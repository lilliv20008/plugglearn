'use strict';
/**
 * 超星反爬验证（9010）自动过验证。
 *
 * 页面长这样：
 *   https://mooc1.chaoxing.com/antispiderShowVerify.ac
 *   <img src="https://mooc1.chaoxing.com/processVerifyPng.ac?t=...">（4 位字母数字，140×50）
 *   提交：GET https://mooc1.chaoxing.com/html/processVerify.ac?app=0&ucode=XXXX
 *
 * 流程：从页面里把验证码图取出来 → 二值化 + 切成 4 个字符位 → 用字形库最近邻识别
 *       （可选外部 OCR 兜底）→ 提交 → 回读页面判断是否已过。过了就把这次的图当样本存回去。
 * 识别不出来时不硬猜，登记一条「待人工输入」，由界面填 4 个字符（填一次等于给库加 4 个样本）。
 */
const bank = require('./captcha-bank');

const LOG = (level, message, meta) => {
  try { require('./db').log(level, message, meta); } catch { /* ignore */ }
};

/* ------------------------------ 页面内脚本 ------------------------------ */

// 找到验证码图并切成 4 个 16×20 的二值格子
const EXTRACT = String.raw`(() => {
  const pick = () => {
    const list = Array.from(document.images || []);
    const named = list.find((im) => /processVerifyPng|verifyPng|verify.*\.(png|jpg)|captcha/i.test(im.src || ''));
    if (named) return named;
    // 兜底：找那种「扁长条」的小图（验证码的典型尺寸），排除头像/图标
    const cands = list.filter((im) => im.naturalWidth >= 80 && im.naturalWidth <= 400
      && im.naturalHeight >= 20 && im.naturalHeight <= 140
      && im.naturalWidth / Math.max(1, im.naturalHeight) >= 1.8);
    cands.sort((a, b) => a.naturalWidth * a.naturalHeight - b.naturalWidth * b.naturalHeight);
    return cands[0] || null;
  };
  const img = pick();
  if (!img) return { ok: false, note: '页面上没找到验证码图' };
  if (!img.complete || !img.naturalWidth) return { ok: false, note: '验证码图还没加载完' };

  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  try { ctx.drawImage(img, 0, 0); } catch (e) { return { ok: false, note: '画布取图失败：' + e.message }; }
  let data;
  try { data = ctx.getImageData(0, 0, W, H).data; } catch (e) { return { ok: false, note: '读像素失败（跨域？）：' + e.message }; }

  // 灰度 + Otsu 二值化
  const gray = new Uint8Array(W * H);
  const hist = new Array(256).fill(0);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 | 0;
    gray[p] = g; hist[g]++;
  }
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = W * H - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  const ink = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) ink[p] = gray[p] < thr ? 1 : 0;

  // 去掉零星噪点：只看邻居数
  const clean = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (!ink[p]) continue;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
      n += ink[yy * W + xx];
    }
    clean[p] = n >= 3 ? 1 : 0;
  }

  // 按列投影切成 4 段（切不出来就等分）
  const colInk = new Array(W).fill(0);
  for (let x = 0; x < W; x++) { let c = 0; for (let y = 0; y < H; y++) c += clean[y * W + x]; colInk[x] = c; }
  const segs = [];
  let start = -1;
  for (let x = 0; x < W; x++) {
    if (colInk[x] > 0 && start < 0) start = x;
    if ((colInk[x] === 0 || x === W - 1) && start >= 0) { segs.push([start, x === W - 1 ? W - 1 : x - 1]); start = -1; }
  }
  const merged = [];
  for (const s of segs) {
    if (merged.length && s[0] - merged[merged.length - 1][1] <= 3) merged[merged.length - 1][1] = s[1];
    else merged.push([s[0], s[1]]);
  }
  // 位数自适应：验证码不一定是 4 位。
  // ① 优先读页面输入框的 maxlength（超星自己的位数声明）；
  // ② 没有就按列投影切出的段数（3–8）；
  // ③ 字符粘连时按「段宽 / 中位字宽」估每个粘连段里塞了几个字。
  const MIN_SLOTS = 3, MAX_SLOTS = 8;
  const force = (typeof window.__capForce === 'number' && window.__capForce >= MIN_SLOTS && window.__capForce <= MAX_SLOTS) ? window.__capForce : 0;
  const hintEl = document.querySelector('#ucode, input[name="ucode"], input[name="code"], input[maxlength]');
  let hint = 0;
  if (hintEl && typeof hintEl.maxLength === 'number' && hintEl.maxLength >= MIN_SLOTS && hintEl.maxLength <= MAX_SLOTS) hint = hintEl.maxLength;

  const work = merged.filter((s) => s[1] - s[0] >= 2);
  let x0 = 0, x1 = W - 1;
  for (let x = 0; x < W; x++) if (colInk[x] > 0) { x0 = x; break; }
  for (let x = W - 1; x >= 0; x--) if (colInk[x] > 0) { x1 = x; break; }
  const span = Math.max(6, x1 - x0 + 1);

  // 把切出来的段按宽度摊成正好 n 个格子
  const boxesFor = (n) => {
    const pivot = span / n;
    const segsUse = work.length ? work : [[x0, x1]];
    const ks = segsUse.map((g) => Math.max(1, Math.round((g[1] - g[0] + 1) / pivot)));
    let sum = ks.reduce((a, b) => a + b, 0);
    while (sum > n) { let mi = 0; for (let i = 1; i < ks.length; i++) if (ks[i] > ks[mi]) mi = i; ks[mi]--; sum--; }
    while (sum < n) {
      let mi = 0, bestW = -1;
      for (let i = 0; i < segsUse.length; i++) {
        const w = (segsUse[i][1] - segsUse[i][0] + 1) / ks[i];
        if (w > bestW) { bestW = w; mi = i; }
      }
      ks[mi]++; sum++;
    }
    const out = [];
    for (let i = 0; i < segsUse.length; i++) {
      const a = segsUse[i][0], b = segsUse[i][1], w = b - a + 1;
      for (let k = 0; k < ks[i]; k++) {
        out.push([a + Math.round((w * k) / ks[i]), a + Math.round((w * (k + 1)) / ks[i]) - 1]);
      }
    }
    return out;
  };

  let n = 0;
  if (force) n = force;
  else if (hint) n = hint;
  else if (work.length >= MIN_SLOTS && work.length <= MAX_SLOTS) {
    // 有段明显比中位宽，说明粘字了：按总宽 / 中位宽 重新估位数
    const widths = work.map((g) => g[1] - g[0] + 1).sort((a, b) => a - b);
    const med = widths[Math.floor(widths.length / 2)] || 1;
    const est = Math.round(work.reduce((a, g) => a + (g[1] - g[0] + 1), 0) / med);
    n = est > work.length && est <= MAX_SLOTS ? est : work.length;
  } else {
    n = Math.round(span / Math.max(6, H * 0.62));
  }
  if (n < MIN_SLOTS) n = MIN_SLOTS;
  if (n > MAX_SLOTS) n = MAX_SLOTS;
  const boxes = boxesFor(n);

  const CW = 16, CH = 20;
  const cells = boxes.map(([x0, x1]) => {
    const w = Math.max(1, x1 - x0 + 1);
    const out = new Array(CW * CH).fill(0);
    for (let gy = 0; gy < CH; gy++) for (let gx = 0; gx < CW; gx++) {
      const sx0 = x0 + Math.floor((gx * w) / CW);
      const sx1 = x0 + Math.max(Math.floor(((gx + 1) * w) / CW) - 1, Math.floor((gx * w) / CW));
      const sy0 = Math.floor((gy * H) / CH);
      const sy1 = Math.max(Math.floor(((gy + 1) * H) / CH) - 1, sy0);
      let hit = 0, tot = 0;
      for (let y = sy0; y <= sy1; y++) for (let x = sx0; x <= sx1; x++) {
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        tot++; hit += clean[y * W + x];
      }
      out[gy * CW + gx] = tot && hit / tot > 0.30 ? 1 : 0;
    }
    return out;
  });

  let dataUrl = '';
  try { dataUrl = img.src.startsWith('data:') ? img.src : cv.toDataURL('image/png'); } catch (e) { /* ignore */ }

  return { ok: true, w: W, h: H, count: boxes.length, hint, boxes, cells, dataUrl, src: img.src, url: location.href };
})()`;

