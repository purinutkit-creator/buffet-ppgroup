FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
ENV DATA_DIR=/var/data PORT=10000 TRUST_PROXY=1
EXPOSE 10000
# Seeds demo data only when the database is empty, then starts the server
CMD ["sh", "-c", "node scripts/seed-demo.js && node server/index.js"]
