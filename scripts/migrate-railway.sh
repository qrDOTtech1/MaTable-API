#!/bin/bash
# Run ensure_columns.sql directly on Railway production DB via SSH
# Usage: bash scripts/migrate-railway.sh

SSH_HOST="shortline.proxy.rlwy.net"
SSH_PORT="23946"
SSH_USER="claude"
SSH_KEY="$HOME/.ssh/id_ed25519"

echo "🚀 Connexion Railway SSH..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" '
export DATABASE_URL="postgresql://postgres:yOUtrwLNgKsdbDelsEonINhkXNZYJmQM@postgres.railway.internal:5432/railway"
cd /data/workspace/MaTable-API
git pull origin main 2>&1 | tail -1
node -e "
const { Client } = require(\"pg\");
const fs = require(\"fs\");
const sql = fs.readFileSync(\"./prisma/ensure_columns.sql\", \"utf8\");
const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect()
  .then(() => client.query(sql))
  .then(() => { console.log(\"✅ ensure_columns.sql — OK\"); return client.end(); })
  .catch(e => { console.error(\"❌\", e.message); process.exit(1); });
"
'
