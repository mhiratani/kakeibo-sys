require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cron = require('node-cron');
const auth = require('./auth');
const backup = require('./backup');
const { getHTMLTemplate } = require('./views/template');

const app = express();
const port = process.env.PORT || 3000;

// リバースプロキシを信頼する設定（HTTPS環境で必須）
app.set('trust proxy', 1);

// csv_files ディレクトリが存在しない場合は作成
const uploadDir = 'csv_files';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log(`${uploadDir} ディレクトリを作成しました`);
}

// PostgreSQL接続設定
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// セッション設定（PostgreSQLストア使用）
app.use(session({
  store: new pgSession({
    pool: pool,                   // 既存のPostgreSQLプール
    tableName: 'session',         // セッションテーブル名
    createTableIfMissing: false,  // init.sqlで作成済み
    pruneSessionInterval: 60 * 60 // 1時間ごとに期限切れセッションを削除
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true, // OIDC認証フローのために true に変更
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS環境でのみtrue
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24時間
    sameSite: 'lax', // CSRF対策
  }
}));

// ミドルウェア
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// CSVアップロード設定
const upload = multer({ dest: 'csv_files/' });

// 認証エンドポイント
app.get('/auth/login', async (req, res) => {
  try {
    const authUrl = await auth.generateAuthUrl(req);
    res.redirect(authUrl);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).send('認証エラーが発生しました');
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const user = await auth.handleCallback(req);
    console.log('User logged in:', user.name);
    res.redirect('/');
  } catch (error) {
    console.error('Callback error:', error);
    const content = `
      <div class="alert alert-error">
        <h3> 認証エラー</h3>
        <p>${error.message}</p>
      </div>
      <button onclick="location.href='/auth/login'" class="btn-primary">再ログイン</button>
    `;
    res.send(getHTMLTemplate(content));
  }
});

app.get('/auth/logout', async (req, res) => {
  try {
    await auth.handleLogout(req);
    const content = `
      <div class="alert alert-success">
        <h3>✅ ログアウト完了</h3>
        <p>ログアウトしました。</p>
      </div>
      <button onclick="location.href='/auth/login'" class="btn-primary">ログイン</button>
    `;
    res.send(getHTMLTemplate(content));
  } catch (error) {
    console.error('Logout error:', error);
    res.redirect('/');
  }
});

app.get('/auth/userinfo', auth.requireAuth, (req, res) => {
  const user = auth.getUser(req);
  const content = `
    <h2>👤 ユーザー情報</h2>
    <div class="settlement">
      <p><strong>名前:</strong> ${user.name}</p>
      <p><strong>メールアドレス:</strong> ${user.email || 'N/A'}</p>
      <p><strong>ユーザーID:</strong> ${user.sub}</p>
    </div>
    <button onclick="location.href='/'" class="btn-primary">ホームに戻る</button>
  `;
  res.send(getHTMLTemplate(content));
});

// メインページ
app.get('/', auth.requireAuth, (req, res) => {
  const user = auth.getUser(req);
  const content = `
    <div class="form-section">
      <h2>🐱 CSVファイル読み込み</h2>
      <form action="/upload" method="post" enctype="multipart/form-data">
        <div class="form-group">
          <label for="csvFile">CSVファイルを選択:</label>
          <input type="file" id="csvFile" name="csvFile" accept=".csv" required>
        </div>
        <button type="submit" class="btn-primary">アップロード</button>
      </form>
    </div>

    <div class="form-section">
      <h2>🐟️ サマリー一覧</h2>
      <button onclick="location.href='/available-months'" class="btn-success">サマリー一覧を見る</button>
    </div>

    <div class="form-section">
      <h2>バックアップ管理</h2>
      <button onclick="location.href='/backup/status'" class="btn-info">バックアップ設定・実行</button>
    </div>
  `;
  res.send(getHTMLTemplate(content, user));
});

