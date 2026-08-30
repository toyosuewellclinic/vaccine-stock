import { config } from '../config.js';
import * as repo from '../db/repositories.js';
import { eachDate, todayIn, addDays, formatJa } from '../lib/dates.js';
import { autoAssign } from '../scheduler/autoAssign.js';
import { validateBoard } from '../scheduler/validate.js';
import { buildRequestModal, parseRequestSubmission, REQUEST_MODAL_CALLBACK } from './views/requestModal.js';
import { buildSwapModal, parseSwapSubmission, SWAP_MODAL_CALLBACK } from './views/swapModal.js';
import { swapRequestBlocks } from './blocks.js';
import { publishSchedule } from './notify.js';

const UPCOMING_DAYS = 90;

async function requireStaff(slackUserId) {
  const staff = await repo.getStaffBySlackId(slackUserId);
  if (!staff) {
    throw new Error(
      'あなたのアカウントがスタッフ登録されていません。管理者に Slack ID の登録を依頼してください。',
    );
  }
  return staff;
}

export function registerCommands(app) {
  // ----------------------------------------------------------
  // /shift-request : 希望シフトの提出
  // ----------------------------------------------------------
  app.command('/shift-request', async ({ ack, body, client, respond }) => {
    await ack();
    try {
      const staff = await requireStaff(body.user_id);
      const period = await repo.getCollectingPeriod();
      if (!period) {
        await respond({ response_type: 'ephemeral', text: '現在、希望シフトを受付中の期間はありません。' });
        return;
      }

      const existingRows = await repo.listRequestsByStaff(period.id, staff.id);
      const existing = new Map(existingRows.map((r) => [r.date, r.preference]));
      const existingNote = existingRows.find((r) => r.note)?.note ?? '';

      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildRequestModal({
          period,
          dates: eachDate(period.start_date, period.end_date),
          existing,
          existingNote,
        }),
      });
    } catch (err) {
      await respond({ response_type: 'ephemeral', text: `:warning: ${err.message}` });
    }
  });

  app.view(REQUEST_MODAL_CALLBACK, async ({ ack, body, view, client }) => {
    await ack();
    try {
      const staff = await requireStaff(body.user.id);
      const { periodId, rows, note } = parseRequestSubmission(view);
      await repo.replaceRequests(periodId, staff.id, rows);

      const period = await repo.getPeriod(periodId);
      const ng = rows.filter((r) => r.preference === 'ng').length;
      const want = rows.filter((r) => r.preference === 'want').length;
      const im = await client.conversations.open({ users: body.user.id });
      await client.chat.postMessage({
        channel: im.channel.id,
        text: `:white_check_mark: *${period?.name ?? ''}* の希望シフトを受け付けました。\n`
          + `勤務不可 ${ng}日 / 希望 ${want}日${note ? `\n備考: ${note}` : ''}\n`
          + '締切までは `/shift-request` で何度でも修正できます。',
      });
    } catch (err) {
      const im = await client.conversations.open({ users: body.user.id });
      await client.chat.postMessage({ channel: im.channel.id, text: `:warning: 希望シフトの登録に失敗しました: ${err.message}` });
    }
  });

  // ----------------------------------------------------------
  // /shift-my : 自分の今後の勤務
  // ----------------------------------------------------------
  app.command('/shift-my', async ({ ack, body, respond }) => {
    await ack();
    try {
      const staff = await requireStaff(body.user_id);
      const today = todayIn(config.timezone);
      const [assignments, shiftTypes] = await Promise.all([
        repo.listUpcomingAssignments(staff.id, today, addDays(today, UPCOMING_DAYS)),
        repo.listShiftTypes(),
      ]);
      if (assignments.length === 0) {
        await respond({ response_type: 'ephemeral', text: '今後の勤務予定はまだ登録されていません。' });
        return;
      }
      const typeById = new Map(shiftTypes.map((t) => [t.id, t]));
      const lines = assignments.map((a) => {
        const t = typeById.get(a.shift_type_id);
        const time = t ? `${t.name} ${t.start_time.slice(0, 5)}-${t.end_time.slice(0, 5)}` : `#${a.shift_type_id}`;
        return `• ${formatJa(a.date)} ${time}${a.status === 'absent' ? '（欠勤）' : ''}`;
      });
      await respond({
        response_type: 'ephemeral',
        text: `*${staff.name} さんの今後の勤務（${assignments.length}件）*\n${lines.join('\n')}`,
      });
    } catch (err) {
      await respond({ response_type: 'ephemeral', text: `:warning: ${err.message}` });
    }
  });

  // ----------------------------------------------------------
  // /shift-swap : 交代・欠勤の申請
  // ----------------------------------------------------------
  app.command('/shift-swap', async ({ ack, body, client, respond }) => {
    await ack();
    try {
      const staff = await requireStaff(body.user_id);
      const today = todayIn(config.timezone);
      const [assignments, shiftTypes] = await Promise.all([
        repo.listUpcomingAssignments(staff.id, today, addDays(today, UPCOMING_DAYS)),
        repo.listShiftTypes(),
      ]);
      const open = assignments.filter((a) => a.status === 'assigned');
      if (open.length === 0) {
        await respond({ response_type: 'ephemeral', text: '申請できる今後の勤務がありません。' });
        return;
      }
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildSwapModal({ assignments: open, shiftTypes }),
      });
    } catch (err) {
      await respond({ response_type: 'ephemeral', text: `:warning: ${err.message}` });
    }
  });

  app.view(SWAP_MODAL_CALLBACK, async ({ ack, body, view, client }) => {
    await ack();
    const im = await client.conversations.open({ users: body.user.id });
    try {
      const staff = await requireStaff(body.user.id);
      const { assignmentId, kind, reason } = parseSwapSubmission(view);

      const assignment = await repo.getAssignment(assignmentId);
      if (!assignment || assignment.staff_id !== staff.id) {
        throw new Error('その勤務はあなたの割当ではありません。');
      }

      const swap = await repo.createSwapRequest({
        assignment_id: assignmentId,
        requester_staff_id: staff.id,
        kind,
        reason,
        status: 'open',
      });

      const shiftTypes = await repo.listShiftTypes();
      const shiftType = shiftTypes.find((t) => t.id === assignment.shift_type_id);
      const posted = await client.chat.postMessage({
        channel: config.slack.shiftChannel,
        text: `${staff.name} さんから${kind === 'absence' ? '欠勤申請' : '交代希望'}が出ています（${assignment.date}）`,
        blocks: swapRequestBlocks({ swap, requester: staff, assignment, shiftType }),
      });

      await repo.updateSwapRequest(swap.id, { slack_channel: posted.channel, slack_ts: posted.ts });
      await client.chat.postMessage({
        channel: im.channel.id,
        text: ':white_check_mark: 申請を受け付け、チャンネルに交代を募集しました。',
      });
    } catch (err) {
      await client.chat.postMessage({ channel: im.channel.id, text: `:warning: 申請に失敗しました: ${err.message}` });
    }
  });

  // ----------------------------------------------------------
  // /shift-admin : 管理者向け操作
  // ----------------------------------------------------------
  app.command('/shift-admin', async ({ ack, body, client, respond }) => {
    await ack();
    try {
      const staff = await requireStaff(body.user_id);
      if (!staff.is_admin) throw new Error('この操作は管理者のみ実行できます。');

      const [sub, ...args] = (body.text || '').trim().split(/\s+/).filter(Boolean);
      const text = await runAdminCommand({ sub, args, client, respond });
      if (text) await respond({ response_type: 'ephemeral', text });
    } catch (err) {
      await respond({ response_type: 'ephemeral', text: `:warning: ${err.message}` });
    }
  });
}

