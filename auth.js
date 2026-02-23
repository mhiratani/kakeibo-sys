const { Issuer, generators } = require('openid-client');

let client = null;

/**
 * OIDC クライアントの初期化
 */
async function initializeOIDC() {
  try {
    const issuerUrl = process.env.OIDC_ISSUER;
    const clientId = process.env.OIDC_CLIENT_ID;
    const clientSecret = process.env.OIDC_CLIENT_SECRET;
    const redirectUri = process.env.OIDC_REDIRECT_URI;

    if (!issuerUrl || !clientId || !clientSecret || !redirectUri) {
      throw new Error('OIDC configuration is incomplete. Please check environment variables.');
    }

    console.log(`Discovering OIDC configuration from: ${issuerUrl}`);
    
    // Issuerの検出
    const issuer = await Issuer.discover(issuerUrl);
    console.log('Discovered issuer:', issuer.metadata.issuer);

    // クライアントの作成
    client = new issuer.Client({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: [redirectUri],
      response_types: ['code'],
    });

    console.log('OIDC client initialized successfully');
    return client;
  } catch (error) {
    console.error('Failed to initialize OIDC client:', error);
    throw error;
  }
}

/**
 * OIDC クライアントの取得
 */
function getClient() {
  if (!client) {
    throw new Error('OIDC client is not initialized. Call initializeOIDC() first.');
  }
  return client;
}

/**
 * 認証URLの生成
 */
function generateAuthUrl(req) {
  const client = getClient();
  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);
  const state = generators.state();

  // セッションに保存
  req.session.code_verifier = code_verifier;
  req.session.state = state;

  const authUrl = client.authorizationUrl({
    scope: 'openid profile email',
    code_challenge,
    code_challenge_method: 'S256',
    state,
  });

  // セッションを明示的に保存してからリダイレクト
  return new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        reject(new Error('セッション保存に失敗しました'));
      } else {
        resolve(authUrl);
      }
    });
  });
}

/**
 * 認証コールバック処理
 */
async function handleCallback(req) {
  const client = getClient();
  const params = client.callbackParams(req);
  
  // stateの検証
  if (params.state !== req.session.state) {
    throw new Error('State mismatch - possible CSRF attack');
  }

  const code_verifier = req.session.code_verifier;

  // トークンの取得
  const tokenSet = await client.callback(
    process.env.OIDC_REDIRECT_URI,
    params,
    { code_verifier, state: req.session.state }
  );

  // ユーザー情報の取得
  const userinfo = await client.userinfo(tokenSet.access_token);

  // セッションにユーザー情報を保存
  req.session.user = {
    sub: userinfo.sub,
    name: userinfo.name || userinfo.preferred_username || userinfo.email,
    email: userinfo.email,
    picture: userinfo.picture,
  };

  req.session.tokenSet = {
    access_token: tokenSet.access_token,
    id_token: tokenSet.id_token,
    expires_at: tokenSet.expires_at,
  };

  // 一時データをクリーンアップ
  delete req.session.code_verifier;
  delete req.session.state;

  return req.session.user;
}

/**
 * ログアウト処理
 */
async function handleLogout(req) {
  return new Promise((resolve) => {
    const user = req.session.user;
    req.session.destroy((err) => {
      if (err) {
        console.error('Session destruction error:', err);
      }
      resolve(user);
    });
  });
}

/**
 * 認証チェックミドルウェア
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  
  // 未認証の場合、ログインページへリダイレクト
  res.redirect('/auth/login');
}

/**
 * 認証済みユーザー情報の取得
 */
function getUser(req) {
  return req.session?.user || null;
}

module.exports = {
  initializeOIDC,
  getClient,
  generateAuthUrl,
  handleCallback,
  handleLogout,
  requireAuth,
  getUser,
};