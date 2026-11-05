// People sign in with GitHub (scope read:user). The GitHub token is used once to read the profile
// and then dropped. A session is a random id in an HttpOnly cookie; only its sha256 is stored, so a
// session can be listed and revoked, and a stolen database does not hand out live cookies.
'use strict';
const { sha256, token, safeEqual, parseCookies, cookie, HttpError } = require('./util');

const SESSION_DAYS = 30;
const COOKIE = 'slop_s';
const STATE_COOKIE = 'slop_oauth';

function makeAuth({ db, config }) {
  const secure = config.baseUrl.startsWith('https://');

  function upsertUser({ github_id, login, name, avatar }) {
    const now = Date.now();
    db.run(`INSERT INTO users (github_id, login, name, avatar, created_at) VALUES (?,?,?,?,?)
            ON CONFLICT(github_id) DO UPDATE SET login=excluded.login, name=excluded.name, avatar=excluded.avatar`,
      github_id, login, name || login, avatar || '', now);
    return db.get('SELECT * FROM users WHERE github_id = ?', github_id);
  }

  function createSession(res, user, req) {
    const id = token(32), csrf = token(18), now = Date.now();
    db.run('INSERT INTO sessions (id_hash, user_id, csrf, user_agent, created_at, expires_at) VALUES (?,?,?,?,?,?)',
      sha256(id), user.id, csrf, String(req.headers['user-agent'] || '').slice(0, 200), now, now + SESSION_DAYS * 864e5);
    return cookie(COOKIE, id, { maxAge: SESSION_DAYS * 86400, secure });
  }

  function session(req) {
    const id = parseCookies(req)[COOKIE];
    if (!id) return null;
    const row = db.get(`SELECT s.id_hash, s.csrf, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`, sha256(id));
    if (!row) return null;
    if (row.expires_at < Date.now()) { db.run('DELETE FROM sessions WHERE id_hash = ?', row.id_hash); return null; }
    return { user: { id: row.id, github_id: row.github_id, login: row.login, name: row.name, avatar: row.avatar }, csrf: row.csrf, sid: row.id_hash };
  }

  function logout(req) {
    const id = parseCookies(req)[COOKIE];
    if (id) db.run('DELETE FROM sessions WHERE id_hash = ?', sha256(id));
    return cookie(COOKIE, '', { maxAge: 0, secure });
  }

  // Requests that change something with a cookie must carry the CSRF token from /api/me and, when
  // the browser sends one, an Origin equal to ours. A JSON body plus a custom header also forces a
  // CORS preflight that no other origin passes.
  function checkCsrf(req, s) {
    const origin = req.headers.origin;
    if (origin && origin !== config.origin) throw new HttpError(403, 'Запит з чужого сайту.');
    if (!safeEqual(req.headers['x-csrf'] || '', s.csrf)) throw new HttpError(403, 'Немає CSRF-токена. Онови сторінку.');
  }

  // ---- GitHub OAuth
  function safeNext(next) { return typeof next === 'string' && /^\/(?!\/)[\w\-./?=&%]*$/.test(next) ? next : '/'; }

  function begin(req, res, url) {
    if (!config.github.clientId) throw new HttpError(503, 'Вхід через GitHub ще не налаштовано на сервері.');
    const state = token(24);
    const next = safeNext(url.searchParams.get('next'));
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', config.github.clientId);
    u.searchParams.set('redirect_uri', config.baseUrl + '/auth/callback');
    u.searchParams.set('scope', 'read:user');
    u.searchParams.set('state', state);
    u.searchParams.set('allow_signup', 'true');
    res.writeHead(302, { Location: u.toString(), 'Set-Cookie': cookie(STATE_COOKIE, `${state}.${next}`, { maxAge: 600, secure }), 'Cache-Control': 'no-store' });
    res.end();
  }

  async function callback(req, res, url) {
    const raw = parseCookies(req)[STATE_COOKIE] || '';
    const dot = raw.indexOf('.');
    const want = dot > 0 ? raw.slice(0, dot) : '', next = safeNext(dot > 0 ? raw.slice(dot + 1) : '/');
    const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
    if (!want || !safeEqual(state, want) || !code) throw new HttpError(400, 'Вхід не вдався: посилання застаріло. Спробуй ще раз.');
    const tr = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.github.clientId, client_secret: config.github.clientSecret, code, redirect_uri: config.baseUrl + '/auth/callback' }),
    });
    const tj = await tr.json().catch(() => ({}));
    if (!tj.access_token) throw new HttpError(400, 'GitHub не підтвердив вхід. Спробуй ще раз.');
    const ur = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tj.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'slopovyna' } });
    const gh = await ur.json().catch(() => ({}));
    if (!ur.ok || !gh.id) throw new HttpError(502, 'Не вдалося прочитати профіль GitHub.');
    const user = upsertUser({ github_id: gh.id, login: gh.login, name: gh.name || gh.login, avatar: gh.avatar_url });
    res.writeHead(302, { Location: next, 'Set-Cookie': [createSession(res, user, req), cookie(STATE_COOKIE, '', { maxAge: 0, secure })], 'Cache-Control': 'no-store' });
    res.end();
  }

  // Local development and tests only: the server refuses to start with this in production.
  function devLogin(req, res, url) {
    if (!config.devLogin) throw new HttpError(404, 'Немає такої сторінки.');
    const login = String(url.searchParams.get('login') || '').toLowerCase();
    if (!/^[a-z\d][a-z\d-]{0,38}$/.test(login)) throw new HttpError(400, 'login');
    const gid = 1e9 + (parseInt(sha256(login).slice(0, 8), 16) % 1e9);
    const user = upsertUser({ github_id: gid, login, name: url.searchParams.get('name') || login, avatar: '' });
    res.writeHead(302, { Location: safeNext(url.searchParams.get('next')), 'Set-Cookie': createSession(res, user, req), 'Cache-Control': 'no-store' });
    res.end();
  }

  // Invites are bound to a GitHub account id, resolved when the invite is made, so a login that is
  // renamed and then taken by someone else does not inherit the invitation.
  async function resolveGithubLogin(login) {
    if (config.devLogin) {
      const u = db.get('SELECT github_id FROM users WHERE lower(login) = lower(?)', login);
      return { github_id: u ? u.github_id : 1e9 + (parseInt(sha256(login.toLowerCase()).slice(0, 8), 16) % 1e9), login };
    }
    const r = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'slopovyna' } });
    if (r.status === 404) throw new HttpError(404, `На GitHub немає акаунта @${login}.`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.id) throw new HttpError(502, 'GitHub зараз не відповідає. Спробуй за хвилину.');
    return { github_id: j.id, login: j.login };
  }

  return { session, logout, checkCsrf, begin, callback, devLogin, resolveGithubLogin, upsertUser };
}

module.exports = { makeAuth };
