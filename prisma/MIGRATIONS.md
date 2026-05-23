# Procédure de migration DB — RÈGLE ABSOLUE

## ⛔ Ne JAMAIS faire

- `prisma db push` en automatique au boot (drop des tables raw-SQL → perte des avis, vouchers, etc.)
- `prisma db push --accept-data-loss`
- `prisma migrate reset`
- Inclure `prisma db push` dans le `start` ou le `CMD` Docker

## ✅ Toujours faire

Toute migration de schéma DB se fait via **`prisma/ensure_columns.sql`**, qui est :

- **Idempotent** : `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`
- **Non-destructif** : aucun `DROP`, aucun `ALTER COLUMN TYPE` qui perdrait des données
- **Joué automatiquement à chaque boot du container** (idempotent donc safe)

### Ajouter un nouveau champ / une nouvelle table

1. Modifier `schema.prisma` (pour le typage TS)
2. Ajouter le SQL idempotent dans `prisma/ensure_columns.sql`
3. Commit + push → Railway redéploie → la migration s'applique au boot

### Si vous devez forcer un schema push (rare, en local seulement)

```bash
# Local uniquement, sur une DB jetable
npm run DANGER:db:push:WILL-WIPE-DATA
```

Le nom du script est volontairement long et alarmant pour qu'on ne le tape jamais par accident.

## Tables raw-SQL critiques (PAS dans schema.prisma)

Ces tables existent UNIQUEMENT via `ensure_columns.sql`. Elles seraient supprimées par `prisma db push` → données client perdues. À surveiller :

- `CustomerReview` (avis clients, vouchers, brouillons IA)
- `GlobalConfig` (clé Ollama, modèles)
- Toute table créée par migration manuelle dans `prisma/migrations/*.sql`

## Vérification post-deploy

Après chaque déploiement, vérifier qu'aucune table critique n'a perdu de lignes :

```sql
SELECT count(*) FROM "CustomerReview";
SELECT count(*) FROM "Restaurant";
SELECT count(*) FROM "Prospect";
SELECT count(*) FROM "GeneratedDocument";
```

Si le count baisse → quelque chose a fait un drop. Investiguer immédiatement.
