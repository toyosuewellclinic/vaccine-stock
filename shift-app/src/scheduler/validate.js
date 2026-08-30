// 手動編集後のシフト表を検証する。自動割当と同じルールを使う。
import { toDayIndex } from '../lib/dates.js';
import {
  PREF,
  buildContext,
  createState,
  hasQualification,
  preferenceOf,
  planSlots,
  shiftWindow,
} from './constraints.js';

/**
 * @returns {{issues: {level:'error'|'warn', date:string, shift_type_id:number|null, staff_id:number|null, message:string}[]}}
 */
export function validateBoard({
  dates,
  staff,
  shiftTypes,
  requirements,
  overrides = [],
  holidays = [],
  requests = [],
  assignments = [],
  rules = {},
}) {
  const ctx = buildContext({ staff, shiftTypes, requests, rules });
  const state = createState(assignments);
  const issues = [];

  // --- スロット単位: 人数・資格 ---
  const slots = planSlots({ dates, shiftTypes, requirements, overrides, holidays });
  const plannedKeys = new Set();

  for (const slot of slots) {
    plannedKeys.add(`${slot.date}|${slot.shiftTypeId}`);
    const typeName = ctx.shiftTypesById.get(slot.shiftTypeId)?.name ?? `#${slot.shiftTypeId}`;
    const assigned = state.bySlot.get(`${slot.date}|${slot.shiftTypeId}`) ?? [];

    if (assigned.length < slot.total) {
      issues.push({
        level: 'error', date: slot.date, shift_type_id: slot.shiftTypeId, staff_id: null,
        message: `${typeName}が${slot.total - assigned.length}名不足（${assigned.length}/${slot.total}名）`,
      });
    } else if (assigned.length > slot.total) {
      issues.push({
        level: 'warn', date: slot.date, shift_type_id: slot.shiftTypeId, staff_id: null,
        message: `${typeName}が${assigned.length - slot.total}名過剰（${assigned.length}/${slot.total}名）`,
      });
    }

    for (const min of slot.minima) {
      const count = assigned.filter((id) => hasQualification(ctx.staffById.get(id) ?? {}, min.qualification)).length;
      if (count < min.count) {
        issues.push({
          level: 'error', date: slot.date, shift_type_id: slot.shiftTypeId, staff_id: null,
          message: `${typeName}の「${min.qualification}」が${min.count - count}名不足（${count}/${min.count}名）`,
        });
      }
    }
  }

  // 必要人数が0の枠（休診日など）に入っている割当
  for (const a of assignments) {
    if (plannedKeys.has(`${a.date}|${a.shift_type_id}`)) continue;
    const typeName = ctx.shiftTypesById.get(a.shift_type_id)?.name ?? `#${a.shift_type_id}`;
    issues.push({
      level: 'warn', date: a.date, shift_type_id: a.shift_type_id, staff_id: a.staff_id,
      message: `休診日・募集のない枠に${typeName}の割当があります`,
    });
  }

  // --- スタッフ単位: 重複・希望・連勤・インターバル・日数上限 ---
  const byStaff = new Map();
  for (const a of assignments) {
    if (!byStaff.has(a.staff_id)) byStaff.set(a.staff_id, []);
    byStaff.get(a.staff_id).push(a);
  }

  for (const [staffId, list] of byStaff) {
    const member = ctx.staffById.get(staffId);
    const name = member?.name ?? `#${staffId}`;
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));

    if (member && member.active === false) {
      issues.push({
        level: 'warn', date: sorted[0].date, shift_type_id: null, staff_id: staffId,
        message: `${name} は在籍対象外ですが割当があります`,
      });
    }

    // 同日重複
    const seen = new Map();
    for (const a of sorted) {
      seen.set(a.date, (seen.get(a.date) ?? 0) + 1);
    }
    for (const [date, count] of seen) {
      if (count > 1) {
        issues.push({
          level: 'error', date, shift_type_id: null, staff_id: staffId,
          message: `${name} が同じ日に${count}件の割当（1日1シフトまで）`,
        });
      }
    }

    // 本人が不可としている日
    for (const a of sorted) {
      if (preferenceOf(ctx.prefIndex, staffId, a.date) === PREF.NG) {
        issues.push({
          level: 'error', date: a.date, shift_type_id: a.shift_type_id, staff_id: staffId,
          message: `${name} は勤務不可の希望を出しています`,
        });
      }
    }

    // 連勤
    const maxRun = member?.max_consecutive_days ?? ctx.defaultMaxConsecutiveDays;
    if (maxRun != null) {
      const days = [...new Set(sorted.map((a) => a.date))].sort();
      let runStart = 0;
      for (let i = 0; i < days.length; i++) {
        const isLast = i === days.length - 1;
        const breaks = isLast || toDayIndex(days[i + 1]) !== toDayIndex(days[i]) + 1;
        if (!breaks) continue;
        const run = i - runStart + 1;
        if (run > maxRun) {
          issues.push({
            level: 'error', date: days[runStart], shift_type_id: null, staff_id: staffId,
            message: `${name} が${run}連勤（上限${maxRun}日）: ${days[runStart]}〜${days[i]}`,
          });
        }
        runStart = i + 1;
      }
    }

    // 勤務間インターバル
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (toDayIndex(cur.date) - toDayIndex(prev.date) > 1) continue;
      const prevType = ctx.shiftTypesById.get(prev.shift_type_id);
      const curType = ctx.shiftTypesById.get(cur.shift_type_id);
      if (!prevType || !curType) continue;
      const gap = shiftWindow(curType, cur.date).start - shiftWindow(prevType, prev.date).end;
      if (gap < ctx.minRestHours * 60) {
        issues.push({
          level: 'error', date: cur.date, shift_type_id: cur.shift_type_id, staff_id: staffId,
          message: `${name} の勤務間隔が${Math.round((gap / 60) * 10) / 10}h（${ctx.minRestHours}h 未満）`,
        });
      }
    }

    // 期間内の勤務日数上限
    const maxDays = member?.max_days_per_period;
    const workedDays = new Set(sorted.map((a) => a.date)).size;
    if (maxDays != null && workedDays > maxDays) {
      issues.push({
        level: 'warn', date: sorted[0].date, shift_type_id: null, staff_id: staffId,
        message: `${name} の勤務日数が${workedDays}日（上限${maxDays}日）`,
      });
    }
  }

  issues.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { issues };
}
