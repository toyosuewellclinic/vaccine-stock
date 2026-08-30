# シフト管理（Slack 連携）

Slack から希望シフトを集め、制約を守って自動で割り当て、管理画面で手直ししてから
確定シフトを Slack に通知するアプリです。交代・欠勤の申請と承認も Slack で完結します。

同じリポジトリのワクチン在庫ウィジェット（`../index.html`）とは独立していますが、
DB は同じ Supabase プロジェクトを使います。

## できること

| 機能 | 入口 |
| --- | --- |
| 希望シフトの提出・修正（○ 可 / ◎ 希望 / × 不可） | Slack `/shift-request` |
| 自分の今後の勤務の確認 | Slack `/shift-my` |
| 交代・欠勤の申請と、チャンネルでの代替者募集 | Slack `/shift-swap` |
| 期間の作成・受付開始・提出状況・自動割当・公開 | Slack `/shift-admin` |
| シフト表の手動修正、指摘の確認 | 管理画面 `/admin/` |
| 提出期限リマインド・翌日勤務リマインド | 自動（cron） |

### 自動割当が守るルール

- 本人が「× 勤務不可」とした日には入れない
- 日ごと・シフトごとの必要人数と、資格の下限（例: 早番2名のうち看護師1名以上）
- 1日1シフトまで
- 連勤上限（スタッフ個別設定 > `DEFAULT_MAX_CONSECUTIVE_DAYS`）
- 勤務間インターバル（`MIN_REST_HOURS`。夜勤の翌朝に早番を入れない）
- 期間内の勤務日数上限（スタッフ個別設定）
- 休診日には割り当てない

そのうえで「◎ 希望」を優先し、勤務日数が偏らないようにならします（`workload_weight`
を 0.6 にすれば常勤の 6 割の勤務日数を目安に配分します）。
埋まらない枠は無理に埋めず、不足として報告するので管理画面で調整してください。

📌 を付けた割当は「手で決めた枠」として自動割当で上書きしません。

## セットアップ

### 1. データベース

Supabase の SQL Editor で以下を順に実行します。

1. `supabase/schema.sql` — テーブルと RLS
2. `supabase/seed.sql` — シフト種別・必要人数・スタッフのサンプル（自院の内容に書き換えて実行）

スタッフの `slack_user_id` には Slack のプロフィール →「メンバー ID をコピー」で
得られる `U...` を入れてください。ここが空だと DM が届きません。

これらのテーブルは RLS を有効にしたうえでポリシーを1つも作っていません。つまり
`service_role` キーを持つこのサーバーからしか読み書きできません。既存の在庫ウィジェットが
使っている `public_vaccine_stock` ビューには影響しません。

### 2. Slack アプリ

1. https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. `slack-manifest.yml` の `YOUR-DOMAIN` を公開 URL に置き換えて貼り付け
3. ワークスペースにインストールし、**Bot User OAuth Token**（`xoxb-...`）と
   **Signing Secret** を控える
4. シフトを投稿するチャンネルにボットを招待する（`/invite @シフト管理`）

### 3. 起動

```bash
cd shift-app
cp .env.example .env   # 値を埋める
npm install
npm start
```

`http://localhost:3000/admin/` が管理画面です。`ADMIN_TOKEN` を入力して「記憶」を押します。

ローカルで Slack から叩けるようにするには ngrok などで公開し、その URL を
マニフェストの `YOUR-DOMAIN` に反映してください。

## 使い方（1か月の流れ）

```
1. 期間を作る        管理画面「新しい期間を作る」 または /shift-admin new 2026年9月 2026-09-01 2026-09-30 2026-08-20
2. 受付を開始        /shift-admin open <期間ID>      → チャンネルに告知が流れる
3. 各自が希望を提出   /shift-request                  → 締切の3日前・1日前・当日に未提出者へ DM
4. 提出状況を確認     /shift-admin status <期間ID>
5. 受付を締める      /shift-admin close <期間ID>
6. 自動割当          /shift-admin assign <期間ID>    または 管理画面の「自動割当」
7. 手直し            管理画面でセルを編集 → 「保存」（指摘が出るので潰す）
8. 公開              管理画面の「公開してSlackに通知」 または /shift-admin publish <期間ID>
                     → チャンネルに日別のシフト、各自に自分の勤務を DM
9. 運用中            /shift-swap で交代・欠勤を申請、前日18時に翌日の勤務を DM
```

### 交代・欠勤の流れ

1. 本人が `/shift-swap` で対象の勤務・種類・理由を送信
2. チャンネルに募集が投稿される
3. 代われる人が「代われます」を押す（同日に別勤務がある人など、割当と同じルールで弾かれます）
4. 管理者が「承認」を押すとシフト表が書き換わり、双方に DM が飛ぶ
5. 代わりが見つからないときは、管理者が「欠勤として承認」で欠員のまま確定できる

## 設定できるもの

| 対象 | 場所 |
| --- | --- |
| シフト種別（時間帯・日またぎ） | `shift_types` テーブル |
| 曜日ごとの必要人数・資格要件 | `shift_requirements` テーブル |
| 特定日の必要人数の上書き | `shift_requirement_overrides` テーブル |
| 休診日 | `clinic_holidays` テーブル |
| 連勤上限・勤務日数上限・勤務比重 | `shift_staff` テーブル |
| 勤務間インターバル・連勤上限の既定値 | `.env`（`MIN_REST_HOURS` / `DEFAULT_MAX_CONSECUTIVE_DAYS`） |
| リマインドの時刻 | `.env`（`CRON_DEADLINE_REMINDER` / `CRON_TOMORROW_REMINDER`） |

`shift_requirements` の資格なしの行が「その日そのシフトの総人数」、資格つきの行が
「そのうち最低何名」を表します。

## 構成

```
src/
  index.js                 起動（Bolt + Express を1プロセスで動かす）
  config.js                環境変数
  lib/dates.js             日付ユーティリティ（UTC 基準の文字列演算）
  db/
    supabase.js            service_role クライアント
    repositories.js        テーブルごとの読み書き
  scheduler/
    constraints.js         ルール判定（自動割当と検証で共有）
    autoAssign.js          自動割当
    validate.js            シフト表の検証
    reminders.js           リマインドの cron
  slack/
    commands.js            スラッシュコマンドとモーダル送信の処理
    actions.js             ボタン（交代・承認・却下）の処理
    views/                 モーダルの定義
    blocks.js              メッセージの組み立て
    notify.js              公開・DM
  web/
    routes.js              管理画面の API
    public/                管理画面（ビルド不要の素の HTML/JS）
tests/                     自動割当・検証・日付のテスト
supabase/                  スキーマとシードの SQL
```

## テスト

```bash
npm test
```

自動割当と検証のルール（不可日・資格・連勤・インターバル・休診日・公平性）と
日付ユーティリティを検証します。

## 運用上の注意

- `SUPABASE_SERVICE_ROLE_KEY` と `ADMIN_TOKEN` はサーバー専用です。ブラウザや
  リポジトリに置かないでください（`.env` は `.gitignore` 済み）。
- 管理画面の認証は `ADMIN_TOKEN` 1本のみです。社内ネットワークや Basic 認証、
  IP 制限などと組み合わせて公開範囲を絞ってください。
- 公開（publish）はスタッフ全員に DM を送ります。取り消しはできないので、
  管理画面で指摘を潰してから実行してください。
