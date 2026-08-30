import { config } from '../config.js';
import * as repo from '../db/repositories.js';
import { formatJa } from '../lib/dates.js';
import { buildContext, checkEligibility, createState } from '../scheduler/constraints.js';
import { swapRequestBlocks, swapApprovalBlocks } from './blocks.js';
import { dmUser } from './notify.js';

export function registerActions(app) {
  app.action('swap_volunteer', wrap(handleVolunteer));
  app.action('swap_cancel', wrap(handleCancel));
  app.action('swap_approve', wrap(handleApprove));
  app.action('swap_reject', wrap(handleReject));
  app.action('swap_approve_absence', wrap(handleApproveAbsence));
}

/** ack と例外処理をまとめる */
function wrap(handler) {
  return async (args) => {
    await args.ack();
    try {
      await handler(args);
    } catch (err) {
      await ephemeral(args, `:warning: ${err.message}`);
    }
  };
}

async function ephemeral({ client, body }, text) {
  const channel = body.channel?.id;
  if (channel) {
    try {
      await client.chat.postEphemeral({ channel, user: body.user.id, text });
      return;
    } catch {
      // チャンネル外（DM など）では postEphemeral が使えないので DM にフォールバック
    }
  }
  await dmUser(client, body.user.id, text);
}

async function loadSwapContext(swapId) {
  const swap = await repo.getSwapRequest(swapId);
  if (!swap) throw new Error('申請が見つかりません。');
  const assignment = await repo.getAssignment(swap.assignment_id);
  if (!assignment) throw new Error('対象の勤務が見つかりません。');
  const [requester, volunteer, shiftTypes] = await Promise.all([
    repo.getStaffById(swap.requester_staff_id),
    swap.volunteer_staff_id ? repo.getStaffById(swap.volunteer_staff_id) : Promise.resolve(null),
    repo.listShiftTypes(),
  ]);
  return {
    swap,
    assignment,
    requester,
    volunteer,
    shiftType: shiftTypes.find((t) => t.id === assignment.shift_type_id) ?? null,
  };
}

/** 募集メッセージを最新の状態に更新する */
async function refreshSwapMessage(client, ctx) {
  if (!ctx.swap.slack_channel || !ctx.swap.slack_ts) return;
  await client.chat.update({
    channel: ctx.swap.slack_channel,
    ts: ctx.swap.slack_ts,
    text: `交代・欠勤申請（${ctx.assignment.date}）: ${ctx.swap.status}`,
    blocks: swapRequestBlocks(ctx),
  });
}

async function requireStaff(slackUserId) {
  const staff = await repo.getStaffBySlackId(slackUserId);
  if (!staff) throw new Error('スタッフ登録されていないため操作できません。');
  return staff;
}

async function requireAdmin(slackUserId) {
  const staff = await requireStaff(slackUserId);
  if (!staff.is_admin) throw new Error('この操作は管理者のみ実行できます。');
  return staff;
}

// ------------------------------------------------------------
// 「代われます」
// ------------------------------------------------------------
async function handleVolunteer({ body, client, action }) {
  const volunteer = await requireStaff(body.user.id);
  const ctx = await loadSwapContext(Number(action.value));

  if (ctx.swap.status !== 'open') throw new Error('この申請はすでに受付を終えています。');
  if (ctx.swap.requester_staff_id === volunteer.id) throw new Error('自分の申請には立候補できません。');

  const check = await checkVolunteer(ctx.assignment, volunteer);
  if (!check.ok) throw new Error(`交代できません: ${check.reason}`);

  const swap = await repo.updateSwapRequest(ctx.swap.id, {
    volunteer_staff_id: volunteer.id,
    status: 'claimed',
  });
  const next = { ...ctx, swap, volunteer };

  await refreshSwapMessage(client, next);
  await client.chat.postMessage({
    channel: config.slack.adminChannel,
    text: `交代の承認依頼: ${ctx.requester?.name} → ${volunteer.name}（${ctx.assignment.date}）`,
    blocks: swapApprovalBlocks(next),
  });
  await dmUser(client, ctx.requester?.slack_user_id,
    `:raising_hand: ${volunteer.name} さんが ${formatJa(ctx.assignment.date)} の代わりに立候補しました。管理者の承認をお待ちください。`);
}

