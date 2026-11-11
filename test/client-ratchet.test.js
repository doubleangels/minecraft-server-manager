'use strict';

// Ratchets for two client habits being migrated away from (audit F-11, F-14):
//   - direct fetch() calls: use api() from public/js/lib/api.js, which adds a
//     timeout, one error shape and the trip back to sign-in on a 401
//   - template literals assigned to innerHTML / outerHTML / insertAdjacentHTML:
//     use the auto-escaping html`` tag from public/js/lib/format.js
// Each file may not go above its count in test/fixtures/client-ratchet.json,
// and a new file starts at zero. When a migration lowers a count, lower the
// baseline too (the test says which), so the gain cannot be lost again.
// Long uploads and downloads that need progress or a non-JSON body are why
// fetch() is not banned outright.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public', 'js');
const BASELINE = path.join(__dirname, 'fixtures', 'client-ratchet.json');
const ALLOWED_FETCH = new Set(['lib/api.js']);

const FETCH_RE = /\bfetch\(/g;
// `el.innerHTML = \`…` (or +=), `el.outerHTML = \`…`, `insertAdjacentHTML('…', \`…`
const RAW_HTML_RE = /(?:inner|outer)HTML\s*\+?=\s*`|insertAdjacentHTML\([^,]+,\s*`/g;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : d.name.endsWith('.js') ? [p] : [];
  });
}

function counts() {
  const out = { fetch: {}, rawHtml: {} };
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const src = fs.readFileSync(file, 'utf8');
    const f = ALLOWED_FETCH.has(rel) ? 0 : (src.match(FETCH_RE) || []).length;
    const h = (src.match(RAW_HTML_RE) || []).length;
    if (f) out.fetch[rel] = f;
    if (h) out.rawHtml[rel] = h;
  }
  return out;
}

test('no file adds direct fetch() calls or raw HTML templates beyond its baseline', () => {
  const now = counts();
  if (process.env.UPDATE_CLIENT_RATCHET === '1') {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const problems = [];
  const stale = [];
  for (const kind of ['fetch', 'rawHtml']) {
    const hint = kind === 'fetch' ? 'use api() from lib/api.js' : 'build the markup with html`` from lib/format.js';
    for (const [file, n] of Object.entries(now[kind])) {
      const allowed = base[kind][file] || 0;
      if (n > allowed) problems.push(`${file}: ${n} ${kind} (baseline ${allowed}), ${hint}`);
    }
    for (const [file, n] of Object.entries(base[kind])) {
      if ((now[kind][file] || 0) < n) stale.push(`${kind} ${file}: ${now[kind][file] || 0} < ${n}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.deepEqual(
    stale,
    [],
    `Counts went down (good). Lower the baseline with UPDATE_CLIENT_RATCHET=1 node --test test/client-ratchet.test.js:\n${stale.join('\n')}`
  );
});

test('the html tag escapes values and keeps nested html', async () => {
  // Browser ESM with no imports of its own: load it as a module from its text.
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'format.js'), 'utf8');
  const { html, rawHtml } = await import(`data:text/javascript,${encodeURIComponent(src)}`);
  const name = '<img src=x onerror=alert(1)>';
  assert.equal(
    String(html`<b title="${name}">${name}</b>`),
    '<b title="&lt;img src=x onerror=alert(1)&gt;">&lt;img src=x onerror=alert(1)&gt;</b>'
  );
  const items = ['a&b', '"c"'];
  const tag = html;
  assert.equal(
    // Through another name: Prettier reformats markup inside html`` templates.
    String(tag`<ul>${items.map((i) => tag`<li>${i}</li>`)}</ul>`),
    '<ul><li>a&amp;b</li><li>&quot;c&quot;</li></ul>'
  );
  assert.equal(String(html`${null}${undefined}${false}${0}`), '0');
  assert.equal(String(html`${rawHtml('<i>ok</i>')}`), '<i>ok</i>');
});
