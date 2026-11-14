'use strict';
/**
 * 验证码字形库：把「切好的 4 个字符位图」存进 SQLite，用最近邻做识别。
 *
 * 为什么不用现成 OCR：
 *   - 超星 processVerifyPng.ac 是 4 位定长字母数字、字符位置基本固定，切成 4 格后
 *     每个格子只需要认 1 个字符，最近邻（汉明距离）在这个规模上比通用 OCR 更准；
 *   - 项目本身零依赖，装不了 tesseract / ddddocr；
 *   - 每次识别成功都会把样本存回来，用得越久越准（一次都没标注过时由外部 OCR 兜底标签）。
 *
 * 一行样本 = 4 个格子，每个格子是 16×20 的二值位图（压成 320 个 0/1）。
 */
const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS captcha_glyphs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot INTEGER NOT NULL,          -- 第几个字符位 0..3
  answer TEXT NOT NULL,           -- 该位置的真实字符
  features TEXT NOT NULL,         -- JSON：长度 320 的 0/1 数组
  source TEXT,                    -- bank | winocr | remote | manual
  hits INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_captcha_glyphs_slot ON captcha_glyphs(slot, answer);
`);

const SLOTS = 4;
const CELL_W = 16;
const CELL_H = 20;
const DIM = CELL_W * CELL_H;

const insert = db.prepare('INSERT INTO captcha_glyphs (slot, answer, features, source, at) VALUES (?, ?, ?, ?, ?)');
const allRows = db.prepare('SELECT id, slot, answer, features FROM captcha_glyphs');
const bumpHit = db.prepare('UPDATE captcha_glyphs SET hits = hits + 1 WHERE id = ?');
const countRow = db.prepare('SELECT slot, answer, COUNT(*) AS n FROM captcha_glyphs GROUP BY slot, answer');

let cache = null;
let cacheAt = 0;
const CACHE_MS = 30 * 1000;

function load() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  const bySlot = Array.from({ length: SLOTS }, () => []);
  for (const r of allRows.all()) {
    let f;
    try { f = JSON.parse(r.features); } catch { continue; }
    if (!Array.isArray(f) || f.length !== DIM) continue;
    bySlot[r.slot].push({ id: r.id, answer: r.answer, f });
  }
  cache = bySlot;
  cacheAt = Date.now();
  return cache;
}

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** 存一条样本（4 个格子 + 4 个字符） */
function learn(cells, answer, source = 'bank') {
  const s = String(answer || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.length !== SLOTS || !Array.isArray(cells) || cells.length !== SLOTS) return 0;
  let n = 0;
  for (let i = 0; i < SLOTS; i++) {
    const f = cells[i];
    if (!Array.isArray(f) || f.length !== DIM) continue;
    insert.run(i, s[i], JSON.stringify(f.map((v) => (v ? 1 : 0))), source, new Date().toISOString());
    n++;
  }
  cache = null;
  return n;
}

/**
 * 识别：每个格子找最近的若干条样本投票。
 * 返回 { code, confident, detail }
 *   confident 为 true 表示 4 个格子都过了阈值（距离/次优距离都不离谱）
 */
function predict(cells, { maxDist = 78, margin = 8 } = {}) {
  if (!Array.isArray(cells) || cells.length !== SLOTS) return { code: '', confident: false, detail: [] };
  const bank = load();
  const out = [];
  let confident = true;
  for (let i = 0; i < SLOTS; i++) {
    const cell = cells[i];
    if (!Array.isArray(cell) || cell.length !== DIM) { confident = false; out.push({ slot: i, char: '', dist: null }); continue; }
    const scored = [];
    for (const s of bank[i]) scored.push({ char: s.answer, dist: hamming(cell, s.f), id: s.id });
    if (!scored.length) { confident = false; out.push({ slot: i, char: '', dist: null }); continue; }
    scored.sort((a, b) => a.dist - b.dist);
    const best = scored[0];
    const other = scored.find((s) => s.char !== best.char);
    // 只有一个候选字符时（库里还没见过别的字符）要求距离足够近才敢下结论，
    // 否则宁可交给外部 OCR，也别拿错答案去撞风控。
    const ok = best.dist <= maxDist && (other ? other.dist - best.dist >= margin : best.dist <= 42);
    if (!ok) confident = false;
    if (best.dist <= maxDist) bumpHit.run(best.id);
    out.push({ slot: i, char: best.char, dist: best.dist, runnerUp: other ? other.dist : null, ok });
  }
  return { code: out.map((o) => o.char || '?').join(''), confident, detail: out };
}

function stats() {
  const rows = countRow.all();
  const bySlot = Array.from({ length: SLOTS }, () => ({}));
  let total = 0;
  for (const r of rows) { bySlot[r.slot][r.answer] = r.n; total += r.n; }
  return { total, samples: Math.floor(total / SLOTS), bySlot };
}

function clear() {
  db.exec('DELETE FROM captcha_glyphs');
  cache = null;
}

module.exports = { SLOTS, CELL_W, CELL_H, DIM, learn, predict, stats, clear };