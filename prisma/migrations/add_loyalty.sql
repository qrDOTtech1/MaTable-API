-- Migration : système de fidélisation client
-- Tables LoyaltyCustomer, LoyaltyOffer, LoyaltyTransaction
-- Toutes IF NOT EXISTS — idempotente.

-- ── LoyaltyCustomer ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "LoyaltyCustomer" (
  "id"           TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "firstName"    TEXT,
  "lastName"     TEXT,
  "email"        TEXT,
  "phone"        TEXT,
  "points"       INTEGER NOT NULL DEFAULT 0,
  "tier"         TEXT NOT NULL DEFAULT 'bronze',
  "totalSpent"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "visitCount"   INTEGER NOT NULL DEFAULT 0,
  "birthDate"    TIMESTAMP(3),
  "notes"        TEXT,
  "source"       TEXT NOT NULL DEFAULT 'manual',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoyaltyCustomer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LoyaltyCustomer_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "LoyaltyCustomer_restaurantId_email_key"
  ON "LoyaltyCustomer"("restaurantId", "email") WHERE "email" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "LoyaltyCustomer_restaurantId_idx"
  ON "LoyaltyCustomer"("restaurantId");

-- ── LoyaltyOffer ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "LoyaltyOffer" (
  "id"           TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "type"         TEXT NOT NULL DEFAULT 'discount_pct',
  "value"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  "pointsCost"   INTEGER NOT NULL DEFAULT 100,
  "minTier"      TEXT,
  "active"       BOOLEAN NOT NULL DEFAULT true,
  "expiresAt"    TIMESTAMP(3),
  "usageLimit"   INTEGER,
  "usageCount"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoyaltyOffer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LoyaltyOffer_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "LoyaltyOffer_restaurantId_idx"
  ON "LoyaltyOffer"("restaurantId");

-- ── LoyaltyTransaction ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "LoyaltyTransaction" (
  "id"          TEXT NOT NULL,
  "customerId"  TEXT NOT NULL,
  "offerId"     TEXT,
  "type"        TEXT NOT NULL,   -- 'earn' | 'redeem' | 'adjust' | 'expire'
  "points"      INTEGER NOT NULL, -- positif = gain, négatif = utilisation
  "description" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoyaltyTransaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LoyaltyTransaction_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "LoyaltyCustomer"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "LoyaltyTransaction_customerId_idx"
  ON "LoyaltyTransaction"("customerId");
