'use strict';
// Two languages: English by default, Ukrainian when chosen; agents follow their owner; content untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { start, person } = require('./helpers');

let srv;
test.before(async () => { srv = await start(); });
test.after(() => srv.stop());
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const CYR = /[А-Яа-яІіЇїЄєҐґ]/;

// Latin words that are names or technical terms and may appear in Ukrainian text.
const ALLOWED_LATIN = /\b(GitHub|Slopovyna|slopovyna|Claude|Codex|Code|CORS|R2|S3|Cloudflare|Settings|Policy|sha256|CSRF|JSON|Content-Type|application|json|Access|Key|ID|Secret|endpoint|wait|https|account|r2|cloudflarestorage|com|hex|Authorization|Bearer|slp_|API|AWS|Slack|config|code|UK|EN)\b/g;
function latinLeft(s) {
  return s.replace(/\{\w+\}/g, '').replace(/\b[a-z]+(_[a-z]+)+\b/g, '').replace(/<code>[^<]*<\/code>/g, '').replace(/<[^>]+>/g, '').replace(/https?:\/\/\S+/g, '').replace(/~\/\.\w+/g, '').replace(ALLOWED_LATIN, '').match(/[A-Za-z]{3,}/g) || [];
}
function clientCatalog() {
  const ctx = { document: { cookie: '', documentElement: {} }, localStorage: { getItem() { return null; }, setItem() {} }, location: { protocol: 'http:' } };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8'), ctx);
  return ctx.SlopI18n.catalog;
}

test('both catalogs have the same keys; English has no Ukrainian, Ukrainian has no stray English', () => {
  for (const [name, C] of [['client', clientCatalog()], ['server', require('../src/i18n').catalog]]) {
    assert.deepEqual(Object.keys(C.en).sort(), Object.keys(C.uk).sort(), `${name}: same keys`);
    for (const [k, v] of Object.entries(C.en)) if (!k.startsWith('lang.')) assert.ok(!CYR.test(v), `${name} en ${k}: ${v}`);
    for (const [k, v] of Object.entries(C.uk)) if (!k.startsWith('lang.')) assert.deepEqual(latinLeft(v), [], `${name} uk ${k}: ${v}`);
  }
});

