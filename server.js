'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { db, now, get, set, getJSON, setJSON, log } = require('./lib/db');
const auth = require('./lib/auth');
const queue = require('./lib/queue');
const providers = require('./lib/providers');
const quiz = require('./lib/quiz');
const quizRemote = require('./lib/quiz-remote');
const captcha = require('./lib/captcha');
const qrLogin = require('./lib/providers/chaoxing-login');

const PORT = Number(process.env.PORT || 8710);
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ----------------------------- 基础工具 ----------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function sendJSON(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function assetVersion(p) {
  try { return String(Math.floor(fs.statSync(p).mtimeMs)); } catch { return '0'; }
}

function serveFile(res, file, { download = false } = {}) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    const ext = path.extname(file).toLowerCase();
    const head = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // 开发中的页面（html/css/js）一律不许缓存，改了立刻生效
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    };
    if (ext === '.html') {
      // 顺手把 css/js 引用加上 mtime 版本号，双保险
      let html = buf.toString('utf8');
      const dir = path.dirname(file);
      html = html.replace(/(href|src)="([^"?]+\.(?:css|js))"/g, (m, attr, rel) => {
        const abs = path.join(dir, rel);
        return `${attr}="${rel}?v=${assetVersion(abs)}"`;
      });
      buf = Buffer.from(html, 'utf8');
      head['Content-Type'] = MIME['.html'];
    }
    res.writeHead(200, head);
    res.end(buf);
  });
}

/* ----------------------------- 鉴权 ----------------------------- */

function currentUser(req) {
  return auth.userFromToken(cookies(req).pl_sid);
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) { sendJSON(res, 401, { error: '未登录' }); return null; }
  return user;
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin') { sendJSON(res, 403, { error: '需要管理员权限' }); return null; }
  return user;
}

/* ----------------------------- 序列化 ----------------------------- */

const parseJSON = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

const shapeAccount = (a) => ({
  id: a.id, label: a.label, provider: a.provider, username: a.username,
  fid: a.fid, status: a.status, status_note: a.status_note,
  has_cookie: !!a.cookie, has_password: !!a.password,
  last_check_at: a.last_check_at, created_at: a.created_at,
});

const shapePlan = (p) => ({
  id: p.id, account_id: p.account_id, name: p.name, course_filter: p.course_filter,
  speed: p.speed, concurrency: p.concurrency, window_start: p.window_start, window_end: p.window_end,
  interval_ms: p.interval_ms, enabled: !!p.enabled, created_at: p.created_at,
  account_label: p.account_label || null,
  counts: p.counts || null,
});

const shapeTask = (t) => ({
  id: t.id, plan_id: t.plan_id, account_id: t.account_id, provider: t.provider,
  course_id: t.course_id, course_name: t.course_name, unit_id: t.unit_id,
  kind: t.kind, title: t.title, status: t.status, progress: t.progress,
  attempts: t.attempts, error: t.error, started_at: t.started_at, finished_at: t.finished_at,
  next_at: t.next_at, created_at: t.created_at, account_label: t.account_label || null,
});

/* ----------------------------- 路由 ----------------------------- */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(pathname);
    if (m) return { handler: r.handler, params: m.slice(1) };
  }
  return null;
}

/* ---------- 初始化 / 会话 ---------- */

route('GET', /^\/api\/bootstrap$/, (req, res) => {
  const user = currentUser(req);
  sendJSON(res, 200, {
    setup_required: auth.setupRequired(),
    user: user ? { id: user.id, email: user.email, role: user.role } : null,
    providers: providers.list(),
    settings: {
      concurrency: Number(get('concurrency', 2)),
      max_attempts: Number(get('max_attempts', 3)),
      paused: get('paused', '0') === '1',
      client_portal_enabled: get('client_portal_enabled', '1') === '1',
      signup_enabled: get('signup_enabled', '1') === '1',
      site_name: get('site_name', '插头学堂'),
    },
    queue: queue.snapshot(),
  });
});

route('POST', /^\/api\/setup$/, async (req, res, params, body) => {
  if (!auth.setupRequired()) return sendJSON(res, 409, { error: '已完成初始化' });
  try {
    const id = auth.createUser(body.email, body.password, 'admin');
    const s = auth.issueSession(id);
    log('success', `初始化管理员 ${body.email}`);
    res.setHeader('Set-Cookie', `pl_sid=${s.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${auth.SESSION_DAYS * 86400}`);
    sendJSON(res, 201, { ok: true });
  } catch (e) {
    sendJSON(res, 400, { error: e.message });
  }
});

