// Files in rooms, without the server becoming a file store.
//
// The server keeps what a file is: name, size, sha256, who has it. The bytes live in one of two places:
//   • the room's own bucket (R2 or any S3), connected by the room owner: browsers and agents upload
//     and download with short presigned URLs, straight to and from the bucket;
//   • without a bucket, on the author's machine: when someone opens the file, the server asks the
//     author's client (an agent waiting for pings, or the author's open browser tab) to send it, and
//     passes the bytes through to the reader as they come, without writing them anywhere. That
//     traffic is paid by the server's owner, so each room has a monthly budget.
'use strict';
const crypto = require('node:crypto');
const { randomId, HttpError, readJSON, sha256 } = require('./util');
const { presign } = require('./s3');
const { t } = require('./i18n');

const MAX_SOURCE = 25 * 1024 * 1024;          // a file passed through the server
const MAX_STORAGE = 200 * 1024 * 1024;        // a file in the room's own bucket
const MAX_FILES = 10;
const BUDGET = Number(process.env.SLOP_RELAY_BUDGET || 1024 * 1024 * 1024);   // bytes per room per month
const LINK_SECONDS = 300;
const SOURCE_WAIT_MS = 20000;
const RASTER = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/gif': [0x47, 0x49, 0x46, 0x38], 'image/webp': [0x52, 0x49, 0x46, 0x46] };

// What a run of bytes really is, for the four formats shown inline; anything else is a download.
function sniff(buf) {
  for (const [type, sig] of Object.entries(RASTER)) {
    if (sig.every((b, i) => buf[i] === b) && (type !== 'image/webp' || buf.slice(8, 12).toString('latin1') === 'WEBP')) return type;
  }
  return null;
}
const month = () => new Date().toISOString().slice(0, 7);
const cleanName = n => String(n || 'file').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
const disposition = name => `attachment; filename="${cleanName(name).replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(cleanName(name))}`;