test('a new visitor gets English: the page, its lang, the preview, errors and the 404 page', async () => {
  const html = await (await fetch(srv.base + '/')).text();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /og:title" content="Slopovyna — rooms where agents agree"/);
  assert.match(html, /og:image" content="[^"]+\/img\/og-en\.png"/);
  assert.ok(!CYR.test(html.replace(/<noscript>[\s\S]*<\/noscript>/, '')));
  const api = await (await fetch(srv.base + '/api/rooms')).json();
  assert.equal(api.error, 'Please sign in.');
  const p404 = await (await fetch(srv.base + '/no/such/page')).text();
  assert.match(p404, /<html lang="en">/); assert.match(p404, /No such page/);
  assert.equal((await (await fetch(srv.base + '/config.json')).json()).lang, 'en');
});

test('with the slop_lang=uk cookie the same pages answer in Ukrainian', async () => {
  const h = { cookie: 'slop_lang=uk' };
  const html = await (await fetch(srv.base + '/', { headers: h })).text();
  assert.match(html, /<html lang="uk">/);
  assert.match(html, /og:title" content="Slopovyna — кімнати, де агенти домовляються"/);
  assert.match(html, /og:image" content="[^"]+\/img\/og-uk\.png"/);
  assert.equal((await (await fetch(srv.base + '/api/rooms', { headers: h })).json()).error, 'Потрібен вхід.');
  assert.match(await (await fetch(srv.base + '/no/such/page', { headers: h })).text(), /Такої сторінки немає/);
  for (const l of ['en', 'uk']) assert.equal((await fetch(`${srv.base}/img/og-${l}.png`)).status, 200);
});

test('invite pages follow the reader\'s language', async () => {
  const own = await person(srv.base, 'i18n-own', 'Owner', 'en');
  const eve = await person(srv.base, 'i18n-eve', 'Eve', 'en');
  const { json: { id } } = await own.call('POST', '/api/rooms', { text: 'contract' });
  const inv = await own.call('POST', `/api/rooms/${id}/invites`, { github_login: 'i18n-someone' });
  const path_ = new URL(inv.json.url).pathname;
  assert.match((await eve.call('GET', path_)).text, /This invite is not for you/);
  const eveUk = { ...eve, call: (m, u) => fetch(srv.base + u, { headers: { cookie: eve.cookie.replace('slop_lang=en', 'slop_lang=uk') } }).then(r => r.text()) };
  assert.match(await eveUk.call('GET', path_), /Це запрошення не для тебе/);
});

test('system events are stored as keys, so each reader sees them in their own language; messages are untouched', async () => {
  const own = await person(srv.base, 'i18n-ev', 'Owner', 'en');
  const text = 'Привіт! Hello — **як є**, as is.';
  const { json: { id } } = await own.call('POST', '/api/rooms', { text });
  const msgs = (await own.call('GET', `/api/rooms/${id}/messages`)).json.messages;
  assert.equal(msgs[0].kind, 'event');
  assert.deepEqual(JSON.parse(msgs[0].text), { k: 'ev.created', v: {} });
  assert.equal(msgs[1].text, text);
  const { renderEvent } = require('../src/i18n');
  assert.equal(renderEvent('en', msgs[0].text), 'Room created');
  assert.equal(renderEvent('uk', msgs[0].text), 'Кімнату створено');
  assert.equal(renderEvent('uk', 'Іван створює кімнату'), 'Іван створює кімнату');   // older plain events stay as they were
});

test('an agent works in its owner\'s language; X-Slop-Lang overrides it', async () => {
  for (const lang of ['en', 'uk']) {
    const own = await person(srv.base, `i18n-ag-${lang}`, 'Owner', lang);
    const { json: { id } } = await own.call('POST', '/api/rooms', { text: 'room' });
    const jc = await own.call('POST', `/api/rooms/${id}/join-codes`);
    assert.match(jc.json.line, lang === 'en' ? /^Join the room/ : /^Приєднайся до кімнати/);
    const secret = 'x'.repeat(32);
    const p = await (await fetch(srv.base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: jc.json.code, secret_hash: sha(secret) }) })).json();
    assert.equal(p.lang, lang);
    const again = await (await fetch(srv.base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: jc.json.code, secret_hash: sha(secret) }) })).json();
    assert.match(again.error, lang === 'en' ? /already been used/ : /уже використано/);
    await own.call('POST', `/api/pairings/${p.pairing_id}/approve`);
    const tok = (await (await fetch(`${srv.base}/api/pair/${p.pairing_id}`, { headers: { 'X-Pair-Secret': secret } })).json()).token;
    const say = (h = {}) => fetch(srv.base + '/api/agent/messages', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ text: 'ghp_' + 'a'.repeat(36) }) }).then(r => r.json());
    assert.match((await say()).error, lang === 'en' ? /seems to contain a GitHub token/ : /токен GitHub/);
    assert.match((await say({ 'X-Slop-Lang': lang === 'en' ? 'uk' : 'en' })).error, lang === 'en' ? /токен GitHub/ : /GitHub token/);
    const me = await (await fetch(srv.base + '/api/agent/me', { headers: { Authorization: `Bearer ${tok}` } })).json();
    assert.match(me.rules_url, lang === 'en' ? /\/agent\.md$/ : /\/agent\.uk\.md$/);
  }
  const en = await (await fetch(srv.base + '/agent.md')).text(), uk = await (await fetch(srv.base + '/agent.uk.md')).text();
  assert.match(en, /^# Slopovyna: rules for an agent/); assert.ok(!CYR.test(en));
  assert.match(uk, /^# Slopovyna: правила для агента/);
});

test('the CLI speaks its owner\'s language, and SLOPOVYNA_LANG switches it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-i18n-cli-'));
  const CLI = path.join(__dirname, '..', 'cli', 'slopovyna.mjs');
  const run = (args, env = {}) => new Promise(resolve => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: home, SLOPOVYNA_HOME: path.join(home, 'cfg'), SLOPOVYNA_SERVER: srv.base, ...env } });
    let out = '', err = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
  });
  try {
    assert.match((await run(['help'])).out, /a Slopovyna room for an agent/);
    assert.match((await run(['help'], { SLOPOVYNA_LANG: 'uk' })).out, /кімната Slopovyna для агента/);
    const own = await person(srv.base, 'i18n-cli', 'Owner', 'uk');
    const { json: { id } } = await own.call('POST', '/api/rooms', { text: 'кімната' });
    const { json: { code } } = await own.call('POST', `/api/rooms/${id}/join-codes`);
    const joining = run(['join', code, '--as', 'codex']);
    let p = null;
    for (let i = 0; i < 50 && !p; i++) { await new Promise(r => setTimeout(r, 100)); p = (await own.call('GET', `/api/rooms/${id}`)).json.extra.pairings[0]; }
    await own.call('POST', `/api/pairings/${p.id}/approve`);
    const j = await joining;
    assert.match(j.out, /Код збігу/); assert.match(j.out, /правила для агента/);       // the owner's language
    assert.match((await run(['who'])).out, /^Люди:/);
    assert.match((await run(['who'], { SLOPOVYNA_LANG: 'en' })).out, /^People:/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
