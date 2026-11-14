'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.PLUGGLEARN_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'plugglearn.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'chaoxing',
  username TEXT,
  password TEXT,
  cookie TEXT,
  fid TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  status_note TEXT,
  last_check_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  course_filter TEXT,
  speed REAL NOT NULL DEFAULT 1.5,
  concurrency INTEGER NOT NULL DEFAULT 1,
  window_start TEXT NOT NULL DEFAULT '00:00',
  window_end TEXT NOT NULL DEFAULT '23:59',
  interval_ms INTEGER NOT NULL DEFAULT 4000,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER REFERENCES plans(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'chaoxing',
  course_id TEXT,
  course_name TEXT,
  unit_id TEXT,
  kind TEXT NOT NULL DEFAULT 'video',
  title TEXT,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  progress REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  account_id INTEGER,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  price_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);
CREATE INDEX IF NOT EXISTS idx_records_created ON records(created_at DESC);
`);

// 轻量迁移：老库补列
for (const sql of [
  "ALTER TABLE tasks ADD COLUMN next_at TEXT",
  "ALTER TABLE accounts ADD COLUMN last_error TEXT",
]) {
  try { db.exec(sql); } catch { /* 列已存在 */ }
}

const now = () => new Date().toISOString();

function get(key, dflt = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : dflt;
}
function set(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
function getJSON(key, dflt) {
  try { return JSON.parse(get(key, '')) ?? dflt; } catch { return dflt; }
}
function setJSON(key, obj) { set(key, JSON.stringify(obj)); }

function log(level, message, { taskId = null, accountId = null, meta = null } = {}) {
  db.prepare('INSERT INTO records(task_id, account_id, level, message, meta, created_at) VALUES(?,?,?,?,?,?)')
    .run(taskId, accountId, level, String(message).slice(0, 2000), meta ? JSON.stringify(meta) : null, now());
  // keep the log bounded, newest 5000 rows
  db.exec(`DELETE FROM records WHERE id <= (SELECT MAX(id) - 5000 FROM records)`);
}

module.exports = { db, now, get, set, getJSON, setJSON, log, DATA_DIR };