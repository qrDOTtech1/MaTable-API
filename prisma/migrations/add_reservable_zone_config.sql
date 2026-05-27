-- Migration : tables réservables + quotas walk-in par zone
-- À exécuter sur Railway via : Settings > Database > Query

-- 1. Champ reservable sur Table (true par défaut — toutes les tables existantes restent réservables)
ALTER TABLE "Table" ADD COLUMN IF NOT EXISTS "reservable" BOOLEAN NOT NULL DEFAULT true;

-- 2. Nouveau modèle ZoneConfig
CREATE TABLE IF NOT EXISTS "ZoneConfig" (
  "id"            TEXT NOT NULL,
  "restaurantId"  TEXT NOT NULL,
  "zone"          TEXT NOT NULL,
  "minFreeWalkIn" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ZoneConfig_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ZoneConfig_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE,
  CONSTRAINT "ZoneConfig_restaurantId_zone_key" UNIQUE ("restaurantId", "zone")
);

CREATE INDEX IF NOT EXISTS "ZoneConfig_restaurantId_idx" ON "ZoneConfig"("restaurantId");
