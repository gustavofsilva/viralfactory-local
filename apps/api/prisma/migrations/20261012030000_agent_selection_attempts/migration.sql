ALTER TABLE "AgentSlot" ADD COLUMN "selectionAttempts" INTEGER NOT NULL DEFAULT 0;
UPDATE "AgentSlot" SET "selectionAttempts" = 1 WHERE "videoId" IS NOT NULL;
