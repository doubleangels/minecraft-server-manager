'use strict';

// The visual register, checked mechanically so it can't drift:
// - colors come from the panel's own palette or semantic tokens, never
//   Tailwind's default palette (red-500, gray-700, …);
// - one radius per role: rounded-sm on every control and small inline piece,
//   rounded-md on panels nested in a card, rounded-lg on top-level surfaces.
//   A bare `rounded` is the same 4px as rounded-sm, so the name must say so.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function walk(rel) {
  const abs = path.join(ROOT, rel);
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .flatMap((d) =>
      d.name === 'dist' ? [] : d.isDirectory() ? walk(path.join(rel, d.name)) : [path.join(rel, d.name)]
    );
}
const sources = [...walk('views'), ...walk('public/js')].filter((f) => /\.(hbs|js)$/.test(f));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

test('no Tailwind default palette colors at call sites', () => {
  const re =
    /\b(?:bg|text|border|ring|outline|fill|stroke|from|to|divide)-(?:red|green|yellow|blue|amber|orange|lime|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral)-\d{2,3}\b/g;
  const bad = [];
  for (const f of sources) {
    const text = read(f);
    for (const m of text.matchAll(re)) bad.push(`${f}:${lineOf(text, m.index)} ${m[0]}`);
  }
  assert.deepEqual(bad, [], 'use a semantic token (ok, warn, danger, link, …) instead');
});

test('no bare `rounded`: controls say rounded-sm', () => {
  const bad = [];
  for (const f of sources) {
    const text = read(f);
    for (const m of text.matchAll(/(?<=[\s"'`:])rounded(?=[\s"'`])/g)) bad.push(`${f}:${lineOf(text, m.index)}`);
  }
  assert.deepEqual(bad, []);
});

test('buttons, links and fields use the control radius', () => {
  const bad = [];
  for (const f of sources) {
    const text = read(f);
    for (const m of text.matchAll(/<(button|input|select|textarea)\b[^>]*\brounded-(?:md|lg)\b[^>]*>/g)) {
      bad.push(`${f}:${lineOf(text, m.index)} <${m[1]}>`);
    }
  }
  assert.deepEqual(bad, [], 'controls are rounded-sm; rounded-md/lg are for panels and surfaces');
});

test('no forced uppercase: text shows as written, so it is written in the right case', () => {
  const bad = [];
  for (const f of sources) {
    const text = read(f);
    // The Tailwind utility as a whole class (not "uppercase" inside a word or a JS method).
    for (const m of text.matchAll(/(?<=[\s"'`])uppercase(?=[\s"'`])/g)) bad.push(`${f}:${lineOf(text, m.index)}`);
  }
  assert.deepEqual(bad, []);
  const css = fs.readFileSync(path.join(ROOT, 'assets/css/input.css'), 'utf8');
  assert.doesNotMatch(css, /@apply[^;]*\buppercase\b/, 'no component forces uppercase either');
});