// CSVファイルをパースしてDBに保存
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

          // 日付をパース
          const dateStr = data['日付'] || '';
          const date = new Date(dateStr.split(' ')[0]);
          
          if (isNaN(date.getTime())) {
            errors.push(`Invalid date format: ${dateStr}`);
            return;
          }

          const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          yearMonths.add(yearMonth);
          
          const record = {
            record_date: date.toISOString().split('T')[0],
            income_expense: data['収入/支出'] || '',
            payment_method: data['入金/支払方法'] || '',
            category: category.trim(),
            person: person.trim(),
            amount: parseInt(data['金額'] || '0'),
            location: data['場所'] || '',
            memo: data['メモ'] || '',
            year_month: yearMonth
          };

          results.push(record);
        } catch (error) {
          errors.push(`Error parsing row: ${error.message}`);
        }
      })
      .on('end', async () => {
        if (results.length > 0) {
          try {
            const client = await pool.connect();
            await client.query('BEGIN');
            
            // 該当する年月のデータを削除
            for (const yearMonth of yearMonths) {
              const deleteResult = await client.query(`
                DELETE FROM household_records WHERE year_month = $1
              `, [yearMonth]);
              
              if (deleteResult.rowCount > 0) {
                console.log(`Deleted ${deleteResult.rowCount} existing records for ${yearMonth}`);
              }
            }
            
            // 新しいデータを挿入
            for (const record of results) {
              await client.query(`
                INSERT INTO household_records 
                (record_date, income_expense, payment_method, category, person, amount, location, memo, year_month)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
              `, [
                record.record_date,
                record.income_expense,
                record.payment_method,
                record.category,
                record.person,
                record.amount,
                record.location,
                record.memo,
                record.year_month
              ]);
            }
            
            await client.query('COMMIT');
            client.release();
            
            const deletedMonths = Array.from(yearMonths);
            resolve({ 
              success: true, 
              processed: results.length, 
              errors, 
              replacedMonths: deletedMonths 
            });
          } catch (dbError) {
            await client.query('ROLLBACK');
            client.release();
            resolve({ success: false, error: dbError.message, errors });
          }
        } else {
          resolve({ success: false, error: 'No valid records found', errors });
        }
      });
  });
}

// CSVアップロード処理
app.post('/upload', auth.requireAuth, upload.single('csvFile'), async (req, res) => {
  const user = auth.getUser(req);
  try {
    if (!req.file) {
      throw new Error('ファイルが選択されていません');
    }

    const result = await parseAndSaveCSV(req.file.path);
    
    // 一時ファイルを削除
    fs.unlinkSync(req.file.path);
    
    let content;
    if (result.success) {
      const replacedInfo = result.replacedMonths && result.replacedMonths.length > 0 
        ? `<p>📝 置き換えた月: ${result.replacedMonths.join(', ')}</p>` 
        : '';
      
      content = `
        <div class="alert alert-success">
          <h3>✅ 成功</h3>
          <p>${result.processed}件のレコードを保存しました。</p>
          ${replacedInfo}
          ${result.errors.length > 0 ? `<p>警告: ${result.errors.length}件のエラーがありました。</p>` : ''}
        </div>
        <div class="btn-container">
          <button onclick="location.href='/'" class="btn-primary">ホームに戻る</button>
          <button onclick="location.href='/available-months'" class="btn-success">サマリー一覧を見る</button>
        </div>
      `;
    } else {
      content = `
        <div class="alert alert-error">
          <h3>❌ エラー</h3>
          <p>エラー: ${result.error}</p>
          ${result.errors.length > 0 ? `<ul>${result.errors.map(err => `<li>${err}</li>`).join('')}</ul>` : ''}
        </div>
        <button onclick="location.href='/'" class="btn-primary">戻る</button>
      `;
    }
    
    res.send(getHTMLTemplate(content, user));
  } catch (error) {
    const content = `
      <div class="alert alert-error">
        <h3>❌ エラー</h3>
        <p>${error.message}</p>
      </div>
      <button onclick="location.href='/'" class="btn-primary">戻る</button>
    `;
    res.send(getHTMLTemplate(content, user));
  }
});