route('POST', /^\/api\/login$/, (req, res, params, body) => {
  const user = auth.authenticate(body.email, body.password);
  if (!user) return sendJSON(res, 401, { error: '邮箱或密码错误' });
  const s = auth.issueSession(user.id);
  res.setHeader('Set-Cookie', `pl_sid=${s.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${auth.SESSION_DAYS * 86400}`);
  sendJSON(res, 200, { ok: true, user: { id: user.id, email: user.email, role: user.role } });
});

route('POST', /^\/api\/logout$/, (req, res) => {
  auth.destroySession(cookies(req).pl_sid);
  res.setHeader('Set-Cookie', 'pl_sid=; Path=/; HttpOnly; Max-Age=0');
  sendJSON(res, 200, { ok: true });
});

route('GET', /^\/api\/me$/, (req, res) => {
  const user = currentUser(req);
  if (!user) return sendJSON(res, 401, { error: '未登录' });
  sendJSON(res, 200, { id: user.id, email: user.email, role: user.role });
});

/* ---------- 账号 ---------- */

route('GET', /^\/api\/accounts$/, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare('SELECT * FROM accounts ORDER BY id DESC').all();
  sendJSON(res, 200, rows.map(shapeAccount));
});

route('POST', /^\/api\/accounts$/, async (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  if (!body.label) return sendJSON(res, 400, { error: '请填写账号备注名' });
  const info = db.prepare(`INSERT INTO accounts(owner_id, label, provider, username, password, cookie, fid, status, created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(
    null, String(body.label).slice(0, 60), body.provider || 'chaoxing',
    body.username || null, body.password || null, body.cookie || null, body.fid || null, 'unknown', now(),
  );
  const id = Number(info.lastInsertRowid);
  log('info', `新增账号「${body.label}」`, { accountId: id });
  sendJSON(res, 201, shapeAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id)));
});

route('PATCH', /^\/api\/accounts\/(\d+)$/, async (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(params[0]);
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
  const fields = ['label', 'provider', 'username', 'password', 'cookie', 'fid', 'status'];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (body[f] !== undefined && body[f] !== '') { sets.push(`${f} = ?`); vals.push(body[f]); }
    else if (body[f] === '' && (f === 'cookie' || f === 'password')) { sets.push(`${f} = ?`); vals.push(null); }
  }
  if (!sets.length) return sendJSON(res, 200, shapeAccount(acc));
  vals.push(id);
  db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  sendJSON(res, 200, shapeAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id)));
});

route('DELETE', /^\/api\/accounts\/(\d+)$/, (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  db.prepare('DELETE FROM accounts WHERE id = ?').run(Number(params[0]));
  sendJSON(res, 200, { ok: true });
});

route('POST', /^\/api\/accounts\/(\d+)\/check$/, async (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(params[0]));
  if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
  const provider = providers.get(acc.provider);
  const result = await provider.check(acc);
  db.prepare('UPDATE accounts SET status = ?, status_note = ?, last_check_at = ? WHERE id = ?')
    .run(result.ok ? 'online' : 'offline', result.note, now(), acc.id);
  log(result.ok ? 'success' : 'warn', `检测「${acc.label}」：${result.note}`, { accountId: acc.id });
  sendJSON(res, 200, { ok: result.ok, note: result.note, account: shapeAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(acc.id)) });
});

/* ---------- 浏览器路线（路线 B：无头 Edge + CDP） ---------- */

route('POST', /^\/api\/accounts\/(\d+)\/probe$/, async (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(params[0]));
  if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
  const provider = providers.get(acc.provider);
  if (typeof provider.probe !== 'function') return sendJSON(res, 400, { error: '这个账号不是浏览器路线，没有页面探针' });
  try {
    sendJSON(res, 200, await provider.probe(acc, body && body.url));
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

/* 临时调试：在账号的浏览器页面里跑一段 JS（仅管理员） */
route('POST', /^\/api\/accounts\/(\d+)\/eval$/, async (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(params[0]));
  if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
  const provider = providers.get(acc.provider);
  try {
    const out = await provider.rawEval(acc, String((body && body.expr) || ''));
    sendJSON(res, 200, { ok: true, result: out });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

/** 临时调试口：服务器浏览器的当前画面（base64 PNG） */
route('POST', /^\/api\/accounts\/(\d+)\/shot$/, async (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(params[0]));
  if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
  const provider = providers.get(acc.provider);
  if (typeof provider.screenshot !== 'function') return sendJSON(res, 400, { error: '该提供方不支持截图' });
  try {
    const png = await provider.screenshot(acc);
    sendJSON(res, 200, { ok: true, png });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

/** 临时调试口：在服务器浏览器里发一次真实点击 */
route('POST', /^\/api\/accounts\/(\d+)\/click$/, async (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(params[0]));
  if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
  const provider = providers.get(acc.provider);
  if (typeof provider.clickAt !== 'function') return sendJSON(res, 400, { error: '该提供方不支持点击' });
  try {
    const out = await provider.clickAt(acc, Number(body && body.x), Number(body && body.y), !!(body && body.move));
    sendJSON(res, 200, { ok: true, ...out });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

route('POST', /^\/api\/accounts\/(\d+)\/browser\/close$/, async (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(params[0]));
  if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
  const provider = providers.get(acc.provider);
  const closed = typeof provider.closeSession === 'function' ? await provider.closeSession(acc.id) : false;
  sendJSON(res, 200, { ok: true, closed });
});

/* ---------- 反爬验证（9010）：自动过验证 + 人工兜底 ---------- */

const captchaRemoteSafeParse = (raw) => quizRemote.parseConfig(raw);
const accById = (id) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(id));

/** 现在有没有等着人填的验证码 */
route('GET', /^\/api\/captcha$/, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const cfg = getJSON('captcha_ocr', null);
  sendJSON(res, 200, {
    enabled: get('captcha_enabled', '1') === '1',
    max_tries: Number(get('captcha_max_tries', 5)),
    ocr_configured: !!(cfg && cfg.url),
    ocr_name: (cfg && (cfg.name || cfg.url)) || null,
    ocr: cfg ? { ...cfg, url: cfg.url, headers: cfg.headers || {}, data: cfg.data || null } : null,
    bank: captcha.bank.stats(),
    pending: captcha.listPending(),
  });
});

route('POST', /^\/api\/captcha$/, (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  if (body.enabled !== undefined) set('captcha_enabled', body.enabled ? '1' : '0');
  if (body.max_tries !== undefined) set('captcha_max_tries', String(Math.max(1, Math.min(10, Number(body.max_tries) || 5))));
  if (body.ocr !== undefined) {
    if (body.ocr === null || body.ocr === '') set('captcha_ocr', '');
    else {
      let parsed = null;
      try {
        parsed = typeof body.ocr === 'string' ? captchaRemoteSafeParse(body.ocr) : body.ocr;
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
      if (!parsed || !parsed.url) return sendJSON(res, 400, { error: 'OCR 配置里没有 url' });
      setJSON('captcha_ocr', parsed);
    }
  }
  sendJSON(res, 200, { ok: true });
});

/** 拿一张真验证码试一下 OCR 通不通（没有待输入样本时返回说明） */
route('POST', /^\/api\/captcha\/test$/, async (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  const cfg = getJSON('captcha_ocr', null);
  if (!cfg || !cfg.url) return sendJSON(res, 400, { error: '还没配 OCR 服务' });
  const pend = captcha.listPending();
  const code = String((body && body.code) || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const sample = pend.find((p) => p.dataUrl);
  if (!sample) return sendJSON(res, 200, { ok: false, note: '暂时没有待识别的验证码图，等下次触发风控时再测；先可以在实际遇到验证页时点「过验证」' });
  const r = await captcha.queryRemote(cfg, sample.dataUrl);
  const matched = code ? (r.answer === code) : null;
  sendJSON(res, 200, { ok: !!r.answer, answer: r.answer || null, expect: code || null, matched, note: r.note || null });
});

/** 让某个账号立刻尝试自动过一次验证 */
route('POST', /^\/api\/accounts\/(\d+)\/captcha$/, async (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  const acc = accById(params[0]);
  if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
  const provider = providers.get(acc.provider);
  if (typeof provider.solveCaptcha !== 'function') return sendJSON(res, 400, { error: '这个账号不是浏览器路线，没法过验证' });
  try {
    const r = await provider.solveCaptcha(acc);
    sendJSON(res, 200, r || { ok: false, note: '当前不在验证页' });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

/** 人工输入验证码：提交 + 当样本存进字形库 */
route('POST', /^\/api\/captcha\/resolve$/, async (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(body && body.id);
  const code = String((body && body.code) || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (code.length !== 4) return sendJSON(res, 400, { error: '验证码是 4 位字母或数字' });
  const pend = captcha.listPending().find((p) => p.id === id);
  if (!pend) return sendJSON(res, 404, { error: '这条待输入已经过期，等下次风控再试' });
  const acc = accById(pend.accountId);
  if (!acc) return sendJSON(res, 404, { error: '这条待输入关联的账号没了' });
  const provider = providers.get(acc.provider);
  if (typeof provider.resolveCaptcha !== 'function') return sendJSON(res, 400, { error: '账号不支持人工过验证' });
  try {
    const r = await provider.resolveCaptcha(acc, id, code);
    sendJSON(res, 200, r);
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

route('DELETE', /^\/api\/captcha\/pending\/(\d+)$/, (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  captcha.dropPending(params[0]);
  sendJSON(res, 200, { ok: true });
});

/* ---------- 学习通扫码登录（服务端出码，手机扫） ---------- */

route('POST', /^\/api\/accounts\/qr\/start$/, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const out = await qrLogin.startQr();
    sendJSON(res, 200, out);
  } catch (e) {
    log('error', '生成登录二维码失败：' + e.message);
    sendJSON(res, 500, { error: e.message });
  }
});

route('GET', /^\/api\/accounts\/qr\/([0-9a-f]{32})$/, async (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  try {
    sendJSON(res, 200, await qrLogin.pollQr(params[0]));
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

route('POST', /^\/api\/accounts\/qr\/([0-9a-f]{32})\/close$/, (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  qrLogin.drop(params[0]);
  sendJSON(res, 200, { ok: true });
});

/* ---------- 题库 ---------- */

route('GET', /^\/api\/quiz$/, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams.get('q') || '';
  const limit = Math.min(Number(url.searchParams.get('limit') || 40), 200);
  const rows = q
    ? db.prepare('SELECT * FROM quiz_bank WHERE question LIKE ? ORDER BY hits DESC, id DESC LIMIT ?').all(`%${q}%`, limit)
    : db.prepare('SELECT * FROM quiz_bank ORDER BY id DESC LIMIT ?').all(limit);
  sendJSON(res, 200, { rows, stats: quiz.stats() });
});

route('POST', /^\/api\/quiz$/, (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  try {
    const out = quiz.learn(body);
    log('info', `题库${out.updated ? '更新' : '新增'}：#${out.id}`);
    sendJSON(res, out.updated ? 200 : 201, out);
  } catch (e) {
    sendJSON(res, 400, { error: e.message });
  }
});

