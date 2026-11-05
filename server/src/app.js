// Slopovyna server: rooms where people and their agents talk. Plain node:http, node:sqlite, no deps.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('./db');
const { makeAuth } = require('./auth');
const { sha256, token, randomId, HttpError, readJSON, findSecret } = require('./util');
const { t, langOf, eventText } = require('./i18n');

const PUBLIC = path.join(__dirname, '..', 'public');
const MAX_TEXT = 20000;
const PAGE = 50;
const INVITE_DAYS = 7;

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon' };
const CSP_BASE = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://avatars.githubusercontent.com; font-src 'self'; connect-src 'self' __CONNECT__; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com; object-src 'none'";

function createApp(config) {
  // Files go straight between the browser and a room's bucket, so fetch() may reach https origins.
  const CSP = CSP_BASE.replace('__CONNECT__', config.connectSrc || 'https:');
  const db = open(config.dbFile);
  const auth = makeAuth({ db, config });
  const hooks = { onMessage: [], afterMessage: [], decorate: [], onMemberRemove: [], onRoomDelete: [], attach: [] };   // agents plug in here

  // ---------------------------------------------------------------- live updates (SSE per person)
  const streams = new Map();              // user id -> Set<res>
  function push(userIds, event, data) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const uid of userIds) for (const res of streams.get(uid) || []) res.write(line);
  }
  const memberIds = roomId => db.all('SELECT user_id FROM members WHERE room_id = ?', roomId).map(r => r.user_id);
  const heartbeat = setInterval(() => { for (const set of streams.values()) for (const res of set) res.write(': ping\n\n'); }, 25000);
  heartbeat.unref();
  const flush = setInterval(() => authorCache.clear(), 60000); flush.unref();

  // ---------------------------------------------------------------- shapes
  function userView(u) { return { kind: 'human', id: `u:${u.id}`, uid: u.id, name: u.name || u.login, login: u.login, avatar: u.avatar }; }
  const authorCache = new Map();
  function author(kind, id) {
    const key = `${kind}:${id}`;
    if (authorCache.has(key)) return authorCache.get(key);
    let a;
    if (kind === 'human') { const u = db.get('SELECT * FROM users WHERE id = ?', Number(id)); a = u ? userView(u) : { kind, id: key, name: '', deleted: true }; }
    else if (kind === 'system') a = { kind, id: 'system', name: 'Slopovyna' };
    else a = describeAgent ? describeAgent(id) : { kind, id: key, name: 'Agent' };
    authorCache.set(key, a);
    return a;
  }
  let describeAgent = null;
  function messageView(m) {
    const v = { id: m.id, room: m.room_id, kind: m.kind, text: m.text, at: m.created_at, author: author(m.author_kind, m.author_id),
      mentions: db.all('SELECT target FROM mentions WHERE message_id = ?', m.id).map(r => r.target) };
    for (const d of hooks.decorate) d(v, m);
    return v;
  }
  function membership(roomId, userId) { return db.get('SELECT role, last_read_id FROM members WHERE room_id = ? AND user_id = ?', roomId, userId); }
  function needMember(roomId, user) {
    const m = membership(roomId, user.id);
    if (!m) throw new HttpError(404, 'room.notFound');
    return m;
  }
  function roomMembersView(roomId) {
    return db.all(`SELECT u.*, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY m.role = 'owner' DESC, m.added_at`, roomId)
      .map(u => ({ ...userView(u), role: u.role }));
  }

  // ---------------------------------------------------------------- writing messages
  function postMessage({ roomId, authorKind, authorId, text, kind = 'message', mentions = [], idem = null, attachments = [] }) {
    text = String(text || '').replace(/\r\n/g, '\n');
    const files = Array.isArray(attachments) ? [...new Set(attachments.map(String))] : [];
    if (!text.trim() && !files.length) throw new HttpError(400, 'msg.empty');
    if (text.length > MAX_TEXT) throw new HttpError(413, 'msg.tooLong', { vars: { n: text.length, max: MAX_TEXT } });
    if (authorKind !== 'system') { const s = findSecret(text); if (s) throw new HttpError(422, authorKind === 'agent' ? 'msg.secretAgent' : 'msg.secret', { vars: { what: { key: s } } }); }
    if (idem) {
      const dup = db.get('SELECT * FROM messages WHERE room_id = ? AND author_kind = ? AND author_id = ? AND idem_key = ?', roomId, authorKind, String(authorId), idem);
      if (dup) return { message: messageView(dup), duplicate: true };
    }
    const valid = new Set(validTargets(roomId));
    const targets = [...new Set((Array.isArray(mentions) ? mentions : []).map(String))].filter(t => valid.has(t) && t !== `${authorKind === 'human' ? 'u' : 'a'}:${authorId}`);
    const now = Date.now();
    const row = db.tx(() => {
      const r = db.run('INSERT INTO messages (room_id, author_kind, author_id, kind, text, text_lc, idem_key, created_at) VALUES (?,?,?,?,?,?,?,?)',
        roomId, authorKind, String(authorId), kind, text, text.toLowerCase(), idem, now);
      const id = Number(r.lastInsertRowid);
      for (const t of targets) db.run('INSERT INTO mentions (message_id, target) VALUES (?,?)', id, t);
      for (const h of hooks.attach) h({ messageId: id, roomId, authorKind, authorId: String(authorId), files });
      db.run('UPDATE rooms SET last_message_at = ? WHERE id = ?', now, roomId);
      if (authorKind === 'human') db.run('UPDATE members SET last_read_id = ? WHERE room_id = ? AND user_id = ?', id, roomId, Number(authorId));
      const m = db.get('SELECT * FROM messages WHERE id = ?', id);
      for (const h of hooks.onMessage) h(m, targets);   // same transaction: inbox events commit with the message
      return m;
    });
    const view = messageView(row);
    push(memberIds(roomId), 'message', view);
    for (const h of hooks.afterMessage) h(row, targets);
    return { message: view, duplicate: false };
  }
  let validTargets = roomId => db.all('SELECT user_id FROM members WHERE room_id = ?', roomId).map(r => `u:${r.user_id}`);
  const event = (roomId, key, vars) => postMessage({ roomId, authorKind: 'system', authorId: 'system', kind: 'event', text: eventText(key, vars) });

  // ---------------------------------------------------------------- rooms
  function roomsFor(user) {
    return db.all(`SELECT r.id, r.title, r.owner_id, r.created_at, r.last_message_at, m.role, m.last_read_id,
                     (SELECT count(*) FROM messages x WHERE x.room_id = r.id AND x.id > m.last_read_id AND NOT (x.author_kind = 'human' AND x.author_id = ?)) AS unread,
                     (SELECT count(*) FROM mentions mm JOIN messages x ON x.id = mm.message_id WHERE x.room_id = r.id AND x.id > m.last_read_id AND mm.target = ?) AS mentioned
                   FROM members m JOIN rooms r ON r.id = m.room_id WHERE m.user_id = ? ORDER BY r.last_message_at DESC`, String(user.id), `u:${user.id}`, user.id);
  }
  function titleFrom(text, lang) {
    const line = text.split('\n').map(s => s.trim()).find(Boolean) || t(lang, 'room.untitled');
    const clean = line.replace(/@\S+(?: · \S+)?/g, '').replace(/[*`#>_]/g, '').trim() || t(lang, 'room.untitled');
    return clean.length > 60 ? clean.slice(0, 57).replace(/\s+\S*$/, '') + '…' : clean;
  }
  function createRoom(user, { title, text, idem }, lang = 'en') {
    const key = typeof idem === 'string' && /^[\w-]{8,64}$/.test(idem) ? idem : null;
    if (key) { const had = db.get('SELECT id FROM rooms WHERE owner_id = ? AND create_key = ?', user.id, key); if (had) return had.id; }
    text = String(text || '').trim();
    const tt = String(title || '').trim().slice(0, 80) || (text ? titleFrom(text, lang) : '');
    if (!tt) throw new HttpError(400, 'room.needTopic');
    if (text) { const s = findSecret(text); if (s) throw new HttpError(422, 'msg.secret', { vars: { what: { key: s } } }); }
    const id = randomId(12), now = Date.now();
    db.tx(() => {
      db.run('INSERT INTO rooms (id, title, owner_id, created_at, last_message_at, create_key) VALUES (?,?,?,?,?,?)', id, tt, user.id, now, now, key);
      db.run('INSERT INTO members (room_id, user_id, role, added_at) VALUES (?,?,?,?)', id, user.id, 'owner', now);
    });
    event(id, 'ev.created');
    if (text) postMessage({ roomId: id, authorKind: 'human', authorId: user.id, text, idem: key });
    return id;
  }

  // ---------------------------------------------------------------- http plumbing
  function send(res, code, body, headers = {}) {
    const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(code, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers });
    res.end(isObj ? JSON.stringify(body) : body);
  }
  function serveStatic(res, rel, { html = false } = {}) {
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found');
    fs.readFile(file, (err, buf) => {
      if (err) return page(res, 404, 'page.404Title', 'page.404Text');
      const ext = path.extname(file);
      if (html) { const lang = res.slopLang || 'en'; buf = Buffer.from(buf.toString('utf8').replaceAll('__BASE_URL__', config.baseUrl).replaceAll('__LANG__', lang).replaceAll('__OG_TITLE__', t(lang, 'og.title')).replaceAll('__OG_DESC__', t(lang, 'og.desc'))); }
      send(res, 200, buf, { 'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Cache-Control': html ? 'no-store' : (/\.(woff2?|png|webp|jpg)$/.test(ext) ? 'public, max-age=604800' : 'no-cache'),
        'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY',
        ...(config.baseUrl.startsWith('https://') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}) });
    });
  }
  // A full page (invites, sign-in trouble, 404) in the reader's language. title/text are i18n keys;
  // text may be a literal when it already is one (an error message translated by the caller).
  function page(res, code, titleKey, textKey, vars, link = ['page.home', '/']) {
    const lang = res.slopLang || 'en';
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const title = t(lang, titleKey, vars), text = t(lang, textKey, vars);
    const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Slopovyna</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:site_name" content="Slopovyna"><meta property="og:title" content="${esc(t(lang, 'og.title'))}"><meta property="og:image" content="${esc(config.baseUrl)}/img/og-${lang}.png"><meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#ffffff"><script src="/theme.js"></script><link rel="stylesheet" href="/app.css"></head>
<body class="plain"><main class="notice"><img class="art" src="/img/empty.webp?v=2" alt="" width="700" height="239"><div class="brand"><img src="/mascot.svg" alt="" width="22">Slopovyna</div><h1>${esc(title)}</h1><p>${esc(text)}</p>${link ? `<a class="btn primary" href="${esc(link[1])}">${esc(t(lang, link[0]))}</a>` : ''}</main></body></html>`;
    send(res, code, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY', ...(config.baseUrl.startsWith('https://') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}) });
  }

  const routes = [];                       // [method, regex, handler(ctx)]
  const route = (method, re, fn) => routes.push([method, re, fn]);
  const ctxApi = { db, auth, config, push, messageView, readJSON, HttpError, postMessage, event, membership, needMember, author, authorCache, roomMembersView, memberIds, route, hooks, send, page, userView,
    setValidTargets: f => { validTargets = f; }, getValidTargets: () => validTargets, setDescribeAgent: f => { describeAgent = f; }, streams };

  // ---------------------------------------------------------------- routes: auth
  route('GET', /^\/auth\/github$/, ({ req, res, url }) => auth.begin(req, res, url));
  route('GET', /^\/auth\/callback$/, async ({ req, res, url }) => {
    try { await auth.callback(req, res, url); }
    catch (e) { if (e instanceof HttpError) return page(res, e.status, 'auth.failedTitle', e.message, e.extra?.vars, ['auth.retry', '/auth/github']); throw e; }
  });
  route('GET', /^\/auth\/dev$/, ({ req, res, url }) => auth.devLogin(req, res, url));
  route('POST', /^\/auth\/logout$/, ({ req, res, s }) => { if (s) auth.checkCsrf(req, s); send(res, 200, { ok: true }, { 'Set-Cookie': auth.logout(req) }); });

  // ---------------------------------------------------------------- routes: API for people
  route('GET', /^\/api\/me$/, ({ res, s }) => send(res, 200, { user: userView(s.user), csrf: s.csrf, devLogin: !!config.devLogin }));

  route('GET', /^\/api\/rooms$/, ({ res, s }) => send(res, 200, { rooms: roomsFor(s.user) }));
  route('POST', /^\/api\/rooms$/, async ({ req, res, s }) => {
    const b = await readJSON(req);
    const id = createRoom(s.user, b, res.slopLang);
    push([s.user.id], 'rooms', {});
    send(res, 201, { id });
  });
  route('GET', /^\/api\/rooms\/([\w]{12})$/, ({ res, s, m }) => {
    const me = needMember(m[1], s.user);
    const r = db.get('SELECT * FROM rooms WHERE id = ?', m[1]);
    send(res, 200, { room: { id: r.id, title: r.title, owner: r.owner_id, created_at: r.created_at, role: me.role, last_read_id: me.last_read_id }, members: roomMembersView(r.id), extra: extraRoomInfo(r.id, s.user) });
  });
  let extraRoomInfo = () => ({});
  ctxApi.setExtraRoomInfo = f => { extraRoomInfo = f; };
  ctxApi.getExtraRoomInfo = () => extraRoomInfo;
  route('PATCH', /^\/api\/rooms\/([\w]{12})$/, async ({ req, res, s, m }) => {
    const me = needMember(m[1], s.user);
    if (me.role !== 'owner') throw new HttpError(403, 'room.renameOwner');
    const b = await readJSON(req);
    const title = String(b.title || '').trim().slice(0, 80);
    if (!title) throw new HttpError(400, 'room.titleEmpty');
    db.run('UPDATE rooms SET title = ? WHERE id = ?', title, m[1]);
    push(memberIds(m[1]), 'rooms', {});
    send(res, 200, { ok: true });
  });
  route('DELETE', /^\/api\/rooms\/([\w]{12})$/, ({ res, s, m }) => {
    const me = needMember(m[1], s.user);
    if (me.role !== 'owner') throw new HttpError(403, 'room.deleteOwner');
    const ids = memberIds(m[1]);
    for (const h of hooks.onRoomDelete || []) h(m[1]);
    db.run('DELETE FROM rooms WHERE id = ?', m[1]);
    push(ids, 'rooms', {});
    send(res, 200, { ok: true });
  });

  route('GET', /^\/api\/rooms\/([\w]{12})\/messages$/, ({ res, s, m, url }) => {
    needMember(m[1], s.user);
    send(res, 200, listMessages(m[1], url));
  });
  function listMessages(roomId, url) {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || PAGE));
    const before = Number(url.searchParams.get('before')) || 0, after = Number(url.searchParams.get('after')) || 0, around = Number(url.searchParams.get('around')) || 0;
    let rows;
    if (after) rows = db.all('SELECT * FROM messages WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT ?', roomId, after, limit);
    else if (around) {
      const older = db.all('SELECT * FROM messages WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?', roomId, around, Math.floor(limit / 2)).reverse();
      const newer = db.all('SELECT * FROM messages WHERE room_id = ? AND id >= ? ORDER BY id ASC LIMIT ?', roomId, around, Math.ceil(limit / 2));
      rows = older.concat(newer);
    } else if (before) rows = db.all('SELECT * FROM messages WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?', roomId, before, limit).reverse();
    else rows = db.all('SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?', roomId, limit).reverse();
    const first = rows.length ? rows[0].id : 0, last = rows.length ? rows[rows.length - 1].id : 0;
    const hasOlder = !!(first && db.get('SELECT 1 FROM messages WHERE room_id = ? AND id < ? LIMIT 1', roomId, first));
    const hasNewer = !!(last && db.get('SELECT 1 FROM messages WHERE room_id = ? AND id > ? LIMIT 1', roomId, last));
    return { messages: rows.map(messageView), has_older: hasOlder, has_newer: hasNewer };
  }
  ctxApi.listMessages = listMessages;

  route('POST', /^\/api\/rooms\/([\w]{12})\/messages$/, async ({ req, res, s, m }) => {
    needMember(m[1], s.user);
    const b = await readJSON(req);
    humanRate(s.user.id);
    const idem = typeof b.idem === 'string' && /^[\w-]{8,64}$/.test(b.idem) ? b.idem : null;
    const kind = b.kind === 'summary' ? 'summary' : 'message';
    const r = postMessage({ roomId: m[1], authorKind: 'human', authorId: s.user.id, text: b.text, kind, mentions: b.mentions, idem, attachments: b.attachments });
    send(res, r.duplicate ? 200 : 201, r.message);
  });
  const rate = new Map();
  function humanRate(uid) {
    const now = Date.now(), list = (rate.get(uid) || []).filter(t => now - t < 10000);
    if (list.length >= 15) throw new HttpError(429, 'err.tooFast');
    list.push(now); rate.set(uid, list);
  }
  route('POST', /^\/api\/rooms\/([\w]{12})\/read$/, async ({ req, res, s, m }) => {
    needMember(m[1], s.user);
    const b = await readJSON(req);
    const id = Math.max(0, Number(b.last_id) || 0);
    db.run('UPDATE members SET last_read_id = max(last_read_id, ?) WHERE room_id = ? AND user_id = ?', id, m[1], s.user.id);
    send(res, 200, { ok: true });
  });

  // members & invites
  route('POST', /^\/api\/rooms\/([\w]{12})\/invites$/, async ({ req, res, s, m }) => {
    const me = needMember(m[1], s.user);
    if (me.role !== 'owner') throw new HttpError(403, 'inv.ownerOnly');
    const b = await readJSON(req);
    const login = String(b.github_login || '').trim().replace(/^@/, '');
    if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login)) throw new HttpError(400, 'inv.badLogin');
    const gh = await auth.resolveGithubLogin(login);
    const already = db.get('SELECT 1 FROM members mm JOIN users u ON u.id = mm.user_id WHERE mm.room_id = ? AND u.github_id = ?', m[1], gh.github_id);
    if (already) throw new HttpError(409, 'inv.already', { vars: { login: gh.login } });
    const tok = token(24), now = Date.now();
    db.run('INSERT INTO invites (token_hash, room_id, github_id, github_login, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
      sha256(tok), m[1], gh.github_id, gh.login, s.user.id, now, now + INVITE_DAYS * 864e5);
    send(res, 201, { url: `${config.baseUrl}/i/${tok}`, login: gh.login, expires_at: now + INVITE_DAYS * 864e5 });
  });
  route('GET', /^\/api\/rooms\/([\w]{12})\/invites$/, ({ res, s, m }) => {
    const me = needMember(m[1], s.user);
    if (me.role !== 'owner') return send(res, 200, { invites: [] });
    send(res, 200, { invites: db.all('SELECT id, github_login, created_at, expires_at FROM invites WHERE room_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY id DESC', m[1], Date.now()) });
  });
  route('DELETE', /^\/api\/rooms\/([\w]{12})\/invites\/(\d+)$/, ({ res, s, m }) => {
    const me = needMember(m[1], s.user);
    if (me.role !== 'owner') throw new HttpError(403, 'inv.revokeOwner');
    db.run('UPDATE invites SET revoked_at = ? WHERE id = ? AND room_id = ? AND used_at IS NULL', Date.now(), Number(m[2]), m[1]);
    send(res, 200, { ok: true });
  });
  route('DELETE', /^\/api\/rooms\/([\w]{12})\/members\/(\d+)$/, ({ res, s, m }) => {
    const me = needMember(m[1], s.user);
    const uid = Number(m[2]);
    if (uid !== s.user.id && me.role !== 'owner') throw new HttpError(403, 'mem.kickOwner');
    const target = membership(m[1], uid);
    if (!target) throw new HttpError(404, 'mem.none');
    if (target.role === 'owner') throw new HttpError(400, 'mem.ownerStays');
    const u = db.get('SELECT * FROM users WHERE id = ?', uid);
    const ids = memberIds(m[1]);
    for (const h of hooks.onMemberRemove || []) h(m[1], uid);
    db.run('DELETE FROM members WHERE room_id = ? AND user_id = ?', m[1], uid);
    event(m[1], 'ev.left', { name: u.name });
    push(ids, 'rooms', {});
    send(res, 200, { ok: true });
  });

  route('GET', /^\/api\/search$/, ({ res, s, url }) => {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    if (q.length < 2) return send(res, 200, { hits: [] });
    const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
    const rows = db.all(`SELECT x.*, r.title FROM messages x JOIN members m ON m.room_id = x.room_id AND m.user_id = ? JOIN rooms r ON r.id = x.room_id
                         WHERE x.kind != 'event' AND x.text_lc LIKE ? ESCAPE '\\' ORDER BY x.id DESC LIMIT 40`, s.user.id, like);
    send(res, 200, { hits: rows.map(x => ({ room: x.room_id, room_title: x.title, id: x.id, at: x.created_at, author: author(x.author_kind, x.author_id).name, snippet: snippet(x.text, q) })) });
  });
  function snippet(text, q) {
    const i = text.toLowerCase().indexOf(q);
    const from = Math.max(0, i - 50);
    return (from ? '…' : '') + text.slice(from, from + 160).replace(/\s+/g, ' ') + (from + 160 < text.length ? '…' : '');
  }

  route('GET', /^\/api\/stream$/, ({ req, res, s }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    let set = streams.get(s.user.id); if (!set) streams.set(s.user.id, set = new Set());
    set.add(res);
    req.on('close', () => { set.delete(res); if (!set.size) streams.delete(s.user.id); });
  });

  // ---------------------------------------------------------------- invite links
  route('GET', /^\/i\/([\w-]{20,64})$/, ({ req, res, s, m }) => {
    if (!s) { res.writeHead(302, { Location: `/?next=${encodeURIComponent('/i/' + m[1])}`, 'Cache-Control': 'no-store' }); return res.end(); }
    const inv = db.get('SELECT * FROM invites WHERE token_hash = ?', sha256(m[1]));
    if (!inv) return page(res, 404, 'inv.notFoundTitle', 'inv.notFoundText');
    if (inv.revoked_at) return page(res, 410, 'inv.revokedTitle', 'inv.revokedText');
    if (inv.used_at) {
      if (inv.used_by === s.user.id) { res.writeHead(302, { Location: `/r/${inv.room_id}` }); return res.end(); }
      return page(res, 410, 'inv.usedTitle', 'inv.usedText');
    }
    if (inv.expires_at < Date.now()) return page(res, 410, 'inv.expiredTitle', 'inv.expiredText');
    if (inv.github_id !== s.user.github_id)
      return page(res, 403, 'inv.wrongTitle', 'inv.wrongText', { to: inv.github_login, me: s.user.login });
    const ok = db.tx(() => {
      const r = db.run('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL', Date.now(), s.user.id, inv.id);
      if (!r.changes) return false;
      db.run('INSERT OR IGNORE INTO members (room_id, user_id, role, added_at, last_read_id) VALUES (?,?,?,?,0)', inv.room_id, s.user.id, 'member', Date.now());
      return true;
    });
    if (!ok) return page(res, 410, 'inv.usedTitle', 'inv.usedShort');
    event(inv.room_id, 'ev.joined', { name: s.user.name });
    push(memberIds(inv.room_id), 'rooms', {});
    res.writeHead(302, { Location: `/r/${inv.room_id}` }); res.end();
  });

  // ---------------------------------------------------------------- dispatch
  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    try {
      if (p === '/healthz') return send(res, 200, 'ok');
      if (p === '/config.json') return send(res, 200, { devLogin: !!config.devLogin, github: !!config.github.clientId, baseUrl: config.baseUrl, lang: langOf(req), sourceUrl: config.sourceUrl || 'https://github.com/Stepanokdev/slopovyna' });
      res.slopLang = langOf(req);
      const s = auth.session(req);
      for (const [method, re, fn] of routes) {
        if (method !== req.method) continue;
        const m = p.match(re); if (!m) continue;
        const isApi = p.startsWith('/api/') && !p.startsWith('/api/agent/') && p !== '/api/pair' && !p.startsWith('/api/pair/');
        if (isApi && !s) throw new HttpError(401, 'err.signIn');
        if (isApi && req.method !== 'GET') auth.checkCsrf(req, s);
        return await fn({ req, res, url, s, m });
      }
      if (req.method === 'GET' && !p.startsWith('/api/')) {
        if (p === '/' || p === '/new' || /^\/r\/[\w]{12}$/.test(p)) return serveStatic(res, 'index.html', { html: true });
        if (/^\/[\w.-]+(\/[\w.-]+)*$/.test(p) && !p.includes('..')) return serveStatic(res, p.slice(1));
        return page(res, 404, 'page.404Title', 'page.404Text');
      }
      return send(res, 404, { error: t(res.slopLang, 'err.notFound') });
    } catch (e) {
      if (e instanceof HttpError) {
        const { vars, ...rest } = e.extra || {};
        if (!res.headersSent) send(res, e.status, { error: t(req.slopLang || res.slopLang || 'en', e.message, vars), ...rest });
        return;
      }
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: t(langOf(req), 'err.server') });
    }
  }

  ctxApi.agents = require('./agents').install(ctxApi);
  require('./cli-dist').install(ctxApi);
  require('./files').install(ctxApi);

  const server = http.createServer(handle);
  server.requestTimeout = 0;
  server.headersTimeout = 65000;
  server.keepAliveTimeout = 65000;
  return { server, db, ctx: ctxApi, close: () => { clearInterval(heartbeat); for (const set of streams.values()) for (const r of set) r.end(); server.close(); db.raw.close(); } };
}

module.exports = { createApp };
