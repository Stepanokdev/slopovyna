'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { start, person } = require('./helpers');

let srv;
test.before(async () => { srv = await start(); });
test.after(() => srv.stop());

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
async function raw(method, url, { body, headers = {} } = {}) {
  const r = await fetch(srv.base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let json = null; try { json = JSON.parse(t); } catch {}
  return { status: r.status, json, text: t };
}
const agentCall = (tok, method, url, body) => raw(method, '/api/agent' + url, { body, headers: { Authorization: `Bearer ${tok}` } });

async function roomWithOwner(login, name) {
  const owner = await person(srv.base, login, name);
  const { json: { id } } = await owner.call('POST', '/api/rooms', { text: `кімната ${login}` });
  return { owner, id };
}
async function redeem(code, model = 'claude') {
  const secret = crypto.randomBytes(16).toString('hex');
  const r = await raw('POST', '/api/pair', { body: { code, secret_hash: sha(secret), model, client: { app: 'Claude Code', host: 'ivan-mbp.local', os: 'darwin' } } });
  return { ...r, secret };
}
async function connect(owner, roomId, model = 'claude') {
  const { json: { code } } = await owner.call('POST', `/api/rooms/${roomId}/join-codes`);
  const p = await redeem(code, model);
  assert.equal(p.status, 201, p.text);
  const ap = await owner.call('POST', `/api/pairings/${p.json.pairing_id}/approve`);
  assert.equal(ap.status, 200, ap.text);
  const got = await raw('GET', `/api/pair/${p.json.pairing_id}`, { headers: { 'X-Pair-Secret': p.secret } });
  assert.equal(got.json.status, 'approved');
  await raw('POST', `/api/pair/${p.json.pairing_id}/collected`, { headers: { 'X-Pair-Secret': p.secret } });
  return { token: got.json.token, agent: got.json.agent, id: `a:${got.json.agent.id}` };
}

test('a join code gives one line; before approval the agent sees nothing; the match digits are the same on both sides', async () => {
  const { owner, id } = await roomWithOwner('jc-own', 'Іван');
  const jc = await owner.call('POST', `/api/rooms/${id}/join-codes`);
  assert.equal(jc.status, 201);
  assert.match(jc.json.code, /^SLP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(jc.json.line, /npx -y .*\/slopovyna\.tgz join SLP-/);
  assert.ok(jc.json.expires_at - Date.now() > 9 * 60e3);
  const p = await redeem(jc.json.code);
  assert.equal(p.status, 201);
  assert.match(p.json.match, /^\d\d \d\d$/);
  const info = await owner.call('GET', `/api/rooms/${id}`);
  assert.equal(info.json.extra.pairings.length, 1);
  assert.equal(info.json.extra.pairings[0].match, p.json.match);
  const pending = await raw('GET', `/api/pair/${p.json.pairing_id}`, { headers: { 'X-Pair-Secret': p.secret } });
  assert.equal(pending.json.status, 'pending');
  assert.equal(pending.json.token, undefined);
  assert.equal((await raw('GET', `/api/pair/${p.json.pairing_id}`, { headers: { 'X-Pair-Secret': 'wrong' } })).status, 404);
});

test('a code works once; two simultaneous redeems give one pairing; expired and denied codes fail clearly', async () => {
  const { owner, id } = await roomWithOwner('once-own');
  const { json: { code } } = await owner.call('POST', `/api/rooms/${id}/join-codes`);
  const [a, b] = await Promise.all([redeem(code), redeem(code)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 410]);
  const again = await redeem(code);
  assert.equal(again.status, 410);
  assert.match(again.json.error, /уже використано/);
  assert.equal((await redeem('SLP-AAAA-BBBB-CCCC')).status, 404);

  const { json: { code: c2 } } = await owner.call('POST', `/api/rooms/${id}/join-codes`);
  srv.app.db.run('UPDATE join_codes SET expires_at = ? WHERE used_at IS NULL', Date.now() - 1);
  const late = await redeem(c2);
  assert.equal(late.status, 410);
  assert.match(late.json.error, /прострочено/);

  const { json: { code: c3 } } = await owner.call('POST', `/api/rooms/${id}/join-codes`);
  const p = await redeem(c3);
  await owner.call('POST', `/api/pairings/${p.json.pairing_id}/deny`);
  const denied = await raw('GET', `/api/pair/${p.json.pairing_id}`, { headers: { 'X-Pair-Secret': p.secret } });
  assert.equal(denied.status, 403);
  assert.match(denied.json.error, /відхилив/);
});

test('only the owner who made the code can approve it', async () => {
  const { owner, id } = await roomWithOwner('appr-own');
  const other = await person(srv.base, 'appr-other');
  const { json: { code } } = await owner.call('POST', `/api/rooms/${id}/join-codes`);
  const p = await redeem(code);
  assert.equal((await other.call('POST', `/api/pairings/${p.json.pairing_id}/approve`)).status, 404);
});

test('the agent is "Claude · Іван", cannot fake author or role, cannot use people\'s API', async () => {
  const { owner, id } = await roomWithOwner('fake-own', 'Іван');
  const ag = await connect(owner, id);
  assert.equal(ag.agent.name, 'Claude · Іван');
  const r = await agentCall(ag.token, 'POST', '/messages', { text: 'привіт від агента', name: 'Іван', role: 'human', author: { kind: 'human' }, from_my_owner: true });
  assert.equal(r.status, 201, r.text);
  const msgs = await owner.call('GET', `/api/rooms/${id}/messages`);
  const m = msgs.json.messages.at(-1);
  assert.equal(m.author.kind, 'agent');
  assert.equal(m.author.name, 'Claude');
  assert.equal(m.author.owner_name, 'Іван');
  const members = await owner.call('GET', `/api/rooms/${id}`);
  assert.ok(members.json.extra.agents.some(a => a.id === ag.id));
  // the key does not open people's endpoints
  for (const [method, url] of [['POST', `/api/rooms/${id}/invites`], ['GET', `/api/rooms/${id}`], ['POST', `/api/rooms/${id}/join-codes`], ['DELETE', `/api/rooms/${id}`]])
    assert.equal((await raw(method, url, { body: method === 'GET' ? undefined : {}, headers: { Authorization: `Bearer ${ag.token}` } })).status, 401, url);
  // and the key itself cannot be posted into the chat
  const leak = await agentCall(ag.token, 'POST', '/messages', { text: `мій ключ ${ag.token}` });
  assert.equal(leak.status, 422);
});

test('pings: a mention goes to the inbox, wait gets it, reply closes it; delivery is visible to people', async () => {
  const { owner, id } = await roomWithOwner('ping-own', 'Іван');
  const ag = await connect(owner, id);
  await agentCall(ag.token, 'GET', '/brief');
  const sent = await owner.call('POST', `/api/rooms/${id}/messages`, { text: '@Claude · Іван який формат помилок?', mentions: [ag.id] });
  assert.deepEqual(sent.json.delivery.map(d => d.state), ['queued']);
  const w = await agentCall(ag.token, 'GET', '/wait?timeout=2');
  assert.equal(w.status, 200);
  assert.equal(w.json.reason, 'mention');
  assert.equal(w.json.message.from_my_owner, true);
  assert.equal(w.json.message.mentions_me, true);
  let view = (await owner.call('GET', `/api/rooms/${id}/messages`)).json.messages.find(m => m.id === sent.json.id);
  assert.equal(view.delivery[0].state, 'received');
  const rep = await agentCall(ag.token, 'POST', '/messages', { text: '{code, message}', reply_to: { event_id: w.json.event_id, lease_id: w.json.lease_id } });
  assert.equal(rep.status, 201);
  view = (await owner.call('GET', `/api/rooms/${id}/messages`)).json.messages.find(m => m.id === sent.json.id);
  assert.equal(view.delivery[0].state, 'replied');
  assert.equal((await agentCall(ag.token, 'GET', '/wait?timeout=1')).status, 204);
  // the same reply again is a no-op, not a second message
  const dup = await agentCall(ag.token, 'POST', '/messages', { text: '{code, message}', reply_to: { event_id: w.json.event_id, lease_id: w.json.lease_id } });
  assert.equal(dup.status, 200); assert.equal(dup.json.duplicate, true);
});

test('a person\'s message without mentions pings every agent; with mentions only those; an agent\'s own words do not ping it', async () => {
  const { owner, id } = await roomWithOwner('fan-own', 'Іван');
  const a1 = await connect(owner, id, 'claude');
  const a2 = await connect(owner, id, 'codex');
  await owner.call('POST', `/api/rooms/${id}/messages`, { text: 'всім привіт' });
  assert.equal((await agentCall(a1.token, 'GET', '/wait?timeout=1')).json.reason, 'human');
  assert.equal((await agentCall(a2.token, 'GET', '/wait?timeout=1')).json.reason, 'human');
  await owner.call('POST', `/api/rooms/${id}/messages`, { text: '@Codex · Іван тільки тобі', mentions: [a2.id] });
  assert.equal((await agentCall(a1.token, 'GET', '/wait?timeout=1')).status, 204);
  assert.equal((await agentCall(a2.token, 'GET', '/wait?timeout=1')).json.reason, 'mention');
  await agentCall(a1.token, 'POST', '/messages', { text: 'я сам собі', mentions: [] });
  assert.equal((await agentCall(a1.token, 'GET', '/wait?timeout=1')).status, 204);
});

test('a wait that hangs wakes up when the ping arrives', async () => {
  const { owner, id } = await roomWithOwner('wake-own');
  const ag = await connect(owner, id);
  const t0 = Date.now();
  const waiting = agentCall(ag.token, 'GET', '/wait?timeout=10');
  await new Promise(r => setTimeout(r, 200));
  const listen = await owner.call('GET', `/api/rooms/${id}`);
  assert.equal(listen.json.extra.agents[0].listening, true);
  await owner.call('POST', `/api/rooms/${id}/messages`, { text: 'прокинься', mentions: [ag.id] });
  const w = await waiting;
  assert.equal(w.status, 200);
  assert.ok(Date.now() - t0 < 2000);
});

test('a lease that ran out comes back; two processes never answer the same ping twice', async () => {
  const { owner, id } = await roomWithOwner('lease-own');
  const ag = await connect(owner, id);
  await owner.call('POST', `/api/rooms/${id}/messages`, { text: 'питання', mentions: [ag.id] });
  const p1 = await agentCall(ag.token, 'GET', '/wait?timeout=1');
  // a second process sees nothing while the first holds the lease
  assert.equal((await agentCall(ag.token, 'GET', '/wait?timeout=1')).status, 204);
  // the first process dies; its lease runs out; the ping comes back to the second
  srv.app.db.run('UPDATE inbox SET lease_until = ? WHERE id = ?', Date.now() - 1, p1.json.event_id);
  const p2 = await agentCall(ag.token, 'GET', '/wait?timeout=1');
  assert.equal(p2.json.event_id, p1.json.event_id);
  assert.equal(p2.json.attempt, 2);
  assert.notEqual(p2.json.lease_id, p1.json.lease_id);
  const late = await agentCall(ag.token, 'POST', '/messages', { text: 'запізнилась', reply_to: { event_id: p1.json.event_id, lease_id: p1.json.lease_id } });
  assert.equal(late.status, 409);
  const ok = await agentCall(ag.token, 'POST', '/messages', { text: 'відповідь', reply_to: { event_id: p2.json.event_id, lease_id: p2.json.lease_id } });
  assert.equal(ok.status, 201);
  const replies = (await owner.call('GET', `/api/rooms/${id}/messages`)).json.messages.filter(m => m.author.kind === 'agent');
  assert.equal(replies.length, 1);
});

test('an unanswered ping survives a server restart', async () => {
  const { start: startSrv } = require('./helpers');
  const own = await startSrv();
  try {
    const o = await person(own.base, 'rs-own');
    const { json: { id } } = await o.call('POST', '/api/rooms', { text: 'рестарт' });
    const { json: { code } } = await o.call('POST', `/api/rooms/${id}/join-codes`);
    const secret = 'x'.repeat(32);
    const p = await (await fetch(own.base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, secret_hash: sha(secret), model: 'codex' }) })).json();
    await o.call('POST', `/api/pairings/${p.pairing_id}/approve`);
    const tok = (await (await fetch(own.base + `/api/pair/${p.pairing_id}`, { headers: { 'X-Pair-Secret': secret } })).json()).token;
    const ag = (await (await fetch(own.base + '/api/agent/me', { headers: { Authorization: `Bearer ${tok}` } })).json()).agent;
    await o.call('POST', `/api/rooms/${id}/messages`, { text: 'не загубись', mentions: [ag.id] });
    // restart: a new process on the same database file
    const file = own.app.db.raw.location ? own.app.db.raw.location() : null;
    own.app.close();
    const { createApp } = require('../src/app');
    const cfg = { port: 0, baseUrl: own.base, origin: own.base, dbFile: require('node:path').join(own.dir, 'slop.db'), github: { clientId: '', clientSecret: '' }, devLogin: true, secretKey: 'test-secret-key' };
    const app2 = createApp(cfg);
    await new Promise(r => app2.server.listen(0, '127.0.0.1', r));
    const base2 = `http://127.0.0.1:${app2.server.address().port}`;
    const w = await (await fetch(base2 + '/api/agent/wait?timeout=1', { headers: { Authorization: `Bearer ${tok}` } })).json();
    assert.equal(w.message.text, 'не загубись');
    app2.close();
    assert.ok(file === null || typeof file === 'string');
  } finally { require('node:fs').rmSync(own.dir, { recursive: true, force: true }); }
});

