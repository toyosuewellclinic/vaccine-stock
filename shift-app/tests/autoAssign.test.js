import { describe, it, expect } from 'vitest';
import { autoAssign } from '../src/scheduler/autoAssign.js';
import { validateBoard } from '../src/scheduler/validate.js';
import { eachDate } from '../src/lib/dates.js';

const EARLY = {
  id: 1, code: 'early', name: '早番', start_time: '08:30', end_time: '17:30',
  crosses_midnight: false, active: true, sort_order: 1,
};
const NIGHT = {
  id: 2, code: 'night', name: '夜勤', start_time: '20:00', end_time: '09:00',
  crosses_midnight: true, active: true, sort_order: 2,
};

const RULES = { minRestHours: 11, defaultMaxConsecutiveDays: 5 };

/** 全曜日ぶんの必要人数を作る（テストで曜日を気にしなくて済むように） */
function everyDay(shiftTypeId, count, qualification = null) {
  return [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
    id: `${shiftTypeId}-${dow}-${qualification ?? ''}`,
    shift_type_id: shiftTypeId,
    day_of_week: dow,
    required_count: count,
    required_qualification: qualification,
  }));
}

function staffMember(id, name, overrides = {}) {
  return {
    id, name, qualifications: [], active: true, workload_weight: 1,
    max_consecutive_days: null, max_days_per_period: null, ...overrides,
  };
}

const DATES = eachDate('2026-09-01', '2026-09-05');

describe('autoAssign', () => {
  it('必要人数ぶんを割り当てる', () => {
    const staff = [staffMember(1, 'A'), staffMember(2, 'B'), staffMember(3, 'C')];
    const result = autoAssign({
      dates: DATES,
      staff,
      shiftTypes: [EARLY],
      requirements: everyDay(EARLY.id, 2),
      rules: RULES,
    });

    expect(result.unfilled).toEqual([]);
    expect(result.assignments).toHaveLength(DATES.length * 2);
    for (const date of DATES) {
      expect(result.assignments.filter((a) => a.date === date)).toHaveLength(2);
    }
  });

  it('勤務不可（ng）の希望を出した日には割り当てない', () => {
    const staff = [staffMember(1, 'A'), staffMember(2, 'B'), staffMember(3, 'C')];
    const requests = DATES.map((date) => ({ staff_id: 1, date, preference: 'ng' }));

    const result = autoAssign({
      dates: DATES,
      staff,
      shiftTypes: [EARLY],
      requirements: everyDay(EARLY.id, 2),
      requests,
      rules: RULES,
    });

    expect(result.assignments.some((a) => a.staff_id === 1)).toBe(false);
    expect(result.unfilled).toEqual([]);
  });

  it('資格の下限を満たすように割り当てる', () => {
    const staff = [
      staffMember(1, '看護A', { qualifications: ['看護師'] }),
      staffMember(2, '受付B'),
      staffMember(3, '受付C'),
    ];
    const result = autoAssign({
      dates: DATES,
      staff,
      shiftTypes: [EARLY],
      requirements: [...everyDay(EARLY.id, 2), ...everyDay(EARLY.id, 1, '看護師')],
      rules: RULES,
    });

    for (const date of DATES) {
      const onDuty = result.assignments.filter((a) => a.date === date);
      expect(onDuty).toHaveLength(2);
      expect(onDuty.some((a) => a.staff_id === 1)).toBe(true);
    }
  });

  it('連勤上限を超えない', () => {
    const staff = [
      staffMember(1, 'A', { max_consecutive_days: 2 }),
      staffMember(2, 'B'),
    ];
    const result = autoAssign({
      dates: DATES,
      staff,
      shiftTypes: [EARLY],
      requirements: everyDay(EARLY.id, 1),
      rules: RULES,
    });

    const aDates = result.assignments.filter((a) => a.staff_id === 1).map((a) => a.date).sort();
    let run = 0;
    let maxRun = 0;
    for (let i = 0; i < DATES.length; i++) {
      run = aDates.includes(DATES[i]) ? run + 1 : 0;
      maxRun = Math.max(maxRun, run);
    }
    expect(maxRun).toBeLessThanOrEqual(2);
  });

  it('勤務希望（want）を出した人を優先する', () => {
    const staff = [staffMember(1, 'A'), staffMember(2, 'B')];
    const dates = ['2026-09-01'];
    const result = autoAssign({
      dates,
      staff,
      shiftTypes: [EARLY],
      requirements: everyDay(EARLY.id, 1),
      requests: [{ staff_id: 2, date: '2026-09-01', preference: 'want' }],
      rules: RULES,
    });

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].staff_id).toBe(2);
  });

  it('人数が足りない枠は unfilled として報告する', () => {
    const staff = [staffMember(1, 'A')];
    const result = autoAssign({
      dates: ['2026-09-01'],
      staff,
      shiftTypes: [EARLY],
      requirements: everyDay(EARLY.id, 3),
      rules: RULES,
    });

    expect(result.assignments).toHaveLength(1);
    expect(result.unfilled).toEqual([
      { date: '2026-09-01', shift_type_id: EARLY.id, kind: 'headcount', qualification: null, shortage: 2 },
    ]);
  });

  it('locked の割当は保持し、その枠を埋まったものとして扱う', () => {
    const staff = [staffMember(1, 'A'), staffMember(2, 'B')];
    const locked = [{ date: '2026-09-01', shift_type_id: EARLY.id, staff_id: 2, locked: true }];

    const result = autoAssign({
      dates: ['2026-09-01'],
      staff,
      shiftTypes: [EARLY],
      requirements: everyDay(EARLY.id, 1),
      existingAssignments: locked,
      rules: RULES,
    });

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]).toMatchObject({ staff_id: 2, locked: true });
    expect(result.created).toEqual([]);
  });

  it('休診日には割り当てない', () => {
    const staff = [staffMember(1, 'A'), staffMember(2, 'B')];
    const result = autoAssign({
      dates: DATES,
      staff,
      shiftTypes: [EARLY],
      requirements: everyDay(EARLY.id, 1),
      holidays: [{ date: '2026-09-03', name: '休診' }],
      rules: RULES,
    });

    expect(result.assignments.some((a) => a.date === '2026-09-03')).toBe(false);
    expect(result.assignments).toHaveLength(DATES.length - 1);
  });

  it('勤務間インターバルを守る（夜勤の翌日に早番を入れない）', () => {
    const staff = [staffMember(1, 'A')];
    const result = autoAssign({
      dates: ['2026-09-01', '2026-09-02'],
      staff,
      shiftTypes: [EARLY, NIGHT],
      requirements: [
        ...everyDay(NIGHT.id, 1).filter((r) => r.day_of_week === 2), // 9/1 は火曜
        ...everyDay(EARLY.id, 1).filter((r) => r.day_of_week === 3), // 9/2 は水曜
      ],
      rules: RULES,
    });

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]).toMatchObject({ date: '2026-09-01', shift_type_id: NIGHT.id });
    expect(result.unfilled).toHaveLength(1);
  });

  it('勤務日数を偏らせずにならす', () => {
    const staff = [staffMember(1, 'A'), staffMember(2, 'B'), staffMember(3, 'C')];
    const dates = eachDate('2026-09-01', '2026-09-30');
    const result = autoAssign({
      dates,
      staff,
      shiftTypes: [EARLY],
      requirements: everyDay(EARLY.id, 2),
      rules: { minRestHours: 11, defaultMaxConsecutiveDays: 30 },
    });

    const days = result.stats.map((s) => s.days);
    expect(Math.max(...days) - Math.min(...days)).toBeLessThanOrEqual(1);
  });
});

