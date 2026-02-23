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

const app = express();
const port = process.env.PORT || 3000;

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
        <h3>❌ 認証エラー</h3>
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

// HTMLテンプレート（レスポンシブ対応）
const getHTMLTemplate = (content, user = null) => {
  const userNav = user ? `
    <div class="user-nav">
      <span class="user-info">👤 ${user.name}</span>
      <button onclick="location.href='/auth/userinfo'" class="btn-info" style="width: auto; padding: 8px 16px; margin: 0 5px;">ユーザー情報</button>
      <button onclick="location.href='/auth/logout'" class="btn-secondary" style="width: auto; padding: 8px 16px; margin: 0;">ログアウト</button>
    </div>
  ` : '';
  
  return `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>出費サマリーApp</title>
    <style>
        /* リセット・ベーススタイル */
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Hiragino Kaku Gothic ProN', 'Hiragino Sans', 'Yu Gothic Medium', 'Meiryo', sans-serif;
            line-height: 1.6;
            color: #333;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 10px;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            padding: 15px;
            border-radius: 20px;
            box-shadow: 0 8px 32px rgba(31, 38, 135, 0.37);
            border: 1px solid rgba(255, 255, 255, 0.18);
        }

        /* タイポグラフィ */
        h1 {
            color: #4a5568;
            text-align: center;
            margin-bottom: 20px;
            font-size: 1.5rem;
            font-weight: 600;
            text-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }

        h2 {
            color: #2d3748;
            border-bottom: 3px solid #667eea;
            padding-bottom: 8px;
            margin-bottom: 15px;
            font-size: 1.2rem;
            font-weight: 600;
            background: linear-gradient(90deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        h3 {
            color: #666;
            margin: 15px 0 10px;
            font-size: 1.1rem;
        }

        h4 {
            color: #777;
            margin: 10px 0 5px;
            font-size: 1rem;
        }

        /* フォーム */
        .form-section {
            background: linear-gradient(145deg, #f7fafc, #edf2f7);
            padding: 15px;
            margin: 15px 0;
            border-radius: 15px;
            border: 1px solid rgba(160, 174, 192, 0.2);
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
        }

        .form-group {
            margin: 12px 0;
        }

        label {
            display: block;
            margin-bottom: 5px;
            font-weight: 600;
            color: #4a5568;
            font-size: 0.9rem;
        }

        input, select {
            width: 100%;
            padding: 12px;
            border: 2px solid #e2e8f0;
            border-radius: 12px;
            font-size: 16px; /* iOS zoom 防止 */
            background: white;
            transition: all 0.2s ease;
        }

        input:focus, select:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
            transform: translateY(-1px);
        }

        /* ボタン */
        button {
            width: 100%;
            padding: 12px;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            margin: 8px 0;
            transition: all 0.3s ease;
            text-decoration: none;
            display: inline-block;
            text-align: center;
            position: relative;
            overflow: hidden;
        }

        button::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
            transition: left 0.5s ease;
        }

        button:hover::before {
            left: 100%;
        }

        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 15px rgba(0,0,0,0.2);
        }

        button:active {
            transform: translateY(0);
        }

        /* ボタンの色バリエーション */
        button, .btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }

        .btn-secondary {
            background: linear-gradient(135deg, #6c757d 0%, #495057 100%);
            color: white;
        }

        .btn-success {
            background: linear-gradient(135deg, #28a745 0%, #20c997 100%);
            color: white;
        }

        .btn-info {
            background: linear-gradient(135deg, #17a2b8 0%, #6f42c1 100%);
            color: white;
        }

        /* テーブル */
        .table-container {
            overflow-x: auto;
            margin: 15px 0;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }

        .summary-table {
            width: 100%;
            border-collapse: collapse;
            min-width: 600px; /* スクロール用最小幅 */
            background: white;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
        }

        .summary-table th,
        .summary-table td {
            padding: 12px 8px;
            text-align: left;
            border-bottom: 1px solid #f1f5f9;
            font-size: 0.9rem;
        }

        .summary-table th {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            position: sticky;
            top: 0;
            z-index: 1;
            font-weight: 600;
        }

        .summary-table tr:hover {
            background: linear-gradient(90deg, #f8faff 0%, #f1f5f9 100%);
        }

        .amount {
            text-align: right !important;
            font-weight: 600;
            font-family: 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif;
        }

        .positive {
            color: #38a169;
            text-shadow: 0 1px 2px rgba(56, 161, 105, 0.2);
        }

        .negative {
            color: #e53e3e;
            text-shadow: 0 1px 2px rgba(229, 62, 62, 0.2);
        }

        /* カード風レイアウト（モバイル用代替表示） */
        .mobile-card {
            display: none;
        }

        /* アラート */
        .alert {
            padding: 18px;
            margin: 20px 0;
            border-radius: 12px;
            border: 1px solid transparent;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
        }

        .alert-success {
            background: linear-gradient(135deg, #f0fff4 0%, #c6f6d5 100%);
            border-color: #9ae6b4;
            color: #22543d;
        }

        .alert-error {
            background: linear-gradient(135deg, #fed7d7 0%, #feb2b2 100%);
            border-color: #fc8181;
            color: #742a2a;
        }

        .settlement {
            background: linear-gradient(135deg, #bee3f8 0%, #90cdf4 100%);
            padding: 20px;
            margin: 20px 0;
            border-radius: 15px;
            border-left: 5px solid #4299e1;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
        }

        /* カテゴリ詳細の展開機能 */
        .category-row {
            cursor: pointer;
            transition: background-color 0.2s;
        }

        .category-row:hover {
            background: #f0f8ff !important;
        }

        .expand-btn {
            background: linear-gradient(135deg, #48bb78 0%, #38a169 100%);
            color: white;
            border: none;
            border-radius: 50%;
            width: 28px;
            height: 28px;
            cursor: pointer;
            font-size: 14px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-right: 8px;
            min-width: 28px;
            box-shadow: 0 2px 4px rgba(72, 187, 120, 0.3);
            transition: all 0.2s ease;
        }

        .expand-btn:hover {
            background: linear-gradient(135deg, #38a169 0%, #2f855a 100%);
            transform: scale(1.1);
        }

        .expanded {
            transform: rotate(45deg);
        }

        .detail-row {
            display: none;
            background: linear-gradient(90deg, #f7fafc 0%, #edf2f7 100%);
            border-left: 4px solid #667eea;
        }

        .detail-row.show {
            display: table-row;
        }

        .detail-table {
            width: 100%;
            margin: 10px 0;
            border-collapse: collapse;
            font-size: 0.8rem;
            overflow-x: auto;
        }

        .detail-table th,
        .detail-table td {
            padding: 6px 4px;
            border: 1px solid #ddd;
            text-align: left;
            color: #333;
        }

        .detail-table th {
            background: #f1f3f4;
            font-size: 0.75rem;
            color: #333;
            font-weight: 600;
        }

        /* ボタンコンテナ */
        .btn-container {
            margin: 20px 0;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        /* ユーザーナビゲーション */
        .user-nav {
            display: flex;
            justify-content: flex-end;
            align-items: center;
            gap: 10px;
            margin-bottom: 20px;
            padding: 10px;
            background: linear-gradient(135deg, #f7fafc, #edf2f7);
            border-radius: 10px;
            flex-wrap: wrap;
        }

        .user-info {
            font-weight: 600;
            color: #4a5568;
            margin-right: auto;
        }

        /* ユーティリティクラス */
        .text-center {
            text-align: center;
        }

        .mt-20 {
            margin-top: 20px;
        }

        .mb-20 {
            margin-bottom: 20px;
        }

        /* タブレット用スタイル */
        @media (min-width: 768px) {
            body {
                padding: 20px;
            }

            .container {
                padding: 30px;
            }

            h1 {
                font-size: 2rem;
                margin-bottom: 30px;
            }

            h2 {
                font-size: 1.5rem;
                margin-bottom: 20px;
            }

            .form-section {
                padding: 20px;
                margin: 20px 0;
            }

            .btn-container {
                flex-direction: row;
                flex-wrap: wrap;
            }

            .btn-container button {
                flex: 1;
                min-width: 200px;
                margin: 5px;
            }

            .summary-table th,
            .summary-table td {
                padding: 12px;
                font-size: 1rem;
            }

            .detail-table {
                font-size: 0.9rem;
            }

            .detail-table th,
            .detail-table td {
                padding: 8px;
            }
        }

        /* デスクトップ用スタイル */
        @media (min-width: 1024px) {
            h1 {
                font-size: 2.5rem;
            }

            .form-section {
                display: flex;
                flex-direction: column;
            }

            .form-row {
                display: flex;
                gap: 20px;
                align-items: end;
            }

            .form-row .form-group {
                flex: 1;
            }

            .form-row button {
                width: auto;
                min-width: 120px;
                flex-shrink: 0;
            }

            input, select {
                max-width: 300px;
            }
        }

        /* モバイル用特別対応 */
        @media (max-width: 767px) {
            /* 小さな画面ではテーブルをカード形式で表示 */
            .mobile-card {
                display: block;
                background: white;
                margin: 10px 0;
                padding: 15px;
                border-radius: 8px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                border-left: 4px solid #007bff;
            }

            .mobile-card h4 {
                margin-bottom: 10px;
                color: #007bff;
            }

            .mobile-card .card-row {
                display: flex;
                justify-content: space-between;
                padding: 5px 0;
                border-bottom: 1px solid #eee;
            }

            .mobile-card .card-row:last-child {
                border-bottom: none;
            }

            .mobile-card .card-label {
                font-weight: bold;
                color: #666;
                flex: 1;
            }

            .mobile-card .card-value {
                flex: 1;
                text-align: right;
                font-family: 'Courier New', monospace;
            }

            /* 複雑なテーブルは横スクロール */
            .table-container {
                position: relative;
            }

            /* 詳細テーブルをモバイル用にコンパクト化 */
            .detail-table th,
            .detail-table td {
                padding: 4px 2px;
                font-size: 0.7rem;
            }

            /* ボタンのタッチ領域を確保 */
            button {
                min-height: 44px;
            }

            .expand-btn {
                min-width: 32px;
                min-height: 32px;
                width: 32px;
                height: 32px;
            }
        }

        /* 印刷用スタイル */
        @media print {
            body {
                background: white;
                color: black;
            }

            .container {
                box-shadow: none;
                max-width: none;
                padding: 0;
            }

            button, .btn-container {
                display: none;
            }

            .form-section {
                display: none;
            }

            .summary-table {
                font-size: 12px;
            }

            .summary-table th,
            .summary-table td {
                padding: 6px 4px;
            }

            .detail-row {
                display: table-row !important;
            }

            .expand-btn {
                display: none;
            }
        }

        /* アクセシビリティ対応 */
        @media (prefers-reduced-motion: reduce) {
            * {
                animation-duration: 0.01ms !important;
                animation-iteration-count: 1 !important;
                transition-duration: 0.01ms !important;
            }
        }

        /* ダークモード対応 */
        @media (prefers-color-scheme: dark) {
            body {
                background: linear-gradient(135deg, #2d3748 0%, #4a5568 100%);
                color: #f7fafc;
            }

            .container {
                background: rgba(45, 55, 72, 0.95);
                backdrop-filter: blur(10px);
                border: 1px solid rgba(255, 255, 255, 0.1);
            }

            .form-section {
                background: linear-gradient(145deg, #4a5568, #2d3748);
            }

            input, select {
                background: #2d3748;
                color: #f7fafc;
                border-color: #4a5568;
            }

            .summary-table {
                background: #2d3748;
            }

            .summary-table th {
                background: linear-gradient(135deg, #4299e1 0%, #3182ce 100%);
            }

            .summary-table tr:hover {
                background: linear-gradient(90deg, #4a5568 0%, #2d3748 100%);
            }

            .mobile-card {
                background: #4a5568;
            }

            .alert-success {
                background: linear-gradient(135deg, #22543d 0%, #2f855a 100%);
                border-color: #38a169;
                color: #9ae6b4;
            }

            .alert-error {
                background: linear-gradient(135deg, #742a2a 0%, #9b2c2c 100%);
                border-color: #e53e3e;
                color: #feb2b2;
            }

            .settlement {
                background: linear-gradient(135deg, #2c5282 0%, #3182ce 100%);
                border-left-color: #63b3ed;
                color: #f7fafc;
            }
        }
    </style>
    <script>
        function toggleDetails(categoryId) {
            const detailRows = document.querySelectorAll(\`.detail-\${categoryId}\`);
            const expandBtn = document.querySelector(\`.expand-\${categoryId}\`);
            
            detailRows.forEach(row => {
                row.classList.toggle('show');
            });
            
            if (expandBtn) {
                expandBtn.classList.toggle('expanded');
            }
        }

        // タッチデバイス検知
        function isTouchDevice() {
            return (('ontouchstart' in window) ||
                   (navigator.maxTouchPoints > 0) ||
                   (navigator.msMaxTouchPoints > 0));
        }

        // ページ読み込み完了時の処理
        document.addEventListener('DOMContentLoaded', function() {
            // タッチデバイスの場合、hover効果を調整
            if (isTouchDevice()) {
                document.body.classList.add('touch-device');
            }

            // テーブルにスワイプヒントを追加
            const tables = document.querySelectorAll('.table-container');
            tables.forEach(table => {
                table.addEventListener('scroll', function() {
                    if (this.scrollLeft > 0) {
                        this.classList.add('scrolled');
                    } else {
                        this.classList.remove('scrolled');
                    }
                });
            });
        });
    </script>
</head>
<body>
    <div class="container">
        <h1>📊 出費サマリーApp</h1>
        ${userNav}
        ${content}
    </div>
</body>
</html>
  `;
};

