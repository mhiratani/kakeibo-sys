const { Pool } = require('pg');

// PostgreSQL接続設定（DBは外部サーバー）
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// 起動時マイグレーション
// 既存の household_records / session はそのまま利用し、
// マスターテーブル（persons / categories）が無ければ作成して既存データからシードする
async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
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
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_household_records_year_month ON household_records (year_month)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_household_records_category ON household_records (category)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_household_records_person ON household_records (person)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_household_records_date ON household_records (record_date)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")');

    await client.query(`
      CREATE TABLE IF NOT EXISTS persons (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // マスターが空なら既存の記録からシード（削除したマスターが復活しないよう、空のときのみ）
    const personCount = await client.query('SELECT COUNT(*)::int AS count FROM persons');
    if (personCount.rows[0].count === 0) {
      const seeded = await client.query(`
        INSERT INTO persons (name)
        SELECT DISTINCT person FROM household_records WHERE person <> ''
        ORDER BY 1
        ON CONFLICT (name) DO NOTHING
      `);
      if (seeded.rowCount > 0) {
        console.log(`persons マスターを既存データからシードしました: ${seeded.rowCount}件`);
      }
    }

    const categoryCount = await client.query('SELECT COUNT(*)::int AS count FROM categories');
    if (categoryCount.rows[0].count === 0) {
      const seeded = await client.query(`
        INSERT INTO categories (name)
        SELECT DISTINCT category FROM household_records WHERE category <> ''
        ORDER BY 1
        ON CONFLICT (name) DO NOTHING
      `);
      if (seeded.rowCount > 0) {
        console.log(`categories マスターを既存データからシードしました: ${seeded.rowCount}件`);
      }
    }
  } finally {
    client.release();
  }
}

module.exports = { pool, ensureSchema };
