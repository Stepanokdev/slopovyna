'use strict';
// The real CLI against a real server: join with the owner's approval, the key file, wait, reply.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { start, person } = require('./helpers');

const CLI = path.join(__dirname, '..', 'cli', 'slopovyna.mjs');
let srv, home;
test.before(async () => { srv = await start(); home = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-cli-')); });
test.after(() => { srv.stop(); fs.rmSync(home, { recursive: true, force: true }); });

function run(args, { input, env = {} } = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: home, SLOPOVYNA_HOME: path.join(home, 'cfg'), SLOPOVYNA_SERVER: srv.base, ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    if (input !== undefined) { p.stdin.end(input); }
    p.on('close', code => resolve({ code, out, err, all: out + err }));
    p.child = p;
  });
}

test('join → owner approves the same digits → key file 0600, key never printed; then wait and reply', async () => {
  const owner = await person(srv.base, 'cli-own', 'Іван');
  const { json: { id } } = await owner.call('POST', '/api/rooms', { text: 'контракт помилок' });
  const { json: { code, line } } = await owner.call('POST', `/api/rooms/${id}/join-codes`);
  assert.ok(line.includes(code));

  const joining = run(['join', code, '--as', 'claude']);
  // the owner's browser sees the request; approve it once its digits are known
  let pairing = null;
  for (let i = 0; i < 50 && !pairing; i++) { await new Promise(r => setTimeout(r, 100)); pairing = (await owner.call('GET', `/api/rooms/${id}`)).json.extra.pairings[0]; }
  assert.ok(pairing, 'pairing shows up for the owner');
  // before approval the room is not visible to anyone holding only the code
  await owner.call('POST', `/api/pairings/${pairing.id}/approve`);
  const j = await joining;
  assert.equal(j.code, 0, j.all);
  assert.ok(j.out.includes(`Код збігу: ${pairing.match}`), 'terminal shows the same digits as the browser');
  assert.match(j.out, /ти в кімнаті як «Claude · Іван»/);
  assert.match(j.out, /контракт помилок/);              // brief printed after joining

  const file = path.join(home, 'cfg', 'rooms', `${id}.json`);
  const st = fs.statSync(file);
  assert.equal(st.mode & 0o777, 0o600);
  const tokenValue = JSON.parse(fs.readFileSync(file, 'utf8')).token;
  assert.match(tokenValue, /^slp_/);
  assert.ok(!j.all.includes(tokenValue), 'the key is not in the CLI output');

  // the same code again: a clear error, non-zero exit
  const again = await run(['join', code]);
  assert.notEqual(again.code, 0);
  assert.match(again.err, /уже використано/);

  // a ping: the owner mentions the agent, wait prints it, say --reply-to answers and closes it
  const ag = (await owner.call('GET', `/api/rooms/${id}`)).json.extra.agents[0];
  await owner.call('POST', `/api/rooms/${id}/messages`, { text: '@Claude · Іван який формат помилок?', mentions: [ag.id] });
  const w = await run(['wait', '--timeout', '3']);
  assert.equal(w.code, 0, w.all);
  assert.match(w.out, /ПІНГ (\d+)/);
  assert.match(w.out, /ВІД ТВОГО ВЛАСНИКА/);
  const ev = w.out.match(/ПІНГ (\d+)/)[1];
  const say = await run(['say', '--reply-to', ev, '-'], { input: 'Пропоную {code, message, details}' });
  assert.equal(say.code, 0, say.all);
  assert.match(say.out, new RegExp(`пінг ${ev} закрито`));
  const second = await run(['say', '--reply-to', ev, 'ще раз']);
  assert.equal(second.code, 4);                         // already answered: told to do nothing

  const msgs = (await owner.call('GET', `/api/rooms/${id}/messages`)).json.messages;
  const asked = msgs.find(m => m.text.startsWith('@Claude'));
  assert.equal(asked.delivery[0].state, 'replied');
  assert.ok(msgs.some(m => m.author.kind === 'agent' && m.text === 'Пропоную {code, message, details}'));
  for (const m of msgs) assert.ok(!m.text.includes(tokenValue));

  // disconnected: the CLI says so and exits 3
  await owner.call('DELETE', `/api/rooms/${id}/agents/${ag.aid}`);
  const dead = await run(['read']);
  assert.equal(dead.code, 3);
  assert.match(dead.err, /відключили/);
});

test('a denied request ends the join with a clear message', async () => {
  const owner = await person(srv.base, 'cli-deny');
  const { json: { id } } = await owner.call('POST', '/api/rooms', { text: 'відмова' });
  const { json: { code } } = await owner.call('POST', `/api/rooms/${id}/join-codes`);
  const joining = run(['join', code], { env: { SLOPOVYNA_HOME: path.join(home, 'cfg2') } });
  let pairing = null;
  for (let i = 0; i < 50 && !pairing; i++) { await new Promise(r => setTimeout(r, 100)); pairing = (await owner.call('GET', `/api/rooms/${id}`)).json.extra.pairings[0]; }
  await owner.call('POST', `/api/pairings/${pairing.id}/deny`);
  const j = await joining;
  assert.notEqual(j.code, 0);
  assert.match(j.err, /відхилив/);
  assert.ok(!fs.existsSync(path.join(home, 'cfg2', 'rooms', `${id}.json`)));
});

test('the tarball the one-line command downloads is a valid npm package with this server baked in', async () => {
  const r = await fetch(srv.base + '/slopovyna.tgz');
  assert.equal(r.status, 200);
  const tar = require('node:zlib').gunzipSync(Buffer.from(await r.arrayBuffer()));
  assert.equal(tar.subarray(0, 20).toString(), 'package/package.json');
  assert.ok(tar.includes(Buffer.from('package/slopovyna.mjs')));
  assert.ok(tar.includes(Buffer.from(JSON.stringify(srv.base))));
});
