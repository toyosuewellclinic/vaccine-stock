import { supabase, unwrap } from './supabase.js';
import { eachDate } from '../lib/dates.js';

// ------------------------------------------------------------
// スタッフ
// ------------------------------------------------------------
export async function listStaff({ activeOnly = true } = {}) {
  let q = supabase.from('shift_staff').select('*').order('id');
  if (activeOnly) q = q.eq('active', true);
  return unwrap(await q, 'スタッフ一覧の取得');
}

export async function getStaffBySlackId(slackUserId) {
  const rows = unwrap(
    await supabase.from('shift_staff').select('*').eq('slack_user_id', slackUserId).limit(1),
    'スタッフの取得',
  );
  return rows[0] ?? null;
}

export async function getStaffById(id) {
  const rows = unwrap(await supabase.from('shift_staff').select('*').eq('id', id).limit(1), 'スタッフの取得');
  return rows[0] ?? null;
}

// ------------------------------------------------------------
// シフト種別・必要人数・休診日
// ------------------------------------------------------------
export async function listShiftTypes() {
  return unwrap(
    await supabase.from('shift_types').select('*').eq('active', true).order('sort_order').order('id'),
    'シフト種別の取得',
  );
}

export async function listRequirements() {
  return unwrap(await supabase.from('shift_requirements').select('*'), '必要人数の取得');
}

export async function listOverrides(startDate, endDate) {
  return unwrap(
    await supabase.from('shift_requirement_overrides').select('*').gte('date', startDate).lte('date', endDate),
    '必要人数（日付指定）の取得',
  );
}

export async function listHolidays(startDate, endDate) {
  return unwrap(
    await supabase.from('clinic_holidays').select('*').gte('date', startDate).lte('date', endDate),
    '休診日の取得',
  );
}

// ------------------------------------------------------------
// シフト期間
// ------------------------------------------------------------
export async function listPeriods() {
  return unwrap(
    await supabase.from('shift_periods').select('*').order('start_date', { ascending: false }),
    'シフト期間一覧の取得',
  );
}

export async function getPeriod(id) {
  const rows = unwrap(await supabase.from('shift_periods').select('*').eq('id', id).limit(1), 'シフト期間の取得');
  return rows[0] ?? null;
}

/** 希望シフトを受付中の期間（複数あれば開始日が早いもの） */
export async function getCollectingPeriod() {
  const rows = unwrap(
    await supabase.from('shift_periods').select('*').eq('status', 'collecting').order('start_date').limit(1),
    '受付中シフト期間の取得',
  );
  return rows[0] ?? null;
}

export async function listCollectingPeriods() {
  return unwrap(
    await supabase.from('shift_periods').select('*').eq('status', 'collecting').order('start_date'),
    '受付中シフト期間の取得',
  );
}

export async function createPeriod(period) {
  const rows = unwrap(await supabase.from('shift_periods').insert(period).select(), 'シフト期間の作成');
  return rows[0];
}

export async function updatePeriod(id, patch) {
  const rows = unwrap(await supabase.from('shift_periods').update(patch).eq('id', id).select(), 'シフト期間の更新');
  return rows[0];
}

// ------------------------------------------------------------
// 希望シフト
// ------------------------------------------------------------
export async function listRequests(periodId) {
  return unwrap(await supabase.from('shift_requests').select('*').eq('period_id', periodId), '希望シフトの取得');
}

export async function listRequestsByStaff(periodId, staffId) {
  return unwrap(
    await supabase.from('shift_requests').select('*').eq('period_id', periodId).eq('staff_id', staffId),
    '希望シフトの取得',
  );
}

/** 1名ぶんの希望を丸ごと置き換える */
export async function replaceRequests(periodId, staffId, rows) {
  unwrap(
    await supabase.from('shift_requests').delete().eq('period_id', periodId).eq('staff_id', staffId),
    '希望シフトの削除',
  );
  if (rows.length === 0) return [];
  const payload = rows.map((r) => ({
    period_id: periodId,
    staff_id: staffId,
    date: r.date,
    preference: r.preference,
    note: r.note ?? null,
  }));
  return unwrap(await supabase.from('shift_requests').insert(payload).select(), '希望シフトの登録');
}

