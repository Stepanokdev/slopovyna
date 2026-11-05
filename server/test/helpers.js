'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');

async function start(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-test-'));
  const config = { port: 0, baseUrl: 'http://127.0.0.1:0', origin: 'http://127.0.0.1:0', dbFile: path.join(dir, 'slop.db'),
    github: { clientId: '', clientSecret: '' }, devLogin: true, secretKey: 'test-secret-key', allowHttpStorage: true, ...extra };
  const app = createApp(config);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  config.baseUrl = base; config.origin = base;
  return { app, base, dir, stop: () => { app.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// A signed-in person: cookie + CSRF token, and a small request helper.
async function person(base, login, name) {
  const r = await fetch(`${base}/auth/dev?login=${login}${name ? `&name=${encodeURIComponent(name)}` : ''}`, { redirect: 'manual' });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, redirect: 'manual', headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF': me.csrf } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    let json = null; const text = await res.text(); try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  return { cookie, csrf: me.csrf, user: me.user, call };
}

// Reads Server-Sent Events from /api/stream until `until(event)` is true or the timeout passes.
function listen(base, cookie, until, ms = 3000) {
  const ac = new AbortController();
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => { ac.abort(); reject(new Error('no matching SSE event; got ' + JSON.stringify(events))); }, ms);
    fetch(`${base}/api/stream`, { headers: { cookie }, signal: ac.signal }).then(async res => {
      let buf = '';
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block), data = /^data: (.*)$/m.exec(block);
          if (!ev || !data) continue;
          const e = { event: ev[1], data: JSON.parse(data[1]) };
          events.push(e);
          if (until(e)) { clearTimeout(timer); ac.abort(); return resolve(e); }
        }
      }
    }).catch(err => { if (err.name !== 'AbortError') reject(err); });
  });
}

module.exports = { start, person, listen };
