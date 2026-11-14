'use strict';
/**
 * 远程题库（第三方题库接口）。
 *
 * 支持直接粘贴 OCS / 网课助手那套题库配置 JSON，例如：
 *   [{"name":"言溪题库","url":"https://tk.enncy.cn/query","method":"post","type":"GM_xmlhttpRequest",
 *     "contentType":"json","headers":{"Content-Type":"application/json"},
 *     "data":{"token":"...","title":"${title}","options":"${options}","type":"${type}"},
 *     "handler":"return (res)=>..."}]
 *
 * 我们只取 url / method / headers / data 模板，把 ${title} ${options} ${type} 换成真实值，
 * 按 JSON 发出去，再从响应里挖答案（兼容 code===0 → data.answer 与直接 data 两种形状）。
 */
const { get, set } = require('./db');

const KEY = 'quiz_remote';
const PLACEHOLDER = /\$\{(title|options|type|images|suggestion_title|suggestion_options)\}/g;

function emptyConfig() {
  return { enabled: false, name: '', url: '', method: 'POST', headers: {}, data: {}, timeout: 8000, token: '' };
}

function loadConfig() {
  try { return { ...emptyConfig(), ...JSON.parse(get(KEY, '{}')) }; } catch { return emptyConfig(); }
}

function saveConfig(cfg) { set(KEY, JSON.stringify(cfg || emptyConfig())); }

/** 把用户粘贴的那段配置，解析成我们内部的结构 */
function parseConfig(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('配置是空的');
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error('不是合法的 JSON：' + e.message); }
  const item = Array.isArray(obj) ? obj.find((x) => x && x.url) : obj;
  if (!item || !item.url) throw new Error('没找到 url 字段');
  const headers = item.headers && typeof item.headers === 'object' ? item.headers : {};
  const data = item.data && typeof item.data === 'object' ? item.data : {};
  // images 那段是 OCS 的函数钩子，我们不需要，去掉免得发函数过去
  for (const k of Object.keys(data)) {
    if (data[k] && typeof data[k] === 'object' && data[k].handler) delete data[k];
  }
  return {
    enabled: true,
    name: String(item.name || '远程题库'),
    url: String(item.url),
    method: String(item.method || 'POST').toUpperCase(),
    headers,
    data,
    timeout: 8000,
    token: String(data.token || ''),
  };
}

const TYPE_MAP = {
  single: 'single', multi: 'multiple', multiple: 'multiple',
  judge: 'judge', blank: 'completion', completion: 'completion', short: 'short',
};

function optionsToText(options) {
  const arr = Array.isArray(options)
    ? options
    : String(options || '').split(/\n+/);
  return arr
    .map((s) => String(s).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((s) => s.replace(/^([A-H])\s*[.、．)）]?\s*/, '$1.'))
    .join('\n');
}

function fillTemplate(value, vars) {
  if (typeof value === 'string') return value.replace(PLACEHOLDER, (m, k) => (vars[k] == null ? '' : String(vars[k])));
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = fillTemplate(v, vars);
    return out;
  }
  return value;
}

/**
 * 从各种返回形状里挖出答案。
 * 言溪这类题库：{"code":1,"data":{"question","answer","times","ai":true},"message":"请求成功"}
 *   code 0 = 题库命中；code 1 = AI 兜底（data.ai=true）——两种都是有效答案，不能当失败。
 */
function digAnswer(json) {
  if (!json || typeof json !== 'object') return null;
  const d = json.data && typeof json.data === 'object' ? json.data : json;
  const cand = d.answer ?? d.result ?? d.ans ?? json.answer;
  if (cand == null) return null;
  const answer = Array.isArray(cand) ? cand.join(',') : String(cand).trim();
  if (!answer) return null;
  return {
    answer,
    ai: !!d.ai,
    tags: d.tags || json.tags || null,
    times: d.times || null,
    message: json.message || json.msg || '',
  };
}

async function query({ question, options, type = 'single' } = {}) {
  const cfg = loadConfig();
  if (!cfg.enabled || !cfg.url) return { ok: false, note: '没有配置远程题库' };
  const vars = {
    title: question,
    options: optionsToText(options),
    type: TYPE_MAP[type] || type || 'single',
  };
  const body = fillTemplate(cfg.data && Object.keys(cfg.data).length ? cfg.data : { token: cfg.token, title: '${title}', options: '${options}', type: '${type}' }, vars);
  // 头部一律小写归一，避免用户粘的 "content-type" 和我们补的 "Content-Type" 撞成两个值
  const headers = {};
  for (const [k, v] of Object.entries(cfg.headers || {})) {
    if (v == null) continue;
    headers[String(k).toLowerCase()] = String(v);
  }
  let url = cfg.url;
  let payload;

  if (cfg.method === 'GET') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (v != null && typeof v !== 'object') qs.set(k, String(v));
    url += (url.includes('?') ? '&' : '?') + qs.toString();
  } else {
    const isJson = /application\/json/i.test(headers['content-type'] || '') || headers['content-type'] === undefined;
    if (isJson) {
      headers['content-type'] = headers['content-type'] || 'application/json';
      payload = JSON.stringify(body);
    } else {
      payload = new URLSearchParams(Object.entries(body).filter(([, v]) => typeof v !== 'object').map(([k, v]) => [k, String(v)])).toString();
      headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';
    }
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeout || 8000);
  try {
    const res = await fetch(url, { method: cfg.method, headers, body: payload, signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!json) return { ok: false, note: `题库返回不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}` };
    const found = digAnswer(json);
    if (!found) {
      const msg = json.message || json.msg || (json.data && json.data.message) || `code ${json.code}`;
      return { ok: false, note: `题库没给答案：${msg}`, raw: json };
    }
    return { ok: true, answer: found.answer, ai: found.ai, times: found.times, name: cfg.name, tags: found.tags, raw: json };
  } catch (e) {
    return { ok: false, note: e.name === 'AbortError' ? '题库超时' : `题库请求失败：${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { loadConfig, saveConfig, parseConfig, query, emptyConfig };