'use strict';
// The whole file path against a real S3-compatible service (not our fake): connect the bucket (the
// server's write/read/delete probe), register an upload, PUT straight to the bucket, complete, and
// read it back as another member through the presigned redirect, with the author offline. Also: a
// browser-origin CORS preflight, a forged signature and an expired link are refused by the bucket.
//   SLOP_S3_ENDPOINT=https://… SLOP_S3_BUCKET=… SLOP_S3_KEY=… SLOP_S3_SECRET=… [SLOP_S3_REGION=…] node test/live-s3.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { start, person } = require('./helpers');
const { presign } = require('../src/s3');

const E = { endpoint: process.env.SLOP_S3_ENDPOINT, bucket: process.env.SLOP_S3_BUCKET, key: process.env.SLOP_S3_KEY, secret: process.env.SLOP_S3_SECRET, region: process.env.SLOP_S3_REGION || 'us-east-1' };
if (!E.endpoint || !E.bucket || !E.key || !E.secret) { console.error('set SLOP_S3_ENDPOINT, SLOP_S3_BUCKET, SLOP_S3_KEY, SLOP_S3_SECRET'); process.exit(2); }

(async () => {
  const srv = await start({ allowHttpStorage: false });
  try {
    const owner = await person(srv.base, 'live-own', 'Іван');
    const marta = await person(srv.base, 'live-marta', 'Марта');
    const { json: { id } } = await owner.call('POST', '/api/rooms', { text: 'живий S3' });
    const inv = await owner.call('POST', `/api/rooms/${id}/invites`, { github_login: 'live-marta' });
    await marta.call('GET', new URL(inv.json.url).pathname);

    const wrong = await owner.call('PUT', `/api/rooms/${id}/storage`, { endpoint: E.endpoint, bucket: E.bucket, region: E.region, access_key_id: E.key, secret_access_key: E.secret + 'x' });
    assert.equal(wrong.status, 400, 'a wrong secret is refused by the probe');
    const ok = await owner.call('PUT', `/api/rooms/${id}/storage`, { endpoint: E.endpoint, bucket: E.bucket, region: E.region, access_key_id: E.key, secret_access_key: E.secret });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));

    const body = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(50000)]);
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const reg = await owner.call('POST', `/api/rooms/${id}/attachments`, { name: 'live.png', size: body.length, sha256: sha, mime: 'image/png' });
    assert.equal(reg.json.mode, 'storage');
    const put = await fetch(reg.json.put_url, { method: 'PUT', body });
    assert.equal(put.status, 200, 'direct PUT to the bucket');
    assert.equal((await owner.call('POST', `/api/rooms/${id}/attachments/${reg.json.id}/complete`, {})).status, 200);
    assert.equal((await owner.call('POST', `/api/rooms/${id}/messages`, { text: 'файл', attachments: [reg.json.id] })).status, 201);

    // the author has no open tab and no agent; the reader is sent to the bucket
    const r = await fetch(srv.base + `/api/rooms/${id}/attachments/${reg.json.id}`, { headers: { cookie: marta.cookie }, redirect: 'manual' });
    assert.equal(r.status, 302);
    const loc = r.headers.get('location');
    assert.ok(loc.startsWith(E.endpoint), 'redirect goes to the bucket, not through Slopovyna');
    const got = Buffer.from(await (await fetch(loc)).arrayBuffer());
    assert.ok(got.equals(body), 'bytes from the bucket match');

    // CORS from the site's origin, forged and expired links
    const pre = await fetch(loc, { method: 'OPTIONS', headers: { Origin: process.env.SLOP_S3_ORIGIN || 'http://localhost:3801', 'Access-Control-Request-Method': 'PUT' } });
    assert.ok(pre.headers.get('access-control-allow-origin'), 'bucket answers CORS preflight for the site');
    const objectKey = new URL(loc).pathname.split('/').slice(2).map(decodeURIComponent).join('/');
    const forged = presign({ method: 'GET', endpoint: E.endpoint, bucket: E.bucket, key: objectKey, region: E.region, accessKeyId: E.key, secretAccessKey: 'not-the-secret' });
    assert.equal((await fetch(forged)).status, 403);
    const expired = presign({ method: 'GET', endpoint: E.endpoint, bucket: E.bucket, key: objectKey, region: E.region, accessKeyId: E.key, secretAccessKey: E.secret, expires: 300, now: new Date(Date.now() - 301e3) });
    assert.equal((await fetch(expired)).status, 403);
    // clean up the object in the test bucket
    await fetch(presign({ method: 'DELETE', endpoint: E.endpoint, bucket: E.bucket, key: objectKey, region: E.region, accessKeyId: E.key, secretAccessKey: E.secret }), { method: 'DELETE' });
    console.log('live S3 OK:', E.endpoint);
  } finally { srv.stop(); }
})().catch(e => { console.error(e); process.exit(1); });
