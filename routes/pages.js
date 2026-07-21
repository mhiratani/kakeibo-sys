const express = require('express');
const fs = require('fs');
const multer = require('multer');
const auth = require('../auth');
const backup = require('../backup');
const { pool } = require('../db');
const { parseAndSaveCSV } = require('../lib/csv-import');
const { getHTMLTemplate } = require('../views/template');

const router = express.Router();
const upload = multer({ dest: 'csv_files/' });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// pg の DATE 型はローカルタイムの Date で返るため、UTC変換(toISOString)だと1日ずれる
function formatDate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function errorPage(res, user, message, backHref = '/') {
  const content = `
    <div class="alert alert-error">
      <h3>❌ エラー</h3>
      <p>${escapeHtml(message)}</p>
    </div>
    <button onclick="location.href='${backHref}'" class="btn-primary">戻る</button>
  `;
  res.send(getHTMLTemplate(content, user));
}

// メインページ
router.get('/', auth.requireAuth, (req, res) => {
  const user = auth.getUser(req);
  const content = `
    <div class="form-section">
      <h2>✏️ 記録を追加</h2>
      <p class="hint">1件ずつ入力できます。登録後は続けて次の入力へ（連続登録）。</p>
      <button onclick="openRecordDialog()" class="btn-primary">記録を追加する</button>
    </div>

    <div class="form-section">
      <h2>🛒 何買ったっけ？</h2>
      <p class="hint">カレンダーから日を選ぶと、その日の買い物をカテゴリ別の円グラフと一覧で確認できます。</p>
      <button onclick="location.href='/daily'" class="btn-success">カレンダーを開く</button>
    </div>

    <div class="form-section">
      <h2>🐟️ サマリー一覧</h2>
      <button onclick="location.href='/available-months'" class="btn-success">サマリー一覧を見る</button>
    </div>

    <div class="form-section">
      <h2>🗂️ マスター管理</h2>
      <p class="hint">登録時に選択する「人」と「カテゴリ」を管理します。</p>
      <button onclick="location.href='/masters'" class="btn-info">人・カテゴリを管理</button>
    </div>

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
      <h2>💾 バックアップ管理</h2>
      <button onclick="location.href='/backup/status'" class="btn-info">バックアップ設定・実行</button>
    </div>

    <button type="button" class="fab" onclick="openRecordDialog()" aria-label="記録を追加">＋</button>
  `;
  res.send(getHTMLTemplate(content, user));
});

// マスター管理ページ
router.get('/masters', auth.requireAuth, (req, res) => {
  const user = auth.getUser(req);
  const content = `
    <h2>🗂️ マスター管理</h2>
    <p class="hint">登録ダイアログの選択肢に表示される「人」と「カテゴリ」を管理します。マスターを削除しても登録済みの記録は変わりません。</p>

    <div class="form-section">
      <h3>👤 人</h3>
      <div id="personList" class="master-list"></div>
      <div class="master-add">
        <input id="personName" placeholder="名前を入力" maxlength="50">
        <button type="button" id="personAdd" class="btn-success">追加</button>
      </div>
    </div>

    <div class="form-section">
      <h3>🏷️ カテゴリ</h3>
      <div id="categoryList" class="master-list"></div>
      <div class="master-add">
        <input id="categoryName" placeholder="カテゴリ名を入力" maxlength="100">
        <button type="button" id="categoryAdd" class="btn-success">追加</button>
      </div>
    </div>

    <div class="btn-container">
      <button onclick="location.href='/'" class="btn-secondary">ホームに戻る</button>
    </div>
  `;
  res.send(getHTMLTemplate(content, user, { scripts: ['/js/masters.js'] }));
});

