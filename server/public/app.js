// Slopovyna web client. No framework: the page is a few regions (sidebar, room, panel) that are
// re-rendered from state; the feed keeps its scroll position across re-renders.
'use strict';
(() => {
const T = window.SlopI18n.t;
const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const narrow = () => matchMedia('(max-width:860px)').matches;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const I = {
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  side: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>',
  gh: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 2.9.8.1-.7.4-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7 3.6 3.6 0 0 1 .1-2.7s.8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1 2.7c0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z"/></svg>',
};

// ------------------------------------------------------------------ API
let CSRF = '';
async function api(method, url, body) {
  const r = await fetch(url, { method, credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF': CSRF } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error((j && j.error) || T('g.error', { status: r.status })); e.status = r.status; throw e; }
  return j;
}

// ------------------------------------------------------------------ state
const S = {
  me: null, config: {}, rooms: [], side: narrow() ? 'closed' : 'open',
  room: null,           // {id, title, role, members, extra}
  msgs: [], ids: new Set(), hasOlder: false, hasNewer: false, loadingOlder: false, lastReadAtOpen: 0,
  panel: false, unseen: 0, mentions: new Set(), online: true, pending: new Map(),
};
const members = () => (S.room ? S.room.members.concat(S.room.extra?.agents || []) : []);
// names come from the server; the two generic ones (an unknown agent, a deleted account) are shown in the interface language
const nameOf = p => (p.deleted ? T('g.deleted') : p.kind === 'agent' && p.name === 'Agent' ? T('g.agentModel') : p.name);
const labelOf = p => p.kind === 'agent' ? `${nameOf(p)} · ${p.owner_name}` : nameOf(p);
const memberById = id => members().find(p => p.id === id);
const myId = () => S.me ? `u:${S.me.uid}` : '';

// ------------------------------------------------------------------ formatting
// Formatters follow the interface language and are rebuilt when it changes.
let dayFmt, dayFmtY, monthFmt, timeFmt;
function makeFormatters() {
  const loc = window.SlopI18n.locale();
  dayFmt = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long' });
  dayFmtY = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', year: 'numeric' });
  monthFmt = new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric' });
  timeFmt = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', hour12: false });
}
makeFormatters();
function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayLabel(t) {
  const d0 = startOfDay(Date.now()), d = startOfDay(t);
  if (d === d0) return T('day.today');
  if (d === d0 - 864e5) return T('day.yesterday');
  return new Date(t).getFullYear() === new Date().getFullYear() ? dayFmt.format(t) : dayFmtY.format(t);
}
function groupLabel(t) {
  const d0 = startOfDay(Date.now()), d = startOfDay(t);
  if (d === d0) return T('day.today');
  if (d === d0 - 864e5) return T('day.yesterday');
  if (d > d0 - 7 * 864e5) return T('grp.week');
  if (d > d0 - 30 * 864e5) return T('grp.month');
  const s = monthFmt.format(t); return s[0].toUpperCase() + s.slice(1);
}
function avatar(p, cls = '') {
  if (!p) return `<span class="av ${cls}" aria-hidden="true">?</span>`;
  if (p.kind === 'agent') return `<span class="av ag ${/codex/i.test(p.name) ? 'cx' : ''} ${cls}" aria-hidden="true">${esc(p.name.slice(0, 2))}</span>`;
  if (p.kind === 'system') return `<span class="av ${cls}" aria-hidden="true"><img src="/mascot.svg" alt=""></span>`;
  if (p.avatar) return `<span class="av ${cls}" aria-hidden="true"><img src="${esc(p.avatar)}&s=64" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
  return `<span class="av ${cls}" aria-hidden="true">${esc((p.name || '?').slice(0, 1).toUpperCase())}</span>`;
}

// Small, safe Markdown: everything is escaped first; only fences, inline code, bold, lists, links
// and mentions are turned back into markup.
function md(text, mentionTargets) {
  const labels = (mentionTargets || []).map(id => { const p = memberById(id); return p ? { id, l: '@' + labelOf(p) } : null; }).filter(Boolean)
    .sort((a, b) => b.l.length - a.l.length);
  const inline = s => {
    const codes = [];
    s = esc(s).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${u}</a>`);
    for (const { id, l } of labels) s = s.split(esc(l)).join(`<span class="at${id === myId() ? ' at-me' : ''}">${esc(l)}</span>`);
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  };
  const out = [];
  const parts = String(text).split(/^```/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const lang = nl > 0 ? part.slice(0, nl).trim() : '';
      const code = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, '');
      out.push(`<pre><div class="bar"><span>${esc(lang || T('g.code'))}</span><button type="button" data-copy>${T('g.copy')}</button></div><code>${esc(code)}</code></pre>`);
      return;
    }
    for (const block of part.split(/\n{2,}/)) {
      const b = block.replace(/^\n+|\n+$/g, ''); if (!b) continue;
      const lines = b.split('\n');
      if (lines.every(l => /^\s*[-*] /.test(l))) out.push('<ul>' + lines.map(l => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('') + '</ul>');
      else if (lines.every(l => /^\s*\d+[.)] /.test(l))) out.push('<ol>' + lines.map(l => `<li>${inline(l.replace(/^\s*\d+[.)] /, ''))}</li>`).join('') + '</ol>');
      else out.push(`<p>${lines.map(inline).join('<br>')}</p>`);
    }
  });
  return out.join('');
}

// ------------------------------------------------------------------ boot
async function boot() {
  try { S.config = await (await fetch('/config.json')).json(); } catch {}
  try { const me = await api('GET', '/api/me'); S.me = me.user; CSRF = me.csrf; }
  catch (e) { if (e.status === 401) return signin(); return fatal(T('g.serverDown')); }
  renderShell();
  await loadRooms();
  connect();
  route();
}
function fatal(text) { document.getElementById('app').className = 'full'; document.getElementById('app').innerHTML = `<main class="notice"><img src="/mascot.svg" alt="" width="56"><h1>${T('g.oops')}</h1><p>${esc(text)}</p><a class="btn primary" href="/">${T('g.reload')}</a></main>`; }

// The button names the theme it switches to, and shows its icon.
function themeButton() {
  const to = window.SlopTheme.current() === 'dark' ? 'light' : 'dark';
  return `<button class="ib theme" data-act="theme" aria-label="${T('th.' + to)}" title="${T('th.' + to)}">${to === 'dark' ? I.moon : I.sun}</button>`;
}
window.SlopTheme.onChange(() => { for (const b of document.querySelectorAll('[data-act=theme]')) b.outerHTML = themeButton(); });

function signin() {
  const next = new URLSearchParams(location.search).get('next') || (location.pathname !== '/' ? location.pathname : '/');
  const app = document.getElementById('app');
  app.className = 'full';
  app.innerHTML = `<div class="signin"><div class="top">${themeButton()}<button class="btn ghost sm" data-act="lang" aria-label="${T('lang.switch')}" title="${T('lang.switch')}">${T('lang.short')}</button></div><div class="signin-c">
    <img class="art" src="/img/hero.webp?v=2" width="1200" height="362" alt="">
    <div class="brand"><img src="/mascot.svg" alt="">Slopovyna</div>
    <h1>${T('in.title')}</h1>
    <p>${T('in.lead')}</p>
    <a class="btn primary" href="/auth/github?next=${encodeURIComponent(next)}">${I.gh}${T('in.github')}</a>
    <small>${T('in.note')}</small>
    ${S.config.devLogin ? `<form class="dev" id="devf"><label class="sr" for="devl">${T('in.devLabel')}</label><input id="devl" placeholder="${T('in.devPh')}" autocomplete="off"><button class="btn sm">${T('in.devGo')}</button></form>` : ''}
  </div>
    <footer class="signin-foot"><a href="${esc(S.config.sourceUrl || 'https://github.com/Stepanokdev/slopovyna')}" rel="noopener">${I.gh}${T('in.source')}</a></footer></div>`;
  const f = $('#devf');
  if (f) f.onsubmit = e => { e.preventDefault(); location.href = `/auth/dev?login=${encodeURIComponent($('#devl').value.trim())}&next=${encodeURIComponent(next)}`; };
}

// ------------------------------------------------------------------ live updates
let es = null, catchupTimer = null;
const sseHandlers = {};
function connect() {
  es = new EventSource('/api/stream');
  es.onopen = () => { if (!S.online) { S.online = true; renderOffline(); catchUp(); } };
  es.onerror = () => { if (S.online) { S.online = false; setTimeout(renderOffline, 1500); } };
  es.addEventListener('message', e => onMessage(JSON.parse(e.data)));
  es.addEventListener('rooms', () => { loadRooms(); if (S.room) refreshRoom(); });
  es.addEventListener('agents', e => { const d = JSON.parse(e.data); if (S.room && d.room === S.room.id) refreshRoom(); });
  for (const [name, fns] of Object.entries(sseHandlers)) es.addEventListener(name, e => { const d = JSON.parse(e.data); for (const f of fns) f(d); });
}
function renderOffline() {
  let el = $('#offline');
  if (S.online) { if (el) el.remove(); return; }
  if (!el && $('#mn')) { el = document.createElement('div'); el.id = 'offline'; el.className = 'offline'; el.textContent = T('g.offline'); $('#mn').appendChild(el); }
}
async function catchUp() {
  await loadRooms();
  if (!S.room || S.hasNewer) return;
  const last = S.msgs.length ? S.msgs[S.msgs.length - 1].id : 0;
  try { const r = await api('GET', `/api/rooms/${S.room.id}/messages?after=${last}&limit=200`); for (const m of r.messages) onMessage(m); } catch {}
}
function onMessage(m) {
  if (S.room && m.room === S.room.id) {
    if (S.ids.has(m.id)) return;
    if (S.hasNewer) { S.unseen++; renderJump(); scheduleRooms(); return; }
    const sc = $('#sc'), atBottom = sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
    S.msgs.push(m); S.ids.add(m.id);
    for (const [k, p] of S.pending) if (p.id === m.id) S.pending.delete(k);
    renderFeed({ keep: !atBottom, bottom: atBottom || m.author.id === myId() });
    if (!atBottom && m.author.id !== myId()) { S.unseen++; renderJump(); }
    if (atBottom && document.visibilityState === 'visible') markRead();
  }
  scheduleRooms();
}
let roomsTimer = null;
function scheduleRooms() { clearTimeout(roomsTimer); roomsTimer = setTimeout(loadRooms, 250); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') markRead(); });

let readTimer = null;
function markRead() {
  clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    if (!S.room || !S.msgs.length || S.hasNewer) return;
    const last = S.msgs[S.msgs.length - 1].id;
    api('POST', `/api/rooms/${S.room.id}/read`, { last_id: last }).then(scheduleRooms).catch(() => {});
  }, 400);
}

// ------------------------------------------------------------------ routing
function nav(path, replace) { (replace ? history.replaceState : history.pushState).call(history, {}, '', path); route(); }
window.addEventListener('popstate', route);
async function route() {
  const p = location.pathname, qs = new URLSearchParams(location.search);
  if (qs.get('next') && qs.get('next').startsWith('/i/')) { location.href = qs.get('next'); return; }
  S.panel = false;
  if (narrow()) S.side = 'closed';
  const m = p.match(/^\/r\/(\w{12})$/);
  if (m) return openRoom(m[1], Number(qs.get('m')) || 0);
  if (p === '/new' || !S.rooms.length) { S.room = null; return renderNew(); }
  nav(`/r/${S.rooms[0].id}`, true);
}

// ------------------------------------------------------------------ shell
function renderShell() {
  const app = document.getElementById('app');
  app.className = 'shell';
  app.innerHTML = `<aside class="sb" id="sb" aria-label="${T('sb.rooms')}"></aside><main class="mn" id="mn"></main><div id="pnw"></div><div id="sbscrim"></div>`;
  applySide();
}
function applySide() {
  $('#app').dataset.side = S.side;
  const sc = $('#sbscrim');
  if (sc) sc.innerHTML = S.side === 'open' && narrow() ? '<div class="scrim sbs" data-act="side"></div>' : '';
}
async function loadRooms() {
  try { S.rooms = (await api('GET', '/api/rooms')).rooms; } catch { return; }
  renderSidebar();
  if (S.room && !S.rooms.some(r => r.id === S.room.id)) { toast(T('sb.gone')); S.room = null; nav('/', true); }
  const unread = S.rooms.reduce((n, r) => n + (r.id !== S.room?.id && r.unread ? 1 : 0), 0);
  document.title = (unread ? `(${unread}) ` : '') + (S.room ? `${S.room.title} · Slopovyna` : 'Slopovyna');
}
function renderSidebar() {
  const groups = [];
  for (const r of S.rooms) { const g = groupLabel(r.last_message_at); let last = groups[groups.length - 1]; if (!last || last.g !== g) groups.push(last = { g, items: [] }); last.items.push(r); }
  $('#sb').innerHTML = `
    <div class="sb-top"><a class="logo" href="/" data-nav="/"><img src="/mascot.svg" alt="">Slopovyna</a><button class="ib" data-act="side" aria-label="${T('sb.hide')}">${I.side}</button></div>
    <div class="nav">
      <a class="item" href="/new" data-nav="/new" ${location.pathname === '/new' ? 'aria-current="page"' : ''}>${I.edit}<span class="t">${T('sb.new')}</span></a>
      <button class="item" data-act="search">${I.search}<span class="t">${T('sb.search')}</span><span class="k">${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'}K</span></button>
    </div>
    <div class="sb-list">${groups.length ? groups.map(g => `<div class="grp">${esc(g.g)}</div>${g.items.map(r => {
      const cur = S.room && r.id === S.room.id;
      return `<a class="item" href="/r/${r.id}" data-nav="/r/${r.id}" ${cur ? 'aria-current="page"' : ''}><span class="t">${esc(r.title)}</span>${!cur && r.mentioned ? `<span class="at-badge" aria-label="${T('sb.mentioned')}">@</span>` : (!cur && r.unread ? `<span class="u" aria-label="${T('sb.unread')}"></span>` : '')}</a>`;
    }).join('')}`).join('') : `<p class="sb-empty">${T('sb.empty')}</p>`}</div>
    <div class="sb-foot"><div class="me">${avatar(S.me)}<span class="who">${esc(S.me.name)}<small>@${esc(S.me.login)}</small></span>${themeButton()}<button class="btn ghost sm" data-act="lang" aria-label="${T('lang.switch')}" title="${T('lang.switch')}">${T('lang.code')}</button><button class="ib" data-act="logout" aria-label="${T('sb.logout')}" title="${T('sb.logout')}">${I.out}</button></div></div>`;
}

// ------------------------------------------------------------------ new room
function renderNew() {
  document.title = `${T('new.title')} · Slopovyna`;
  renderSidebar();
  $('#pnw').innerHTML = '';
  $('#mn').innerHTML = `<header class="hd" id="hd"><button class="ib open-sb" data-act="side" aria-label="${T('sb.show')}">${I.side}</button><span class="ttl static"><span>${T('new.title')}</span></span></header>
    <div class="empty"><div class="col">
      <img class="art" src="/img/empty.webp?v=2" width="700" height="239" alt="">
      <h1>${T('new.h1')}</h1>
      ${composerHtml(T('new.ph'))}
      <div class="sugg">${T('new.hint')}</div>
    </div></div>`;
  $('.sugg').classList.add('foot');
  bindComposer({ onSend: async (text, _m, _e, idem) => {
    const r = await api('POST', '/api/rooms', { text, idem });
    await loadRooms(); nav(`/r/${r.id}`);
  }, key: 'new' });
  $('#ta').focus();
}

// ------------------------------------------------------------------ room
async function openRoom(id, around) {
  let info;
  try { info = await api('GET', `/api/rooms/${id}`); }
  catch (e) { S.room = null; renderSidebar(); $('#pnw').innerHTML = ''; $('#mn').innerHTML = `<header class="hd"><button class="ib open-sb" data-act="side" aria-label="${T('sb.show')}">${I.side}</button></header><main class="notice"><img src="/mascot.svg" alt="" width="56"><h1>${e.status === 404 ? T('room.notFound') : T('room.openFail')}</h1><p>${e.status === 404 ? T('room.notFoundText') : esc(e.message)}</p><a class="btn primary" href="/new" data-nav="/new">${T('sb.new')}</a></main>`; return; }
  S.room = { ...info.room, members: info.members, extra: info.extra || {} };
  S.msgs = []; S.ids = new Set(); S.unseen = 0; S.lastReadAtOpen = info.room.last_read_id;
  renderRoomFrame();
  const r = await api('GET', `/api/rooms/${id}/messages?${around ? `around=${around}&limit=60` : 'limit=50'}`);
  S.msgs = r.messages; S.ids = new Set(r.messages.map(m => m.id)); S.hasOlder = r.has_older; S.hasNewer = r.has_newer;
  S.lastIdAtOpen = r.messages.length ? r.messages[r.messages.length - 1].id : 0;
  renderFeed({ initial: true, around });
  if (!around) markRead();
  loadRooms();
}
async function refreshRoom() {
  if (!S.room) return;
  try { const info = await api('GET', `/api/rooms/${S.room.id}`); S.room = { ...S.room, ...info.room, members: info.members, extra: info.extra || {} }; renderHeader(); if (S.panel) renderPanel(); }
  catch (e) { if (e.status === 404) loadRooms(); }
}
function renderRoomFrame() {
  $('#mn').innerHTML = `<header class="hd" id="hd"></header>
    <div class="scroller" id="sc"><div class="col"><div id="older" class="older"></div><div id="feed"></div><div class="spacer"></div></div></div>
    <button class="jump" id="jump" data-act="bottom" aria-label="${T('room.toBottom')}" hidden>${I.down}<span id="jumpn"></span></button>
    ${composerHtml(T('room.ph'))}`;
  renderHeader(); renderSidebar(); renderPanel();
  $('#sc').addEventListener('scroll', onScroll, { passive: true });
  bindComposer({ onSend: sendMessage, key: S.room.id, mentions: true });
  if (!narrow()) $('#ta').focus();
  renderOffline();
}
function renderHeader() {
  const ms = members();
  document.title = `${S.room.title} · Slopovyna`;
  $('#hd').innerHTML = `<button class="ib open-sb" data-act="side" aria-label="${T('sb.show')}">${I.side}</button>
    <button class="ttl" data-act="panel" aria-label="${T('room.panel')}"><span>${esc(S.room.title)}</span>${I.chev}</button><span class="sp"></span>
    <button class="pile" data-act="panel" aria-label="${T('room.members', { n: ms.length })}"><span class="avs">${ms.slice(0, 5).map(p => avatar(p)).join('')}</span><span class="lbl">${ms.length}</span></button>`;
}

function renderFeed({ initial, keep, bottom, around, prepend } = {}) {
  const sc = $('#sc'), feed = $('#feed'); if (!feed) return;
  const prevH = sc.scrollHeight, prevTop = sc.scrollTop;
  let html = '', lastDay = '', newMarked = false;
  const firstUnread = S.msgs.find(m => m.id > S.lastReadAtOpen && m.id <= (S.lastIdAtOpen || 0) && m.author.id !== myId() && m.kind !== 'event');
  if (!S.msgs.length) html = `<div class="roomempty"><img class="art" src="/img/empty.webp?v=2" width="700" height="239" alt=""><p>${T('room.empty')}</p></div>`;
  for (const m of S.msgs) {
    const d = dayLabel(m.at);
    if (d !== lastDay) { html += `<div class="date"><span>${esc(d)}</span></div>`; lastDay = d; }
    if (!newMarked && firstUnread && m.id === firstUnread.id && S.lastReadAtOpen) { html += `<div class="newline" id="newline">${T('room.new')}</div>`; newMarked = true; }
    html += msgHtml(m);
  }
  for (const p of S.pending.values()) if (!S.ids.has(p.id)) html += msgHtml({ ...p.view, pending: true });
  feed.innerHTML = html;
  $('#older').innerHTML = S.hasOlder ? (S.loadingOlder ? `<span class="spin" aria-hidden="true"></span>${T('room.loadingOlder')}` : '') : (S.msgs.length ? T('room.start', { date: esc(dayFmtY.format(S.room.created_at)) }) : '');
  if (prepend) sc.scrollTop = prevTop + (sc.scrollHeight - prevH);
  else if (initial) {
    const target = around ? $(`#m${around}`) : $('#newline');
    if (target) { target.scrollIntoView({ block: around ? 'center' : 'start' }); if (around) flash(target); }
    else sc.scrollTop = sc.scrollHeight;
  } else if (bottom) sc.scrollTop = sc.scrollHeight;
  else if (keep) sc.scrollTop = prevTop;
  const cmp = $('.cmp'); if (cmp) document.documentElement.style.setProperty('--compH', cmp.offsetHeight + 'px');
  renderJump();
}
function flash(el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
function msgHtml(m) {
  if (m.kind === 'event') return `<div class="ev" id="m${m.id}">${esc(window.SlopI18n.event(m.text))} · ${timeFmt.format(m.at)}</div>`;
  const a = m.author, mine = a.id === myId();
  const body = m.kind === 'summary' ? `<div class="sum"><div class="slb">${I.check}${T('room.summary')}</div><div class="tx">${md(m.text, m.mentions)}</div></div>` : `<div class="tx">${md(m.text, m.mentions)}</div>`;
  const extra = renderExtras(m);
  if (mine && m.kind !== 'summary') {
    const meta = m.failed ? `<div class="meta err">${esc(m.failed)}</div>` : `<div class="meta">${m.pending ? T('room.sending') : timeFmt.format(m.at)}</div>`;
    return `<div class="m mine${m.pending ? ' pending' : ''}" id="m${m.id}"><div class="bub tx">${md(m.text, m.mentions)}</div>${extra}${meta}</div>`;
  }
  const owner = a.kind === 'agent' ? `<span class="o">${esc(a.owner_name || '')}</span><span class="tag">${T('g.agent')}</span>` : '';
  return `<div class="m" id="m${m.id}">${avatar(a)}<div><div class="nm">${esc(nameOf(a))}${owner}<time datetime="${new Date(m.at).toISOString()}">${timeFmt.format(m.at)}</time></div>${body}${extra}</div></div>`;
}
const extraRenderers = [];      // attachments and delivery state plug in here
const renderExtras = m => extraRenderers.map(f => f(m)).join('');

function onScroll() {
  const sc = $('#sc');
  if (sc.scrollTop < 300 && S.hasOlder && !S.loadingOlder) loadOlder();
  const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
  if (nearBottom && S.hasNewer && !S.loadingNewer) loadNewer();
  if (nearBottom && S.unseen && !S.hasNewer) { S.unseen = 0; markRead(); }
  renderJump();
}
async function loadOlder() {
  S.loadingOlder = true; renderFeed({ keep: true });
  try {
    const r = await api('GET', `/api/rooms/${S.room.id}/messages?before=${S.msgs[0].id}&limit=50`);
    const fresh = r.messages.filter(m => !S.ids.has(m.id));
    S.msgs = fresh.concat(S.msgs); fresh.forEach(m => S.ids.add(m.id)); S.hasOlder = r.has_older;
  } catch (e) { toast(e.message); }
  S.loadingOlder = false; renderFeed({ prepend: true });
}
async function loadNewer() {
  S.loadingNewer = true;
  try {
    const r = await api('GET', `/api/rooms/${S.room.id}/messages?after=${S.msgs[S.msgs.length - 1].id}&limit=100`);
    const fresh = r.messages.filter(m => !S.ids.has(m.id));
    S.msgs = S.msgs.concat(fresh); fresh.forEach(m => S.ids.add(m.id)); S.hasNewer = r.has_newer;
    if (!S.hasNewer) { S.unseen = 0; markRead(); }
  } catch {}
  S.loadingNewer = false; renderFeed({ keep: true });
}
function renderJump() {
  const j = $('#jump'), sc = $('#sc'); if (!j || !sc) return;
  const far = sc.scrollHeight - sc.scrollTop - sc.clientHeight > 240;
  j.hidden = !(far || S.hasNewer);
  $('#jumpn').textContent = S.unseen ? T(S.unseen === 1 ? 'room.unseen1' : 'room.unseenN', { n: S.unseen }) : '';
}
async function jumpBottom() {
  if (S.hasNewer) {
    const r = await api('GET', `/api/rooms/${S.room.id}/messages?limit=50`);
    S.msgs = r.messages; S.ids = new Set(r.messages.map(m => m.id)); S.hasOlder = r.has_older; S.hasNewer = false;
    history.replaceState({}, '', `/r/${S.room.id}`);
  }
  S.unseen = 0; renderFeed({ bottom: true }); markRead();
}

// ------------------------------------------------------------------ composer
function composerHtml(ph) {
  return `<div class="cmp"><div class="col"><form class="cbox" id="cform" autocomplete="off">
    <div class="pop" id="pop" role="listbox" aria-label="${T('c.mention')}" hidden></div>
    <div id="chips"></div>
    <label for="ta" class="sr">${T('c.message')}</label>
    <textarea id="ta" rows="1" placeholder="${esc(ph)}" enterkeyhint="send"></textarea>
    <div class="cerr" id="cerr" role="alert" hidden></div>
    <div class="crow"><span id="attachSlot"></span><span class="sp"></span><button type="submit" class="rb go" id="go" aria-label="${T('c.send')}" disabled>${I.up}</button></div>
  </form><div class="foot">${T('c.foot')}</div></div></div>`;
}
let composerHooks = { slot: () => '', bind: () => {}, ready: () => true, collect: () => ({}), reset: () => {} };
function bindComposer({ onSend, key, mentions }) {
  const ta = $('#ta'), go = $('#go'), pop = $('#pop'), err = $('#cerr');
  const D = window.SlopDraft;
  const lbl = id => { const p = memberById(id); return p ? labelOf(p) : null; };
  const saved = D.load(store, key);
  ta.value = saved.text;
  S.mentions = new Set(D.liveMentions(saved.text, saved.mentions, lbl));
  const persist = () => D.save(store, key, ta.value, D.liveMentions(ta.value, [...S.mentions], lbl));
  const can = () => !!(ta.value.trim() || composerHooks.collect().hasFiles) && composerHooks.ready();
  const sync = () => { go.disabled = !can(); grow(); };
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; const cmp = $('.cmp'); if (cmp) document.documentElement.style.setProperty('--compH', cmp.offsetHeight + 'px'); };
  $('#attachSlot').innerHTML = mentions ? composerHooks.slot() : '';
  if (mentions) composerHooks.bind(sync);
  ta.addEventListener('input', () => { persist(); err.hidden = true; sync(); if (mentions) showPop(); });
  ta.addEventListener('keydown', e => {
    if (!pop.hidden && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      const o = [...pop.querySelectorAll('button')]; let k = o.findIndex(x => x.getAttribute('aria-selected') === 'true');
      e.preventDefault();
      if (e.key === 'Escape') { pop.hidden = true; return; }
      if (e.key === 'ArrowDown') k = (k + 1) % o.length; else if (e.key === 'ArrowUp') k = (k - 1 + o.length) % o.length; else { o[k].click(); return; }
      o.forEach((x, j) => x.setAttribute('aria-selected', j === k)); return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !narrow()) { e.preventDefault(); submit(); }
  });
  ta.addEventListener('blur', () => setTimeout(() => { pop.hidden = true; }, 150));
  $('#cform').addEventListener('submit', e => { e.preventDefault(); submit(); });
  pop.addEventListener('mousedown', e => e.preventDefault());
  pop.addEventListener('click', e => { const b = e.target.closest('[data-mention]'); if (b) insertMention(b.dataset.mention); });
  function showPop() {
    const m = ta.value.slice(0, ta.selectionStart).match(/(?:^|\s)@([^\s@]{0,30})$/);
    if (!m) { pop.hidden = true; return; }
    const q = m[1].toLowerCase();
    const list = members().filter(p => p.id !== myId() && (labelOf(p).toLowerCase().includes(q) || (p.login || '').toLowerCase().startsWith(q))).slice(0, 8);
    if (!list.length) { pop.hidden = true; return; }
    pop.innerHTML = list.map((p, j) => `<button type="button" role="option" aria-selected="${j === 0}" data-mention="${esc(p.id)}">${avatar(p)}${esc(labelOf(p))}<small>${p.kind === 'agent' ? (p.listening ? T('c.listening') : T('c.offline')) : T('c.human')}</small></button>`).join('');
    pop.hidden = false;
  }
  function insertMention(id) {
    const p = memberById(id); if (!p) return;
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos).replace(/@([^\s@]{0,30})$/, '@' + labelOf(p) + ' ');
    ta.value = before + ta.value.slice(pos); S.mentions.add(id);
    pop.hidden = true; ta.focus(); ta.setSelectionRange(before.length, before.length);
    persist(); sync();
  }
  let busy = false;
  async function submit() {
    if (!can() || busy) return;
    const raw = ta.value, text = raw.trim();
    const ments = D.liveMentions(text, [...S.mentions], lbl);
    const idem = D.attempt(store, key, text, newKey);
    busy = true; go.disabled = true; err.hidden = true;
    try {
      await onSend(text, ments, composerHooks.collect(), idem);
      // Keep whatever was typed while the message was on its way.
      const left = D.afterSend(store, key, raw, ta.value, [...S.mentions], lbl);
      ta.value = left.text; S.mentions = new Set(left.mentions); composerHooks.reset();
    } catch (e) {
      err.textContent = e.status ? e.message : T('c.noServer'); err.hidden = false;
    } finally { busy = false; sync(); }
  }
  sync();
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')).replace(/-/g, '').slice(0, 32);
async function sendMessage(text, mentions, extra, idem) {
  const tmpId = `p${idem}`;
  const view = { id: tmpId, room: S.room.id, kind: 'message', text: text || ' ', at: Date.now(), author: { ...S.me, id: myId() }, mentions };
  S.pending.set(tmpId, { view, id: null });
  renderFeed({ bottom: true });
  try {
    const m = await api('POST', `/api/rooms/${S.room.id}/messages`, { text, mentions, idem, ...(extra.body || {}) });
    S.pending.delete(tmpId);
    if (!S.ids.has(m.id) && !S.hasNewer) { S.msgs.push(m); S.ids.add(m.id); }
    renderFeed({ bottom: true }); markRead();
  } catch (e) { S.pending.delete(tmpId); renderFeed({ keep: true }); throw e; }
}

// ------------------------------------------------------------------ panel (room & members)
function renderPanel() {
  const w = $('#pnw'); if (!w || !S.room) { if (w) w.innerHTML = ''; return; }
  const owner = S.room.role === 'owner';
  const row = p => `<div class="row">${avatar(p)}<span class="nmw"><b>${esc(labelOf(p))}</b><small>${p.role === 'owner' ? T('p.owner') : (p.login ? '@' + esc(p.login) : '')}${p.id === myId() ? T('p.you') : ''}</small></span>
    ${p.id === myId() && p.role !== 'owner' ? `<button class="btn sm" data-act="leave">${T('p.leave')}</button>` : ''}
    ${owner && p.id !== myId() ? `<button class="btn sm danger" data-act="kick" data-uid="${p.uid}" data-name="${esc(p.name)}">${T('p.kick')}</button>` : ''}</div>`;
  w.innerHTML = `${S.panel ? '<div class="scrim" data-act="panel"></div>' : ''}
  <aside class="pn ${S.panel ? 'open' : ''}" aria-label="${T('p.room')}" ${S.panel ? '' : 'aria-hidden="true" inert'}>
    <div class="pn-h"><h2>${esc(S.room.title)}</h2><button class="ib" data-act="panel" aria-label="${T('g.close')}">${I.x}</button></div>
    <div class="pn-b">
      <h3>${T('p.people')}</h3>${S.room.members.map(row).join('')}
      ${panelAgents()}
      <div class="acts">${panelActions()}${owner ? `<button class="btn" data-act="invite">${I.user}${T('p.invite')}</button>` : ''}</div>
      ${owner ? `<div id="invites"></div>` : ''}
      ${panelFiles()}
      ${owner ? `<h3>${T('p.room')}</h3><div class="fld"><label for="rt">${T('p.title')}</label><div class="inp plain"><input id="rt" value="${esc(S.room.title)}" maxlength="80"></div></div>
        <div class="acts"><button class="btn danger" data-act="delete">${T('p.delete')}</button></div>` : ''}
      ${panelNotes()}
    </div>
  </aside>`;
  if (owner && S.panel) {
    loadInvites();
    const rt = $('#rt');
    rt.addEventListener('change', async () => { const t = rt.value.trim(); if (!t || t === S.room.title) return; try { await api('PATCH', `/api/rooms/${S.room.id}`, { title: t }); S.room.title = t; renderHeader(); loadRooms(); toast(T('p.renamed')); } catch (e) { toast(e.message); } });
  }
}
let panelAgents = () => '', panelActions = () => '', panelNotes = () => '', panelFiles = () => '';
async function loadInvites() {
  const el = $('#invites'); if (!el) return;
  try {
    const { invites } = await api('GET', `/api/rooms/${S.room.id}/invites`);
    el.innerHTML = invites.length ? `<h3>${T('p.pending')}</h3><ul class="invl">${invites.map(i => `<li><span>@${esc(i.github_login)} · ${T('p.until', { date: esc(dayFmt.format(i.expires_at)) })}</span><button class="btn sm" data-act="revoke-inv" data-id="${i.id}">${T('p.revoke')}</button></li>`).join('')}</ul>` : '';
  } catch {}
}

function openInvite() {
  const d = $('#dlg');
  d.innerHTML = `<div class="dh"><h2>${T('i.title')}</h2><button class="ib" data-close aria-label="${T('g.close')}">${I.x}</button></div>
  <form class="db" id="invf"><div class="fld"><label for="gh">${T('i.login')}</label><div class="inp"><span>github.com/</span><input id="gh" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="${T('i.ph')}" required></div>
    <div class="hint" id="hh">${T('i.hint')}</div></div><div id="io"></div>
    <div class="df" id="invbtns"><button class="btn primary" id="mk">${T('i.make')}</button></div></form>`;
  d.showModal(); $('#gh').focus();
  $('#invf').onsubmit = async e => {
    e.preventDefault();
    const hh = $('#hh'), v = $('#gh').value.trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
    $('#mk').disabled = true;
    try {
      const r = await api('POST', `/api/rooms/${S.room.id}/invites`, { github_login: v });
      hh.className = 'hint'; hh.textContent = T('i.made', { login: r.login, date: dayFmt.format(r.expires_at) });
      $('#io').innerHTML = `<div class="cp"><code>${esc(r.url)}</code><button type="button" class="btn sm" data-copytext="${esc(r.url)}">${T('g.copy')}</button></div>`;
      $('#invbtns').innerHTML = `<button type="button" class="btn" data-close>${T('g.done')}</button>`;
      loadInvites();
    } catch (err) { hh.className = 'hint err'; hh.textContent = err.message; $('#mk').disabled = false; }
  };
}

// ------------------------------------------------------------------ search
function openSearch() {
  const d = $('#dSearch');
  d.innerHTML = `<div class="sr-in">${I.search}<label class="sr" for="q">${T('q.label')}</label><input id="q" placeholder="${T('q.ph')}" autocomplete="off"><button class="ib" data-close aria-label="${T('g.close')}">${I.x}</button></div><div class="sr-list" id="sl" role="listbox"><p class="sr-none">${T('q.min')}</p></div>`;
  d.setAttribute('aria-label', T('q.label'));
  d.showModal();
  const q = $('#q'); let t = null, seq = 0;
  q.focus();
  q.oninput = () => { clearTimeout(t); t = setTimeout(run, 180); };
  q.onkeydown = e => {
    const o = [...d.querySelectorAll('#sl button')]; if (!o.length) return;
    let k = o.findIndex(x => x.getAttribute('aria-selected') === 'true');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); k = e.key === 'ArrowDown' ? (k + 1) % o.length : (k - 1 + o.length) % o.length; o.forEach((x, j) => x.setAttribute('aria-selected', j === k)); o[k].scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'Enter' && k >= 0) { e.preventDefault(); o[k].click(); }
  };
  async function run() {
    const v = q.value.trim(), my = ++seq;
    if (v.length < 2) { $('#sl').innerHTML = `<p class="sr-none">${T('q.min')}</p>`; return; }
    let r; try { r = await api('GET', `/api/search?q=${encodeURIComponent(v)}`); } catch (e) { $('#sl').innerHTML = `<p class="sr-none">${esc(e.message)}</p>`; return; }
    if (my !== seq) return;
    const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    $('#sl').innerHTML = r.hits.length ? r.hits.map((h, i) => `<button role="option" aria-selected="${i === 0}" data-hit="/r/${h.room}?m=${h.id}"><b>${esc(h.room_title)}</b><span>${esc(h.snippet).replace(re, x => `<mark>${x}</mark>`)}</span><span class="w">${esc(h.author)} · ${esc(dayLabel(h.at))} ${timeFmt.format(h.at)}</span></button>`).join('') : `<p class="sr-none">${T('q.none')}</p>`;
  }
}

