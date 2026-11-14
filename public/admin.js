'use strict';

/* ------------------------------ 基础 ------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  boot: null,
  accounts: [],
  plans: [],
  tasks: [],
  records: [],
  orders: [],
  stats: null,
  taskFilter: '',
  recordFilter: '',
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

function toast(message, isError = false) {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast show${isError ? ' err' : ''}`;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; t.hidden = true; }, 2600);
}

function modal(html) {
  const wrap = $('#modal');
  $('#modalBody').innerHTML = html;
  wrap.hidden = false;
  wrap.onclick = (e) => { if (e.target === wrap) closeModal(); };
  return $('#modalBody');
}
function closeModal() { qrStop(); $('#modal').hidden = true; $('#modalBody').innerHTML = ''; }

const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtDur = (a, b) => {
  if (!a || !b) return '—';
  const s = Math.round((new Date(b) - new Date(a)) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

const STATUS = {
  pending: ['待执行', 'dim'],
  running: ['执行中', 'info'],
  done: ['已完成', 'ok'],
  failed: ['失败', 'err'],
  skipped: ['已跳过', 'dim'],
};

const statusPill = (s) => {
  const [label, cls] = STATUS[s] || [s, 'dim'];
  return `<span class="pill ${cls}">${label}</span>`;
};

const ACC_STATUS = {
  online: ['在线', 'ok'],
  offline: ['失效', 'err'],
  unknown: ['未检测', 'dim'],
  disabled: ['已停用', 'dim'],
};

/* ------------------------------ 登录 ------------------------------ */

async function boot() {
  state.boot = await api('/api/bootstrap');
  if (state.boot.setup_required) return showGate('setup');
  if (!state.boot.user) return showGate('login');
  return showShell();
}

function showGate(mode) {
  $('#shell').hidden = true;
  $('#gate').hidden = false;
  const setup = mode === 'setup';
  $('#gateTitle').textContent = setup ? '初始化工作台' : '登录工作台';
  $('#gateHint').textContent = setup
    ? '第一次使用：创建管理员账号，之后用这个邮箱登录。'
    : '用管理员账号进入，管理账号、计划、任务与记录。';
  $('#gateSubmit').textContent = setup ? '创建并进入' : '登录';
  $('#gateForm').dataset.mode = mode;
  $('#gateEmail').focus();
}

$('#gateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#gateError');
  err.hidden = true;
  const mode = $('#gateForm').dataset.mode;
  const payload = { email: $('#gateEmail').value.trim(), password: $('#gatePass').value };
  try {
    await api(mode === 'setup' ? '/api/setup' : '/api/login', { method: 'POST', body: payload });
    await boot();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

function showShell() {
  $('#gate').hidden = true;
  $('#shell').hidden = false;
  $('#who').textContent = state.boot.user.email;
  renderQueue(state.boot.queue);
  route();
}

$('#logoutBtn').onclick = async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
};

$('#pauseBtn').onclick = async () => {
  const paused = !(state.boot.queue && state.boot.queue.paused);
  const snap = await api('/api/queue/pause', { method: 'POST', body: { paused } });
  state.boot.queue = snap;
  renderQueue(snap);
  toast(paused ? '调度器已暂停' : '调度器已恢复');
};

function renderQueue(q) {
  const pill = $('#queuePill');
  const dot = $('.dot', pill);
  const text = $('#queueText');
  if (!q) return;
  dot.className = 'dot' + (q.paused ? '' : q.running > 0 ? ' busy' : ' on');
  text.textContent = q.paused ? '调度器已暂停' : q.running > 0 ? `执行中 ${q.running} / 并发 ${q.concurrency}` : '调度器空闲';
  $('#pauseBtn').textContent = q.paused ? '恢复调度' : '暂停调度';
}

/* ------------------------------ 路由 ------------------------------ */

const ROUTES = {
  overview: renderOverview,
  accounts: renderAccounts,
  plans: renderPlans,
  tasks: renderTasks,
  records: renderRecords,
  orders: renderOrders,
  settings: renderSettings,
};

function route() {
  const key = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
  const view = ROUTES[key] || renderOverview;
  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.route === key));
  view().catch((e) => { $('#main').innerHTML = `<div class="empty"><div class="empty-title">加载失败</div>${esc(e.message)}</div>`; });
}

window.addEventListener('hashchange', () => { if (!$('#shell').hidden) route(); });

/* ------------------------------ 概览 ------------------------------ */