// 「何買ったっけ？」日別ビュー（カレンダー+カテゴリ別円グラフ+明細一覧）
router.get('/daily', auth.requireAuth, (req, res) => {
  const user = auth.getUser(req);
  const content = `
    <h2>🛒 何買ったっけ？</h2>
    <p class="hint">日付をタップすると、その日の買い物をカテゴリ別の円グラフと一覧で表示します。明細行をタップすると編集・削除できます。</p>

    <div class="form-section">
      <div class="cal-header">
        <button type="button" id="calPrev" class="cal-nav" aria-label="前の月">◀</button>
        <span id="calTitle" class="cal-title"></span>
        <button type="button" id="calNext" class="cal-nav" aria-label="次の月">▶</button>
      </div>
      <div id="calendar" class="calendar"></div>
    </div>

    <div id="dayDetail" class="day-detail" hidden>
      <h3 id="dayDetailTitle"></h3>
      <div class="viz-root">
        <div class="donut-wrap">
          <svg id="donutChart" viewBox="0 0 200 200" role="img" aria-label="カテゴリ別支出の円グラフ"></svg>
          <div class="donut-center">
            <span class="donut-center-label">合計</span>
            <span id="donutTotal" class="donut-center-value"></span>
          </div>
          <div id="chartTooltip" class="chart-tooltip" hidden></div>
        </div>
        <div id="chartLegend" class="chart-legend"></div>
      </div>
      <div id="dayRecords"></div>
    </div>
    <div id="dayEmpty" class="alert alert-error" hidden><p>この日の記録はありません。</p></div>

    <div class="btn-container">
      <button onclick="location.href='/'" class="btn-secondary">ホームに戻る</button>
    </div>
    <button type="button" class="fab" onclick="openRecordDialog()" aria-label="記録を追加">＋</button>
  `;
  res.send(getHTMLTemplate(content, user, { scripts: ['/js/daily.js'] }));
});

