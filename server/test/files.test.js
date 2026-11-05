'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { start, person, listen } = require('./helpers');
const { createFakeS3 } = require('./fake-s3');
const { presign } = require('../src/s3');

const CLI = path.join(__dirname, '..', 'cli', 'slopovyna.mjs');
let srv, s3, s3base;
test.before(async () => {
  srv = await start();
  s3 = createFakeS3({ origins: [srv.base] });
  await new Promise(r => s3.server.listen(0, '127.0.0.1', r));
  s3base = `http://127.0.0.1:${s3.server.address().port}`;
});
test.after(() => { srv.stop(); s3.server.close(); });

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(3000)]);
async function raw(method, url, { body, headers = {}, redirect = 'follow' } = {}) {
  const r = await fetch(url.startsWith('http') ? url : srv.base + url, { method, redirect, headers: { ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined });
  const buf = Buffer.from(await r.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString()); } catch {}
  return { status: r.status, json, buf, headers: r.headers };
}
const agent = tok => (method, url, body, headers) => raw(method, '/api/agent' + url, { body, headers: { Authorization: `Bearer ${tok}`, ...(headers || {}) } });

async function setup(tag) {
  const owner = await person(srv.base, `${tag}-own`, 'Іван');
  const marta = await person(srv.base, `${tag}-marta`, 'Марта');
  const { json: { id } } = await owner.call('POST', '/api/rooms', { text: `файли ${tag}` });
  const inv = await owner.call('POST', `/api/rooms/${id}/invites`, { github_login: `${tag}-marta` });
  await marta.call('GET', new URL(inv.json.url).pathname);
  const { json: { code } } = await owner.call('POST', `/api/rooms/${id}/join-codes`);
  const secret = crypto.randomBytes(16).toString('hex');
  const p = (await raw('POST', '/api/pair', { body: { code, secret_hash: sha(secret), model: 'claude' } })).json;
  await owner.call('POST', `/api/pairings/${p.pairing_id}/approve`);
  const tok = (await raw('GET', `/api/pair/${p.pairing_id}`, { headers: { 'X-Pair-Secret': secret } })).json.token;
  return { owner, marta, id, tok, ag: agent(tok) };
}
// An agent "client" that answers one file request with the given bytes.
async function serveOnce(ag, bytes) {
  const w = await ag('GET', '/wait?timeout=10');
  assert.equal(w.json.type, 'file_request');
  return ag('POST', `/relay/${w.json.request_id}`, bytes, { 'Content-Type': 'application/octet-stream' });
}

test('no bucket: an agent\'s file reaches a person through the server while the agent waits; nothing is written to disk', async () => {
  const { owner, id, ag } = await setup('src');
  const reg = await ag('POST', '/attachments', { name: 'screen.png', size: PNG.length, sha256: sha(PNG), mime: 'image/png' });
  assert.equal(reg.status, 201); assert.equal(reg.json.mode, 'source');
  const msg = await ag('POST', '/messages', { text: 'скриншот', attachments: [reg.json.id] });
  assert.equal(msg.status, 201, msg.buf.toString());
  const view = (await owner.call('GET', `/api/rooms/${id}/messages`)).json.messages.at(-1);
  assert.equal(view.files[0].name, 'screen.png'); assert.equal(view.files[0].inline, true); assert.equal(view.files[0].size, PNG.length);
  const serving = serveOnce(ag, PNG);
  await new Promise(r => setTimeout(r, 100));
  const dl = await raw('GET', `/api/rooms/${id}/attachments/${reg.json.id}`, { headers: { cookie: owner.cookie } });
  assert.equal(dl.status, 200);
  assert.ok(dl.buf.equals(PNG));
  assert.equal(dl.headers.get('content-type'), 'image/png');
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await serving).status, 200);
  // the bytes are nowhere under the server's data directory
  const marker = PNG.subarray(100, 160);
  for (const f of fs.readdirSync(srv.dir)) assert.ok(!fs.readFileSync(path.join(srv.dir, f)).includes(marker), `${f} holds file bytes`);
  const info = await owner.call('GET', `/api/rooms/${id}`);
  assert.equal(info.json.extra.files.relay.used, PNG.length);
  assert.equal(info.json.extra.files.relay.budget, 1024 * 1024 * 1024);
});

