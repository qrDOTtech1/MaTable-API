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
