// Hands out the agent CLI: /slopovyna.tgz for `npx -y <server>/slopovyna.tgz join …` and the bare
// script at /slopovyna.mjs. The tarball is built in memory at start, with this server's address baked
// in, so the one line an owner pastes needs nothing published anywhere else.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const CLI = path.join(__dirname, '..', 'cli');

function tarEntry(name, data, mode) {
  const h = Buffer.alloc(512);
  const put = (str, off, len) => h.write(str, off, len, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100); put(oct(mode, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
  put(oct(data.length, 12), 124, 12); put(oct(Math.floor(Date.UTC(2026, 10, 1) / 1000), 12), 136, 12);
  h.fill(' ', 148, 156); put('0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
  let sum = 0; for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}

function build(baseUrl) {
  const script = Buffer.from(fs.readFileSync(path.join(CLI, 'slopovyna.mjs'), 'utf8').replace("'__SLOP_SERVER__'", JSON.stringify(baseUrl)));
  const pkg = fs.readFileSync(path.join(CLI, 'package.json'));
  const tar = Buffer.concat([tarEntry('package/package.json', pkg, 0o644), tarEntry('package/slopovyna.mjs', script, 0o755), Buffer.alloc(1024)]);
  const tgz = zlib.gzipSync(tar, { level: 9 });
  return { script, tgz, etag: '"' + crypto.createHash('sha256').update(tgz).digest('hex').slice(0, 16) + '"' };
}

function install(ctx) {
  let built = null;
  const get = () => (built ||= build(ctx.config.baseUrl));
  ctx.route('GET', /^\/slopovyna\.tgz$/, ({ res }) => { const b = get(); ctx.send(res, 200, b.tgz, { 'Content-Type': 'application/gzip', ETag: b.etag, 'Cache-Control': 'no-cache' }); });
  ctx.route('GET', /^\/slopovyna\.mjs$/, ({ res }) => { const b = get(); ctx.send(res, 200, b.script, { 'Content-Type': 'text/javascript; charset=utf-8', ETag: b.etag, 'Cache-Control': 'no-cache' }); });
}

module.exports = { install, build };
