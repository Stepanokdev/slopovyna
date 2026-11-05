// SQLite through node:sqlite. One file, WAL, short transactions. Migrations are a list applied in
// order and remembered in PRAGMA user_version, so an existing database only gets what it lacks.
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     github_id INTEGER NOT NULL UNIQUE,
     login TEXT NOT NULL,
     name TEXT NOT NULL,
     avatar TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     id_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     csrf TEXT NOT NULL,
     user_agent TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE rooms (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     owner_id INTEGER NOT NULL REFERENCES users(id),
     created_at INTEGER NOT NULL,
     last_message_at INTEGER NOT NULL
   );
   CREATE TABLE members (
     room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('owner','member')),
     added_at INTEGER NOT NULL,
     last_read_id INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (room_id, user_id)
   );
   CREATE INDEX members_user ON members(user_id);
   CREATE TABLE invites (
     id INTEGER PRIMARY KEY,
     token_hash TEXT NOT NULL UNIQUE,
     room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
     github_id INTEGER,
     github_login TEXT NOT NULL,
     created_by INTEGER NOT NULL REFERENCES users(id),
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at INTEGER,
     used_by INTEGER,
     revoked_at INTEGER
   );
   CREATE INDEX invites_room ON invites(room_id);
   CREATE TABLE messages (
     id INTEGER PRIMARY KEY,
     room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
     author_kind TEXT NOT NULL CHECK (author_kind IN ('human','agent','system')),
     author_id TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message','summary','event')),
     text TEXT NOT NULL,
     text_lc TEXT NOT NULL,
     idem_key TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX messages_room ON messages(room_id, id);
   CREATE UNIQUE INDEX messages_idem ON messages(room_id, author_kind, author_id, idem_key) WHERE idem_key IS NOT NULL;
   CREATE TABLE mentions (
     message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
     target TEXT NOT NULL,
     PRIMARY KEY (message_id, target)
   );`,
  // A retried "create room" with the same key returns the room made the first time.
  `ALTER TABLE rooms ADD COLUMN create_key TEXT;
   CREATE UNIQUE INDEX rooms_create_key ON rooms(owner_id, create_key) WHERE create_key IS NOT NULL;`,
];

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  const have = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = have; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  // Prepared statements are cached per SQL text: the hot paths prepare once.
  const cache = new Map();
  const q = sql => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  const tx = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  };
  return { raw: db, q, tx, get: (sql, ...a) => q(sql).get(...a), all: (sql, ...a) => q(sql).all(...a), run: (sql, ...a) => q(sql).run(...a) };
}

module.exports = { open };
