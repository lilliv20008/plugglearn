'use strict';
const crypto = require('crypto');
const { db, now } = require('./db');

const SESSION_DAYS = 14;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${key}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, salt, key] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(key, 'hex'));
  } catch { return false; }
}

function createUser(email, password, role = 'admin') {
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) throw new Error('该邮箱已存在');
  if (String(password).length < 8) throw new Error('密码至少 8 位');
  const info = db.prepare('INSERT INTO users(email, pass_hash, role, created_at) VALUES(?,?,?,?)')
    .run(email.toLowerCase(), hashPassword(password), role, now());
  return Number(info.lastInsertRowid);
}

function authenticate(email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (!user || user.status !== 'active') return null;
  if (!verifyPassword(password, user.pass_hash)) return null;
  return user;
}

function issueSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)')
    .run(token, userId, now(), expires);
  return { token, expires };
}

function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT s.token, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function setupRequired() {
  return !db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
}

module.exports = { hashPassword, verifyPassword, createUser, authenticate, issueSession, userFromToken, destroySession, setupRequired, SESSION_DAYS };