const ADMIN_USAGE = [
  '*使い方*',
  '`/shift-admin periods` 期間の一覧',
  '`/shift-admin new <名前> <開始日> <終了日> [提出期限]` 例: `/shift-admin new 2026年9月 2026-09-01 2026-09-30 2026-08-20`',
  '`/shift-admin open <期間ID>` 希望シフトの受付を開始',
  '`/shift-admin close <期間ID>` 希望シフトの受付を終了',
  '`/shift-admin status <期間ID>` 提出状況',
  '`/shift-admin assign <期間ID>` 自動割当を実行（手動確定した枠は保持）',
  '`/shift-admin publish <期間ID>` 確定シフトを公開・通知',
].join('\n');

async function runAdminCommand({ sub, args, client }) {
  switch (sub) {
    case undefined:
    case 'help':
      return ADMIN_USAGE;

    case 'periods': {
      const periods = await repo.listPeriods();
      if (periods.length === 0) return '期間がまだありません。`/shift-admin new` で作成してください。';
      return ['*シフト期間*', ...periods.map(
        (p) => `• #${p.id} ${p.name}（${p.start_date}〜${p.end_date}） 状態: ${p.status}`
          + (p.request_deadline ? ` 締切: ${p.request_deadline}` : ''),
      )].join('\n');
    }

    case 'new': {
      const [name, start, end, deadline] = args;
      if (!name || !start || !end) return `引数が足りません。\n${ADMIN_USAGE}`;
      const period = await repo.createPeriod({
        name, start_date: start, end_date: end, request_deadline: deadline ?? null, status: 'draft',
      });
      return `:white_check_mark: 期間 #${period.id}「${period.name}」を作成しました。`
        + '\n`/shift-admin open ' + period.id + '` で希望シフトの受付を開始できます。';
    }

    case 'open': {
      const period = await requirePeriod(args[0]);
      await repo.updatePeriod(period.id, { status: 'collecting' });
      await client.chat.postMessage({
        channel: config.slack.shiftChannel,
        text: `:memo: *${period.name}*（${period.start_date}〜${period.end_date}）の希望シフト受付を開始しました。\n`
          + (period.request_deadline ? `提出期限: *${period.request_deadline}*\n` : '')
          + '`/shift-request` から入力してください。',
      });
      return `:white_check_mark: #${period.id} の受付を開始し、チャンネルに告知しました。`;
    }

    case 'close': {
      const period = await requirePeriod(args[0]);
      await repo.updatePeriod(period.id, { status: 'draft' });
      return `:white_check_mark: #${period.id} の希望シフト受付を終了しました。`;
    }

    case 'status': {
      const period = await requirePeriod(args[0]);
      const [staff, submitted] = await Promise.all([
        repo.listStaff({ activeOnly: true }),
        repo.listStaffIdsWithRequests(period.id),
      ]);
      const done = staff.filter((s) => submitted.has(s.id));
      const notYet = staff.filter((s) => !submitted.has(s.id));
      return [
        `*${period.name} の提出状況*（${done.length}/${staff.length}名）`,
        `提出済み: ${done.map((s) => s.name).join('、') || 'なし'}`,
        `未提出: ${notYet.map((s) => s.name).join('、') || 'なし'}`,
      ].join('\n');
    }

    case 'assign': {
      const period = await requirePeriod(args[0]);
      const result = await runAutoAssign(period.id);
      const lines = [
        `:white_check_mark: *${period.name}* の自動割当が完了しました（${result.assignments.length}件）。`,
      ];
      if (result.unfilled.length > 0) {
        lines.push(`:warning: 埋まらなかった枠が ${result.unfilled.length} 件あります。管理画面で調整してください。`);
      }
      if (result.issues.length > 0) {
        lines.push(`:warning: 検証で ${result.issues.length} 件の指摘があります。`);
      }
      lines.push('人数: ' + result.stats.map((s) => `${s.name} ${s.days}日`).join(' / '));
      lines.push('管理画面で修正のうえ `/shift-admin publish ' + period.id + '` で公開してください。');
      return lines.join('\n');
    }

    case 'publish': {
      const period = await requirePeriod(args[0]);
      const result = await publishSchedule(client, period.id);
      return `:white_check_mark: *${period.name}* を公開しました（DM ${result.dmSent}名）。`
        + (result.dmFailed.length > 0 ? `\n:warning: DM 失敗: ${result.dmFailed.join(' / ')}` : '');
    }

    default:
      return `不明なサブコマンド「${sub}」\n${ADMIN_USAGE}`;
  }
}

async function requirePeriod(idText) {
  const id = Number(idText);
  if (!id) throw new Error('期間IDを指定してください（`/shift-admin periods` で確認）。');
  const period = await repo.getPeriod(id);
  if (!period) throw new Error(`期間 #${id} が見つかりません。`);
  return period;
}

/** 自動割当を実行して保存する。管理Web UI からも使う。 */
export async function runAutoAssign(periodId) {
  const data = await repo.loadPlanningData(periodId);
  const result = autoAssign({ ...data, existingAssignments: data.assignments, rules: config.rules });

  await repo.saveAssignments(periodId, result.assignments, { keepLocked: true });
  await repo.updatePeriod(periodId, { status: 'assigned' });

  const { issues } = validateBoard({ ...data, assignments: result.assignments, rules: config.rules });
  return { ...result, issues };
}
