// Shared number/size formatting. One byte formatter for the whole panel -
// three pages had drifted copies, all with a floor that rendered 0 bytes as
// "1 KB" ("Total: 1 KB in 0 archives"). Mirrors the server-side `bytes`
// Handlebars helper (src/web/app.js) so a size never renders differently in a
// toast than in its table cell.

export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (n === 0) return '0 B';
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log2(Math.abs(n)) / 10), units.length - 1);
  const value = n / 2 ** (10 * i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

// One HTML-escaper for the whole panel - a dozen-plus pages had drifted
// copies, some missing the `?? ''` coercion (throws on null/undefined).
export function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// Auto-escaping HTML templates, so a call site cannot forget escapeHtml:
//
//   list.innerHTML = html`<li title="${name}">${name}</li>`;
//
// Every interpolated value is escaped, except another html`` result or a
// value marked with rawHtml() (markup you built and trust). Arrays are joined,
// each item following the same rule, so a nested map needs no .join(''):
//
//   html`<ul>${items.map((i) => html`<li>${i.label}</li>`)}</ul>`
//
// The result is an object whose toString() is the markup; assign it to
// innerHTML, or call String() on it.
class SafeHtml {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

/** Mark markup as trusted so html`` inserts it unescaped. Never pass user text here. */
export function rawHtml(markup) {
  return new SafeHtml(String(markup ?? ''));
}

function htmlValue(v) {
  if (v instanceof SafeHtml) return v.text;
  if (Array.isArray(v)) return v.map(htmlValue).join('');
  if (v === false || v === null || v === undefined) return '';
  return escapeHtml(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += htmlValue(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}
