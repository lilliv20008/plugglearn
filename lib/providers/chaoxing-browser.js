'use strict';
/**
 * 学习通「浏览器路线」提供方（路线 B）：无头 Edge 打开真实页面，
 * 播放交给 <video>，答题走 DOM：题库命中 → 点选项 → 点提交。
 *
 * 和 chaoxing.js（纯 HTTP）的区别：
 *   - 鉴权、enc 签名、随机题都由页面自己算，我们只做「读页面 + 点按钮」，最不容易被改版打死；
 *   - 代价是每个并发账号一个浏览器进程。
 *
 * 章节发现走的是「新版课程门户」（mooc2）：
 *   课程卡 → mooc-ans/visit/stucoursemiddle → mooc2-ans/mycourse/stu
 *   → iframe mooc2-ans/mycourse/studentcourse（章节树在这里）
 *   → 每个 .chapter_item[id^=cur] 的 onclick=toOld('cid','knowledgeId','clazzid',0)
 * 学习页是 mooc1/mycourse/studentstudy?chapterId&courseId&clazzid&cpi&enc&mooc2=1，
 * 视频在第三层 iframe：mooc-ans/knowledge/cards → ananas/modules/video/index.html。
 *
 * 数据库里账号 provider 填 chaoxing-browser 即走这里。
 */
const path = require('node:path');
const fs = require('node:fs');
const { Browser, sleep, killOrphans } = require('../browser');
const quiz = require('../quiz');
const quizRemote = require('../quiz-remote');
const { log } = require('../db');

const ROOT = path.join(__dirname, '..', '..');
const SESSIONS = new Map(); // accountId -> { browser, at }
let swept = false;
const IDLE_MS = 3 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function cookiesFrom(account) {
  return String(account.cookie || '');
}

/** 复用一个账号的浏览器；没有就拉起一个，Cookie 灌进去 */
async function session(account) {
  const id = account.id || 0;
  const cur = SESSIONS.get(id);
  if (cur && Date.now() - cur.at < IDLE_MS && await cur.browser.isAlive()) {
    cur.at = Date.now();
    return cur.browser;
  }
  if (cur) { try { await cur.browser.close(); } catch { /* ignore */ } SESSIONS.delete(id); }

  const dir = path.join(ROOT, 'data', 'browsers', String(id));
  fs.mkdirSync(dir, { recursive: true });

  // 第一次拉浏览器前，扫掉上次崩溃留下的孤儿进程（只认我们这个目录）
  if (!swept) {
    swept = true;
    const n = killOrphans(path.join('data', 'browsers'));
    if (n) log('warn', `清理了 ${n} 个残留的无头浏览器进程`);
  }

  let browser;
  try {
    browser = await Browser.launch({ userDataDir: dir });
  } catch (e) {
    throw new Error(e.message);
  }
  if (cookiesFrom(account)) await browser.setCookies(cookiesFrom(account));
  SESSIONS.set(id, { browser, at: Date.now() });
  log('info', `为「${account.label || account.id}」启动无头浏览器（端口 ${browser.port}）`);
  return browser;
}

async function closeSession(accountId) {
  const cur = SESSIONS.get(accountId);
  if (!cur) return false;
  SESSIONS.delete(accountId);
  try { await cur.browser.close(); } catch { /* ignore */ }
  return true;
}

/* ------------------------------ 页面探针 ------------------------------ */

/** 在页面里跑：把主文档和最多 3 层同源 iframe 全扫一遍 */
const WALK = `const walk = (doc, d, out) => {
  if (!doc || d > 3 || out.length > 9) return;
  out.push(doc);
  let frames = [];
  try { frames = [...doc.querySelectorAll('iframe')]; } catch (e) {}
  for (const f of frames) {
    let cd = null;
    try { cd = f.contentDocument; } catch (e) {}
    if (cd) walk(cd, d + 1, out);
  }
};`;

