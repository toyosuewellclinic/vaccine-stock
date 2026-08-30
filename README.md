# vaccine-stock

クリニックの社内ツール置き場。

| 場所 | 内容 |
| --- | --- |
| `index.html` | ワクチン在庫ウィジェット。Supabase の `public_vaccine_stock` ビューを読み、ホームページに iframe で埋め込む静的ページ。 |
| `shift-app/` | Slack 連携のシフト作成アプリ。希望シフトの収集・自動割当・確定シフトの通知・交代申請。詳細は [shift-app/README.md](shift-app/README.md)。 |
