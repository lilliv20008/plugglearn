'use strict';
/**
 * 题库：本地 SQLite 存题 + 归一化匹配 + 缺题记录。
 * 设计目标：和 OCS 那类浏览器脚本用同一套“题干 → 答案”判定，但跑在服务端，
 * 可以被调度器/答题器直接调用，不需要开浏览器。
 */
const { db, now, log } = require('./db');

/* ------------------------------ 建表 ------------------------------ */

try {
  db.exec(`CREATE TABLE IF NOT EXISTS quiz_bank(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    qkey TEXT UNIQUE NOT NULL,
    question TEXT NOT NULL,
    type TEXT DEFAULT 'single',
    options TEXT,
    answer TEXT NOT NULL,
    source TEXT DEFAULT 'manual',
    hits INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS quiz_misses(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    options TEXT,
    course TEXT,
    answer TEXT,
    at TEXT,
    resolved INTEGER DEFAULT 0
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_quiz_qkey ON quiz_bank(qkey)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_miss_at ON quiz_misses(at)');
} catch (e) {
  log('error', '题库建表失败：' + e.message);
}

/* --------------------------- 文本归一化 --------------------------- */

const PUNCT = /[\s\u3000,，.。;；:：!！?？、"'“”‘’()（）\[\]【】<>《》\-—_~`|\\/·…]/g;

/** 全角转半角 + 去空白标点 + 小写；题干匹配只看“字” */
function normalize(s) {
  if (!s) return '';
  let out = '';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else if (code === 0x3000) out += ' ';
    else out += ch;
  }
  return out.replace(PUNCT, '').toLowerCase();
}

/** 二元组 Dice 系数，0~1；用于“题干基本一样但标点/空格不同”的模糊命中 */
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) || 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = bigrams.get(g) || 0;
    if (n > 0) { hit++; bigrams.set(g, n - 1); }
  }
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

const key = (q) => normalize(q).slice(0, 180);

/* ---------------------------- 读写接口 ---------------------------- */

let cache = null;
let cacheAt = 0;
const CACHE_MS = 30_000;

function all() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  cache = db.prepare('SELECT * FROM quiz_bank').all().map((r) => ({
    ...r,
    _k: r.qkey,
    _n: r.qkey, // qkey 已经是归一化结果的前 180 字
  }));
  cacheAt = Date.now();
  return cache;
}

function invalidate() { cache = null; cacheAt = 0; }

/**
 * 查题：先精确（归一化后全等），再模糊（Dice ≥ threshold）。
 * @returns {{answer:string, type:string, score:number, id:number}|null}
 */
function find(question, threshold = 0.86) {
  const n = key(question);
  if (!n) return null;
  const rows = all();
  const exact = rows.find((r) => r._k === n);
  if (exact) {
    db.prepare('UPDATE quiz_bank SET hits = hits + 1 WHERE id = ?').run(exact.id);
    return { id: exact.id, answer: exact.answer, type: exact.type, score: 1 };
  }
  let best = null;
  let bestScore = 0;
  for (const r of rows) {
    // 长度差太大直接跳过，省 CPU
    if (Math.abs(r._k.length - n.length) > Math.max(12, n.length * 0.45)) continue;
    const s = dice(r._k, n);
    if (s > bestScore) { bestScore = s; best = r; }
  }
  if (best && bestScore >= threshold) {
    db.prepare('UPDATE quiz_bank SET hits = hits + 1 WHERE id = ?').run(best.id);
    return { id: best.id, answer: best.answer, type: best.type, score: Number(bestScore.toFixed(3)) };
  }
  return null;
}

