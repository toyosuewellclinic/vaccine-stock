import { config } from '../config.js';
import * as repo from '../db/repositories.js';
import { buildScheduleChunks, buildPersonalSchedule } from './blocks.js';

/** ユーザーに DM を送る */
export async function dmUser(client, slackUserId, text) {
  if (!slackUserId) return null;
  const im = await client.conversations.open({ users: slackUserId });
  return client.chat.postMessage({ channel: im.channel.id, text });
}

/**
 * 確定シフトをチャンネルに投稿し、各自に自分の勤務を DM する。
 * @returns {{channel: string, ts: string, dmSent: number, dmFailed: string[]}}
 */
export async function publishSchedule(client, periodId, { dm = true, channel } = {}) {
  const data = await repo.loadPlanningData(periodId);
  const target = channel || config.slack.shiftChannel;

  const chunks = buildScheduleChunks({
    period: data.period,
    shiftTypes: data.shiftTypes,
    staff: data.staff,
    assignments: data.assignments,
  });

  const head = await client.chat.postMessage({
    channel: target,
    text: `:calendar: ${data.period.name} のシフトが確定しました（${data.period.start_date} 〜 ${data.period.end_date}）`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `📅 ${data.period.name} シフト確定`, emoji: true },
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `${data.period.start_date} 〜 ${data.period.end_date}　/　スレッドに日別の割当を投稿します`,
        }],
      },
    ],
  });

  for (const chunk of chunks) {
    await client.chat.postMessage({ channel: target, thread_ts: head.ts, text: chunk });
  }

  let dmSent = 0;
  const dmFailed = [];
  if (dm) {
    for (const member of data.staff) {
      if (!member.slack_user_id) continue;
      const text = buildPersonalSchedule({
        period: data.period,
        shiftTypes: data.shiftTypes,
        assignments: data.assignments,
        staffId: member.id,
      });
      try {
        await dmUser(client, member.slack_user_id, `シフトが確定しました。\n\n${text}`);
        dmSent++;
      } catch (err) {
        dmFailed.push(`${member.name}: ${err.message}`);
      }
    }
  }

  await repo.updatePeriod(periodId, { status: 'published', published_at: new Date().toISOString() });

  return { channel: head.channel, ts: head.ts, dmSent, dmFailed };
}