const PROBE = `(() => {
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  ${WALK}
  const docs = [];
  walk(document, 0, docs);
  const R = { url: location.href, title: document.title, video: null, quiz: null, roots: docs.length, done: false };

  let best = null;
  for (const d of docs) {
    for (const v of d.querySelectorAll('video')) {
      if (!best || (v.duration || 0) > (best.duration || 0)) best = v;
    }
  }
  if (best) {
    const dur = Number.isFinite(best.duration) ? best.duration : 0;
    const cur = Number.isFinite(best.currentTime) ? best.currentTime : 0;
    R.video = {
      t: Math.round(cur * 10) / 10,
      d: Math.round(dur * 10) / 10,
      paused: !!best.paused, ended: !!best.ended,
      rate: best.playbackRate || 1,
      hasDur: dur > 0,
      // 调试：看倍速有没有被站点自己的 setter 吃掉
      rateOwn: !!Object.getOwnPropertyDescriptor(best, 'playbackRate'),
      dpr: Number.isFinite(best.defaultPlaybackRate) ? best.defaultPlaybackRate : -1,
      real: (() => {
        try {
          const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
          return d && d.get ? Math.round(d.get.call(best) * 100) / 100 : -1;
        } catch (e) { return -1; }
      })(),
    };
  }

  const QSEL = ['.ans-videoquiz', '.videoquiz', '#videoquiz', '.TiMu', '.questionLi', '.ans-videoquiz-wrap', '.mark_item'];
  const OPT = 'li, .ans-videoquiz-opt, .option, label';
  for (const d of docs) {
    let box = null;
    for (const s of QSEL) {
      const el = d.querySelector(s);
      if (el && clean(el.innerText).length > 4) { box = el; break; }
    }
    if (!box) continue;
    const text = clean(box.innerText).slice(0, 600);
    const opts = [...box.querySelectorAll(OPT)].map((x) => clean(x.innerText)).filter((t) => t && t.length < 160);
    R.quiz = { text, options: [...new Set(opts)].slice(0, 8), answered: /已作答|正确答案|答案：/.test(text) };
    break;
  }

  const bodyAll = docs.map((d) => clean(d.body && d.body.innerText).slice(0, 400)).join(' ');
  R.done = /任务点已完成|已完成任务点|章节已完成/.test(bodyAll);
  R.body = bodyAll.slice(0, 300);
  // 播放器会自动接着播下一节，页面 URL 不变但正文的章节目录会高亮到新的一节；
  // 把它抓出来，避免把下一节的进度记到当前任务上
  const head = clean((document.body && document.body.innerText) || '');
  const m = head.match(/章节详情\\s*(\\S{1,40})/);
  R.chapter = m ? m[1] : '';
  return R;
})()`;

/** 点选项 + 提交。letter 为 'A' / 'B,C' 之类 */
function clickAnswer(letter) {
  return `(() => {
    const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    ${WALK}
    const docs = [];
    walk(document, 0, docs);
    const QSEL = ['.ans-videoquiz', '.videoquiz', '#videoquiz', '.TiMu', '.questionLi', '.ans-videoquiz-wrap', '.mark_item'];
    let box = null;
    for (const d of docs) {
      for (const s of QSEL) {
        const el = d.querySelector(s);
        if (el && clean(el.innerText).length > 4) { box = el; break; }
      }
      if (box) break;
    }
    if (!box) return { ok: false, note: '页面上没找到题目容器' };
    const letters = ${JSON.stringify(letter)}.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const cands = [...box.querySelectorAll('li, .ans-videoquiz-opt, .option, label')];
    const picked = [];
    for (const L of letters) {
      const hit = cands.find((x) => {
        const t = clean(x.innerText).toUpperCase();
        const v = clean(x.getAttribute && x.getAttribute('data')) || '';
        return t.startsWith(L) || t.startsWith(L + '.') || t.startsWith(L + ' ') || t === L || v === L;
      });
      if (hit) { hit.click(); hit.dispatchEvent(new MouseEvent('click', { bubbles: true })); picked.push(L); }
    }
    if (!picked.length) return { ok: false, note: '没找到选项 ' + letters.join(',') };
    const btn = [...box.querySelectorAll('button, a, input[type=button], .ans-videoquiz-submit')]
      .find((b) => /提交|确定|保存|下一题/.test(clean(b.innerText || b.value || '')));
    if (btn) { btn.click(); return { ok: true, picked, submitted: true }; }
    return { ok: true, picked, submitted: false, note: '点了选项但没找到提交按钮' };
  })()`;
}

