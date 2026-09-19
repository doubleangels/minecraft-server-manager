// Metrics ("Live") tab: the top stat strip and the CPU / memory / network /
// tick-rate charts, all fed by the stats WebSocket. Chart.js is loaded globally
// from /vendor/chart.umd.js by the partial.

import { themeColors } from '../lib/chartTheme.js';

const root = document.querySelector('[data-metrics-server]');
if (root && window.Chart)
  init(
    root.dataset.metricsServer,
    Number(root.dataset.metricsMemLimit) || 0,
    Number(root.dataset.metricsCpuLimit) || 0
  );

function init(serverId, memLimitMb, cpuLimit) {
  const MAX_POINTS = 60;

  // --- Top stat strip: keep the SSR numbers moving between reloads.
  const metricEl = (name) => root.querySelector(`[data-metric="${name}"]`);
  const tpsCard = root.querySelector('[data-tps-card]');
  let perfSupported = root.dataset.metricsPerfSupported === '1';

  // Local uptime ticker from the container's start time.
  const startedAt = root.dataset.metricsStartedAt ? Date.parse(root.dataset.metricsStartedAt) : null;
  function fmtUptime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
  }
  if (startedAt) {
    const upEl = metricEl('uptime');
    const tick = () => upEl && (upEl.textContent = fmtUptime(Date.now() - startedAt));
    tick();
    setInterval(() => {
      if (!document.hidden) tick();
    }, 30000);
  }

  let colors = themeColors();
  const charts = [];

  function makeChart(canvas, datasets, { max, unit, y1 } = {}) {
    if (!canvas) return null;
    const scales = {
      x: { display: false, grid: { display: false }, ticks: { color: colors.tick, maxTicksLimit: 6 } },
      y: {
        beginAtZero: true,
        suggestedMax: max,
        grid: { color: colors.grid },
        ticks: { callback: (v) => `${v}${unit || ''}`, color: colors.tick },
      },
    };
    if (y1)
      scales.y1 = {
        beginAtZero: true,
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { callback: (v) => `${v}${y1}`, color: colors.tick },
      };
    const chart = new window.Chart(canvas, {
      type: 'line',
      data: { labels: [], datasets },
      options: {
        responsive: true,
        animation: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: { legend: { display: datasets.length > 1, labels: { boxWidth: 10, color: colors.tick } } },
        scales,
        elements: { point: { radius: 0 }, line: { borderWidth: 2, tension: 0.35, spanGaps: true } },
      },
    });
    charts.push(chart);
    return chart;
  }

  new MutationObserver(() => {
    colors = themeColors();
    for (const chart of charts) {
      chart.options.scales.y.grid.color = colors.grid;
      chart.options.scales.y.ticks.color = colors.tick;
      if (chart.options.scales.x.ticks) chart.options.scales.x.ticks.color = colors.tick;
      if (chart.options.scales.y1) chart.options.scales.y1.ticks.color = colors.tick;
      if (chart.options.plugins.legend.labels) chart.options.plugins.legend.labels.color = colors.tick;
      chart.update('none');
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const cpuChart = makeChart(
    document.querySelector('[data-chart="cpu"]'),
    [{ label: 'CPU %', data: [], borderColor: colors.diamond, backgroundColor: 'transparent' }],
    { max: cpuLimit ? cpuLimit * 100 : 100, unit: '%' }
  );
  const memChart = makeChart(
    document.querySelector('[data-chart="memory"]'),
    [{ label: 'Used MB', data: [], borderColor: colors.grass, backgroundColor: 'transparent' }],
    { max: memLimitMb || undefined, unit: ' MB' }
  );
  const netChart = makeChart(
    document.querySelector('[data-chart="network"]'),
    [
      { label: 'RX KB/s', data: [], borderColor: colors.diamond, backgroundColor: 'transparent' },
      { label: 'TX KB/s', data: [], borderColor: colors.gold, backgroundColor: 'transparent' },
    ],
    { unit: '' }
  );
  const tpsChart = makeChart(
    document.querySelector('[data-chart="tps"]'),
    [
      { label: 'TPS', data: [], borderColor: colors.grass, backgroundColor: 'transparent', yAxisID: 'y' },
      { label: 'ms/tick', data: [], borderColor: colors.redstone, backgroundColor: 'transparent', yAxisID: 'y1' },
    ],
    { max: 20, unit: '', y1: ' ms' }
  );

  // ---- Live vs. saved history ----
  // The WS feed owns the "Live" charts; the 1h / 24h / 7d buttons swap them for
  // the persisted series served by /api/servers/:id/metrics. While a history
  // view is showing, incoming WS ticks stop touching the charts (the top stat
  // strip keeps updating), and the old live buffers are snapshotted so switching
  // back resumes seamlessly.
  const chartByName = { cpu: cpuChart, memory: memChart, network: netChart, tps: tpsChart };
  let liveMode = true;
  let liveSnapshots = null;
  let lastNet = null;
  let lastTs = 0;
  // Monotonic id for the history fetch. Every range click and every switch
  // back to Live bumps it, so a request that resolves out of order is dropped
  // no matter which range it was for. A value compare alone wouldn't catch an
  // earlier request for the same range beating a later one on reorder.
  let historySeq = 0;

  function updateCharts() {
    for (const chart of Object.values(chartByName)) chart?.update('none');
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function fmtDayTime(iso) {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(iso)}`;
  }

  function snapshotLive() {
    liveSnapshots = {};
    for (const [name, chart] of Object.entries(chartByName)) {
      if (!chart) continue;
      liveSnapshots[name] = {
        labels: [...chart.data.labels],
        data: chart.data.datasets.map((d) => [...d.data]),
      };
    }
  }

  function restoreLive() {
    if (!liveSnapshots) return;
    for (const [name, chart] of Object.entries(chartByName)) {
      if (!chart || !liveSnapshots[name]) continue;
      chart.data.labels = liveSnapshots[name].labels;
      chart.data.datasets.forEach((d, i) => {
        d.data = liveSnapshots[name].data[i] ?? [];
      });
      chart.options.scales.x.display = false;
    }
    lastNet = null;
    lastTs = 0;
    updateCharts();
  }

  function setSeries(chart, labels, series) {
    if (!chart) return;
    chart.data.labels = labels;
    chart.data.datasets.forEach((d, i) => {
      d.data = series[i] ?? [];
    });
    chart.options.scales.x.display = true;
  }

  async function applyHistory(range) {
    const seq = historySeq;
    let data;
    try {
      const res = await fetch(`/api/servers/${serverId}/metrics?range=${range}&points=120`);
      data = await res.json();
      if (!res.ok || !data.ok) return;
    } catch {
      return;
    }
    // A newer click replaced this one while the request was in flight;
    // applying it now would clobber the current view with stale data.
    if (seq !== historySeq) return;
    if (!Array.isArray(data.points)) return;
    const fmt = range === '7d' ? fmtDayTime : fmtTime;
    const labels = data.points.map((p) => fmt(p.at));
    setSeries(cpuChart, labels, [data.points.map((p) => p.cpuPct)]);
    setSeries(memChart, labels, [data.points.map((p) => p.memUsedMb)]);
    setSeries(netChart, labels, [data.points.map((p) => p.netRxKbs), data.points.map((p) => p.netTxKbs)]);
    setSeries(tpsChart, labels, [data.points.map((p) => p.tps), data.points.map((p) => p.mspt)]);
    updateCharts();
  }

  const rangeBtns = root.querySelectorAll('[data-range]');
  for (const btn of rangeBtns) {
    btn.addEventListener('click', () => {
      const range = btn.dataset.range;
      const wasLive = liveMode;
      liveMode = range === 'live';
      // Retire any fetch already in flight: a switch back to Live or to a new
      // range must make the previous request stale, even one for this range.
      ++historySeq;
      for (const b of rangeBtns) b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      if (liveMode) {
        restoreLive();
      } else {
        if (wasLive) snapshotLive();
        applyHistory(range);
      }
    });
  }

  function push(chart, values) {
    if (!chart || !liveMode) return;
    chart.data.labels.push('');
    values.forEach((v, i) => chart.data.datasets[i].data.push(v));
    if (chart.data.labels.length > MAX_POINTS) {
      chart.data.labels.shift();
      chart.data.datasets.forEach((d) => d.data.shift());
    }
    chart.update('none');
  }

  function applyPerf(perf, supported) {
    if (supported === false) {
      // Every probe command has been tried and none answered.
      perfSupported = false;
      if (tpsCard) tpsCard.hidden = true;
      const tpsEl = metricEl('tps');
      const msptEl = metricEl('mspt');
      if (tpsEl && tpsEl.textContent === '…') tpsEl.textContent = 'n/a';
      if (msptEl && /reading|min/.test(msptEl.textContent)) msptEl.textContent = 'not reported';
      return;
    }
    if (supported === true && !perfSupported) {
      perfSupported = true;
      if (tpsCard) tpsCard.hidden = false;
    }
    if (!perf) return;
    const tpsEl = metricEl('tps');
    const msptEl = metricEl('mspt');
    if (tpsEl && perf.tps1 != null) tpsEl.textContent = perf.tps1.toFixed(1);
    if (msptEl) msptEl.textContent = perf.mspt != null ? `${perf.mspt.toFixed(1)} ms/tick` : 'last 1 min';
    push(tpsChart, [perf.tps1 ?? null, perf.mspt ?? null]);
  }

  // Reconnect with backoff and pause while the tab is hidden (otherwise the
  // charts draw a misleading unbroken line across the gap).
  let reconnectDelay = 5000;
  let ws = null;
  function connect() {
    if (document.hidden) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/stats/${serverId}`);
    ws.addEventListener('open', () => {
      reconnectDelay = 5000;
    });
    ws.addEventListener('message', (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.kind !== 'stats') return;
      const now = Date.now();
      const memMb = Math.round(msg.memUsedBytes / 1024 / 1024);
      push(cpuChart, [msg.cpuPct]);
      push(memChart, [memMb]);
      const cpuEl = metricEl('cpu');
      const memEl = metricEl('mem');
      if (cpuEl) cpuEl.textContent = `${msg.cpuPct}%`;
      if (memEl) memEl.textContent = String(memMb);
      if (lastNet && now > lastTs) {
        const dt = (now - lastTs) / 1000;
        push(netChart, [
          Math.max(0, Math.round((msg.netRx - lastNet.rx) / 1024 / dt)),
          Math.max(0, Math.round((msg.netTx - lastNet.tx) / 1024 / dt)),
        ]);
      }
      lastNet = { rx: msg.netRx, tx: msg.netTx };
      lastTs = now;
      applyPerf(msg.perf, msg.perfSupported);
    });
    ws.addEventListener('close', () => {
      if (document.hidden) return; // visibilitychange reconnects
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      ws?.close();
      lastNet = null; // rate math must not span the hidden gap
    } else {
      reconnectDelay = 5000;
      connect();
    }
  });
  connect();
}
