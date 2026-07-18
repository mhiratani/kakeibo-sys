const fs = require('fs');
const csv = require('csv-parser');
const { pool } = require('../db');

// CSVファイルをパースしてDBに保存（既存フォーマット互換）
// 含まれる年月のデータを削除してから入れ替える
async function parseAndSaveCSV(filePath) {
  const results = [];
  const errors = [];
  const yearMonths = new Set();

  return new Promise((resolve) => {
    fs.createReadStream(filePath, 'utf8')
      .pipe(csv())
      .on('data', (data) => {
        try {
          // 親カテゴリから カテゴリ と 人名 を分離
          const parentCategory = data['親カテゴリ'] || '';
          const [category, person] = parentCategory.split('/');

          if (!category || !person) {
            errors.push(`Invalid parent category format: ${parentCategory}`);
            return;
          }

          const dateStr = data['日付'] || '';
          const date = new Date(dateStr.split(' ')[0]);

          if (isNaN(date.getTime())) {
            errors.push(`Invalid date format: ${dateStr}`);
            return;
          }

          const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          yearMonths.add(yearMonth);

          results.push({
            record_date: date.toISOString().split('T')[0],
            income_expense: data['収入/支出'] || '',
            payment_method: data['入金/支払方法'] || '',
            category: category.trim(),
            person: person.trim(),
            amount: parseInt(data['金額'] || '0'),
            location: data['場所'] || '',
            memo: data['メモ'] || '',
            year_month: yearMonth,
          });
        } catch (error) {
          errors.push(`Error parsing row: ${error.message}`);
        }
      })
      .on('end', async () => {
        if (results.length === 0) {
          resolve({ success: false, error: 'No valid records found', errors });
          return;
        }

        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          for (const yearMonth of yearMonths) {
            const deleteResult = await client.query(
              'DELETE FROM household_records WHERE year_month = $1',
              [yearMonth]
            );
            if (deleteResult.rowCount > 0) {
              console.log(`Deleted ${deleteResult.rowCount} existing records for ${yearMonth}`);
            }
          }

          for (const record of results) {
            await client.query(`
              INSERT INTO household_records
                (record_date, income_expense, payment_method, category, person, amount, location, memo, year_month)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `, [
              record.record_date, record.income_expense, record.payment_method,
              record.category, record.person, record.amount,
              record.location, record.memo, record.year_month,
            ]);
          }

          // CSVに含まれる人・カテゴリをマスターへ補完（既存は変更しない）
          const personNames = [...new Set(results.map((r) => r.person).filter(Boolean))];
          const categoryNames = [...new Set(results.map((r) => r.category).filter(Boolean))];
          await client.query(
            'INSERT INTO persons (name) SELECT unnest($1::varchar[]) ON CONFLICT (name) DO NOTHING',
            [personNames]
          );
          await client.query(
            'INSERT INTO categories (name) SELECT unnest($1::varchar[]) ON CONFLICT (name) DO NOTHING',
            [categoryNames]
          );

          await client.query('COMMIT');
          resolve({
            success: true,
            processed: results.length,
            errors,
            replacedMonths: Array.from(yearMonths),
          });
        } catch (dbError) {
          await client.query('ROLLBACK');
          resolve({ success: false, error: dbError.message, errors });
        } finally {
          client.release();
        }
      });
  });
}

module.exports = { parseAndSaveCSV };
