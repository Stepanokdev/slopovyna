'use strict';
// Dark theme: follows the system until the person picks one, the pick is remembered and applied before
// the page paints; the sign-in page links to the source code (AGPL-3.0).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { start } = require('./helpers');

function browser({ systemDark = false, stored = null } = {}) {
  const store = stored ? { 'slop.theme': stored } : {};
  const media = { matches: systemDark, cb: null, addEventListener(_, f) { this.cb = f; } };
  const meta = { v: '#ffffff', getAttribute() { return this.v; }, setAttribute(_, x) { this.v = x; } };
  const root = { dataset: {} };
  const ctx = { document: { documentElement: root, querySelector: s => (s === 'meta[name="theme-color"]' ? meta : null), addEventListener() {} },
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
    matchMedia: () => media };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/theme.js'), 'utf8'), ctx);
  return { T: ctx.SlopTheme, root, meta, store, media };
}

test('without a pick the theme follows the system, live', () => {
  const b = browser({ systemDark: true });
  assert.equal(b.T.current(), 'dark'); assert.equal(b.root.dataset.theme, undefined); assert.equal(b.meta.v, '#212121');
  b.media.matches = false; b.media.cb();
  assert.equal(b.T.current(), 'light'); assert.equal(b.meta.v, '#ffffff');
});

test('a pick is applied at once, remembered, and survives a reload; the system no longer overrides it', () => {
  const b = browser({ systemDark: false });
  const seen = []; b.T.onChange(t => seen.push(t));
  b.T.toggle();
  assert.equal(b.root.dataset.theme, 'dark'); assert.equal(b.store['slop.theme'], 'dark'); assert.deepEqual(seen, ['dark']);
  b.media.matches = true; b.media.cb(); b.media.matches = false; b.media.cb();
  assert.equal(b.T.current(), 'dark');
  const again = browser({ systemDark: false, stored: b.store['slop.theme'] });
  assert.equal(again.root.dataset.theme, 'dark'); assert.equal(again.meta.v, '#212121');
  again.T.toggle(); assert.equal(again.root.dataset.theme, 'light'); assert.equal(again.store['slop.theme'], 'light');
});

test('the stylesheet has the dark tokens for both the system preference and an explicit pick', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');
  const sys = css.match(/@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{([^}]*)\}\}/);
  const pick = css.match(/:root\[data-theme=dark\]\{([^}]*)\}/);
  assert.ok(sys && pick); assert.equal(sys[1], pick[1]);
  assert.match(pick[1], /--paper:#212121/);
});

test('every page loads theme.js before the stylesheet, and the sign-in page knows where the source is', async () => {
  const srv = await start();
  try {
    for (const u of ['/', '/no/such/page']) {
      const html = await (await fetch(srv.base + u)).text();
      assert.ok(html.indexOf('/theme.js') > 0 && html.indexOf('/theme.js') < html.indexOf('/app.css'), u);
    }
    assert.equal((await fetch(srv.base + '/theme.js')).status, 200);
    assert.equal((await (await fetch(srv.base + '/config.json')).json()).sourceUrl, 'https://github.com/Stepanokdev/slopovyna');
  } finally { srv.stop(); }
  const own = await start({ sourceUrl: 'https://git.example.org/me/slopovyna-fork' });
  try { assert.equal((await (await fetch(own.base + '/config.json')).json()).sourceUrl, 'https://git.example.org/me/slopovyna-fork'); }
  finally { own.stop(); }
});
