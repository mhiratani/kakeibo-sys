require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const fs = require('fs');
const cron = require('node-cron');
const auth = require('./auth');
const backup = require('./backup');
const { pool, ensureSchema } = require('./db');
const { getHTMLTemplate } = require('./views/template');
const apiRoutes = require('./routes/api');
const pageRoutes = require('./routes/pages');

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

// セッション設定（PostgreSQLストア使用）
app.use(session({
  store: new pgSession({
    pool: pool,                   // 既存のPostgreSQLプール
    tableName: 'session',         // セッションテーブル名
    createTableIfMissing: false,  // 起動時マイグレーションで作成済み
    pruneSessionInterval: 60 * 60 // 1時間ごとに期限切れセッションを削除
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true, // OIDC認証フローのために true
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
  res.send(getHTMLTemplate(content, user));
});

// JSON API（登録ダイアログ・マスター管理から利用）
app.use('/api', apiRoutes);

// 画面系ルート
app.use('/', pageRoutes);

// サーバー起動
async function startServer() {
  try {
    // DBスキーマの確認・マイグレーション
    await ensureSchema();
    console.log('Database schema ensured');

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