function install(ctx) {
  const { db, route, send, needMember, push, config, hooks, streams } = ctx;
  const key = crypto.createHash('sha256').update('slopovyna-storage:' + config.secretKey).digest();

  // ---------------------------------------------------------------- the room's bucket
  const seal = s => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const e = Buffer.concat([c.update(s, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), e]).toString('base64'); };
  const open = s => { const b = Buffer.from(s, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); };
  const storageOf = roomId => db.get('SELECT * FROM storages WHERE room_id = ?', roomId);
  function link(st, method, objectKey, extra = {}) {
    return presign({ method, endpoint: st.endpoint, bucket: st.bucket, key: objectKey, region: st.region, accessKeyId: st.access_key_id, secretAccessKey: open(st.secret_enc), expires: LINK_SECONDS, ...extra });
  }
  function storageView(roomId) {
    const st = storageOf(roomId);
    const used = db.get('SELECT bytes FROM relay_usage WHERE room_id = ? AND month = ?', roomId, month())?.bytes || 0;
    return { storage: st ? { endpoint: st.endpoint, bucket: st.bucket, region: st.region, prefix: st.prefix, key_hint: st.access_key_id.slice(0, 4) + '…' + st.access_key_id.slice(-2), since: st.created_at } : null,
      relay: { used, budget: BUDGET, month: month() } };
  }

  function validStorage(b) {
    const s = v => String(v || '').trim();
    let endpoint = s(b.endpoint).replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(endpoint)) throw new HttpError(400, 'st.badEndpoint');
    if (endpoint.startsWith('http://') && !config.allowHttpStorage) throw new HttpError(400, 'st.https');
    const bucket = s(b.bucket);
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new HttpError(400, 'st.badBucket');
    const region = s(b.region) || (/r2\.cloudflarestorage\.com/.test(endpoint) ? 'auto' : 'us-east-1');
    const access_key_id = s(b.access_key_id), secret = s(b.secret_access_key);
    if (!access_key_id || !secret) throw new HttpError(400, 'st.needKeys');
    const prefix = s(b.prefix).replace(/^\/+|\/+$/g, '');
    return { endpoint, bucket, region, access_key_id, secret, prefix };
  }

  // Before saving, the server proves the key works: it writes, reads and deletes a small probe object.
  async function probe(st) {
    const probeKey = (st.prefix ? st.prefix + '/' : '') + `slopovyna-probe-${randomId(8)}.txt`;
    const body = 'slopovyna access check';
    const sign = (method, extra) => presign({ method, endpoint: st.endpoint, bucket: st.bucket, key: probeKey, region: st.region, accessKeyId: st.access_key_id, secretAccessKey: st.secret, expires: 60, ...extra });
    const tryFetch = async (url, opts, what) => {
      let r; try { r = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) }); } catch (e) { throw new HttpError(400, 'st.connect', { vars: { what: { key: what }, why: e.cause?.code || e.message } }); }
      if (!r.ok) { const t = (await r.text().catch(() => '')).match(/<Code>([^<]+)<\/Code>/)?.[1] || r.status; throw new HttpError(400, 'st.refused', { vars: { what: { key: what }, code: t } }); }
      return r;
    };
    await tryFetch(sign('PUT'), { method: 'PUT', body }, 'st.write');
    const got = await (await tryFetch(sign('GET'), { method: 'GET' }, 'st.read')).text();
    if (got !== body) throw new HttpError(400, 'st.mismatch');
    await tryFetch(sign('DELETE'), { method: 'DELETE' }, 'st.delete');
  }

  route('GET', /^\/api\/rooms\/([\w]{12})\/storage$/, ({ res, s, m }) => { needMember(m[1], s.user); send(res, 200, storageView(m[1])); });
  route('PUT', /^\/api\/rooms\/([\w]{12})\/storage$/, async ({ req, res, s, m }) => {
    const me = needMember(m[1], s.user);
    if (me.role !== 'owner') throw new HttpError(403, 'st.ownerConnect');
    const st = validStorage(await readJSON(req, 8192));
    await probe(st);
    db.run(`INSERT INTO storages (room_id, endpoint, bucket, region, prefix, access_key_id, secret_enc, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(room_id) DO UPDATE SET endpoint=excluded.endpoint, bucket=excluded.bucket, region=excluded.region, prefix=excluded.prefix, access_key_id=excluded.access_key_id, secret_enc=excluded.secret_enc, created_by=excluded.created_by, created_at=excluded.created_at`,
      m[1], st.endpoint, st.bucket, st.region, st.prefix, st.access_key_id, seal(st.secret), s.user.id, Date.now());
    ctx.event(m[1], 'ev.storageOn', { name: s.user.name });
    push(ctx.memberIds(m[1]), 'storage', { room: m[1] });
    send(res, 200, storageView(m[1]));
  });
  // A presigned PUT the owner's browser tries once, to find out whether the bucket allows uploads from
  // this site (CORS). The server cannot check that for the browser.
  route('POST', /^\/api\/rooms\/([\w]{12})\/storage\/probe$/, ({ res, s, m }) => {
    const me = needMember(m[1], s.user);
    if (me.role !== 'owner') throw new HttpError(403, 'st.ownerOnly');
    const st = storageOf(m[1]); if (!st) throw new HttpError(404, 'st.none');
    const k = (st.prefix ? st.prefix + '/' : '') + `slopovyna-probe-${randomId(8)}.txt`;
    send(res, 200, { put: link(st, 'PUT', k, { headers: { 'content-type': 'text/plain' } }), del: link(st, 'DELETE', k), origin: config.origin });
  });
  route('DELETE', /^\/api\/rooms\/([\w]{12})\/storage$/, ({ res, s, m }) => {
    const me = needMember(m[1], s.user);
    if (me.role !== 'owner') throw new HttpError(403, 'st.ownerDisconnect');
    db.run('DELETE FROM storages WHERE room_id = ?', m[1]);
    ctx.event(m[1], 'ev.storageOff', { name: s.user.name });
    push(ctx.memberIds(m[1]), 'storage', { room: m[1] });
    send(res, 200, storageView(m[1]));
  });

  // ---------------------------------------------------------------- registering a file
  function register(roomId, who, b) {
    const size = Number(b.size), hash = String(b.sha256 || '').toLowerCase();
    if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'f.badSize');
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(400, 'f.needSha');
    const st = storageOf(roomId);
    const max = st ? MAX_STORAGE : MAX_SOURCE;
    if (size > max) throw new HttpError(413, st ? 'f.tooBig' : 'f.tooBigRelay', { vars: { mb: max / 1048576 } });
    const name = cleanName(b.name), mime = String(b.mime || 'application/octet-stream').slice(0, 100);
    const id = randomId(14), now = Date.now();
    const objectKey = st ? `${st.prefix ? st.prefix + '/' : ''}${roomId}/${id}` : null;   // chosen here, never by the client
    db.run("INSERT INTO attachments (id, room_id, uploader_kind, uploader_id, name, mime, size, sha256, mode, object_key, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      id, roomId, who.kind, who.id, name, mime, size, hash, st ? 'storage' : 'source', objectKey, st ? 'pending' : 'ready', now);
    if (!st) return { id, mode: 'source' };
    return { id, mode: 'storage', put_url: link(st, 'PUT', objectKey), expires_in: LINK_SECONDS };
  }
  async function complete(roomId, who, id) {
    const a = db.get('SELECT * FROM attachments WHERE id = ? AND room_id = ? AND uploader_kind = ? AND uploader_id = ?', id, roomId, who.kind, who.id);
    if (!a) throw new HttpError(404, 'f.none');
    if (a.status === 'ready') return { id, ok: true };
    const st = storageOf(roomId); if (!st) throw new HttpError(409, 'f.storageGoneUpload');
    let r; try { r = await fetch(link(st, 'HEAD', a.object_key), { method: 'HEAD', signal: AbortSignal.timeout(10000) }); } catch { throw new HttpError(502, 'f.storageDown'); }
    if (!r.ok) throw new HttpError(409, 'f.notInStorage');
    if (Number(r.headers.get('content-length')) !== a.size) throw new HttpError(409, 'f.sizeDiffers');
    db.run("UPDATE attachments SET status = 'ready' WHERE id = ?", id);
    return { id, ok: true };
  }

  // Attaching to a message happens inside postMessage's transaction.
  hooks.attach.push(({ messageId, roomId, authorKind, authorId, files }) => {
    if (files.length > MAX_FILES) throw new HttpError(400, 'f.maxFiles', { vars: { n: MAX_FILES } });
    for (const id of files) {
      const r = db.run("UPDATE attachments SET message_id = ? WHERE id = ? AND room_id = ? AND uploader_kind = ? AND uploader_id = ? AND status = 'ready' AND message_id IS NULL",
        messageId, id, roomId, authorKind, authorId);
      if (!r.changes) throw new HttpError(400, 'f.notReady');
    }
  });
  const fileView = f => ({ id: f.id, name: f.name, type: f.mime, size: f.size, sha256: f.sha256, mode: f.mode, inline: !!RASTER[f.mime], from: f.uploader_kind === 'human' ? `u:${f.uploader_id}` : `a:${f.uploader_id}` });
  hooks.decorate.push(v => {
    const fs = db.all('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at', v.id);
    if (fs.length) v.files = fs.map(fileView);
  });

  // ---------------------------------------------------------------- reading a file
  const relays = new Map();          // request id -> { a, res, timer, onCancel }

  async function deliver(req, res, a) {
    const lang = req.slopLang || res.slopLang || 'en';
    if (a.status !== 'ready') throw new HttpError(404, 'f.notUploaded');
    if (a.mode === 'storage') {
      const st = storageOf(a.room_id);
      if (!st) throw new HttpError(410, 'f.storageGone', { code: 'storage_gone' });
      const type = RASTER[a.mime] ? a.mime : 'application/octet-stream';
      const url = link(st, 'GET', a.object_key, { query: { 'response-content-type': type, 'response-content-disposition': disposition(a.name) } });
      res.writeHead(302, { Location: url, 'Cache-Control': 'no-store', 'X-Content-SHA256': a.sha256 });
      return res.end();
    }
    // from the author's machine
    const used = db.get('SELECT bytes FROM relay_usage WHERE room_id = ? AND month = ?', a.room_id, month())?.bytes || 0;
    if (used + a.size > BUDGET) throw new HttpError(403, 'f.budget', { code: 'budget', vars: { mb: Math.round(BUDGET / 1048576) } });
    const author = ctx.author(a.uploader_kind, a.uploader_id);
    const reqId = randomId(16);
    const payload = { request_id: reqId, attachment_id: a.id, name: a.name, size: a.size };
    let asked = false;
    if (a.uploader_kind === 'agent') asked = ctx.agents.requestFile(a.uploader_id, payload);
    else {
      const set = streams.get(Number(a.uploader_id));
      if (set && set.size) { push([Number(a.uploader_id)], 'file_request', { ...payload, room: a.room_id }); asked = true; }
    }
    const offline = () => { const who = a.uploader_kind === 'agent' ? `${author.name} · ${author.owner_name}` : author.name; return [404, { error: t(lang, a.uploader_kind === 'agent' ? 'f.offlineAgent' : 'f.offlineHuman', { who }), code: 'offline', author: who }]; };
    if (!asked) { const [c, b] = offline(); return send(res, c, b); }
    await new Promise(resolve => {
      const timer = setTimeout(() => { relays.delete(reqId); const [c, b] = offline(); send(res, c, b); resolve(); }, SOURCE_WAIT_MS);
      relays.set(reqId, { a, res, timer, resolve, lang });
      req.on('close', () => { const r = relays.get(reqId); if (r) { clearTimeout(r.timer); relays.delete(reqId); resolve(); } });
    });
  }

  // The author's client sends the bytes here. They go on to the reader as they arrive; the last chunk
  // is held until the sha256 is known, so a file that does not match is never delivered whole.
  async function relay(req, res, who, reqId) {
    const r = relays.get(reqId);
    if (!r || r.a.uploader_kind !== who.kind || r.a.uploader_id !== who.id) { req.resume(); throw new HttpError(404, 'f.noRequest'); }
    relays.delete(reqId); clearTimeout(r.timer);
    const { a, res: out, lang } = r;
    if (req.headers['x-slop-missing']) {
      send(out, 404, { error: t(lang, 'f.missing'), code: 'missing' });
      r.resolve(); return send(res, 200, { ok: true });
    }
    const hash = crypto.createHash('sha256');
    let got = 0, held = null, started = false, failed = false;
    const fail = key => { if (failed) return; failed = true; if (started) out.destroy(); else send(out, 502, { error: t(lang, key), code: 'mismatch' }); };
    try {
      for await (const chunk of req) {
        got += chunk.length;
        if (got > a.size) { fail('f.bigger'); break; }
        hash.update(chunk);
        if (!started) {
          started = true;
          const type = sniff(chunk) && RASTER[a.mime] ? sniff(chunk) : 'application/octet-stream';
          out.writeHead(200, { 'Content-Type': type, 'Content-Length': a.size, 'Content-Disposition': disposition(a.name), 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'private, no-store', 'X-Content-SHA256': a.sha256 });
        }
        if (held) out.write(held);
        held = chunk;
      }
    } catch { fail('f.interrupted'); }
    if (!failed) {
      if (got !== a.size || hash.digest('hex') !== a.sha256) fail('f.notMatch');
      else {
        out.end(held);
        db.run('INSERT INTO relay_usage (room_id, month, bytes) VALUES (?,?,?) ON CONFLICT(room_id, month) DO UPDATE SET bytes = bytes + excluded.bytes', a.room_id, month(), a.size);
      }
    }
    r.resolve();
    send(res, failed ? 422 : 200, failed ? { error: t(req.slopLang || res.slopLang || 'en', 'f.notMatchShort') } : { ok: true });
  }

  // ---------------------------------------------------------------- routes for people
  const fileIn = (roomId, id) => { const a = db.get('SELECT * FROM attachments WHERE id = ? AND room_id = ?', String(id), roomId); if (!a) throw new HttpError(404, 'f.none'); return a; };
  route('POST', /^\/api\/rooms\/([\w]{12})\/attachments$/, async ({ req, res, s, m }) => { needMember(m[1], s.user); send(res, 201, register(m[1], { kind: 'human', id: String(s.user.id) }, await readJSON(req, 8192))); });
  route('POST', /^\/api\/rooms\/([\w]{12})\/attachments\/([\w]{14})\/complete$/, async ({ res, s, m }) => { needMember(m[1], s.user); send(res, 200, await complete(m[1], { kind: 'human', id: String(s.user.id) }, m[2])); });
  route('GET', /^\/api\/rooms\/([\w]{12})\/attachments\/([\w]{14})$/, async ({ req, res, s, m }) => { needMember(m[1], s.user); await deliver(req, res, fileIn(m[1], m[2])); });
  route('POST', /^\/api\/relay\/([\w]{16})$/, async ({ req, res, s, m }) => relay(req, res, { kind: 'human', id: String(s.user.id) }, m[1]));

  // ---------------------------------------------------------------- routes for agents
  const agentRoute = (method, path, fn) => route(method, new RegExp('^/api/agent' + path + '$'), async c => fn({ ...c, a: ctx.agents.agentAuth(c.req) }));
  agentRoute('POST', '/attachments', async ({ req, res, a }) => send(res, 201, register(a.room_id, { kind: 'agent', id: a.id }, await readJSON(req, 8192))));
  agentRoute('POST', '/attachments/([\\w]{14})/complete', async ({ res, a, m }) => send(res, 200, await complete(a.room_id, { kind: 'agent', id: a.id }, m[1])));
  agentRoute('GET', '/attachments/([\\w]{14})/meta', ({ res, a, m }) => send(res, 200, fileView(fileIn(a.room_id, m[1]))));
  agentRoute('GET', '/attachments/([\\w]{14})', async ({ req, res, a, m }) => deliver(req, res, fileIn(a.room_id, m[1])));
  agentRoute('POST', '/relay/([\\w]{16})', async ({ req, res, a, m }) => relay(req, res, { kind: 'agent', id: a.id }, m[1]));

  // the panel shows the bucket and the month's traffic
  const prevExtra = ctx.getExtraRoomInfo();
  ctx.setExtraRoomInfo((roomId, user) => ({ ...prevExtra(roomId, user), files: storageView(roomId) }));

  // Files registered but never attached to a message (a closed tab, a failed upload) are forgotten after a day.
  const sweep = setInterval(() => db.run('DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?', Date.now() - 864e5), 3600e3);
  sweep.unref();

  return { sniff, BUDGET };
}

module.exports = { install, sniff, cleanName };
