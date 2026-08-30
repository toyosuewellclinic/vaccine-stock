-- ============================================================
-- シフト作成アプリ スキーマ
-- Supabase SQL Editor に貼り付けて実行する（既存の在庫テーブルには触れない）
-- ============================================================

-- ------------------------------------------------------------
-- スタッフ
-- ------------------------------------------------------------
create table if not exists shift_staff (
  id                     bigint generated always as identity primary key,
  slack_user_id          text unique,                 -- Slack の U... ID
  name                   text not null,
  qualifications         text[] not null default '{}',-- 例: {看護師,受付}
  is_admin               boolean not null default false,
  active                 boolean not null default true,
  workload_weight        numeric not null default 1,  -- 常勤=1 / 週3勤務=0.6 など
  max_consecutive_days   int,                         -- null ならアプリ既定値
  max_days_per_period    int,                         -- 期間内の勤務日数上限
  created_at             timestamptz not null default now()
);

-- ------------------------------------------------------------
-- シフト種別（早番・遅番・当直 など）
-- ------------------------------------------------------------
create table if not exists shift_types (
  id               bigint generated always as identity primary key,
  code             text not null unique,
  name             text not null,
  start_time       time not null,
  end_time         time not null,
  crosses_midnight boolean not null default false,  -- 日をまたぐ勤務
  break_minutes    int not null default 60,
  sort_order       int not null default 0,
  active           boolean not null default true
);

-- ------------------------------------------------------------
-- 必要人数（曜日ごとの基本形）
-- day_of_week: 0=日 1=月 ... 6=土
-- ------------------------------------------------------------
create table if not exists shift_requirements (
  id                     bigint generated always as identity primary key,
  shift_type_id          bigint not null references shift_types(id) on delete cascade,
  day_of_week            int not null check (day_of_week between 0 and 6),
  required_count         int not null default 0,
  required_qualification text,                      -- null なら資格不問
  unique (shift_type_id, day_of_week, required_qualification)
);

-- ------------------------------------------------------------
-- 必要人数の日付単位の上書き（臨時休診・繁忙日など）
-- ------------------------------------------------------------
create table if not exists shift_requirement_overrides (
  id                     bigint generated always as identity primary key,
  date                   date not null,
  shift_type_id          bigint not null references shift_types(id) on delete cascade,
  required_count         int not null default 0,
  required_qualification text,
  unique (date, shift_type_id, required_qualification)
);

-- ------------------------------------------------------------
-- 休診日
-- ------------------------------------------------------------
create table if not exists clinic_holidays (
  date date primary key,
  name text
);

-- ------------------------------------------------------------
-- シフト期間（1か月ぶんなど）
-- status: draft -> collecting -> assigned -> published
-- ------------------------------------------------------------
create table if not exists shift_periods (
  id               bigint generated always as identity primary key,
  name             text not null,
  start_date       date not null,
  end_date         date not null,
  status           text not null default 'draft'
                   check (status in ('draft','collecting','assigned','published','closed')),
  request_deadline date,
  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  check (start_date <= end_date)
);

-- ------------------------------------------------------------
-- 希望シフト（Slack のモーダルから登録）
-- preference: ng=不可 / ok=可 / want=希望
-- ------------------------------------------------------------
create table if not exists shift_requests (
  id         bigint generated always as identity primary key,
  period_id  bigint not null references shift_periods(id) on delete cascade,
  staff_id   bigint not null references shift_staff(id) on delete cascade,
  date       date not null,
  preference text not null default 'ok' check (preference in ('ng','ok','want')),
  note       text,
  updated_at timestamptz not null default now(),
  unique (period_id, staff_id, date)
);

-- ------------------------------------------------------------
-- 割当（シフト表の実体）
-- ------------------------------------------------------------
create table if not exists shift_assignments (
  id            bigint generated always as identity primary key,
  period_id     bigint not null references shift_periods(id) on delete cascade,
  date          date not null,
  shift_type_id bigint not null references shift_types(id) on delete cascade,
  staff_id      bigint not null references shift_staff(id) on delete cascade,
  locked        boolean not null default false,  -- true は自動割当で上書きしない
  status        text not null default 'assigned'
                check (status in ('assigned','absent','swapped')),
  note          text,
  created_at    timestamptz not null default now(),
  unique (period_id, date, shift_type_id, staff_id)
);

create index if not exists shift_assignments_date_idx on shift_assignments(date);
create index if not exists shift_assignments_staff_date_idx on shift_assignments(staff_id, date);

-- ------------------------------------------------------------
-- 交代・欠勤申請
-- kind: absence=欠勤申請 / swap=交代希望
-- status: open -> claimed -> approved / rejected / cancelled
-- ------------------------------------------------------------
create table if not exists shift_swap_requests (
  id                 bigint generated always as identity primary key,
  assignment_id      bigint not null references shift_assignments(id) on delete cascade,
  requester_staff_id bigint not null references shift_staff(id) on delete cascade,
  volunteer_staff_id bigint references shift_staff(id) on delete set null,
  kind               text not null check (kind in ('absence','swap')),
  reason             text,
  status             text not null default 'open'
                     check (status in ('open','claimed','approved','rejected','cancelled')),
  slack_channel      text,
  slack_ts           text,
  decided_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 通知の重複送信よけ
-- ------------------------------------------------------------
create table if not exists shift_notifications (
  id         bigint generated always as identity primary key,
  kind       text not null,        -- deadline_reminder / tomorrow_reminder / publish
  target_key text not null,        -- 例: "12:2026-09-01" (period_id:date など)
  sent_at    timestamptz not null default now(),
  unique (kind, target_key)
);

-- ------------------------------------------------------------
-- RLS: これらのテーブルはサーバー(service_role)からのみ触る。
-- anon / authenticated には一切公開しない。
-- ------------------------------------------------------------
alter table shift_staff                 enable row level security;
alter table shift_types                 enable row level security;
alter table shift_requirements          enable row level security;
alter table shift_requirement_overrides enable row level security;
alter table clinic_holidays             enable row level security;
alter table shift_periods               enable row level security;
alter table shift_requests              enable row level security;
alter table shift_assignments           enable row level security;
alter table shift_swap_requests         enable row level security;
alter table shift_notifications         enable row level security;
-- ポリシーを1つも作らない = service_role 以外は読み書き不可。
