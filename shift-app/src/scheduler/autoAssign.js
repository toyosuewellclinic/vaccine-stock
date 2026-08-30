// 制約を満たす範囲でシフトを自動割当する。DB には触らない純粋関数。
import {
  PREF,
  buildContext,
  createState,
  addToState,
  assignedStaffOf,
  checkEligibility,
  hasQualification,
  preferenceOf,
  scoreCandidate,
  planSlots,
  workedDaysOf,
} from './constraints.js';

/**
 * @returns {{
 *   assignments: {date:string, shift_type_id:number, staff_id:number, locked:boolean}[],
 *   created: {date:string, shift_type_id:number, staff_id:number}[],
 *   unfilled: {date:string, shift_type_id:number, kind:string, qualification:string|null, shortage:number}[],
 *   stats: {staff_id:number, name:string, days:number, want_total:number, want_honored:number}[]
 * }}
 */
export function autoAssign({
  dates,
  staff,
  shiftTypes,
  requirements,
  overrides = [],
  holidays = [],
  requests = [],
  existingAssignments = [],
  rules = {},
}) {
  const ctx = buildContext({ staff, shiftTypes, requests, rules });
  const locked = existingAssignments.filter((a) => a.locked);
  const state = createState(locked);

  const slots = planSlots({ dates, shiftTypes, requirements, overrides, holidays });
  const slotsByDate = new Map();
  for (const slot of slots) {
    if (!slotsByDate.has(slot.date)) slotsByDate.set(slot.date, []);
    slotsByDate.get(slot.date).push(slot);
  }

  const created = [];
  const unfilled = [];
  const sortedDates = [...slotsByDate.keys()].sort();

  for (const date of sortedDates) {
    const daySlots = slotsByDate.get(date);

    // 候補が少ないシフトから埋める（埋まらないスロットを減らすため）
    const ordered = [...daySlots].sort((a, b) => {
      const ca = countCandidates(ctx, state, staff, date, a);
      const cb = countCandidates(ctx, state, staff, date, b);
      if (ca !== cb) return ca - cb;
      return a.shiftTypeId - b.shiftTypeId;
    });

    for (const slot of ordered) {
      const shiftType = ctx.shiftTypesById.get(slot.shiftTypeId);
      if (!shiftType) continue;

      // 1) 資格の下限を先に満たす
      for (const min of slot.minima) {
        const already = assignedStaffOf(state, date, slot.shiftTypeId)
          .filter((id) => hasQualification(ctx.staffById.get(id) ?? {}, min.qualification)).length;
        let need = min.count - already;
        while (need > 0) {
          const pick = bestCandidate(ctx, state, staff, date, shiftType, min.qualification);
          if (!pick) break;
          addToState(state, { date, shiftTypeId: slot.shiftTypeId, staffId: pick.id });
          created.push({ date, shift_type_id: slot.shiftTypeId, staff_id: pick.id });
          need--;
        }
        if (need > 0) {
          unfilled.push({
            date,
            shift_type_id: slot.shiftTypeId,
            kind: 'qualification',
            qualification: min.qualification,
            shortage: need,
          });
        }
      }

      // 2) 総人数まで埋める
      let need = slot.total - assignedStaffOf(state, date, slot.shiftTypeId).length;
      while (need > 0) {
        const pick = bestCandidate(ctx, state, staff, date, shiftType, null);
        if (!pick) break;
        addToState(state, { date, shiftTypeId: slot.shiftTypeId, staffId: pick.id });
        created.push({ date, shift_type_id: slot.shiftTypeId, staff_id: pick.id });
        need--;
      }
      if (need > 0) {
        unfilled.push({
          date,
          shift_type_id: slot.shiftTypeId,
          kind: 'headcount',
          qualification: null,
          shortage: need,
        });
      }
    }
  }

  const assignments = [
    ...locked.map((a) => ({
      date: a.date, shift_type_id: a.shift_type_id, staff_id: a.staff_id, locked: true,
    })),
    ...created.map((a) => ({ ...a, locked: false })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.shift_type_id - b.shift_type_id || a.staff_id - b.staff_id);

  return { assignments, created, unfilled, stats: buildStats(ctx, state, staff, dates) };
}

function candidates(ctx, state, staff, date, shiftType, qualification) {
  const out = [];
  for (const s of staff) {
    if (checkEligibility(ctx, state, s, date, shiftType, qualification).ok) out.push(s);
  }
  return out;
}

function countCandidates(ctx, state, staff, date, slot) {
  const shiftType = ctx.shiftTypesById.get(slot.shiftTypeId);
  if (!shiftType) return 0;
  return candidates(ctx, state, staff, date, shiftType, null).length;
}

function bestCandidate(ctx, state, staff, date, shiftType, qualification) {
  let best = null;
  let bestScore = -Infinity;
  for (const s of candidates(ctx, state, staff, date, shiftType, qualification)) {
    const score = scoreCandidate(ctx, state, s, date);
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

function buildStats(ctx, state, staff, dates) {
  const dateSet = new Set(dates);
  return staff.map((s) => {
    let wantTotal = 0;
    let wantHonored = 0;
    for (const date of dateSet) {
      if (preferenceOf(ctx.prefIndex, s.id, date) !== PREF.WANT) continue;
      wantTotal++;
      if (state.byStaffDate.get(s.id)?.has(date)) wantHonored++;
    }
    return {
      staff_id: s.id,
      name: s.name,
      days: workedDaysOf(state, s.id),
      want_total: wantTotal,
      want_honored: wantHonored,
    };
  });
}