route('POST', /^\/api\/quiz\/import$/, (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return sendJSON(res, 400, { error: 'items 不能为空' });
  const out = quiz.importMany(items);
  log('info', `题库导入：新增 ${out.added}、更新 ${out.updated}、失败 ${out.failed}`);
  sendJSON(res, 200, out);
});

route('POST', /^\/api\/quiz\/lookup$/, async (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  const question = body.question || '';
  const hit = quiz.find(question, Number(body.threshold || 0.86));
  if (hit) return sendJSON(res, 200, { hit: true, ...hit, param: quiz.toAnswerParam(hit.type, hit.answer) });

  // 本地没有 → 问远程题库（配了才问），命中就顺手写进本地库
  const remote = await quizRemote.query({ question, options: body.options, type: body.type || 'single' });
  if (remote.ok) {
    // 远程常返回选项文字而不是字母，先换成字母再入库（存字母，下次直接可用）
    const letter = quiz.answerToParam(remote.answer, body.options) || remote.answer;
    const saved = quiz.learn({ question, options: body.options, type: body.type || 'single', answer: letter, source: remote.name || '远程题库' });
    return sendJSON(res, 200, {
      hit: true, source: 'remote', remote: remote.name, ai: !!remote.ai, score: 0,
      answer: letter, answer_text: remote.answer, type: body.type || 'single', id: saved.id,
      param: quiz.toAnswerParam(body.type || 'single', letter),
    });
  }

  const missId = quiz.miss(question, body.options, body.course);
  sendJSON(res, 200, { hit: false, miss_id: missId, remote: remote.note });
});

