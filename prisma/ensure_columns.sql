-- Idempotent column migrations — run at every startup
-- Adds missing columns without dropping anything

-- Table: zone + assignedServerId
ALTER TABLE "Table" ADD COLUMN IF NOT EXISTS zone TEXT;
ALTER TABLE "Table" ADD COLUMN IF NOT EXISTS "assignedServerId" TEXT;

-- Restaurant: coverImageId, logoId (in case previous push failed)
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "coverImageId" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "logoId" TEXT;

-- User: shadow columns owned by RSMATABLE
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "name" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "image" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "password" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerified" TIMESTAMP(3);

-- ServerChallenge: global AI challenges
ALTER TABLE "ServerChallenge" ADD COLUMN IF NOT EXISTS "isGlobal" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ServerChallenge" ADD COLUMN IF NOT EXISTS "restaurantId" TEXT;

-- Photo gallery table
CREATE TABLE IF NOT EXISTS "Photo" (
  id TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "menuItemId" TEXT,
  kind TEXT NOT NULL DEFAULT 'RESTAURANT',
  "mimeType" TEXT NOT NULL,
  bytes BYTEA NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  "originalName" TEXT,
  sha256 TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Photo_pkey" PRIMARY KEY (id)
);

-- Photo: foreign keys
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Photo_restaurantId_fkey') THEN
    ALTER TABLE "Photo" ADD CONSTRAINT "Photo_restaurantId_fkey"
      FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Photo_menuItemId_fkey') THEN
    ALTER TABLE "Photo" ADD CONSTRAINT "Photo_menuItemId_fkey"
      FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Photo: indexes
CREATE INDEX IF NOT EXISTS "Photo_restaurantId_kind_idx" ON "Photo"("restaurantId", kind);
CREATE INDEX IF NOT EXISTS "Photo_menuItemId_idx" ON "Photo"("menuItemId");

-- Table: indexes for zone
CREATE INDEX IF NOT EXISTS "Table_restaurantId_zone_idx" ON "Table"("restaurantId", zone);

-- Table: foreign key for assignedServerId
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Table_assignedServerId_fkey') THEN
    ALTER TABLE "Table" ADD CONSTRAINT "Table_assignedServerId_fkey"
      FOREIGN KEY ("assignedServerId") REFERENCES "Server"(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