// 月次サマリー表示
app.get('/summary', auth.requireAuth, async (req, res) => {
  const user = auth.getUser(req);
  try {
    const { yearMonth } = req.query;
    
    if (!yearMonth) {
      throw new Error('年月が指定されていません');
    }

    const client = await pool.connect();
    
    // カテゴリ別・人別の支出を取得
    const categoryResult = await client.query(`
      SELECT category, person, SUM(amount) as total_amount
      FROM household_records 
      WHERE year_month = $1 AND income_expense = '支出'
      GROUP BY category, person
      ORDER BY category, person
    `, [yearMonth]);

    // カテゴリ別詳細データを取得
    const detailResult = await client.query(`
      SELECT category, person, record_date, payment_method, amount, location, memo
      FROM household_records 
      WHERE year_month = $1 AND income_expense = '支出'
      ORDER BY category, person, record_date
    `, [yearMonth]);

    // 人別の総支出を取得
    const personTotalResult = await client.query(`
      SELECT person, SUM(amount) as total_amount
      FROM household_records 
      WHERE year_month = $1 AND income_expense = '支出'
      GROUP BY person
      ORDER BY person
    `, [yearMonth]);

    // 全体の総支出
    const totalResult = await client.query(`
      SELECT SUM(amount) as grand_total
      FROM household_records 
      WHERE year_month = $1 AND income_expense = '支出'
    `, [yearMonth]);

    client.release();

    const grandTotal = parseInt(totalResult.rows[0].grand_total || 0);
    const personTotals = personTotalResult.rows;
    const categoryData = categoryResult.rows;
    const detailData = detailResult.rows;
    
    // 人数と一人当たりの金額を計算
    const personCount = personTotals.length;
    const perPersonAmount = personCount > 0 ? Math.round(grandTotal / personCount) : 0;

    // カテゴリ別テーブル（詳細展開機能付き）
    let categoryTable = '';
    if (categoryData.length > 0) {
      const categories = [...new Set(categoryData.map(row => row.category))];
      const persons = [...new Set(categoryData.map(row => row.person))];

      categoryTable = `
        <div class="table-container">
          <table class="summary-table">
            <thead>
              <tr>
                <th>カテゴリ</th>
                ${persons.map(person => `<th>${person}</th>`).join('')}
                <th>合計</th>
              </tr>
            </thead>
            <tbody>
      `;

      for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex++) {
        const category = categories[categoryIndex];
        let categoryTotal = 0;
        let row = `<tr class="category-row" onclick="toggleDetails('cat${categoryIndex}')">
          <td><button class="expand-btn expand-cat${categoryIndex}">+</button><strong>${category}</strong></td>`;
        
        for (const person of persons) {
          const amount = categoryData.find(d => d.category === category && d.person === person)?.total_amount || 0;
          categoryTotal += parseInt(amount);
          row += `<td class="amount">¥${parseInt(amount).toLocaleString()}</td>`;
        }
        
        row += `<td class="amount"><strong>¥${categoryTotal.toLocaleString()}</strong></td></tr>`;
        categoryTable += row;

        // 詳細行を追加
        for (const person of persons) {
          const personDetails = detailData.filter(d => d.category === category && d.person === person);
          if (personDetails.length > 0) {
            categoryTable += `
              <tr class="detail-row detail-cat${categoryIndex}">
                <td colspan="${persons.length + 2}">
                  <div style="margin-left: 35px;">
                    <h4>${person}の詳細</h4>
                    <div class="table-container">
                      <table class="detail-table">
                        <thead>
                          <tr>
                            <th>日付</th>
                            <th>金額</th>
                            <th>場所</th>
                            <th>メモ</th>
                          </tr>
                        </thead>
                        <tbody>
            `;
            
            for (const detail of personDetails) {
              categoryTable += `
                <tr>
                  <td>${new Date(detail.record_date).toLocaleDateString('ja-JP')}</td>
                  <td class="amount">¥${parseInt(detail.amount).toLocaleString()}</td>
                  <td>${detail.location}</td>
                  <td>${detail.memo}</td>
                </tr>
              `;
            }
            
            categoryTable += `
                        </tbody>
                      </table>
                    </div>
                  </div>
                </td>
              </tr>
            `;
          }
        }
      }

      categoryTable += '</tbody></table></div>';
    }

    // 清算計算テーブル
    let settlementTable = '';
    if (personTotals.length > 0) {
      settlementTable = `
        <div class="table-container">
          <table class="summary-table">
            <thead>
              <tr>
                <th>支払者</th>
                <th>支払総額</th>
                <th>一人当たり</th>
                <th>差額</th>
              </tr>
            </thead>
            <tbody>
      `;

      const settlements = [];
      
      for (const person of personTotals) {
        const paid = parseInt(person.total_amount);
        const shouldPay = perPersonAmount;
        const difference = paid - shouldPay;
        
        settlements.push({
          person: person.person,
          paid,
          shouldPay,
          difference
        });

        const diffClass = difference > 0 ? 'positive' : difference < 0 ? 'negative' : '';
        const settlementText = difference > 0 ? `¥${difference.toLocaleString()} 受け取り` : 
                              difference < 0 ? `¥${Math.abs(difference).toLocaleString()} 支払い` : '清算済み';

        settlementTable += `
          <tr>
            <td><strong>${person.person}</strong></td>
            <td class="amount">¥${paid.toLocaleString()}</td>
            <td class="amount">¥${shouldPay.toLocaleString()}</td>
            <td class="amount ${diffClass}">¥${difference.toLocaleString()}</td>
          </tr>
        `;
      }

      settlementTable += '</tbody></table></div>';

      // 具体的な清算指示
      const creditors = settlements.filter(s => s.difference > 0).sort((a, b) => b.difference - a.difference);
      const debtors = settlements.filter(s => s.difference < 0).sort((a, b) => a.difference - b.difference);
      
      if (creditors.length > 0 && debtors.length > 0) {
        settlementTable += '<div class="settlement"><h3>💰 清算指示</h3><ul>';
        
        let i = 0, j = 0;
        while (i < creditors.length && j < debtors.length) {
          const creditor = creditors[i];
          const debtor = debtors[j];
          const transferAmount = Math.min(creditor.difference, Math.abs(debtor.difference));
          
          settlementTable += `<li><strong>${debtor.person}</strong> → <strong>${creditor.person}</strong>: ¥${transferAmount.toLocaleString()}</li>`;
          
          creditor.difference -= transferAmount;
          debtor.difference += transferAmount;
          
          if (creditor.difference === 0) i++;
          if (debtor.difference === 0) j++;
        }
        
        settlementTable += '</ul></div>';
      }
    }

    const content = `
      <h2>🌙 ${yearMonth} 月次サマリー</h2>
      
      <div class="settlement">
        <h3>💰 支出サマリー</h3>
        <p><strong>生活費合計:</strong> ¥${grandTotal.toLocaleString()}</p>
        <p><strong>参加人数:</strong> ${personCount}人</p>
        <p><strong>一人当たり:</strong> ¥${perPersonAmount.toLocaleString()}</p>
      </div>

      <h3>👰 支払者別支出</h3>
      ${settlementTable}

      <h3>🐬 カテゴリ別詳細 <small>（行をクリックで詳細表示）</small></h3>
      ${categoryTable}

      <div class="btn-container">
        <button onclick="location.href='/available-months'" class="btn-success">サマリー一覧に戻る</button>
        <button onclick="location.href='/'" class="btn-secondary">ホームに戻る</button>
        <button onclick="window.print()" class="btn-info">印刷</button>
      </div>
    `;

    res.send(getHTMLTemplate(content, user));
  } catch (error) {
    const content = `
      <div class="alert alert-error">
        <h3>❌ エラー</h3>
        <p>${error.message}</p>
      </div>
      <button onclick="location.href='/available-months'" class="btn-primary">サマリー一覧に戻る</button>
    `;
    res.send(getHTMLTemplate(content, user));
  }
});

