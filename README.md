# 家計簿管理システム

PostgreSQL + Node.js + Express を使った家計簿データ管理システムです。CSVファイルから家計簿データを読み込み、月次サマリーと清算計算を行います。

## 機能

- CSVファイルのアップロードとデータベース保存
- 月次サマリー表示（カテゴリ別・人別支出）
- 清算計算（一人当たり負担額と過不足分算出）
- サマリー一覧表示
- 自動/手動データベースバックアップ（NAS保存対応）

## セットアップ

### 必要なファイル構成

```
project-directory/
├── docker-compose.yml
├── Dockerfile
├── package.json
├── app.js
├── init.sql
└── README.md
```

### 1. プロジェクトディレクトリの作成

```bash
mkdir household-budget-app
cd household-budget-app
```

### 2. ファイルの配置

提供されたファイルをすべて適切な場所に配置してください。

### 3. Docker Compose でアプリケーションを起動

```bash
docker compose up --build
```

初回起動時は、以下が実行されます：
- PostgreSQLデータベースの初期化
- 必要なテーブルの作成
- Node.jsアプリケーションの起動

### 4. アプリケーションへのアクセス

ブラウザで `http://localhost:3000` にアクセスします。

## 使用方法

### CSVファイルのアップロード

ブラウザからCSVファイルを選択してアップロードします。アップロードされたファイルは自動的に解析され、データベースに保存されます。

### CSVファイル形式

以下の形式のCSVファイルに対応しています：

```csv
日付,収入/支出,入金/支払方法,親カテゴリ,子カテゴリ,金額,場所,メモ,備考,タグ
2025/07/01 00:00,支出,現金,食費/Aさん,,321,イトーヨーカドー,にんにく,,
2025/07/01 00:00,支出,現金,外食/Bさん,,1360,マクドナルド,夜ご飯,,
```

**重要**: 親カテゴリは `カテゴリ名/支払者名` の形式で記載してください。

### 月次サマリー表示

1. メインページで「サマリー一覧を表示」ボタンをクリック
2. 一覧から表示したい年月を選択
3. 以下の情報が表示されます：
   - 生活費合計金額
   - 一人当たり負担額
   - 支払者別支出と清算計算
   - カテゴリ別詳細（行をクリックで詳細表示）

### 清算計算の仕組み

システムは以下の計算を行います：

1. **生活費合計** = 全支出の合計
2. **一人当たり負担額** = 生活費合計 ÷ 参加人数
3. **過不足分** = 各人の支払額 - 一人当たり負担額
4. **清算指示** = 不足分がある人が余剰分がある人に支払う金額

## データベース構造

### household_records テーブル

| フィールド名 | データ型 | 説明 |
|-------------|----------|------|
| id | SERIAL | 主キー |
| record_date | DATE | 支出日 |
| income_expense | VARCHAR(10) | 収入/支出区分 |
| payment_method | VARCHAR(50) | 支払方法 |
| category | VARCHAR(100) | カテゴリ |
| person | VARCHAR(50) | 支払者名 |
| amount | INTEGER | 金額 |
| location | VARCHAR(200) | 場所 |
| memo | VARCHAR(500) | メモ |
| year_month | VARCHAR(7) | 年月（YYYY-MM形式） |
| created_at | TIMESTAMP | 作成日時 |

## トラブルシューティング

### Docker関連

```bash
# コンテナの状態確認
docker compose ps

# ログの確認
docker compose logs web
docker compose logs db

# コンテナの再起動
docker compose restart

# 完全な再構築
docker compose down -v
docker compose up --build
```

### データベース接続エラー

1. PostgreSQLコンテナが起動しているか確認
2. データベースの初期化が完了しているか確認
3. 接続設定（ホスト名、ポート、認証情報）を確認

### CSVファイル読み込みエラー

1. ファイル形式がUTF-8エンコーディングか確認
2. 親カテゴリの形式が `カテゴリ名/支払者名` になっているか確認
3. 日付形式が正しいか確認（YYYY/MM/DD HH:MM）

## カスタマイズ

### ポート番号の変更

`docker-compose.yml` の ports セクションを変更：

```yaml
web:
  ports:
    - "8080:3000"  # ホスト側のポートを8080に変更
```

### データベース認証情報の変更

`docker-compose.yml` の environment セクションで変更可能：

```yaml
environment:
  POSTGRES_DB: your_db_name
  POSTGRES_USER: your_username
  POSTGRES_PASSWORD: your_password
```

## データベースバックアップ機能

### 概要

本システムは定期的な自動バックアップと手動バックアップの両方に対応しています。バックアップファイルはNAS上のLinux APIサーバーに送信されます。

### バックアップの設定

`.env`ファイルに以下の設定を追加してください：

```env
# NAS APIのエンドポイントURL
BACKUP_NAS_API_URL=http://192.168.1.100:5000/api/backup/upload

# NAS API認証トークン
BACKUP_NAS_API_TOKEN=your_secure_token_here

# バックアップスケジュール（cron形式）
# デフォルト: 毎週日曜日午前3時
BACKUP_SCHEDULE=0 3 * * 0
```

### バックアップスケジュール形式（cron）

cron形式: `分 時 日 月 曜日`

例：
- `0 3 * * 0` - 毎週日曜日午前3時
- `0 2 * * *` - 毎日午前2時
- `0 3 * * 1` - 毎週月曜日午前3時
- `0 4 1 * *` - 毎月1日午前4時

### 手動バックアップの実行

1. ブラウザでアプリケーションにログイン
2. `/backup/status` にアクセス
3. 「手動バックアップ実行」ボタンをクリック

または、直接 `POST /backup/manual` を呼び出すことも可能です。

### バックアップファイル形式

- ファイル名: `household_budget_backup_YYYY-MM-DDTHH-MM-SS.sql`
- 形式: PostgreSQL SQLダンプファイル
- 内容: 全テーブルデータとスキーマ

### バックアップの復元

バックアップファイルからデータを復元する場合：

```bash
# コンテナ内で実行
docker compose exec db psql -U budget_user -d household_budget -f /path/to/backup.sql

# またはホストから実行
cat backup.sql | docker compose exec -T db psql -U budget_user -d household_budget
```

### トラブルシューティング

**pg_dumpが見つからないエラー：**

Dockerfileに `postgresql-client` がインストールされているか確認してください。

## サポート

問題が発生した場合は、以下を確認してください：

1. Docker Desktop が起動している
2. 必要なファイルがすべて配置されている
3. CSVファイルの形式が正しい
4. ポート3000が他のアプリケーションで使用されていない

---
