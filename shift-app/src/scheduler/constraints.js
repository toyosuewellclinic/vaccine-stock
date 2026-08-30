// シフト割当のルール判定。DB に依存しない純粋関数のみを置く。
import { toDayIndex, dayOfWeek, timeToMinutes } from '../lib/dates.js';

export const PREF = { NG: 'ng', OK: 'ok', WANT: 'want' };

/** 希望シフトを `${staffId}|${date}` -> preference の Map にする */
export function indexRequests(requests) {
  const map = new Map();
  for (const r of requests) map.set(`${r.staff_id}|${r.date}`, r.preference);
  return map;
}

export function preferenceOf(prefIndex, staffId, date) {
  return prefIndex.get(`${staffId}|${date}`) ?? PREF.OK;
}

/**
 * 日付ごとの必要人数を展開する。
 * 資格なしの要件行 = その日そのシフトの総人数。
 * 資格つきの要件行 = 総人数の内数としての下限。
 * @returns {{date:string, shiftTypeId:number, total:number, minima:{qualification:string,count:number}[]}[]}
 */
export function planSlots({ dates, shiftTypes, requirements, overrides = [], holidays = [] }) {
  const holidaySet = new Set(holidays.map((h) => (typeof h === 'string' ? h : h.date)));
  const overrideIndex = new Map();
  for (const o of overrides) {
    overrideIndex.set(`${o.date}|${o.shift_type_id}|${o.required_qualification ?? ''}`, o.required_count);
  }

  const activeTypes = shiftTypes.filter((t) => t.active !== false);
  const slots = [];

  for (const date of dates) {
    if (holidaySet.has(date)) continue;
    const dow = dayOfWeek(date);

    for (const type of activeTypes) {
      const rows = requirements.filter((r) => r.shift_type_id === type.id && r.day_of_week === dow);

      const totalRow = rows.find((r) => !r.required_qualification);
      const totalOverride = overrideIndex.get(`${date}|${type.id}|`);
      const total = totalOverride ?? totalRow?.required_count ?? 0;

      const minima = [];
      for (const r of rows) {
        if (!r.required_qualification) continue;
        const count = overrideIndex.get(`${date}|${type.id}|${r.required_qualification}`) ?? r.required_count;
        if (count > 0) minima.push({ qualification: r.required_qualification, count });
      }
      // 要件行が無い資格に対する上書きだけが存在するケースも拾う
      for (const o of overrides) {
        if (o.date !== date || o.shift_type_id !== type.id || !o.required_qualification) continue;
        if (minima.some((m) => m.qualification === o.required_qualification)) continue;
        if (o.required_count > 0) minima.push({ qualification: o.required_qualification, count: o.required_count });
      }

      if (total <= 0 && minima.length === 0) continue;
      slots.push({ date, shiftTypeId: type.id, total, minima });
    }
  }
  return slots;
}

/** 割当状態。autoAssign と validate が共有する。 */
export function createState(assignments = []) {
  const state = { byStaffDate: new Map(), bySlot: new Map() };
  for (const a of assignments) {
    addToState(state, { date: a.date, shiftTypeId: a.shift_type_id, staffId: a.staff_id });
  }
  return state;
}

export function addToState(state, { date, shiftTypeId, staffId }) {
  let perStaff = state.byStaffDate.get(staffId);
  if (!perStaff) {
    perStaff = new Map();
    state.byStaffDate.set(staffId, perStaff);
  }
  perStaff.set(date, shiftTypeId);

  const key = `${date}|${shiftTypeId}`;
  const list = state.bySlot.get(key) ?? [];
  if (!list.includes(staffId)) list.push(staffId);
  state.bySlot.set(key, list);
}

export function assignedStaffOf(state, date, shiftTypeId) {
  return state.bySlot.get(`${date}|${shiftTypeId}`) ?? [];
}

export function shiftTypeOnDate(state, staffId, date) {
  return state.byStaffDate.get(staffId)?.get(date) ?? null;
}

export function workedDaysOf(state, staffId) {
  return state.byStaffDate.get(staffId)?.size ?? 0;
}

/** date に入れたと仮定したときの連勤日数 */
export function consecutiveRunWith(state, staffId, date) {
  const days = state.byStaffDate.get(staffId);
  if (!days) return 1;
  const index = toDayIndex(date);
  let run = 1;
  for (let i = index - 1; days.has(dayString(i)); i--) run++;
  for (let i = index + 1; days.has(dayString(i)); i++) run++;
  return run;
}

