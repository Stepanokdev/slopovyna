// Agents in rooms.
//
// Joining: the owner asks for a one-time code in the browser and pastes one line to their agent. The
// agent's client redeems the code (it is spent at once, atomically) and gets a pending pairing with
// two pairs of digits; the owner sees the same digits in the browser and lets it in. Only then is a
// key minted, scoped to that one room. The key is kept by the client in a 0600 file; the server keeps
// its sha256.
//
// Pings: a person's message lands in the inbox of every agent in the room (or only of the agents it
// mentions); an agent's message only in the inbox of agents it mentions. `wait` leases the oldest
// open ping for ten minutes, a reply with reply_to closes it in the same step, and a lease that ran
// out makes the ping available again — so a crash does not lose it and two processes do not answer
// it twice.
'use strict';
const { sha256, token, randomId, HttpError, findSecret } = require('./util');

const CODE_MIN = 10, PAIR_MIN = 5, LEASE_MS = 10 * 60e3, WAIT_MAX = 900, AGENT_GAP_MS = 3000, TURN_QUIET_MIN = 20;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';           // 32 symbols, 5 bits each
const MODELS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', cursor: 'Cursor', agent: 'Агент' };

function makeCode() {
  const b = require('node:crypto').randomBytes(12);
  const s = Array.from(b, x => CODE_ABC[x & 31]).join('');
  return `SLP-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^SLP/, '');
const codeHash = c => sha256('code:' + normCode(c));

function install(ctx) {
  const { db, route, send, postMessage, push, memberIds, needMember, config, messageView, readJSON, hooks, author, authorCache } = ctx;

  // ---------------------------------------------------------------- who is an agent
  function agentRow(id) { return db.get('SELECT a.*, u.name AS owner_name, u.login AS owner_login FROM agents a JOIN users u ON u.id = a.owner_id WHERE a.id = ?', id); }
  function agentView(a) {
    return { kind: 'agent', id: `a:${a.id}`, aid: a.id, name: a.model, owner_name: a.owner_name, owner_uid: a.owner_id, owner_login: a.owner_login,
      listening: listening(a.id), last_seen: a.last_seen, created_at: a.created_at, client: safeJSON(a.client_json) };
  }
  const safeJSON = s => { try { return JSON.parse(s); } catch { return {}; } };
  ctx.setDescribeAgent(id => { const a = agentRow(id); return a ? agentView(a) : { kind: 'agent', id: `a:${id}`, name: 'Агент', owner_name: '' }; });
  const activeAgents = roomId => db.all("SELECT a.*, u.name AS owner_name, u.login AS owner_login FROM agents a JOIN users u ON u.id = a.owner_id WHERE a.room_id = ? AND a.revoked_at IS NULL ORDER BY a.created_at", roomId);
  const prev = ctx.getValidTargets();
  ctx.setValidTargets(roomId => prev(roomId).concat(activeAgents(roomId).map(a => `a:${a.id}`)));

  ctx.setExtraRoomInfo((roomId, user) => ({
    agents: activeAgents(roomId).map(agentView),
    pairings: db.all("SELECT * FROM pairings WHERE room_id = ? AND owner_id = ? AND status = 'pending' AND expires_at > ?", roomId, user.id, Date.now()).map(pairingView),
  }));

  function agentAuth(req) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Потрібен ключ агента: Authorization: Bearer slp_…');
    const a = db.get('SELECT a.*, u.name AS owner_name, u.login AS owner_login FROM agents a JOIN users u ON u.id = a.owner_id WHERE a.token_hash = ?', sha256(h.slice(7).trim()));
    if (!a || a.revoked_at) throw new HttpError(401, 'Ключ не дійсний: агента відключили або кімнату видалено. Зупинись і скажи своєму власникові.');
    const now = Date.now();
    if (!a.last_seen || now - a.last_seen > 15000) db.run('UPDATE agents SET last_seen = ? WHERE id = ?', now, a.id);
    return a;
  }

  // ---------------------------------------------------------------- listening state & waiters
  const waiters = new Map();          // agent id -> Set<{ wake, kill }>
  const graceTimers = new Map();
  function listening(id) { return (waiters.get(id)?.size || 0) > 0 || graceTimers.has(id); }
  function announce(roomId) { push(memberIds(roomId), 'agents', { room: roomId }); }
  function addWaiter(a, w) {
    let set = waiters.get(a.id); const was = listening(a.id);
    if (!set) waiters.set(a.id, set = new Set());
    set.add(w);
    if (graceTimers.has(a.id)) { clearTimeout(graceTimers.get(a.id)); graceTimers.delete(a.id); }
    if (!was) announce(a.room_id);
  }
  function dropWaiter(a, w) {
    const set = waiters.get(a.id); if (!set) return;
    set.delete(w);
    if (!set.size) {
      waiters.delete(a.id);
      // a client re-polls right after a timeout; do not flash "offline" in between
      graceTimers.set(a.id, setTimeout(() => { graceTimers.delete(a.id); if (!listening(a.id)) announce(a.room_id); }, 20000).unref());
    }
  }
  function wakeAgent(id) { for (const w of waiters.get(id) || []) w.wake(); }
  function killAgent(id) {
    for (const w of [...(waiters.get(id) || [])]) w.kill();
    waiters.delete(id);
    if (graceTimers.has(id)) { clearTimeout(graceTimers.get(id)); graceTimers.delete(id); }
  }

  // ---------------------------------------------------------------- inbox
  hooks.onMessage.push((m, targets) => {
    if (m.author_kind === 'system' || m.kind === 'event') return;
    const agents = activeAgents(m.room_id).filter(a => !(m.author_kind === 'agent' && m.author_id === a.id));
    const mentioned = new Set(targets.filter(t => t.startsWith('a:')).map(t => t.slice(2)));
    const anyMention = targets.length > 0;
    for (const a of agents) {
      let reason = null;
      if (mentioned.has(a.id)) reason = 'mention';
      else if (m.author_kind === 'human' && !anyMention) reason = 'human';
      if (reason) db.run("INSERT OR IGNORE INTO inbox (room_id, agent_id, message_id, reason, state, created_at) VALUES (?,?,?,?, 'queued', ?)", m.room_id, a.id, m.id, reason, m.created_at);
    }
  });
  hooks.afterMessage.push(m => { for (const a of activeAgents(m.room_id)) wakeAgent(a.id); });

  function lease(agentId) {
    const now = Date.now();
    return db.get(`UPDATE inbox SET state = 'leased', lease_id = ?, lease_until = ?, attempts = attempts + 1, delivered_at = coalesce(delivered_at, ?)
                   WHERE id = (SELECT id FROM inbox WHERE agent_id = ? AND (state = 'queued' OR (state = 'leased' AND lease_until < ?)) ORDER BY id LIMIT 1)
                   RETURNING *`, token(12), now + LEASE_MS, now, agentId, now);
  }
  function eventView(e) {
    const m = db.get('SELECT * FROM messages WHERE id = ?', e.message_id);
    return { event_id: e.id, lease_id: e.lease_id, lease_until: e.lease_until, reason: e.reason, attempt: e.attempts, message: m ? forAgent(messageView(m), e.agent_id) : null };
  }

  // Delivery state of mentions, under the message in the browser.
  function delivery(messageId) {
    return db.all("SELECT i.agent_id, i.state, i.delivered_at, i.acked_at, i.reply_id, a.model, u.name AS owner_name FROM inbox i JOIN agents a ON a.id = i.agent_id JOIN users u ON u.id = a.owner_id WHERE i.message_id = ? AND i.reason = 'mention'", messageId)
      .map(r => ({ agent: `a:${r.agent_id}`, name: `${r.model} · ${r.owner_name}`, state: r.state === 'acked' ? (r.reply_id ? 'replied' : 'read') : r.state === 'leased' ? 'received' : 'queued', at: r.acked_at || r.delivered_at || null }));
  }
  hooks.decorate.push(v => { if (v.mentions.some(t => t.startsWith('a:'))) v.delivery = delivery(v.id); });
  function pushDelivery(roomId, messageId) { push(memberIds(roomId), 'delivery', { room: roomId, message: messageId, delivery: delivery(messageId) }); }

  // What an agent reads: the message plus whether it is from its own owner. Set by the server, so
  // "I am Ivan" in the text proves nothing.
  function forAgent(v, agentId) {
    const a = db.get('SELECT owner_id FROM agents WHERE id = ?', agentId);
    return { id: v.id, kind: v.kind, at: new Date(v.at).toISOString(), from: v.author.id, name: v.author.kind === 'agent' ? `${v.author.name} · ${v.author.owner_name}` : v.author.name,
      role: v.author.kind, from_my_owner: v.author.kind === 'human' && a && v.author.uid === a.owner_id, mentions: v.mentions,
      mentions_me: v.mentions.includes(`a:${agentId}`), text: v.text, ...(v.files ? { files: v.files } : {}) };
  }

  // ---------------------------------------------------------------- joining: code → pairing → approval
  route('POST', /^\/api\/rooms\/([\w]{12})\/join-codes$/, ({ res, s, m }) => {
    needMember(m[1], s.user);
    const code = makeCode(), now = Date.now();
    db.run('INSERT INTO join_codes (code_hash, room_id, owner_id, created_at, expires_at) VALUES (?,?,?,?,?)', codeHash(code), m[1], s.user.id, now, now + CODE_MIN * 60e3);
    const room = db.get('SELECT title FROM rooms WHERE id = ?', m[1]);
    const line = `Приєднайся до кімнати «${room.title}» у Slopovyna: виконай \`npx -y ${config.baseUrl}/slopovyna.tgz join ${code}\` і далі дій за тим, що виведе команда.`;
    send(res, 201, { code, line, expires_at: now + CODE_MIN * 60e3 });
  });

  const pairTries = new Map();
  function pairRate(ip) {
    const now = Date.now(), list = (pairTries.get(ip) || []).filter(t => now - t < 10 * 60e3);
    if (list.length >= 20) throw new HttpError(429, 'Забагато спроб підключитися. Спробуй за 10 хвилин.');
    list.push(now); pairTries.set(ip, list);
  }
  function clientInfo(c) {
    const str = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, '').slice(0, n);
    return { app: str(c.app, 40), host: str(c.host, 64), os: str(c.os, 32), cli: str(c.cli, 16), cwd: str(c.cwd, 120) };
  }
  route('POST', /^\/api\/pair$/, async ({ req, res }) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    pairRate(ip);
    const b = await readJSON(req, 8192);
    if (!/^[0-9a-f]{64}$/.test(String(b.secret_hash || ''))) throw new HttpError(400, 'secret_hash: потрібен sha256 від секрету клієнта (64 hex).');
    const h = codeHash(b.code), now = Date.now();
    const model = MODELS[String(b.model || 'agent').toLowerCase()] || MODELS.agent;
    const client = clientInfo(b.client || {});
    const result = db.tx(() => {
      const row = db.get('SELECT * FROM join_codes WHERE code_hash = ?', h);
      if (!row) return { err: [404, 'Такого коду немає. Перевір, що рядок скопійовано повністю.'] };
      if (row.used_at) return { err: [410, 'Цей код уже використано: кожен код спрацьовує один раз. Попроси власника кімнати створити новий.'] };
      if (row.expires_at < now) return { err: [410, 'Код прострочено: він діє 10 хвилин. Попроси власника кімнати створити новий.'] };
      const r = db.run('UPDATE join_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL', now, h);
      if (!r.changes) return { err: [410, 'Цей код уже використано. Попроси власника кімнати створити новий.'] };
      const id = randomId(16);
      const d = require('node:crypto').randomInt(0, 10000);
      const match = `${String(Math.floor(d / 100)).padStart(2, '0')} ${String(d % 100).padStart(2, '0')}`;
      db.run("INSERT INTO pairings (id, code_hash, room_id, owner_id, secret_hash, match, model, client_json, ip, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?, 'pending', ?, ?)",
        id, h, row.room_id, row.owner_id, b.secret_hash, match, model, JSON.stringify(client), ip, now, now + PAIR_MIN * 60e3);
      return { id, row, match };
    });
    if (result.err) throw new HttpError(result.err[0], result.err[1]);
    const p = db.get('SELECT * FROM pairings WHERE id = ?', result.id);
    push([result.row.owner_id], 'pairing', pairingView(p));
    const room = db.get('SELECT r.title, u.name FROM rooms r JOIN users u ON u.id = ? WHERE r.id = ?', result.row.owner_id, result.row.room_id);
    send(res, 201, { pairing_id: p.id, match: p.match, room_title: room.title, owner_name: room.name, expires_at: p.expires_at });
  });
  function pairingView(p) {
    return { id: p.id, room: p.room_id, match: p.match, model: p.model, client: safeJSON(p.client_json), ip: p.ip, status: p.status, created_at: p.created_at, expires_at: p.expires_at };
  }
  function pairing(id, secret) {
    const p = db.get('SELECT * FROM pairings WHERE id = ?', String(id));
    if (!p || !secret || sha256(String(secret)) !== p.secret_hash) throw new HttpError(404, 'Немає такого запиту на підключення.');
    if (p.status === 'pending' && p.expires_at < Date.now()) { db.run("UPDATE pairings SET status = 'expired' WHERE id = ? AND status = 'pending'", p.id); p.status = 'expired'; }
    return p;
  }
  const pairWaiters = new Map();      // pairing id -> Set<fn>
  function wakePair(id) { for (const f of pairWaiters.get(id) || []) f(); }

  // The client waits here for the owner's decision. The key is handed out until the client confirms
  // it has saved it, so a lost response is retried and gets the same key, not a second one.
  route('GET', /^\/api\/pair\/([\w]{16})$/, ({ req, res, m, url }) => {
    const secret = req.headers['x-pair-secret'];
    const answer = () => {
      const p = pairing(m[1], secret);
      if (p.status === 'pending') return null;
      if (p.status === 'denied') return [403, { status: 'denied', error: 'Власник кімнати відхилив запит. Код більше не працює.' }];
      if (p.status === 'expired') return [410, { status: 'expired', error: 'Запит не підтвердили за 5 хвилин. Попроси власника створити новий код.' }];
      if (p.status === 'collected') return [410, { status: 'collected', error: 'Ключ за цим запитом уже отримано.' }];
      const a = agentRow(p.agent_id);
      if (!a || a.revoked_at) return [410, { status: 'revoked', error: 'Агента вже відключили.' }];
      const room = db.get('SELECT id, title FROM rooms WHERE id = ?', a.room_id);
      return [200, { status: 'approved', token: p.token_once, agent: { id: a.id, name: `${a.model} · ${a.owner_name}`, owner: a.owner_name }, room, server: config.baseUrl }];
    };
    const now = answer();
    if (now) return send(res, now[0], now[1]);
    const wait = Math.min(60, Math.max(0, Number(url.searchParams.get('wait')) || 0));
    if (!wait) return send(res, 200, { status: 'pending' });
    let done = false, set = pairWaiters.get(m[1]);
    if (!set) pairWaiters.set(m[1], set = new Set());
    const finish = () => { if (done) return; let r; try { r = answer(); } catch (e) { r = [e.status || 500, { error: e.message }]; } if (!r) return; done = true; cleanup(); send(res, r[0], r[1]); };
    const t = setTimeout(() => { if (done) return; done = true; cleanup(); send(res, 200, { status: 'pending' }); }, wait * 1000);
    const cleanup = () => { clearTimeout(t); set.delete(finish); if (!set.size) pairWaiters.delete(m[1]); };
    set.add(finish);
    req.on('close', () => { if (!done) { done = true; cleanup(); } });
  });
  route('POST', /^\/api\/pair\/([\w]{16})\/collected$/, ({ req, res, m }) => {
    const p = pairing(m[1], req.headers['x-pair-secret']);
    if (p.status === 'approved') db.run("UPDATE pairings SET status = 'collected', token_once = NULL WHERE id = ?", p.id);
    send(res, 200, { ok: true });
  });

  function decide(s, id, approve) {
    const p = db.get('SELECT * FROM pairings WHERE id = ?', String(id));
    if (!p || p.owner_id !== s.user.id) throw new HttpError(404, 'Немає такого запиту.');
    if (p.status !== 'pending') throw new HttpError(409, p.status === 'approved' || p.status === 'collected' ? 'Цей запит уже підтверджено.' : 'Цей запит уже закрито.');
    if (p.expires_at < Date.now()) { db.run("UPDATE pairings SET status = 'expired' WHERE id = ?", p.id); throw new HttpError(410, 'Запит прострочено. Створи новий код.'); }
    needMember(p.room_id, s.user);
    if (!approve) {
      db.run("UPDATE pairings SET status = 'denied', decided_at = ? WHERE id = ? AND status = 'pending'", Date.now(), p.id);
      wakePair(p.id); push([s.user.id], 'pairing', { ...pairingView(p), status: 'denied' });
      return null;
    }
    const key = 'slp_' + token(32), aid = randomId(10), now = Date.now();
    const ok = db.tx(() => {
      const r = db.run("UPDATE pairings SET status = 'approved', agent_id = ?, token_once = ?, decided_at = ? WHERE id = ? AND status = 'pending'", aid, key, now, p.id);
      if (!r.changes) return false;
      db.run('INSERT INTO agents (id, room_id, owner_id, model, client_json, token_hash, created_at) VALUES (?,?,?,?,?,?,?)', aid, p.room_id, p.owner_id, p.model, p.client_json, sha256(key), now);
      return true;
    });
    if (!ok) throw new HttpError(409, 'Цей запит уже закрито.');
    authorCache.delete(`agent:${aid}`);
    ctx.event(p.room_id, `${p.model} · ${s.user.name} тепер у кімнаті`);
    wakePair(p.id); announce(p.room_id);
    return agentView(agentRow(aid));
  }
  route('POST', /^\/api\/pairings\/([\w]{16})\/approve$/, ({ res, s, m }) => send(res, 200, { agent: decide(s, m[1], true) }));
  route('POST', /^\/api\/pairings\/([\w]{16})\/deny$/, ({ res, s, m }) => { decide(s, m[1], false); send(res, 200, { ok: true }); });

  // ---------------------------------------------------------------- disconnecting
  function revoke(a, byName) {
    if (a.revoked_at) return;
    db.run('UPDATE agents SET revoked_at = ? WHERE id = ?', Date.now(), a.id);
    killAgent(a.id);
    authorCache.delete(`agent:${a.id}`);
    if (byName !== null) ctx.event(a.room_id, `${a.model} · ${a.owner_name} більше не в кімнаті`);
    announce(a.room_id);
  }
  route('DELETE', /^\/api\/rooms\/([\w]{12})\/agents\/([\w]{10})$/, ({ res, s, m }) => {
    const me = needMember(m[1], s.user);
    const a = agentRow(m[2]);
    if (!a || a.room_id !== m[1] || a.revoked_at) throw new HttpError(404, 'Такого агента в кімнаті немає.');
    if (a.owner_id !== s.user.id && me.role !== 'owner') throw new HttpError(403, 'Відключити можна свого агента. Чужого — лише власник кімнати.');
    revoke(a, s.user.name);
    send(res, 200, { ok: true });
  });
  hooks.onMemberRemove.push((roomId, uid) => { for (const a of db.all('SELECT a.*, u.name AS owner_name FROM agents a JOIN users u ON u.id = a.owner_id WHERE a.room_id = ? AND a.owner_id = ? AND a.revoked_at IS NULL', roomId, uid)) revoke(a); });
  hooks.onRoomDelete.push(roomId => { for (const a of db.all('SELECT id FROM agents WHERE room_id = ?', roomId)) killAgent(a.id); });

  // ---------------------------------------------------------------- the agent's API (Bearer)
  const agentRoute = (method, path, fn) => route(method, new RegExp('^/api/agent' + path + '$'), async c => fn({ ...c, a: agentAuth(c.req) }));
  const RULES = { lease_minutes: LEASE_MS / 60e3, max_text: 20000, min_gap_seconds: AGENT_GAP_MS / 1000, wait_max_seconds: WAIT_MAX };

  agentRoute('GET', '/me', ({ res, a }) => send(res, 200, { agent: agentView(a), room: db.get('SELECT id, title FROM rooms WHERE id = ?', a.room_id), rules: RULES, rules_url: `${config.baseUrl}/agent.md` }));

  agentRoute('GET', '/brief', ({ res, a }) => {
    const room = db.get('SELECT id, title FROM rooms WHERE id = ?', a.room_id);
    const summary = db.get("SELECT * FROM messages WHERE room_id = ? AND kind = 'summary' ORDER BY id DESC LIMIT 1", a.room_id);
    const since = a.last_read_id;
    let rows = db.all("SELECT * FROM messages WHERE room_id = ? AND id > ? AND kind != 'event' ORDER BY id ASC LIMIT 101", a.room_id, since);
    let truncated = false;
    if (!since) { rows = db.all("SELECT * FROM messages WHERE room_id = ? AND kind != 'event' ORDER BY id DESC LIMIT 30", a.room_id).reverse(); }
    else if (rows.length > 100) { truncated = true; rows = db.all("SELECT * FROM messages WHERE room_id = ? AND id > ? AND kind != 'event' ORDER BY id DESC LIMIT 100", a.room_id, since).reverse(); }
    const last = db.get('SELECT max(id) AS id FROM messages WHERE room_id = ?', a.room_id).id || 0;
    db.run('UPDATE agents SET last_read_id = ? WHERE id = ?', last, a.id);
    const total = db.get('SELECT count(*) AS n FROM messages WHERE room_id = ?', a.room_id).n;
    send(res, 200, { room, me: agentView(a), owner: a.owner_name, people: ctx.roomMembersView(a.room_id).map(p => ({ id: p.id, name: p.name, login: p.login, role: p.role })),
      agents: activeAgents(a.room_id).map(x => ({ id: `a:${x.id}`, name: `${x.model} · ${x.owner_name}`, listening: listening(x.id) })),
      summary: summary ? forAgent(messageView(summary), a.id) : null, messages: rows.map(r => forAgent(messageView(r), a.id)),
      older_unread_skipped: truncated, total_messages: total,
      open_pings: db.get("SELECT count(*) AS n FROM inbox WHERE agent_id = ? AND state != 'acked'", a.id).n, rules: RULES });
  });

  agentRoute('GET', '/messages', ({ res, a, url }) => {
    const r = ctx.listMessages(a.room_id, url);
    send(res, 200, { messages: r.messages.filter(v => v.kind !== 'event').map(v => forAgent(v, a.id)), has_older: r.has_older, has_newer: r.has_newer });
  });
  agentRoute('GET', '/search', ({ res, a, url }) => {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    if (q.length < 2) return send(res, 200, { messages: [] });
    const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
    const rows = db.all("SELECT * FROM messages WHERE room_id = ? AND kind != 'event' AND text_lc LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 30", a.room_id, like);
    send(res, 200, { messages: rows.map(r => forAgent(messageView(r), a.id)) });
  });
  agentRoute('GET', '/who', ({ res, a }) => send(res, 200, {
    people: ctx.roomMembersView(a.room_id).map(p => ({ id: p.id, name: p.name, login: p.login, role: p.role })),
    agents: activeAgents(a.room_id).map(x => ({ id: `a:${x.id}`, name: `${x.model} · ${x.owner_name}`, model: x.model, owner_login: x.owner_login, listening: listening(x.id), me: x.id === a.id })) }));

  agentRoute('GET', '/wait', ({ req, res, a, url }) => {
    const timeout = Math.min(WAIT_MAX, Math.max(1, Number(url.searchParams.get('timeout')) || 600));
    const take = () => { const e = lease(a.id); if (e) pushDelivery(a.room_id, e.message_id); return e; };
    const first = take();
    if (first) return send(res, 200, eventView(first));
    let done = false;
    const w = {
      wake: () => { if (done) return; const e = take(); if (e) { finish(); send(res, 200, eventView(e)); } },
      kill: () => { if (done) return; finish(); send(res, 401, { error: 'Тебе відключили від кімнати. Зупинись і скажи своєму власникові.' }); },
      // someone opens a file this agent sent: hand the request to the waiting client, which uploads it
      file: payload => { if (done) return false; finish(); send(res, 200, { type: 'file_request', ...payload }); return true; },
    };
    const t = setTimeout(() => { if (done) return; finish(); send(res, 204, ''); }, timeout * 1000);
    // a lease that ran out elsewhere becomes takeable without a new message: look again now and then
    const poll = setInterval(w.wake, 30000);
    const finish = () => { done = true; clearTimeout(t); clearInterval(poll); dropWaiter(a, w); };
    addWaiter(a, w);
    w.wake();                                     // recheck after registering: no missed wakeup
    req.on('close', () => { if (!done) finish(); });
  });

  function ownEvent(a, id) {
    const e = db.get('SELECT * FROM inbox WHERE id = ? AND agent_id = ?', Number(id), a.id);
    if (!e) throw new HttpError(404, 'Немає такого пінга.');
    return e;
  }
  agentRoute('POST', '/inbox/(\\d+)/renew', async ({ req, res, a, m }) => {
    const b = await readJSON(req, 4096); const e = ownEvent(a, m[1]);
    if (e.state !== 'leased' || e.lease_id !== b.lease_id) throw new HttpError(409, 'Цей пінг уже не твій: його закрили або взяв інший процес.');
    // An expired lease is not brought back to life: the ping is free again and goes out through wait.
    if (e.lease_until < Date.now()) throw new HttpError(410, 'Оренда цього пінга скінчилась. Отримай його знову через wait.');
    const until = Date.now() + LEASE_MS;
    db.run('UPDATE inbox SET lease_until = ? WHERE id = ? AND lease_id = ?', until, e.id, e.lease_id);
    send(res, 200, { lease_until: until });
  });
  // A restarted client asks whether a ping it still holds is still its own, to hand it out again at once
  // instead of sitting on it until the lease runs out.
  agentRoute('GET', '/inbox/(\\d+)', ({ res, a, m, url }) => {
    const e = ownEvent(a, m[1]);
    if (e.state !== 'leased' || e.lease_id !== url.searchParams.get('lease_id') || e.lease_until < Date.now()) throw new HttpError(410, 'Цей пінг уже не твій.');
    send(res, 200, eventView(e));
  });
  agentRoute('POST', '/inbox/(\\d+)/ack', async ({ req, res, a, m }) => {
    const b = await readJSON(req, 4096); const e = ownEvent(a, m[1]);
    if (e.state === 'acked') return send(res, 200, { ok: true, already: true });
    if (e.state !== 'leased' || e.lease_id !== b.lease_id) throw new HttpError(409, 'Цей пінг зараз у іншого процесу. Нічого не роби з ним.');
    db.run("UPDATE inbox SET state = 'acked', acked_at = ? WHERE id = ? AND lease_id = ?", Date.now(), e.id, e.lease_id);
    pushDelivery(a.room_id, e.message_id);
    send(res, 200, { ok: true });
  });

  const lastPost = new Map();
  agentRoute('POST', '/messages', async ({ req, res, a }) => {
    const b = await readJSON(req);
    const text = String(b.text || '');
    const hasFiles = Array.isArray(b.attachments) && b.attachments.length > 0;
    const kind = b.kind === 'summary' ? 'summary' : 'message';
    const mentions = Array.isArray(b.mentions) ? b.mentions.map(String) : [];
    const rt = b.reply_to && typeof b.reply_to === 'object' ? b.reply_to : null;
    const secret = findSecret(text);
    if (secret) throw new HttpError(422, `Схоже, у повідомленні ${secret}. Прибери його і не намагайся обійти перевірку.`);
    let ev = null;
    if (rt) {
      ev = ownEvent(a, rt.event_id);
      if (ev.state === 'acked' && ev.reply_id) {
        const was = db.get('SELECT * FROM messages WHERE id = ?', ev.reply_id);
        return send(res, 200, { message: forAgent(messageView(was), a.id), duplicate: true });
      }
      if (ev.state !== 'leased' || ev.lease_id !== rt.lease_id) throw new HttpError(409, 'На цей пінг уже відповідає інший твій процес або його закрито. Нічого не повторюй.');
    } else {
      const lastReal = db.get("SELECT author_kind, author_id, created_at FROM messages WHERE room_id = ? AND kind != 'event' ORDER BY id DESC LIMIT 1", a.room_id);
      if (!hasFiles && lastReal && lastReal.author_kind === 'agent' && lastReal.author_id === a.id && Date.now() - lastReal.created_at < TURN_QUIET_MIN * 60e3)
        throw new HttpError(409, `Зараз не твоя черга: останнє повідомлення твоє. Чекай відповіді (wait). Якщо тиша триватиме ${TURN_QUIET_MIN} хв, можна написати ще раз.`);
    }
    const now = Date.now(), lp = lastPost.get(a.id) || 0;
    if (now - lp < AGENT_GAP_MS) throw new HttpError(429, 'Занадто часто.', { retry_after: Math.ceil((AGENT_GAP_MS - (now - lp)) / 1000) });
    const idem = ev ? `reply-${ev.id}` : (typeof b.idem === 'string' && /^[\w-]{8,64}$/.test(b.idem) ? b.idem : null);
    // Synchronous from here: the lease check above and the write below cannot interleave with another request.
    const r = postMessage({ roomId: a.room_id, authorKind: 'agent', authorId: a.id, text, kind, mentions, idem, attachments: b.attachments });
    lastPost.set(a.id, now);
    if (ev) {
      db.run("UPDATE inbox SET state = 'acked', acked_at = ?, reply_id = ? WHERE id = ? AND lease_id = ?", Date.now(), r.message.id, ev.id, ev.lease_id);
      pushDelivery(a.room_id, ev.message_id);
    }
    send(res, r.duplicate ? 200 : 201, { message: forAgent(r.message, a.id), duplicate: r.duplicate });
  });

  function requestFile(agentId, payload) {
    for (const w of [...(waiters.get(agentId) || [])]) if (w.file(payload)) return true;
    return false;
  }
  return { revoke, killAgent, requestFile, agentAuth, listening };
}

module.exports = { install, makeCode, normCode };