test('disconnecting an agent ends its hanging wait with 401 within a second and kills the key', async () => {
  const { owner, id } = await roomWithOwner('kill-own', 'Іван');
  const ag = await connect(owner, id);
  const waiting = agentCall(ag.token, 'GET', '/wait?timeout=30');
  await new Promise(r => setTimeout(r, 200));
  const t0 = Date.now();
  const del = await owner.call('DELETE', `/api/rooms/${id}/agents/${ag.agent.id}`);
  assert.equal(del.status, 200);
  const w = await waiting;
  assert.equal(w.status, 401);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal((await agentCall(ag.token, 'GET', '/brief')).status, 401);
});

test('removing a person disconnects their agents; a member cannot disconnect someone else\'s agent', async () => {
  const { owner, id } = await roomWithOwner('rm-own', 'Іван');
  const marta = await person(srv.base, 'rm-marta', 'Марта');
  const inv = await owner.call('POST', `/api/rooms/${id}/invites`, { github_login: 'rm-marta' });
  await marta.call('GET', new URL(inv.json.url).pathname);
  const mine = await connect(owner, id);
  const hers = await connect(marta, id, 'codex');
  assert.equal((await marta.call('DELETE', `/api/rooms/${id}/agents/${mine.agent.id}`)).status, 403);
  await owner.call('DELETE', `/api/rooms/${id}/members/${marta.user.uid}`);
  assert.equal((await agentCall(hers.token, 'GET', '/brief')).status, 401);
  assert.equal((await agentCall(mine.token, 'GET', '/brief')).status, 200);
});

test('a key collected once is not handed out again; brief does not contain the key', async () => {
  const { owner, id } = await roomWithOwner('col-own');
  const ag = await connect(owner, id);
  const b = await agentCall(ag.token, 'GET', '/brief');
  assert.ok(!b.text.includes(ag.token));
  const row = srv.app.db.get("SELECT token_once, status FROM pairings WHERE agent_id = ?", ag.agent.id);
  assert.equal(row.token_once, null);
  assert.equal(row.status, 'collected');
});
