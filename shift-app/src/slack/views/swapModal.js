import { formatJa } from '../../lib/dates.js';

export const SWAP_MODAL_CALLBACK = 'shift_swap_modal';

const KIND_OPTIONS = [
  { value: 'swap', text: '交代希望（代わりの人を探す）' },
  { value: 'absence', text: '欠勤申請（休ませてほしい）' },
];

function option(o) {
  return { text: { type: 'plain_text', text: o.text, emoji: true }, value: o.value };
}

/**
 * 自分の今後の勤務から1つ選んで交代・欠勤を申請するモーダル。
 * @param {{assignments: object[], shiftTypes: object[]}} params
 */
export function buildSwapModal({ assignments, shiftTypes }) {
  const typeById = new Map(shiftTypes.map((t) => [t.id, t]));
  const options = assignments.slice(0, 100).map((a) => {
    const t = typeById.get(a.shift_type_id);
    const label = `${formatJa(a.date)} ${t ? t.name : `#${a.shift_type_id}`}`;
    return { text: { type: 'plain_text', text: label, emoji: true }, value: String(a.id) };
  });

  return {
    type: 'modal',
    callback_id: SWAP_MODAL_CALLBACK,
    title: { type: 'plain_text', text: '交代・欠勤の申請' },
    submit: { type: 'plain_text', text: '申請する' },
    close: { type: 'plain_text', text: 'やめる' },
    blocks: [
      {
        type: 'input',
        block_id: 'assignment',
        label: { type: 'plain_text', text: '対象の勤務' },
        element: { type: 'static_select', action_id: 'value', options },
      },
      {
        type: 'input',
        block_id: 'kind',
        label: { type: 'plain_text', text: '申請の種類' },
        element: {
          type: 'radio_buttons',
          action_id: 'value',
          initial_option: option(KIND_OPTIONS[0]),
          options: KIND_OPTIONS.map(option),
        },
      },
      {
        type: 'input',
        block_id: 'reason',
        optional: true,
        label: { type: 'plain_text', text: '理由（任意）' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          placeholder: { type: 'plain_text', text: '例: 家族の通院付き添いのため' },
        },
      },
    ],
  };
}

export function parseSwapSubmission(view) {
  const v = view.state.values;
  return {
    assignmentId: Number(v.assignment.value.selected_option.value),
    kind: v.kind.value.selected_option.value,
    reason: v.reason?.value?.value?.trim() || null,
  };
}