/* ---------- 远程题库配置 ---------- */

const maskToken = (t) => (t ? String(t).slice(0, 6) + '…' + String(t).slice(-4) : '');

route('GET', /^\/api\/quiz\/remote$/, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const cfg = quizRemote.loadConfig();
  sendJSON(res, 200, {
    ...cfg,
    token: maskToken(cfg.token),
    data: Object.fromEntries(Object.entries(cfg.data || {}).map(([k, v]) => [k, k === 'token' ? maskToken(String(v)) : v])),
  });
});

route('POST', /^\/api\/quiz\/remote$/, (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (body && body.config) {
      const cfg = quizRemote.parseConfig(body.config);
      quizRemote.saveConfig(cfg);
      return sendJSON(res, 200, { ok: true, name: cfg.name, url: cfg.url, method: cfg.method });
    }
    const cur = quizRemote.loadConfig();
    const next = { ...cur };
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    if (typeof body.timeout === 'number') next.timeout = Math.max(1000, Math.min(30000, body.timeout));
    quizRemote.saveConfig(next);
    sendJSON(res, 200, { ok: true, enabled: next.enabled });
  } catch (e) {
    sendJSON(res, 400, { error: e.message });
  }
});

route('POST', /^\/api\/quiz\/remote\/test$/, async (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  const question = body.question || '1.（单选题）马克思主义哲学研究的对象是（ ）';
  const options = body.options || ['A 自然界', 'B 人类社会', 'C 人的思维', 'D 自然、社会和思维发展的普遍规律'];
  const out = await quizRemote.query({ question, options, type: body.type || 'single' });
  sendJSON(res, out.ok ? 200 : 502, out);
});