// メインページ
app.get('/', auth.requireAuth, (req, res) => {
  const user = auth.getUser(req);
  const content = `
    <div class="form-section">
      <h2>📁 CSVファイル読み込み</h2>
      <form action="/upload" method="post" enctype="multipart/form-data">
        <div class="form-group">
          <label for="csvFile">CSVファイルを選択:</label>
          <input type="file" id="csvFile" name="csvFile" accept=".csv" required>
        </div>
        <button type="submit" class="btn-primary">アップロード</button>
      </form>
    </div>

    <div class="form-section">
      <h2>📋 サマリー一覧</h2>
      <button onclick="location.href='/available-months'" class="btn-success">サマリー一覧を表示</button>
    </div>

    <div class="form-section">
      <h2>💾 バックアップ管理</h2>
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
      <h2>📊 ${yearMonth} 月次サマリー</h2>
      
      <div class="settlement">
        <h3>💰 支出サマリー</h3>
        <p><strong>生活費合計:</strong> ¥${grandTotal.toLocaleString()}</p>
        <p><strong>参加人数:</strong> ${personCount}人</p>
        <p><strong>一人当たり:</strong> ¥${perPersonAmount.toLocaleString()}</p>
      </div>

      <h3>👥 支払者別支出</h3>
      ${settlementTable}

      <h3>📋 カテゴリ別詳細 <small>（行をクリックで詳細表示）</small></h3>
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
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
      `;
      
      for (const row of result.rows) {
        content += `
          <tr>
            <td><strong>${row.year_month}</strong></td>
            <td class="amount">${row.record_count}件</td>
            <td>
              <button onclick="location.href='/summary?yearMonth=${row.year_month}'" class="btn-info" style="width: auto; padding: 8px 12px; margin: 0;">サマリー表示</button>
            </td>
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
