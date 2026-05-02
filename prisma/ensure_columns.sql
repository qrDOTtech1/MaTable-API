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
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "stripeSecretKey" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "stripeWebhookSecret" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "stripePublicKey" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "ollamaApiKey" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "ollamaLangModel" TEXT DEFAULT 'gpt-oss:120b';
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "ollamaVisionModel" TEXT DEFAULT 'qwen3-vl:235b';
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "googleReviewLink" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "reviewVoucherConfig" JSONB;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "subscriptionStartedAt" TIMESTAMP(3);
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "subscriptionExpiresAt" TIMESTAMP(3);

-- enabledApps: modular app system — JSON array of app IDs
-- Default: ["reviews"] (base app, always included for new restaurants)
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "enabledApps" JSONB NOT NULL DEFAULT '["reviews"]'::jsonb;

-- Migrate existing PRO_IA restaurants: give them all apps
UPDATE "Restaurant"
SET "enabledApps" = '["reviews","reservations","orders","nova_ia","nova_stock","nova_contab","nova_finance"]'::jsonb
WHERE subscription = 'PRO_IA' AND "enabledApps" = '["reviews"]'::jsonb;

-- Migrate existing PRO restaurants: reviews + reservations + orders
UPDATE "Restaurant"
SET "enabledApps" = '["reviews","reservations","orders"]'::jsonb
WHERE subscription = 'PRO' AND "enabledApps" = '["reviews"]'::jsonb;

-- Migrate STARTER restaurants that had features enabled
UPDATE "Restaurant"
SET "enabledApps" = jsonb_build_array('reviews') ||
  CASE WHEN "acceptReservations" = true THEN '["reservations"]'::jsonb ELSE '[]'::jsonb END ||
  CASE WHEN "serviceCallEnabled" = true THEN '["orders"]'::jsonb ELSE '[]'::jsonb END
WHERE subscription = 'STARTER' AND "enabledApps" = '["reviews"]'::jsonb
  AND ("acceptReservations" = true OR "serviceCallEnabled" = true);
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "postalCode" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'FR';
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "contactEmail" TEXT;
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

-- MenuItem: Smart up-selling & pairings (JSON arrays of MenuItem IDs or strings)
ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "suggestedPairings" JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "upsellItems" JSONB NOT NULL DEFAULT '[]'::jsonb;

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

-- GlobalConfig: single-row table for platform-wide Ollama Cloud settings
-- IMPORTANT: this table is NOT in schema.prisma to prevent prisma db push from dropping it
CREATE TABLE IF NOT EXISTS "GlobalConfig" (
  id TEXT NOT NULL DEFAULT 'global',
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GlobalConfig_pkey" PRIMARY KEY (id)
);
-- Add columns if table existed without them (idempotent)
ALTER TABLE "GlobalConfig" ADD COLUMN IF NOT EXISTS "ollamaApiKey" TEXT;
ALTER TABLE "GlobalConfig" ADD COLUMN IF NOT EXISTS "ollamaLangModel" TEXT NOT NULL DEFAULT 'gpt-oss:120b';
ALTER TABLE "GlobalConfig" ADD COLUMN IF NOT EXISTS "ollamaVisionModel" TEXT NOT NULL DEFAULT 'qwen3-vl:235b';

-- Ensure exactly one global config row exists (NEVER overwrite existing data)
INSERT INTO "GlobalConfig" (id) VALUES ('global') ON CONFLICT (id) DO NOTHING;

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

-- SupportTicket: SAV messages from restaurants to admin
CREATE TABLE IF NOT EXISTS "SupportTicket" (
  id TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "userId" TEXT,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  "adminReply" TEXT,
  "repliedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportTicket_pkey" PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS "SupportTicket_restaurantId_idx" ON "SupportTicket"("restaurantId");
CREATE INDEX IF NOT EXISTS "SupportTicket_status_idx" ON "SupportTicket"(status);

-- (duplicate GlobalConfig removed — defined above)

-- SocialProfile: ensure name column exists (required by Prisma but may be missing on existing rows)
ALTER TABLE "SocialProfile" ADD COLUMN IF NOT EXISTS "name" TEXT NOT NULL DEFAULT 'Anonyme';

-- TableSession: link to social profile
ALTER TABLE "TableSession" ADD COLUMN IF NOT EXISTS "socialProfileId" TEXT;
CREATE INDEX IF NOT EXISTS "TableSession_socialProfileId_idx" ON "TableSession"("socialProfileId");

-- AiHistory: historique persistant des réponses IA par restaurant
CREATE TABLE IF NOT EXISTS "AiHistory" (
  id TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  "outputData" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiHistory_pkey" PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS "AiHistory_restaurantId_type_idx" ON "AiHistory"("restaurantId", type, "createdAt" DESC);

-- StockProduct: matières premières et ingrédients bruts (séparé de MenuItem)
CREATE TABLE IF NOT EXISTS "StockProduct" (
  id TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'kg',
  category TEXT NOT NULL DEFAULT 'Autre',
  "isFresh" BOOLEAN NOT NULL DEFAULT false,
  "currentQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "lowThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "weeklyEstimate" DOUBLE PRECISION NOT NULL DEFAULT 0,
  notes TEXT,
  "linkedDishes" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockProduct_pkey" PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS "StockProduct_restaurantId_idx" ON "StockProduct"("restaurantId", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "StockProduct_restaurantId_category_idx" ON "StockProduct"("restaurantId", category);

-- ActiveOffer: offres déployées depuis Nova Finance IA
CREATE TABLE IF NOT EXISTS "ActiveOffer" (
  id TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  dish TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'PROMO',
  description TEXT NOT NULL,
  "discountPercent" INTEGER NOT NULL DEFAULT 0,
  rationale TEXT,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActiveOffer_pkey" PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS "ActiveOffer_restaurantId_idx" ON "ActiveOffer"("restaurantId", "endsAt");

-- ShoppingHistory: historique des listes de courses generees par Nova Stock IA
CREATE TABLE IF NOT EXISTS "ShoppingHistory" (
  id TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  title TEXT NOT NULL,
  "itemCount" INTEGER NOT NULL DEFAULT 0,
  "estimatedBudget" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "realCost" DOUBLE PRECISION,
  "shoppingList" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "completedAt" TIMESTAMP(3),
  notes TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShoppingHistory_pkey" PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS "ShoppingHistory_restaurantId_idx" ON "ShoppingHistory"("restaurantId", "createdAt" DESC);

-- CustomerReview: generated reviews by customers via AI
CREATE TABLE IF NOT EXISTS "CustomerReview" (
  id TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "serverName" TEXT,
  "ratings" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "reviewText" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerReview_pkey" PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS "CustomerReview_restaurantId_idx" ON "CustomerReview"("restaurantId", "createdAt" DESC);

-- Add contact columns (email / phone) for voucher claim
ALTER TABLE "CustomerReview" ADD COLUMN IF NOT EXISTS "contactEmail" TEXT;
ALTER TABLE "CustomerReview" ADD COLUMN IF NOT EXISTS "contactPhone" TEXT;
ALTER TABLE "CustomerReview" ADD COLUMN IF NOT EXISTS "voucherClaimed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CustomerReview" ADD COLUMN IF NOT EXISTS "voucherCode" TEXT;

-- ServerTip: tips left by customers via review flow
CREATE TABLE IF NOT EXISTS "ServerTip" (
  id TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "serverId" TEXT,
  "serverName" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "stripeSessionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServerTip_pkey" PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS "ServerTip_restaurantId_idx" ON "ServerTip"("restaurantId", "createdAt" DESC);