route('DELETE', /^\/api\/quiz\/(\d+)$/, (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  db.prepare('DELETE FROM quiz_bank WHERE id = ?').run(Number(params[0]));
  quiz.invalidate();
  sendJSON(res, 200, { ok: true });
});

route('GET', /^\/api\/quiz\/misses$/, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare('SELECT * FROM quiz_misses WHERE resolved = 0 ORDER BY id DESC LIMIT 200').all();
  sendJSON(res, 200, rows);
});

route('POST', /^\/api\/quiz\/misses\/(\d+)\/resolve$/, (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  const ok = quiz.resolveMiss(Number(params[0]), body.answer, body.type || 'single');
  sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: '缺题记录不存在' });
});

/* ---------- 计划 ---------- */

function plansWithCounts() {
  const rows = db.prepare(`SELECT p.*, a.label AS account_label FROM plans p LEFT JOIN accounts a ON a.id = p.account_id ORDER BY p.id DESC`).all();
  const stats = db.prepare(`SELECT plan_id, status, COUNT(*) AS n FROM tasks GROUP BY plan_id, status`).all();
  const map = new Map();
  for (const s of stats) {
    if (!map.has(s.plan_id)) map.set(s.plan_id, {});
    map.get(s.plan_id)[s.status] = s.n;
  }
  return rows.map((p) => shapePlan({ ...p, counts: { pending: 0, running: 0, done: 0, failed: 0, ...(map.get(p.id) || {}) } }));
}

route('GET', /^\/api\/plans$/, (req, res) => {
  if (!requireAdmin(req, res)) return;
  sendJSON(res, 200, plansWithCounts());
});

