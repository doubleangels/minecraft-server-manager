// Shared Chart.js theme tokens, re-read on every theme toggle: Chart.js paints
// on canvas, so it can't follow CSS variables by itself. One copy for every
// page with a chart (dashboard trend, per-server metrics) so a palette change
// doesn't have to be made twice.

export function themeColors() {
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