// サマリー一覧（旧：利用可能な月一覧）
app.get('/available-months', auth.requireAuth, async (req, res) => {
  const user = auth.getUser(req);
  try {
    const client = await pool.connect();
    const result = await client.query(`
      SELECT year_month, COUNT(*) as record_count
      FROM household_records
      GROUP BY year_month
      ORDER BY year_month DESC
    `);
    client.release();

    let content = '<h2>📋 サマリー一覧</h2>';
    
    if (result.rows.length > 0) {
      content += `
        <div class="table-container">
          <table class="summary-table">
            <thead>
              <tr>
                <th>年月</th>
                <th>レコード数</th>
              </tr>
            </thead>
            <tbody>
      `;
      
      for (const row of result.rows) {
        content += `
          <tr onclick="location.href='/summary?yearMonth=${row.year_month}'" style="cursor: pointer;">
            <td><strong>${row.year_month}</strong></td>
            <td class="amount">${row.record_count}件</td>
          </tr>
        `;
      }
      
      content += '</tbody></table></div>';
    } else {
      content += '<div class="alert alert-error"><p>データがありません。CSVファイルを読み込んでください。</p></div>';
    }

    content += '<div class="btn-container"><button onclick="location.href=\'/\'" class="btn-primary">ホームに戻る</button></div>';

    res.send(getHTMLTemplate(content, user));
  } catch (error) {
    const content = `
      <div class="alert alert-error">
        <h3>❌ エラー</h3>
        <p>${error.message}</p>
      </div>
      <button onclick="location.href='/'" class="btn-primary">ホームに戻る</button>
    `;
    res.send(getHTMLTemplate(content, user));
  }
});

