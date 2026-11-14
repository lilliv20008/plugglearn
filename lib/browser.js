'use strict';
/**
 * 无头 Edge + CDP 驱动（零依赖）。
 *
 * Node 22+ 自带全局 WebSocket，所以不用 puppeteer 也能直接说 CDP 协议：
 *   启动 msedge --headless=new --remote-debugging-port=P
 *   GET  /json/version        → webSocketDebuggerUrl
 *   WS   Target.createTarget  → 新标签页
 *   WS   Target.attachToTarget{flatten:true} → sessionId，之后所有命令带 sessionId
 *
 * 每个账号一个独立的 user-data-dir，登录态（Cookie）落在磁盘上，能长期复用。
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 启动超时：2C2G 的小机器上 Edge 冷启动要十几秒，默认给到 45s */
const LAUNCH_TIMEOUT_MS = Math.max(5000, Number(process.env.BROWSER_TIMEOUT_MS || 45000));

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
];

function findBrowser() {
  // 显式指定优先（服务器上 SYSTEM 会话里 Edge 起不来时，指向 Chrome for Testing）
  const custom = process.env.BROWSER_PATH;
  if (custom) {
    try { if (fs.existsSync(custom)) return custom; } catch { /* ignore */ }
  }
  const root = path.join(__dirname, '..', 'chrome');
  for (const rel of ['chrome-win64\\chrome.exe', 'chrome.exe']) {
    try { if (fs.existsSync(path.join(root, rel))) return path.join(root, rel); } catch { /* ignore */ }
  }
  for (const p of EDGE_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  const env = process.env;
  for (const key of ['PROGRAMFILES(X86)', 'PROGRAMFILES', 'LOCALAPPDATA']) {
    const base = env[key];
    if (!base) continue;
    for (const rel of ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe']) {
      const p = path.join(base, rel);
      try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message}${msg.error.data ? ' / ' + msg.error.data : ''}`)) : resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const cb of this.handlers.get(msg.method) || []) {
          try { cb(msg.params, msg.sessionId); } catch { /* ignore */ }
        }
      }
    });
  }

  static async connect(url, timeout = 15000) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP 连接超时')), timeout);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error('CDP 连接失败：' + (e.message || 'error'))); }, { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }
      }, 30000);
      try { this.ws.send(JSON.stringify(payload)); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  on(method, cb) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(cb);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

class Browser {
  constructor({ proc, cdp, port, userDataDir }) {
    this.proc = proc;
    this.cdp = cdp;
    this.port = port;
    this.userDataDir = userDataDir;
    this.sessionId = null;
    this.startedAt = Date.now();
  }

  /** 启动一个无头浏览器实例；userDataDir 传入则复用磁盘上的登录态 */
  static async launch({ userDataDir, headless = true, port, extraArgs = [] } = {}) {
    const exe = findBrowser();
    if (!exe) throw new Error('没找到 Edge / Chrome，可在 lib/browser.js 的 EDGE_CANDIDATES 里加路径');
    const dir = userDataDir || path.join(require('node:os').tmpdir(), 'plugg-browser-' + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    const p = port || 9300 + Math.floor(Math.random() * 600);
    const args = [
      headless ? '--headless=new' : '--start-maximized',
      ...extraArgs,
      `--remote-debugging-port=${p}`,
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      // 计划任务以 SYSTEM 在 session 0 里跑时，Chromium 的沙箱拿不到可执行文件权限
      // （Sandbox cannot access executable ... 0x5），必须关掉沙箱
      ...(process.env.BROWSER_SANDBOX === '1' ? [] : ['--no-sandbox']),
      '--disable-blink-features=AutomationControlled',
      '--mute-audio',
      '--window-size=1366,900',
      // 无头 UA 里带 HeadlessChrome，超星会区别对待；这里抹平
      '--user-agent=' + (process.env.BROWSER_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'),
      'about:blank',
    ];
    const proc = spawn(exe, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });

    // 把 stderr 留着：启动失败时要能把真正的原因报给用户，而不是只说「端口没响应」
    let errTail = '';
    try {
      proc.stderr.on('data', (d) => {
        errTail = (errTail + d.toString()).slice(-4000);
      });
    } catch { /* ignore */ }

    let exited = null;
    proc.on('exit', (code) => { exited = code; proc.__exited = true; });

    let info = null;
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(250);
      if (exited !== null) break;
      try {
        const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(900) });
        if (r.ok) { info = await r.json(); break; }
      } catch { /* 还没起来 */ }
    }
    if (!info) {
      const why = exited !== null
        ? `浏览器进程已退出（code ${exited}）`
        : `等了 ${Math.round(LAUNCH_TIMEOUT_MS / 1000)} 秒 CDP 端口 ${p} 没响应`;
      const detail = errTail.split('\n').map((s) => s.trim()).filter(Boolean).slice(-3).join(' | ');
      try { killTree(proc); } catch { /* ignore */ }
      throw new Error(`${why}${detail ? '：' + detail.slice(0, 300) : ''}`);
    }

    const cdp = await CDP.connect(info.webSocketDebuggerUrl);
    const br = new Browser({ proc, cdp, port: p, userDataDir: dir });
    await br.openPage();
    return br;
  }

  /** 打开并附着到一个标签页 */
  async openPage(url = 'about:blank') {
    const { targetId } = await this.cdp.send('Target.createTarget', { url });
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = sessionId;
    this.targetId = targetId;
    await this.cdp.send('Page.enable', {}, sessionId);
    await this.cdp.send('Runtime.enable', {}, sessionId);
    await this.cdp.send('Network.enable', {}, sessionId);
    return sessionId;
  }

  /** 把 Cookie 头写进浏览器（domain 内所有子域共享） */
  async setCookies(cookieHeader, domain = '.chaoxing.com') {
    const pairs = String(cookieHeader || '').split(';').map((s) => s.trim()).filter(Boolean);
    let n = 0;
    for (const pair of pairs) {
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      try {
        await this.cdp.send('Network.setCookie', {
          name, value, domain, path: '/', secure: true, httpOnly: false, sameSite: 'Lax',
        }, this.sessionId);
        n++;
      } catch { /* 单个失败不致命 */ }
    }
    return n;
  }

  async goto(url, { waitMs = 1500 } = {}) {
    await this.cdp.send('Page.navigate', { url }, this.sessionId);
    await sleep(waitMs);
  }

  /**
   * 在每个新文档（含 iframe）里先跑一段脚本。
   * 学习通的播放器每次换视频都会重新加载页面，页面里的 setInterval 会跟着没；
   * 只有 CDP 的 addScriptToEvaluateOnNewDocument 能跨导航生效。
   */
  async initScript(source) {
    if (!this.sessionId) return null;
    const r = await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source, runImmediately: true,
    }, this.sessionId);
    this.initScriptIds = this.initScriptIds || [];
    if (r && r.identifier) this.initScriptIds.push(r.identifier);
    return r && r.identifier;
  }

  async clearInitScripts() {
    for (const id of (this.initScriptIds || [])) {
      try {
        await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }, this.sessionId);
      } catch { /* ignore */ }
    }
    this.initScriptIds = [];
  }

  async eval(expression, { awaitPromise = true, timeout = 20000 } = {}) {
    const r = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    }, this.sessionId);
    if (r.exceptionDetails) {
      const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '脚本异常';
      throw new Error(msg.split('\n')[0]);
    }
    return r.result ? r.result.value : null;
  }

  async url() { return this.eval('location.href', { awaitPromise: false }); }
  async title() { return this.eval('document.title', { awaitPromise: false }); }

  async close() {
    try { await this.cdp.send('Browser.close'); } catch { /* ignore */ }
    try { this.cdp.close(); } catch { /* ignore */ }
    await sleep(300);
    killTree(this.proc);
  }

  /** 进程还在、CDP 还答得上话 */
  async isAlive() {
    if (!this.proc || this.proc.killed || this.proc.__exited) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(1200) });
      return r.ok;
    } catch {
      return false;
    }
  }
}

/** 杀掉整个进程树（Windows 上 proc.kill 只杀父进程，渲染进程会变孤儿） */
function killTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/**
 * 清掉上次崩溃/重启后残留的无头浏览器。
 * 只杀命令行里带 `dirMarker` 的那些，不会碰你自己开的 Edge。
 */
function killOrphans(dirMarker) {
  if (process.platform !== 'win32' || !dirMarker) return 0;
  const script = [
    "$m = '" + String(dirMarker).replace(/'/g, "''") + "';",
    "$p = Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' or Name='chrome.exe'\" -ErrorAction SilentlyContinue |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine -like ('*' + $m + '*') };",
    "foreach ($x in $p) { try { Stop-Process -Id $x.ProcessId -Force -ErrorAction Stop } catch {} }",
    "($p | Measure-Object).Count",
  ].join(' ');
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    return parseInt(String(r.stdout || '0').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

module.exports = { Browser, findBrowser, sleep, killOrphans, killTree };