async function renderOverview() {
  const [stats, plans, records] = await Promise.all([
    api('/api/stats'),
    api('/api/plans'),
    api('/api/records?limit=10'),
  ]);
  state.stats = stats;
  renderQueue(stats.queue);

  const s = stats.by_status || {};
  const cards = [
    ['待执行', s.pending || 0, '排队中的任务点', ''],
    ['执行中', s.running || 0, `全局并发 ${stats.queue.concurrency}`, ''],
    ['今日完成', stats.today_done, '按任务点统计', 'accent'],
    ['失败', s.failed || 0, `今日错误 ${stats.today_error}`, ''],
  ];

  const activePlans = plans.filter((p) => p.enabled);
  $('#main').innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">概览</h1>
        <p class="page-sub">账号 ${stats.accounts} 个 · 启用计划 ${stats.plans} 个 · 调度器${stats.queue.paused ? '已暂停' : '运行中'}</p>
      </div>
      <div class="page-actions">
        <button class="btn" data-action="goto" data-href="#/plans">管理计划</button>
        <button class="btn primary" data-action="goto" data-href="#/accounts">添加账号</button>
      </div>
    </div>
    <div class="grid k4">
      ${cards.map(([label, value, foot, cls]) => `
        <div class="card stat ${cls}">
          <div class="stat-label">${label}</div>
          <div class="stat-value">${value}</div>
          <div class="stat-foot">${foot}</div>
        </div>`).join('')}
    </div>

    <div class="grid k2" style="margin-top:14px">
      <div class="card">
        <div class="card pad" style="display:flex;justify-content:space-between;align-items:center;padding-bottom:12px">
          <div><div style="font-weight:620">正在跑的计划</div><div class="small muted">启用后按窗口与并发自动消费任务</div></div>
          <button class="btn tiny" data-action="goto" data-href="#/plans">全部</button>
        </div>
        ${activePlans.length ? `<div class="table-wrap"><table>
          <thead><tr><th>计划</th><th>账号</th><th class="num">待执行</th><th class="num">完成</th><th class="num">失败</th></tr></thead>
          <tbody>${activePlans.map((p) => `<tr>
            <td data-label="计划">${esc(p.name)}<div class="small muted">${esc(p.course_filter || '全部课程')} · ${p.speed}x</div></td>
            <td data-label="账号">${esc(p.account_label || '—')}</td>
            <td class="num" data-label="待执行">${p.counts.pending}</td>
            <td class="num" data-label="完成">${p.counts.done}</td>
            <td class="num" data-label="失败">${p.counts.failed}</td>
          </tr>`).join('')}</tbody></table></div>` : `<div class="empty"><div class="empty-title">还没有启用的计划</div>先添加账号，再为它建一个计划</div>`}
      </div>

      <div class="card">
        <div class="card pad" style="display:flex;justify-content:space-between;align-items:center;padding-bottom:12px">
          <div><div style="font-weight:620">最新动态</div><div class="small muted">调度器与账号的实时记录</div></div>
          <button class="btn tiny" data-action="goto" data-href="#/records">全部</button>
        </div>
        ${records.length ? `<div class="timeline">${records.map((r) => `
          <div class="tl-item">
            <div class="tl-time">${fmtTime(r.created_at)}</div>
            <div>${levelPill(r.level)}</div>
            <div class="tl-msg">${esc(r.message)}</div>
          </div>`).join('')}</div>` : `<div class="empty"><div class="empty-title">暂无记录</div>任务开始执行后这里会出现实时日志</div>`}
      </div>
    </div>

    <div class="card pad" style="margin-top:14px">
      <div style="font-weight:620;margin-bottom:6px">三步开始</div>
      <div class="small muted">
        1. <b>账号</b>：添加学习通账号，粘贴浏览器里的 Cookie，点「检测」确认在线。<br>
        2. <b>计划</b>：为账号建计划（倍速、并发、时段），点「同步任务」把章节拉进来。<br>
        3. <b>任务</b>：调度器按窗口自动跑，进度与错误都在「任务」「记录」里。
      </div>
    </div>`;
}

function levelPill(level) {
  const map = { success: ['ok', '完成'], error: ['err', '错误'], warn: ['warn', '警告'], info: ['info', '信息'], debug: ['dim', '调试'] };
  const [cls, label] = map[level] || ['dim', level];
  return `<span class="pill ${cls}">${label}</span>`;
}

/* ------------------------------ 账号 ------------------------------ */

async function renderAccounts() {
  state.accounts = await api('/api/accounts');
  const rows = state.accounts;
  $('#main').innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">账号</h1><p class="page-sub">学习通账号以 Cookie 方式接入，失效时自动标记</p></div>
      <div class="page-actions"><button class="btn" data-action="account-qr">扫码登录</button><button class="btn primary" data-action="account-new">添加账号</button></div>
    </div>
    <div class="card">
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>备注</th><th>提供方</th><th>状态</th><th>最近检测</th><th>接入方式</th><th class="num">操作</th></tr></thead>
        <tbody>${rows.map((a) => {
          const [label, cls] = ACC_STATUS[a.status] || ACC_STATUS.unknown;
          return `<tr>
            <td data-label="备注"><b>${esc(a.label)}</b><div class="small muted">${esc(a.username || a.fid || '')}</div></td>
            <td data-label="提供方">${({ sim: '模拟', chaoxing: '学习通', 'chaoxing-browser': '学习通 · 浏览器' })[a.provider] || a.provider}</td>
            <td data-label="状态"><span class="pill ${cls}">${label}</span>${a.status_note ? `<div class="small muted">${esc(a.status_note)}</div>` : ''}</td>
            <td class="small muted" data-label="最近检测">${fmtTime(a.last_check_at)}</td>
            <td class="small" data-label="接入方式">${a.has_cookie ? '<span class="pill ok">Cookie</span>' : '<span class="pill warn">未导入</span>'}</td>
            <td class="num act" data-label="操作">
              <button class="btn tiny" data-action="account-check" data-id="${a.id}">检测</button>
              ${a.provider === 'chaoxing-browser' ? `<button class="btn tiny" data-action="account-probe" data-id="${a.id}">看页面</button>` : ''}
              <button class="btn tiny" data-action="account-edit" data-id="${a.id}">编辑</button>
              <button class="btn tiny danger" data-action="account-del" data-id="${a.id}">删除</button>
            </td>
          </tr>`;
        }).join('')}</tbody></table></div>` : `<div class="empty"><div class="empty-title">还没有账号</div>点右上角「添加账号」，粘贴学习通 Cookie 即可接入</div>`}
    </div>

    <div class="card pad" style="margin-top:14px">
      <div style="font-weight:620;margin-bottom:6px">怎么拿 Cookie</div>
      <div class="small muted">
        浏览器登录 <code class="inline">i.chaoxing.com</code> → F12 → Network → 任意请求 → 复制请求头里的 <code class="inline">Cookie</code> 整串，
        粘贴到「Cookie」输入框。包含 <code class="inline">_uid</code>、<code class="inline">fid</code>、<code class="inline">_d</code> 即可。
      </div>
    </div>`;

  const accById = (id) => rows.find((a) => a.id === Number(id));
  bindActions({
    'account-new': () => accountForm(),
    'account-qr': () => qrLogin(),
    'account-edit': (bid) => accountForm(accById(bid)),
    'account-check': async (bid) => {
      toast('检测中…');
      try {
        const r = await api(`/api/accounts/${bid}/check`, { method: 'POST' });
        toast(`${r.ok ? '在线' : '异常'}：${r.note}`, !r.ok);
        renderAccounts();
      } catch (e) { toast(e.message, true); }
    },
    'account-probe': async (bid) => {
      toast('正在读页面…');
      try {
        const st = await api(`/api/accounts/${bid}/probe`, { method: 'POST' });
        modal(`
          <h2>页面探针</h2>
          <p class="hint">这是无头浏览器当前看到的页面状态，用来判断选择器/登录态是否正常。</p>
          <pre class="probe">${esc(JSON.stringify(st, null, 2))}</pre>
          <div class="modal-foot">
            <button class="btn ghost" data-action="account-browser-close" data-id="${bid}">关掉浏览器</button>
            <button class="btn primary" data-action="modal-close">关闭</button>
          </div>`);
        bindActions({ 'account-browser-close': async (id) => { await api(`/api/accounts/${id}/browser/close`, { method: 'POST' }); closeModal(); toast('浏览器已关闭'); } });
      } catch (e) { toast(e.message, true); }
    },
    'account-del': async (bid) => {
      if (!confirm('删除账号会同时删除它的计划与任务，确定？')) return;
      await api(`/api/accounts/${bid}`, { method: 'DELETE' });
      toast('已删除');
      renderAccounts();
    },
  });
}

function accountForm(acc = null) {
  const p = acc || {};
  modal(`
    <h2>${acc ? '编辑账号' : '添加账号'}</h2>
    <p class="hint">学习通账号用 Cookie 接入；模拟账号用于先跑通流程。</p>
    <div class="form-row">
      <label class="field"><span>备注名</span><input id="f_label" value="${esc(p.label || '')}" placeholder="张三 · 2024级"></label>
      <label class="field"><span>提供方</span>
        <select id="f_provider">
          <option value="chaoxing-browser" ${p.provider === 'chaoxing-browser' ? 'selected' : ''}>学习通 · 浏览器路线（能自动答题）</option>
          <option value="chaoxing" ${(!p.provider || p.provider === 'chaoxing') ? 'selected' : ''}>学习通 · 接口路线（只刷进度）</option>
          <option value="sim" ${p.provider === 'sim' ? 'selected' : ''}>模拟环境</option>
        </select>
      </label>
    </div>
    <div class="form-row">
      <label class="field"><span>学号 / 手机号（可选）</span><input id="f_username" value="${esc(p.username || '')}"></label>
      <label class="field"><span>学校 fid（可选）</span><input id="f_fid" value="${esc(p.fid || '')}" placeholder="如 2345"></label>
    </div>
    <label class="field"><span>Cookie</span><textarea id="f_cookie" class="mono" placeholder="_uid=...; fid=...; _d=...">${esc(acc && p.has_cookie ? '' : '')}</textarea></label>
    <div class="hint-box">编辑时 Cookie 留空表示不修改；填 <code class="inline">-</code> 表示清空。</div>
    <div class="modal-foot">
      <button class="btn ghost" data-action="modal-close">取消</button>
      <button class="btn primary" id="f_save">保存</button>
    </div>
  `);
  $('#f_save').onclick = async () => {
    const cookieRaw = $('#f_cookie').value.trim();
    const body = {
      label: $('#f_label').value.trim(),
      provider: $('#f_provider').value,
      username: $('#f_username').value.trim(),
      fid: $('#f_fid').value.trim(),
    };
    if (cookieRaw === '-') body.cookie = '';
    else if (cookieRaw) body.cookie = cookieRaw;
    try {
      if (acc) await api(`/api/accounts/${acc.id}`, { method: 'PATCH', body });
      else await api('/api/accounts', { method: 'POST', body });
      closeModal();
      toast('已保存');
      renderAccounts();
    } catch (e) { toast(e.message, true); }
  };
}

/* ------------------------------ 扫码登录 ------------------------------ */

let qrTimer = null;
let qrUuid = null;

function qrStop() {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
  qrUuid = null;
}

async function qrLogin() {
  qrStop();
  modal(`
    <h2>扫码登录学习通</h2>
    <p class="hint">用手机学习通 App 扫码并确认，登录态会直接写成一个新账号。</p>
    <div class="qr-box">
      <img id="qr_img" class="qr-img" alt="登录二维码" />
      <div id="qr_mask" class="qr-mask">正在生成二维码…</div>
    </div>
    <div class="qr-state" id="qr_state">
      <span class="qr-dot"></span><span id="qr_text">准备中</span>
    </div>
    <label class="field"><span>备注名</span><input id="qr_label" placeholder="例如 张三 · 2024级"></label>
    <div class="modal-foot">
      <button class="btn ghost" id="qr_reload" hidden>换一张</button>
      <button class="btn ghost" data-action="modal-close">关闭</button>
    </div>
  `);

  const mask = $('#qr_mask');
  const text = $('#qr_text');
  const reload = $('#qr_reload');
  reload.onclick = () => qrStart();

  async function qrStart() {
    qrStop();
    reload.hidden = true;
    mask.hidden = false;
    mask.textContent = '正在生成二维码…';
    text.textContent = '准备中';
    try {
      const out = await api('/api/accounts/qr/start', { method: 'POST' });
      qrUuid = out.uuid;
      $('#qr_img').src = out.image;
      mask.hidden = true;
      text.textContent = '打开学习通 App → 右上角扫一扫';
      qrTimer = setInterval(qrPoll, 2000);
    } catch (e) {
      mask.textContent = '生成失败：' + e.message;
      text.textContent = '出错了';
    }
  }

  async function qrPoll() {
    if (!qrUuid) return;
    let s;
    try { s = await api('/api/accounts/qr/' + qrUuid); } catch { return; }
    if (s.state === 'scanned') {
      text.textContent = `已扫码${s.nickname ? '：' + s.nickname : ''}，请在手机上点确认`;
    } else if (s.state === 'ok') {
      qrStop();
      text.textContent = '登录成功，正在创建账号…';
      const label = ($('#qr_label').value.trim()) || (s.nickname ? s.nickname : '学习通账号') + ' · 扫码';
      try {
        const acc = await api('/api/accounts', { method: 'POST', body: { label, provider: 'chaoxing', cookie: s.cookie } });
        closeModal();
        toast(`已添加「${acc.label}」`);
        renderAccounts();
        if (acc.id) api(`/api/accounts/${acc.id}/check`, { method: 'POST' }).then(() => renderAccounts()).catch(() => {});
      } catch (e) {
        text.textContent = '建账号失败：' + e.message;
      }
    } else if (s.state === 'expired' || s.state === 'cancelled') {
      qrStop();
      mask.hidden = false;
      mask.textContent = s.state === 'cancelled' ? '已取消' : '二维码已失效';
      text.textContent = s.note || '重新获取一张';
      reload.hidden = false;
    } else if (s.state === 'twofactor') {
      qrStop();
      mask.hidden = false;
      mask.textContent = '需要双因子验证';
      text.textContent = s.note || '这个账号开了双因子，请先在手机端完成验证';
      reload.hidden = false;
    } else if (s.note) {
      text.textContent = '等待扫码…';
    }
  }

  qrStart();
}

/* ------------------------------ 计划 ------------------------------ */

async function renderPlans() {
  const [plans, accounts] = await Promise.all([api('/api/plans'), api('/api/accounts')]);
  state.plans = plans;
  state.accounts = accounts;
  $('#main').innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">计划</h1><p class="page-sub">一个账号可以有多个计划，按课程过滤、倍速与时段并行工作</p></div>
      <div class="page-actions"><button class="btn primary" data-action="plan-new">新建计划</button></div>
    </div>
    ${plans.length ? `<div class="grid k2">${plans.map((p) => `
      <div class="card pad">
        <div class="row" style="justify-content:space-between">
          <div>
            <div style="font-weight:640;font-size:15px">${esc(p.name)}</div>
            <div class="small muted">${esc(p.account_label || '账号已删除')} · ${esc(p.course_filter || '全部课程')}</div>
          </div>
          <span class="pill ${p.enabled ? 'ok' : 'dim'}">${p.enabled ? '启用' : '停用'}</span>
        </div>
        <div class="row" style="margin:12px 0 10px;gap:14px" class="small">
          <span class="small muted">倍速 ${p.speed}x</span>
          <span class="small muted">并发 ${p.concurrency}</span>
          <span class="small muted">间隔 ${Math.round(p.interval_ms / 1000)}s</span>
          <span class="small muted">时段 ${p.window_start}–${p.window_end}</span>
        </div>
        <div class="row" style="gap:12px;font-size:12px;margin-bottom:12px">
          <span class="pill dim">待执行 ${p.counts.pending}</span>
          <span class="pill info">执行中 ${p.counts.running}</span>
          <span class="pill ok">完成 ${p.counts.done}</span>
          <span class="pill err">失败 ${p.counts.failed}</span>
        </div>
        <div class="row">
          <button class="btn tiny" data-action="plan-sync" data-id="${p.id}">同步任务</button>
          <button class="btn tiny" data-action="plan-toggle" data-id="${p.id}">${p.enabled ? '停用' : '启用'}</button>
          <button class="btn tiny" data-action="plan-edit" data-id="${p.id}">编辑</button>
          <button class="btn tiny danger" data-action="plan-clear" data-id="${p.id}">清空队列</button>
          <div class="spacer"></div>
          <button class="btn tiny danger" data-action="plan-del" data-id="${p.id}">删除</button>
        </div>
      </div>`).join('')}</div>`
      : `<div class="card"><div class="empty"><div class="empty-title">还没有计划</div>先添加账号，再点「新建计划」</div></div>`}`;

  const byId = (id) => plans.find((p) => p.id === Number(id));
  bindActions({
    'plan-new': () => planForm(null, accounts),
    'plan-edit': (id) => planForm(byId(id), accounts),
    'plan-sync': async (id) => {
      toast('正在同步章节…');
      try {
        const r = await api(`/api/plans/${id}/sync`, { method: 'POST' });
        toast(`同步完成：新增 ${r.created} / 共 ${r.total}`);
        renderPlans();
      } catch (e) { toast(e.message, true); }
    },
    'plan-toggle': async (id) => {
      const p = byId(id);
      await api(`/api/plans/${id}`, { method: 'PATCH', body: { enabled: !p.enabled } });
      renderPlans();
    },
    'plan-clear': async (id) => {
      if (!confirm('清空该计划里所有待执行与失败的任务？')) return;
      const r = await api(`/api/plans/${id}/clear`, { method: 'POST' });
      toast(`已清空 ${r.removed} 个任务`);
      renderPlans();
    },
    'plan-del': async (id) => {
      if (!confirm('删除计划及其任务？')) return;
      await api(`/api/plans/${id}`, { method: 'DELETE' });
      renderPlans();
    },
  });
}

