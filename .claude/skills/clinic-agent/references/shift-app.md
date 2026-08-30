# シフト作成アプリ（`shift-app/`）

Node.js + Slack Bolt + Supabase。1プロセスで Slack のエンドポイント（`/slack/events`）と
管理画面（`/admin/`）とその API（`/api/`）を同時に提供する。

## 目次

- [月次の流れ](#月次の流れ)
- [Slack から使えるもの](#slack-から使えるもの)
- [データモデル](#データモデル)
- [自動割当のルール](#自動割当のルール)
- [割当がうまくいかないとき](#割当がうまくいかないとき)
- [交代・欠勤の申請](#交代欠勤の申請)
- [リマインド](#リマインド)
- [コードの地図](#コードの地図)
- [初期セットアップ](#初期セットアップ)

## 月次の流れ

期間（`shift_periods`）の `status` がそのまま進行状況を表す。
いま何合目かは `/shift-admin periods` か管理画面の期間セレクタで分かる。

| # | やること | 手段 | 期間の status |
| --- | --- | --- | --- |
| 1 | 期間を作る | 管理画面「新しい期間を作る」/ `/shift-admin new <名前> <開始日> <終了日> [提出期限]` | `draft` |
| 2 | 希望シフトの受付を開始 | `/shift-admin open <期間ID>`（チャンネルに告知が流れる） | `collecting` |
| 3 | 各自が希望を提出 | `/shift-request` | `collecting` |
| 4 | 提出状況を見る | `/shift-admin status <期間ID>` | `collecting` |
| 5 | 受付を締める | `/shift-admin close <期間ID>` | `draft` |
| 6 | 自動割当 | `/shift-admin assign <期間ID>` / 管理画面「自動割当」 | `assigned` |
| 7 | 手直し | 管理画面でセルを編集 →「保存」 | `assigned` |
| 8 | 公開 | 管理画面「公開してSlackに通知」/ `/shift-admin publish <期間ID>` | `published` |

**受付中の期間は同時に1つにしておく。** `/shift-request` は `status='collecting'` の期間のうち
開始日が最も早いものを1つだけ拾う（`getCollectingPeriod`）。2か月ぶんを同時に開けると、
スタッフは古いほうにしか希望を出せず、しかもエラーが出ないので誰も気づかない。

締切を延ばしたいときは `shift_periods.request_deadline` を更新する（管理画面の API か SQL）。
締切そのものは提出を止めない。止めるのは `close`（`status` を `collecting` から外すこと）。

## Slack から使えるもの

| コマンド | 誰が | 内容 |
| --- | --- | --- |
| `/shift-request` | 全員 | 希望シフトのモーダル。日付ごとに ○可 / ◎希望 / ×不可 ＋ 備考。締切まで何度でも上書き可 |
| `/shift-my` | 全員 | 今後90日の自分の勤務 |
| `/shift-swap` | 全員 | 交代・欠勤の申請 |
| `/shift-admin` | `is_admin` のみ | `help` / `periods` / `new` / `open` / `close` / `status` / `assign` / `publish` |

どのコマンドも、実行者の Slack ID が `shift_staff.slack_user_id` に登録されていないと
「スタッフ登録されていません」で止まる。新しいスタッフが入ったらまずここを埋める。
Slack のプロフィール →「メンバー ID をコピー」で `U...` が取れる。

## データモデル

`supabase/schema.sql` が正。要点だけ:

| テーブル | 役割 | 注意 |
| --- | --- | --- |
| `shift_staff` | スタッフ。資格・管理者フラグ・連勤上限・勤務日数上限・勤務比重 | `qualifications` は配列（例 `{看護師}`）。`workload_weight` 0.6 なら常勤の6割の勤務日数を目安に配分 |
| `shift_types` | シフト種別（早番・遅番・当直） | 日をまたぐ勤務は `crosses_midnight=true`。ここを忘れるとインターバル判定が壊れる |
| `shift_requirements` | 曜日ごとの必要人数 | **資格なしの行＝その日そのシフトの総人数。資格つきの行＝そのうちの最低人数（内数）** |
| `shift_requirement_overrides` | 特定日の必要人数の上書き | 繁忙日・臨時体制に使う |
| `clinic_holidays` | 休診日 | この日は枠を作らない |
| `shift_periods` | 期間 | `status` が進行状況 |
| `shift_requests` | 希望シフト | `preference` は `ng` / `ok` / `want` |
| `shift_assignments` | シフト表の実体 | `locked=true` は自動割当で上書きしない。`status` は `assigned` / `absent` / `swapped` |
| `shift_swap_requests` | 交代・欠勤申請 | `status` は `open` → `claimed` → `approved` / `rejected` / `cancelled` |
| `shift_notifications` | 通知の重複よけ | 同じ通知は二度送らないための記録 |

全テーブルで RLS を有効にし、ポリシーを1つも作っていない。つまり `service_role` キーを持つ
サーバーからしか読み書きできない。既存の在庫ウィジェットが使う `public_vaccine_stock` ビューとは無関係。

## 自動割当のルール

`src/scheduler/autoAssign.js`。判定は `src/scheduler/constraints.js` に集約され、
検証（`validate.js`）と共有している。

**必ず守る（破ってまで枠を埋めない）**

- 本人が `ng` を出した日には入れない
- 1日1シフトまで
- 資格の下限（早番2名のうち看護師1名以上、など）
- 連勤上限 … `shift_staff.max_consecutive_days`（個人設定）が優先、無ければ `DEFAULT_MAX_CONSECUTIVE_DAYS`（既定5）
- 勤務間インターバル … `MIN_REST_HOURS`（既定11時間）。夜勤の翌朝に早番は入らない
- 期間内の勤務日数上限 … `shift_staff.max_days_per_period`
- 休診日には割り当てない

**そのうえで最適化する**

- `want`（◎希望）の日を優先する
- 勤務日数を `workload_weight` に応じてならす
- 連勤が伸びている人は後回しにする

日付を古い順に、その日のうちは候補者の少ないシフトから埋める貪欲法。数理最適化ではないので
「最適解」は保証しない。だから埋まらない枠は無理に埋めず不足として報告し、人が直す前提にしてある。

`locked=true`（管理画面の 📌）の割当は保持され、その枠は埋まっているものとして扱われる。
管理画面で手動追加した割当は自動的に `locked=true` になる。せっかくの手作業が
次の自動割当で消えないようにするため。

## 割当がうまくいかないとき

「埋まらない」「偏る」は、たいていルールではなくデータが原因。上から順に潰す。

1. **そもそも人数が足りない** … 必要人数の合計 ÷ 期間日数 と、稼働可能なスタッフ数を比べる。
   足りなければ何をしても埋まらない。必要人数を見直すか、人を増やすしかない。
2. **`ng` が多い日** … 管理画面の「希望」欄でその日の × を見る。全員 × なら埋まらない。
3. **資格保持者が足りない** … 看護師が1名しかいない日に「看護師1名以上」が2枠あれば詰む。
   `shift_staff.qualifications` の綴りが `shift_requirements.required_qualification` と
   一致しているかも確認する（不一致は無資格扱いになる）。
4. **連勤上限・インターバル** … 少人数だとここで詰まりやすい。`.env` の既定値か個人設定を緩める。
5. **`active=false` のスタッフ** … 退職・休職の設定が残っていないか。
6. **曜日の設定漏れ** … `shift_requirements` に該当曜日の行が無ければ、その曜日は枠が0になる。
   逆に「日曜も出勤になってしまう」は日曜の行を消し忘れている。
7. **休診日の未登録** … `clinic_holidays` に入れる。

偏りが気になるときは `workload_weight` を見直す。常勤=1、週3勤務=0.6 のように相対値で入れる。

## 交代・欠勤の申請

1. 本人が `/shift-swap` で対象の勤務・種類（交代希望／欠勤申請）・理由を送る
2. チャンネルに募集が投稿される（`status='open'`）
3. 代われる人が「代われます」を押す（`claimed`）。このとき**割当と同じルールで資格や連勤を判定する**ので、
   同日に別勤務がある人などは弾かれる。申請者本人の枠は空くものとして除外して判定する
4. 管理者が「承認」を押すと `shift_assignments.staff_id` が立候補者に書き換わり、双方に DM が飛ぶ
5. 代わりが見つからないときは、管理者が「欠勤として承認」で `status='absent'` にして欠員のまま確定できる

**承認できないときの確認順**: 押した人が `is_admin` か → 申請の `status` が `claimed` か
（`open` のまま＝まだ立候補者がいない）→ 立候補者が消えていないか。

既知の癖として、**欠勤として承認した枠は検証上まだ人数に数えられたまま**になる
（シフト表では打ち消し線で表示される）。欠員を埋めるなら管理画面で人を差し替える。

## リマインド

`src/scheduler/reminders.js`。`ENABLE_CRON=false` で止まる。

- 提出期限の3日前・1日前・当日 … 未提出者へ DM ＋ チャンネルに未提出者一覧
- 前日18時 … 翌日勤務者へ DM ＋ チャンネルに翌日の配置

同じ通知は `shift_notifications` に記録して二度送らないようにしてある。
**意図的に再送したいときは、該当する行を消す**（例: `delete from shift_notifications
where kind='tomorrow_reminder' and target_key like '2026-09-01%'`）。消さずに再実行しても何も起きない。

時刻は `.env` の `CRON_DEADLINE_REMINDER` / `CRON_TOMORROW_REMINDER`（cron 形式、`TZ_NAME` で評価）。

## コードの地図

| 変えたいもの | 触る場所 |
| --- | --- |
| 割当のルール | `src/scheduler/constraints.js`（判定）→ 必要なら `autoAssign.js`（優先順位） |
| 検証の指摘文 | `src/scheduler/validate.js` |
| Slack のコマンド・モーダル | `src/slack/commands.js`、`src/slack/views/` |
| ボタンの挙動（交代・承認） | `src/slack/actions.js` |
| Slack に出る文面 | `src/slack/blocks.js`、`src/slack/notify.js` |
| リマインドの中身・頻度 | `src/scheduler/reminders.js` |
| 管理画面 | `src/web/public/`（素の HTML/JS）、API は `src/web/routes.js` |
| DB アクセス | `src/db/repositories.js` |

ルール判定を `constraints.js` に集約しているのは、自動割当と検証が同じ基準で動くようにするため。
片方だけに条件を足すと「割当は通るのに検証で怒られる」状態になる。

管理画面の保存（`PUT /api/periods/:id/assignments`）は、画面に出ている割当で期間全体を
**丸ごと置き換える**。部分更新ではない。API を直接叩くときはこの前提を外さない。

テストは `npm test`（vitest、21件）。割当と検証のルール、日付ユーティリティを見ている。
ルールを変えるならテストを先に足す。

## 初期セットアップ

まだ動かしていない環境で立ち上げるとき:

1. Supabase の SQL Editor で `supabase/schema.sql` → `supabase/seed.sql`
   （seed はサンプル。シフト種別・必要人数・スタッフを自院の内容に書き換えてから流す）
2. `slack-manifest.yml` の `YOUR-DOMAIN` を公開 URL に置き換えて Slack アプリを作成、
   ワークスペースにインストール、投稿先チャンネルにボットを招待
3. `.env.example` を `.env` にして値を埋め、`npm install && npm start`

`shift-app/README.md` に同じ手順がもう少し丁寧に書いてある。