// ------------------------------------------------------------------ misc UI
let toastT = null;
function toast(text) {
  let el = $('#toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = text; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 3200);
}
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); if (btn) { const t = btn.textContent; btn.textContent = T('g.copied'); setTimeout(() => { btn.textContent = t; }, 1500); } }
  catch { toast(T('g.copyFail')); }
}

document.addEventListener('click', async e => {
  const n = e.target.closest('[data-nav]');
  if (n && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); nav(n.dataset.nav); return; }
  if (e.target.closest('[data-close]')) { e.target.closest('dialog').close(); return; }
  const hit = e.target.closest('[data-hit]');
  if (hit) { $('#dSearch').close(); nav(hit.dataset.hit); return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) { copy(cp.closest('pre').querySelector('code').textContent, cp); return; }
  const ct = e.target.closest('[data-copytext]');
  if (ct) { copy(ct.dataset.copytext, ct); return; }
  const t = e.target.closest('[data-act]'); if (!t) return;
  const a = t.dataset.act;
  try {
    if (a === 'side') { S.side = S.side === 'open' ? 'closed' : 'open'; applySide(); }
    else if (a === 'panel') { S.panel = !S.panel; renderPanel(); }
    else if (a === 'search') openSearch();
    else if (a === 'lang') window.SlopI18n.set(window.SlopI18n.lang() === 'en' ? 'uk' : 'en');
    else if (a === 'theme') window.SlopTheme.toggle();
    else if (a === 'invite') openInvite();
    else if (a === 'bottom') jumpBottom();
    else if (a === 'logout') { await api('POST', '/auth/logout'); location.href = '/'; }
    else if (a === 'revoke-inv') { await api('DELETE', `/api/rooms/${S.room.id}/invites/${t.dataset.id}`); loadInvites(); }
    else if (a === 'kick') { if (confirm(T('p.kickQ', { name: t.dataset.name }))) { await api('DELETE', `/api/rooms/${S.room.id}/members/${t.dataset.uid}`); refreshRoom(); } }
    else if (a === 'leave') { if (confirm(T('p.leaveQ'))) { await api('DELETE', `/api/rooms/${S.room.id}/members/${S.me.uid}`); S.room = null; await loadRooms(); nav('/'); } }
    else if (a === 'delete') { if (confirm(T('p.deleteQ', { title: S.room.title }))) { await api('DELETE', `/api/rooms/${S.room.id}`); S.room = null; await loadRooms(); nav('/'); } }
    else if (actions[a]) await actions[a](t, e);
  } catch (err) { toast(err.message); }
});
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && S.me) { e.preventDefault(); if (!$('#dSearch').open) openSearch(); }
  if (e.key === 'Escape' && S.panel && !document.querySelector('dialog[open]')) { S.panel = false; renderPanel(); }
});
matchMedia('(max-width:860px)').addEventListener('change', () => { S.side = narrow() ? 'closed' : 'open'; applySide(); });

