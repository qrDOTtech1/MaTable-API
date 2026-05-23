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

#
# ⚠ PERSISTANCE DES DONNÉES CLIENT — RÈGLE ABSOLUE
#
# JAMAIS de `prisma db push` automatique au boot (drop tables raw-SQL :
# CustomerReview, GlobalConfig…). On utilise UNIQUEMENT le SQL idempotent
# `ensure_columns.sql` qui fait `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`.
# Les migrations schema doivent être ajoutées à `ensure_columns.sql` manuellement.
#
CMD ["sh", "-c", "\
  echo '--- ensure_columns.sql (idempotent, ne supprime jamais de données) ---' && \
  npx prisma db execute --url=$DATABASE_URL --file=./prisma/ensure_columns.sql && echo 'columns ok' || echo 'SQL FAILED'; \
  npx tsx prisma/seed.ts || true; \
  node dist/server.js"]
