require('dotenv').config();
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

/**
 * PostgreSQLデータベースのバックアップを実行し、NASに送信する
 */
async function performBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFileName = `household_budget_backup_${timestamp}.sql`;
  const backupPath = path.join('/tmp', backupFileName);

  console.log(`[${new Date().toISOString()}] Starting database backup...`);

  try {
    // 1. pg_dumpでバックアップファイルを作成
    await createDatabaseDump(backupPath);
    console.log(`[${new Date().toISOString()}] Database dump created: ${backupPath}`);

    // 2. NASのAPIにバックアップファイルを送信
    if (process.env.BACKUP_NAS_API_URL) {
      await uploadToNAS(backupPath, backupFileName);
      console.log(`[${new Date().toISOString()}] Backup uploaded to NAS successfully`);
    } else {
      console.warn('[WARNING] BACKUP_NAS_API_URL not configured. Backup file saved locally only.');
    }

    // 3. ローカルの一時ファイルを削除
    fs.unlinkSync(backupPath);
    console.log(`[${new Date().toISOString()}] Local backup file cleaned up`);

    return { success: true, fileName: backupFileName };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Backup failed:`, error);
    
    // エラー時もローカルファイルをクリーンアップ
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
    
    throw error;
  }
}

/**
 * pg_dumpコマンドでデータベースのバックアップを作成
 */
function createDatabaseDump(outputPath) {
  return new Promise((resolve, reject) => {
    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || 5432;
    const dbName = process.env.DB_NAME || 'household_budget';
    const dbUser = process.env.DB_USER || 'budget_user';
    const dbPassword = process.env.DB_PASSWORD || 'budget_pass';

    // pg_dumpコマンドを構築
    const command = `PGPASSWORD="${dbPassword}" pg_dump -h ${dbHost} -p ${dbPort} -U ${dbUser} -d ${dbName} -f ${outputPath}`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`pg_dump failed: ${error.message}\n${stderr}`));
        return;
      }
      
      if (stderr && !stderr.includes('warning')) {
        console.warn(`pg_dump warnings: ${stderr}`);
      }
      
      resolve();
    });
  });
}

/**
 * NASのAPIにバックアップファイルをアップロード
 */
async function uploadToNAS(filePath, fileName) {
  const nasApiUrl = process.env.BACKUP_NAS_API_URL;
  const nasApiToken = process.env.BACKUP_NAS_API_TOKEN || '';
  
  if (!nasApiUrl) {
    throw new Error('BACKUP_NAS_API_URL is not configured');
  }

  // FormDataを使ってファイルを送信
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('fileName', fileName);
  form.append('source', 'kakeibo-sys');

  try {
    const response = await axios.post(nasApiUrl, form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${nasApiToken}`,
      },
      timeout: 60000, // 60秒タイムアウト
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`NAS API returned status ${response.status}: ${response.data}`);
    }

    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(`NAS API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      throw new Error(`NAS API request failed: ${error.message}`);
    } else {
      throw error;
    }
  }
}

/**
 * バックアップの状態をチェック
 */
async function checkBackupHealth() {
  try {
    if (!process.env.BACKUP_NAS_API_URL) {
      return {
        status: 'warning',
        message: 'BACKUP_NAS_API_URL not configured',
      };
    }

    // NAS APIへの接続テスト
    // URLからオリジン（プロトコル+ホスト+ポート）を抽出
    try {
      const apiUrl = new URL(process.env.BACKUP_NAS_API_URL);
      const healthUrl = `${apiUrl.origin}/health`;
      
      const response = await axios.get(healthUrl, {
        timeout: 5000,
        headers: {
          'Authorization': `Bearer ${process.env.BACKUP_NAS_API_TOKEN || ''}`,
        },
      });

      if (response.status === 200 && response.data) {
        const service = response.data.service || 'NAS Backup Server';
        return {
          status: 'ok',
          message: `${service} is reachable and healthy`,
        };
      } else {
        return {
          status: 'warning',
          message: `NAS API returned unexpected response: ${response.status}`,
        };
      }
    } catch (error) {
      // ネットワークエラーの場合
      if (error.code === 'ECONNREFUSED') {
        return {
          status: 'error',
          message: 'NAS API connection refused (server may be offline)',
        };
      } else if (error.code === 'ENOTFOUND') {
        return {
          status: 'error',
          message: 'NAS API host not found (check URL configuration)',
        };
      } else if (error.code === 'ETIMEDOUT') {
        return {
          status: 'warning',
          message: 'NAS API health check timed out',
        };
      } else if (error.response) {
        // HTTPエラーレスポンス
        return {
          status: 'warning',
          message: `NAS API health check failed: ${error.response.status}`,
        };
      } else {
        return {
          status: 'warning',
          message: `Health check error: ${error.message}`,
        };
      }
    }
  } catch (error) {
    return {
      status: 'warning',
      message: `Health check error: ${error.message}`,
    };
  }
}

module.exports = {
  performBackup,
  checkBackupHealth,
};