route('POST', /^\/api\/plans$/, async (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  if (!body.account_id) return sendJSON(res, 400, { error: '请选择账号' });
  const info = db.prepare(`INSERT INTO plans(account_id, name, course_filter, speed, concurrency, window_start, window_end, interval_ms, enabled, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    Number(body.account_id), String(body.name || '新计划').slice(0, 60), body.course_filter || null,
    Number(body.speed || 1.5), Number(body.concurrency || 1),
    body.window_start || '00:00', body.window_end || '23:59',
    Number(body.interval_ms || 4000), body.enabled === false ? 0 : 1, now(),
  );
  const id = Number(info.lastInsertRowid);
  log('info', `创建计划「${body.name}」`, { accountId: Number(body.account_id) });
  sendJSON(res, 201, plansWithCounts().find((p) => p.id === id));
});

route('PATCH', /^\/api\/plans\/(\d+)$/, async (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(params[0]);
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!plan) return sendJSON(res, 404, { error: '计划不存在' });
  const fields = ['name', 'course_filter', 'speed', 'concurrency', 'window_start', 'window_end', 'interval_ms', 'enabled'];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (body[f] === undefined) continue;
    sets.push(`${f} = ?`);
    vals.push(f === 'enabled' ? (body[f] ? 1 : 0) : body[f]);
  }
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  sendJSON(res, 200, plansWithCounts().find((p) => p.id === id));
});

route('DELETE', /^\/api\/plans\/(\d+)$/, (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  db.prepare('DELETE FROM plans WHERE id = ?').run(Number(params[0]));
  sendJSON(res, 200, { ok: true });
});

route('POST', /^\/api\/plans\/(\d+)\/sync$/, async (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(Number(params[0]));
  if (!plan) return sendJSON(res, 404, { error: '计划不存在' });
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(plan.account_id);
  if (!acc) return sendJSON(res, 400, { error: '计划所属账号已删除' });

  const provider = providers.get(acc.provider);
  let units;
  try {
    units = await provider.listUnits(acc, plan);
  } catch (e) {
    log('error', `同步失败：${e.message}`, { accountId: acc.id });
    return sendJSON(res, 400, { error: `同步失败：${e.message}` });
  }

  const exists = new Set(db.prepare('SELECT unit_id FROM tasks WHERE plan_id = ?').all(plan.id).map((r) => r.unit_id));
  let created = 0;
  const stmt = db.prepare(`INSERT INTO tasks(plan_id, account_id, provider, course_id, course_name, unit_id, kind, title, payload, status, created_at)
    VALUES(?,?,?,?,?,?,?,?,?, 'pending', ?)`);
  for (const u of units) {
    if (exists.has(u.unit_id)) continue;
    stmt.run(plan.id, acc.id, acc.provider || 'chaoxing', u.course_id, u.course_name, u.unit_id, u.kind || 'video', u.title, JSON.stringify(u.payload || {}), now());
    created += 1;
  }
  log('info', `计划「${plan.name}」同步完成：新增 ${created} 个任务，共 ${units.length} 个单元`, { accountId: acc.id });
  sendJSON(res, 200, { ok: true, total: units.length, created });
});

route('POST', /^\/api\/plans\/(\d+)\/clear$/, (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  const info = db.prepare("DELETE FROM tasks WHERE plan_id = ? AND status IN ('pending','failed')").run(Number(params[0]));
  sendJSON(res, 200, { ok: true, removed: Number(info.changes || 0) });
});

/* ---------- 任务 ---------- */

route('GET', /^\/api\/tasks$/, (req, res, params, body, query) => {
  if (!requireAdmin(req, res)) return;
  const where = [];
  const vals = [];
  if (query.get('status')) { where.push('t.status = ?'); vals.push(query.get('status')); }
  if (query.get('account_id')) { where.push('t.account_id = ?'); vals.push(Number(query.get('account_id'))); }
  if (query.get('plan_id')) { where.push('t.plan_id = ?'); vals.push(Number(query.get('plan_id'))); }
  if (query.get('q')) { where.push('(t.title LIKE ? OR t.course_name LIKE ?)'); vals.push(`%${query.get('q')}%`, `%${query.get('q')}%`); }
  const limit = Math.min(500, Number(query.get('limit') || 200));
  const sql = `SELECT t.*, a.label AS account_label FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.id DESC LIMIT ${limit}`;
  sendJSON(res, 200, db.prepare(sql).all(...vals).map(shapeTask));
});

route('POST', /^\/api\/tasks\/(\d+)\/retry$/, (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(params[0]);
  db.prepare("UPDATE tasks SET status = 'pending', attempts = 0, error = NULL, progress = 0, next_at = NULL WHERE id = ?").run(id);
  log('info', `手动重试任务 #${id}`, { taskId: id });
  sendJSON(res, 200, { ok: true });
});

route('POST', /^\/api\/tasks\/(\d+)\/skip$/, (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(params[0]);
  db.prepare("UPDATE tasks SET status = 'skipped', finished_at = ? WHERE id = ?").run(now(), id);
  sendJSON(res, 200, { ok: true });
});

route('POST', /^\/api\/tasks\/retry-failed$/, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const info = db.prepare("UPDATE tasks SET status = 'pending', attempts = 0, error = NULL, progress = 0, next_at = NULL WHERE status = 'failed'").run();
  log('info', `批量重试失败任务 ${info.changes} 个`);
  sendJSON(res, 200, { ok: true, count: Number(info.changes || 0) });
});

