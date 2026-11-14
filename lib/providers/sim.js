'use strict';
/**
 * 模拟提供方：不连接任何外部站点，用于端到端演示、压测和 UI 联调。
 * 结构与 chaoxing 提供方完全一致，方便替换。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COURSES = [
  { id: 'sim-1001', name: '大学生心理健康教育（模拟）', units: 8 },
  { id: 'sim-1002', name: '形势与政策（模拟）', units: 6 },
  { id: 'sim-1003', name: '创新创业基础（模拟）', units: 5 },
];

module.exports = {
  id: 'sim',
  label: '模拟环境（不联网，用于演示）',

  async check(account) {
    await sleep(120);
    if (!account.cookie && account.provider === 'chaoxing') {
      return { ok: false, note: '模拟账号无需 Cookie，可直接使用' };
    }
    return { ok: true, note: `模拟会话有效 · ${COURSES.length} 门课程` };
  },

  async listUnits(account, plan) {
    await sleep(200);
    const filter = String(plan.course_filter || '').trim();
    const out = [];
    for (const course of COURSES) {
      if (filter && !course.name.includes(filter) && !course.id.includes(filter)) continue;
      for (let i = 1; i <= course.units; i += 1) {
        out.push({
          course_id: course.id,
          course_name: course.name,
          unit_id: `${course.id}-u${i}`,
          kind: 'video',
          title: `第 ${i} 节 · 课程视频（模拟）`,
          payload: { duration: 300 + i * 37 },
        });
      }
    }
    return out;
  },

  async runUnit(account, plan, task, onProgress) {
    const duration = (task.payload && task.payload.duration) || 300;
    const speed = Math.min(4, Math.max(1, Number(plan.speed) || 1));
    const steps = 6;
    for (let i = 1; i <= steps; i += 1) {
      await sleep(Math.max(120, Math.round((duration * 1000) / steps / speed / 40)));
      onProgress((i / steps) * 100, `播放中 ${Math.round((i / steps) * duration)}s / ${duration}s`);
    }
    return { ok: true, message: `模拟完成，时长 ${duration}s，倍速 ${speed}x` };
  },
};