'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, person, listen } = require('./helpers');

let srv;
test.before(async () => { srv = await start(); });
test.after(() => srv.stop());

test('without a session the API answers 401 and the page is the app shell', async () => {
  for (const u of ['/api/rooms', '/api/me', '/api/search?q=ab']) assert.equal((await fetch(srv.base + u)).status, 401, u);
  const html = await (await fetch(srv.base + '/')).text();
  assert.match(html, /app\.js/);
  const r = await fetch(srv.base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"x"}' });
  assert.equal(r.status, 401);
});

test('writes need the CSRF token and our Origin', async () => {
  const a = await person(srv.base, 'csrf-a');
  const noToken = await a.call('POST', '/api/rooms', { text: 'hi' }, { 'X-CSRF': '' });
  assert.equal(noToken.status, 403);
  const foreign = await a.call('POST', '/api/rooms', { text: 'hi' }, { Origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
});

test('a room is created from its first message and titled by it', async () => {
  const a = await person(srv.base, 'ivan', 'Іван');
  const r = await a.call('POST', '/api/rooms', { text: 'Підписки: як мобілка дізнається про продовження\n\nдеталі нижче' });
  assert.equal(r.status, 201);
  const list = await a.call('GET', '/api/rooms');
  const room = list.json.rooms.find(x => x.id === r.json.id);
  assert.equal(room.title, 'Підписки: як мобілка дізнається про продовження');
  const msgs = await a.call('GET', `/api/rooms/${r.json.id}/messages`);
  assert.equal(msgs.json.messages.at(-1).text.split('\n')[0], 'Підписки: як мобілка дізнається про продовження');
  assert.equal(msgs.json.messages[0].kind, 'event');
});

test('outsiders see nothing: not in the list, 404 for the room, its messages and posting', async () => {
  const a = await person(srv.base, 'owner1');
  const b = await person(srv.base, 'stranger1');
  const { json: { id } } = await a.call('POST', '/api/rooms', { text: 'секретна тема' });
  assert.ok(!(await b.call('GET', '/api/rooms')).json.rooms.some(r => r.id === id));
  assert.equal((await b.call('GET', `/api/rooms/${id}`)).status, 404);
  assert.equal((await b.call('GET', `/api/rooms/${id}/messages`)).status, 404);
  assert.equal((await b.call('POST', `/api/rooms/${id}/messages`, { text: 'привіт' })).status, 404);
  assert.equal((await b.call('POST', `/api/rooms/${id}/invites`, { github_login: 'stranger1' })).status, 404);
  const search = await b.call('GET', '/api/search?q=секретна');
  assert.equal(search.json.hits.length, 0);
});

test('invite: only that GitHub account, only once; others get a clear refusal', async () => {
  const a = await person(srv.base, 'own-inv');
  const marta = await person(srv.base, 'marta-k', 'Марта');
  const eve = await person(srv.base, 'eve');
  const { json: { id } } = await a.call('POST', '/api/rooms', { text: 'бекенд і мобілка' });
  const inv = await a.call('POST', `/api/rooms/${id}/invites`, { github_login: 'marta-k' });
  assert.equal(inv.status, 201);
  const path = new URL(inv.json.url).pathname;

  const wrong = await eve.call('GET', path);
  assert.equal(wrong.status, 403);
  assert.match(wrong.text, /не для тебе/);
  assert.equal((await eve.call('GET', `/api/rooms/${id}`)).status, 404);

  const ok = await marta.call('GET', path);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), `/r/${id}`);
  assert.equal((await marta.call('GET', `/api/rooms/${id}`)).status, 200);

  const again = await eve.call('GET', path);
  assert.equal(again.status, 410);
  assert.match(again.text, /вже використано/);

  const anon = await fetch(srv.base + path, { redirect: 'manual' });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get('location'), /^\/\?next=/);
});

test('revoked and member-already invites', async () => {
  const a = await person(srv.base, 'own-rev');
  const b = await person(srv.base, 'bob-rev');
  const { json: { id } } = await a.call('POST', '/api/rooms', { text: 'кімната' });
  const inv = await a.call('POST', `/api/rooms/${id}/invites`, { github_login: 'bob-rev' });
  const list = await a.call('GET', `/api/rooms/${id}/invites`);
  assert.equal(list.json.invites.length, 1);
  await a.call('DELETE', `/api/rooms/${id}/invites/${list.json.invites[0].id}`);
  const r = await b.call('GET', new URL(inv.json.url).pathname);
  assert.equal(r.status, 410);
  assert.match(r.text, /відкликано/);
  assert.equal((await a.call('POST', `/api/rooms/${id}/invites`, { github_login: 'own-rev' })).status, 409);
  assert.equal((await a.call('POST', `/api/rooms/${id}/invites`, { github_login: 'bad login!' })).status, 400);
});

test('a member who is not the owner cannot invite, rename or delete', async () => {
  const a = await person(srv.base, 'own-perm');
  const b = await person(srv.base, 'mem-perm');
  const { json: { id } } = await a.call('POST', '/api/rooms', { text: 'права' });
  const inv = await a.call('POST', `/api/rooms/${id}/invites`, { github_login: 'mem-perm' });
  await b.call('GET', new URL(inv.json.url).pathname);
  assert.equal((await b.call('POST', `/api/rooms/${id}/invites`, { github_login: 'someone' })).status, 403);
  assert.equal((await b.call('PATCH', `/api/rooms/${id}`, { title: 'x' })).status, 403);
  assert.equal((await b.call('DELETE', `/api/rooms/${id}`)).status, 403);
  assert.equal((await b.call('DELETE', `/api/rooms/${id}/members/${a.user.uid}`)).status, 403);
  // and the owner can remove the member, who then loses access
  assert.equal((await a.call('DELETE', `/api/rooms/${id}/members/${b.user.uid}`)).status, 200);
  assert.equal((await b.call('GET', `/api/rooms/${id}`)).status, 404);
});

