'use strict';

// Host temperature and fan readings from a fake sysfs tree shaped like real
// machines: an AMD desktop (k10temp + a motherboard fan controller), an Intel
// box (coretemp), a Raspberry Pi (thermal zone only), and a host with nothing.

const app = require('./helpers/app');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sensors = require('../src/services/hostSensors');

function tree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-sys-'));
  for (const [rel, content] of Object.entries(spec)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${content}\n`);
  }
  return root;
}

const AMD = {
  'class/hwmon/hwmon0/name': 'nvme',
  'class/hwmon/hwmon0/temp1_input': '38850',
  'class/hwmon/hwmon0/temp1_label': 'Composite',
  'class/hwmon/hwmon1/name': 'k10temp',
  'class/hwmon/hwmon1/temp1_input': '52375',
  'class/hwmon/hwmon1/temp1_label': 'Tctl',
  'class/hwmon/hwmon1/temp3_input': '48000',
  'class/hwmon/hwmon1/temp3_label': 'Tccd1',
  'class/hwmon/hwmon2/name': 'nct6798',
  'class/hwmon/hwmon2/fan1_input': '0',
  'class/hwmon/hwmon2/fan2_input': '1180',
  'class/hwmon/hwmon2/fan2_label': 'CPU Fan',
  'class/hwmon/hwmon2/temp7_input': '-62000', // unplugged probe
  'class/hwmon/hwmon2/fan3_input': '65535', // misreport
};

let cookie;
test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
  app.seedServer('srv_hostsensors');
});
test.after(async () => {
  delete process.env.HOST_SYS_PATH;
  sensors._reset();
  await app.stop();
});

test('an AMD desktop: Tctl is the CPU temperature, fans are read, bad readings dropped', async () => {
  process.env.HOST_SYS_PATH = tree(AMD);
  sensors._reset();
  const s = await sensors.readSensors();
  assert.equal(s.available, true);
  assert.equal(s.cpuTempC, 52.4);
  assert.equal(s.maxTempC, 52.4);
  assert.deepEqual(
    s.temps.map((t) => `${t.chip}/${t.label}`),
    ['nvme/Composite', 'k10temp/Tctl', 'k10temp/Tccd1']
  );
  assert.deepEqual(
    s.fans.map((f) => [f.label, f.rpm]),
    [
      ['Fan 1', 0],
      ['CPU Fan', 1180],
    ]
  );
});

test('an Intel box: the package temperature, not the hottest core', async () => {
  process.env.HOST_SYS_PATH = tree({
    'class/hwmon/hwmon3/name': 'coretemp',
    'class/hwmon/hwmon3/temp1_input': '61000',
    'class/hwmon/hwmon3/temp1_label': 'Package id 0',
    'class/hwmon/hwmon3/temp2_input': '66000',
    'class/hwmon/hwmon3/temp2_label': 'Core 0',
  });
  sensors._reset();
  const s = await sensors.readSensors();
  assert.equal(s.cpuTempC, 61);
  assert.equal(s.maxTempC, 66);
  assert.deepEqual(s.fans, []);
});

test('a Raspberry Pi: the thermal zone stands in when there is no hwmon chip', async () => {
  process.env.HOST_SYS_PATH = tree({
    'class/thermal/thermal_zone0/type': 'cpu-thermal',
    'class/thermal/thermal_zone0/temp': '47236',
    'class/thermal/cooling_device0/type': 'gpio-fan',
  });
  sensors._reset();
  const s = await sensors.readSensors();
  assert.equal(s.available, true);
  assert.equal(s.cpuTempC, 47.2);
});

test('a host with no sensors reports unavailable, and nothing is drawn', async () => {
  process.env.HOST_SYS_PATH = tree({ 'class/net/eth0/address': 'x' });
  sensors._reset();
  const s = await sensors.readSensors();
  assert.equal(s.available, false);
  assert.equal(s.cpuTempC, null);
  assert.equal(await sensors.liveReading(), null);
  const html = (await app.req('GET', '/', { cookie, headers: { Accept: 'text/html' } })).text;
  assert.doesNotMatch(html, /data-host-sensors/);
  const metrics = (
    await app.req('GET', '/servers/srv_hostsensors/metrics', { cookie, headers: { Accept: 'text/html' } })
  ).text;
  assert.doesNotMatch(metrics, /data-host-card/);
});

test('the API, the dashboard card and the Performance chart appear when sensors exist', async () => {
  process.env.HOST_SYS_PATH = tree(AMD);
  sensors._reset();
  await sensors.sampleHistory();
  const r = await app.req('GET', '/api/system/sensors?history=1', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.cpuTempC, 52.4);
  assert.equal(r.json.history.length, 1);
  assert.deepEqual(r.json.history[0].fans, { 'Fan 1': 0, 'CPU Fan': 1180 });
  const html = (await app.req('GET', '/', { cookie, headers: { Accept: 'text/html' } })).text;
  assert.match(html, /data-host-sensors/);
  assert.match(html, /data-host-cpu>52\.4</);
  assert.match(html, /CPU Fan/);
  const metrics = (
    await app.req('GET', '/servers/srv_hostsensors/metrics', { cookie, headers: { Accept: 'text/html' } })
  ).text;
  assert.match(metrics, /data-chart="host"/);
  assert.match(metrics, /Host Temperature &amp; Fans/);
  assert.deepEqual(await sensors.liveReading(), {
    cpuTempC: 52.4,
    maxTempC: 52.4,
    fans: [
      { label: 'Fan 1', rpm: 0 },
      { label: 'CPU Fan', rpm: 1180 },
    ],
  });
});

test('the sensors API needs a signed-in user', async () => {
  const r = await app.req('GET', '/api/system/sensors');
  assert.equal(r.status, 401);
});
