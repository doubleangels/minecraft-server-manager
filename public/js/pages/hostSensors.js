// Dashboard "Host Sensors": the 24-hour temperature and fan chart, and the
// tiles above it, refreshed once a minute (the server samples once a minute,
// so polling faster would only redraw the same points).

const root = document.querySelector('[data-host-sensors]');
if (root && window.Chart) init();

function init() {
  const canvas = root.querySelector('[data-chart="host-history"]');
  const hasFans = Number(canvas?.dataset.hostFans || 0) > 0;
  const FAN_KEYS = ['diamond', 'gold', 'grass'];

  function themeColors() {
    const css = getComputedStyle(document.documentElement);
    const line = css.getPropertyValue('--color-line').trim();
    return {
      grass: css.getPropertyValue('--color-grass-400').trim() || '#59c53e',
      diamond: css.getPropertyValue('--color-diamond-400').trim() || '#3cc5c7',
      gold: css.getPropertyValue('--color-gold-400').trim() || '#f0b42f',
      redstone: css.getPropertyValue('--color-redstone-400').trim() || '#e5484d',
      grid: line ? `${line}66` : 'rgba(128,128,128,.12)',
      tick: css.getPropertyValue('--color-ink-faint').trim() || '#87919b',
    };
  }
  let colors = themeColors();

  const timeLabel = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // A phone gets fewer time labels and a taller chart, so labels never collide.
  const narrow = window.matchMedia('(width < 40rem)').matches;
  const scales = {
    x: {
      ticks: { maxTicksLimit: narrow ? 4 : 8, autoSkipPadding: 16, color: colors.tick, maxRotation: 0 },
      grid: { display: false },
    },
    y: {
      suggestedMin: 30,
      suggestedMax: 80,
      grid: { color: colors.grid },
      ticks: { callback: (v) => `${v}°`, color: colors.tick },
    },
  };
  if (hasFans) {
    scales.y1 = {
      // 0 to the fans' top speed, set from the data in render().
      min: 0,
      position: 'right',
      grid: { drawOnChartArea: false },
      ticks: { callback: (v) => `${v} rpm`, color: colors.tick },
    };
  }
  const chart = new window.Chart(canvas, {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      aspectRatio: narrow ? 1.5 : 3,
      animation: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: { legend: { display: true, labels: { boxWidth: 10, color: colors.tick } } },
      scales,
      elements: { point: { radius: 0 }, line: { borderWidth: 2, tension: 0.3 } },
    },
  });

  new MutationObserver(() => {
    colors = themeColors();
    chart.options.scales.x.ticks.color = colors.tick;
    chart.options.scales.y.grid.color = colors.grid;
    chart.options.scales.y.ticks.color = colors.tick;
    if (chart.options.scales.y1) chart.options.scales.y1.ticks.color = colors.tick;
    chart.options.plugins.legend.labels.color = colors.tick;
    chart.data.datasets.forEach((d) => {
      d.borderColor = colors[d.colorKey];
    });
    chart.update('none');
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function render(data) {
    const history = data.history || [];
    const fanLabels = hasFans ? [...new Set(history.flatMap((p) => Object.keys(p.fans || {})))].slice(0, 3) : [];
    chart.data.labels = history.map((p) => timeLabel(p.t));
    chart.data.datasets = [
      {
        label: 'CPU °C',
        colorKey: 'redstone',
        borderColor: colors.redstone,
        backgroundColor: 'transparent',
        yAxisID: 'y',
        data: history.map((p) => p.cpuTempC),
      },
      ...fanLabels.map((label, i) => ({
        label: `${label} rpm`,
        colorKey: FAN_KEYS[i],
        borderColor: colors[FAN_KEYS[i]],
        backgroundColor: 'transparent',
        yAxisID: 'y1',
        data: history.map((p) => (p.fans && label in p.fans ? p.fans[label] : null)),
      })),
    ];
    if (chart.options.scales.y1) {
      // Top of the fan axis: the shown fans' top speed (rated, or highest
      // seen), and never below any point in the history.
      const shown = (data.fans || []).filter((f) => fanLabels.includes(f.label));
      const top = Math.max(
        0,
        ...shown.map((f) => f.maxRpm || f.rpm || 0),
        ...history.flatMap((p) => fanLabels.map((l) => (p.fans && p.fans[l]) || 0))
      );
      chart.options.scales.y1.max = top > 0 ? Math.ceil(top / 100) * 100 : undefined;
    }
    chart.update('none');

    const set = (sel, v) => {
      const el = root.querySelector(sel);
      if (el) el.textContent = v == null ? '-' : String(v);
    };
    set('[data-host-cpu]', data.cpuTempC);
    set('[data-host-max]', data.maxTempC);
    (data.fans || []).slice(0, 3).forEach((f, i) => set(`[data-host-fan="${i}"]`, f.rpm));
  }

  async function refresh() {
    if (document.hidden) return;
    try {
      const res = await fetch('/api/system/sensors?history=1');
      if (!res.ok) return;
      render(await res.json());
    } catch {
      /* the next minute tries again */
    }
  }
  refresh();
  setInterval(refresh, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}