/** 找到（可能藏在多层 iframe 里的）video，静音、设倍速、开播 */
/** 学习通的 ananas 播放器会自己把 playbackRate 改回 1：给每个 video 装一个只认目标倍速的 setter，再用定时器兜底 */
const INSTALL_RATE = (rate) => `(() => {
  const RATE = ${Number(rate) || 1};
  ${WALK}
  const docs = [];
  walk(document, 0, docs);
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
  const lock = (v) => {
    if (!v || v.__plLock || !desc) return;
    try {
      Object.defineProperty(v, 'playbackRate', {
        configurable: true,
        get() { return desc.get.call(this); },
        set() { desc.set.call(this, RATE); },
      });
      v.__plLock = true;
      desc.set.call(v, RATE);
    } catch (e) {}
  };
  const bump = () => {
    const ds = [];
    walk(document, 0, ds); // 每次重新遍历：播放器是后加载进 iframe 的
    for (const d of ds) {
      for (const v of d.querySelectorAll('video')) {
        lock(v);
        if (desc && Math.abs(desc.get.call(v) - RATE) > 0.05) { try { desc.set.call(v, RATE); } catch (e) {} }
        if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      }
    }
  };
  if (window.__plRate) clearInterval(window.__plRate);
  window.__plRate = setInterval(bump, 700);
  bump();
  return { installed: true, rate: RATE, videos: docs.reduce((n, d) => n + d.querySelectorAll('video').length, 0) };
})()`;

/** 注入到每个新文档：把倍速钉死。
 *  学习通播放器会往 <video> 实例上塞 playbackRate 属性并不断写回 1，
 *  所以先删实例属性，再直接走原型上的真 setter；页面每换一次视频都会重载，
 *  靠 CDP 的 addScriptToEvaluateOnNewDocument 才能一直生效。 */
const RATE_GUARD = (rate) => `(() => {
  const R = ${Number(rate) || 1};
  if (R <= 1) return;
  const dd = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
  const seen = new WeakSet();
  const read = (v) => { try { return dd && dd.get ? dd.get.call(v) : v.playbackRate; } catch (e) { return 1; } };
  const bump = () => {
    let list = [];
    try { list = document.querySelectorAll('video'); } catch (e) { return; }
    for (const v of list) {
      if (Math.abs(read(v) - R) < 0.05) continue;
      // 只在第一次见到这个元素时删掉站点塞的 playbackRate，之后只走原型 setter，
      // 免得每秒 delete/define 一次被反爬盯上
      if (!seen.has(v)) { try { delete v.playbackRate; } catch (e) {} seen.add(v); }
      try { if (dd && dd.set) dd.set.call(v, R); } catch (e) {}
      if (v.paused) { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
    }
  };
  bump();
  try { setInterval(bump, 1500); } catch (e) {}
  try { document.addEventListener('DOMContentLoaded', bump, { once: true }); } catch (e) {}
  window.addEventListener('load', bump, { once: true });
})()`;