// CSVアップロード処理
router.post('/upload', auth.requireAuth, upload.single('csvFile'), async (req, res) => {
  const user = auth.getUser(req);
  try {
    if (!req.file) {
      throw new Error('ファイルが選択されていません');
    }

    const result = await parseAndSaveCSV(req.file.path);
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
          <p>エラー: ${escapeHtml(result.error)}</p>
          ${result.errors.length > 0 ? `<ul>${result.errors.map((err) => `<li>${escapeHtml(err)}</li>`).join('')}</ul>` : ''}
        </div>
        <button onclick="location.href='/'" class="btn-primary">戻る</button>
      `;
    }

    res.send(getHTMLTemplate(content, user));
  } catch (error) {
    errorPage(res, user, error.message);
  }
});

// 月次サマリー表示
router.get('/summary', auth.requireAuth, async (req, res) => {
  const user = auth.getUser(req);
  try {
    const { yearMonth } = req.query;

    if (!yearMonth) {
      throw new Error('年月が指定されていません');
    }

    const client = await pool.connect();
    let categoryResult, detailResult, personTotalResult, totalResult;
    try {
      // カテゴリ別・人別の支出を取得
      categoryResult = await client.query(`
        SELECT category, person, SUM(amount) as total_amount
        FROM household_records
        WHERE year_month = $1 AND income_expense = '支出'
        GROUP BY category, person
        ORDER BY category, person
      `, [yearMonth]);

      // カテゴリ別詳細データを取得（編集用に id も取得）
      detailResult = await client.query(`
        SELECT id, category, person, record_date, income_expense, payment_method, amount, location, memo
        FROM household_records
        WHERE year_month = $1 AND income_expense = '支出'
        ORDER BY category, person, record_date
      `, [yearMonth]);

      // 人別の総支出を取得
      personTotalResult = await client.query(`
        SELECT person, SUM(amount) as total_amount
        FROM household_records
        WHERE year_month = $1 AND income_expense = '支出'
        GROUP BY person
        ORDER BY person
      `, [yearMonth]);

      // 全体の総支出
      totalResult = await client.query(`
        SELECT SUM(amount) as grand_total
        FROM household_records
        WHERE year_month = $1 AND income_expense = '支出'
      `, [yearMonth]);
    } finally {
      client.release();
    }

    const grandTotal = parseInt(totalResult.rows[0].grand_total || 0);
    const personTotals = personTotalResult.rows;
    const categoryData = categoryResult.rows;
    const detailData = detailResult.rows;

    const personCount = personTotals.length;
    const perPersonAmount = personCount > 0 ? Math.round(grandTotal / personCount) : 0;

    // カテゴリ別テーブル（詳細展開・明細タップで編集/削除）
    let categoryTable = '';
    if (categoryData.length > 0) {
      const categories = [...new Set(categoryData.map((row) => row.category))];
      const persons = [...new Set(categoryData.map((row) => row.person))];

      categoryTable = `
        <div class="table-container">
          <table class="summary-table">
            <thead>
              <tr>
                <th>カテゴリ</th>
                ${persons.map((person) => `<th>${escapeHtml(person)}</th>`).join('')}
                <th>合計</th>
              </tr>
            </thead>
            <tbody>
      `;

      for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex++) {
        const category = categories[categoryIndex];
        let categoryTotal = 0;
        let row = `<tr class="category-row" onclick="toggleDetails('cat${categoryIndex}')">
          <td><button class="expand-btn expand-cat${categoryIndex}">+</button><strong>${escapeHtml(category)}</strong></td>`;

        for (const person of persons) {
          const amount = categoryData.find((d) => d.category === category && d.person === person)?.total_amount || 0;
          categoryTotal += parseInt(amount);
          row += `<td class="amount">¥${parseInt(amount).toLocaleString()}</td>`;
        }

        row += `<td class="amount"><strong>¥${categoryTotal.toLocaleString()}</strong></td></tr>`;
        categoryTable += row;

        // 詳細行を追加
        for (const person of persons) {
          const personDetails = detailData.filter((d) => d.category === category && d.person === person);
          if (personDetails.length > 0) {
            categoryTable += `
              <tr class="detail-row detail-cat${categoryIndex}">
                <td colspan="${persons.length + 2}">
                  <div style="margin-left: 35px;">
                    <h4>${escapeHtml(person)}の詳細 <small>（行をタップで編集・削除）</small></h4>
                    <div class="table-container">
                      <table class="detail-table">
                        <thead>
                          <tr>
                            <th>日付</th>
                            <th>金額</th>
                            <th>場所</th>
                            <th>買ったもの</th>
                          </tr>
                        </thead>
                        <tbody>
            `;

            for (const detail of personDetails) {
              const recordJson = JSON.stringify({
                id: detail.id,
                record_date: formatDate(detail.record_date),
                income_expense: detail.income_expense,
                payment_method: detail.payment_method || '',
                category: detail.category,
                person: detail.person,
                amount: parseInt(detail.amount),
                location: detail.location || '',
                memo: detail.memo || '',
              });
              categoryTable += `
                <tr class="record-row" data-record="${escapeHtml(recordJson)}">
                  <td class="nowrap-cell">${new Date(detail.record_date).toLocaleDateString('ja-JP')}</td>
                  <td class="amount">¥${parseInt(detail.amount).toLocaleString()}</td>
                  <td>${escapeHtml(detail.location)}</td>
                  <td>${escapeHtml(detail.memo)}</td>
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

        settlements.push({ person: person.person, paid, shouldPay, difference });

        const diffClass = difference > 0 ? 'positive' : difference < 0 ? 'negative' : '';

        settlementTable += `
          <tr>
            <td><strong>${escapeHtml(person.person)}</strong></td>
            <td class="amount">¥${paid.toLocaleString()}</td>
            <td class="amount">¥${shouldPay.toLocaleString()}</td>
            <td class="amount ${diffClass}">¥${difference.toLocaleString()}</td>
          </tr>
        `;
      }

      settlementTable += '</tbody></table></div>';

      // 具体的な清算指示
      const creditors = settlements.filter((s) => s.difference > 0).sort((a, b) => b.difference - a.difference);
      const debtors = settlements.filter((s) => s.difference < 0).sort((a, b) => a.difference - b.difference);

      if (creditors.length > 0 && debtors.length > 0) {
        settlementTable += '<div class="settlement"><h3>💰 清算指示</h3><ul>';

        let i = 0, j = 0;
        while (i < creditors.length && j < debtors.length) {
          const creditor = creditors[i];
          const debtor = debtors[j];
          const transferAmount = Math.min(creditor.difference, Math.abs(debtor.difference));

          settlementTable += `<li><strong>${escapeHtml(debtor.person)}</strong> → <strong>${escapeHtml(creditor.person)}</strong>: ¥${transferAmount.toLocaleString()}</li>`;

          creditor.difference -= transferAmount;
          debtor.difference += transferAmount;

          if (creditor.difference === 0) i++;
          if (debtor.difference === 0) j++;
        }

        settlementTable += '</ul></div>';
      }
    }

    const content = `
      <h2>🌙 ${escapeHtml(yearMonth)} 月次サマリー</h2>

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
        <button onclick="openRecordDialog()" class="btn-primary">＋ 記録を追加</button>
        <button onclick="location.href='/available-months'" class="btn-success">サマリー一覧に戻る</button>
        <button onclick="location.href='/'" class="btn-secondary">ホームに戻る</button>
        <button onclick="window.print()" class="btn-info">印刷</button>
      </div>

      <button type="button" class="fab" onclick="openRecordDialog()" aria-label="記録を追加">＋</button>
    `;

    res.send(getHTMLTemplate(content, user));
  } catch (error) {
    errorPage(res, user, error.message, '/available-months');
  }
});