// バックアップエンドポイント（手動バックアップ）
app.post('/backup/manual', auth.requireAuth, async (req, res) => {
  const user = auth.getUser(req);
  try {
    console.log(`Manual backup triggered by user: ${user.name}`);
    const result = await backup.performBackup();
    
    const content = `
      <div class="alert alert-success">
        <h3>✅ バックアップ成功</h3>
        <p>データベースのバックアップが正常に完了しました。</p>
        <p><strong>ファイル名:</strong> ${result.fileName}</p>
        <p><strong>保存先:</strong> NAS (${process.env.BACKUP_NAS_API_URL || 'Not configured'})</p>
      </div>
      <button onclick="location.href='/'" class="btn-primary">ホームに戻る</button>
    `;
    res.send(getHTMLTemplate(content, user));
  } catch (error) {
    console.error('Manual backup failed:', error);
    const content = `
      <div class="alert alert-error">
        <h3>❌ バックアップ失敗</h3>
        <p>${error.message}</p>
        <p>ログを確認してください。NAS APIの設定が正しいか確認してください。</p>
      </div>
      <button onclick="location.href='/'" class="btn-primary">ホームに戻る</button>
    `;
    res.send(getHTMLTemplate(content, user));
  }
});

// バックアップ状態確認エンドポイント
app.get('/backup/status', auth.requireAuth, async (req, res) => {
  const user = auth.getUser(req);
  try {
    const health = await backup.checkBackupHealth();
    
    const statusIcon = health.status === 'ok' ? '✅' : health.status === 'warning' ? '⚠️' : '❌';
    const statusClass = health.status === 'ok' ? 'alert-success' : 'alert-error';
    
    const content = `
      <h2>💾 バックアップ設定状況</h2>
      <div class="${statusClass}">
        <h3>${statusIcon} ステータス: ${health.status.toUpperCase()}</h3>
        <p>${health.message}</p>
      </div>
      
      <div class="settlement">
        <h3>📋 設定情報</h3>
        <p><strong>NAS API URL:</strong> ${process.env.BACKUP_NAS_API_URL || '未設定'}</p>
        <p><strong>スケジュール:</strong> ${process.env.BACKUP_SCHEDULE || '0 3 * * 0 (毎週日曜日 午前3時)'}</p>
        <p><strong>認証トークン:</strong> ${process.env.BACKUP_NAS_API_TOKEN ? '設定済み' : '未設定'}</p>
      </div>

      <div class="btn-container">
        <button onclick="if(confirm('データベースのバックアップを実行しますか？')) { document.getElementById('manualBackupForm').submit(); }" class="btn-success">手動バックアップ実行</button>
        <button onclick="location.href='/'" class="btn-secondary">ホームに戻る</button>
      </div>

      <form id="manualBackupForm" action="/backup/manual" method="POST" style="display: none;"></form>
    `;
    res.send(getHTMLTemplate(content, user));
  } catch (error) {
    const content = `
      <div class="alert alert-error">
        <h3>❌ エラー</h3>
        <p>${error.message}</p>
      </div>
      <button onclick="location.href='/'" class="btn-primary">戻る</button>
    `;
    res.send(getHTMLTemplate(content, user));
  }
});

// サーバー起動
async function startServer() {
  try {
    // OIDC クライアントの初期化
    await auth.initializeOIDC();
    console.log('OIDC authentication configured');
    
    // バックアップスケジューラーの設定
    const backupSchedule = process.env.BACKUP_SCHEDULE || '0 3 * * 0'; // デフォルト: 毎週日曜日午前3時
    console.log(`Backup schedule: ${backupSchedule}`);
    
    cron.schedule(backupSchedule, async () => {
      console.log(`[${new Date().toISOString()}] Scheduled backup started`);
      try {
        const result = await backup.performBackup();
        console.log(`[${new Date().toISOString()}] Scheduled backup completed: ${result.fileName}`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Scheduled backup failed:`, error);
      }
    }, {
      timezone: "Asia/Tokyo"
    });
    
    console.log('Backup scheduler configured');
    
    // サーバー起動
    app.listen(port, () => {
      console.log(`家計簿管理システムが起動しました: http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

// データベース接続テスト
pool.connect((err, client, release) => {
  if (err) {
    console.error('データベース接続エラー:', err);
  } else {
    console.log('PostgreSQLに接続しました');
    release();
  }
});
