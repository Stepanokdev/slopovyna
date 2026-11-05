// Presigned S3 URLs (AWS Signature Version 4, query-string form). Works with AWS S3, Cloudflare R2
// (region "auto") and other S3-compatible stores, path-style: <endpoint>/<bucket>/<key>.
'use strict';
const crypto = require('node:crypto');

const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
const hex = s => crypto.createHash('sha256').update(s).digest('hex');
// RFC 3986 encoding as SigV4 wants it; "/" kept in paths.
const enc = (s, keepSlash) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(keepSlash ? /%2F/g : /$^/, '/');

function amzDate(d) { return d.toISOString().replace(/[:-]|\.\d{3}/g, ''); }

/**
 * presign({ method, endpoint, bucket, key, region, accessKeyId, secretAccessKey, expires, query, headers, now })
 * Returns a URL anyone can use for `expires` seconds to do exactly that method on that object.
 * `headers` are headers the caller will send and wants signed (e.g. content-type for a PUT).
 */
function presign({ method, endpoint, bucket, key, region, accessKeyId, secretAccessKey, expires = 300, query = {}, headers = {}, now = new Date() }) {
  const u = new URL(endpoint);
  const path = (u.pathname.replace(/\/$/, '') + '/' + enc(bucket) + (key !== undefined ? '/' + enc(key, true) : '')).replace(/\/{2,}/g, '/');
  const date = amzDate(now), day = date.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const hdrs = { host: u.host, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])) };
  const signedHeaders = Object.keys(hdrs).sort().join(';');
  const q = { ...query, 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKeyId}/${scope}`, 'X-Amz-Date': date, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': signedHeaders };
  const canonicalQuery = Object.keys(q).sort().map(k => `${enc(k)}=${enc(String(q[k]))}`).join('&');
  const canonicalHeaders = Object.keys(hdrs).sort().map(k => `${k}:${hdrs[k]}\n`).join('');
  const canonical = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, scope, hex(canonical)].join('\n');
  const kDate = hmac('AWS4' + secretAccessKey, day), kRegion = hmac(kDate, region), kService = hmac(kRegion, 's3'), kSigning = hmac(kService, 'aws4_request');
  const sig = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return `${u.protocol}//${u.host}${path}?${canonicalQuery}&X-Amz-Signature=${sig}`;
}

module.exports = { presign };