function planForm(plan, accounts) {
  const p = plan || { speed: 1.5, concurrency: 1, window_start: '00:00', window_end: '23:59', interval_ms: 4000, enabled: true };
  modal(`
    <h2>${plan ? '编辑计划' : '新建计划'}</h2>
    <p class="hint">同步任务会把账号下的章节展开成任务点，交给调度器按窗口消费。</p>
    <div class="form-row">
      <label class="field"><span>计划名</span><input id="p_name" value="${esc(p.name || '')}" placeholder="周一至周五 · 全部课程"></label>
      <label class="field"><span>账号</span>
        <select id="p_account">${accounts.map((a) => `<option value="${a.id}" ${Number(p.account_id) === a.id ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select>
      </label>
    </div>
    <label class="field"><span>课程过滤（留空=全部）</span><input id="p_filter" value="${esc(p.course_filter || '')}" placeholder="形势与政策"></label>
    <div class="form-row-3">
      <label class="field"><span>倍速</span><input id="p_speed" type="number" step="0.5" min="1" max="4" value="${p.speed}"></label>
      <label class="field"><span>账号并发</span><input id="p_conc" type="number" min="1" max="3" value="${p.concurrency}"></label>
      <label class="field"><span>请求间隔(秒)</span><input id="p_interval" type="number" min="1" max="60" value="${Math.round(p.interval_ms / 1000)}"></label>
    </div>
    <div class="form-row">
      <label class="field"><span>开始时间</span><input id="p_ws" type="time" value="${p.window_start}"></label>
      <label class="field"><span>结束时间</span><input id="p_we" type="time" value="${p.window_end}"></label>
    </div>
    <label class="switch"><input type="checkbox" id="p_enabled" ${p.enabled ? 'checked' : ''}><span>启用计划（启用后调度器才会执行）</span></label>
    <div class="modal-foot">
      <button class="btn ghost" data-action="modal-close">取消</button>
      <button class="btn primary" id="p_save">保存</button>
    </div>
  `);
  $('#p_save').onclick = async () => {
    const body = {
      name: $('#p_name').value.trim() || '新计划',
      account_id: Number($('#p_account').value),
      course_filter: $('#p_filter').value.trim(),
      speed: Number($('#p_speed').value),
      concurrency: Number($('#p_conc').value),
      interval_ms: Number($('#p_interval').value) * 1000,
      window_start: $('#p_ws').value,
      window_end: $('#p_we').value,
      enabled: $('#p_enabled').checked,
    };
    try {
      if (plan) await api(`/api/plans/${plan.id}`, { method: 'PATCH', body });
      else await api('/api/plans', { method: 'POST', body });
      closeModal();
      toast('已保存');
      renderPlans();
    } catch (e) { toast(e.message, true); }
  };
}

/* ------------------------------ 任务 ------------------------------ */

async function renderTasks() {
  const qs = state.taskFilter ? `?status=${encodeURIComponent(state.taskFilter)}&limit=300` : '?limit=300';
  const tasks = await api('/api/tasks' + qs);
  state.tasks = tasks;
  const counts = tasks.reduce((acc, t) => (acc[t.status] = (acc[t.status] || 0) + 1, acc), {});
  $('#main').innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">任务</h1><p class="page-sub">${tasks.length} 条 · 失败 ${counts.failed || 0} · 执行中 ${counts.running || 0}</p></div>
      <div class="page-actions">
        <div class="seg" id="taskSeg">
          ${[['', '全部'], ['pending', '待执行'], ['running', '执行中'], ['done', '已完成'], ['failed', '失败']].map(([v, l]) =>
            `<button class="${state.taskFilter === v ? 'active' : ''}" data-filter="${v}">${l}</button>`).join('')}
        </div>
        <button class="btn" data-action="retry-failed">重试全部失败</button>
      </div>
    </div>
    <div class="card">
      ${tasks.length ? `<div class="table-wrap"><table>
        <thead><tr><th>任务</th><th>账号</th><th>状态</th><th style="width:150px">进度</th><th class="num">尝试</th><th class="num">操作</th></tr></thead>
        <tbody>${tasks.map((t) => `<tr>
          <td data-label="任务"><b>${esc(t.title || t.unit_id)}</b><div class="small muted">${esc(t.course_name || '')}</div></td>
          <td class="small" data-label="账号">${esc(t.account_label || '—')}</td>
          <td data-label="状态">${statusPill(t.status)}${t.error ? `<div class="small muted" title="${esc(t.error)}">${esc(t.error.slice(0, 42))}</div>` : ''}</td>
          <td data-label="进度"><div class="bar ${t.status === 'done' ? 'done' : t.status === 'failed' ? 'fail' : ''}"><i style="width:${t.progress}%"></i></div>
              <div class="small muted">${Math.round(t.progress)}%${t.finished_at && t.started_at ? ` · ${fmtDur(t.started_at, t.finished_at)}` : ''}</div></td>
          <td class="num small muted" data-label="尝试">${t.attempts}</td>
          <td class="num act" data-label="操作">
            <button class="btn tiny" data-action="task-retry" data-id="${t.id}">重试</button>
            <button class="btn tiny" data-action="task-skip" data-id="${t.id}">跳过</button>
          </td>
        </tr>`).join('')}</tbody></table></div>`
        : `<div class="empty"><div class="empty-title">没有任务</div>到「计划」里点一次「同步任务」</div>`}
    </div>`;

  $('#taskSeg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { state.taskFilter = b.dataset.filter; renderTasks(); };
  });
  bindActions({
    'task-retry': async (id) => { await api(`/api/tasks/${id}/retry`, { method: 'POST' }); toast('已重新排队'); renderTasks(); },
    'task-skip': async (id) => { await api(`/api/tasks/${id}/skip`, { method: 'POST' }); renderTasks(); },
    'retry-failed': async () => {
      const r = await api('/api/tasks/retry-failed', { method: 'POST' });
      toast(`已重新排队 ${r.count} 个任务`);
      renderTasks();
    },
  });
}

/* ------------------------------ 记录 ------------------------------ */

async function renderRecords() {
  const qs = state.recordFilter ? `?level=${state.recordFilter}&limit=300` : '?limit=300';
  const rows = await api('/api/records' + qs);
  state.records = rows;
  $('#main').innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">记录</h1><p class="page-sub">最近 5000 条执行日志，最新在上</p></div>
      <div class="page-actions">
        <div class="seg" id="recSeg">
          ${[['', '全部'], ['success', '完成'], ['error', '错误'], ['warn', '警告'], ['info', '信息']].map(([v, l]) =>
            `<button class="${state.recordFilter === v ? 'active' : ''}" data-filter="${v}">${l}</button>`).join('')}
        </div>
      </div>
    </div>
    <div class="card">
      ${rows.length ? `<div class="timeline">${rows.map((r) => `
        <div class="tl-item">
          <div class="tl-time">${fmtTime(r.created_at)}</div>
          <div>${levelPill(r.level)}</div>
          <div class="tl-msg">${esc(r.message)}${r.account_label ? ` <span class="small muted">· ${esc(r.account_label)}</span>` : ''}</div>
        </div>`).join('')}</div>` : `<div class="empty"><div class="empty-title">暂无记录</div></div>`}
    </div>`;
  $('#recSeg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { state.recordFilter = b.dataset.filter; renderRecords(); };
  });
}

/* ------------------------------ 订单 ------------------------------ */

async function renderOrders() {
  const [orders, settings] = await Promise.all([api('/api/orders'), api('/api/settings')]);
  const ORDER = { pending: ['待处理', 'warn'], active: ['进行中', 'info'], done: ['已完成', 'ok'], closed: ['已关闭', 'dim'] };
  $('#main').innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">客户订单</h1><p class="page-sub">客户前台 ${settings.client_portal_enabled ? '已开启' : '已关闭'} · <a href="/app" target="_blank" style="color:var(--accent)">打开客户前台 ↗</a></p></div>
    </div>
    <div class="card">
      ${orders.length ? `<div class="table-wrap"><table>
        <thead><tr><th>订单</th><th>客户</th><th>账号</th><th>状态</th><th class="num">金额</th><th>时间</th><th class="num">操作</th></tr></thead>
        <tbody>${orders.map((o) => {
          const [label, cls] = ORDER[o.status] || [o.status, 'dim'];
          return `<tr>
            <td data-label="订单">#${o.id} <b>${esc(o.title || '')}</b><div class="small muted">${esc(o.note || '')}</div></td>
            <td class="small" data-label="客户">${esc(o.client_email || '—')}</td>
            <td class="small" data-label="账号">${esc(o.account_label || '—')}</td>
            <td data-label="状态"><span class="pill ${cls}">${label}</span></td>
            <td class="num" data-label="金额">¥${(o.price_cents / 100).toFixed(2)}</td>
            <td class="small muted" data-label="时间">${fmtTime(o.created_at)}</td>
            <td class="num act" data-label="操作">
              <button class="btn tiny" data-action="order-accept" data-id="${o.id}">受理</button>
              <button class="btn tiny ghost" data-action="order-close" data-id="${o.id}">关闭</button>
            </td>
          </tr>`;
        }).join('')}</tbody></table></div>`
        : `<div class="empty"><div class="empty-title">还没有订单</div>把客户前台链接发出去，客户自助提交后这里会出现</div>`}
    </div>`;
  bindActions({
    'order-accept': async (id) => {
      const price = prompt('收费金额（元）', '10');
      if (price === null) return;
      await api(`/api/orders/${id}`, { method: 'PATCH', body: { status: 'active', price_cents: Math.round(Number(price) * 100) } });
      toast('已受理，对应计划已启用');
      renderOrders();
    },
    'order-close': async (id) => {
      await api(`/api/orders/${id}`, { method: 'PATCH', body: { status: 'closed' } });
      renderOrders();
    },
  });
}

/* ------------------------------ 设置 ------------------------------ */

async function renderSettings() {
  const s = await api('/api/settings');
  $('#main').innerHTML = `
    <div class="page-head"><div><h1 class="page-title">设置</h1><p class="page-sub">调度与客户前台开关</p></div></div>
    <div class="grid k2">
      <div class="card pad">
        <div style="font-weight:640;margin-bottom:12px">调度</div>
        <div class="form-row">
          <label class="field"><span>全局并发（1–8）</span><input id="s_conc" type="number" min="1" max="8" value="${s.concurrency}"></label>
          <label class="field"><span>单任务最大重试</span><input id="s_max" type="number" min="1" max="10" value="${s.max_attempts}"></label>
        </div>
        <label class="switch"><input type="checkbox" id="s_paused" ${s.paused ? 'checked' : ''}><span>暂停调度器</span></label>
        <div class="hint-box">并发越高越容易触发平台风控。学习通建议全局 1–2、账号并发 1、间隔 ≥4s。</div>
      </div>
      <div class="card pad">
        <div style="font-weight:640;margin-bottom:12px">客户前台</div>
        <label class="switch"><input type="checkbox" id="s_portal" ${s.client_portal_enabled ? 'checked' : ''}><span>开启客户前台（/app）</span></label>
        <label class="switch"><input type="checkbox" id="s_signup" ${s.signup_enabled ? 'checked' : ''}><span>允许客户自助注册</span></label>
        <label class="field"><span>站点名</span><input id="s_name" value="${esc(s.site_name)}"></label>
        <div class="hint-box">客户提交订单后会在「订单」里待处理；受理即启用对应计划。</div>
      </div>
    </div>

    <div class="card pad" style="margin-top:14px">
      <div style="font-weight:640;margin-bottom:6px">远程题库</div>
      <div class="small muted" style="margin-bottom:12px">把题库配置整段粘进来（网课助手 / OCS 那种 JSON 数组就行），本地没收录的题会去问它，答对后自动写进本地题库，下次秒中。</div>
      <label class="field"><span>题库配置</span><textarea id="s_qr_cfg" class="mono" rows="5" placeholder='[{"name":"言溪题库","url":"https://tk.enncy.cn/query","method":"post","contentType":"json","headers":{"Content-Type":"application/json"},"data":{"token":"...","title":"\${title}","options":"\${options}","type":"\${type}"}}]'></textarea></label>
      <div class="row" style="gap:8px;align-items:center;margin-top:10px">
        <button class="btn" id="s_qr_import">导入配置</button>
        <button class="btn ghost" id="s_qr_test">测试一次</button>
        <label class="switch" style="margin:0"><input type="checkbox" id="s_qr_on"><span>启用远程题库</span></label>
        <span class="small muted" id="s_qr_state">未配置</span>
      </div>
    </div>

    <div class="row" style="margin-top:14px">
      <button class="btn primary" id="s_save">保存设置</button>
      <span class="small muted">修改后立即生效，无需重启</span>
    </div>`;

  $('#s_save').onclick = async () => {
    await api('/api/settings', { method: 'POST', body: {
      concurrency: Number($('#s_conc').value),
      max_attempts: Number($('#s_max').value),
      paused: $('#s_paused').checked,
      client_portal_enabled: $('#s_portal').checked,
      signup_enabled: $('#s_signup').checked,
      site_name: $('#s_name').value.trim() || '插头学堂',
    } });
    toast('设置已保存');
  };

  /* ---- 远程题库 ---- */
  async function qrRefresh() {
    try {
      const r = await api('/api/quiz/remote');
      $('#s_qr_on').checked = !!r.enabled;
      $('#s_qr_state').textContent = r.url ? `${r.name || '远程题库'} · ${r.method} ${r.url}${r.enabled ? '' : ' · 停用中'}` : '未配置';
      if (r.url && !$('#s_qr_cfg').value) {
        $('#s_qr_cfg').value = JSON.stringify([{
          name: r.name, url: r.url, method: r.method.toLowerCase(), headers: r.headers, data: r.data,
        }], null, 2);
      }
    } catch (e) { $('#s_qr_state').textContent = '读取失败：' + e.message; }
  }
  qrRefresh();

  $('#s_qr_import').onclick = async () => {
    try {
      const out = await api('/api/quiz/remote', { method: 'POST', body: { config: $('#s_qr_cfg').value } });
      toast(`已导入：${out.name}`);
      qrRefresh();
    } catch (e) { toast(e.message, true); }
  };
  $('#s_qr_test').onclick = async () => {
    toast('正在问题库…');
    try {
      const r = await api('/api/quiz/remote/test', { method: 'POST', body: {} });
      toast(`题库返回：${r.answer}`, !r.ok);
    } catch (e) { toast(e.message, true); }
  };
  $('#s_qr_on').onchange = async () => {
    try {
      await api('/api/quiz/remote', { method: 'POST', body: { enabled: $('#s_qr_on').checked } });
      toast($('#s_qr_on').checked ? '远程题库已启用' : '远程题库已停用');
      qrRefresh();
    } catch (e) { toast(e.message, true); }
  };
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bindActions(map) {
  const root = $('#main');
  root.querySelectorAll('[data-action]').forEach((btn) => {
    const fn = map[btn.dataset.action];
    if (!fn) return;
    btn.onclick = (e) => { e.preventDefault(); fn(btn.dataset.id); };
  });
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  if (t.dataset.action === 'modal-close') closeModal();
  if (t.dataset.action === 'goto') location.hash = t.dataset.href;
});

/* ------------------------------ 启动 ------------------------------ */

boot().catch((e) => {
  document.body.innerHTML = `<div class="empty"><div class="empty-title">无法连接服务</div>${esc(e.message)}</div>`;
});

setInterval(async () => {
  if ($('#shell').hidden) return;
  try {
    const s = await api('/api/stats');
    renderQueue(s.queue);
    const key = (location.hash.replace(/^#\/?/, '') || 'overview');
    if (key === 'overview' || key === 'tasks') route();
  } catch { /* 忽略轮询错误 */ }
}, 8000);