const PLAY = (rate) => `(() => {
  ${WALK}
  const docs = [];
  walk(document, 0, docs);
  let v = null;
  for (const d of docs) {
    for (const x of d.querySelectorAll('video')) { if (!v || (x.duration || 0) > (v.duration || 0)) v = x; }
  }
  if (!v) return null;
  v.muted = true;
  const R = ${Number(rate) || 1};
  const d0 = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
  // 超星会往 <video> 实例上塞一个 playbackRate 属性把倍速钉在 1x：
  // 先删掉它，再走原型上的真 setter，最后才回落普通赋值
  let del = 'skip';
  try { del = String(delete v.playbackRate); } catch (e) { del = 'err'; }
  try { if (d0 && d0.set) d0.set.call(v, R); } catch (e) {}
  try { v.playbackRate = R; } catch (e) {}
  try { v.defaultPlaybackRate = R; } catch (e) {}
  let real = v.playbackRate;
  try { if (d0 && d0.get) real = d0.get.call(v); } catch (e) {}
  if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
  return {
    t: Math.round(v.currentTime * 10) / 10,
    d: Math.round((v.duration || 0) * 10) / 10,
    paused: v.paused, rate: v.playbackRate, real: Math.round(real * 100) / 100,
    own: !!Object.getOwnPropertyDescriptor(v, 'playbackRate'), del,
  };
})()`;

/* ------------------------------ 课程 / 章节 ------------------------------ */

