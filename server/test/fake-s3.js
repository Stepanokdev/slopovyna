'use strict';
// A small S3-compatible bucket for tests and local runs. It checks presigned requests on its own
// (recomputes SigV4 from what arrives, refuses expired links), keeps objects in memory, answers CORS
// for allowed origins and counts the bytes it served — which is how the tests show that file bytes
// went to the bucket and not through the Slopovyna server.
//   node test/fake-s3.js 9100 http://localhost:3801     # run standalone
const http = require('node:http');
const crypto = require('node:crypto');

function createFakeS3({ accessKeyId = 'TESTKEY', secretAccessKey = 'TESTSECRET', bucket = 'slop-test', region = 'auto', origins = [] } = {}) {
  const objects = new Map();            // key -> { body, type }
  const stats = { put: 0, get: 0, bytesIn: 0, bytesOut: 0, rejected: 0 };
  const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
  const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

  function verify(req, url) {
    const q = Object.fromEntries(url.searchParams);
    const sig = q['X-Amz-Signature'];
    if (!sig || q['X-Amz-Algorithm'] !== 'AWS4-HMAC-SHA256') return 'no signature';
    const [ak, day, reg, svc] = (q['X-Amz-Credential'] || '').split('/');
    if (ak !== accessKeyId || reg !== region || svc !== 's3') return 'bad credential';
    const t = q['X-Amz-Date'];
    const at = Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(9, 11), +t.slice(11, 13), +t.slice(13, 15));
    if (Date.now() > at + Number(q['X-Amz-Expires']) * 1000) return 'expired';
    const signed = q['X-Amz-SignedHeaders'].split(';');
    const canonQ = Object.keys(q).filter(k => k !== 'X-Amz-Signature').sort().map(k => `${enc(k)}=${enc(q[k])}`).join('&');
    const canonH = signed.map(h => `${h}:${String(req.headers[h] || '').trim()}\n`).join('');
    const canonical = [req.method, url.pathname, canonQ, canonH, signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', t, `${day}/${reg}/s3/aws4_request`, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
    const k = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), reg), 's3'), 'aws4_request');
    const want = crypto.createHmac('sha256', k).update(toSign).digest('hex');
    return want === sig ? null : 'signature mismatch';
  }
  function cors(req, res) {
    const o = req.headers.origin;
    if (o && origins.includes(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, HEAD, DELETE');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Expose-Headers', 'ETag, Content-Length');
    }
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const parts = url.pathname.split('/').filter(Boolean);
    if (decodeURIComponent(parts[0] || '') !== bucket) { res.writeHead(404); return res.end('<Error><Code>NoSuchBucket</Code></Error>'); }
    const why = verify(req, url);
    if (why) { stats.rejected++; res.writeHead(403, { 'Content-Type': 'application/xml' }); return res.end(`<Error><Code>${why === 'expired' ? 'AccessDenied' : 'SignatureDoesNotMatch'}</Code><Message>${why}</Message></Error>`); }
    const key = parts.slice(1).map(decodeURIComponent).join('/');
    if (req.method === 'PUT') {
      const chunks = []; req.on('data', c => chunks.push(c));
      req.on('end', () => { const body = Buffer.concat(chunks); objects.set(key, { body, type: req.headers['content-type'] || 'application/octet-stream' }); stats.put++; stats.bytesIn += body.length; res.writeHead(200, { ETag: '"' + crypto.createHash('md5').update(body).digest('hex') + '"' }); res.end(); });
      return;
    }
    const o = objects.get(key);
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
    if (!o) { res.writeHead(404, { 'Content-Type': 'application/xml' }); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
    const headers = { 'Content-Length': o.body.length, 'Content-Type': url.searchParams.get('response-content-type') || o.type,
      ...(url.searchParams.get('response-content-disposition') ? { 'Content-Disposition': url.searchParams.get('response-content-disposition') } : {}) };
    if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
    stats.get++; stats.bytesOut += o.body.length;
    res.writeHead(200, headers); res.end(o.body);
  });
  return { server, objects, stats, config: { accessKeyId, secretAccessKey, bucket, region } };
}

module.exports = { createFakeS3 };

if (require.main === module) {
  const port = Number(process.argv[2] || 9100);
  const s3 = createFakeS3({ origins: process.argv.slice(3) });
  s3.server.listen(port, () => console.log(`fake S3 on http://localhost:${port} bucket=${s3.config.bucket} key=${s3.config.accessKeyId} secret=${s3.config.secretAccessKey} origins=${process.argv.slice(3).join(',')}`));
}
