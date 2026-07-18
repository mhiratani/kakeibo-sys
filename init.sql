-- データベースの初期化スクリプト
CREATE TABLE IF NOT EXISTS household_records (
    id SERIAL PRIMARY KEY,
    record_date DATE NOT NULL,
    income_expense VARCHAR(10) NOT NULL,
    payment_method VARCHAR(50),
    category VARCHAR(100) NOT NULL,
    person VARCHAR(50) NOT NULL,
    amount INTEGER NOT NULL,
    location VARCHAR(200),
    memo VARCHAR(500),
    year_month VARCHAR(7) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- インデックスの作成
CREATE INDEX IF NOT EXISTS idx_household_records_year_month ON household_records (year_month);
CREATE INDEX IF NOT EXISTS idx_household_records_category ON household_records (category);
CREATE INDEX IF NOT EXISTS idx_household_records_person ON household_records (person);
CREATE INDEX IF NOT EXISTS idx_household_records_date ON household_records (record_date);

-- マスターテーブル（人）
CREATE TABLE IF NOT EXISTS persons (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- マスターテーブル（カテゴリ）
CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- セッションテーブルの作成（connect-pg-simple用）
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
