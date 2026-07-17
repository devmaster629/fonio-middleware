-- CreateEnum
CREATE TYPE "AdminPermission" AS ENUM (
  'DASHBOARD_VIEW',
  'LISTINGS_VIEW',
  'LISTINGS_EDIT',
  'GROUPS_VIEW',
  'RESERVATIONS_VIEW',
  'RESERVATIONS_VIEW_PII',
  'CONVERSATIONS_VIEW',
  'CONVERSATIONS_MANAGE',
  'RULES_VIEW',
  'RULES_EDIT',
  'RULES_DELETE',
  'REQUESTS_VIEW',
  'REQUESTS_MANAGE',
  'PAYMENTS_VIEW',
  'PAYMENTS_REVIEW',
  'PAYMENTS_ADMIN',
  'LOGS_VIEW',
  'LOG_SETTINGS_EDIT',
  'FONIO_ACTIVITY_VIEW',
  'FONIO_SETUP_VIEW',
  'USERS_MANAGE',
  'SYNC_RUN',
  'SYNC_SETTINGS_EDIT',
  'WEBHOOKS_MANAGE',
  'ROLE_PERMISSIONS_MANAGE'
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "permission" "AdminPermission" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RolePermission_role_permission_key" ON "RolePermission"("role", "permission");
CREATE INDEX "RolePermission_role_idx" ON "RolePermission"("role");