route('DELETE', /^\/api\/tasks\/(\d+)$/, (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(params[0]));
  sendJSON(res, 200, { ok: true });
});

/* ---------- 记录 / 统计 ---------- */

route('GET', /^\/api\/records$/, (req, res, params, body, query) => {
  if (!requireAdmin(req, res)) return;
  const where = [];
  const vals = [];
  if (query.get('level')) { where.push('level = ?'); vals.push(query.get('level')); }
  if (query.get('account_id')) { where.push('account_id = ?'); vals.push(Number(query.get('account_id'))); }
  const limit = Math.min(1000, Number(query.get('limit') || 200));
  const sql = `SELECT r.*, a.label AS account_label FROM records r LEFT JOIN accounts a ON a.id = r.account_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC LIMIT ${limit}`;
  sendJSON(res, 200, db.prepare(sql).all(...vals));
});

route('GET', /^\/api\/stats$/, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const byStatus = {};
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM tasks GROUP BY status').all()) byStatus[r.status] = r.n;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayIso = today.toISOString();
  const todayDone = db.prepare("SELECT COUNT(*) n FROM tasks WHERE status = 'done' AND finished_at >= ?").get(todayIso).n;
  const todayFail = db.prepare("SELECT COUNT(*) n FROM records WHERE level = 'error' AND created_at >= ?").get(todayIso).n;
  const accounts = db.prepare('SELECT COUNT(*) n FROM accounts').get().n;
  const plans = db.prepare('SELECT COUNT(*) n FROM plans WHERE enabled = 1').get().n;
  const recent = db.prepare(`SELECT id, level, message, created_at, account_id FROM records ORDER BY id DESC LIMIT 8`).all();
  sendJSON(res, 200, { by_status: byStatus, today_done: todayDone, today_error: todayFail, accounts, plans, queue: queue.snapshot(), recent });
});

/* ---------- 设置 ---------- */

route('GET', /^\/api\/settings$/, (req, res) => {
  if (!requireAdmin(req, res)) return;
  sendJSON(res, 200, {
    concurrency: Number(get('concurrency', 2)),
    max_attempts: Number(get('max_attempts', 3)),
    paused: get('paused', '0') === '1',
    client_portal_enabled: get('client_portal_enabled', '1') === '1',
    signup_enabled: get('signup_enabled', '1') === '1',
    site_name: get('site_name', '插头学堂'),
  });
});

route('POST', /^\/api\/settings$/, (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  const map = {
    concurrency: (v) => String(Math.max(1, Math.min(8, Number(v) || 2))),
    max_attempts: (v) => String(Math.max(1, Math.min(10, Number(v) || 3))),
    paused: (v) => (v ? '1' : '0'),
    client_portal_enabled: (v) => (v ? '1' : '0'),
    signup_enabled: (v) => (v ? '1' : '0'),
    site_name: (v) => String(v).slice(0, 40),
  };
  for (const [k, fn] of Object.entries(map)) {
    if (body[k] !== undefined) set(k, fn(body[k]));
  }
  sendJSON(res, 200, { ok: true });
});

/* ---------- 调度控制 ---------- */

route('POST', /^\/api\/queue\/pause$/, (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  queue.setPaused(body.paused !== false);
  log('info', body.paused !== false ? '调度器已暂停' : '调度器已恢复');
  sendJSON(res, 200, queue.snapshot());
});

/* ---------- 客户前台 ---------- */

route('POST', /^\/api\/client\/signup$/, async (req, res, params, body) => {
  if (get('client_portal_enabled', '1') !== '1') return sendJSON(res, 403, { error: '客户前台未开启' });
  if (get('signup_enabled', '1') !== '1') return sendJSON(res, 403, { error: '注册已关闭' });
  try {
    const id = auth.createUser(body.email, body.password, 'client');
    const s = auth.issueSession(id);
    res.setHeader('Set-Cookie', `pl_sid=${s.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${auth.SESSION_DAYS * 86400}`);
    sendJSON(res, 201, { ok: true });
  } catch (e) {
    sendJSON(res, 400, { error: e.message });
  }
});

