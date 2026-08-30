import { describe, it, expect } from 'vitest';
import { addDays, dayOfWeek, daysBetween, eachDate, formatJa, timeToMinutes, toDayIndex } from '../src/lib/dates.js';

describe('dates', () => {
  it('曜日が JavaScript の Date と一致する', () => {
    for (const date of eachDate('2026-01-01', '2026-03-31')) {
      expect(dayOfWeek(date)).toBe(new Date(`${date}T00:00:00Z`).getUTCDay());
    }
  });

  it('月またぎ・年またぎで日付を進められる', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('期間を列挙する', () => {
    expect(eachDate('2026-09-29', '2026-10-02')).toEqual([
      '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02',
    ]);
    expect(eachDate('2026-09-01', '2026-09-01')).toEqual(['2026-09-01']);
  });

  it('日数差を求める', () => {
    expect(daysBetween('2026-09-01', '2026-09-10')).toBe(9);
    expect(daysBetween('2026-09-10', '2026-09-01')).toBe(-9);
  });

  it('日付インデックスは連続する', () => {
    expect(toDayIndex('2026-09-02') - toDayIndex('2026-09-01')).toBe(1);
  });

  it('日本語表記にする', () => {
    expect(formatJa('2026-09-01')).toBe('9/1(火)');
  });

  it('時刻を分に直す', () => {
    expect(timeToMinutes('08:30')).toBe(510);
    expect(timeToMinutes('20:00:00')).toBe(1200);
  });
});
