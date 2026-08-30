import cron from 'node-cron';
import { config } from '../config.js';
import * as repo from '../db/repositories.js';
import { todayIn, addDays, daysBetween, formatJa } from '../lib/dates.js';
import { dmUser } from '../slack/notify.js';

// 締切の何日前にリマインドするか（当日=0）
const DEADLINE_OFFSETS = [3, 1, 0];

/** 希望シフト未提出者へのリマインド */
export async function runDeadlineReminder(client) {
  const today = todayIn(config.timezone);
  const periods = await repo.listCollectingPeriods();
  let sent = 0;

  for (const period of periods) {
    if (!period.request_deadline) continue;
    const left = daysBetween(today, period.request_deadline);
    if (!DEADLINE_OFFSETS.includes(left)) continue;

    const [staff, submitted] = await Promise.all([
      repo.listStaff({ activeOnly: true }),
      repo.listStaffIdsWithRequests(period.id),
    ]);
    const pending = staff.filter((s) => !submitted.has(s.id) && s.slack_user_id);
    if (pending.length === 0) continue;

    for (const member of pending) {
      if (!(await repo.claimNotification('deadline_reminder', `${period.id}:${member.id}:${left}`))) continue;
      const when = left === 0 ? '*本日*' : `*あと${left}日*`;
      await dmUser(client, member.slack_user_id,
        `:memo: *${period.name}* の希望シフトが未提出です（締切 ${period.request_deadline} / ${when}）。\n`
        + '`/shift-request` から入力をお願いします。');
      sent++;
    }

    if (await repo.claimNotification('deadline_reminder_channel', `${period.id}:${left}`)) {
      await client.chat.postMessage({
        channel: config.slack.shiftChannel,
        text: `:alarm_clock: *${period.name}* の希望シフト締切は ${period.request_deadline} です。`
          + `未提出: ${pending.map((s) => s.name).join('、')}`,
      });
    }
  }
  return { sent };
}

/** 翌日の勤務のリマインド */
export async function runTomorrowReminder(client) {
  const tomorrow = addDays(todayIn(config.timezone), 1);
  const [assignments, shiftTypes] = await Promise.all([
    repo.listAssignmentsByDate(tomorrow),
    repo.listShiftTypes(),
  ]);
  const working = assignments.filter((a) => a.status === 'assigned');
  if (working.length === 0) return { sent: 0 };

  const typeById = new Map(shiftTypes.map((t) => [t.id, t]));
  let sent = 0;

  for (const a of working) {
    const member = await repo.getStaffById(a.staff_id);
    if (!member?.slack_user_id) continue;
    if (!(await repo.claimNotification('tomorrow_reminder', `${tomorrow}:${a.staff_id}:${a.shift_type_id}`))) continue;
    const t = typeById.get(a.shift_type_id);
    const time = t ? `${t.name} ${t.start_time.slice(0, 5)}-${t.end_time.slice(0, 5)}` : '';
    await dmUser(client, member.slack_user_id, `:sunny: 明日 ${formatJa(tomorrow)} は *${time}* です。よろしくお願いします。`);
    sent++;
  }

  if (await repo.claimNotification('tomorrow_reminder_channel', tomorrow)) {
    const lines = [];
    for (const type of shiftTypes) {
      const rows = working.filter((a) => a.shift_type_id === type.id);
      if (rows.length === 0) continue;
      const names = [];
      for (const a of rows) {
        const member = await repo.getStaffById(a.staff_id);
        names.push(member?.name ?? `#${a.staff_id}`);
      }
      lines.push(`　${type.name}: ${names.join('、')}`);
    }
    await client.chat.postMessage({
      channel: config.slack.shiftChannel,
      text: `:sunny: *明日 ${formatJa(tomorrow)} の勤務*\n${lines.join('\n')}`,
    });
  }

  return { sent };
}

/** cron を起動する */
export function startReminders(app) {
  if (!config.cron.enabled) {
    console.log('[cron] ENABLE_CRON=false のため定期実行は起動しません');
    return [];
  }
  const options = { timezone: config.timezone };
  const jobs = [
    cron.schedule(config.cron.deadlineReminder, () => safeRun('deadline', () => runDeadlineReminder(app.client)), options),
    cron.schedule(config.cron.tomorrowReminder, () => safeRun('tomorrow', () => runTomorrowReminder(app.client)), options),
  ];
  console.log(`[cron] 締切リマインド: ${config.cron.deadlineReminder} / 翌日リマインド: ${config.cron.tomorrowReminder}（${config.timezone}）`);
  return jobs;
}

async function safeRun(name, fn) {
  try {
    const result = await fn();
    console.log(`[cron] ${name} 完了`, result);
  } catch (err) {
    console.error(`[cron] ${name} 失敗:`, err);
  }
}
