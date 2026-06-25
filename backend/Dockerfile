# Backend (Node + Express + TypeScript via tsx)
FROM node:20-slim

# Build tools for native modules (better-sqlite3, bcrypt)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
EXPOSE 3002

# tsx runs the TypeScript entrypoint directly (matches the dev runtime).
CMD ["npx", "tsx", "src/server.ts"]
