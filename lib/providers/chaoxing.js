'use strict';
/**
 * 学习通（超星）提供方。
 *
 * 说明：所有请求都带上账号里导入的 Cookie（登录后从浏览器复制）。
 * 平台本身不做账号密码登录（超星登录有滑块/验证码，脚本化极易触发风控），
 * 因此首次使用请用「导入 Cookie」的方式接入，Cookie 失效时状态会变成「已失效」。
 *
 * 主要接口（公开可得，若超星改版请按 docs/chaoxing-api.md 调整常量）：
 *   课程列表  https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1
 *   课程章节  https://mooc1.chaoxing.com/mycourse/studentcourse?courseId=&clazzid=&ut=s
 *   章节详情  https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=&courseId=&clazzid=&enc=
 *   进度上报  https://mooc1.chaoxing.com/multimedia/log/a/{clazzid}/{objectid}?...
 */
const https = require('https');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(url, { method = 'GET', cookie = '', contentType = null, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error(`URL 非法: ${url}`)); }
    const headers = {
      'User-Agent': UA,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://mooc1.chaoxing.com/',
    };
    if (cookie) headers.Cookie = cookie;
    if (contentType) headers['Content-Type'] = contentType;
    if (body) headers['Content-Length'] = Buffer.byteLength(body);

    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, location: res.headers.location || null });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时 ${timeout}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function looksLikeLogin(html) {
  return /passport2\.chaoxing\.com|请登录|用户登录|login\.chaoxing/i.test(html) && html.length < 20000;
}

function parseCourses(payload) {
  const out = [];
  const list = (payload && payload.channelList) || [];
  for (const ch of list) {
    const content = ch.content || {};
    const course = (content.course && content.course.data) || [];
    for (const c of course) {
      out.push({
        course_id: String(c.id || content.courseid || ''),
        course_name: String(c.name || '未命名课程'),
        clazz_id: String(content.id || c.clazzid || ''),
        teacher: String(c.teacherfactor || ''),
      });
    }
  }
  return out.filter((c) => c.course_id && c.clazz_id);
}

function parseChapters(html, course) {
  const out = [];
  const seen = new Set();
  const re = /studentstudy\?chapterId=([^&"']+)[^"']*?[^>]*>\s*([^<]{2,80})</g;
  let m;
  while ((m = re.exec(html))) {
    const chapterId = decodeURIComponent(m[1]);
    const title = m[2].replace(/&nbsp;/g, ' ').trim();
    if (!chapterId || seen.has(chapterId)) continue;
    seen.add(chapterId);
    out.push({
      course_id: course.course_id,
      course_name: course.course_name,
      unit_id: chapterId,
      kind: 'chapter',
      title: title || `章节 ${chapterId}`,
      payload: { clazz_id: course.clazz_id, course_id: course.course_id },
    });
  }
  return out;
}

function parseAttachments(html) {
  const items = [];
  const re = /"objectid"\s*:\s*"?(\d+)"?[^}]*?"jobid"\s*:\s*"?([\w-]+)"?[^}]*?"type"\s*:\s*"?(\w+)"?/g;
  let m;
  while ((m = re.exec(html))) items.push({ objectId: m[1], jobId: m[2], type: m[3] });
  if (!items.length) {
    const re2 = /objectid["\s:]+(\d+)[\s\S]{0,200}?jobid["\s:]+([\w-]+)/g;
    while ((m = re2.exec(html))) items.push({ objectId: m[1], jobId: m[2], type: 'video' });
  }
  const seen = new Set();
  return items.filter((i) => (seen.has(i.objectId) ? false : (seen.add(i.objectId), true)));
}

