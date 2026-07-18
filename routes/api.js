const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// API用認証チェック（未認証はリダイレクトではなく401 JSONを返す）
router.use((req, res, next) => {
  if (req.session && req.session.user) {
    return next();
  }
  res.status(401).json({ error: '認証が必要です。再ログインしてください。' });
});

// 記録の入力値検証
function validateRecord(body) {
  const errors = [];

  const record_date = String(body.record_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record_date) || isNaN(new Date(record_date).getTime())) {
    errors.push('日付が不正です');
  }

  const income_expense = ['支出', '収入'].includes(body.income_expense) ? body.income_expense : null;
  if (!income_expense) {
    errors.push('収支区分は「支出」または「収入」を指定してください');
  }

  const person = String(body.person || '').trim();
  if (!person || person.length > 50) {
    errors.push('人を選択してください');
  }

  const category = String(body.category || '').trim();
  if (!category || category.length > 100) {
    errors.push('カテゴリを選択してください');
  }

  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 100000000) {
    errors.push('金額は1以上の整数で入力してください');
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    record: {
      record_date,
      income_expense,
      person,
      category,
      amount,
      location: String(body.location || '').trim().slice(0, 200),
      memo: String(body.memo || '').trim().slice(0, 500),
      payment_method: String(body.payment_method || '').trim().slice(0, 50),
      year_month: record_date.slice(0, 7),
    },
  };
}

function parseId(param) {
  const id = Number(param);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// マスター一覧（登録ダイアログの選択肢用）
router.get('/masters', async (req, res) => {
  try {
    const persons = await pool.query('SELECT id, name FROM persons ORDER BY sort_order, name');
    const categories = await pool.query('SELECT id, name FROM categories ORDER BY sort_order, name');
    res.json({ persons: persons.rows, categories: categories.rows });
  } catch (error) {
    console.error('GET /api/masters failed:', error);
    res.status(500).json({ error: 'マスターの取得に失敗しました' });
  }
});

// 日別合計（「何買ったっけ？」カレンダーのマーク用）
router.get('/daily-totals', async (req, res) => {
  const yearMonth = String(req.query.yearMonth || '').trim();
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    return res.status(400).json({ error: '年月の形式が不正です' });
  }
  try {
    const result = await pool.query(`
      SELECT to_char(record_date, 'YYYY-MM-DD') AS day,
             SUM(amount)::int AS total,
             COUNT(*)::int AS count
      FROM household_records
      WHERE year_month = $1 AND income_expense = '支出'
      GROUP BY record_date
      ORDER BY record_date
    `, [yearMonth]);
    res.json({ days: result.rows });
  } catch (error) {
    console.error('GET /api/daily-totals failed:', error);
    res.status(500).json({ error: '日別合計の取得に失敗しました' });
  }
});

// 指定日の記録一覧（「何買ったっけ？」の円グラフ・明細用）
router.get('/records', async (req, res) => {
  const date = String(req.query.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date).getTime())) {
    return res.status(400).json({ error: '日付の形式が不正です' });
  }
  try {
    const result = await pool.query(`
      SELECT id, to_char(record_date, 'YYYY-MM-DD') AS record_date,
             income_expense, payment_method, category, person, amount, location, memo
      FROM household_records
      WHERE record_date = $1 AND income_expense = '支出'
      ORDER BY category, id
    `, [date]);
    res.json({ records: result.rows });
  } catch (error) {
    console.error('GET /api/records failed:', error);
    res.status(500).json({ error: '記録の取得に失敗しました' });
  }
});

// 記録の追加
router.post('/records', async (req, res) => {
  const { record, errors } = validateRecord(req.body);
  if (errors) {
    return res.status(400).json({ error: errors.join(' / ') });
  }
  try {
    const result = await pool.query(`
      INSERT INTO household_records
        (record_date, income_expense, payment_method, category, person, amount, location, memo, year_month)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [
      record.record_date, record.income_expense, record.payment_method,
      record.category, record.person, record.amount,
      record.location, record.memo, record.year_month,
    ]);
    res.status(201).json({ id: result.rows[0].id });
  } catch (error) {
    console.error('POST /api/records failed:', error);
    res.status(500).json({ error: '登録に失敗しました' });
  }
});

// 記録の更新
router.put('/records/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'IDが不正です' });
  }
  const { record, errors } = validateRecord(req.body);
  if (errors) {
    return res.status(400).json({ error: errors.join(' / ') });
  }
  try {
    const result = await pool.query(`
      UPDATE household_records SET
        record_date = $1, income_expense = $2, payment_method = $3,
        category = $4, person = $5, amount = $6,
        location = $7, memo = $8, year_month = $9
      WHERE id = $10
    `, [
      record.record_date, record.income_expense, record.payment_method,
      record.category, record.person, record.amount,
      record.location, record.memo, record.year_month, id,
    ]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: '対象の記録が見つかりません' });
    }
    res.json({ id });
  } catch (error) {
    console.error('PUT /api/records failed:', error);
    res.status(500).json({ error: '更新に失敗しました' });
  }
});

// 記録の削除
router.delete('/records/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'IDが不正です' });
  }
  try {
    const result = await pool.query('DELETE FROM household_records WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: '対象の記録が見つかりません' });
    }
    res.json({ id });
  } catch (error) {
    console.error('DELETE /api/records failed:', error);
    res.status(500).json({ error: '削除に失敗しました' });
  }
});

// マスターの追加・削除（persons / categories 共通）
function registerMasterRoutes(path, table, label, maxLength) {
  router.post(`/${path}`, async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name || name.length > maxLength) {
      return res.status(400).json({ error: `${label}は1〜${maxLength}文字で入力してください` });
    }
    try {
      // 既存の色割当・並び順を崩さないよう、新規マスターは末尾に追加
      const result = await pool.query(
        `INSERT INTO ${table} (name, sort_order)
         VALUES ($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ${table}))
         ON CONFLICT (name) DO NOTHING RETURNING id`,
        [name]
      );
      if (result.rowCount === 0) {
        return res.status(409).json({ error: `「${name}」は既に登録されています` });
      }
      res.status(201).json({ id: result.rows[0].id, name });
    } catch (error) {
      console.error(`POST /api/${path} failed:`, error);
      res.status(500).json({ error: `${label}の追加に失敗しました` });
    }
  });

  router.delete(`/${path}/:id`, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'IDが不正です' });
    }
    try {
      const result = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      if (result.rowCount === 0) {
        return res.status(404).json({ error: `対象の${label}が見つかりません` });
      }
      res.json({ id });
    } catch (error) {
      console.error(`DELETE /api/${path} failed:`, error);
      res.status(500).json({ error: `${label}の削除に失敗しました` });
    }
  });
}

registerMasterRoutes('persons', 'persons', '人', 50);
registerMasterRoutes('categories', 'categories', 'カテゴリ', 100);

module.exports = router;
