FROM node:20-slim AS base
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npx prisma generate
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json ./package.json
RUN npx playwright install --with-deps chromium

CMD ["sh", "-c", "\
  echo '--- backup GlobalConfig ---' && \
  sh ./prisma/backup_restore_config.sh backup || echo 'backup skip (table may not exist)'; \
  echo '--- prisma db push ---' && \
  npx prisma db push --skip-generate --accept-data-loss && echo 'push ok' || echo 'push warn'; \
  echo '--- ensure_columns.sql ---' && \
  npx prisma db execute --url=$DATABASE_URL --file=./prisma/ensure_columns.sql && echo 'columns ok' || echo 'SQL FAILED'; \
  echo '--- restore GlobalConfig ---' && \
  sh ./prisma/backup_restore_config.sh restore || echo 'restore skip'; \
  npx tsx prisma/seed.ts || true; \
  node dist/server.js"]
