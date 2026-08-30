import { formatJa } from '../../lib/dates.js';

export const REQUEST_MODAL_CALLBACK = 'shift_request_modal';

const OPTIONS = [
  { value: 'ok', text: '○ 勤務可' },
  { value: 'want', text: '◎ 希望（できれば入りたい）' },
  { value: 'ng', text: '× 勤務不可' },
];

function option(o) {
  return { text: { type: 'plain_text', text: o.text, emoji: true }, value: o.value };
}

/**
 * 希望シフト入力モーダル。日付ごとに ○ / ◎ / × を選ぶ。
 * @param {{period: object, dates: string[], existing: Map<string,string>, existingNote?: string}} params
 */
export function buildRequestModal({ period, dates, existing = new Map(), existingNote = '' }) {
  // Slack のモーダルは 100 ブロックまで。1か月（最大31日）なら余裕がある。
  const usable = dates.slice(0, 95);

  const blocks = [
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `*${period.name}*（${period.start_date} 〜 ${period.end_date}）`
          + (period.request_deadline ? `\n提出期限: ${period.request_deadline}` : ''),
      }],
    },
    { type: 'divider' },
  ];

  for (const date of usable) {
    const current = existing.get(date) ?? 'ok';
    const initial = OPTIONS.find((o) => o.value === current) ?? OPTIONS[0];
    blocks.push({
      type: 'input',
      block_id: `d:${date}`,
      optional: true,
      label: { type: 'plain_text', text: formatJa(date), emoji: true },
      element: {
        type: 'static_select',
        action_id: 'pref',
        initial_option: option(initial),
        options: OPTIONS.map(option),
      },
    });
  }

  blocks.push({
    type: 'input',
    block_id: 'note',
    optional: true,
    label: { type: 'plain_text', text: '備考（任意）', emoji: true },
    element: {
      type: 'plain_text_input',
      action_id: 'value',
      multiline: true,
      initial_value: existingNote || undefined,
      placeholder: { type: 'plain_text', text: '例: 9/15は午前のみ可能です' },
    },
  });

  if (dates.length > usable.length) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:warning: 期間が長いため最初の${usable.length}日ぶんのみ表示しています。` }],
    });
  }

  return {
    type: 'modal',
    callback_id: REQUEST_MODAL_CALLBACK,
    private_metadata: JSON.stringify({ periodId: period.id }),
    title: { type: 'plain_text', text: '希望シフトの提出' },
    submit: { type: 'plain_text', text: '提出する' },
    close: { type: 'plain_text', text: 'やめる' },
    blocks,
  };
}

/** モーダルの入力値を希望シフト行に変換する */
export function parseRequestSubmission(view) {
  const { periodId } = JSON.parse(view.private_metadata || '{}');
  const values = view.state.values;
  const rows = [];
  let note = null;

  for (const [blockId, block] of Object.entries(values)) {
    if (blockId === 'note') {
      note = block.value?.value?.trim() || null;
      continue;
    }
    if (!blockId.startsWith('d:')) continue;
    const date = blockId.slice(2);
    const selected = block.pref?.selected_option?.value;
    if (!selected) continue;
    rows.push({ date, preference: selected });
  }

  // 備考は行ごとに持たせず、× / ◎ の日にだけ添える（全日に同じ文言が並ぶのを避ける）
  for (const row of rows) {
    if (note && row.preference !== 'ok') row.note = note;
  }

  return { periodId, rows, note };
}