// サマリー一覧
router.get('/available-months', auth.requireAuth, async (req, res) => {
  const user = auth.getUser(req);
  try {
    const result = await pool.query(`
      SELECT year_month, COUNT(*) as record_count
      FROM household_records
      GROUP BY year_month
      ORDER BY year_month DESC
    `);

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
          <tr onclick="location.href='/summary?yearMonth=${encodeURIComponent(row.year_month)}'" style="cursor: pointer;">
            <td><strong>${escapeHtml(row.year_month)}</strong></td>
            <td class="amount">${row.record_count}件</td>
          </tr>
        `;
      }

      content += '</tbody></table></div>';
    } else {
      content += '<div class="alert alert-error"><p>データがありません。記録を追加するか、CSVファイルを読み込んでください。</p></div>';
    }

    content += `
      <div class="btn-container">
        <button onclick="openRecordDialog()" class="btn-primary">＋ 記録を追加</button>
        <button onclick="location.href='/'" class="btn-secondary">ホームに戻る</button>
      </div>
      <button type="button" class="fab" onclick="openRecordDialog()" aria-label="記録を追加">＋</button>
    `;

    res.send(getHTMLTemplate(content, user));
  } catch (error) {
    errorPage(res, user, error.message);
  }
});

// バックアップエンドポイント（手動バックアップ）
router.post('/backup/manual', auth.requireAuth, async (req, res) => {
  const user = auth.getUser(req);
  try {
    console.log(`Manual backup triggered by user: ${user.name}`);
    const result = await backup.performBackup();

    const content = `
      <div class="alert alert-success">
        <h3>✅ バックアップ成功</h3>
        <p>データベースのバックアップが正常に完了しました。</p>
        <p><strong>ファイル名:</strong> ${escapeHtml(result.fileName)}</p>
        <p><strong>保存先:</strong> NAS (${escapeHtml(process.env.BACKUP_NAS_API_URL || 'Not configured')})</p>
      </div>
      <button onclick="location.href='/'" class="btn-primary">ホームに戻る</button>
    `;
    res.send(getHTMLTemplate(content, user));
  } catch (error) {
    console.error('Manual backup failed:', error);
    const content = `
      <div class="alert alert-error">
        <h3>❌ バックアップ失敗</h3>
        <p>${escapeHtml(error.message)}</p>
        <p>ログを確認してください。NAS APIの設定が正しいか確認してください。</p>
      </div>
      <button onclick="location.href='/'" class="btn-primary">ホームに戻る</button>
    `;
    res.send(getHTMLTemplate(content, user));
  }
});

// バックアップ状態確認エンドポイント
router.get('/backup/status', auth.requireAuth, async (req, res) => {
  const user = auth.getUser(req);
  try {
    const health = await backup.checkBackupHealth();

    const statusIcon = health.status === 'ok' ? '✅' : health.status === 'warning' ? '⚠️' : '❌';
    const statusClass = health.status === 'ok' ? 'alert-success' : 'alert-error';

    const content = `
      <h2>💾 バックアップ設定状況</h2>
      <div class="${statusClass}">
        <h3>${statusIcon} ステータス: ${escapeHtml(health.status.toUpperCase())}</h3>
        <p>${escapeHtml(health.message)}</p>
      </div>

      <div class="settlement">
        <h3>📋 設定情報</h3>
        <p><strong>NAS API URL:</strong> ${escapeHtml(process.env.BACKUP_NAS_API_URL || '未設定')}</p>
        <p><strong>スケジュール:</strong> ${escapeHtml(process.env.BACKUP_SCHEDULE || '0 3 * * 0 (毎週日曜日 午前3時)')}</p>
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
    errorPage(res, user, error.message);
  }
});

module.exports = router;
