#!/bin/sh
# backup_restore_config.sh — Preserves GlobalConfig across prisma db push
#
# prisma db push --accept-data-loss drops tables NOT in schema.prisma.
# GlobalConfig is raw-SQL only → gets wiped every deploy.
# This script saves the key BEFORE push and restores it AFTER ensure_columns.sql.

BACKUP_FILE="/tmp/globalconfig_backup.json"

case "$1" in
  backup)
    echo "[config-backup] Saving GlobalConfig..."
    node --input-type=module -e "
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
const p = new PrismaClient();
try {
  const rows = await p.\$queryRawUnsafe(
    'SELECT \"ollamaApiKey\", \"ollamaLangModel\", \"ollamaVisionModel\" FROM \"GlobalConfig\" WHERE id = \\'global\\' LIMIT 1'
  );
  if (rows.length > 0 && rows[0].ollamaApiKey) {
    writeFileSync('$BACKUP_FILE', JSON.stringify(rows[0]));
    console.log('[config-backup] Saved key=' + rows[0].ollamaApiKey.slice(0,12) + '...');
  } else {
    console.log('[config-backup] No key found — nothing to backup');
  }
} catch (e) {
  console.log('[config-backup] Table not found (first deploy?) — skipping');
} finally {
  await p.\$disconnect();
}
"
    ;;

  restore)
    if [ ! -f "$BACKUP_FILE" ]; then
      echo "[config-restore] No backup file — skipping"
      exit 0
    fi

    echo "[config-restore] Restoring GlobalConfig..."
    node --input-type=module -e "
import { PrismaClient } from '@prisma/client';
import { readFileSync, unlinkSync } from 'fs';
const p = new PrismaClient();
try {
  const data = JSON.parse(readFileSync('$BACKUP_FILE', 'utf8'));
  if (!data.ollamaApiKey) {
    console.log('[config-restore] No key in backup — skip');
    process.exit(0);
  }
  const r = await p.\$executeRawUnsafe(
    'UPDATE \"GlobalConfig\" SET \"ollamaApiKey\" = \$1, \"ollamaLangModel\" = \$2, \"ollamaVisionModel\" = \$3, \"updatedAt\" = NOW() WHERE id = \\'global\\'',
    data.ollamaApiKey,
    data.ollamaLangModel || 'gpt-oss:120b',
    data.ollamaVisionModel || 'qwen3-vl:235b'
  );
  console.log('[config-restore] Restored key=' + data.ollamaApiKey.slice(0,12) + '... rows=' + r);
  unlinkSync('$BACKUP_FILE');
} catch (e) {
  console.error('[config-restore] Error:', e.message);
} finally {
  await p.\$disconnect();
}
"
    ;;

  *)
    echo "Usage: \$0 {backup|restore}"
    exit 1
    ;;
esac
