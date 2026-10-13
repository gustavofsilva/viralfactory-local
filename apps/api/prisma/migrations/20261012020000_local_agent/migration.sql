CREATE TABLE "AgentSlot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "slotKey" TEXT NOT NULL,
  "scheduledFor" DATETIME NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PLANNED',
  "videoId" TEXT,
  "lastError" TEXT,
  "postUrl" TEXT,
  "submissionStartedAt" DATETIME,
  "evidencePath" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "AgentSlot_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AgentSlot_slotKey_key" ON "AgentSlot"("slotKey");
CREATE UNIQUE INDEX "AgentSlot_videoId_key" ON "AgentSlot"("videoId");
CREATE INDEX "AgentSlot_status_scheduledFor_idx" ON "AgentSlot"("status", "scheduledFor");
