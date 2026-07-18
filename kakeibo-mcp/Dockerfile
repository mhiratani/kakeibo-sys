FROM python:3.12-slim

WORKDIR /app

# 依存関係をコピーしてインストール
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# アプリケーションコードをコピー
COPY server.py .

# ポート公開
EXPOSE 3000

# サーバー起動
CMD ["python", "server.py"]