test('author offline: a clear 404 naming who has the file', async () => {
  const { owner, id, ag } = await setup('off');
  const body = Buffer.from('лог помилки');
  const reg = await ag('POST', '/attachments', { name: 'err.log', size: body.length, sha256: sha(body), mime: 'text/plain' });
  await ag('POST', '/messages', { text: 'лог', attachments: [reg.json.id] });
  const dl = await owner.call('GET', `/api/rooms/${id}/attachments/${reg.json.id}`);
  assert.equal(dl.status, 404);
  assert.equal(dl.json.code, 'offline');
  assert.match(dl.json.error, /Claude · Іван/);
});

test('a file whose bytes do not match its sha256 is not delivered', async () => {
  const { owner, id, ag } = await setup('bad');
  const reg = await ag('POST', '/attachments', { name: 'a.png', size: PNG.length, sha256: sha(PNG), mime: 'image/png' });
  await ag('POST', '/messages', { text: 'x', attachments: [reg.json.id] });
  const forged = Buffer.from(PNG); forged[PNG.length - 1] ^= 0xff;
  const serving = serveOnce(ag, forged);
  await new Promise(r => setTimeout(r, 100));
  let ok = false;
  try { const dl = await raw('GET', `/api/rooms/${id}/attachments/${reg.json.id}`, { headers: { cookie: owner.cookie } }); ok = dl.status === 200 && dl.buf.equals(forged); } catch { /* aborted mid-way: good */ }
  assert.equal(ok, false, 'forged bytes were delivered whole');
  assert.equal((await serving).status, 422);
});

test('the monthly relay budget: when it is used up, files are refused with advice to connect a bucket', async () => {
  const { owner, id, ag } = await setup('bud');
  const reg = await ag('POST', '/attachments', { name: 'a.png', size: PNG.length, sha256: sha(PNG), mime: 'image/png' });
  await ag('POST', '/messages', { text: 'x', attachments: [reg.json.id] });
  srv.app.db.run('INSERT INTO relay_usage (room_id, month, bytes) VALUES (?,?,?)', id, new Date().toISOString().slice(0, 7), 1024 * 1024 * 1024 - 10);
  const dl = await owner.call('GET', `/api/rooms/${id}/attachments/${reg.json.id}`);
  assert.equal(dl.status, 403);
  assert.equal(dl.json.code, 'budget');
  assert.match(dl.json.error, /сховище/);
  assert.equal((await ag('POST', '/attachments', { name: 'big.bin', size: 26 * 1024 * 1024, sha256: sha('x'), mime: 'application/octet-stream' })).status, 413);
});

test('a person\'s file from the browser: the server asks the author\'s open tab over SSE and passes the bytes on', async () => {
  const { owner, marta, id } = await setup('hum');
  const body = Buffer.from('{"plan":"pro_yearly"}');
  const reg = await marta.call('POST', `/api/rooms/${id}/attachments`, { name: 'me.json', size: body.length, sha256: sha(body), mime: 'application/json' });
  assert.equal(reg.json.mode, 'source');
  await marta.call('POST', `/api/rooms/${id}/messages`, { text: 'контракт', attachments: [reg.json.id] });
  const asked = listen(srv.base, marta.cookie, e => e.event === 'file_request');
  await new Promise(r => setTimeout(r, 100));
  const dlP = raw('GET', `/api/rooms/${id}/attachments/${reg.json.id}`, { headers: { cookie: owner.cookie } });
  const ev = await asked;
  const up = await raw('POST', `/api/relay/${ev.data.request_id}`, { body, headers: { cookie: marta.cookie, 'X-CSRF': marta.csrf, 'Content-Type': 'application/octet-stream' } });
  assert.equal(up.status, 200);
  const dl = await dlP;
  assert.ok(dl.buf.equals(body));
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');   // JSON is a download, never rendered
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  // someone else cannot answer a request meant for Марта
  const asked2 = listen(srv.base, marta.cookie, e => e.event === 'file_request');
  await new Promise(r => setTimeout(r, 100));
  const dl2 = raw('GET', `/api/rooms/${id}/attachments/${reg.json.id}`, { headers: { cookie: owner.cookie } });
  const ev2 = await asked2;
  assert.equal((await raw('POST', `/api/relay/${ev2.data.request_id}`, { body, headers: { cookie: owner.cookie, 'X-CSRF': owner.csrf, 'Content-Type': 'application/octet-stream' } })).status, 404);
  await raw('POST', `/api/relay/${ev2.data.request_id}`, { body, headers: { cookie: marta.cookie, 'X-CSRF': marta.csrf, 'Content-Type': 'application/octet-stream' } });
  assert.equal((await dl2).status, 200);
});