route('GET', /^\/api\/client\/orders$/, (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const rows = db.prepare(`SELECT o.*, a.label AS account_label,
      (SELECT COUNT(*) FROM tasks t WHERE t.account_id = o.account_id AND t.status = 'done') AS done,
      (SELECT COUNT(*) FROM tasks t WHERE t.account_id = o.account_id) AS total
    FROM orders o LEFT JOIN accounts a ON a.id = o.account_id
    WHERE o.client_id = ? ORDER BY o.id DESC`).all(user.id);
  sendJSON(res, 200, rows);
});

route('POST', /^\/api\/client\/orders$/, async (req, res, params, body) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role !== 'client') return sendJSON(res, 403, { error: '仅客户账号可下单' });
  if (!body.label || !body.cookie) return sendJSON(res, 400, { error: '请填写备注名与学习通 Cookie' });
  const accInfo = db.prepare(`INSERT INTO accounts(owner_id, label, provider, cookie, status, created_at) VALUES(?,?,?,?,?,?)`)
    .run(user.id, String(body.label).slice(0, 60), 'chaoxing', body.cookie, 'unknown', now());
  const accountId = Number(accInfo.lastInsertRowid);
  const planInfo = db.prepare(`INSERT INTO plans(account_id, name, speed, concurrency, interval_ms, enabled, created_at)
    VALUES(?,?,?,?,?,0,?)`).run(accountId, `${body.label} 的刷课计划`, Number(body.speed || 1.5), 1, 5000, now());
  const orderInfo = db.prepare(`INSERT INTO orders(client_id, account_id, plan_id, title, status, price_cents, note, created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(user.id, accountId, Number(planInfo.lastInsertRowid), String(body.title || '学习通刷课'), 'pending', Number(body.price_cents || 0), body.note || null, now());
  log('info', `客户下单：#${orderInfo.lastInsertRowid} ${body.label}`, { accountId });
  sendJSON(res, 201, { ok: true, order_id: Number(orderInfo.lastInsertRowid) });
});

route('GET', /^\/api\/orders$/, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare(`SELECT o.*, u.email AS client_email, a.label AS account_label, a.status AS account_status
    FROM orders o LEFT JOIN users u ON u.id = o.client_id LEFT JOIN accounts a ON a.id = o.account_id
    ORDER BY o.id DESC`).all();
  sendJSON(res, 200, rows);
});

route('PATCH', /^\/api\/orders\/(\d+)$/, async (req, res, params, body) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(params[0]);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return sendJSON(res, 404, { error: '订单不存在' });
  const status = String(body.status || order.status);
  db.prepare('UPDATE orders SET status = ?, price_cents = ? WHERE id = ?')
    .run(status, body.price_cents !== undefined ? Number(body.price_cents) : order.price_cents, id);
  if (status === 'active' && order.plan_id) {
    db.prepare('UPDATE plans SET enabled = 1 WHERE id = ?').run(order.plan_id);
    log('info', `订单 #${id} 已受理，计划已启用`);
  }
  if (status === 'closed' && order.plan_id) {
    db.prepare('UPDATE plans SET enabled = 0 WHERE id = ?').run(order.plan_id);
  }
  sendJSON(res, 200, { ok: true });
});

/* ----------------------------- 静态与启动 ----------------------------- */

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith('/api/')) {
    const hit = match(req.method, pathname);
    if (!hit) return sendJSON(res, 404, { error: '接口不存在' });
    try {
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      await hit.handler(req, res, hit.params, body, parsed.searchParams);
    } catch (e) {
      console.error('[api]', pathname, e);
      if (!res.headersSent) sendJSON(res, 500, { error: e.message || '服务器错误' });
    }
    return;
  }

  if (pathname === '/' || pathname === '/index.html') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  if (pathname === '/app' || pathname === '/app/') return serveFile(res, path.join(PUBLIC_DIR, 'app.html'));
  if (pathname === '/favicon.ico') return serveFile(res, path.join(PUBLIC_DIR, 'favicon.svg'));

  const target = path.join(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('403'); }
  serveFile(res, target);
});

server.listen(PORT, '0.0.0.0', () => {
  queue.start();
  log('info', `服务启动 http://127.0.0.1:${PORT}`);
  console.log(`plugglearn listening on http://127.0.0.1:${PORT}`);
});