// Extension points for later parts of the client (agents, files).
const actions = {};
window.Slop = {
  S, api, esc, md, avatar, labelOf, toast, copy, I, $, actions, refreshRoom, renderFeed, myId, T, fmt: () => ({ timeFmt, dayFmt, dayFmtY }),
  setExtras: f => { extraRenderers.push(f); }, prependExtras: f => { extraRenderers.unshift(f); }, setPanel: o => { if (o.agents) panelAgents = o.agents; if (o.actions) panelActions = o.actions; if (o.notes) panelNotes = o.notes; if (o.files) panelFiles = o.files; },
  setComposer: h => { composerHooks = { ...composerHooks, ...h }; },
  on: (name, f) => { (sseHandlers[name] ||= []).push(f); }, csrf: () => CSRF,
  renderPanel: () => renderPanel(), renderHeader: () => renderHeader(),
};
// Switching the language redraws what is on screen, keeping the room, the scroll and the draft.
window.SlopI18n.onChange(() => {
  makeFormatters();
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  if (!S.me) return signin();
  renderSidebar();
  if (S.room) { const top = $('#sc')?.scrollTop; renderRoomFrame(); renderFeed({}); if (top != null) $('#sc').scrollTop = top; }
  else renderNew();
});
document.addEventListener('DOMContentLoaded', boot);
})();
