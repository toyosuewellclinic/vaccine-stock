// Slack に出す文字列・ブロックの組み立て。
import { formatJa, eachDate } from '../lib/dates.js';

export const PREF_LABEL = { want: '◎ 希望', ok: '○ 可', ng: '× 不可' };

export function section(text) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

export function header(text) {
  return { type: 'header', text: { type: 'plain_text', text, emoji: true } };
}

export function context(text) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

export function divider() {
  return { type: 'divider' };
}

/** 期間全体のシフト表を、Slack のメッセージ長に収まる塊に分けて返す */
export function buildScheduleChunks({ period, shiftTypes, staff, assignments }) {
  const staffById = new Map(staff.map((s) => [s.id, s]));
  const typeById = new Map(shiftTypes.map((t) => [t.id, t]));

  const byDate = new Map();
  for (const a of assignments) {
    if (a.status === 'swapped') continue;
    if (!byDate.has(a.date)) byDate.set(a.date, []);
    byDate.get(a.date).push(a);
  }

  const lines = [];
  for (const date of eachDate(period.start_date, period.end_date)) {
    const list = byDate.get(date) ?? [];
    if (list.length === 0) {
      lines.push(`*${formatJa(date)}* 〜 休診・割当なし`);
      continue;
    }
    const byType = new Map();
    for (const a of list) {
      if (!byType.has(a.shift_type_id)) byType.set(a.shift_type_id, []);
      byType.get(a.shift_type_id).push(a);
    }
    const parts = [`*${formatJa(date)}*`];
    for (const type of shiftTypes) {
      const rows = byType.get(type.id);
      if (!rows || rows.length === 0) continue;
      const names = rows
        .map((a) => {
          const name = staffById.get(a.staff_id)?.name ?? `#${a.staff_id}`;
          return a.status === 'absent' ? `~${name}~` : name;
        })
        .join('、');
      parts.push(`　${type.name}(${type.start_time.slice(0, 5)}-${type.end_time.slice(0, 5)}): ${names}`);
    }
    for (const [typeId, rows] of byType) {
      if (typeById.has(typeId)) continue;
      parts.push(`　#${typeId}: ${rows.length}名`);
    }
    lines.push(parts.join('\n'));
  }

  return chunkLines(lines, 2800);
}

/** 個人あての勤務一覧 */
export function buildPersonalSchedule({ period, shiftTypes, assignments, staffId }) {
  const typeById = new Map(shiftTypes.map((t) => [t.id, t]));
  const mine = assignments
    .filter((a) => a.staff_id === staffId && a.status !== 'swapped')
    .sort((a, b) => a.date.localeCompare(b.date));

  if (mine.length === 0) return `*${period.name}* の勤務はありません。`;

  const lines = mine.map((a) => {
    const t = typeById.get(a.shift_type_id);
    const time = t ? `${t.name} ${t.start_time.slice(0, 5)}-${t.end_time.slice(0, 5)}` : `#${a.shift_type_id}`;
    const mark = a.status === 'absent' ? '（欠勤）' : '';
    return `• ${formatJa(a.date)} ${time}${mark}`;
  });

  return `*${period.name}* のあなたの勤務（全${mine.length}日）\n${lines.join('\n')}`;
}

export function chunkLines(lines, maxLength) {
  const chunks = [];
  let buf = '';
  for (const line of lines) {
    if (buf && buf.length + line.length + 1 > maxLength) {
      chunks.push(buf);
      buf = '';
    }
    buf = buf ? `${buf}\n${line}` : line;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** 交代・欠勤申請の募集メッセージ */
export function swapRequestBlocks({ swap, requester, volunteer, assignment, shiftType }) {
  const kindLabel = swap.kind === 'absence' ? '欠勤申請' : '交代希望';
  const time = shiftType
    ? `${shiftType.name} ${shiftType.start_time.slice(0, 5)}-${shiftType.end_time.slice(0, 5)}`
    : '';
  const head = `:rotating_light: *${kindLabel}* ${formatJa(assignment.date)} ${time}`;
  const body = [
    `申請者: ${requester?.name ?? '不明'}`,
    swap.reason ? `理由: ${swap.reason}` : null,
  ].filter(Boolean).join('\n');

  const blocks = [section(`${head}\n${body}`)];

  if (swap.status === 'open') {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: '代われます', emoji: true },
          action_id: 'swap_volunteer',
          value: String(swap.id),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '申請を取り消す', emoji: true },
          action_id: 'swap_cancel',
          value: String(swap.id),
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: '欠勤として承認（管理者）', emoji: true },
          action_id: 'swap_approve_absence',
          value: String(swap.id),
        },
      ],
    });
    blocks.push(context(
      '代わりに入れる方は「代われます」を押してください。管理者の承認後に確定します。'
      + '\n代わりが見つからない場合、管理者は「欠勤として承認」で欠員のまま確定できます。',
    ));
  } else if (swap.status === 'claimed') {
    blocks.push(context(`:raising_hand: ${volunteer?.name ?? '不明'} さんが立候補中です。管理者の承認待ち。`));
  } else if (swap.status === 'approved') {
    blocks.push(context(
      volunteer
        ? `:white_check_mark: 承認済み: ${volunteer.name} さんに交代しました。`
        : ':white_check_mark: 承認済み: 欠勤として確定しました（欠員のまま）。',
    ));
  } else if (swap.status === 'rejected') {
    blocks.push(context(':x: 却下されました。'));
  } else if (swap.status === 'cancelled') {
    blocks.push(context(':wastebasket: 申請は取り消されました。'));
  }

  return blocks;
}

export function swapApprovalBlocks({ swap, requester, volunteer, assignment, shiftType }) {
  const time = shiftType ? `${shiftType.name} ${shiftType.start_time.slice(0, 5)}-${shiftType.end_time.slice(0, 5)}` : '';
  return [
    section(
      `:inbox_tray: *交代の承認依頼*\n`
      + `${formatJa(assignment.date)} ${time}\n`
      + `${requester?.name ?? '不明'} → ${volunteer?.name ?? '不明'}\n`
      + (swap.reason ? `理由: ${swap.reason}` : ''),
    ),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: '承認', emoji: true },
          action_id: 'swap_approve',
          value: String(swap.id),
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: '却下', emoji: true },
          action_id: 'swap_reject',
          value: String(swap.id),
        },
      ],
    },
  ];
}
