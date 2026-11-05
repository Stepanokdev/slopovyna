'use strict';
const crypto = require('node:crypto');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const ALNUM = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomId(len = 12) {
  const out = []; const buf = crypto.randomBytes(len * 2);
  for (let i = 0; out.length < len && i < buf.length; i++) if (buf[i] < 256 - (256 % ALNUM.length)) out.push(ALNUM[buf[i] % ALNUM.length]);
  while (out.length < len) out.push(ALNUM[crypto.randomInt(ALNUM.length)]);
  return out.join('');
}
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    const k = part.slice(0, i).trim(); if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}
function cookie(name, value, { maxAge, secure, path = '/', httpOnly = true, sameSite = 'Lax' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

// message is an i18n key (src/i18n.js); extra.vars fills its {placeholders}, the rest of extra goes into the JSON reply
class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'err.tooLarge')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req, limit = 128 * 1024) {
  const ct = req.headers['content-type'] || '';
  if (!ct.startsWith('application/json')) throw new HttpError(415, 'err.json');
  const raw = await readBody(req, limit);
  try { const v = JSON.parse(raw.toString('utf8') || '{}'); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; }
  catch { throw new HttpError(400, 'err.jsonObject'); }
}

// Things that look like credentials. A post containing one is refused so a key does not end up in a
// room's history by accident. This catches the usual formats, not every secret in the world.
const SECRET_PATTERNS = [
  [/\bslp_[A-Za-z0-9_-]{20,}/, 'secret.slp'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, 'secret.api'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/, 'secret.github'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/, 'secret.github'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'secret.aws'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'secret.slack'],
  [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, 'secret.private'],
];
function findSecret(text) { for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what; return null; }

module.exports = { sha256, token, randomId, safeEqual, parseCookies, cookie, HttpError, readBody, readJSON, findSecret };
