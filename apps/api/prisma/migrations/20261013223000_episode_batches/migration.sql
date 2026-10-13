CREATE TABLE "EpisodeBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "sourceRoot" TEXT NOT NULL,
    "intervalMinutes" INTEGER NOT NULL,
    "nextPublishAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rightsConfirmedAt" DATETIME NOT NULL,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EpisodeBatch_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TikTokAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "EpisodeBatch_enabled_nextPublishAt_idx" ON "EpisodeBatch"("enabled", "nextPublishAt");
CREATE UNIQUE INDEX "EpisodeBatch_accountId_sourceRoot_key" ON "EpisodeBatch"("accountId", "sourceRoot");
ALTER TABLE "Clip" ADD COLUMN "batchId" TEXT REFERENCES "EpisodeBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Clip" ADD COLUMN "sourceModifiedAt" DATETIME;
CREATE UNIQUE INDEX "Clip_batchId_sourcePath_key" ON "Clip"("batchId", "sourcePath");