const IS_VERIFY = /antispider|ShowVerify|verify\.chaoxing|\/captcha/i;
// 验证码位数：超星不同入口会给 3–8 位，别写死 4 位
const MIN_LEN = 3;
const MAX_LEN = 8;

const captcha = {
  IS_VERIFY,
  EXTRACT,
  bank,
  _pending: new Map(),
  _seq: 0,

  /** 页面是不是验证页 */
  isVerifyUrl(url) { return IS_VERIFY.test(String(url || '')); },

  /** 从当前页面取出验证码格子；count 可强制位数（页面 hint 不可靠时用） */
  async extract(br, count = 0) {
    await br.eval('window.__capForce = ' + (Number(count) || 0));
    const r = await br.eval(EXTRACT);
    return r || { ok: false, note: '读取验证码失败（空结果）' };
  },

  /** 提交验证码（位数不限死，3–8 位字母数字都收），然后回读页面判断是否已过 */
  async submit(br, code) {
    const clean = String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (clean.length < MIN_LEN || clean.length > MAX_LEN) {
      return { ok: false, note: '验证码是 ' + MIN_LEN + '–' + MAX_LEN + ' 位字母或数字（页面几位就输几位）' };
    }
    const url = 'https://mooc1.chaoxing.com/html/processVerify.ac?app=0&ucode=' + encodeURIComponent(clean);
    await br.goto(url, { waitMs: 2200 });
    const now = await br.url();
    if (IS_VERIFY.test(String(now))) return { ok: false, note: '验证码不对，还在验证页', url: now };
    return { ok: true, url: now };
  },

  /**
   * 自动过一遍验证：库 → 外部 OCR → 登记人工。
   * 返回 { ok, code, source, tries, needManual, pendingId, note }
   */
  async solve(br, { maxTries = 5, remote = null, accountId = null } = {}) {
    const tries = [];
    for (let i = 0; i < Math.max(1, Math.min(10, maxTries)); i++) {
      const ex = await this.extract(br);
      if (!ex.ok) {
        tries.push({ step: 'extract', note: ex.note });
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }

      let code = '';
      let source = '';
      const guess = bank.predict(ex.cells);
      if (guess.confident && guess.code.indexOf('?') === -1) { code = guess.code; source = 'bank'; }
      if (!code && remote && remote.enabled) {
        const r = await this.queryRemote(remote, ex.dataUrl);
        if (r.answer) { code = String(r.answer).toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, MAX_LEN); source = remote.name || 'remote'; }
        else tries.push({ step: 'remote', note: r.note });
      }
      if (!code) {
        const pend = this.addPending({ accountId, dataUrl: ex.dataUrl, cells: ex.cells, note: '需要人工输入验证码' });
        LOG('warn', '反爬验证码没能自动识别（已登记人工输入 #' + pend.id + '）', { accountId });
        return { ok: false, code: '', source: '', tries, needManual: true, pendingId: pend.id, note: '识别不出来，已登记人工输入' };
      }

      // 位数对不上（切格估错）：按答案位数重切一次，样本才学得进去
      let cellsForLearn = ex.cells;
      if (code.length !== (ex.cells ? ex.cells.length : 0)) {
        const re = await this.extract(br, code.length);
        if (re && re.ok && re.cells && re.cells.length === code.length) cellsForLearn = re.cells;
      }

      const sub = await this.submit(br, code);
      tries.push({ step: 'submit', code, source, ok: sub.ok, note: sub.note });
      if (sub.ok) {
        bank.learn(cellsForLearn, code, source);
        LOG('success', '自动通过超星反爬验证（' + source + ' → ' + code + '）', { accountId });
        return { ok: true, code, source, tries, note: '已通过' };
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    return { ok: false, code: '', source: '', tries, note: '试了 ' + tries.length + ' 次没过' };
  },

  /** 外部 OCR：通用 HTTP 配置（整段 JSON 粘贴即可） */
  async queryRemote(cfg, dataUrl) {
    const url = cfg.url;
    if (!url) return { answer: '', note: '没配 url' };
    const b64 = String(dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
    const headers = {};
    for (const [k, v] of Object.entries(cfg.headers || {})) headers[String(k).toLowerCase()] = String(v);
    if (!headers['content-type']) headers['content-type'] = 'application/json';
    if (headers['content-type'].indexOf('x-www-form-urlencoded') >= 0) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const fill = (o) => {
      if (typeof o === 'string') return o.replace(/\$\{image\}/g, b64);
      if (Array.isArray(o)) return o.map(fill);
      if (o && typeof o === 'object') { const n = {}; for (const [k, v] of Object.entries(o)) n[k] = fill(v); return n; }
      return o;
    };
    const bodyTmpl = cfg.data || { image: '${image}' };
    const isForm = headers['content-type'].indexOf('urlencoded') >= 0;
    let body;
    if (isForm) {
      const filled = fill(bodyTmpl) || {};
      body = Object.entries(filled).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    } else {
      body = JSON.stringify(fill(bodyTmpl));
    }
    try {
      const r = await fetch(url, {
        method: (cfg.method || 'POST').toUpperCase(),
        headers,
        body,
        signal: AbortSignal.timeout(8000),
      });
      const text = await r.text();
      let j = null;
      try { j = JSON.parse(text); } catch (e) { /* 可能是纯文本 */ }
      const dig = (o) => {
        if (!o) return '';
        if (typeof o === 'string') return o;
        if (Array.isArray(o)) { for (const v of o) { const g = dig(v); if (g) return g; } return ''; }
        for (const k of ['data', 'result', 'answer', 'code', 'text', 'pic_str', 'words', 'v']) {
          if (o[k] !== undefined) { const g = dig(o[k]); if (g) return g; }
        }
        return '';
      };
      const raw = dig(j) || (j ? '' : text.trim());
      const clean = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
      if (clean.length >= MIN_LEN && clean.length <= MAX_LEN) return { answer: clean };
      return { answer: '', note: '外部 OCR 没给出 ' + MIN_LEN + '–' + MAX_LEN + ' 位结果：' + text.slice(0, 120) };
    } catch (e) {
      return { answer: '', note: '外部 OCR 请求失败：' + e.message };
    }
  },

  /* ------------------------- 人工兜底（待输入队列） ------------------------- */

  addPending({ accountId, dataUrl, cells, note }) {
    const id = ++this._seq;
    this._pending.set(id, { id, accountId, dataUrl, cells: cells || null, note, at: Date.now() });
    if (this._pending.size > 20) {
      const oldest = [...this._pending.values()].sort((a, b) => a.at - b.at)[0];
      this._pending.delete(oldest.id);
    }
    return { id };
  },

  listPending() {
    const now = Date.now();
    const out = [];
    for (const p of this._pending.values()) {
      if (now - p.at > 30 * 60 * 1000) continue;
      out.push({ id: p.id, accountId: p.accountId, dataUrl: p.dataUrl, note: p.note, at: p.at });
    }
    return out.sort((a, b) => a.at - b.at);
  },

  dropPending(id) { return this._pending.delete(Number(id)); },

  /** 人工填的答案：提交 + 存样本（cells 是 extract 阶段就存下的） */
  async resolveManual(br, id, code) {
    const p = this._pending.get(Number(id));
    if (!p) return { ok: false, note: '这条待输入已经过期' };
    const sub = await this.submit(br, code);
    if (sub.ok) {
      if (p.cells) bank.learn(p.cells, code, 'manual');
      this._pending.delete(Number(id));
      LOG('success', '人工输入验证码通过（' + code + '），已存入字形库', { accountId: p.accountId });
      return { ok: true, url: sub.url };
    }
    return { ok: false, note: sub.note };
  },
};

module.exports = captcha;