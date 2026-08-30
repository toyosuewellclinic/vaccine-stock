import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import * as repo from '../db/repositories.js';
import { planSlots } from '../scheduler/constraints.js';
import { validateBoard } from '../scheduler/validate.js';
import { runAutoAssign } from '../slack/commands.js';
import { publishSchedule } from '../slack/notify.js';

function tokenMatches(provided) {
  const a = Buffer.from(String(provided ?? ''));
  const b = Buffer.from(config.admin.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireAdminToken(req, res, next) {
  const provided = req.get('x-admin-token') ?? '';
  if (!tokenMatches(provided)) {
    res.status(401).json({ error: '管理トークンが不正です' });
    return;
  }
  next();
}

/** 非同期ハンドラの例外を Express に流す */
function handle(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
}

export function createApiRouter(slackApp) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  router.get('/health', (_req, res) => res.json({ ok: true }));

  router.use(requireAdminToken);

  router.get('/staff', handle(async (_req, res) => {
    res.json({ staff: await repo.listStaff({ activeOnly: false }) });
  }));

  router.get('/periods', handle(async (_req, res) => {
    res.json({ periods: await repo.listPeriods() });
  }));

  router.post('/periods', handle(async (req, res) => {
    const { name, start_date: startDate, end_date: endDate, request_deadline: deadline } = req.body ?? {};
    if (!name || !startDate || !endDate) {
      res.status(400).json({ error: 'name / start_date / end_date は必須です' });
      return;
    }
    const period = await repo.createPeriod({
      name, start_date: startDate, end_date: endDate, request_deadline: deadline || null, status: 'draft',
    });
    res.status(201).json({ period });
  }));

  router.patch('/periods/:id', handle(async (req, res) => {
    const allowed = ['name', 'start_date', 'end_date', 'request_deadline', 'status'];
    const patch = {};
    for (const key of allowed) {
      if (key in (req.body ?? {})) patch[key] = req.body[key];
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: '更新する項目がありません' });
      return;
    }
    res.json({ period: await repo.updatePeriod(Number(req.params.id), patch) });
  }));

  /** シフト表の編集に必要な情報を一括で返す */
  router.get('/periods/:id/board', handle(async (req, res) => {
    const data = await repo.loadPlanningData(Number(req.params.id));
    const slots = planSlots(data);
    const { issues } = validateBoard({ ...data, rules: config.rules });
    const submitted = await repo.listStaffIdsWithRequests(data.period.id);
    res.json({
      ...data,
      slots,
      issues,
      submitted_staff_ids: [...submitted],
      rules: config.rules,
    });
  }));

  router.post('/periods/:id/auto-assign', handle(async (req, res) => {
    const result = await runAutoAssign(Number(req.params.id));
    res.json(result);
  }));

  /** 手動編集の保存。locked の枠も含めて渡された内容で丸ごと置き換える。 */
  router.put('/periods/:id/assignments', handle(async (req, res) => {
    const periodId = Number(req.params.id);
    const rows = req.body?.assignments;
    if (!Array.isArray(rows)) {
      res.status(400).json({ error: 'assignments は配列で指定してください' });
      return;
    }
    await repo.saveAssignments(periodId, rows, { keepLocked: false });

    const data = await repo.loadPlanningData(periodId);
    const { issues } = validateBoard({ ...data, rules: config.rules });
    if (data.period.status === 'draft' || data.period.status === 'collecting') {
      await repo.updatePeriod(periodId, { status: 'assigned' });
    }
    res.json({ saved: data.assignments.length, issues });
  }));

  router.post('/periods/:id/publish', handle(async (req, res) => {
    const result = await publishSchedule(slackApp.client, Number(req.params.id), {
      dm: req.body?.dm !== false,
    });
    res.json(result);
  }));

  // eslint-disable-next-line no-unused-vars -- Express のエラーハンドラは引数4つが必須
  router.use((err, _req, res, _next) => {
    console.error('[api]', err);
    res.status(500).json({ error: err.message });
  });

  return router;
}