test('a message reaches another member live over SSE', async () => {
  const a = await person(srv.base, 'live-a');
  const b = await person(srv.base, 'live-b');
  const { json: { id } } = await a.call('POST', '/api/rooms', { text: 'наживо' });
  const inv = await a.call('POST', `/api/rooms/${id}/invites`, { github_login: 'live-b' });
  await b.call('GET', new URL(inv.json.url).pathname);
  const got = listen(srv.base, b.cookie, e => e.event === 'message' && e.data.text === 'бачиш?');
  await new Promise(r => setTimeout(r, 100));
  await a.call('POST', `/api/rooms/${id}/messages`, { text: 'бачиш?' });
  const e = await got;
  assert.equal(e.data.room, id);
  assert.equal(e.data.author.login, 'live-a');
});

test('history pages backwards and forwards without gaps', async () => {
  const a = await person(srv.base, 'pager');
  const { json: { id } } = await a.call('POST', '/api/rooms', { title: 'довга кімната' });
  const db = srv.app.db;
  for (let i = 1; i <= 130; i++) srv.app.ctx.postMessage({ roomId: id, authorKind: 'human', authorId: a.user.uid, text: `повідомлення ${i}` });
  const first = await a.call('GET', `/api/rooms/${id}/messages?limit=50`);
  assert.equal(first.json.messages.length, 50);
  assert.equal(first.json.messages.at(-1).text, 'повідомлення 130');
  assert.equal(first.json.has_older, true);
  const seen = new Set(first.json.messages.map(m => m.id));
  let before = first.json.messages[0].id, older;
  do {
    older = await a.call('GET', `/api/rooms/${id}/messages?before=${before}&limit=50`);
    for (const m of older.json.messages) { assert.ok(!seen.has(m.id)); seen.add(m.id); }
    before = older.json.messages[0].id;
  } while (older.json.has_older);
  assert.equal(seen.size, 131);   // 130 + the "created" event
  const mid = [...seen].sort((x, y) => x - y)[60];
  const around = await a.call('GET', `/api/rooms/${id}/messages?around=${mid}&limit=20`);
  assert.ok(around.json.messages.some(m => m.id === mid));
  assert.equal(around.json.has_newer, true);
  assert.ok(db);
});

test('search finds messages only in my rooms, case-insensitive, Cyrillic included', async () => {
  const a = await person(srv.base, 'search-a');
  const b = await person(srv.base, 'search-b');
  const { json: { id } } = await a.call('POST', '/api/rooms', { text: 'Вебхуки App Store приймаємо на /hooks/appstore' });
  await b.call('POST', '/api/rooms', { text: 'вебхуки в чужій кімнаті' });
  const r = await a.call('GET', '/api/search?q=ВЕБХУКИ');
  assert.equal(r.json.hits.length, 1);
  assert.equal(r.json.hits[0].room, id);
  assert.match(r.json.hits[0].snippet, /hooks\/appstore/);
  assert.equal((await a.call('GET', '/api/search?q=%25')).json.hits.length, 0);
});

test('mentions are stored as structured targets, only for room members', async () => {
  const a = await person(srv.base, 'men-a', 'Іван');
  const b = await person(srv.base, 'men-b', 'Марта');
  const { json: { id } } = await a.call('POST', '/api/rooms', { text: 'кімната' });
  const inv = await a.call('POST', `/api/rooms/${id}/invites`, { github_login: 'men-b' });
  await b.call('GET', new URL(inv.json.url).pathname);
  const r = await a.call('POST', `/api/rooms/${id}/messages`, { text: '@Марта глянь', mentions: [`u:${b.user.uid}`, 'u:999999', `u:${a.user.uid}`] });
  assert.deepEqual(r.json.mentions, [`u:${b.user.uid}`]);
  const rooms = await b.call('GET', '/api/rooms');
  assert.equal(rooms.json.rooms.find(x => x.id === id).mentioned, 1);
});

test('secrets are refused, the same idempotency key does not post twice', async () => {
  const a = await person(srv.base, 'idem');
  const { json: { id } } = await a.call('POST', '/api/rooms', { text: 'кімната' });
  const s = await a.call('POST', `/api/rooms/${id}/messages`, { text: 'ключ ghp_abcdefghijklmnopqrstuvwxyz0123456789AB' });
  assert.equal(s.status, 422);
  const one = await a.call('POST', `/api/rooms/${id}/messages`, { text: 'раз', idem: 'k-12345678' });
  const two = await a.call('POST', `/api/rooms/${id}/messages`, { text: 'раз', idem: 'k-12345678' });
  assert.equal(one.status, 201); assert.equal(two.status, 200); assert.equal(one.json.id, two.json.id);
  assert.equal((await a.call('POST', `/api/rooms/${id}/messages`, { text: 'x'.repeat(20001) })).status, 413);
});
