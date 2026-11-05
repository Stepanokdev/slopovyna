'use strict';
// A crashed agent, through the real CLI and its saved state file: the ping it took and never answered
// comes back — at once while its lease still holds, and through the inbox once the lease has run out,
// also across a server restart — and ends with exactly one reply.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createApp } = require('../src/app');
const { person } = require('./helpers');

const CLI = path.join(__dirname, '..', 'cli', 'slopovyna.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-rec-'));
const home = path.join(dir, 'home');
let app, base, port;

async function boot() {
  const cfg = { port: 0, baseUrl: '', origin: '', dbFile: path.join(dir, 'slop.db'), github: { clientId: '', clientSecret: '' }, devLogin: true, secretKey: 'test-secret-key' };
  app = createApp(cfg);
  await new Promise(r => app.server.listen(port || 0, '127.0.0.1', r));
  port = app.server.address().port;
  base = `http://127.0.0.1:${port}`;
  cfg.baseUrl = base; cfg.origin = base;
}
async function restart() {
  const closed = new Promise(r => app.server.once('close', r));
  app.server.closeAllConnections?.();
  app.close();
  await closed;
  await boot();
}
function cli(args, input) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: home, SLOPOVYNA_HOME: path.join(home, 'cfg'), SLOPOVYNA_SERVER: base } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    if (input !== undefined) p.stdin.end(input);
    p.on('close', code => resolve({ code, out, err }));
  });
}
const stateFile = id => path.join(home, 'cfg', 'rooms', `${id}.state.json`);

test.before(boot);
test.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('take → crash without answering → (lease still holds) restart picks it up at once → lease runs out → server restart → inbox gives it again → one reply', async () => {
  const owner = await person(base, 'rec-own', 'Іван');
  const { json: { id } } = await owner.call('POST', '/api/rooms', { text: 'відновлення' });
  const { json: { code } } = await owner.call('POST', `/api/rooms/${id}/join-codes`);
  const joining = cli(['join', code, '--as', 'codex']);
  let p = null;
  for (let i = 0; i < 50 && !p; i++) { await new Promise(r => setTimeout(r, 100)); p = (await owner.call('GET', `/api/rooms/${id}`)).json.extra.pairings[0]; }
  await owner.call('POST', `/api/pairings/${p.id}/approve`);
  assert.equal((await joining).code, 0);
  const ag = (await owner.call('GET', `/api/rooms/${id}`)).json.extra.agents[0];

  await owner.call('POST', `/api/rooms/${id}/messages`, { text: 'питання, на яке агент упаде', mentions: [ag.id] });

  // 1. the agent takes the ping, then "crashes": it never answers
  const first = await cli(['wait', '--timeout', '3']);
  assert.equal(first.code, 0, first.err);
  const ev = first.out.match(/ПІНГ (\d+)/)[1];
  assert.ok(JSON.parse(fs.readFileSync(stateFile(id), 'utf8')).leases[ev], 'the lease is in the saved state');

  // 2. restarted while its lease still holds: wait hands the same ping back at once, not after 10 minutes
  const t0 = Date.now();
  const again = await cli(['wait', '--timeout', '30']);
  assert.ok(Date.now() - t0 < 5000);
  assert.match(again.out, new RegExp(`ПІНГ ${ev} .*ти ще не відповів`));

  // 3. other commands keep a live lease alive, but never revive one that ran out
  await cli(['read']);
  const row = () => app.db.get('SELECT * FROM inbox WHERE id = ?', Number(ev));
  app.db.run('UPDATE inbox SET lease_until = ? WHERE id = ?', Date.now() - 1000, Number(ev));
  // the state file still believes the lease is good for minutes; the server refuses to renew it
  const st = JSON.parse(fs.readFileSync(stateFile(id), 'utf8')); st.leases[ev].until = Date.now() + 60e3; fs.writeFileSync(stateFile(id), JSON.stringify(st));
  await cli(['renew']);
  assert.ok(row().lease_until < Date.now(), 'an expired lease was not renewed');

  // 4. the server restarts; the expired ping comes back through the inbox to the restarted client
  await restart();
  const back = await cli(['wait', '--timeout', '3']);
  assert.equal(back.code, 0, back.err);
  assert.match(back.out, new RegExp(`ПІНГ ${ev} .*спроба 2`));
  assert.match(back.out, /питання, на яке агент упаде/);
  assert.equal(row().attempts, 2);

  // 5. one answer, and only one
  const ans = await cli(['say', '--reply-to', ev, 'відповідь після падіння']);
  assert.equal(ans.code, 0, ans.err);
  const dup = await cli(['say', '--reply-to', ev, 'відповідь після падіння']);
  assert.equal(dup.code, 4);
  assert.equal((await cli(['wait', '--timeout', '1'])).out.trim(), 'Нових пінгів немає. Запусти wait ще раз.');
  const replies = (await owner.call('GET', `/api/rooms/${id}/messages`)).json.messages.filter(m => m.author.kind === 'agent');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, 'відповідь після падіння');
  assert.equal(row().state, 'acked');
});

test('the server will not renew an expired lease', async () => {
  const owner = await person(base, 'rec-own2');
  const { json: { id } } = await owner.call('POST', '/api/rooms', { text: 'оренда' });
  const { json: { code } } = await owner.call('POST', `/api/rooms/${id}/join-codes`);
  const crypto = require('node:crypto');
  const secret = 's'.repeat(40);
  const pr = await (await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, secret_hash: crypto.createHash('sha256').update(secret).digest('hex') }) })).json();
  await owner.call('POST', `/api/pairings/${pr.pairing_id}/approve`);
  const tok = (await (await fetch(base + `/api/pair/${pr.pairing_id}`, { headers: { 'X-Pair-Secret': secret } })).json()).token;
  const ag = (await owner.call('GET', `/api/rooms/${id}`)).json.extra.agents[0];
  await owner.call('POST', `/api/rooms/${id}/messages`, { text: 'x', mentions: [ag.id] });
  const w = await (await fetch(base + '/api/agent/wait?timeout=1', { headers: { Authorization: `Bearer ${tok}` } })).json();
  app.db.run('UPDATE inbox SET lease_until = ? WHERE id = ?', Date.now() - 1, w.event_id);
  const r = await fetch(base + `/api/agent/inbox/${w.event_id}/renew`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ lease_id: w.lease_id }) });
  assert.equal(r.status, 410);
  const held = await fetch(base + `/api/agent/inbox/${w.event_id}?lease_id=${w.lease_id}`, { headers: { Authorization: `Bearer ${tok}` } });
  assert.equal(held.status, 410);
});
