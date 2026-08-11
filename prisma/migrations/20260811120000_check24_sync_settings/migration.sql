-- CreateTable
CREATE TABLE "Check24SyncSettings" (
    "id" TEXT NOT NULL,
    "autoSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoSyncContent" BOOLEAN NOT NULL DEFAULT false,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 30,
    "lastAutoSyncAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Check24SyncSettings_pkey" PRIMARY KEY ("id")
);
