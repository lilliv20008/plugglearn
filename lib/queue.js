'use strict';
/**
 * 任务调度器：单进程内的工作队列。
 * - 全局并发、账号并发、时段窗口、失败重试（指数退避）
 * - 每个任务执行时把进度写回数据库，并在 records 里留痕
 */
const { db, now, get, set, log } = require('./db');
const providers = require('./providers');

const running = new Map(); // taskId -> { startedAt, accountId }
let paused = false;
let timer = null;

function settings() {
  return {
    concurrency: Math.max(1, Math.min(8, Number(get('concurrency', 2)))),
    maxAttempts: Math.max(1, Math.min(10, Number(get('max_attempts', 3)))),
    paused: get('paused', '0') === '1',
  };
}

function inWindow(plan) {
  const d = new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  const toMin = (s) => {
    const [h, m] = String(s || '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const start = toMin(plan.window_start);
  const end = toMin(plan.window_end);
  if (start === end) return true;
  if (start < end) return cur >= start && cur <= end;
  return cur >= start || cur <= end; // 跨零点
}

function accountRunning(accountId) {
  let n = 0;
  for (const v of running.values()) if (v.accountId === accountId) n += 1;
  return n;
}

function pickTask(limitArg) {
  const rows = db.prepare(`
    SELECT t.*, p.enabled AS plan_enabled, p.concurrency AS plan_concurrency,
           p.speed AS plan_speed, p.interval_ms AS plan_interval,
           p.window_start, p.window_end, a.provider AS provider, a.status AS account_status
    FROM tasks t
    JOIN plans p ON p.id = t.plan_id
    JOIN accounts a ON a.id = t.account_id
    WHERE t.status = 'pending'
      AND p.enabled = 1
      AND a.status != 'disabled'
      AND (t.next_at IS NULL OR t.next_at <= ?)
    ORDER BY t.id ASC
    LIMIT 200
  `).all(now());

  for (const t of rows) {
    if (!inWindow(t)) continue;
    if (accountRunning(t.account_id) >= Math.max(1, t.plan_concurrency || 1)) continue;
    return t;
  }
  return null;
}

function updateProgress(taskId, progress) {
  db.prepare('UPDATE tasks SET progress = ? WHERE id = ?').run(Math.round(Math.min(100, Math.max(0, progress))), taskId);
}

async function execute(task) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(task.account_id);
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(task.plan_id);
  const provider = providers.get(account.provider || 'chaoxing');

  running.set(task.id, { startedAt: Date.now(), accountId: account.id });
  db.prepare("UPDATE tasks SET status = 'running', started_at = ?, progress = 0, error = NULL WHERE id = ?").run(now(), task.id);
  log('info', `开始执行：${task.course_name || ''} ${task.title || task.unit_id}`, { taskId: task.id, accountId: account.id });

  try {
    let parsed = {};
    try { parsed = task.payload ? JSON.parse(task.payload) : {}; } catch { parsed = {}; }

    const result = await provider.runUnit(account, plan, { ...task, payload: parsed }, (pct, note) => {
      updateProgress(task.id, pct);
      if (note && Math.round(pct) % 30 === 0) {
        log('debug', note, { taskId: task.id, accountId: account.id });
      }
    });

    db.prepare("UPDATE tasks SET status = 'done', progress = 100, finished_at = ?, next_at = NULL WHERE id = ?").run(now(), task.id);
    log('success', result && result.message ? result.message : '任务完成', { taskId: task.id, accountId: account.id });
  } catch (err) {
    const attempts = (task.attempts || 0) + 1;
    const maxAttempts = settings().maxAttempts;
    const backoffSec = Math.min(600, 30 * attempts * attempts);
    // 风控/登录失效这类问题重试没用，会一路烧掉整批任务：直接暂停队列等人处理
    if (/人工验证|反爬验证|Cookie 失效|跳到登录页|没加载出来/.test(String(err.message))) {
      db.prepare("UPDATE tasks SET status = 'pending', attempts = ?, error = ?, next_at = ? WHERE id = ?")
        .run(attempts, String(err.message).slice(0, 500), new Date(Date.now() + 900000).toISOString(), task.id);
      setPaused(true);
      log('error', `队列已自动暂停：${err.message}（处理完再点继续）`, { taskId: task.id, accountId: account.id });
      return;
    }
    if (attempts >= maxAttempts) {
      db.prepare("UPDATE tasks SET status = 'failed', attempts = ?, error = ?, finished_at = ?, next_at = NULL WHERE id = ?")
        .run(attempts, String(err.message).slice(0, 500), now(), task.id);
      log('error', `失败（已放弃）：${err.message}`, { taskId: task.id, accountId: account.id });
    } else {
      const next = new Date(Date.now() + backoffSec * 1000).toISOString();
      db.prepare("UPDATE tasks SET status = 'pending', attempts = ?, error = ?, next_at = ? WHERE id = ?")
        .run(attempts, String(err.message).slice(0, 500), next, task.id);
      log('warn', `失败，${backoffSec}s 后重试（${attempts}/${maxAttempts}）：${err.message}`, { taskId: task.id, accountId: account.id });
    }
  } finally {
    running.delete(task.id);
  }
}

function tick() {
  const cfg = settings();
  if (cfg.paused) return;
  while (running.size < cfg.concurrency) {
    const task = pickTask();
    if (!task) break;
    execute(task).catch((e) => log('error', `调度异常：${e.message}`, { taskId: task.id }));
  }
}

function start() {
  if (timer) return;
  // 上次进程被强杀时留下的 running 行会永远卡住，启动时回收
  try {
    const n = db.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, progress = 0 WHERE status = 'running'").run().changes;
    if (n) log('warn', `回收了 ${n} 个上次异常中断的任务（已重新排队）`);
  } catch (e) {
    log('error', `回收中断任务失败：${e.message}`);
  }
  timer = setInterval(() => {
    try { tick(); } catch (e) { log('error', `调度器循环异常：${e.message}`); }
  }, 2000);
  timer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function snapshot() {
  return {
    running: running.size,
    active: [...running.entries()].map(([taskId, v]) => ({ taskId, accountId: v.accountId, ms: Date.now() - v.startedAt })),
    paused: settings().paused,
    concurrency: settings().concurrency,
  };
}

function setPaused(v) {
  set('paused', v ? '1' : '0');
}

module.exports = { start, stop, snapshot, setPaused, settings, inWindow };