module.exports = {
  id: 'chaoxing',
  label: '学习通（超星）',

  async check(account) {
    if (!account.cookie) return { ok: false, note: '未导入 Cookie' };
    try {
      const res = await request('https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1', { cookie: account.cookie });
      if (res.status === 302 && /passport2/.test(res.location || '')) return { ok: false, note: 'Cookie 已失效，请重新导入' };
      if (res.status !== 200) return { ok: false, note: `接口返回 HTTP ${res.status}` };
      let data;
      try { data = JSON.parse(res.text); } catch { return { ok: false, note: looksLikeLogin(res.text) ? 'Cookie 已失效' : '返回内容不是 JSON，可能被风控拦截' }; }
      const courses = parseCourses(data);
      if (!courses.length) return { ok: false, note: 'Cookie 可用，但没有读到课程（账号未选课？）' };
      return { ok: true, note: `有效 · ${courses.length} 门课程` };
    } catch (e) {
      return { ok: false, note: `检测失败：${e.message}` };
    }
  },

  async listUnits(account, plan) {
    const res = await request('https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1', { cookie: account.cookie });
    if (res.status !== 200) throw new Error(`课程列表 HTTP ${res.status}`);
    const courses = parseCourses(JSON.parse(res.text));
    const filter = String(plan.course_filter || '').trim();
    const picked = filter ? courses.filter((c) => c.course_name.includes(filter)) : courses;
    const units = [];
    for (const course of picked) {
      const url = `https://mooc1.chaoxing.com/mycourse/studentcourse?courseId=${encodeURIComponent(course.course_id)}&clazzid=${encodeURIComponent(course.clazz_id)}&ut=s`;
      const page = await request(url, { cookie: account.cookie });
      if (page.status !== 200 || looksLikeLogin(page.text)) throw new Error(`读取《${course.course_name}》章节失败`);
      units.push(...parseChapters(page.text, course));
      await sleep(600 + Math.random() * 900);
    }
    if (!units.length) throw new Error('没有解析到章节，可能是课程结构改版或 Cookie 权限不足');
    return units;
  },

  async runUnit(account, plan, task, onProgress) {
    const payload = task.payload || {};
    const courseId = payload.course_id || task.course_id;
    const clazzId = payload.clazz_id;
    if (!courseId || !clazzId) throw new Error('任务缺少 courseId / clazzId');

    const detailUrl = `https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=${encodeURIComponent(task.unit_id)}&courseId=${encodeURIComponent(courseId)}&clazzid=${encodeURIComponent(clazzId)}&enc=&openc=null`;
    const detail = await request(detailUrl, { cookie: account.cookie });
    if (detail.status !== 200) throw new Error(`章节详情 HTTP ${detail.status}`);
    const attachments = parseAttachments(detail.text);
    if (!attachments.length) {
      onProgress(100, '未发现任务点，按已完成处理');
      return { ok: true, message: '该章节没有可识别的任务点' };
    }

    const speed = Math.min(4, Math.max(1, Number(plan.speed) || 1));
    const step = Math.max(500, Math.min(15000, Number(plan.interval_ms) || 4000));
    const results = [];

    for (let idx = 0; idx < attachments.length; idx += 1) {
      const att = attachments[idx];
      const duration = Number(att.duration) || 600;
      let played = 0;
      let passed = false;
      while (played < duration) {
        played = Math.min(duration, played + Math.max(15, Math.round((step / 1000) * speed)));
        const qs = new URLSearchParams({
          authorid: String(payload.authorid || ''),
          dtype: att.type === 'video' ? 'Video' : 'Document',
          objectId: att.objectId,
          jobid: att.jobId,
          userid: String(payload.userid || ''),
          isdrag: '3',
          view: 'json',
          playingTime: String(played),
          duration: String(duration),
          clipTime: `0_${played}`,
          rt: '0.9',
          courseId: String(courseId),
          clazzId: String(clazzId),
        });
        const res = await request(`https://mooc1.chaoxing.com/multimedia/log/a/${encodeURIComponent(clazzId)}/${encodeURIComponent(att.objectId)}?${qs}`, {
          cookie: account.cookie,
        });
        let json = null;
        try { json = JSON.parse(res.text); } catch { /* 非 JSON 视为失败 */ }
        if (json && (json.isPassed === true || json.status === true)) passed = true;
        const pct = Math.round(((idx + played / duration) / attachments.length) * 100);
        onProgress(pct, `任务点 ${idx + 1}/${attachments.length} · ${played}/${duration}s`);
        if (played < duration) await sleep(step);
        if (passed && res.status !== 200) break;
      }
      results.push({ objectId: att.objectId, passed });
      if (!passed) throw new Error(`任务点 ${att.objectId} 未通过（可能被风控，建议降低并发、放慢间隔）`);
      await sleep(800 + Math.random() * 1200);
    }
    return { ok: true, message: `完成 ${results.length} 个任务点` };
  },
};