/** 入库/覆盖一题 */
function learn({ question, options = [], answer, type = 'single', source = 'manual' }) {
  if (!question || answer === undefined || answer === null) throw new Error('题目和答案都不能为空');
  const k = key(question);
  const optJson = Array.isArray(options) ? JSON.stringify(options) : (options || null);
  const exist = db.prepare('SELECT id FROM quiz_bank WHERE qkey = ?').get(k);
  if (exist) {
    db.prepare('UPDATE quiz_bank SET question=?, type=?, options=?, answer=?, source=?, updated_at=? WHERE id=?')
      .run(question, type, optJson, String(answer), source, now(), exist.id);
    invalidate();
    return { id: exist.id, updated: true };
  }
  const info = db.prepare(`INSERT INTO quiz_bank(qkey, question, type, options, answer, source, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(k, question, type, optJson, String(answer), source, now(), now());
  invalidate();
  return { id: Number(info.lastInsertRowid), updated: false };
}

function importMany(items) {
  let added = 0;
  let updated = 0;
  let failed = 0;
  const tx = db.prepare('SELECT 1');
  for (const it of items) {
    try {
      const r = learn(it);
      r.updated ? updated++ : added++;
    } catch { failed++; }
  }
  return { added, updated, failed, total: items.length };
}

function miss(question, options, course) {
  const n = key(question);
  const dup = db.prepare('SELECT id FROM quiz_misses WHERE question = ? AND resolved = 0').get(n);
  if (dup) return dup.id;
  const info = db.prepare('INSERT INTO quiz_misses(question, options, course, at, resolved) VALUES(?,?,?,?,0)')
    .run(n, Array.isArray(options) ? JSON.stringify(options) : (options || null), course || null, now());
  return Number(info.lastInsertRowid);
}

function resolveMiss(id, answer, type = 'single') {
  const row = db.prepare('SELECT * FROM quiz_misses WHERE id = ?').get(id);
  if (!row) return null;
  learn({ question: row.question, options: row.options ? JSON.parse(row.options) : [], answer, type, source: 'miss' });
  db.prepare('UPDATE quiz_misses SET resolved = 1, answer = ? WHERE id = ?').run(String(answer), id);
  return true;
}

function stats() {
  const total = db.prepare('SELECT COUNT(*) n FROM quiz_bank').get().n;
  const byType = db.prepare('SELECT type, COUNT(*) n FROM quiz_bank GROUP BY type').all();
  const hits = db.prepare('SELECT COALESCE(SUM(hits),0) n FROM quiz_bank').get().n;
  const openMiss = db.prepare('SELECT COUNT(*) n FROM quiz_misses WHERE resolved = 0').get().n;
  return { total, hits, byType, openMiss };
}

/**
 * 把库里的答案转成提交格式。
 * 超星：单选 "A"；多选 "A,B"（部分版本接受 "AB"，按抓包为准）；判断 "true"/"false"；填空/简答直接给文本。
 */
function toAnswerParam(type, answer) {
  const a = String(answer || '').trim();
  if (type === 'multi') {
    const letters = a.toUpperCase().replace(/[^A-Z]/g, '').split('');
    return Array.from(new Set(letters)).sort().join(',');
  }
  if (type === 'judge') {
    // 有选项字母（A 正确 / B 错误）时直接给字母，点选项更稳；否则退回 true/false
    if (/^[A-H]$/i.test(a)) return a.toUpperCase();
    const truthy = /^(true|对|正确|√|T|Y|1)$/i.test(a);
    return truthy ? 'true' : 'false';
  }
  return a;
}


/**
 * 把「答案」变成选项字母。
 * 第三方题库常返回选项内容而不是 A/B/C，多选还可能用 # 拼起来（言溪就是这样）：
 *   "社会存在决定社会意识#人民群众是历史创造者" → "A,B"
 * 先认字母 → 再按文本精确/包含匹配 → 最后 Dice ≥ 0.6 模糊兜底。
 */
function mapOneToLetter(raw, opts) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  if (/^[A-H](?:[\s,，、;；]*[A-H])*$/i.test(text)) {
    const letters = text.toUpperCase().replace(/[^A-H]/g, '').split('');
    return [...new Set(letters)].sort().join(',');
  }

  const items = opts.map((t, i) => {
    const m = t.match(/^([A-H])[\s.、．)）]/);
    const letter = m ? m[1] : String.fromCharCode(65 + i);
    const body = m ? t.slice(m[0].length) : t;
    return { letter, body: normalize(body), whole: normalize(t) };
  });

  const target = normalize(text);
  let contains = null;
  for (const it of items) {
    if (it.body && it.body === target) return it.letter;
    if (it.body && target && (it.body.includes(target) || (it.body.length >= 4 && target.includes(it.body)))) {
      if (!contains || it.body.length > contains.len) contains = { letter: it.letter, len: it.body.length };
    }
  }
  if (contains) return contains.letter;

  let fuzzy = null;
  for (const it of items) {
    const sc = Math.max(dice(target, it.body), dice(target, it.whole));
    if (!fuzzy || sc > fuzzy.score) fuzzy = { letter: it.letter, score: sc };
  }
  return fuzzy && fuzzy.score >= 0.6 ? fuzzy.letter : null;
}

function answerToParam(answer, options) {
  const raw = String(answer || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const arr = Array.isArray(options) ? options : String(options || '').split(/\n+/);
  const opts = arr.map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!opts.length) return null;

  const parts = raw.split(/[#；;\n]+/).map((t) => t.trim()).filter(Boolean);
  if (parts.length > 1) {
    const letters = parts.map((t) => mapOneToLetter(t, opts)).filter(Boolean);
    return letters.length ? [...new Set(letters)].sort().join(',') : null;
  }
  return mapOneToLetter(raw, opts);
}

module.exports = { normalize, dice, answerToParam, find, learn, importMany, miss, resolveMiss, stats, toAnswerParam, invalidate };