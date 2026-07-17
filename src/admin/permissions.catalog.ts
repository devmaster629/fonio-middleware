import { AdminPermission, AdminRole } from '@prisma/client';

/** UI labels / grouping for the role-permission checkbox matrix. */
export const ADMIN_PERMISSION_CATALOG: Array<{
  key: AdminPermission;
  group: 'pages' | 'actions';
  labelKey: string;
}> = [
  { key: AdminPermission.DASHBOARD_VIEW, group: 'pages', labelKey: 'perm.DASHBOARD_VIEW' },
  { key: AdminPermission.LISTINGS_VIEW, group: 'pages', labelKey: 'perm.LISTINGS_VIEW' },
  { key: AdminPermission.GROUPS_VIEW, group: 'pages', labelKey: 'perm.GROUPS_VIEW' },
  { key: AdminPermission.RESERVATIONS_VIEW, group: 'pages', labelKey: 'perm.RESERVATIONS_VIEW' },
  { key: AdminPermission.CONVERSATIONS_VIEW, group: 'pages', labelKey: 'perm.CONVERSATIONS_VIEW' },
  { key: AdminPermission.RULES_VIEW, group: 'pages', labelKey: 'perm.RULES_VIEW' },
  { key: AdminPermission.REQUESTS_VIEW, group: 'pages', labelKey: 'perm.REQUESTS_VIEW' },
  { key: AdminPermission.PAYMENTS_VIEW, group: 'pages', labelKey: 'perm.PAYMENTS_VIEW' },
  { key: AdminPermission.LOGS_VIEW, group: 'pages', labelKey: 'perm.LOGS_VIEW' },
  { key: AdminPermission.FONIO_ACTIVITY_VIEW, group: 'pages', labelKey: 'perm.FONIO_ACTIVITY_VIEW' },
  { key: AdminPermission.FONIO_SETUP_VIEW, group: 'pages', labelKey: 'perm.FONIO_SETUP_VIEW' },
  { key: AdminPermission.USERS_MANAGE, group: 'pages', labelKey: 'perm.USERS_MANAGE' },
  { key: AdminPermission.LISTINGS_EDIT, group: 'actions', labelKey: 'perm.LISTINGS_EDIT' },
  { key: AdminPermission.RESERVATIONS_VIEW_PII, group: 'actions', labelKey: 'perm.RESERVATIONS_VIEW_PII' },
  { key: AdminPermission.CONVERSATIONS_MANAGE, group: 'actions', labelKey: 'perm.CONVERSATIONS_MANAGE' },
  { key: AdminPermission.RULES_EDIT, group: 'actions', labelKey: 'perm.RULES_EDIT' },
  { key: AdminPermission.RULES_DELETE, group: 'actions', labelKey: 'perm.RULES_DELETE' },
  { key: AdminPermission.REQUESTS_MANAGE, group: 'actions', labelKey: 'perm.REQUESTS_MANAGE' },
  { key: AdminPermission.PAYMENTS_REVIEW, group: 'actions', labelKey: 'perm.PAYMENTS_REVIEW' },
  { key: AdminPermission.PAYMENTS_ADMIN, group: 'actions', labelKey: 'perm.PAYMENTS_ADMIN' },
  { key: AdminPermission.LOG_SETTINGS_EDIT, group: 'actions', labelKey: 'perm.LOG_SETTINGS_EDIT' },
  { key: AdminPermission.SYNC_RUN, group: 'actions', labelKey: 'perm.SYNC_RUN' },
  { key: AdminPermission.SYNC_SETTINGS_EDIT, group: 'actions', labelKey: 'perm.SYNC_SETTINGS_EDIT' },
  { key: AdminPermission.WEBHOOKS_MANAGE, group: 'actions', labelKey: 'perm.WEBHOOKS_MANAGE' },
  { key: AdminPermission.ROLE_PERMISSIONS_MANAGE, group: 'actions', labelKey: 'perm.ROLE_PERMISSIONS_MANAGE' },
];

const ALL_PERMISSIONS = Object.values(AdminPermission);

const VIEWER_DEFAULTS: AdminPermission[] = [
  AdminPermission.DASHBOARD_VIEW,
  AdminPermission.LISTINGS_VIEW,
  AdminPermission.GROUPS_VIEW,
  AdminPermission.RESERVATIONS_VIEW,
  AdminPermission.CONVERSATIONS_VIEW,
  AdminPermission.RULES_VIEW,
  AdminPermission.REQUESTS_VIEW,
  AdminPermission.PAYMENTS_VIEW,
  AdminPermission.LOGS_VIEW,
  AdminPermission.FONIO_ACTIVITY_VIEW,
];

const EDITOR_DEFAULTS: AdminPermission[] = [
  ...VIEWER_DEFAULTS,
  AdminPermission.RESERVATIONS_VIEW_PII,
  AdminPermission.LISTINGS_EDIT,
  AdminPermission.CONVERSATIONS_MANAGE,
  AdminPermission.RULES_EDIT,
  AdminPermission.REQUESTS_MANAGE,
  AdminPermission.PAYMENTS_REVIEW,
  AdminPermission.SYNC_RUN,
  AdminPermission.SYNC_SETTINGS_EDIT,
  AdminPermission.LOG_SETTINGS_EDIT,
];

/** Ops staff: payments + reservations + conversations, no technical settings. */
const BACK_OFFICE_DEFAULTS: AdminPermission[] = [
  AdminPermission.DASHBOARD_VIEW,
  AdminPermission.RESERVATIONS_VIEW,
  AdminPermission.RESERVATIONS_VIEW_PII,
  AdminPermission.CONVERSATIONS_VIEW,
  AdminPermission.CONVERSATIONS_MANAGE,
  AdminPermission.PAYMENTS_VIEW,
  AdminPermission.PAYMENTS_REVIEW,
];

const ADMIN_DEFAULTS: AdminPermission[] = ALL_PERMISSIONS.filter(
  (p) =>
    p !== AdminPermission.USERS_MANAGE &&
    p !== AdminPermission.ROLE_PERMISSIONS_MANAGE,
);

export const DEFAULT_ROLE_PERMISSIONS: Record<AdminRole, AdminPermission[]> = {
  [AdminRole.VIEWER]: VIEWER_DEFAULTS,
  [AdminRole.EDITOR]: EDITOR_DEFAULTS,
  [AdminRole.BACK_OFFICE]: BACK_OFFICE_DEFAULTS,
  [AdminRole.ADMIN]: ADMIN_DEFAULTS,
  [AdminRole.SUPER_ADMIN]: ALL_PERMISSIONS,
};

export function defaultPermissionsForRole(role: AdminRole): AdminPermission[] {
  return [...(DEFAULT_ROLE_PERMISSIONS[role] ?? [])];
}
