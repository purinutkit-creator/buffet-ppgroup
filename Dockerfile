FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# Build tools for native modules (better-sqlite3) in case no prebuilt binary is available
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && npm ci --omit=dev && npm cache clean --force \
  && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY . .
ENV DATA_DIR=/var/data PORT=10000 TRUST_PROXY=1
EXPOSE 10000
# Seeds demo data only when the database is empty, then starts the server
CMD ["sh", "-c", "node scripts/seed-demo.js && node server/index.js"]
