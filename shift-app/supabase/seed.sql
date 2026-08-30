-- ============================================================
-- 初期データのサンプル。自院の実態に合わせて書き換えて実行する。
-- ============================================================

-- シフト種別
insert into shift_types (code, name, start_time, end_time, crosses_midnight, break_minutes, sort_order)
values
  ('early', '早番', '08:30', '17:30', false, 60, 1),
  ('late',  '遅番', '11:00', '20:00', false, 60, 2)
on conflict (code) do nothing;

-- 必要人数（月〜金は早番2/遅番2、土は早番2のみ、日は休診）
insert into shift_requirements (shift_type_id, day_of_week, required_count, required_qualification)
select t.id, d.dow, d.cnt, d.qual
from shift_types t
join (values
  ('early', 1, 2, null), ('early', 2, 2, null), ('early', 3, 2, null),
  ('early', 4, 2, null), ('early', 5, 2, null), ('early', 6, 2, null),
  ('late',  1, 2, null), ('late',  2, 2, null), ('late',  3, 2, null),
  ('late',  4, 2, null), ('late',  5, 2, null),
  -- 早番の2名のうち看護師が1名以上（資格つきの行は総人数の内数の下限として扱う）
  ('early', 1, 1, '看護師'), ('early', 2, 1, '看護師'), ('early', 3, 1, '看護師'),
  ('early', 4, 1, '看護師'), ('early', 5, 1, '看護師'), ('early', 6, 1, '看護師')
) as d(code, dow, cnt, qual) on d.code = t.code
on conflict (shift_type_id, day_of_week, required_qualification) do nothing;

-- スタッフ（slack_user_id は Slack のプロフィールから取得した U... を入れる）
insert into shift_staff (slack_user_id, name, qualifications, is_admin, workload_weight)
values
  ('U000ADMIN01', '管理 太郎', '{受付}',        true,  1),
  ('U000STAFF01', '看護 花子', '{看護師}',      false, 1),
  ('U000STAFF02', '看護 次郎', '{看護師}',      false, 1),
  ('U000STAFF03', '受付 三郎', '{受付}',        false, 0.6)
on conflict (slack_user_id) do nothing;
