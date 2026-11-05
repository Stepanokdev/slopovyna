// Light or dark. Until the person picks one, the page follows the system; a pick is remembered in
// this browser. Loaded in <head> before the stylesheet applies, so the page never flashes the
// other theme.
(function () {
  const root = document.documentElement, media = window.matchMedia('(prefers-color-scheme: dark)');
  const listeners = [];
  let chosen = null;
  try { chosen = localStorage.getItem('slop.theme'); } catch {}
  if (chosen !== 'light' && chosen !== 'dark') chosen = null;
  const current = () => chosen || (media.matches ? 'dark' : 'light');
  function apply() {
    if (chosen) root.dataset.theme = chosen; else delete root.dataset.theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', current() === 'dark' ? '#212121' : '#ffffff');
    for (const f of listeners) f(current());
  }
  function set(t) {
    chosen = t === 'light' || t === 'dark' ? t : null;
    try { chosen ? localStorage.setItem('slop.theme', chosen) : localStorage.removeItem('slop.theme'); } catch {}
    apply();
  }
  media.addEventListener('change', () => { if (!chosen) apply(); });
  apply();
  document.addEventListener('DOMContentLoaded', apply);   // the theme-color meta exists by then
  window.SlopTheme = { current, set, toggle: () => set(current() === 'dark' ? 'light' : 'dark'), onChange: f => listeners.push(f) };
})();
