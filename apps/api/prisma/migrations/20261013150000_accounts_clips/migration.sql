CREATE TABLE "TikTokAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "handle" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "TikTokAccount_handle_key" ON "TikTokAccount"("handle");

CREATE TABLE "Clip" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "caption" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourcePath" TEXT,
    "sourceBytes" INTEGER NOT NULL,
    "uploadOffset" INTEGER NOT NULL DEFAULT 0,
    "durationSeconds" REAL,
    "transcriptJson" TEXT,
    "segmentsJson" TEXT,
    "outputPath" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UPLOADING',
    "lastError" TEXT,
    "postUrl" TEXT,
    "submissionStartedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Clip_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TikTokAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "Clip_accountId_createdAt_idx" ON "Clip"("accountId", "createdAt");