describe('validateBoard', () => {
  const staff = [
    staffMember(1, '看護A', { qualifications: ['看護師'] }),
    staffMember(2, 'B'),
  ];
  const requirements = [...everyDay(EARLY.id, 2), ...everyDay(EARLY.id, 1, '看護師')];

  it('問題のないシフト表では指摘を出さない', () => {
    const assignments = DATES.flatMap((date) => [
      { date, shift_type_id: EARLY.id, staff_id: 1 },
      { date, shift_type_id: EARLY.id, staff_id: 2 },
    ]);
    const { issues } = validateBoard({
      dates: DATES, staff, shiftTypes: [EARLY], requirements, assignments,
      rules: { minRestHours: 11, defaultMaxConsecutiveDays: 10 },
    });
    // B は 5 連勤だが上限を 10 日にしているため指摘なし
    expect(issues).toEqual([]);
  });

  it('人数不足・資格不足を検出する', () => {
    const assignments = [{ date: '2026-09-01', shift_type_id: EARLY.id, staff_id: 2 }];
    const { issues } = validateBoard({
      dates: ['2026-09-01'], staff, shiftTypes: [EARLY], requirements, assignments, rules: RULES,
    });
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining('1名不足'),
      expect.stringContaining('「看護師」が1名不足'),
    ]);
  });

  it('勤務不可の日への割当と連勤超過を検出する（連勤上限は個人設定が優先）', () => {
    const limited = [staff[0], staffMember(2, 'B', { max_consecutive_days: 2 })];
    const assignments = DATES.map((date) => ({ date, shift_type_id: EARLY.id, staff_id: 2 }));
    const requests = [{ staff_id: 2, date: '2026-09-02', preference: 'ng' }];
    const { issues } = validateBoard({
      dates: DATES, staff: limited, shiftTypes: [EARLY], requirements, assignments, requests, rules: RULES,
    });

    expect(issues.some((i) => i.message.includes('勤務不可の希望'))).toBe(true);
    expect(issues.some((i) => i.message.includes('5連勤（上限2日）'))).toBe(true);
  });

  it('同じ日に2つの割当があれば検出する', () => {
    const assignments = [
      { date: '2026-09-01', shift_type_id: EARLY.id, staff_id: 1 },
      { date: '2026-09-01', shift_type_id: NIGHT.id, staff_id: 1 },
    ];
    const { issues } = validateBoard({
      dates: ['2026-09-01'], staff, shiftTypes: [EARLY, NIGHT],
      requirements: everyDay(EARLY.id, 1), assignments, rules: RULES,
    });
    expect(issues.some((i) => i.message.includes('1日1シフト'))).toBe(true);
  });
});