test('SVG and HTML are never served as renderable', async () => {
  const { owner, id, ag } = await setup('svg');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const reg = await ag('POST', '/attachments', { name: 'x.svg', size: svg.length, sha256: sha(svg), mime: 'image/svg+xml' });
  await ag('POST', '/messages', { text: 'svg', attachments: [reg.json.id] });
  const view = (await owner.call('GET', `/api/rooms/${id}/messages`)).json.messages.at(-1);
  assert.equal(view.files[0].inline, false);
  const serving = serveOnce(ag, svg);
  await new Promise(r => setTimeout(r, 100));
  const dl = await raw('GET', `/api/rooms/${id}/attachments/${reg.json.id}`, { headers: { cookie: owner.cookie } });
  await serving;
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.match(dl.headers.get('content-security-policy'), /sandbox/);
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
});

test('own bucket: the server checks the key, then bytes go straight to and from the bucket', async () => {
  const { owner, marta, id, ag } = await setup('st');
  const bad = await owner.call('PUT', `/api/rooms/${id}/storage`, { endpoint: s3base, bucket: s3.config.bucket, access_key_id: s3.config.accessKeyId, secret_access_key: 'wrong', region: 'auto' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /SignatureDoesNotMatch|Перевір ключ/);
  assert.equal((await marta.call('PUT', `/api/rooms/${id}/storage`, { endpoint: s3base, bucket: 'slop-test', access_key_id: 'TESTKEY', secret_access_key: 'TESTSECRET' })).status, 403);
  const ok = await owner.call('PUT', `/api/rooms/${id}/storage`, { endpoint: s3base, bucket: s3.config.bucket, access_key_id: s3.config.accessKeyId, secret_access_key: s3.config.secretAccessKey, region: 'auto' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.storage.bucket, 'slop-test');
  assert.ok(!JSON.stringify(ok.json).includes('TESTSECRET'));
  assert.ok(!JSON.stringify(srv.app.db.all('SELECT * FROM storages')).includes('TESTSECRET'), 'secret is sealed at rest');

  const before = { ...s3.stats };
  const reg = await ag('POST', '/attachments', { name: 'screen.png', size: PNG.length, sha256: sha(PNG), mime: 'image/png' });
  assert.equal(reg.json.mode, 'storage');
  assert.match(reg.json.put_url, /X-Amz-Expires=300/);
  assert.equal((await ag('POST', '/messages', { text: 'ще не завантажено', attachments: [reg.json.id] })).status, 400);
  assert.equal((await raw('PUT', reg.json.put_url, { body: PNG })).status, 200);
  assert.equal((await ag('POST', `/attachments/${reg.json.id}/complete`, {})).status, 200);
  assert.equal((await ag('POST', '/messages', { text: 'у сховищі', attachments: [reg.json.id] })).status, 201);
  // the agent is offline (nobody waiting) and the file still opens: from the bucket
  const redirect = await raw('GET', `/api/rooms/${id}/attachments/${reg.json.id}`, { headers: { cookie: marta.cookie }, redirect: 'manual' });
  assert.equal(redirect.status, 302);
  const loc = redirect.headers.get('location');
  assert.ok(loc.startsWith(s3base), 'redirected to the bucket');
  assert.match(loc, /X-Amz-Expires=300/);
  const got = await raw('GET', loc);
  assert.ok(got.buf.equals(PNG));
  assert.equal(s3.stats.bytesIn - before.bytesIn, PNG.length);
  assert.equal(s3.stats.bytesOut - before.bytesOut, PNG.length);
  const info = await owner.call('GET', `/api/rooms/${id}`);
  assert.equal(info.json.extra.files.relay.used, 0, 'no proxy traffic counted for bucket files');
  // a link older than five minutes is refused by the bucket
  const old = presign({ method: 'GET', endpoint: s3base, bucket: 'slop-test', key: [...s3.objects.keys()].find(k => k.endsWith(reg.json.id)), region: 'auto', accessKeyId: 'TESTKEY', secretAccessKey: 'TESTSECRET', expires: 300, now: new Date(Date.now() - 301e3) });
  assert.equal((await raw('GET', old)).status, 403);
});

test('only members get files: stranger 404, disconnected agent 401, removed person 404', async () => {
  const { owner, marta, id, ag, tok } = await setup('acc');
  const stranger = await person(srv.base, 'acc-stranger');
  const body = Buffer.from('секрет кімнати');
  const reg = await ag('POST', '/attachments', { name: 's.txt', size: body.length, sha256: sha(body), mime: 'text/plain' });
  await ag('POST', '/messages', { text: 'x', attachments: [reg.json.id] });
  assert.equal((await stranger.call('GET', `/api/rooms/${id}/attachments/${reg.json.id}`)).status, 404);
  // a file id from another room does not open through this room
  const other = await setup('acc2');
  assert.equal((await other.owner.call('GET', `/api/rooms/${other.id}/attachments/${reg.json.id}`)).status, 404);
  assert.equal((await other.ag('GET', `/attachments/${reg.json.id}/meta`)).status, 404);
  await owner.call('DELETE', `/api/rooms/${id}/members/${marta.user.uid}`);
  assert.equal((await marta.call('GET', `/api/rooms/${id}/attachments/${reg.json.id}`)).status, 404);
  const ags = (await owner.call('GET', `/api/rooms/${id}`)).json.extra.agents;
  await owner.call('DELETE', `/api/rooms/${id}/agents/${ags[0].aid}`);
  assert.equal((await agent(tok)('GET', `/attachments/${reg.json.id}`)).status, 401);
});

test('CLI: say --file keeps the file on the agent\'s machine; another agent gets it with slopovyna get while the first waits', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-files-cli-'));
  const run = (who, args, input) => new Promise(resolve => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: path.join(home, who), SLOPOVYNA_HOME: path.join(home, who, 'cfg'), XDG_CACHE_HOME: path.join(home, who, 'cache'), SLOPOVYNA_SERVER: srv.base } });
    let out = '', err = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    if (input !== undefined) p.stdin.end(input);
    p.on('close', code => resolve({ code, out, err }));
  });
  try {
    const owner = await person(srv.base, 'clif-own', 'Іван');
    const { json: { id } } = await owner.call('POST', '/api/rooms', { text: 'файли через CLI' });
    async function join(who, as) {
      const { json: { code } } = await owner.call('POST', `/api/rooms/${id}/join-codes`);
      const j = run(who, ['join', code, '--as', as]);
      let p = null;
      for (let i = 0; i < 50 && !p; i++) { await new Promise(r => setTimeout(r, 100)); p = (await owner.call('GET', `/api/rooms/${id}`)).json.extra.pairings[0]; }
      await owner.call('POST', `/api/pairings/${p.id}/approve`);
      assert.equal((await j).code, 0);
    }
    await join('a', 'claude'); await join('b', 'codex');
    const shot = path.join(home, 'screen.png'); fs.writeFileSync(shot, PNG);
    const said = await run('a', ['say', '--file', shot, 'ось екран']);
    assert.equal(said.code, 0, said.err);
    const msgs = (await owner.call('GET', `/api/rooms/${id}/messages`)).json.messages;
    const fid = msgs.at(-1).files[0].id;
    // agent b reads it in the room as [файл …]
    const read = await run('b', ['read']);
    assert.match(read.out, new RegExp(`\\[файл ${fid}\\] screen\\.png \\(image/png, ${PNG.length} Б\\)`));
    // while a waits, b downloads
    const waiting = run('a', ['wait', '--timeout', '6']);
    await new Promise(r => setTimeout(r, 500));
    const got = await run('b', ['get', fid]);
    assert.equal(got.code, 0, got.err);
    const saved = got.out.match(/Збережено: (.+?) \(/)[1];
    assert.ok(fs.readFileSync(saved).equals(PNG));
    assert.ok(saved.startsWith(path.join(home, 'b', 'cache', 'slopovyna')));
    assert.match((await waiting).out, /Нових пінгів немає/);   // a served the file and went on waiting
    // a is gone: b still opens the copy it already has (checked against size and sha256)…
    const again = await run('b', ['get', fid]);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /з кешу/);
    assert.ok(fs.readFileSync(saved).equals(PNG));
    // …a tampered copy is not trusted: it is fetched again, and with a is offline that fails clearly
    fs.writeFileSync(saved, Buffer.from('підмінено'));
    const tampered = await run('b', ['get', fid]);
    assert.notEqual(tampered.code, 0);
    assert.match(tampered.err, /недоступний/);
    // and an agent that never fetched it is told the author is offline
    const ag2 = (await owner.call('GET', `/api/rooms/${id}`)).json.extra.agents.find(x => x.name === 'Claude');
    assert.ok(ag2);
    const direct = await owner.call('GET', `/api/rooms/${id}/attachments/${fid}`);
    assert.equal(direct.status, 404);
    assert.equal(direct.json.code, 'offline');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
