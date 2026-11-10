'use strict';

// Host temperature and fan-speed readings from Linux sysfs: the same hwmon
// chips `sensors` (lm-sensors) reads, plus the kernel's thermal zones for
// boards that only expose those (a Raspberry Pi's cpu_thermal). A container
// sees the host's /sys read-only by default, so this works when the panel runs
// in Docker too. Hosts with nothing to read (Docker Desktop's VM, most
// macOS/Windows setups) report available: false and the UI hides the charts.
//
// HOST_SYS_PATH points it at a different sysfs root (a bind-mounted host /sys,
// or a fake tree in tests).
//
// A minute-by-minute history (last 24 hours) is kept in memory for the
// dashboard's chart; it starts empty after a panel restart.

const fs = require('node:fs/promises');
const path = require('node:path');
const logger = require('../logger')(path.basename(__filename));

const CACHE_MS = 2000;
const HISTORY_EVERY_MS = 60_000;
const HISTORY_POINTS = 24 * 60;
const MAX_FANS_IN_HISTORY = 4;
// Readings outside these bounds are a disconnected or misreporting sensor.
const TEMP_MIN_C = -40;
const TEMP_MAX_C = 150;
const FAN_MAX_RPM = 30_000;

// Chips whose reading is the CPU package temperature, best first, with the
// label that names it on chips that report several (null: first reading).
/** @type {Array<[string, RegExp | null]>} */
const CPU_CHIPS = [
  ['k10temp', /^(Tctl|Tdie)$/],
  ['zenpower', /^(Tctl|Tdie)$/],
  ['coretemp', /^Package id 0$/],
  ['cpu_thermal', null],
  ['soc_thermal', null],
  ['x86_pkg_temp', null],
  ['cpu-thermal', null],
  ['acpitz', null],
];

function sysRoot() {
  return process.env.HOST_SYS_PATH || '/sys';
}