function dayString(index) {
  return new Date(index * 86400000).toISOString().slice(0, 10);
}

/** シフトの開始・終了を「日付インデックス起点の絶対分」で返す */
export function shiftWindow(shiftType, date) {
  const base = toDayIndex(date) * 1440;
  const start = base + timeToMinutes(shiftType.start_time);
  const end = base + timeToMinutes(shiftType.end_time) + (shiftType.crosses_midnight ? 1440 : 0);
  return { start, end };
}

/** 前日・翌日の勤務との勤務間インターバル違反を返す（無ければ null） */
export function restViolation(state, shiftTypesById, staffId, date, shiftType, minRestHours) {
  const need = minRestHours * 60;
  const here = shiftWindow(shiftType, date);
  const index = toDayIndex(date);

  for (const offset of [-1, 1]) {
    const other = dayString(index + offset);
    const otherTypeId = shiftTypeOnDate(state, staffId, other);
    if (otherTypeId == null) continue;
    const otherType = shiftTypesById.get(otherTypeId);
    if (!otherType) continue;
    const win = shiftWindow(otherType, other);
    const gap = offset === -1 ? here.start - win.end : win.start - here.end;
    if (gap < need) return { date: other, gapHours: Math.round((gap / 60) * 10) / 10 };
  }
  return null;
}

export function hasQualification(staff, qualification) {
  if (!qualification) return true;
  return (staff.qualifications ?? []).includes(qualification);
}

/**
 * 1名をそのスロットに入れられるかを判定する。
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkEligibility(ctx, state, staff, date, shiftType, qualification = null) {
  if (staff.active === false) return { ok: false, reason: '休職中・退職済み' };
  if (!hasQualification(staff, qualification)) return { ok: false, reason: `資格「${qualification}」なし` };

  const assignedType = shiftTypeOnDate(state, staff.id, date);
  if (assignedType != null) {
    return {
      ok: false,
      reason: assignedType === shiftType.id ? '同じシフトに割当済み' : '同日に別シフトあり',
    };
  }

  if (preferenceOf(ctx.prefIndex, staff.id, date) === PREF.NG) return { ok: false, reason: '本人が勤務不可' };

  const maxDays = staff.max_days_per_period;
  if (maxDays != null && workedDaysOf(state, staff.id) >= maxDays) {
    return { ok: false, reason: `期間内の勤務日数上限 ${maxDays} 日` };
  }

  const maxRun = staff.max_consecutive_days ?? ctx.defaultMaxConsecutiveDays;
  const run = consecutiveRunWith(state, staff.id, date);
  if (maxRun != null && run > maxRun) return { ok: false, reason: `連勤上限 ${maxRun} 日超過` };

  const rest = restViolation(state, ctx.shiftTypesById, staff.id, date, shiftType, ctx.minRestHours);
  if (rest) return { ok: false, reason: `${rest.date} の勤務との間隔が ${rest.gapHours}h（${ctx.minRestHours}h 未満）` };

  return { ok: true };
}

/** 割当候補の優先度。大きいほど優先。 */
export function scoreCandidate(ctx, state, staff, date) {
  const weight = Number(staff.workload_weight) > 0 ? Number(staff.workload_weight) : 1;
  const load = workedDaysOf(state, staff.id) / weight;
  const run = consecutiveRunWith(state, staff.id, date);

  let score = 0;
  if (preferenceOf(ctx.prefIndex, staff.id, date) === PREF.WANT) score += 60;
  score -= load * 12;          // 勤務日数の偏りをならす
  score -= (run - 1) * 4;      // 連勤が伸びる人は後回し
  score += tiebreak(`${staff.id}|${date}`); // 同点時の順序を決定的にする
  return score;
}

function tiebreak(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 100000; // 0〜0.01 のごく小さな値
}

export function buildContext({ staff, shiftTypes, requests, rules }) {
  return {
    staffById: new Map(staff.map((s) => [s.id, s])),
    shiftTypesById: new Map(shiftTypes.map((t) => [t.id, t])),
    prefIndex: indexRequests(requests ?? []),
    minRestHours: rules?.minRestHours ?? 11,
    defaultMaxConsecutiveDays: rules?.defaultMaxConsecutiveDays ?? 5,
  };
}
