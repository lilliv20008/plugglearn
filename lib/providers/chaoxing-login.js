'use strict';
/**
 * 学习通扫码登录（服务端实现，不需要浏览器）。
 *
 * 实测流程（2026-11，Node fetch 直连 passport2.chaoxing.com 验证通过）：
 *   1) GET  /login?fid=&newversion=true&refer=http%3A%2F%2Fi.chaoxing.com
 *      → HTML 里带 <input value="32位uuid" id="uuid"> 与 enc；响应 Set-Cookie: JSESSIONID / route
 *   2) GET  /createqr?uuid=<uuid>&fid=-1            → 270x270 二维码（jpeg）
 *   3) POST /getauthstatus/v2  enc & uuid & doubleFactorLogin & forbidotherlogin
 *      → {"status":false,"type":"3","mes":"未登录"}   等待扫码
 *        {"status":false,"type":"4","nickname":"..","uid":".."}  已扫码，等手机端确认
 *        {"status":false,"type":"2","mes":"二维码已失效"}         过期，重新拿
 *        {"status":true, ...}                         登录成功，同一个 jar 里已经有会话 cookie
 *   4) 拿会话 cookie 去 i.chaoxing.com / mooc1 换出 _uid / _d / UID / vc3 / fid
 *
 * 注意：uuid 必须和“取它的那个 jar”配对，否则 /getauthstatus 会直接回 type=2 失效。
 */
const { log } = require('../db');

const PASSPORT = 'https://passport2.chaoxing.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFER = `${PASSPORT}/login?fid=&newversion=true&refer=http%3A%2F%2Fi.chaoxing.com`;
const TTL = 5 * 60 * 1000;

class Jar {
  constructor() { this.map = new Map(); }
  absorb(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const pair = raw.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) this.map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
  get(k) { return this.map.get(k); }
}

const sessions = new Map(); // uuid -> { uuid, enc, jar, at, state, nickname, cookie }

function gc() {
  const t = Date.now();
  for (const [k, v] of sessions) if (t - v.at > TTL) sessions.delete(k);
}

/** 第一步：拿二维码。返回 { uuid, image: dataURL, state } */
async function startQr() {
  gc();
  const res = await fetch(REFER, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  });
  const jar = new Jar();
  jar.absorb(res);
  const html = await res.text();

  const uuid = (html.match(/value="([0-9a-f]{32})"\s+id="uuid"/) || [])[1]
    || (html.match(/id="uuid"\s+value="([0-9a-f]{32})"/) || [])[1];
  const enc = (html.match(/value="([0-9a-f]{32})"\s+id="enc"/) || [])[1]
    || (html.match(/id="enc"\s+value="([0-9a-f]{32})"/) || [])[1];

  if (!uuid || !enc) throw new Error('没能从登录页解析出 uuid/enc，页面结构可能变了');

  const qr = await fetch(`${PASSPORT}/createqr?uuid=${uuid}&fid=-1`, {
    headers: { 'User-Agent': UA, 'Cookie': jar.header(), 'Referer': REFER },
  });
  if (!qr.ok) throw new Error(`二维码接口返回 ${qr.status}`);
  const buf = Buffer.from(await qr.arrayBuffer());
  const type = (qr.headers.get('content-type') || 'image/jpeg').split(';')[0];

  sessions.set(uuid, { uuid, enc, jar, at: Date.now(), state: 'waiting', nickname: null, cookie: null });
  log('info', '生成学习通登录二维码');
  return { uuid, image: `data:${type};base64,${buf.toString('base64')}`, state: 'waiting' };
}

/** 第二步：轮询状态。state: waiting | scanned | ok | expired | cancelled | twofactor */
async function pollQr(uuid) {
  const s = sessions.get(uuid);
  if (!s) return { state: 'expired', note: '会话不存在或已超时，请重新获取二维码' };
  if (Date.now() - s.at > TTL) { sessions.delete(uuid); return { state: 'expired', note: '二维码已超时' }; }
  if (s.state === 'ok') return { state: 'ok', cookie: s.cookie, nickname: s.nickname };

  const res = await fetch(`${PASSPORT}/getauthstatus/v2`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Referer': REFER,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Cookie': s.jar.header(),
    },
    body: new URLSearchParams({ enc: s.enc, uuid: s.uuid, doubleFactorLogin: '0', forbidotherlogin: '0' }).toString(),
  });
  s.jar.absorb(res);
  let data;
  try { data = await res.json(); } catch { return { state: 'waiting' }; }

  if (data.status) {
    if (data.containTwoFactorLogin) {
      s.state = 'twofactor';
      return { state: 'twofactor', note: '这个账号开了双因子验证，需要在手机端确认或补验证码', url: data.twoFactorLoginPCUrl };
    }
    const cookie = await finish(s);
    s.state = 'ok';
    s.cookie = cookie;
    s.nickname = data.nickname || s.nickname;
    log('success', `学习通扫码登录成功：${s.nickname || '(未知昵称)'}`);
    return { state: 'ok', cookie, nickname: s.nickname };
  }

  const type = String(data.type || '');
  if (type === '4') {
    s.state = 'scanned';
    s.nickname = data.nickname || null;
    return { state: 'scanned', nickname: s.nickname, uid: data.uid || null };
  }
  if (type === '6') { sessions.delete(uuid); return { state: 'cancelled', note: '手机上点了取消' }; }
  if (type === '2') { sessions.delete(uuid); return { state: 'expired', note: data.mes || '二维码已失效' }; }
  if (type === '7') return { state: 'error', note: data.mes || '登录失败' };
  return { state: s.state === 'scanned' ? 'scanned' : 'waiting', nickname: s.nickname, note: data.mes };
}

/** 第三步：登录成功后补一次业务请求，把 _uid/_d/UID 等 cookie 换出来 */
async function finish(s) {
  const targets = [
    'https://i.chaoxing.com/base',
    'https://mooc1.chaoxing.com/visit/interaction',
  ];
  for (const url of targets) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Cookie': s.jar.header(), 'Referer': 'https://i.chaoxing.com' },
        redirect: 'follow',
      });
      s.jar.absorb(r);
      await r.text();
    } catch (e) {
      log('warn', `换 cookie 失败 ${url}: ${e.message}`);
    }
  }
  const need = ['_uid', '_d', 'UID', 'vc3', 'fid', 'dstu'];
  const picked = need.filter((k) => s.jar.get(k)).map((k) => `${k}=${s.jar.get(k)}`);
  const full = s.jar.header();
  return picked.length >= 2 ? picked.join('; ') : full;
}

function drop(uuid) { sessions.delete(uuid); }
function list() { return [...sessions.values()].map(({ uuid, state, nickname }) => ({ uuid, state, nickname })); }

module.exports = { startQr, pollQr, drop, list, PASSPORT };