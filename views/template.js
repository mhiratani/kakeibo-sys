// HTMLテンプレート生成関数（レスポンシブ対応）
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
    <link rel="stylesheet" href="/css/style.css">
</head>
<body>
    <div class="container">
        <h1>📊 出費サマリーApp</h1>
        ${userNav}
        ${content}
    </div>
    <script src="/js/main.js"></script>
</body>
</html>
  `;
};

module.exports = { getHTMLTemplate };
