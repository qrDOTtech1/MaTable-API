-- Idempotent column migrations — run at every startup
-- Adds missing columns without dropping anything

-- Table: zone + assignedServerId
ALTER TABLE "Table" ADD COLUMN IF NOT EXISTS zone TEXT;
ALTER TABLE "Table" ADD COLUMN IF NOT EXISTS "assignedServerId" TEXT;

-- Restaurant: all potentially missing columns
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "coverImageId" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "logoId" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "caissePin" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "cuisinePin" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "tipsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "serviceCallEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "reviewsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "acceptReservations" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "depositPerGuestCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "avgPrepMinutes" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "reservationLeadMinutes" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "reservationSlotMinutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "reservationPolicy" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS subscription TEXT NOT NULL DEFAULT 'STARTER';
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "ollamaApiKey" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "ollamaLangModel" TEXT DEFAULT 'gpt-4o-mini';
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "ollamaVisionModel" TEXT DEFAULT 'gpt-4o';
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "subscriptionStartedAt" TIMESTAMP(3);
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "subscriptionExpiresAt" TIMESTAMP(3);
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "postalCode" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'FR';
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "isPartner" BOOLEAN NOT NULL DEFAULT true;

-- User: shadow columns owned by RSMATABLE
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "name" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "image" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "password" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerified" TIMESTAMP(3);

-- TableSession: customer email for invoice + tip tracking
ALTER TABLE "TableSession" ADD COLUMN IF NOT EXISTS "customerEmail" TEXT;
ALTER TABLE "TableSession" ADD COLUMN IF NOT EXISTS "tipCents" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "TableSession_customerEmail_idx" ON "TableSession"("customerEmail");

-- TableSession: bill confirmation by server
ALTER TABLE "TableSession" ADD COLUMN IF NOT EXISTS "billConfirmedAt" TIMESTAMP(3);
ALTER TABLE "TableSession" ADD COLUMN IF NOT EXISTS "billConfirmedBy" TEXT;

-- MenuItem: wait time in minutes (0 = instant)
ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "waitMinutes" INTEGER NOT NULL DEFAULT 0;

-- Order: expected ready time (computed at order creation)
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "expectedReadyAt" TIMESTAMP(3);

-- TableSession: split payment (JSON array of split parts)
ALTER TABLE "TableSession" ADD COLUMN IF NOT EXISTS "billSplits" JSONB NOT NULL DEFAULT '[]'::jsonb;

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

-- Prospect table (CRM de prospection)
CREATE TABLE IF NOT EXISTS "Prospect" (
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  city TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  description TEXT,
  website TEXT,
  category TEXT,
  "imageUrl" TEXT,
  "sourceUrl" TEXT,
  status TEXT NOT NULL DEFAULT 'NEW',
  "restaurantId" TEXT,
  notes TEXT,
  "activatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Prospect_pkey" PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS "Prospect_status_idx" ON "Prospect"(status);
CREATE INDEX IF NOT EXISTS "Prospect_city_idx" ON "Prospect"(city);

-- Table: indexes for zone
CREATE INDEX IF NOT EXISTS "Table_restaurantId_zone_idx" ON "Table"("restaurantId", zone);

-- Table: foreign key for assignedServerId
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Table_assignedServerId_fkey') THEN
    ALTER TABLE "Table" ADD CONSTRAINT "Table_assignedServerId_fkey"
      FOREIGN KEY ("assignedServerId") REFERENCES "Server"(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Global platform config (single row, id = 'global')
CREATE TABLE IF NOT EXISTS "GlobalConfig" (
  id TEXT NOT NULL DEFAULT 'global',
  "iaApiKey" TEXT,
  "iaLangModel" TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  "iaVisionModel" TEXT NOT NULL DEFAULT 'gpt-4o',
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GlobalConfig_pkey" PRIMARY KEY (id)
);
-- Ensure the single row always exists
INSERT INTO "GlobalConfig" (id) VALUES ('global') ON CONFLICT DO NOTHING;