/** 立候補者がその日に入れるかを、割当と同じルールで確認する */
async function checkVolunteer(assignment, volunteer) {
  const data = await repo.loadPlanningData(assignment.period_id);
  const ctx = buildContext({
    staff: data.staff, shiftTypes: data.shiftTypes, requests: data.requests, rules: config.rules,
  });
  // 申請者の枠は空くので、状態からは外して判定する
  const others = data.assignments.filter((a) => a.id !== assignment.id);
  const state = createState(others);
  const shiftType = ctx.shiftTypesById.get(assignment.shift_type_id);
  if (!shiftType) return { ok: false, reason: 'シフト種別が見つかりません' };
  return checkEligibility(ctx, state, volunteer, assignment.date, shiftType, null);
}

// ------------------------------------------------------------
// 申請の取り消し
// ------------------------------------------------------------
async function handleCancel({ body, client, action }) {
  const staff = await requireStaff(body.user.id);
  const ctx = await loadSwapContext(Number(action.value));

  if (ctx.swap.requester_staff_id !== staff.id && !staff.is_admin) {
    throw new Error('申請者本人または管理者のみ取り消せます。');
  }
  if (!['open', 'claimed'].includes(ctx.swap.status)) throw new Error('この申請はすでに処理済みです。');

  const swap = await repo.updateSwapRequest(ctx.swap.id, { status: 'cancelled', decided_by: body.user.id });
  await refreshSwapMessage(client, { ...ctx, swap });
}

// ------------------------------------------------------------
// 承認（交代）
// ------------------------------------------------------------
async function handleApprove({ body, client, action, respond }) {
  await requireAdmin(body.user.id);
  const ctx = await loadSwapContext(Number(action.value));

  if (ctx.swap.status !== 'claimed') throw new Error('立候補者がいる申請のみ承認できます。');
  if (!ctx.volunteer) throw new Error('立候補者が見つかりません。');

  await repo.updateAssignment(ctx.assignment.id, {
    staff_id: ctx.volunteer.id,
    status: 'assigned',
    note: `${ctx.requester?.name ?? ''} から交代`,
  });
  const swap = await repo.updateSwapRequest(ctx.swap.id, { status: 'approved', decided_by: body.user.id });

  await refreshSwapMessage(client, { ...ctx, swap });
  await respond({ replace_original: true, text: `:white_check_mark: 承認しました（${ctx.requester?.name} → ${ctx.volunteer.name} / ${ctx.assignment.date}）` });
  await dmUser(client, ctx.requester?.slack_user_id,
    `:white_check_mark: ${formatJa(ctx.assignment.date)} の交代が承認されました（担当: ${ctx.volunteer.name} さん）。`);
  await dmUser(client, ctx.volunteer.slack_user_id,
    `:white_check_mark: ${formatJa(ctx.assignment.date)} の勤務を担当することになりました。よろしくお願いします。`);
}

// ------------------------------------------------------------
// 承認（欠勤のまま確定）
// ------------------------------------------------------------
async function handleApproveAbsence({ body, client, action }) {
  await requireAdmin(body.user.id);
  const ctx = await loadSwapContext(Number(action.value));

  if (!['open', 'claimed'].includes(ctx.swap.status)) throw new Error('この申請はすでに処理済みです。');

  await repo.updateAssignment(ctx.assignment.id, { status: 'absent' });
  const swap = await repo.updateSwapRequest(ctx.swap.id, {
    status: 'approved', volunteer_staff_id: null, decided_by: body.user.id,
  });

  await refreshSwapMessage(client, { ...ctx, swap, volunteer: null });
  await dmUser(client, ctx.requester?.slack_user_id,
    `:white_check_mark: ${formatJa(ctx.assignment.date)} の欠勤が承認されました。`);
}

// ------------------------------------------------------------
// 却下
// ------------------------------------------------------------
async function handleReject({ body, client, action, respond }) {
  await requireAdmin(body.user.id);
  const ctx = await loadSwapContext(Number(action.value));

  if (!['open', 'claimed'].includes(ctx.swap.status)) throw new Error('この申請はすでに処理済みです。');

  const swap = await repo.updateSwapRequest(ctx.swap.id, { status: 'rejected', decided_by: body.user.id });
  await refreshSwapMessage(client, { ...ctx, swap });
  await respond({ replace_original: true, text: `:x: 却下しました（${ctx.assignment.date}）` });
  await dmUser(client, ctx.requester?.slack_user_id,
    `:x: ${formatJa(ctx.assignment.date)} の申請は承認されませんでした。管理者にご相談ください。`);
}