async function fetchCourses(account) {
  const res = await fetch('https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1', {
    headers: { 'User-Agent': UA, 'Cookie': cookiesFrom(account), 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`课程列表 HTTP ${res.status}`);
  const data = await res.json();
  const out = [];
  for (const ch of (data.channelList || [])) {
    const content = ch.content || {};
    for (const c of ((content.course && content.course.data) || [])) {
      out.push({
        course_id: String(c.id || ''),
        course_name: String(c.name || '未命名课程'),
        clazz_id: String(content.id || c.clazzid || ''),
      });
    }
  }
  return out.filter((c) => c.course_id && c.clazz_id);
}

/** 章节树在 mooc2 的 studentcourse iframe 里；顺带从 toOld() 源码里挖 enc / cpi */
const HARVEST = `(() => {
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const src = String(window.toOld || '');
  const enc = (src.match(/var enc = "([0-9a-fA-F]+)"/) || [])[1] || '';
  const cpi = (src.match(/var cpi = (\\d+)/) || [])[1] || '';
  const items = [];
  for (const n of document.querySelectorAll('div.chapter_item[id^="cur"]')) {
    const oc = n.getAttribute('onclick') || '';
    const m = oc.match(/toOld\\(\\s*'([^']*)'\\s*,\\s*'([^']*)'\\s*,\\s*'([^']*)'/);
    const kid = m ? m[2] : n.id.replace(/^cur/, '');
    if (!kid) continue;
    items.push({
      kid,
      cid: m ? m[1] : '',
      clz: m ? m[3] : '',
      title: clean(n.getAttribute('title') || n.querySelector('.catalog_name') && n.querySelector('.catalog_name').innerText || ''),
      // 章节列表里 icon_yiwanc = 已完成（悬浮提示「已完成」）
      done: !!n.querySelector('.catalog_state.icon_yiwanc'),
    });
  }
  return { enc, cpi, items };
})()`;

/** 从课程卡进到章节树 iframe，取 { enc, cpi, items } */
async function harvestCourse(br, course) {
  const mid = `https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=${encodeURIComponent(course.course_id)}`
    + `&clazzid=${encodeURIComponent(course.clazz_id)}&vc=1&ismooc2=1&v=2`;
  await br.goto(mid, { waitMs: 3200 });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const frame = await br.eval(`(() => {
      const list = [...document.querySelectorAll('iframe')].map((f) => f.src || '');
      return list.find((s) => /\\/mycourse\\/studentcourse/.test(s)) || '';
    })()`).catch(() => '');

    if (frame) {
      await br.goto(frame, { waitMs: 3500 });
      const got = await br.eval(HARVEST).catch(() => null);
      if (got && got.items && got.items.length) return got;
    }
    await sleep(1600);
  }
  return null;
}

module.exports = {
  id: 'chaoxing-browser',
  label: '学习通（浏览器路线）',

  async check(account) {
    try {
      const br = await session(account);
      await br.goto('https://mooc1.chaoxing.com/visit/interaction', { waitMs: 2200 });
      const url = await br.url();
      const title = await br.title();
      if (/passport2\.chaoxing\.com|login/i.test(url)) {
        await closeSession(account.id);
        return { ok: false, note: 'Cookie 失效，页面跳到了登录页' };
      }
      const courses = await fetchCourses(account);
      return { ok: true, note: `浏览器已就绪 · ${title.slice(0, 20) || '学习通'} · ${courses.length} 门课程` };
    } catch (e) {
      await closeSession(account.id).catch(() => {});
      return { ok: false, note: `浏览器检测失败：${e.message}` };
    }
  },

  async listUnits(account, plan) {
    const courses = await fetchCourses(account);
    const filter = String(plan.course_filter || '').trim();
    const picked = filter ? courses.filter((c) => c.course_name.includes(filter)) : courses;
    if (!picked.length) throw new Error('没有读到课程（账号未选课或 Cookie 失效）');

    const br = await session(account);
    const units = [];
    const notes = [];

    for (const c of picked) {
      let got = null;
      try { got = await harvestCourse(br, c); } catch (e) { notes.push(`${c.course_name}: ${e.message}`); }
      if (!got) { notes.push(`${c.course_name}: 章节树没打开`); continue; }

      const seen = new Set();
      let count = 0;
      for (const it of got.items) {
        if (!it.kid || seen.has(it.kid)) continue;
        seen.add(it.kid);
        count += 1;
        units.push({
          course_id: c.course_id,
          course_name: c.course_name,
          unit_id: it.kid,
          kind: 'chapter',
          title: it.title || `章节 ${it.kid}`,
          payload: {
            course_id: c.course_id,
            clazz_id: c.clazz_id,
            cpi: got.cpi,
            enc: got.enc,
            done: !!it.done,
          },
        });
      }
      log('info', `「${c.course_name}」解析到 ${count} 个章节`, { accountId: account.id });
      await sleep(700 + Math.random() * 700);
    }

    if (!units.length) {
      throw new Error('没有解析到章节（课程可能没开或页面结构变了）' + (notes.length ? '：' + notes.slice(0, 2).join('；') : ''));
    }
    return units;
  },

  async runUnit(account, plan, task, onProgress = () => {}) {
    const payload = task.payload || {};
    const courseId = payload.course_id || task.course_id;
    const clazzId = payload.clazz_id || '';
    if (!courseId || !task.unit_id) throw new Error('任务缺少 courseId / chapterId');
    // 同步时就已经是「已完成」的章节，直接跳过，不重复消耗时间
    if (payload.done) {
      onProgress(100, '同步时就已完成，跳过');
      return { ok: true, message: '已学完（同步时即为已完成状态），跳过' };
    }

    const rate = Math.min(4, Math.max(1, Number(plan.speed) || 1));
    const tick = Math.max(800, Math.min(6000, Number(plan.interval_ms) || 1500));
    const br = await session(account);

    const url = 'https://mooc1.chaoxing.com/mycourse/studentstudy'
      + `?chapterId=${encodeURIComponent(task.unit_id)}`
      + `&courseId=${encodeURIComponent(courseId)}`
      + `&clazzid=${encodeURIComponent(clazzId)}`
      + `&cpi=${encodeURIComponent(payload.cpi || '')}`
      + `&enc=${encodeURIComponent(payload.enc || '')}`
      + '&mooc2=1&hidetype=0&fanyaVersion=0';
    await br.goto(url, { waitMs: 3200 });
    // 页面会不断重载，倍速必须挂在 CDP 的文档级注入上，否则每次重载都回到 1x
    await br.initScript(RATE_GUARD(rate)).catch(() => {});
    await br.eval(INSTALL_RATE(rate)).catch(() => {});

    const started = Date.now();
    let answered = 0;
    let misses = 0;
    let lastD = 0;
    let idleTicks = 0;
    let stallTicks = 0;
    let lastPct = -1;
    let lastT = -1;
    let bestT = 0;
    let wraps = 0;
    let rateTick = 0;

    for (;;) {
      if (Date.now() - started > 60 * 60 * 1000) throw new Error('单章节超过 60 分钟，已放弃（页面可能卡住）');

      let st = null;
      try { st = await br.eval(PROBE); } catch (e) { throw new Error('读取页面失败：' + e.message); }
      if (!st) throw new Error('读取页面失败：空结果');
      if (/passport2\.chaoxing\.com|请登录/.test(st.url)) throw new Error('Cookie 失效，页面跳到了登录页');
      // 超星风控：出现滑块/点选验证页时一切都停了，必须人工过一次
      if (/antispider|ShowVerify|verify\.chaoxing|\/captcha/i.test(st.url)) {
        throw new Error('超星要求人工验证（反爬验证页），需要本人过一次再继续');
      }

      // 0) 整章任务点已完成 → 不重复刷
      if (st.done && !st.quiz) {
        onProgress(100, '任务点已完成，跳过');
        break;
      }

      // 0.5) 播放器自动跳到下一节了 → 本节按完成处理，别再记到当前任务上
      if (st.chapter && task.title && !st.chapter.includes(task.title) && !String(task.title).includes(st.chapter) && bestT > 5) {
        log('info', `页面已切到《${st.chapter}》，本节按完成处理`, { accountId: account.id });
        onProgress(100, '已切到下一节');
        break;
      }

      // 1) 有题 → 查库（本地 + 远程）→ 点
      if (st.quiz && !st.quiz.answered) {
        const qText = st.quiz.text;
        const hit = quiz.find(qText);
        if (hit) {
          const param = quiz.toAnswerParam(hit.type, hit.answer);
          const r = await br.eval(clickAnswer(param));
          if (r && r.ok) {
            answered += 1;
            log('info', `答题（${hit.score >= 1 ? '精确' : '模糊 ' + hit.score}）→ ${param}`, { accountId: account.id });
          } else {
            log('warn', `答题没点中：${(r && r.note) || '未知原因'}`, { accountId: account.id });
          }
        } else {
          const remote = await quizRemote.query({ question: qText, options: st.quiz.options, type: 'single' });
          if (remote.ok) {
            const letter = quiz.answerToParam(remote.answer, st.quiz.options) || remote.answer;
            quiz.learn({ question: qText, options: st.quiz.options, type: 'single', answer: letter, source: remote.name || '远程题库' });
            const param = quiz.toAnswerParam('single', letter);
            const r = await br.eval(clickAnswer(param));
            answered += 1;
            log('info', `远程题库（${remote.name}）答 ${param}${r && r.ok ? '，已点' : '，但没点中'}`, { accountId: account.id });
          } else {
            misses += 1;
            const missId = quiz.miss(qText, st.quiz.options, task.course_name || '');
            log('warn', `本地/远程题库都没答案（缺题 #${missId}）：${remote.note || ''}｜${qText.slice(0, 40)}…`, { accountId: account.id });
          }
        }
        await sleep(900);
        continue;
      }

      // 2) 有视频 → 播放
      if (st.video) {
        const v = st.video;
        if (v.d > 0) lastD = v.d;
        if (v.t > bestT) bestT = v.t;
        // 学习通的播放器在视频尾部（常见于最后有个总结/弹题段）会自动从头重播，
        // 进度突然归零。已经播过大半就按完成处理，否则会在这里无限循环。
        if (lastT > 30 && v.t < lastT - 90) {
          wraps += 1;
          const enough = bestT >= (v.d > 0 ? v.d * 0.85 : 300);
          log('info', `视频回到起点（第 ${wraps} 次）：已播到 ${Math.round(bestT)}s${enough ? '，按完成处理' : '，接着重播'}`, { accountId: account.id });
          if (enough) {
            onProgress(100, '视频已播完（播放器循环）');
            break;
          }
          stallTicks = 0;
          idleTicks = 0;
          lastT = v.t;
          lastPct = -1;
          await br.eval(PLAY(rate)).catch(() => {});
          await sleep(tick);
          continue;
        }
        // 兜底：单节超 25 分钟且已播过半数，不再耗时间
        if (Date.now() - started > 25 * 60 * 1000 && bestT >= (v.d > 0 ? v.d * 0.5 : 180)) {
          log('warn', `单章节跑了 25 分钟只到 ${Math.round(bestT)}s，先按完成记录`, { accountId: account.id });
          break;
        }
        // 学习通的视频是分片流，duration 经常是 null/NaN，不能拿它当完成判据
        const finished = v.ended || (v.d > 0 && v.t >= v.d - 1.2);
        if (finished) {
          if (idleTicks++ > 3) break;
        } else {
          idleTicks = 0;
          // 播放器偶尔会把 playbackRate 重置回 1，发现就再设一次
          if (v.paused || v.t === lastT || (v.rate && Math.abs(v.rate - rate) > 0.05)) {
            const pr = await br.eval(PLAY(rate)).catch(() => null);
            if (pr && rateTick % 6 === 0 && Math.abs((pr.real ?? pr.rate) - rate) > 0.05) {
              log('warn', `倍速设不上去（表面 ${pr.rate}x / 实际 ${pr.real}x，目标 ${rate}x，own=${pr.own} del=${pr.del}）`, { accountId: account.id });
            }
          }
          // 页面跳转 / 换 <video> 元素会把定时器一起弄丢，定期重装一次
          if (rateTick++ % 6 === 0) await br.eval(INSTALL_RATE(rate)).catch(() => {});
          if (v.t === lastT) stallTicks += 1; else stallTicks = 0;
          lastT = v.t;
          if (stallTicks > 20) {
            if (v.d > 0) throw new Error('视频不前进（可能被防拖拽 / 需要真人验证）');
            break; // 时长未知又推不动：这一节没有可推进的任务点了
          }
        }
        const pct = v.d > 0
          ? Math.min(99, Math.round((v.t / v.d) * 100))
          : Math.min(95, 15 + Math.floor(v.t / 120) * 5);
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress(pct, `视频 ${Math.round(v.t)}${v.d > 0 ? '/' + Math.round(v.d) : ''}s · ${v.rate}x${answered ? ' · 已答 ' + answered : ''}`);
        }
        await sleep(tick);
        continue;
      }

      // 3) 没视频：可能全是文档/测验任务点，或已完成
      if (st.done) break;
      // 页面根本没加载出学习内容（空白/被踢回门户）→ 报错，别当成「已完成」糊过去
      if (idleTicks === 0 && st.roots <= 2) {
        throw new Error('学习页没加载出来（可能被风控或网络异常）：' + String(st.url).slice(0, 80));
      }
      idleTicks += 1;
      if (idleTicks > 6) break;
      onProgress(Math.min(95, 40 + idleTicks * 6), '页面没有视频任务点，等待中');
      await sleep(1500);
    }

    onProgress(100, '章节完成');
    await sleep(500);
    return {
      ok: true,
      message: `完成（视频 ${Math.round(lastD)}s，答题 ${answered} 次${misses ? `，缺题 ${misses} 道` : ''}）`,
    };
  },

  async probe(account, url) {
    const br = await session(account);
    if (url) await br.goto(url, { waitMs: 3200 });
    const st = await br.eval(PROBE);
    return { ...st, port: br.port };
  },

  async rawEval(account, expr) {
    const br = await session(account);
    return br.eval(expr);
  },

  closeSession,
  listSessions: () => [...SESSIONS.keys()],
};