/** 期間内に1件でも希望を出しているスタッフ ID の集合 */
export async function listStaffIdsWithRequests(periodId) {
  const rows = unwrap(
    await supabase.from('shift_requests').select('staff_id').eq('period_id', periodId),
    '希望シフト提出状況の取得',
  );
  return new Set(rows.map((r) => r.staff_id));
}

// ------------------------------------------------------------
// 割当
// ------------------------------------------------------------
export async function listAssignments(periodId) {
  return unwrap(
    await supabase.from('shift_assignments').select('*').eq('period_id', periodId).order('date'),
    '割当の取得',
  );
}

export async function listAssignmentsByDate(date) {
  return unwrap(await supabase.from('shift_assignments').select('*').eq('date', date), '割当の取得');
}

export async function listUpcomingAssignments(staffId, fromDate, toDate) {
  return unwrap(
    await supabase.from('shift_assignments').select('*')
      .eq('staff_id', staffId).gte('date', fromDate).lte('date', toDate)
      .neq('status', 'swapped').order('date'),
    '今後の勤務の取得',
  );
}

export async function getAssignment(id) {
  const rows = unwrap(await supabase.from('shift_assignments').select('*').eq('id', id).limit(1), '割当の取得');
  return rows[0] ?? null;
}

export async function updateAssignment(id, patch) {
  const rows = unwrap(await supabase.from('shift_assignments').update(patch).eq('id', id).select(), '割当の更新');
  return rows[0];
}

/**
 * 期間の割当を保存する。keepLocked=true のときは locked=true の行を残し、
 * それ以外を渡された内容で置き換える。
 */
export async function saveAssignments(periodId, rows, { keepLocked = false } = {}) {
  let del = supabase.from('shift_assignments').delete().eq('period_id', periodId);
  if (keepLocked) del = del.eq('locked', false);
  unwrap(await del, '割当の削除');

  const payload = rows
    .filter((r) => !(keepLocked && r.locked))
    .map((r) => ({
      period_id: periodId,
      date: r.date,
      shift_type_id: r.shift_type_id,
      staff_id: r.staff_id,
      locked: !!r.locked,
      status: r.status ?? 'assigned',
      note: r.note ?? null,
    }));
  if (payload.length === 0) return [];
  return unwrap(await supabase.from('shift_assignments').insert(payload).select(), '割当の保存');
}

// ------------------------------------------------------------
// 交代・欠勤申請
// ------------------------------------------------------------
export async function createSwapRequest(row) {
  const rows = unwrap(await supabase.from('shift_swap_requests').insert(row).select(), '交代申請の作成');
  return rows[0];
}

export async function getSwapRequest(id) {
  const rows = unwrap(await supabase.from('shift_swap_requests').select('*').eq('id', id).limit(1), '交代申請の取得');
  return rows[0] ?? null;
}

export async function updateSwapRequest(id, patch) {
  const rows = unwrap(
    await supabase.from('shift_swap_requests').update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id).select(),
    '交代申請の更新',
  );
  return rows[0];
}

// ------------------------------------------------------------
// 通知の重複よけ
// ------------------------------------------------------------
/** まだ送っていなければ記録して true を返す（送信済みなら false） */
export async function claimNotification(kind, targetKey) {
  const { error } = await supabase.from('shift_notifications').insert({ kind, target_key: targetKey });
  if (!error) return true;
  if (error.code === '23505') return false; // unique 制約 = 送信済み
  throw new Error(`通知記録の登録: ${error.message}`);
}

// ------------------------------------------------------------
// 自動割当・検証に必要なデータをまとめて取得
// ------------------------------------------------------------
export async function loadPlanningData(periodId) {
  const period = await getPeriod(periodId);
  if (!period) throw new Error(`シフト期間 #${periodId} が見つかりません`);

  const [staff, shiftTypes, requirements, overrides, holidays, requests, assignments] = await Promise.all([
    listStaff({ activeOnly: true }),
    listShiftTypes(),
    listRequirements(),
    listOverrides(period.start_date, period.end_date),
    listHolidays(period.start_date, period.end_date),
    listRequests(periodId),
    listAssignments(periodId),
  ]);

  return {
    period,
    dates: eachDate(period.start_date, period.end_date),
    staff,
    shiftTypes,
    requirements,
    overrides,
    holidays,
    requests,
    assignments,
  };
}
