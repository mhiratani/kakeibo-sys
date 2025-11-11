FROM node:18-alpine

WORKDIR /app

# パッケージファイルをコピー
COPY package*.json ./

# 依存関係をインストール（productionのみ）
RUN npm install --omit=dev

# インストール結果を確認
RUN ls -la node_modules/ && echo "Dependencies installed successfully"

# アプリケーションファイルをコピー
COPY . .

EXPOSE 3000

CMD ["npm", "start"]