async function readText(file) {
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function readNumber(file) {
  const t = await readText(file);
  if (t === null || t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

async function listDir(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/** Highest speed seen per fan id, for fans whose driver reports no maximum. */
const peakRpm = new Map();

/** Every hwmon chip's temperatures and fans. */
async function readHwmon() {
  const base = path.join(sysRoot(), 'class', 'hwmon');
  const temps = [];
  const fans = [];
  for (const dev of (await listDir(base)).sort()) {
    const dir = path.join(base, dev);
    const chip = (await readText(path.join(dir, 'name'))) || dev;
    for (const file of (await listDir(dir)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      let m = /^temp(\d+)_input$/.exec(file);
      if (m) {
        const milli = await readNumber(path.join(dir, file));
        if (milli === null) continue;
        const c = Math.round(milli / 100) / 10;
        if (c <= TEMP_MIN_C || c >= TEMP_MAX_C) continue;
        const label = (await readText(path.join(dir, `temp${m[1]}_label`))) || `temp${m[1]}`;
        temps.push({ id: `${dev}/temp${m[1]}`, chip, label, c });
        continue;
      }
      m = /^fan(\d+)_input$/.exec(file);
      if (m) {
        const rpm = await readNumber(path.join(dir, file));
        if (rpm === null || rpm < 0 || rpm > FAN_MAX_RPM) continue;
        const label = (await readText(path.join(dir, `fan${m[1]}_label`))) || `Fan ${m[1]}`;
        const id = `${dev}/fan${m[1]}`;
        // The chart's fan axis runs 0 to the fan's top speed: the driver's
        // rated maximum when it reports one (most leave fan*_max unset or 0),
        // else the highest speed seen since the panel started.
        const rated = await readNumber(path.join(dir, `fan${m[1]}_max`));
        const peak = Math.max(peakRpm.get(id) || 0, Math.round(rpm));
        peakRpm.set(id, peak);
        const maxRpm = rated && rated > 0 && rated <= FAN_MAX_RPM ? Math.max(Math.round(rated), peak) : peak;
        fans.push({ id, chip, label, rpm: Math.round(rpm), maxRpm, maxRated: Boolean(rated && rated > 0) });
      }
    }
  }
  return { temps, fans };
}

/** Thermal zones, for chips not already listed under hwmon. */
async function readThermalZones(seenChips) {
  const base = path.join(sysRoot(), 'class', 'thermal');
  const temps = [];
  for (const zone of (await listDir(base)).filter((z) => z.startsWith('thermal_zone')).sort()) {
    const type = (await readText(path.join(base, zone, 'type'))) || zone;
    if (seenChips.has(type)) continue;
    const milli = await readNumber(path.join(base, zone, 'temp'));
    if (milli === null) continue;
    const c = Math.round(milli / 100) / 10;
    if (c <= TEMP_MIN_C || c >= TEMP_MAX_C) continue;
    temps.push({ id: zone, chip: type, label: type, c });
  }
  return temps;
}

/** The reading that best stands for "CPU temperature", or the hottest one. */
function pickCpuTemp(temps) {
  for (const [chip, labelRe] of CPU_CHIPS) {
    const ofChip = temps.filter((t) => t.chip === chip);
    if (!ofChip.length) continue;
    const hit = labelRe ? ofChip.find((t) => labelRe.test(t.label)) : ofChip[0];
    if (hit) return hit.c;
    return Math.max(...ofChip.map((t) => t.c));
  }
  return temps.length ? Math.max(...temps.map((t) => t.c)) : null;
}

let cache = null;
let cacheAt = 0;
let inFlight = null;

/**
 * Current readings, cached for a couple of seconds (the stats socket asks once
 * a second per open graph).
 * @returns {Promise<{available: boolean, cpuTempC: number|null, maxTempC: number|null,
 *   temps: Array<{id: string, chip: string, label: string, c: number}>,
 *   fans: Array<{id: string, chip: string, label: string, rpm: number}>, at: number}>}
 */
async function readSensors() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const hw = await readHwmon();
      const zones = await readThermalZones(new Set(hw.temps.map((t) => t.chip)));
      const temps = [...hw.temps, ...zones];
      const fans = hw.fans;
      cache = {
        available: temps.length > 0 || fans.length > 0,
        cpuTempC: pickCpuTemp(temps),
        maxTempC: temps.length ? Math.max(...temps.map((t) => t.c)) : null,
        temps,
        fans,
        at: Date.now(),
      };
      cacheAt = Date.now();
      return cache;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** The compact form folded into every live stats sample. */
async function liveReading() {
  const s = await readSensors().catch(() => null);
  if (!s || !s.available) return null;
  return {
    cpuTempC: s.cpuTempC,
    maxTempC: s.maxTempC,
    fans: s.fans.map((f) => ({ label: f.label, rpm: f.rpm, maxRpm: f.maxRpm })),
  };
}

// ---- History (dashboard chart) ----
const history = []; // { t, cpuTempC, maxTempC, fans: { [label]: rpm } }
let historyTimer = null;

async function sampleHistory() {
  const s = await readSensors();
  if (!s.available) return;
  const fans = {};
  for (const f of s.fans.slice(0, MAX_FANS_IN_HISTORY)) fans[f.label] = f.rpm;
  history.push({ t: s.at, cpuTempC: s.cpuTempC, maxTempC: s.maxTempC, fans });
  if (history.length > HISTORY_POINTS) history.splice(0, history.length - HISTORY_POINTS);
}

/** Start the once-a-minute history sampler. Quietly does nothing on a host with no sensors. */
async function startSensorHistory() {
  if (historyTimer) return;
  const first = await readSensors().catch(() => null);
  if (!first || !first.available) {
    logger.info('No temperature or fan sensors are readable on this host, so their charts stay hidden.', {
      sysRoot: sysRoot(),
    });
    return;
  }
  logger.info('Reading host temperature and fan sensors.', {
    temps: first.temps.length,
    fans: first.fans.length,
    cpuTempC: first.cpuTempC,
  });
  await sampleHistory().catch(() => {});
  historyTimer = setInterval(() => {
    sampleHistory().catch((err) => logger.debug('A host sensor sample failed.', { err: err.message }));
  }, HISTORY_EVERY_MS);
  historyTimer.unref();
}

function sensorHistory() {
  return history.slice();
}

/** Tests: forget cached readings and history. */
function _reset() {
  cache = null;
  cacheAt = 0;
  peakRpm.clear();
  history.length = 0;
  if (historyTimer) clearInterval(historyTimer);
  historyTimer = null;
}

module.exports = { readSensors, liveReading, startSensorHistory, sensorHistory, sampleHistory, pickCpuTemp, _reset };
