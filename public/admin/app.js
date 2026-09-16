const API = '/api/v1/admin';
const AUTH = '/api/v1/admin/auth';

let token = localStorage.getItem('adminToken') || '';
let adminRole = localStorage.getItem('adminRole') || '';
let adminPermissions = [];
try {
  adminPermissions = JSON.parse(localStorage.getItem('adminPermissions') || '[]');
} catch {
  adminPermissions = [];
}
let activeTab = 'dashboard';
let paymentsView = 'reconcile';
let cachedRules = [];
let cachedListings = [];
let cachedConditionSchema = null;
let editingRuleId = null;
let editingUserId = null;
let editingListingAliases = null;
let dashboardPoll = null;
let paymentsStatusPoll = null;
let syncSettingsDirty = false;
let cachedWebhookJobs = [];
const webhookFilters = { range: '24h', event: 'all', result: 'all' };
const SYNC_INTERVAL_OPTIONS = [5, 15, 30, 60, 120, 360, 720, 1440];
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const DEFAULT_PAGE_SIZE = 10;
const tableState = {
  listings: { page: 1, pageSize: DEFAULT_PAGE_SIZE, search: '', sortBy: 'name', sortDir: 'asc', city: '', groupId: '', status: '', bookable: '' },
  groups: { page: 1, pageSize: DEFAULT_PAGE_SIZE, search: '', sortBy: 'name', sortDir: 'asc', city: '', mode: '', chip: 'all' },
  reservations: {
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    search: '',
    sortBy: 'arrivalDate',
    sortDir: 'desc',
    status: 'all',
    paymentStatus: 'all',
    channel: 'all',
    groupId: 'all',
    dateFrom: '',
    dateTo: '',
    cancelledRecordedToday: false,
  },
  conversations: {
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    search: '',
    sortBy: 'updatedAt',
    sortDir: 'desc',
    status: 'all',
    channel: 'all',
  },
  rules: { page: 1, pageSize: DEFAULT_PAGE_SIZE, search: '', sortBy: 'priority', sortDir: 'desc', mode: 'all', status: 'all' },
  requests: {
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    search: '',
    sortBy: 'createdAt',
    sortDir: 'desc',
    tab: 'all',
    type: 'all',
    listingId: 'all',
    delivery: 'all',
    dateFrom: '',
    dateTo: '',
  },
  payments: { page: 1, pageSize: DEFAULT_PAGE_SIZE, search: '', sortBy: '', sortDir: 'asc', source: 'all', match: 'all', date: 'all' },
  paymentsHistory: { page: 1, pageSize: DEFAULT_PAGE_SIZE, search: '', sortBy: 'createdAt', sortDir: 'desc', source: 'all', status: 'all' },
  logs: {
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    search: '',
    sortBy: 'createdAt',
    sortDir: 'desc',
    source: 'all',
    action: 'all',
    status: 'all',
    retention: 'all',
    method: 'all',
    dateFrom: '',
    dateTo: '',
  },
  webhooks: { page: 1, pageSize: DEFAULT_PAGE_SIZE, search: '' },
  users: { page: 1, pageSize: DEFAULT_PAGE_SIZE, search: '', sortBy: 'createdAt', sortDir: 'desc', role: 'all', status: 'all' },
  usersSecurity: { page: 1, pageSize: DEFAULT_PAGE_SIZE },
  fonioActivity: {
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    search: '',
    sortBy: 'createdAt',
    sortDir: 'desc',
    actionFilter: '',
    statusFilter: '',
    outcomeFilter: '',
    dateFrom: '',
    dateTo: '',
  },
};
let listingsFacets = { cities: [], groups: [] };
let groupsFacets = { cities: [], modes: [] };
let groupsStats = { groups: 0, groupedListings: 0, cities: 0 };
let groupsLastSync = null;
const expandedGroupIds = new Set();
const searchTimers = {};
let fonioActivityCache = [];
let fonioActivitySelectedId = null;
let fonioActivityLastFetchedAt = null;
let fonioActivityPoll = null;
let fonioActivityUiBound = false;
let fonioActivityChartDays = 7;
let logsCache = [];
let logsRetentionStatus = null;
let logsUiBound = false;
let logsActiveView = 'entries';
let logsDrawerLog = null;
let logsDrawerTab = 'details';
let logsDrawerFull = false;
let logsFacets = { sources: [], actions: [] };
let logsRetentionSamplesExpanded = false;
let logsPageResult = {
  items: [],
  total: 0,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  totalPages: 1,
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDateTime(value) {
  if (!value) return '–';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDashboardDateTime(value) {
  if (!value) return '–';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  try {
    return d.toLocaleString(typeof locale === 'function' ? locale() : 'en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return formatDateTime(value);
  }
}

function formatCount(n) {
  const num = Number(n) || 0;
  try {
    return num.toLocaleString(typeof locale === 'function' ? locale() : 'en-GB');
  } catch {
    return String(num);
  }
}

function formatDate(value) {
  if (!value) return '–';
  const raw = String(value).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw.replace(/-/g, '/');
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const MOBILE_NAV_BREAKPOINT = 1024;

function isMobileNav() {
  return window.matchMedia(`(max-width: ${MOBILE_NAV_BREAKPOINT - 1}px)`).matches;
}

function setSidebarOpen(open) {
  const backdrop = $('#sidebar-backdrop');
  const toggle = $('#sidebar-toggle');
  document.body.classList.toggle('sidebar-open', open);
  if (backdrop) {
    backdrop.hidden = !open;
    backdrop.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
  if (toggle) {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', t(open ? 'nav.closeMenu' : 'nav.openMenu'));
  }
  resetMobileScrollX();
}

function resetMobileScrollX() {
  if (!isMobileNav()) return;
  if (window.scrollX) window.scrollTo(0, window.scrollY || 0);
  document.documentElement.scrollLeft = 0;
  document.body.scrollLeft = 0;
}

function closeSidebar() {
  if (isMobileNav()) setSidebarOpen(false);
}

function updateMobileBottomNav(tab) {
  const primary = new Set(['dashboard', 'reservations', 'requests', 'payments']);
  $$('#mobile-bottom-nav [data-mobile-nav]').forEach((btn) => {
    const key = btn.dataset.mobileNav;
    if (key === 'more') {
      btn.classList.toggle('is-active', !primary.has(tab));
      return;
    }
    btn.classList.toggle('is-active', key === tab);
  });
  syncCheck24MobileChrome();
  syncPaymentsMobileChrome();
}

function initMobileBottomNav() {
  const nav = $('#mobile-bottom-nav');
  if (!nav || nav.dataset.bound === '1') return;
  nav.dataset.bound = '1';
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mobile-nav]');
    if (!btn) return;
    const key = btn.dataset.mobileNav;
    if (key === 'more') {
      if (!isMobileNav()) return;
      const open = !document.body.classList.contains('sidebar-open');
      setSidebarOpen(open);
      return;
    }
    activateTab(key);
  });
}

function updateMobilePageTitle(tab) {
  const titleEl = $('#mobile-page-title');
  const btn = $(`.nav-btn[data-tab="${tab}"]`);
  if (!titleEl || !btn) return;
  const key = btn.querySelector('.nav-label[data-i18n]')?.dataset.i18n || btn.dataset.i18n;
  titleEl.textContent = key ? t(key) : btn.textContent.trim();
}

function enhanceResponsiveTables(root = document) {
  root.querySelectorAll('.table-wrap table:not(.no-responsive-stack), #payments-table table').forEach((table) => {
    const headers = [...table.querySelectorAll('thead th')].map((th) => {
      const raw = th.getAttribute('data-label') || th.textContent || '';
      return raw.replace(/\s*[▲▼]\s*/g, '').trim();
    });
    if (!headers.length) return;
    table.classList.add('responsive-stack');
    table.querySelectorAll('tbody tr').forEach((tr) => {
      if (tr.children.length === 1 && tr.children[0].hasAttribute('colspan')) return;
      [...tr.children].forEach((cell, index) => {
        if (cell.tagName !== 'TD') return;
        const label = headers[index] || '';
        if (label) {
          cell.setAttribute('data-label', label);
          cell.classList.remove('mobile-actions');
        } else {
          cell.removeAttribute('data-label');
          cell.classList.add('mobile-actions');
        }
      });
    });
  });
}

let enhanceTablesScheduled = false;
function scheduleEnhanceResponsiveTables() {
  if (enhanceTablesScheduled) return;
  enhanceTablesScheduled = true;
  requestAnimationFrame(() => {
    enhanceTablesScheduled = false;
    enhanceResponsiveTables();
  });
}

function initMobileNav() {
  $('#sidebar-toggle')?.addEventListener('click', () => {
    if (!isMobileNav()) return;
    setSidebarOpen(!document.body.classList.contains('sidebar-open'));
  });
  $('#sidebar-backdrop')?.addEventListener('click', () => closeSidebar());
  window.addEventListener('resize', () => {
    if (!isMobileNav()) setSidebarOpen(false);
    resetMobileScrollX();
  });
  window.addEventListener('orientationchange', () => {
    requestAnimationFrame(resetMobileScrollX);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSidebar();
  });
  resetMobileScrollX();
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...options, headers });
  if (res.status === 401) {
    logout();
    throw new Error(t('session.expired'));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = Array.isArray(data.message) ? data.message.join(', ') : (data.message || `HTTP ${res.status}`);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

function logout() {
  token = '';
  adminRole = '';
  adminPermissions = [];
  localStorage.removeItem('adminToken');
  localStorage.removeItem('adminRole');
  localStorage.removeItem('adminPermissions');
  $('#app-screen').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
}

function hasPermission(key) {
  if (adminRole === 'SUPER_ADMIN') return true;
  return Array.isArray(adminPermissions) && adminPermissions.includes(key);
}

function canEdit() {
  return (
    hasPermission('LISTINGS_EDIT') ||
    hasPermission('RULES_EDIT') ||
    hasPermission('PAYMENTS_REVIEW') ||
    hasPermission('SYNC_SETTINGS_EDIT') ||
    hasPermission('REQUESTS_MANAGE')
  );
}

function canAdmin() {
  return (
    hasPermission('RULES_DELETE') ||
    hasPermission('WEBHOOKS_MANAGE') ||
    hasPermission('PAYMENTS_ADMIN')
  );
}

function canSuperAdmin() {
  return adminRole === 'SUPER_ADMIN' || hasPermission('USERS_MANAGE');
}

function setControlsDisabled(root, disabled, { exceptIds = [] } = {}) {
  if (!root) return;
  root.querySelectorAll('input, select, textarea, button').forEach((el) => {
    if (exceptIds.includes(el.id)) return;
    el.toggleAttribute('disabled', disabled);
  });
  root.classList.toggle('is-readonly', disabled);
}

function formatRoleLabel(role) {
  return t(`role.${role}`) || role;
}

const NAV_PERMISSIONS = {
  dashboard: 'DASHBOARD_VIEW',
  listings: 'LISTINGS_VIEW',
  groups: 'GROUPS_VIEW',
  reservations: 'RESERVATIONS_VIEW',
  conversations: 'CONVERSATIONS_VIEW',
  rules: 'RULES_VIEW',
  requests: 'REQUESTS_VIEW',
  payments: 'PAYMENTS_VIEW',
  logs: 'LOGS_VIEW',
  fonioActivity: 'FONIO_ACTIVITY_VIEW',
  fonio: 'FONIO_SETUP_VIEW',
  check24: 'DASHBOARD_VIEW',
  users: 'USERS_MANAGE',
};

function applyRoleUi() {
  const canSyncRun = hasPermission('SYNC_RUN');
  const canSyncSettings = hasPermission('SYNC_SETTINGS_EDIT');
  const canLogSettings = hasPermission('LOG_SETTINGS_EDIT');
  const canRulesEdit = hasPermission('RULES_EDIT');
  const canRulesDelete = hasPermission('RULES_DELETE');
  const canConversationsManage = hasPermission('CONVERSATIONS_MANAGE');
  const canPaymentsReview = hasPermission('PAYMENTS_REVIEW');
  const canPaymentsAdmin = hasPermission('PAYMENTS_ADMIN');
  const canListingsEdit = hasPermission('LISTINGS_EDIT');
  const canRequestsManage = hasPermission('REQUESTS_MANAGE');
  const canWebhooks = hasPermission('WEBHOOKS_MANAGE');

  const syncBtn = $('#sync-btn');
  const syncBtnCard = $('#sync-btn-card');
  [syncBtn, syncBtnCard].forEach((btn) => {
    btn?.toggleAttribute('disabled', !canSyncRun);
    if (btn) btn.title = canSyncRun ? '' : t('dashboard.syncReadonly');
  });
  $('#check24-sync-btn')?.toggleAttribute('disabled', !canSyncRun);
  $('#check24-poll-btn')?.toggleAttribute('disabled', !canSyncRun);
  $('#check24-webhook-btn')?.toggleAttribute('disabled', !canWebhooks);
  setControlsDisabled($('#sync-settings-form'), !canSyncSettings);
  $('#sync-settings-readonly-hint')?.classList.toggle('hidden', canSyncSettings);
  setControlsDisabled($('#check24-sync-settings-form'), !canSyncSettings);
  $('#check24-sync-settings-readonly-hint')?.classList.toggle(
    'hidden',
    canSyncSettings,
  );

  setControlsDisabled($('#log-settings-form'), !canLogSettings, {
    exceptIds: ['log-debug-toggle', 'log-operational-toggle', 'log-pii-toggle', 'log-cleanup-toggle'],
  });
  $('#log-purge-now-btn')?.toggleAttribute('disabled', !canLogSettings);
  $('#log-settings-readonly-hint')?.classList.toggle('hidden', canLogSettings);

  setControlsDisabled($('#rule-form'), !canRulesEdit, {
    exceptIds: canRulesDelete && editingRuleId ? ['rule-delete-btn'] : [],
  });
  $('#rule-delete-btn')?.classList.toggle('hidden', !canRulesDelete || !editingRuleId);
  $('#rule-new-btn')?.classList.toggle('hidden', !editingRuleId || !canRulesEdit);
  $('#rule-delete-btn-mobile')?.classList.toggle('hidden', !canRulesDelete || !editingRuleId);
  $('#rule-new-btn-mobile')?.classList.toggle('hidden', !editingRuleId || !canRulesEdit);
  $('#rule-submit-btn-mobile')?.toggleAttribute('disabled', !canRulesEdit);
  $('#rules-mobile-create-btn')?.classList.toggle('hidden', !canRulesEdit);

  const verificationForm = $('#verification-form');
  if (verificationForm) {
    verificationForm.querySelectorAll('input, button, select').forEach((el) => {
      if (el.name === 'verification-field' && el.value === 'stayDates') {
        el.toggleAttribute('disabled', true);
        return;
      }
      el.toggleAttribute('disabled', !canRulesEdit);
    });
    verificationForm.classList.toggle('is-readonly', !canRulesEdit);
  }
  $('#verification-save-btn')?.toggleAttribute('disabled', !canRulesEdit);
  $('#verification-save-btn-mobile')?.toggleAttribute('disabled', !canRulesEdit);
  $('#verification-min-minus')?.toggleAttribute('disabled', !canRulesEdit);
  $('#verification-min-plus')?.toggleAttribute('disabled', !canRulesEdit);
  $('#verification-readonly-hint')?.classList.toggle('hidden', canRulesEdit);

  $('#inbox-backfill-btn')?.toggleAttribute('disabled', !canConversationsManage);
  $('#inbox-backfill-btn')?.classList.toggle('hidden', !canConversationsManage);
  $('#inbox-backfill-btn-mobile')?.toggleAttribute('disabled', !canConversationsManage);
  $('#inbox-backfill-btn-mobile')?.classList.toggle('hidden', !canConversationsManage);
  $('.requests-mobile-backfill-wrap')?.classList.toggle('hidden', !canConversationsManage);

  $$('.listing-aliases-edit').forEach((btn) => {
    btn.classList.toggle('hidden', !canListingsEdit);
  });
  $$('.payment-confirm-btn, .payment-skip-btn, .payment-assign-select, .payment-assign-manual, .payment-retry-btn').forEach((el) => {
    el.toggleAttribute('disabled', !canPaymentsReview);
    if (el.matches('button')) el.classList.toggle('hidden', !canPaymentsReview);
  });
  setControlsDisabled($('#portal-rules-list'), !canPaymentsAdmin);
  $('#portal-rules-readonly-hint')?.classList.toggle('hidden', canPaymentsAdmin);
  setControlsDisabled($('#payment-plan-editor'), !canPaymentsAdmin);
  $('#payment-plans-readonly-hint')?.classList.toggle('hidden', canPaymentsAdmin);
  $$('.retry-forward-btn').forEach((btn) => {
    btn.classList.toggle('hidden', !canRequestsManage);
    btn.toggleAttribute('disabled', !canRequestsManage);
  });
  $$('[data-refresh-conv]').forEach((btn) => {
    btn.classList.toggle('hidden', !canConversationsManage);
    btn.toggleAttribute('disabled', !canConversationsManage);
  });

  updateAdminSession();

  $$('.nav-btn').forEach((btn) => {
    const tab = btn.dataset.tab;
    const perm = NAV_PERMISSIONS[tab];
    const allowed = !perm || hasPermission(perm);
    btn.classList.toggle('hidden', !allowed);
  });

  $$('#mobile-bottom-nav [data-mobile-nav]').forEach((btn) => {
    const key = btn.dataset.mobileNav;
    if (key === 'more') return;
    const perm = NAV_PERMISSIONS[key];
    const allowed = !perm || hasPermission(perm);
    btn.classList.toggle('hidden', !allowed);
  });

  $$('.nav-section').forEach((section) => {
    const anyVisible = [...section.querySelectorAll('.nav-btn')].some(
      (b) => !b.classList.contains('hidden'),
    );
    section.classList.toggle('hidden', !anyVisible);
  });

  if (!hasPermission(NAV_PERMISSIONS[activeTab] || 'DASHBOARD_VIEW')) {
    const first = [...$$('.nav-btn')].find((b) => !b.classList.contains('hidden'));
    activeTab = first?.dataset.tab || 'dashboard';
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
    $$('.tab').forEach((tab) => tab.classList.add('hidden'));
    $(`#tab-${activeTab}`)?.classList.remove('hidden');
  }
  updateMobileBottomNav(activeTab);
  scheduleEnhanceResponsiveTables();
}

function updateAdminSession() {
  const el = $('#admin-session');
  if (!el || !token) return;
  const roleLabel = formatRoleLabel(adminRole || t('session.roleUnknown'));
  el.textContent = t('session.loggedInAs', { role: roleLabel });
}

async function restoreSession() {
  if (!token) return false;
  try {
    const res = await fetch(`${AUTH}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      logout();
      return false;
    }
    const data = await res.json();
    adminRole = data.role || '';
    adminPermissions = Array.isArray(data.permissions) ? data.permissions : [];
    localStorage.setItem('adminRole', adminRole);
    localStorage.setItem('adminPermissions', JSON.stringify(adminPermissions));
    return true;
  } catch {
    logout();
    return false;
  }
}

function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  applyRoleUi();
  applyTabFromUrl();
  updateMobilePageTitle(activeTab);
  updateMobileBottomNav(activeTab);
  refreshActiveTab();
}

function refreshActiveTab() {
  manageDashboardPoll();
  const loaders = {
    dashboard: loadDashboard,
    listings: loadListings,
    groups: loadGroups,
    reservations: loadReservations,
    conversations: loadConversations,
    rules: loadRules,
    requests: loadRequests,
    payments: loadPayments,
    logs: loadLogs,
    fonioActivity: loadFonioActivity,
    fonio: loadFonio,
    check24: loadCheck24,
    users: loadUsers,
  };
  updateRuleSelects();
  loaders[activeTab]?.();
}

function manageDashboardPoll() {
  if (dashboardPoll) clearInterval(dashboardPoll);
  dashboardPoll = null;
  if (paymentsStatusPoll) clearInterval(paymentsStatusPoll);
  paymentsStatusPoll = null;
  if (conversationsPoll) clearInterval(conversationsPoll);
  conversationsPoll = null;
  if (activeTab === 'dashboard' && token) {
    dashboardPoll = setInterval(() => {
      if (activeTab === 'dashboard') loadDashboard();
    }, 5000);
  }
  if (activeTab === 'payments' && token) {
    paymentsStatusPoll = setInterval(() => {
      if (activeTab === 'payments') {
        loadQontoStatus();
        loadPaypalStatus();
      }
    }, 15000);
  }
  if (activeTab === 'conversations' && token) {
    manageConversationsPoll();
  }
}

function formatRelativeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const ms = Date.now() - then;
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return t('payments.agoSeconds', { n: Math.max(1, sec) });
  const min = Math.floor(sec / 60);
  if (min < 60) return t('payments.agoMinutes', { n: min });
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return t('payments.agoHours', { n: hrs });
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  if (remHrs <= 0) return t('payments.agoDays', { n: days });
  return t('payments.agoDaysHours', { days, hours: remHrs });
}

/** Friendly import time: "Today, 08:42" / "Yesterday, 18:13" / "13/07/2026, 18:13". */
function formatPaymentImportTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startThen = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startToday - startThen) / 86400000);
  if (dayDiff === 0) return t('payments.timeToday', { time });
  if (dayDiff === 1) return t('payments.timeYesterday', { time });
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}, ${time}`;
}

function formatSyncPhase(last, inProgress) {
  if (!last || (last.status !== 'running' && !inProgress)) {
    return last?.status || '–';
  }
  const meta = last.metadata || {};
  if (meta.phase === 'listings') return t('dashboard.syncPhase.listings');
  if (meta.phase === 'reservations') {
    return t('dashboard.syncPhase.reservations', {
      done: meta.reservationsDone ?? '?',
      total: meta.reservationsTotal ?? '?',
    });
  }
  if (meta.phase === 'calendars') {
    return t('dashboard.syncPhase.calendars', {
      done: meta.calendarListing ?? '?',
      total: meta.calendarTotal ?? '?',
    });
  }
  return t('dashboard.syncPhase.running');
}

function formatSyncTime(last, inProgress) {
  if (!last?.startedAt) return '–';
  if (last.status === 'running' || inProgress) {
    const mins = Math.floor((Date.now() - new Date(last.startedAt).getTime()) / 60000);
    return `${formatDateTime(last.startedAt)} (${mins} min)`;
  }
  return last.finishedAt
    ? formatDateTime(last.finishedAt)
    : formatDateTime(last.startedAt);
}

function tableQuery(tabKey) {
  const s = tableState[tabKey];
  const params = new URLSearchParams();
  params.set('page', String(s.page));
  params.set('pageSize', String(s.pageSize));
  if (s.search.trim()) params.set('search', s.search.trim());
  if (s.sortBy) {
    params.set('sortBy', s.sortBy);
    params.set('sortDir', s.sortDir || 'asc');
  }
  if (tabKey === 'listings') {
    if (s.city) params.set('city', s.city);
    if (s.groupId) params.set('groupId', s.groupId);
    if (s.status) params.set('status', s.status);
    if (s.bookable) params.set('bookable', s.bookable);
    params.set('includeFacets', '1');
  }
  if (tabKey === 'groups') {
    if (s.city) params.set('city', s.city);
    if (s.mode) params.set('mode', s.mode);
    params.set('includeFacets', '1');
  }
  if (tabKey === 'reservations') {
    if (s.status && s.status !== 'all') params.set('status', s.status);
    if (s.paymentStatus && s.paymentStatus !== 'all') {
      params.set('paymentStatus', s.paymentStatus);
    }
    if (s.channel && s.channel !== 'all') params.set('channel', s.channel);
    if (s.groupId && s.groupId !== 'all') params.set('groupId', s.groupId);
    if (s.dateFrom) params.set('dateFrom', s.dateFrom);
    if (s.dateTo) params.set('dateTo', s.dateTo);
    if (s.cancelledRecordedToday) params.set('cancelledRecordedToday', '1');
  }
  if (tabKey === 'conversations') {
    if (s.status && s.status !== 'all') params.set('status', s.status);
    if (s.channel && s.channel !== 'all') params.set('channel', s.channel);
  }
  return params.toString();
}

function sortIndicator(tabKey, column) {
  const s = tableState[tabKey];
  if (s.sortBy !== column) return '';
  return s.sortDir === 'asc' ? ' ▲' : ' ▼';
}

function sortTh(tabKey, column, label) {
  return `<th class="sortable" data-sort="${column}" data-label="${esc(label)}" role="button" tabindex="0">${label}${sortIndicator(tabKey, column)}</th>`;
}

function toggleSort(tabKey, column) {
  const s = tableState[tabKey];
  if (s.sortBy === column) {
    s.sortDir = s.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    s.sortBy = column;
    s.sortDir = column === 'arrivalDate' || column === 'departureDate' || column === 'createdAt' ? 'desc' : 'asc';
  }
  s.page = 1;
}

function bindSortableHeaders(containerSelector, tabKey, loader) {
  $$(`${containerSelector} th[data-sort]`).forEach((th) => {
    const activate = () => {
      toggleSort(tabKey, th.dataset.sort);
      loader();
    };
    th.addEventListener('click', activate);
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
  });
}

function compareSort(a, b, sortBy, sortDir) {
  const pick = (row) => {
    if (sortBy === 'listingName') return row.reservation?.listing?.name ?? row.listing?.name ?? '';
    if (sortBy === 'requestType') return row.requestType ?? '';
    if (sortBy === 'action') return row.action ?? '';
    if (sortBy === 'source') return row.source ?? '';
    if (sortBy === 'email') return row.email ?? '';
    if (sortBy === 'role') return row.role ?? '';
    return row[sortBy] ?? '';
  };
  const av = pick(a);
  const bv = pick(b);
  let cmp = 0;
  if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
  else cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
  return sortDir === 'desc' ? -cmp : cmp;
}

function ensurePaymentsToolbar(loader) {
  const el = $('#payments-toolbar');
  if (!el) return;
  const tabKey = 'payments';
  const s = tableState[tabKey];
  if (el.dataset.toolbarInit === 'payments-v7') {
    const dateSel = el.querySelector('[data-payment-filter="date"]');
    const searchInput = el.querySelector(`[data-table-search="${tabKey}"]`);
    if (dateSel) dateSel.value = s.date || 'all';
    if (searchInput && document.activeElement !== searchInput) searchInput.value = s.search || '';
    return;
  }
  el.dataset.toolbarInit = 'payments-v7';
  el.innerHTML = `
    <div class="payments-toolbar-filters">
      <label class="payments-search-field payments-reconcile-search-field">
        <span class="payments-filter-label">${t('table.search')}</span>
        <span class="payments-search-wrap">
          <svg class="payments-search-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
            <circle cx="11" cy="11" r="6.25" fill="none" stroke="currentColor" stroke-width="2"/>
            <path d="M16 16.5 20 20.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <input type="search" data-table-search="${tabKey}" value="${esc(s.search)}" autocomplete="off" placeholder="${esc(t('payments.searchPlaceholder'))}" />
        </span>
      </label>
      <label>
        <span class="payments-filter-label">${t('payments.dateFilter')}</span>
        <select data-payment-filter="date">
          <option value="all">${t('payments.filterAllTime')}</option>
          <option value="24h">${t('payments.filter24h')}</option>
          <option value="7d">${t('payments.filter7d')}</option>
          <option value="30d">${t('payments.filter30d')}</option>
        </select>
      </label>
    </div>
  `;
  const dateSel = el.querySelector('[data-payment-filter="date"]');
  if (dateSel) dateSel.value = s.date || 'all';
  el.querySelector(`[data-table-search="${tabKey}"]`)?.addEventListener('input', (e) => {
    clearTimeout(searchTimers[tabKey]);
    searchTimers[tabKey] = setTimeout(() => {
      tableState[tabKey].search = e.target.value;
      tableState[tabKey].page = 1;
      loader();
    }, 300);
  });
  dateSel?.addEventListener('change', (e) => {
    tableState[tabKey].date = e.target.value;
    tableState[tabKey].page = 1;
    loader();
  });
}

function ensurePaymentsHistoryToolbar(loader) {
  const el = $('#payments-history-toolbar');
  if (!el) return;
  const tabKey = 'paymentsHistory';
  const s = tableState[tabKey];
  if (el.dataset.toolbarInit === 'payments-history-v4') {
    const sourceSel = el.querySelector('[data-history-filter="source"]');
    const searchInput = el.querySelector(`[data-table-search="${tabKey}"]`);
    if (sourceSel) sourceSel.value = s.source || 'all';
    if (searchInput && document.activeElement !== searchInput) searchInput.value = s.search || '';
    return;
  }
  el.dataset.toolbarInit = 'payments-history-v4';
  el.innerHTML = `
    <div class="payments-toolbar-filters payments-history-toolbar-filters">
      <label class="payments-search-field payments-history-search-field">
        <span class="payments-filter-label sr-only">${t('table.search')}</span>
        <span class="payments-search-wrap">
          <svg class="payments-search-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
            <circle cx="11" cy="11" r="6.25" fill="none" stroke="currentColor" stroke-width="2"/>
            <path d="M16 16.5 20 20.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <input type="search" data-table-search="${tabKey}" value="${esc(s.search)}" autocomplete="off" placeholder="${esc(t('payments.historySearchPlaceholder'))}" />
        </span>
      </label>
      <label>
        <span class="payments-filter-label sr-only">${t('payments.source')}</span>
        <select data-history-filter="source">
          <option value="all">${t('payments.filterAllSources')}</option>
          <option value="QONTO">Qonto</option>
          <option value="PAYPAL">PayPal</option>
        </select>
      </label>
    </div>
  `;
  const sourceSel = el.querySelector('[data-history-filter="source"]');
  if (sourceSel) sourceSel.value = s.source || 'all';
  el.querySelector(`[data-table-search="${tabKey}"]`)?.addEventListener('input', (e) => {
    clearTimeout(searchTimers[tabKey]);
    searchTimers[tabKey] = setTimeout(() => {
      tableState[tabKey].search = e.target.value;
      tableState[tabKey].page = 1;
      loader();
    }, 300);
  });
  sourceSel?.addEventListener('change', (e) => {
    tableState[tabKey].source = e.target.value;
    tableState[tabKey].page = 1;
    loader();
  });
}

function resetTableToolbars() {
  document.querySelectorAll('[data-toolbar-init]').forEach((el) => {
    delete el.dataset.toolbarInit;
    delete el.dataset.fonioFilterInit;
  });
}

function renderTableInfo(infoId, data, maxTotal) {
  const el = $(infoId);
  if (!el || !data) return;
  const { page, pageSize, total } = data;
  if (!total) {
    el.textContent = t('table.infoEmpty');
    return;
  }
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  if (maxTotal && maxTotal > total) {
    el.textContent = t('table.infoFiltered', { start, end, total, max: maxTotal });
  } else {
    el.textContent = t('table.info', { start, end, total });
  }
}

function buildPageList(page, totalPages) {
  if (totalPages <= 1) return [1];
  const pages = new Set([1, totalPages]);
  for (let i = page - 2; i <= page + 2; i += 1) {
    if (i >= 1 && i <= totalPages) pages.add(i);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const result = [];
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) result.push('…');
    result.push(sorted[i]);
  }
  return result;
}

function pageSizeOptionLabel(n) {
  return t('table.perPage', { n: String(n) });
}

/**
 * Shared pagination control for the whole admin UI.
 * Renders page buttons + "N / page" select in one consistent control.
 *
 * @param {string} containerId
 * @param {{ page: number, totalPages: number, pageSize?: number }} data
 * @param {string} tabKey
 * @param {Function} loader
 * @param {{
 *   compact?: boolean,
 *   includePageSize?: boolean,
 *   pageSizeOptions?: number[],
 *   state?: { page: number, pageSize: number },
 *   selectId?: string,
 * }} [opts]
 */
function renderPagination(containerId, data, tabKey, loader, opts = {}) {
  const el = $(containerId);
  if (!el || !data) return;
  const state = opts.state || tableState[tabKey];
  const page = Number(data.page) || 1;
  const totalPages = Math.max(1, Number(data.totalPages) || 1);
  const pages = buildPageList(page, totalPages);
  const compact = Boolean(opts.compact);
  const includePageSize = opts.includePageSize !== false;
  const sizeOpts =
    Array.isArray(opts.pageSizeOptions) && opts.pageSizeOptions.length
      ? opts.pageSizeOptions
      : PAGE_SIZE_OPTIONS;
  const currentSize = Number(state?.pageSize ?? data.pageSize) || DEFAULT_PAGE_SIZE;
  const safeSize = sizeOpts.includes(currentSize) ? currentSize : sizeOpts[0];
  const selectId =
    opts.selectId ||
    `pager-${String(tabKey || 'table').replace(/[^a-zA-Z0-9_-]/g, '')}-size`;

  el.classList.toggle('is-compact', compact);
  el.innerHTML = `
    <div class="table-pager${compact ? ' is-compact' : ''}">
      <div class="paginate" role="navigation" aria-label="Pagination">
        <button type="button" class="page-btn prev" data-page="prev" ${page <= 1 ? 'disabled' : ''} aria-label="Previous">‹</button>
        ${pages
          .map((p) => {
            if (p === '…') return `<span class="page-btn ellipsis">…</span>`;
            return `<button type="button" class="page-btn${p === page ? ' active' : ''}" data-page="${p}">${p}</button>`;
          })
          .join('')}
        <button type="button" class="page-btn next" data-page="next" ${page >= totalPages ? 'disabled' : ''} aria-label="Next">›</button>
      </div>
      ${
        includePageSize
          ? `<label class="table-page-size" for="${esc(selectId)}">
        <span class="sr-only">${esc(t('table.show'))}</span>
        <select id="${esc(selectId)}" aria-label="Per page">
          ${sizeOpts
            .map(
              (n) =>
                `<option value="${n}"${Number(n) === safeSize ? ' selected' : ''}>${esc(pageSizeOptionLabel(n))}</option>`,
            )
            .join('')}
        </select>
      </label>`
          : ''
      }
    </div>
  `;

  const goTo = (nextPage) => {
    if (!state) return;
    state.page = nextPage;
    loader();
  };
  el.querySelector('[data-page="prev"]')?.addEventListener('click', () => {
    if (page > 1) goTo(page - 1);
  });
  el.querySelector('[data-page="next"]')?.addEventListener('click', () => {
    if (page < totalPages) goTo(page + 1);
  });
  el.querySelectorAll('[data-page]').forEach((btn) => {
    if (btn.dataset.page === 'prev' || btn.dataset.page === 'next') return;
    btn.addEventListener('click', () => goTo(Number(btn.dataset.page)));
  });

  const sizeSel = includePageSize ? el.querySelector('.table-page-size select') : null;
  sizeSel?.addEventListener('change', (e) => {
    const next = Number(e.target.value) || DEFAULT_PAGE_SIZE;
    if (state) {
      state.pageSize = next;
      state.page = 1;
    }
    loader();
  });
}

function paginateClient(items, tabKey, searchFields) {
  const { page, pageSize, search, sortBy, sortDir } = tableState[tabKey];
  const q = search.trim().toLowerCase();
  let filtered = items;
  if (q) {
    filtered = items.filter((item) => {
      const haystack = searchFields(item).toLowerCase();
      return haystack.includes(q);
    });
  }
  if (sortBy) {
    filtered = [...filtered].sort((a, b) => compareSort(a, b, sortBy, sortDir || 'asc'));
  }
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  if (safePage !== page) tableState[tabKey].page = safePage;
  const start = (safePage - 1) * pageSize;
  return {
    items: filtered.slice(start, start + pageSize),
    total,
    page: safePage,
    pageSize,
    totalPages,
    maxTotal: items.length,
  };
}

function channelLabel(type) {
  const key = String(type || '').toLowerCase();
  if (key.includes('email')) return t('conversations.channel.email');
  if (key.includes('sms')) return t('conversations.channel.sms');
  return t('conversations.channel.message');
}

function looksLikeHtml(text) {
  return /<[a-z][\s\S]*>/i.test(text);
}

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,form,style').forEach((el) => el.remove());
  doc.body.querySelectorAll('*').forEach((el) => {
    [...el.attributes].forEach((attr) => {
      if (attr.name.startsWith('on') || attr.name === 'style') el.removeAttribute(attr.name);
    });
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return doc.body.innerHTML;
}

function formatMessageContent(message) {
  const raw = (message.emailFormatted || message.body || '').trim();
  if (!raw) return '<span class="muted">–</span>';
  if (looksLikeHtml(raw)) return sanitizeHtml(raw);
  return esc(raw).replace(/\n/g, '<br>');
}

function formatMessageDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : formatDateTime(value);
}

function renderConversationMessage(message, opts = {}) {
  const incoming = message.isIncoming === 1;
  const time = formatMessageTime(message.insertedOn);
  const who = incoming ? t('conversations.incoming') : 'Hostaway';
  const showGuestAvatar = incoming && opts.showGuestAvatar;
  const guestAvatar = opts.guestAvatarHtml || '';
  return `
    <div class="conv-bubble-row ${incoming ? 'is-guest' : 'is-host'}">
      ${showGuestAvatar ? guestAvatar : incoming ? `<div class="conversations-avatar is-sm conv-avatar-spacer" aria-hidden="true"></div>` : ''}
      ${incoming ? '' : `<div class="conversations-avatar is-sm" aria-hidden="true">H</div>`}
      <div class="conv-bubble ${incoming ? 'is-guest' : 'is-host'}">
        ${incoming ? '' : `<div class="conv-bubble-who">${esc(who)}</div>`}
        <div class="message-body">${formatMessageContent(message)}</div>
        <div class="conv-bubble-meta">${esc(time)}</div>
      </div>
    </div>
  `;
}

function formatMessageTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

function conversationMessageDayKey(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function conversationDayLabel(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const yday = new Date();
  yday.setDate(today.getDate() - 1);
  const key = conversationMessageDayKey(value);
  if (key === conversationMessageDayKey(today)) return t('conversations.today');
  if (key === conversationMessageDayKey(yday)) return t('conversations.yesterday');
  return d.toLocaleDateString(locale(), { month: 'short', day: 'numeric', year: 'numeric' });
}

const RULE_TYPE_CODES = [
  'ADD_GUEST', 'ADD_PET', 'CANCELLATION', 'MODIFICATION',
  'EARLY_CHECKIN', 'LATE_CHECKOUT', 'RESERVATION_QUESTION', 'OTHER',
];

function ruleTypeLabel(code) {
  const key = `requestType.${code}`;
  const label = t(key);
  return label === key ? code : label;
}

function resolveRuleTypeInput(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const upper = value.toUpperCase().replace(/\s+/g, '_');
  if (RULE_TYPE_CODES.includes(upper)) return upper;
  const byLabel = RULE_TYPE_CODES.find(
    (code) => ruleTypeLabel(code).toLowerCase() === value.toLowerCase(),
  );
  return byLabel || value;
}

function formatRuleTypeDisplay(value) {
  if (!value) return '–';
  if (RULE_TYPE_CODES.includes(value)) return ruleTypeLabel(value);
  return value;
}

function updateRuleSelects() {
  const modes = ['AUTO', 'MANUAL', 'DENY'];
  const typeInput = $('#rule-type');
  const modeSel = $('#rule-mode');
  const suggestions = $('#rule-type-suggestions');
  if (!typeInput || !modeSel) return;
  const curMode = modeSel.value;
  if (suggestions) {
    suggestions.innerHTML = RULE_TYPE_CODES.map((v) =>
      `<option value="${esc(ruleTypeLabel(v))}"></option>`,
    ).join('');
  }
  modeSel.innerHTML = modes.map((v) =>
    `<option value="${v}">${t(`mode.${v}`)}</option>`,
  ).join('');
  modeSel.value = modes.includes(curMode) ? curMode : modes[0];
  syncRuleModeForType();
  renderRuleConditionsPanel();
}

function syncRuleModeForType() {
  const type = resolveRuleTypeInput($('#rule-type')?.value || '');
  const modeSel = $('#rule-mode');
  if (!modeSel) return;
  const autoOpt = modeSel.querySelector('option[value="AUTO"]');
  if (autoOpt) autoOpt.disabled = type === 'CANCELLATION';
  if (type === 'CANCELLATION' && modeSel.value === 'AUTO') modeSel.value = 'MANUAL';
}

function renderRuleConditionsPanel() {
  // Conditions UI removed to keep the rules form simple.
  $('#rule-conditions-panel')?.classList.add('hidden');
}

function buildConditionsFromForm() {
  // Do not send conditions from the form so existing values stay unchanged on edit.
  return undefined;
}

function loadConditionsIntoForm(_conditions) {
  renderRuleConditionsPanel();
}

$('#rule-type')?.addEventListener('change', () => {
  syncRuleModeForType();
  renderRuleConditionsPanel();
});
$('#rule-type')?.addEventListener('input', () => {
  syncRuleModeForType();
});
$('#rule-mode')?.addEventListener('change', renderRuleConditionsPanel);
$('#rules-create-toggle')?.addEventListener('click', () => {
  const card = $('#rules-create-card');
  const btn = $('#rules-create-toggle');
  if (!card || !btn) return;
  const open = !card.classList.contains('is-collapsed');
  if (open) collapseRulesCreatePanel();
  else expandRulesCreatePanel();
});

function expandRulesCreatePanel() {
  const card = $('#rules-create-card');
  const btn = $('#rules-create-toggle');
  card?.classList.remove('is-collapsed');
  btn?.setAttribute('aria-expanded', 'true');
  if (isRulesMobile()) {
    card?.classList.add('is-mobile-open');
    const backdrop = $('#rules-create-backdrop');
    backdrop?.classList.remove('hidden');
    backdrop?.removeAttribute('hidden');
    document.body.classList.add('rules-create-modal-open');
  }
}

function collapseRulesCreatePanel() {
  const card = $('#rules-create-card');
  const btn = $('#rules-create-toggle');
  card?.classList.add('is-collapsed');
  card?.classList.remove('is-mobile-open');
  btn?.setAttribute('aria-expanded', 'false');
  const backdrop = $('#rules-create-backdrop');
  backdrop?.classList.add('hidden');
  backdrop?.setAttribute('hidden', '');
  document.body.classList.remove('rules-create-modal-open');
}

function isRulesMobile() {
  return window.matchMedia('(max-width: 1023px)').matches;
}

function closeRulesMenus() {
  $$('.rules-mobile-card.is-menu-open').forEach((card) => card.classList.remove('is-menu-open'));
}

function ensureRulesFilterSheet() {
  let sheet = $('#rules-filter-sheet');
  if (sheet) return sheet;
  sheet = document.createElement('div');
  sheet.id = 'rules-filter-sheet';
  sheet.className = 'rules-filter-sheet hidden';
  sheet.innerHTML = `
    <button type="button" class="rules-filter-sheet-backdrop" aria-label="Close"></button>
    <div class="rules-filter-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="rules-filter-sheet-title">
      <div class="rules-filter-sheet-handle" aria-hidden="true"></div>
      <div class="rules-filter-sheet-head">
        <h4 id="rules-filter-sheet-title" class="rules-filter-sheet-title">${esc(t('rules.filters'))}</h4>
        <button type="button" class="rules-filter-sheet-close" aria-label="Close">&times;</button>
      </div>
      <div class="rules-filter-sheet-section">
        <div class="rules-filter-sheet-label">${esc(t('rules.mode'))}</div>
        <div class="rules-filter-sheet-options" data-rules-filter="mode"></div>
      </div>
      <div class="rules-filter-sheet-section">
        <div class="rules-filter-sheet-label">${esc(t('rules.col.status'))}</div>
        <div class="rules-filter-sheet-options" data-rules-filter="status"></div>
      </div>
    </div>`;
  document.body.appendChild(sheet);
  sheet.querySelector('.rules-filter-sheet-backdrop')?.addEventListener('click', closeRulesFilterSheet);
  sheet.querySelector('.rules-filter-sheet-close')?.addEventListener('click', closeRulesFilterSheet);
  return sheet;
}

function closeRulesFilterSheet() {
  const sheet = $('#rules-filter-sheet');
  sheet?.classList.add('hidden');
  document.body.classList.remove('rules-filter-sheet-open');
}

function openRulesFilterSheet() {
  const sheet = ensureRulesFilterSheet();
  const modeOpts = [
    { value: 'all', label: t('rules.filterAllModes') },
    { value: 'AUTO', label: t('mode.AUTO') },
    { value: 'MANUAL', label: t('mode.MANUAL') },
    { value: 'DENY', label: t('mode.DENY') },
  ];
  const statusOpts = [
    { value: 'all', label: t('rules.filterAllStatuses') },
    { value: 'active', label: t('rules.active') },
    { value: 'inactive', label: t('rules.inactive') },
  ];
  const modeCurrent = tableState.rules.mode || 'all';
  const statusCurrent = tableState.rules.status || 'all';
  const titleEl = sheet.querySelector('.rules-filter-sheet-title');
  if (titleEl) titleEl.textContent = t('rules.filters');
  const modeEl = sheet.querySelector('[data-rules-filter="mode"]');
  const statusEl = sheet.querySelector('[data-rules-filter="status"]');
  if (modeEl) {
    modeEl.innerHTML = modeOpts.map((o) => `
      <button type="button" class="rules-filter-sheet-option${o.value === modeCurrent ? ' is-selected' : ''}" data-rules-filter-key="mode" data-value="${esc(o.value)}">${esc(o.label)}</button>
    `).join('');
  }
  if (statusEl) {
    statusEl.innerHTML = statusOpts.map((o) => `
      <button type="button" class="rules-filter-sheet-option${o.value === statusCurrent ? ' is-selected' : ''}" data-rules-filter-key="status" data-value="${esc(o.value)}">${esc(o.label)}</button>
    `).join('');
  }
  sheet.querySelectorAll('.rules-filter-sheet-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.rulesFilterKey;
      const value = btn.dataset.value;
      if (key === 'mode') tableState.rules.mode = value;
      if (key === 'status') tableState.rules.status = value;
      tableState.rules.page = 1;
      closeRulesFilterSheet();
      loadRules();
    });
  });
  sheet.classList.remove('hidden');
  document.body.classList.add('rules-filter-sheet-open');
}

async function deleteApprovalRule(ruleId) {
  if (!ruleId || !hasPermission('RULES_DELETE')) return;
  const ok = await notify.confirm(t('rules.deleteConfirm'), {
    title: t('rules.deleteTitle'),
    okLabel: t('rules.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/rules/${ruleId}`, { method: 'DELETE' });
    notify.success(t('rules.deleted'));
    if (editingRuleId === ruleId) {
      resetRuleForm();
      if (isRulesMobile()) collapseRulesCreatePanel();
    }
    await loadRules();
  } catch (ex) {
    notify.error(t('rules.error', { message: ex.message }));
  }
}

function renderRulesMobileList(items, { canEdit, canDelete, totalCount }) {
  const list = $('#rules-mobile-list');
  if (!list) return;
  list.removeAttribute('hidden');
  const countBadge = $('#rules-existing-count');
  if (countBadge) countBadge.textContent = String(totalCount ?? items.length);
  const title = $('#rules-existing-title');
  if (title) title.textContent = t('rules.existingRules');

  if (!items.length) {
    list.innerHTML = `<div class="rules-mobile-empty">${esc(t('rules.none'))}</div>`;
    return;
  }

  const listingIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/></svg>`;
  const priorityIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7"/></svg>`;

  list.innerHTML = items.map((r) => {
    const active = r.isActive !== false;
    const listingLabel = r.listing?.name || t('rules.allListings');
    const selected = editingRuleId === r.id;
    return `
      <article class="rules-mobile-card${selected ? ' is-selected' : ''}" data-rule-id="${r.id}">
        <div class="rules-mobile-card-top">
          <div class="rules-mobile-card-main">
            <h4 class="rules-mobile-card-title">${esc(formatRuleTypeDisplay(r.requestType))}</h4>
            <span class="rules-mode-badge ${modeBadgeClass(r.mode)}">${esc(t(`mode.${r.mode}`) || r.mode)}</span>
          </div>
          ${(canEdit || canDelete) ? `
          <div class="rules-mobile-card-menu">
            <button type="button" class="rules-mobile-menu-btn" data-rule-menu="${r.id}" aria-label="${esc(t('rules.col.actions'))}" aria-haspopup="menu">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
            </button>
            <div class="rules-mobile-menu" role="menu">
              ${canEdit ? `<button type="button" role="menuitem" data-rule-edit="${r.id}">${esc(t('rules.editRule'))}</button>` : ''}
              ${canDelete ? `<button type="button" role="menuitem" class="is-danger" data-rule-delete="${r.id}">${esc(t('rules.delete'))}</button>` : ''}
            </div>
          </div>` : ''}
        </div>
        <div class="rules-mobile-card-meta">
          <span>${listingIcon}<span>${esc(listingLabel)}</span></span>
          <span>${priorityIcon}<span>${esc(t('rules.priorityValue', { n: r.priority }))}</span></span>
          <span class="rules-status-dot ${active ? 'is-active' : 'is-inactive'}">
            <span class="rules-status-dot-mark" aria-hidden="true"></span>
            ${esc(active ? t('rules.active') : t('rules.inactive'))}
          </span>
        </div>
      </article>`;
  }).join('');
}

function bindRulesMobileList() {
  const list = $('#rules-mobile-list');
  if (!list || list.dataset.bound === '1') return;
  list.dataset.bound = '1';
  list.addEventListener('click', (e) => {
    const menuBtn = e.target.closest('[data-rule-menu]');
    if (menuBtn) {
      e.preventDefault();
      e.stopPropagation();
      const card = menuBtn.closest('.rules-mobile-card');
      const open = card?.classList.contains('is-menu-open');
      closeRulesMenus();
      if (!open) card?.classList.add('is-menu-open');
      return;
    }
    const editBtn = e.target.closest('[data-rule-edit]');
    if (editBtn) {
      e.preventDefault();
      closeRulesMenus();
      const rule = cachedRules.find((r) => r.id === editBtn.dataset.ruleEdit);
      if (rule) loadRuleIntoForm(rule);
      return;
    }
    const deleteBtn = e.target.closest('[data-rule-delete]');
    if (deleteBtn) {
      e.preventDefault();
      closeRulesMenus();
      deleteApprovalRule(deleteBtn.dataset.ruleDelete);
      return;
    }
    const card = e.target.closest('.rules-mobile-card[data-rule-id]');
    if (card && hasPermission('RULES_EDIT')) {
      closeRulesMenus();
      const rule = cachedRules.find((r) => r.id === card.dataset.ruleId);
      if (rule) loadRuleIntoForm(rule);
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.rules-mobile-card-menu')) closeRulesMenus();
  });
}

function ensureRulesApprovalMobileUi() {
  const createBtn = $('#rules-mobile-create-btn');
  const closeBtn = $('#rules-create-modal-close');
  const backdrop = $('#rules-create-backdrop');
  const cancelMobile = $('#rule-new-btn-mobile');
  const deleteMobile = $('#rule-delete-btn-mobile');
  if (createBtn && createBtn.dataset.bound !== '1') {
    createBtn.dataset.bound = '1';
    createBtn.addEventListener('click', () => {
      if (!hasPermission('RULES_EDIT')) {
        notify.error(t('perms.featureLocked'));
        return;
      }
      resetRuleForm();
      expandRulesCreatePanel();
      $('#rule-type')?.focus();
    });
  }
  if (closeBtn && closeBtn.dataset.bound !== '1') {
    closeBtn.dataset.bound = '1';
    closeBtn.addEventListener('click', () => {
      collapseRulesCreatePanel();
      resetRuleForm();
    });
  }
  if (backdrop && backdrop.dataset.bound !== '1') {
    backdrop.dataset.bound = '1';
    backdrop.addEventListener('click', () => {
      collapseRulesCreatePanel();
      resetRuleForm();
    });
  }
  if (cancelMobile && cancelMobile.dataset.bound !== '1') {
    cancelMobile.dataset.bound = '1';
    cancelMobile.addEventListener('click', () => {
      resetRuleForm();
      if (isRulesMobile()) collapseRulesCreatePanel();
    });
  }
  if (deleteMobile && deleteMobile.dataset.bound !== '1') {
    deleteMobile.dataset.bound = '1';
    deleteMobile.addEventListener('click', async () => {
      if (!editingRuleId || !hasPermission('RULES_DELETE')) return;
      await deleteApprovalRule(editingRuleId);
    });
  }
  bindRulesMobileList();
  const card = $('#rules-create-card');
  if (!isRulesMobile() && card && card.dataset.desktopReady !== '1') {
    card.dataset.desktopReady = '1';
    expandRulesCreatePanel();
  }
}

$$('.lang-select').forEach((sel) => {
  sel.addEventListener('change', () => setLang(sel.value));
});

document.addEventListener('langchange', () => {
  resetTableToolbars();
  refreshActiveTab();
  updateRuleFormUI();
  renderRuleConditionsPanel();
  updateMobilePageTitle(activeTab);
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  err.classList.add('hidden');
  try {
    const res = await fetch(`${AUTH}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: $('#email').value,
        password: $('#password').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(Array.isArray(data.message) ? data.message.join(', ') : data.message);
    token = data.accessToken;
    adminRole = data.user?.role ?? '';
    adminPermissions = Array.isArray(data.user?.permissions) ? data.user.permissions : [];
    localStorage.setItem('adminToken', token);
    localStorage.setItem('adminRole', adminRole);
    localStorage.setItem('adminPermissions', JSON.stringify(adminPermissions));
    if (!adminRole) await restoreSession();
    showApp();
  } catch (ex) {
    err.textContent = ex.message || t('login.failed');
    err.classList.remove('hidden');
  }
});

$('#logout-btn').addEventListener('click', logout);

initMobileNav();
initMobileBottomNav();
fillSyncIntervalOptions(30);

$$('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    activateTab(btn.dataset.tab);
  });
});

$$('#tab-payments .payments-subnav-btn[data-payments-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    activatePaymentsView(btn.dataset.paymentsView);
  });
});

$$('#payments-mobile-bottom-nav [data-payments-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    activatePaymentsView(btn.dataset.paymentsView);
  });
});

$('#qonto-poll-btn-mobile')?.addEventListener('click', () => {
  $('#qonto-poll-btn')?.click();
});

async function saveSyncSettings({ silent = false } = {}) {
  const intervalMinutes = Number($('#auto-sync-interval').value);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
    notify.error(t('dashboard.autoSyncIntervalInvalid'));
    return false;
  }
  try {
    await api('/sync/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        autoSyncEnabled: $('#auto-sync-enabled').checked,
        intervalMinutes,
      }),
    });
    syncSettingsDirty = false;
    if (!silent) notify.success(t('dashboard.autoSyncSaved'));
    loadDashboard();
    return true;
  } catch (ex) {
    notify.error(ex.message);
    return false;
  }
}

$('#auto-sync-enabled')?.addEventListener('change', () => {
  syncSettingsDirty = true;
});
$('#auto-sync-interval')?.addEventListener('change', () => {
  syncSettingsDirty = true;
});

$('#sync-settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveSyncSettings();
});

async function runHostawaySyncNow() {
  const el = $('#sync-result');
  if (el) el.innerHTML = `<p>${t('dashboard.syncRunning')}</p>`;
  const buttons = [$('#sync-btn'), $('#sync-btn-card')].filter(Boolean);
  buttons.forEach((btn) => {
    btn.disabled = true;
  });
  try {
    const data = await api('/sync', { method: 'POST' });
    if (!data.started) {
      if (el) el.innerHTML = `<p class="field-hint">${t('dashboard.syncAlreadyRunning')}</p>`;
      notify.info(t('dashboard.syncAlreadyRunning'));
    } else {
      if (el) el.innerHTML = `<p>${t('dashboard.syncStarted')}</p>`;
      notify.success(t('dashboard.syncStarted'));
    }
    loadDashboard();
  } catch (ex) {
    if (el) el.innerHTML = `<p class="error">${t('dashboard.syncError', { message: ex.message })}</p>`;
    notify.error(t('dashboard.syncError', { message: ex.message }));
  } finally {
    const canRun = hasPermission('SYNC_RUN');
    buttons.forEach((btn) => {
      btn.disabled = !canRun;
    });
  }
}

$('#sync-btn')?.addEventListener('click', () => {
  runHostawaySyncNow();
});
$('#sync-btn-card')?.addEventListener('click', () => {
  runHostawaySyncNow();
});


$('#webhook-filter-search')?.addEventListener('input', (e) => {
  clearTimeout(searchTimers.webhooks);
  searchTimers.webhooks = setTimeout(() => {
    tableState.webhooks.search = e.target.value || '';
    tableState.webhooks.page = 1;
    renderWebhookDashboard(cachedWebhookJobs);
  }, 250);
});

['webhook-filter-range', 'webhook-filter-event', 'webhook-filter-result', 'trend-filter-range'].forEach((id) => {
  $(`#${id}`)?.addEventListener('change', (e) => {
    if (id === 'webhook-filter-range' || id === 'trend-filter-range') {
      webhookFilters.range = e.target.value;
      if ($('#webhook-filter-range')) $('#webhook-filter-range').value = webhookFilters.range;
      if ($('#trend-filter-range')) $('#trend-filter-range').value = webhookFilters.range;
    }
    if (id === 'webhook-filter-event') webhookFilters.event = e.target.value;
    if (id === 'webhook-filter-result') webhookFilters.result = e.target.value;
    tableState.webhooks.page = 1;
    renderWebhookDashboard(cachedWebhookJobs);
  });
});

document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-dash-nav]');
  if (!link) return;
  e.preventDefault();
  activateTab(link.dataset.dashNav);
});

document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-dash-scroll]');
  if (!link) return;
  e.preventDefault();
  $(link.dataset.dashScroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function fillSyncIntervalOptions(selected) {
  const sel = $('#auto-sync-interval');
  if (!sel) return;
  const value = Number(selected) || 30;
  const opts = SYNC_INTERVAL_OPTIONS.includes(value)
    ? SYNC_INTERVAL_OPTIONS
    : [...SYNC_INTERVAL_OPTIONS, value].sort((a, b) => a - b);
  sel.innerHTML = opts
    .map((n) => `<option value="${n}"${n === value ? ' selected' : ''}>${t('dashboard.intervalOption', { n })}</option>`)
    .join('');
}

function webhookEventName(job) {
  return String(job.jobType || '').replace(/^webhook:/, '') || 'event';
}

function classifyWebhookStatus(job) {
  if (job.status === 'completed') return 'success';
  if (job.status === 'failed') return 'failed';
  if (job.status === 'running') return 'running';
  return 'warning';
}

function webhookStatusBadge(kind) {
  if (kind === 'success') return `<span class="status-badge ok">${t('dashboard.status.success')}</span>`;
  if (kind === 'failed') return `<span class="status-badge err">${t('dashboard.status.failed')}</span>`;
  if (kind === 'running') return `<span class="status-badge run">${t('dashboard.status.running')}</span>`;
  return `<span class="status-badge warn">${t('dashboard.status.warning')}</span>`;
}

function formatNextSyncLabel(nextAt, intervalMinutes) {
  if (!nextAt) return `~${intervalMinutes} min`;
  const ms = nextAt.getTime() - Date.now();
  const absMin = Math.max(0, Math.round(Math.abs(ms) / 60000));
  const when = formatDashboardDateTime(nextAt);
  if (ms <= 0) return t('dashboard.nextSyncDue', { time: when });
  if (absMin < 60) return t('dashboard.nextSyncInMin', { time: when, n: absMin });
  const hours = Math.round(absMin / 60);
  return t('dashboard.nextSyncInHours', { time: when, n: hours });
}

function filterWebhookJobs(jobs) {
  const now = Date.now();
  const rangeMs =
    webhookFilters.range === '24h'
      ? 24 * 60 * 60 * 1000
      : webhookFilters.range === '7d'
        ? 7 * 24 * 60 * 60 * 1000
        : null;
  return jobs.filter((w) => {
    const started = new Date(w.startedAt).getTime();
    if (rangeMs != null && Number.isFinite(started) && now - started > rangeMs) return false;
    const event = webhookEventName(w);
    if (webhookFilters.event !== 'all' && event !== webhookFilters.event) return false;
    const kind = classifyWebhookStatus(w);
    if (webhookFilters.result === 'success' && kind !== 'success') return false;
    if (webhookFilters.result === 'failed' && kind !== 'failed') return false;
    if (webhookFilters.result === 'warning' && kind !== 'warning' && kind !== 'running') return false;
    return true;
  });
}

function populateWebhookEventFilter(jobs) {
  const sel = $('#webhook-filter-event');
  if (!sel) return;
  const current = webhookFilters.event;
  const events = [...new Set(jobs.map(webhookEventName))].sort();
  sel.innerHTML =
    `<option value="all">${t('dashboard.filter.allEvents')}</option>` +
    events.map((ev) => `<option value="${esc(ev)}">${esc(ev)}</option>`).join('');
  sel.value = events.includes(current) ? current : 'all';
  webhookFilters.event = sel.value;
}

function renderWebhookTrend(jobs) {
  const chartEl = $('#webhook-trend-chart');
  const totalsEl = $('#webhook-trend-totals');
  if (!chartEl || !totalsEl) return;

  let success = 0;
  let failed = 0;
  let warning = 0;
  jobs.forEach((w) => {
    const kind = classifyWebhookStatus(w);
    if (kind === 'success') success += 1;
    else if (kind === 'failed') failed += 1;
    else warning += 1;
  });
  const total = success + failed + warning;

  totalsEl.innerHTML = `
    <div class="trend-kpi">
      <div>
        <div class="trend-kpi-label">${t('dashboard.trend.totalEvents')}</div>
        <div class="trend-kpi-value">${formatCount(total)}</div>
      </div>
      <span class="trend-kpi-icon trend-kpi-total" aria-hidden="true">${trendIconLayers()}</span>
    </div>
    <div class="trend-kpi">
      <div>
        <div class="trend-kpi-label">${t('dashboard.trend.success')}</div>
        <div class="trend-kpi-value">${formatCount(success)}</div>
      </div>
      <span class="trend-kpi-icon trend-kpi-ok" aria-hidden="true">${trendIconCheck()}</span>
    </div>
    <div class="trend-kpi">
      <div>
        <div class="trend-kpi-label">${t('dashboard.trend.failed')}</div>
        <div class="trend-kpi-value">${formatCount(failed)}</div>
      </div>
      <span class="trend-kpi-icon trend-kpi-err" aria-hidden="true">${trendIconX()}</span>
    </div>
    <div class="trend-kpi">
      <div>
        <div class="trend-kpi-label">${t('dashboard.trend.warning')}</div>
        <div class="trend-kpi-value">${formatCount(warning)}</div>
      </div>
      <span class="trend-kpi-icon trend-kpi-warn" aria-hidden="true">${trendIconWarn()}</span>
    </div>
  `;

  if (!jobs.length) {
    chartEl.innerHTML = `<p class="field-hint">${t('dashboard.trend.empty')}</p>`;
    return;
  }

  const buckets = 7;
  const now = Date.now();
  let minT;
  let maxT = now;
  if (webhookFilters.range === '24h') {
    minT = now - 24 * 60 * 60 * 1000;
  } else if (webhookFilters.range === '7d') {
    minT = now - 7 * 24 * 60 * 60 * 1000;
  } else {
    const times = jobs
      .map((w) => new Date(w.startedAt).getTime())
      .filter((n) => Number.isFinite(n));
    minT = times.length ? Math.min(...times) : now - 24 * 60 * 60 * 1000;
    maxT = Math.max(...times, now);
  }
  const span = Math.max(maxT - minT, 1);
  const series = {
    success: Array(buckets).fill(0),
    failed: Array(buckets).fill(0),
    warning: Array(buckets).fill(0),
  };
  jobs.forEach((w) => {
    const ts = new Date(w.startedAt).getTime();
    if (!Number.isFinite(ts) || ts < minT || ts > maxT) return;
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor(((ts - minT) / span) * buckets)));
    const kind = classifyWebhookStatus(w);
    if (kind === 'success') series.success[idx] += 1;
    else if (kind === 'failed') series.failed[idx] += 1;
    else series.warning[idx] += 1;
  });

  const peakRaw = Math.max(1, ...series.success, ...series.failed, ...series.warning);
  const yMax = Math.max(5, Math.ceil(peakRaw / 5) * 5);
  const w = 720;
  const h = 300;
  const padL = 48;
  const padR = 16;
  const padT = 16;
  const padB = 36;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const xAt = (i) => padL + (i / Math.max(buckets - 1, 1)) * plotW;
  const yAt = (v) => padT + plotH - (v / yMax) * plotH;
  const toPoints = (arr) => arr.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ');
  const areaPoints = (arr) => {
    const line = arr.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ');
    return `${xAt(0)},${yAt(0)} ${line} ${xAt(buckets - 1)},${yAt(0)}`;
  };
  const dots = (arr, color) =>
    arr
      .map((v, i) => `<circle cx="${xAt(i)}" cy="${yAt(v)}" r="4" fill="${color}" stroke="#0f1419" stroke-width="1.5" />`)
      .join('');
  const gridSteps = 5;
  const grid = Array.from({ length: gridSteps + 1 }, (_, i) => {
    const val = Math.round((yMax / gridSteps) * i);
    const y = yAt(val);
    return `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="#2d3a4f" stroke-width="1" />
      <text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="#8b9cb3" font-size="13">${val}</text>`;
  }).join('');
  const xLabels = Array.from({ length: buckets }, (_, i) => {
    const ts = minT + (span * i) / Math.max(buckets - 1, 1);
    const label = formatTrendAxisLabel(ts, span);
    return `<text x="${xAt(i)}" y="${h - 10}" text-anchor="middle" fill="#8b9cb3" font-size="13">${label}</text>`;
  }).join('');
  const yMid = padT + plotH / 2;
  const yAxisTitle = `<text x="14" y="${yMid}" fill="#8b9cb3" font-size="13" text-anchor="middle" transform="rotate(-90 14 ${yMid})">${esc(t('dashboard.trend.events'))}</text>`;

  chartEl.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(t('dashboard.trend.aria'))}">
      ${grid}
      ${yAxisTitle}
      <polygon points="${areaPoints(series.success)}" fill="rgba(34,197,94,0.18)" />
      <polyline fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${toPoints(series.success)}" />
      <polyline fill="none" stroke="#ef4444" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${toPoints(series.failed)}" />
      <polyline fill="none" stroke="#f59e0b" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${toPoints(series.warning)}" />
      ${dots(series.success, '#22c55e')}
      ${dots(series.failed, '#ef4444')}
      ${dots(series.warning, '#f59e0b')}
      ${xLabels}
    </svg>
  `;
}

function formatTrendAxisLabel(ts, spanMs) {
  const d = new Date(ts);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (spanMs <= 36 * 60 * 60 * 1000) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  if (spanMs <= 40 * 24 * 60 * 60 * 1000) {
    return `${d.getDate()} ${months[d.getMonth()]}`;
  }
  return `${months[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
}

function trendIconLayers() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 12.5-8.58 3.91a2 2 0 0 1-1.66 0L2.6 12.5"/><path d="m22 17.5-8.58 3.91a2 2 0 0 1-1.66 0L2.6 17.5"/></svg>`;
}
function trendIconCheck() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M8.5 12.5 11 15l4.5-5.5" stroke="#0f1419" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function trendIconX() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m9 9 6 6M15 9l-6 6" stroke="#0f1419" stroke-width="2.2" stroke-linecap="round"/></svg>`;
}
function trendIconWarn() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3.2 22 20.5H2L12 3.2Z" fill="currentColor"/><path d="M12 9.5v5" stroke="#0f1419" stroke-width="2.1" stroke-linecap="round"/><circle cx="12" cy="17.2" r="1.1" fill="#0f1419"/></svg>`;
}

function renderWebhookDashboard(allJobs) {
  populateWebhookEventFilter(allJobs);
  const filtered = filterWebhookJobs(allJobs);
  renderWebhookTrend(filtered);
const searchInput = $('#webhook-filter-search');
  if (searchInput && document.activeElement !== searchInput) {
    searchInput.value = tableState.webhooks.search || '';
  }

  const webhookData = paginateClient(filtered, 'webhooks', (w) =>
    [w.startedAt, w.jobType, w.status, JSON.stringify(w.metadata || {}), w.error || ''].join(' '),
  );
  const whRows = webhookData.items
    .map((w) => {
      const meta = w.metadata || {};
      const kind = classifyWebhookStatus(w);
      const result =
        kind === 'success'
          ? `${meta.listings ?? 0} ${t('dashboard.listings')}, ${meta.reservations ?? 0} ${t('dashboard.reservations')}`
          : w.error || w.status;
      const detail =
        kind === 'success'
          ? t('dashboard.webhookPayloadProcessed')
          : w.error || w.status;
      const resId = meta.reservationId || meta.hostawayReservationId;
      const eventLabel = resId
        ? `${webhookEventName(w)} · #${resId}`
        : webhookEventName(w);
      return {
        time: formatDashboardDateTime(w.startedAt),
        eventLabel,
        result: String(result),
        detail: String(detail),
        badge: webhookStatusBadge(kind),
      };
    });

  const tableRows = whRows
    .map(
      (row) => `<tr>
      <td>${row.time}</td>
      <td>${esc(row.eventLabel)}</td>
      <td>${esc(row.result)}</td>
      <td>${row.badge}</td>
    </tr>`,
    )
    .join('');

  const listRows = whRows
    .map(
      (row) => `
      <article class="webhook-feed-item">
        <span class="webhook-feed-icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.59 13.51 15.42 17.49"/><path d="m15.41 6.51-6.82 3.98"/></svg>
        </span>
        <div class="webhook-feed-copy">
          <div class="webhook-feed-title">${esc(row.eventLabel)}</div>
          <div class="webhook-feed-time">${row.time}</div>
        </div>
        <div class="webhook-feed-status">
          ${row.badge}
          <div class="webhook-feed-detail">${esc(row.detail)}</div>
        </div>
      </article>`,
    )
    .join('');

  $('#webhook-activity').innerHTML = `
    <div class="webhook-desktop-table">
      <table class="no-responsive-stack"><thead><tr>
        <th>${t('dashboard.webhookCol.time')}</th>
        <th>${t('dashboard.webhookCol.event')}</th>
        <th>${t('dashboard.webhookCol.result')}</th>
        <th>${t('dashboard.webhookCol.status')}</th>
      </tr></thead>
      <tbody>${tableRows || `<tr><td colspan="4">${t('dashboard.webhookEmpty')}</td></tr>`}</tbody></table>
    </div>
    <div class="webhook-feed-list">
      ${listRows || `<div class="webhook-feed-empty">${t('dashboard.webhookEmpty')}</div>`}
    </div>`;
  renderTableInfo('#webhooks-info', webhookData, webhookData.maxTotal);
  renderPagination('#webhooks-pagination', webhookData, 'webhooks', () =>
    renderWebhookDashboard(cachedWebhookJobs),
  );
}

function healthBadge(state) {
  if (state === 'ok') return `<span class="health-badge ok">${t('dashboard.health.operational')}</span>`;
  if (state === 'warn') return `<span class="health-badge warn">${t('dashboard.health.degraded')}</span>`;
  return `<span class="health-badge err">${t('dashboard.health.down')}</span>`;
}

function dashStatIcon(kind) {
  const attrs = 'xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  if (kind === 'listings') {
    return `<svg ${attrs}><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
  }
  if (kind === 'reservations') {
    return `<svg ${attrs}><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>`;
  }
  if (kind === 'sync') {
    return `<svg ${attrs}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
  }
  return `<svg ${attrs}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
}

async function loadDashboard() {
  const [status, webhooks, healthRes, check24Res] = await Promise.all([
    api('/sync/status'),
    api('/sync/webhook-activity'),
    fetch('/health').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    hasPermission('DASHBOARD_VIEW')
      ? api('/check24/status').catch(() => null)
      : Promise.resolve(null),
  ]);
  const last = status.last;
  const settings = status.settings;
  const inProgress = !!status.inProgress || last?.status === 'running';
  const syncOk = !inProgress && last?.status === 'completed';
  const syncFailed = !inProgress && last?.status === 'failed';
  const syncLabel = inProgress
    ? formatSyncPhase(last, true)
    : syncOk
      ? t('dashboard.syncComplete')
      : syncFailed
        ? t('dashboard.syncFailed')
        : t('dashboard.syncIdle');
  const syncTime = formatDashboardDateTime(
    last?.finishedAt || last?.startedAt || null,
  );

  const statusEl = $('#dashboard-sync-status');
  if (statusEl) {
    statusEl.className = `sync-status-pill ${inProgress ? 'is-running' : syncOk ? 'is-ok' : syncFailed ? 'is-error' : 'is-idle'}`;
    statusEl.textContent = inProgress
      ? `⟳ ${syncLabel}`
      : syncOk
        ? `✓ ${t('dashboard.syncComplete')}`
        : syncFailed
          ? `✕ ${t('dashboard.syncFailed')}`
          : syncLabel;
  }
  const lastSyncEl = $('#dashboard-last-sync');
  if (lastSyncEl) {
    lastSyncEl.textContent = last
      ? t('dashboard.lastSyncLabel', { time: syncTime })
      : '';
  }

  const syncBadge = $('#hostaway-sync-badge');
  if (syncBadge) {
    syncBadge.className = `dash-synced-badge ${inProgress ? 'is-running' : syncOk ? 'is-ok' : syncFailed ? 'is-error' : 'is-idle'}`;
    syncBadge.textContent = inProgress
      ? t('dashboard.badge.syncing')
      : syncOk
        ? t('dashboard.badge.synced')
        : syncFailed
          ? t('dashboard.badge.failed')
          : t('dashboard.badge.idle');
  }

  $('#stats').innerHTML = `
    <div class="stat-card dash-stat">
      <div class="dash-stat-top">
        <span class="dash-stat-icon listings">${dashStatIcon('listings')}</span>
        <div class="dash-stat-text">
          <div class="value">${formatCount(status.listingCount)}</div>
          <div class="label">${t('dashboard.listingsLabel')}</div>
          <button type="button" class="link-btn" data-dash-nav="listings">${t('dashboard.viewListings')}</button>
        </div>
      </div>
    </div>
    <div class="stat-card dash-stat">
      <div class="dash-stat-top">
        <span class="dash-stat-icon reservations">${dashStatIcon('reservations')}</span>
        <div class="dash-stat-text">
          <div class="value">${formatCount(status.reservationCount)}</div>
          <div class="label">${t('dashboard.reservationsLabel')}</div>
          <button type="button" class="link-btn" data-dash-nav="reservations">${t('dashboard.viewReservations')}</button>
        </div>
      </div>
    </div>
    <div class="stat-card dash-stat">
      <div class="dash-stat-top">
        <span class="dash-stat-icon sync">${dashStatIcon('sync')}</span>
        <div class="dash-stat-text">
          <div class="value value-status">${esc(syncLabel)}</div>
          <div class="label">${syncOk ? t('dashboard.allSystemsOk') : formatSyncPhase(last, inProgress)}</div>
          <button type="button" class="link-btn" data-dash-scroll="#system-health-card">${t('dashboard.viewDetails')}</button>
        </div>
      </div>
    </div>
    <div class="stat-card dash-stat">
      <div class="dash-stat-top">
        <span class="dash-stat-icon time">${dashStatIcon('time')}</span>
        <div class="dash-stat-text">
          <div class="label label-top">${t('dashboard.lastSync')}</div>
          <div class="value value-sm">${syncTime}</div>
          <button type="button" class="link-btn" data-dash-scroll="#webhook-activity">${t('dashboard.viewSyncHistory')}</button>
        </div>
      </div>
    </div>
  `;

  if (!syncSettingsDirty) {
    $('#auto-sync-enabled').checked = settings?.autoSyncEnabled ?? true;
    fillSyncIntervalOptions(settings?.intervalMinutes ?? 30);
  } else {
    fillSyncIntervalOptions(Number($('#auto-sync-interval').value) || settings?.intervalMinutes || 30);
  }

  if (settings?.autoSyncEnabled) {
    const base = last?.finishedAt || last?.startedAt;
    const intervalMs = (settings.intervalMinutes || 30) * 60 * 1000;
    const nextAt = base ? new Date(new Date(base).getTime() + intervalMs) : null;
    $('#auto-sync-hint').textContent = formatNextSyncLabel(
      nextAt,
      settings.intervalMinutes || 30,
    );
  } else {
    $('#auto-sync-hint').textContent = t('dashboard.autoSyncOff');
  }

  const recentWebhookOk = (Array.isArray(webhooks) ? webhooks : [])
    .slice(0, 10)
    .some((w) => w.status === 'completed');
  const recentWebhookFail = (Array.isArray(webhooks) ? webhooks : [])
    .slice(0, 5)
    .every((w) => w.status === 'failed') && (webhooks?.length || 0) > 0;
  const hostawayState = syncFailed ? 'err' : healthRes?.checks?.database === 'ok' ? 'ok' : 'warn';
  const webhookState = recentWebhookFail ? 'err' : recentWebhookOk || (webhooks?.length || 0) === 0 ? 'ok' : 'warn';
  const fonioState = healthRes?.checks?.database === 'ok' ? 'ok' : 'warn';
  let check24State = 'warn';
  if (check24Res) {
    if (!check24Res.configured || !check24Res.enabled) check24State = 'warn';
    else if (check24Res.ping?.ok) check24State = 'ok';
    else check24State = 'err';
  }

  const healthItems = [
    ['hostaway', hostawayState],
    ['webhooks', webhookState],
    ['fonio', fonioState],
    ['check24', check24State],
  ];
  const allHealthOk = healthItems.every(([, state]) => state === 'ok');
  const anyHealthDown = healthItems.some(([, state]) => state === 'err');
  const healthSummary = $('#system-health-summary');
  if (healthSummary) {
    healthSummary.className = `dash-health-summary ${allHealthOk ? 'is-ok' : anyHealthDown ? 'is-error' : 'is-warn'}`;
    healthSummary.textContent = allHealthOk
      ? t('dashboard.health.allOperational')
      : anyHealthDown
        ? t('dashboard.health.someDown')
        : t('dashboard.health.someDegraded');
  }

  $('#system-health-list').innerHTML = healthItems
    .map(
      ([key, state]) => `
    <div class="health-row">
      <span class="health-dot ${state}" aria-hidden="true"></span>
      <div class="health-copy">
        <div class="health-name">${t(`dashboard.health.${key}`)}</div>
        <div class="health-desc">${t(`dashboard.health.${key}Desc`)}</div>
      </div>
      ${healthBadge(state)}
    </div>`,
    )
    .join('');

  cachedWebhookJobs = Array.isArray(webhooks) ? webhooks : [];
  if ($('#webhook-filter-range')) $('#webhook-filter-range').value = webhookFilters.range;
  if ($('#trend-filter-range')) $('#trend-filter-range').value = webhookFilters.range;
  if ($('#webhook-filter-result')) $('#webhook-filter-result').value = webhookFilters.result;
  renderWebhookDashboard(cachedWebhookJobs);
  applyRoleUi();
}

$('#rule-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!hasPermission('RULES_EDIT')) {
    notify.error(t('perms.featureLocked'));
    return;
  }
  const payload = {
    requestType: resolveRuleTypeInput($('#rule-type').value),
    mode: $('#rule-mode').value,
    listingId: $('#rule-listing').value || null,
    priority: Number($('#rule-priority').value),
    isActive: $('#rule-active').checked,
  };
  if (!payload.requestType) {
    notify.error(t('rules.typeRequired'));
    return;
  }
  const conditions = buildConditionsFromForm();
  if (conditions !== undefined) payload.conditions = conditions;
  try {
    if (editingRuleId) {
      await api(`/rules/${editingRuleId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify.success(t('rules.updated'));
    } else {
      await api('/rules', { method: 'POST', body: JSON.stringify(payload) });
      notify.success(t('rules.created'));
      resetRuleForm();
    }
    if (isRulesMobile()) collapseRulesCreatePanel();
    await loadRules();
  } catch (ex) {
    notify.error(t('rules.error', { message: ex.message }));
  }
});

$('#rule-new-btn').addEventListener('click', () => {
  resetRuleForm();
  if (isRulesMobile()) collapseRulesCreatePanel();
});

$('#rule-delete-btn').addEventListener('click', async () => {
  if (!editingRuleId || !hasPermission('RULES_DELETE')) return;
  await deleteApprovalRule(editingRuleId);
});

function updateRuleFormUI() {
  const titleText = editingRuleId
    ? t('rules.editApprovalRule')
    : t('rules.createApprovalRule');
  const title = $('#rule-form-title');
  const titleDesktop = $('#rule-form-title-desktop');
  const submitText = editingRuleId ? t('rules.updateRule') : t('rules.addRule');
  const submit = $('#rule-submit-btn');
  const submitMobile = $('#rule-submit-btn-mobile');
  if (title) title.textContent = titleText;
  if (titleDesktop) titleDesktop.textContent = titleText;
  if (submit) submit.textContent = submitText;
  if (submitMobile) submitMobile.textContent = submitText;
  const showDelete = !!editingRuleId && hasPermission('RULES_DELETE');
  const showCancel = !!editingRuleId && hasPermission('RULES_EDIT');
  $('#rule-delete-btn')?.classList.toggle('hidden', !showDelete);
  $('#rule-new-btn')?.classList.toggle('hidden', !showCancel);
  $('#rule-delete-btn-mobile')?.classList.toggle('hidden', !showDelete);
  $('#rule-new-btn-mobile')?.classList.toggle('hidden', !showCancel);
  applyRoleUi();
}

function resetRuleForm() {
  if (!hasPermission('RULES_EDIT') && editingRuleId) {
    editingRuleId = null;
  }
  editingRuleId = null;
  $('#rule-id').value = '';
  $('#rule-type').value = '';
  $('#rule-mode').value = 'AUTO';
  $('#rule-listing').value = '';
  $('#rule-priority').value = 0;
  $('#rule-active').checked = true;
  syncRuleModeForType();
  renderRuleConditionsPanel();
  updateRuleFormUI();
  highlightSelectedRule(null);
}

function loadRuleIntoForm(rule, opts = {}) {
  const { activate = true } = opts;
  editingRuleId = rule.id;
  $('#rule-id').value = rule.id;
  $('#rule-type').value = formatRuleTypeDisplay(rule.requestType);
  $('#rule-mode').value = rule.mode;
  $('#rule-listing').value = rule.listingId || '';
  $('#rule-priority').value = rule.priority;
  $('#rule-active').checked = rule.isActive !== false;
  syncRuleModeForType();
  loadConditionsIntoForm(rule.conditions);
  updateRuleFormUI();
  highlightSelectedRule(rule.id);
  if (activate) {
    expandRulesCreatePanel();
    activateRulesView('approval');
  }
}

function populateListingSelect() {
  const sel = $('#rule-listing');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">${t('rules.allListingsGlobal')}</option>` +
    cachedListings.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  sel.value = current;
}

function highlightSelectedRule(ruleId) {
  $$('#rules-table tbody tr').forEach((row) => {
    row.classList.toggle('selected', ruleId && row.dataset.ruleId === ruleId);
  });
  $$('#rules-mobile-list .rules-mobile-card').forEach((card) => {
    card.classList.toggle('is-selected', ruleId && card.dataset.ruleId === ruleId);
  });
}

function modeBadgeClass(mode) {
  if (mode === 'AUTO') return 'is-auto';
  if (mode === 'DENY') return 'is-deny';
  return 'is-manual';
}

function ensureRulesToolbar() {
  const search = $('#rules-search');
  const modeSel = $('#rules-filter-mode');
  const statusSel = $('#rules-filter-status');
  const s = tableState.rules;
  if (search && document.activeElement !== search) search.value = s.search || '';
  if (modeSel) modeSel.value = s.mode || 'all';
  if (statusSel) statusSel.value = s.status || 'all';
  if (search?.dataset.bound === '1') return;
  if (search) search.dataset.bound = '1';
  search?.addEventListener('input', (e) => {
    clearTimeout(searchTimers.rules);
    searchTimers.rules = setTimeout(() => {
      tableState.rules.search = e.target.value;
      tableState.rules.page = 1;
      loadRules();
    }, 300);
  });
  modeSel?.addEventListener('change', (e) => {
    tableState.rules.mode = e.target.value;
    tableState.rules.page = 1;
    loadRules();
  });
  statusSel?.addEventListener('change', (e) => {
    tableState.rules.status = e.target.value;
    tableState.rules.page = 1;
    loadRules();
  });
}


function bindRuleRowActions() {
  $$('#rules-table [data-rule-edit]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!hasPermission('RULES_EDIT')) return;
      const rule = cachedRules.find((r) => r.id === btn.dataset.ruleEdit);
      if (rule) loadRuleIntoForm(rule);
    });
  });
}

function bindRuleRowClicks() {
  $$('#rules-table tbody tr[data-rule-id]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      if (!hasPermission('RULES_EDIT')) return;
      const rule = cachedRules.find((r) => r.id === row.dataset.ruleId);
      if (rule) loadRuleIntoForm(rule);
    });
  });
}

async function loadListings() {
  ensureListingsToolbar();
  const data = await api(`/listings?${tableQuery('listings')}`);
  cachedListings = data.items || [];
  if (data.facets) {
    listingsFacets = {
      cities: Array.isArray(data.facets.cities) ? data.facets.cities : [],
      groups: Array.isArray(data.facets.groups) ? data.facets.groups : [],
    };
    refreshListingsFilterOptions();
  }
  const guestIcon = '<svg class="guest-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  const rows = cachedListings.map((l) => {
    const aliasText = (l.aliases && l.aliases.length)
      ? `<div class="listing-aliases-lines">${l.aliases.map((a) => `<span class="listing-alias-line">${esc(a)}</span>`).join('')}</div>`
      : `<span class="muted">${t('listings.aliasesEmpty')}</span>`;
    const editBtn = hasPermission('LISTINGS_EDIT')
      ? `<button type="button" class="btn primary btn-sm listing-aliases-edit" data-id="${esc(l.id)}">${t('listings.aliasesEdit')}</button>`
      : '';
    const thumb = listingThumbHtml(l);
    const statusClass = String(l.status || '').toUpperCase() === 'LIVE'
      ? 'badge-live'
      : String(l.status || '').toUpperCase() === 'HIDDEN'
        ? 'badge-hidden'
        : 'badge-neutral';
    const bookableClass = l.isBookable ? 'badge-yes' : 'badge-no';
    return `
    <tr>
      <td class="listing-thumb-cell">${thumb}</td>
      <td class="listing-id-cell">${l.hostawayId}</td>
      <td class="listing-name-cell"><span class="listing-name" title="${esc(l.name)}">${esc(l.name)}</span></td>
      <td class="listing-aliases-cell">${aliasText}</td>
      <td>${esc(l.city || '–')}</td>
      <td>${esc(l.listingGroup?.name || '–')}</td>
      <td class="listing-guests-cell"><span class="guests-pill">${guestIcon}${l.personCapacity}</span></td>
      <td><span class="status-pill ${statusClass}">${esc(l.status || '–')}</span></td>
      <td><span class="status-pill ${bookableClass}">${l.isBookable ? t('common.yes') : t('common.no')}</span></td>
      <td class="listing-actions-cell">${editBtn}</td>
    </tr>
  `;
  }).join('');
  $('#listings-table').innerHTML = `
    <table class="listings-table"><thead><tr>
      <th class="listing-thumb-col"></th>
      ${sortTh('listings', 'hostawayId', t('listings.id'))}
      ${sortTh('listings', 'name', t('listings.propertyName'))}
      <th>${t('listings.aliases')}</th>
      ${sortTh('listings', 'city', t('listings.city'))}
      <th>${t('listings.group')}</th>
      ${sortTh('listings', 'personCapacity', t('listings.guests'))}
      ${sortTh('listings', 'status', t('listings.visibility'))}
      <th>${t('listings.bookable')}</th>
      <th>${t('listings.actions')}</th>
    </tr></thead><tbody>${rows || `<tr class="table-empty-row"><td class="table-empty-cell" colspan="10">${t('table.infoEmpty')}</td></tr>`}</tbody></table>`;
  bindSortableHeaders('#listings-table', 'listings', loadListings);
  $$('.listing-aliases-edit').forEach((btn) => {
    btn.addEventListener('click', () => openListingAliasesModal(btn.dataset.id));
  });
  renderListingsMobile(cachedListings);
  renderTableInfo('#listings-info', data);
  renderPagination('#listings-pagination', data, 'listings', loadListings);
applyRoleUi();
  scheduleEnhanceResponsiveTables();
}

function listingStatusMeta(listing) {
  const status = String(listing?.status || '').toUpperCase();
  if (status === 'LIVE') return { cls: 'is-live', label: 'LIVE' };
  if (status === 'HIDDEN') return { cls: 'is-hidden', label: 'HIDDEN' };
  if (status === 'DRAFT') return { cls: 'is-draft', label: 'DRAFT' };
  return { cls: 'is-neutral', label: status || '–' };
}

function listingAliasTagsHtml(listing, maxVisible = 2) {
  const aliases = Array.isArray(listing?.aliases) ? listing.aliases.filter(Boolean) : [];
  if (!aliases.length) return '';
  const shown = aliases.slice(0, maxVisible);
  const rest = aliases.length - shown.length;
  return `
    <div class="listings-m-tags">
      ${shown.map((a) => `<span class="listings-m-tag">${esc(a)}</span>`).join('')}
      ${rest > 0 ? `<span class="listings-m-tag is-more">+${rest}</span>` : ''}
    </div>`;
}

function renderListingsMobile(items) {
  const root = $('#listings-mobile-list');
  if (!root) return;
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    root.innerHTML = `<div class="listings-m-empty">${esc(t('table.infoEmpty'))}</div>`;
    return;
  }
  const guestIcon =
    '<svg class="guest-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  const moreIcon =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>';
  const canEdit = hasPermission('LISTINGS_EDIT');
  root.innerHTML = list
    .map((l) => {
      const status = listingStatusMeta(l);
      const city = l.city || '–';
      const group = l.listingGroup?.name || '';
      const sub = [city, group].filter(Boolean).join(' · ');
      const guestsLabel = `${l.personCapacity ?? '–'} ${t('listings.guests').toLowerCase()}`;
      return `
      <article class="listings-m-card" data-listing-id="${esc(l.id)}">
        <div class="listings-m-card-main">
          ${listingThumbHtml(l)}
          <div class="listings-m-card-body">
            <div class="listings-m-card-top">
              <div class="listings-m-card-title" title="${esc(l.name)}">${esc(l.name)}</div>
              ${
                canEdit
                  ? `<button type="button" class="listings-m-more" data-edit-aliases="${esc(l.id)}" aria-label="${esc(t('listings.aliasesEdit'))}">${moreIcon}</button>`
                  : ''
              }
            </div>
            <div class="listings-m-card-meta">ID ${esc(String(l.hostawayId))} · ${esc(sub)}</div>
            <div class="listings-m-card-row">
              <span class="listings-m-guests">${guestIcon}<span>${esc(guestsLabel)}</span></span>
              <span class="listings-m-status ${status.cls}"><span class="listings-m-status-dot" aria-hidden="true"></span>${esc(status.label)}</span>
              <span class="listings-m-bookable ${l.isBookable ? 'is-yes' : 'is-no'}">${esc(l.isBookable ? t('listings.bookable') : t('common.no'))}</span>
            </div>
            ${listingAliasTagsHtml(l)}
          </div>
        </div>
      </article>`;
    })
    .join('');
  root.querySelectorAll('[data-edit-aliases]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openListingAliasesModal(btn.getAttribute('data-edit-aliases'));
    });
  });
}

function listingThumbPlaceholderHtml() {
  return `<span class="listing-thumb-frame listing-thumb-placeholder" aria-hidden="true">
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
  </span>`;
}

function listingThumbFallback(img) {
  if (!img || img.dataset.fallbackApplied === '1') return;
  img.dataset.fallbackApplied = '1';
  const wrap = document.createElement('span');
  const inGroup = !!img.closest('.group-thumb-frame, .group-listing-chip, .group-name-wrap');
  if (inGroup) {
    const isGroupRow = !!img.closest('.group-name-wrap');
    wrap.innerHTML = isGroupRow
      ? `<span class="group-thumb-frame is-group group-thumb-placeholder" aria-hidden="true">${groupBuildingIcon()}</span>`
      : `<span class="group-thumb-frame group-thumb-placeholder" aria-hidden="true">${groupHomeIcon()}</span>`;
  } else {
    wrap.innerHTML = listingThumbPlaceholderHtml();
  }
  const placeholder = wrap.firstElementChild;
  const target = img.closest('.group-thumb-frame, .listing-thumb-frame') || img;
  if (placeholder) target.replaceWith(placeholder);
}
window.listingThumbFallback = listingThumbFallback;

function listingCoverUrl(listing) {
  const meta = listing?.rawMetadata;
  if (!meta || typeof meta !== 'object') return '';
  let url =
    meta.coverImageUrl ||
    meta.thumbnailUrl ||
    meta.pictureUrl ||
    meta.imageUrl ||
    meta.coverImage ||
    '';
  if (!url) {
    const images = meta.listingImages || meta.images || [];
    if (Array.isArray(images) && images.length) {
      url = images[0]?.url || images[0]?.thumbnailUrl || '';
    }
  }
  return typeof url === 'string' ? url : '';
}

function listingThumbHtml(listing) {
  const url = listingCoverUrl(listing);
  if (url) {
    return `<span class="listing-thumb-frame"><img class="listing-thumb" src="${esc(url)}" alt="" loading="lazy" onerror="listingThumbFallback(this)" /></span>`;
  }
  return listingThumbPlaceholderHtml();
}

/** Compact thumb for Groups page chips / group name cell. */
function groupListingThumbHtml(listing) {
  const url = listingCoverUrl(listing);
  if (url) {
    return `<span class="group-thumb-frame"><img class="group-thumb" src="${esc(url)}" alt="" loading="lazy" onerror="listingThumbFallback(this)" /></span>`;
  }
  return `<span class="group-thumb-frame group-thumb-placeholder" aria-hidden="true">${groupHomeIcon()}</span>`;
}

/** Prefer parent listing cover, else first child with an image, else building icon. */
function groupThumbHtml(group) {
  const listings = Array.isArray(group?.listings) ? group.listings : [];
  const parentId = Number(group?.hostawayParentId);
  const parent =
    Number.isFinite(parentId) && parentId > 0
      ? listings.find((l) => Number(l.hostawayId) === parentId)
      : null;
  const withImage =
    (parent && listingCoverUrl(parent) ? parent : null) ||
    listings.find((l) => listingCoverUrl(l)) ||
    null;
  if (withImage) {
    return `<span class="group-thumb-frame is-group"><img class="group-thumb" src="${esc(listingCoverUrl(withImage))}" alt="" loading="lazy" onerror="listingThumbFallback(this)" /></span>`;
  }
  return `<span class="group-thumb-frame is-group group-thumb-placeholder" aria-hidden="true">${groupBuildingIcon()}</span>`;
}

function isListingsMobile() {
  return window.matchMedia('(max-width: 1023px)').matches;
}

function ensureListingsFilterSheet() {
  let sheet = $('#listings-filter-sheet');
  if (sheet) return sheet;
  sheet = document.createElement('div');
  sheet.id = 'listings-filter-sheet';
  sheet.className = 'listings-filter-sheet hidden';
  sheet.innerHTML = `
    <button type="button" class="listings-filter-sheet-backdrop" aria-label="Close"></button>
    <div class="listings-filter-sheet-panel" role="dialog" aria-modal="true">
      <div class="listings-filter-sheet-handle" aria-hidden="true"></div>
      <div class="listings-filter-sheet-head">
        <h4 class="listings-filter-sheet-title"></h4>
        <button type="button" class="listings-filter-sheet-close" aria-label="Close">&times;</button>
      </div>
      <div class="listings-filter-sheet-options"></div>
    </div>
  `;
  document.body.appendChild(sheet);
  sheet.querySelector('.listings-filter-sheet-backdrop')?.addEventListener('click', closeListingsFilterSheet);
  sheet.querySelector('.listings-filter-sheet-close')?.addEventListener('click', closeListingsFilterSheet);
  return sheet;
}

function closeListingsFilterSheet() {
  const sheet = $('#listings-filter-sheet');
  if (!sheet) return;
  sheet.classList.add('hidden');
  document.body.classList.remove('listings-filter-sheet-open');
}

function openListingsFilterSheet(chip) {
  if (!chip) return;
  const sel = chip.querySelector('select');
  if (!sel) return;
  const sheet = ensureListingsFilterSheet();
  const title = chip.getAttribute('data-empty-label') || sel.getAttribute('aria-label') || 'Filter';
  const titleEl = sheet.querySelector('.listings-filter-sheet-title');
  const optionsEl = sheet.querySelector('.listings-filter-sheet-options');
  if (titleEl) titleEl.textContent = title;
  if (optionsEl) {
    const current = String(sel.value || '');
    optionsEl.innerHTML = [...sel.options]
      .map((opt) => {
        const value = String(opt.value ?? '');
        const label = String(opt.textContent || '').trim() || value || 'All';
        const selected = value === current;
        return `<button type="button" class="listings-filter-sheet-option${selected ? ' is-selected' : ''}" data-value="${esc(value)}">${esc(label)}</button>`;
      })
      .join('');
    optionsEl.querySelectorAll('[data-value]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = btn.getAttribute('data-value') ?? '';
        sel.value = value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        closeListingsFilterSheet();
      });
    });
  }
  sheet.classList.remove('hidden');
  document.body.classList.add('listings-filter-sheet-open');
}

function ensureListingsToolbar() {
  const el = $('#listings-toolbar');
  if (!el) return;
  const s = tableState.listings;
  if (el.dataset.toolbarInit === 'listings-v7') {
    const search = el.querySelector('[data-table-search="listings"]');
    if (search && document.activeElement !== search) search.value = s.search;
    const sort = el.querySelector('[data-listing-sort]');
    if (sort && document.activeElement !== sort) {
      sort.value = `${s.sortBy || 'name'}:${s.sortDir || 'asc'}`;
    }
    refreshListingsFilterOptions();
    syncListingsFilterChips(el);
    return;
  }
  el.dataset.toolbarInit = 'listings-v7';
  const sortValue = `${s.sortBy || 'name'}:${s.sortDir || 'asc'}`;
  const cityLabel = t('listings.city');
  const groupLabel = t('listings.group');
  const statusLabel = t('listings.visibility');
  const bookableLabel = t('listings.bookable');
  const sortLabel = 'Sort';
  el.innerHTML = `
    <div class="listings-toolbar-row">
      <label class="listings-search">
        <span class="sr-only">${t('table.search')}</span>
        <input type="search" data-table-search="listings" value="${esc(s.search)}" placeholder="${esc(t('listings.searchPlaceholder'))}" autocomplete="off" />
        <svg class="listings-search-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      </label>
      <div class="listings-filters">
        <div class="listings-filter-chip" data-empty-label="${esc(cityLabel)}">
          <span class="listings-filter-chip-caption">${esc(cityLabel)}</span>
          <button type="button" class="listings-filter-chip-btn" aria-haspopup="listbox">
            <span class="listings-filter-chip-text">${esc(cityLabel)}</span>
          </button>
          <select data-listing-filter="city" aria-label="${esc(cityLabel)}"></select>
        </div>
        <div class="listings-filter-chip" data-empty-label="${esc(groupLabel)}">
          <span class="listings-filter-chip-caption">${esc(groupLabel)}</span>
          <button type="button" class="listings-filter-chip-btn" aria-haspopup="listbox">
            <span class="listings-filter-chip-text">${esc(groupLabel)}</span>
          </button>
          <select data-listing-filter="groupId" aria-label="${esc(groupLabel)}"></select>
        </div>
        <div class="listings-filter-chip" data-empty-label="${esc(statusLabel)}">
          <span class="listings-filter-chip-caption">${esc(statusLabel)}</span>
          <button type="button" class="listings-filter-chip-btn" aria-haspopup="listbox">
            <span class="listings-filter-chip-text">${esc(statusLabel)}</span>
          </button>
          <select data-listing-filter="status" aria-label="${esc(statusLabel)}">
            <option value="">${t('listings.filterAll')}</option>
            <option value="LIVE">LIVE</option>
            <option value="HIDDEN">HIDDEN</option>
            <option value="DRAFT">DRAFT</option>
            <option value="UNKNOWN">UNKNOWN</option>
          </select>
        </div>
        <div class="listings-filter-chip" data-empty-label="${esc(bookableLabel)}">
          <span class="listings-filter-chip-caption">${esc(bookableLabel)}</span>
          <button type="button" class="listings-filter-chip-btn" aria-haspopup="listbox">
            <span class="listings-filter-chip-text">${esc(bookableLabel)}</span>
          </button>
          <select data-listing-filter="bookable" aria-label="${esc(bookableLabel)}">
            <option value="">${t('listings.filterAll')}</option>
            <option value="yes">${t('common.yes')}</option>
            <option value="no">${t('common.no')}</option>
          </select>
        </div>
        <div class="listings-filter-chip listings-sort-filter" data-empty-label="${esc(sortLabel)}" data-default-value="name:asc">
          <span class="listings-filter-chip-caption">${esc(sortLabel)}</span>
          <button type="button" class="listings-filter-chip-btn" aria-haspopup="listbox">
            <span class="listings-filter-chip-text">${esc(sortLabel)}</span>
          </button>
          <select data-listing-sort aria-label="${esc(sortLabel)}">
            <option value="name:asc">${esc(t('listings.propertyName'))} A-Z</option>
            <option value="name:desc">${esc(t('listings.propertyName'))} Z-A</option>
            <option value="hostawayId:desc">${esc(t('listings.id'))} ↓</option>
            <option value="hostawayId:asc">${esc(t('listings.id'))} ↑</option>
            <option value="city:asc">${esc(t('listings.city'))} A-Z</option>
            <option value="personCapacity:desc">${esc(t('listings.guests'))} ↓</option>
            <option value="status:asc">${esc(t('listings.visibility'))}</option>
          </select>
        </div>
      </div>
    </div>
  `;
  const sortSel = el.querySelector('[data-listing-sort]');
  if (sortSel) sortSel.value = sortValue;
  refreshListingsFilterOptions();
  syncListingsFilterChips(el);
  el.querySelector('[data-table-search="listings"]')?.addEventListener('input', (e) => {
    clearTimeout(searchTimers.listings);
    searchTimers.listings = setTimeout(() => {
      tableState.listings.search = e.target.value;
      tableState.listings.page = 1;
      loadListings();
    }, 300);
  });
  el.querySelectorAll('[data-listing-filter]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const key = sel.dataset.listingFilter;
      tableState.listings[key] = sel.value;
      tableState.listings.page = 1;
      syncListingsFilterChips(el);
      loadListings();
    });
  });
  sortSel?.addEventListener('change', () => {
    const [sortBy, sortDir] = String(sortSel.value || 'name:asc').split(':');
    tableState.listings.sortBy = sortBy || 'name';
    tableState.listings.sortDir = sortDir || 'asc';
    tableState.listings.page = 1;
    syncListingsFilterChips(el);
    loadListings();
  });
  el.querySelectorAll('.listings-filter-chip-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const chip = btn.closest('.listings-filter-chip');
      if (!chip) return;
      if (isListingsMobile()) openListingsFilterSheet(chip);
      else chip.querySelector('select')?.focus();
    });
  });
}

function syncListingsFilterChips(root = document) {
  (root.querySelectorAll?.('.listings-filter-chip') || []).forEach((chip) => {
    const sel = chip.querySelector('select');
    const textEl = chip.querySelector('.listings-filter-chip-text');
    if (!sel || !textEl) return;
    const emptyLabel = chip.getAttribute('data-empty-label') || '';
    const defaultValue = chip.getAttribute('data-default-value');
    const isDefault =
      defaultValue != null ? String(sel.value) === String(defaultValue) : !String(sel.value || '');
    if (isDefault) {
      textEl.textContent = emptyLabel;
      chip.classList.remove('is-active');
      return;
    }
    const opt = sel.selectedOptions && sel.selectedOptions[0];
    textEl.textContent = (opt?.textContent || '').trim() || emptyLabel;
    chip.classList.add('is-active');
  });
}


function refreshListingsFilterOptions() {
  const citySel = document.querySelector('[data-listing-filter="city"]');
  const groupSel = document.querySelector('[data-listing-filter="groupId"]');
  if (citySel) {
    const current = tableState.listings.city || '';
    citySel.innerHTML =
      `<option value="">${t('listings.filterAll')}</option>` +
      listingsFacets.cities
        .map((c) => `<option value="${esc(c)}"${c === current ? ' selected' : ''}>${esc(c)}</option>`)
        .join('');
    citySel.value = current;
  }
  if (groupSel) {
    const current = tableState.listings.groupId || '';
    groupSel.innerHTML =
      `<option value="">${t('listings.filterAll')}</option>` +
      listingsFacets.groups
        .map((g) => `<option value="${esc(g.id)}"${g.id === current ? ' selected' : ''}>${esc(g.name)}</option>`)
        .join('');
    groupSel.value = current;
  }
  const statusSel = document.querySelector('[data-listing-filter="status"]');
  const bookableSel = document.querySelector('[data-listing-filter="bookable"]');
  if (statusSel) statusSel.value = tableState.listings.status || '';
  if (bookableSel) bookableSel.value = tableState.listings.bookable || '';
  syncListingsFilterChips(document.getElementById('listings-toolbar') || document);
}

function parseAliasesInput(raw) {
  return [...new Set(
    raw.split(/[,;\n]+/).map((s) => s.trim()).filter((s) => s.length >= 2),
  )].slice(0, 30);
}

function renderListingAliasChips() {
  const el = $('#listing-aliases-chips');
  if (!el || !editingListingAliases) return;
  const aliases = editingListingAliases.aliases || [];
  if (!aliases.length) {
    el.innerHTML = `<p class="aliases-empty muted">${t('listings.aliasesNoneYet')}</p>`;
    return;
  }
  el.innerHTML = aliases
    .map(
      (alias, index) => `
      <div class="aliases-chip">
        <span class="aliases-chip-text">${esc(alias)}</span>
        <button type="button" class="aliases-chip-remove" data-alias-index="${index}" aria-label="${esc(t('listings.aliasesRemove'))}">&times;</button>
      </div>`,
    )
    .join('');
  el.querySelectorAll('.aliases-chip-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.aliasIndex);
      if (!editingListingAliases || Number.isNaN(idx)) return;
      editingListingAliases.aliases.splice(idx, 1);
      renderListingAliasChips();
    });
  });
}

function addListingAliasFromInput() {
  if (!editingListingAliases || !hasPermission('LISTINGS_EDIT')) return;
  const input = $('#listing-aliases-input');
  const parts = parseAliasesInput(input?.value || '');
  if (!parts.length) return;
  const existing = new Set(
    (editingListingAliases.aliases || []).map((a) => a.toLowerCase()),
  );
  for (const part of parts) {
    if (existing.has(part.toLowerCase())) continue;
    if ((editingListingAliases.aliases || []).length >= 30) break;
    editingListingAliases.aliases.push(part);
    existing.add(part.toLowerCase());
  }
  if (input) input.value = '';
  renderListingAliasChips();
  input?.focus();
}

function openListingAliasesModal(listingId) {
  const listing = cachedListings.find((l) => l.id === listingId);
  if (!listing) return;
  editingListingAliases = {
    id: listing.id,
    name: listing.name,
    hostawayId: listing.hostawayId,
    aliases: [...(listing.aliases || [])],
  };
  $('#listing-aliases-modal-listing').textContent = listing.name;
  $('#listing-aliases-modal-id').textContent = `ID ${listing.hostawayId}`;
  const subEl = $('#listing-aliases-modal-sub');
  if (subEl) {
    const parts = [listing.city, listing.listingGroup?.name].filter(Boolean);
    subEl.textContent = parts.join(' · ');
    subEl.hidden = !parts.length;
  }
  const thumbEl = $('#listing-aliases-modal-thumb');
  if (thumbEl) thumbEl.innerHTML = listingThumbHtml(listing);
  const input = $('#listing-aliases-input');
  if (input) {
    input.value = '';
    input.placeholder = t('listings.aliasesPlaceholder');
  }
  renderListingAliasChips();
  $('#listing-aliases-modal').classList.remove('hidden');
  document.body.classList.add('modal-open');
  setTimeout(() => input?.focus(), 0);
}

function closeListingAliasesModal() {
  editingListingAliases = null;
  $('#listing-aliases-modal').classList.add('hidden');
  document.body.classList.remove('modal-open');
}

$('#listing-aliases-cancel')?.addEventListener('click', closeListingAliasesModal);
$('#listing-aliases-close')?.addEventListener('click', closeListingAliasesModal);
$('#listing-aliases-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'listing-aliases-modal') closeListingAliasesModal();
});
$('#listing-aliases-add')?.addEventListener('click', () => addListingAliasFromInput());
$('#listing-aliases-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addListingAliasFromInput();
  }
});
$('#listing-aliases-save')?.addEventListener('click', async () => {
  if (!editingListingAliases || !hasPermission('LISTINGS_EDIT')) return;
  try {
    const aliases = (editingListingAliases.aliases || [])
      .map((a) => a.trim())
      .filter((a) => a.length >= 2)
      .slice(0, 30);
    await api(`/listings/${editingListingAliases.id}/aliases`, {
      method: 'PATCH',
      body: JSON.stringify({ aliases }),
    });
    notify.success(t('listings.aliasesSaved'));
    closeListingAliasesModal();
    await loadListings();
  } catch (err) {
    notify.error(err.message);
  }
});

async function loadGroups() {
  ensureGroupsToolbar();
  const [data, syncStatus] = await Promise.all([
    api(`/listing-groups?${tableQuery('groups')}`),
    api('/sync/status').catch(() => null),
  ]);
  groupsLastSync = syncStatus?.last || null;
  if (data.facets) {
    groupsFacets = {
      cities: Array.isArray(data.facets.cities) ? data.facets.cities : [],
      modes: Array.isArray(data.facets.modes) ? data.facets.modes : [],
    };
    refreshGroupsFilterOptions();
  }
  if (data.stats) {
    groupsStats = {
      groups: data.stats.groups ?? 0,
      groupedListings: data.stats.groupedListings ?? 0,
      cities: data.stats.cities ?? 0,
    };
  }
  renderGroupsHeaderMeta();
  renderGroupsStats(syncStatus);
  refreshGroupsChipCounts(data.items || []);

  const items = filterGroupsByChip(data.items || []);
  const rows = items.map((g) => {
    const listingCount = g.listings?.length ?? 0;
    const expanded = expandedGroupIds.has(g.id);
    const shortListings = (g.listings || [])
      .map((l) => {
        const label = groupListingDisplayName(l);
        return `<div class="group-listing-chip" title="${esc(l.name)}">
          ${groupListingThumbHtml(l)}
          <span class="group-listing-chip-text">${esc(label)}</span>
        </div>`;
      })
      .join('');
    const synced = groupIsSynced(g);
    return `
      <tr class="group-row${expanded ? ' is-expanded' : ''}" data-group-id="${esc(g.id)}">
        <td class="group-name-cell">
          <span class="group-name-wrap">
            ${groupThumbHtml(g)}
            <span class="group-name">${esc(g.name)}</span>
          </span>
        </td>
        <td>${esc(g.city || '–')}</td>
        <td><span class="group-mode-pill">${esc(g.availabilityMode || '–')}</span></td>
        <td class="group-listings-count">${listingCount}</td>
        <td>
          <span class="group-sync-status ${synced ? 'is-synced' : 'is-pending'}">
            ${synced ? groupCheckIcon() : ''}
            ${synced ? t('groups.synced') : t('groups.pending')}
          </span>
        </td>
        <td class="group-expand-cell">
          <button type="button" class="group-expand-btn" data-group-toggle="${esc(g.id)}" aria-expanded="${expanded ? 'true' : 'false'}" aria-label="${esc(t('groups.toggleListings'))}">
            ${expanded ? groupChevronUp() : groupChevronDown()}
          </button>
        </td>
      </tr>
      <tr class="group-listings-row${expanded ? '' : ' hidden'}" data-group-listings="${esc(g.id)}">
        <td colspan="6">
          <div class="group-listings-panel">
            <div class="group-listings-title">${t('groups.listingsInGroup', { count: listingCount })}</div>
            <div class="group-listings-grid">${shortListings || `<span class="muted">${t('groups.noListings')}</span>`}</div>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  $('#listing-groups-table').innerHTML = `
    <table class="groups-table"><thead><tr>
      ${sortTh('groups', 'name', t('groups.colGroup'))}
      ${sortTh('groups', 'city', t('listings.city'))}
      <th>${t('groups.colMode')}</th>
      <th>${t('groups.colListings')}</th>
      <th>${t('groups.colSync')}</th>
      <th class="group-expand-col"></th>
    </tr></thead><tbody>${rows || `<tr class="table-empty-row"><td class="table-empty-cell" colspan="6">${t('table.infoEmpty')}</td></tr>`}</tbody></table>`;
  renderGroupsMobileList(items);
  bindSortableHeaders('#listing-groups-table', 'groups', loadGroups);
  bindGroupsExpandToggles();
  renderTableInfo('#groups-info', data);
  renderPagination('#groups-pagination', data, 'groups', loadGroups);
applyRoleUi();
  scheduleEnhanceResponsiveTables();
}

function groupIsSynced(group) {
  const listings = group?.listings || [];
  if (!listings.length) return false;
  return listings.some((l) => l.lastSyncedAt);
}

function filterGroupsByChip(items) {
  const chip = tableState.groups.chip || 'all';
  if (chip === 'synced') return items.filter((g) => groupIsSynced(g));
  if (chip === 'withListings') return items.filter((g) => (g.listings?.length ?? 0) > 0);
  return items;
}

function bindGroupsExpandToggles() {
  $$('[data-group-toggle]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.groupToggle;
      if (!id) return;
      if (expandedGroupIds.has(id)) expandedGroupIds.delete(id);
      else expandedGroupIds.add(id);
      loadGroups();
    });
  });
}

function groupChevronRight() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>`;
}

function renderGroupsMobileList(items) {
  const el = $('#groups-mobile-list');
  if (!el) return;
  if (!items.length) {
    el.innerHTML = `<div class="groups-mobile-empty">${t('table.infoEmpty')}</div>`;
    return;
  }
  el.innerHTML = items
    .map((g) => {
      const listingCount = g.listings?.length ?? 0;
      const expanded = expandedGroupIds.has(g.id);
      const synced = groupIsSynced(g);
      const mode = g.availabilityMode || '–';
      const listingsHtml = (g.listings || [])
        .map((l) => {
          const label = groupListingDisplayName(l);
          const listingSynced = !!l.lastSyncedAt;
          return `
            <div class="groups-m-listing">
              ${groupListingThumbHtml(l)}
              <span class="groups-m-listing-meta">
                <span class="groups-m-listing-name">${esc(label)}</span>
                <span class="groups-m-listing-city">${esc(l.city || g.city || '–')}</span>
              </span>
              <span class="group-sync-status ${listingSynced ? 'is-synced' : 'is-pending'}">
                <span class="groups-m-sync-dot" aria-hidden="true"></span>
                ${listingSynced ? t('groups.synced') : t('groups.pending')}
              </span>
            </div>
          `;
        })
        .join('');
      return `
        <article class="groups-m-card${expanded ? ' is-expanded' : ''}" data-group-id="${esc(g.id)}">
          <button type="button" class="groups-m-card-head" data-group-toggle="${esc(g.id)}" aria-expanded="${expanded ? 'true' : 'false'}">
            ${groupThumbHtml(g)}
            <span class="groups-m-card-meta">
              <span class="groups-m-card-title">${esc(g.name)}</span>
              <span class="groups-m-card-city">${esc(g.city || '–')}</span>
              <span class="groups-m-tags">
                <span class="groups-m-tag is-mode">${esc(mode)}</span>
                <span class="groups-m-tag">${t('groups.listingsCountShort', { count: listingCount })}</span>
                <span class="groups-m-tag ${synced ? 'is-synced' : ''}">
                  <span class="groups-m-sync-dot" aria-hidden="true"></span>
                  ${synced ? t('groups.synced') : t('groups.pending')}
                </span>
              </span>
            </span>
            <span class="groups-m-card-chevron" aria-hidden="true">${expanded ? groupChevronUp() : groupChevronDown()}</span>
          </button>
          <div class="groups-m-card-body${expanded ? '' : ' hidden'}">
            <div class="groups-m-body-head">
              <span>${t('groups.listingsInGroupShort', { count: listingCount })}</span>
            </div>
            <div class="groups-m-listings">
              ${listingsHtml || `<div class="groups-mobile-empty muted">${t('groups.noListings')}</div>`}
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

function groupListingDisplayName(listing) {
  const alias = (listing?.aliases || []).find((a) => a && String(a).trim().length >= 2);
  if (alias) return String(alias).trim();
  return shortGroupListingName(listing?.name);
}

function shortGroupListingName(name) {
  if (!name) return '–';
  let cleaned = String(name).trim();
  // Prefer the distinctive short title before long descriptive tails.
  cleaned = cleaned
    .replace(/\s*[·|]\s*.*$/, '')
    .replace(/\s+[-–—]\s+(FeWo|Apartment|Zimmer|Suite|Wohnung).*$/i, '')
    .trim();
  if (cleaned.length > 36) cleaned = `${cleaned.slice(0, 34).trim()}…`;
  return cleaned || String(name).trim();
}

function groupBuildingIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>`;
}
function groupHomeIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
}
function groupCheckIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg>`;
}
function groupChevronDown() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>`;
}
function groupChevronUp() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 15-6-6-6 6"/></svg>`;
}
function groupUsersIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
}
function groupPinIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>`;
}

function renderGroupsHeaderMeta() {
  const el = $('#groups-last-sync');
  if (!el) return;
  const stamp = groupsLastSync?.finishedAt || groupsLastSync?.startedAt;
  if (!stamp) {
    el.innerHTML = `<span class="muted">${t('groups.neverSynced')}</span>`;
    return;
  }
  const ok = groupsLastSync?.status === 'completed';
  el.innerHTML = `
    <span class="groups-last-sync-pill ${ok ? 'is-ok' : 'is-warn'}">
      ${ok ? groupCheckIcon() : ''}
      ${t('groups.lastSync')}: ${formatRelativeAgo(stamp)}
    </span>
  `;
}

function renderGroupsStats(syncStatus) {
  const el = $('#groups-stats');
  if (!el) return;
  const last = syncStatus?.last;
  const inProgress = !!syncStatus?.inProgress;
  const syncOk = !inProgress && last?.status === 'completed';
  const syncLabel = inProgress
    ? t('groups.syncRunning')
    : syncOk
      ? t('groups.syncAllOk')
      : last?.status === 'failed'
        ? t('groups.syncFailed')
        : t('groups.syncIdle');
  const syncHint = inProgress
    ? t('groups.syncRunningHint')
    : syncOk
      ? t('groups.syncAllOkHint')
      : last?.status === 'failed'
        ? t('groups.syncFailedHint')
        : t('groups.syncIdleHint');
  el.innerHTML = `
    <div class="groups-stat-card">
      <div class="groups-stat-icon">${groupUsersIcon()}</div>
      <div>
        <div class="groups-stat-label">${t('groups.statGroups')}</div>
        <div class="groups-stat-value">${formatCount(groupsStats.groups)}</div>
      </div>
    </div>
    <div class="groups-stat-card">
      <div class="groups-stat-icon">${groupBuildingIcon()}</div>
      <div>
        <div class="groups-stat-label">${t('groups.statListingsShort')}</div>
        <div class="groups-stat-value">${formatCount(groupsStats.groupedListings)}</div>
      </div>
    </div>
    <div class="groups-stat-card">
      <div class="groups-stat-icon">${groupPinIcon()}</div>
      <div>
        <div class="groups-stat-label">${t('groups.statCities')}</div>
        <div class="groups-stat-value">${formatCount(groupsStats.cities)}</div>
      </div>
    </div>
    <div class="groups-stat-card groups-stat-sync ${syncOk ? 'is-ok' : inProgress ? 'is-run' : 'is-idle'}">
      <div class="groups-stat-icon">${syncOk ? groupCheckIcon() : groupBuildingIcon()}</div>
      <div>
        <div class="groups-stat-label">${t('groups.statSync')}</div>
        <div class="groups-stat-value groups-stat-sync-text">${esc(syncLabel)}</div>
        <div class="groups-stat-hint">${esc(syncHint)}</div>
      </div>
    </div>
  `;
}

function ensureGroupsToolbar() {
  const el = $('#groups-toolbar');
  if (!el) return;
  const s = tableState.groups;
  if (el.dataset.toolbarInit === 'groups-v4') {
    const search = el.querySelector('[data-table-search="groups"]');
    if (search && document.activeElement !== search) search.value = s.search;
    return;
  }
  el.dataset.toolbarInit = 'groups-v4';
  el.innerHTML = `
    <div class="groups-toolbar-row">
      <label class="groups-search">
        <span class="sr-only">${t('table.search')}</span>
        <input type="search" data-table-search="groups" value="${esc(s.search)}" placeholder="${esc(t('groups.searchPlaceholder'))}" autocomplete="off" />
        <svg class="groups-search-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      </label>
      <div class="groups-filters groups-filters-desktop">
        <label>
          <span>${t('listings.city')}</span>
          <select data-group-filter="city"></select>
        </label>
        <label>
          <span>${t('groups.colMode')}</span>
          <select data-group-filter="mode"></select>
        </label>
      </div>
    </div>
  `;
  refreshGroupsFilterOptions();
  el.querySelector('[data-table-search="groups"]')?.addEventListener('input', (e) => {
    clearTimeout(searchTimers.groups);
    searchTimers.groups = setTimeout(() => {
      tableState.groups.search = e.target.value;
      tableState.groups.page = 1;
      loadGroups();
    }, 300);
  });
  el.querySelectorAll('[data-group-filter]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const key = sel.dataset.groupFilter;
      tableState.groups[key] = sel.value;
      if (key === 'mode') {
        tableState.groups.chip = sel.value || 'all';
      }
      tableState.groups.page = 1;
      loadGroups();
    });
  });
}

function renderGroupsFilterChips() {
  /* Chips removed — mobile uses the same City/Mode filters as desktop. */
}

function refreshGroupsChipCounts() {
  /* no-op: chip UI removed */
}

function refreshGroupsChipActive() {
  /* no-op: chip UI removed */
}


function refreshGroupsFilterOptions() {
  const citySel = document.querySelector('[data-group-filter="city"]');
  const modeSel = document.querySelector('[data-group-filter="mode"]');
  if (citySel) {
    const current = tableState.groups.city || '';
    citySel.innerHTML =
      `<option value="">${t('groups.filterAllCities')}</option>` +
      groupsFacets.cities
        .map((c) => `<option value="${esc(c)}"${c === current ? ' selected' : ''}>${esc(c)}</option>`)
        .join('');
  }
  if (modeSel) {
    const current = tableState.groups.mode || '';
    const modes = groupsFacets.modes.length
      ? groupsFacets.modes
      : ['BOTH', 'PARENT_ONLY', 'CHILDREN_ONLY'];
    modeSel.innerHTML =
      `<option value="">${t('groups.filterAllModes')}</option>` +
      modes
        .map((m) => `<option value="${esc(m)}"${m === current ? ' selected' : ''}>${esc(m)}</option>`)
        .join('');
  }
}

async function loadReservations() {
  await Promise.all([
    loadReservationsStats().catch(() => null),
    ensureReservationsToolbar(),
  ]);
  const data = await api(`/reservations?${tableQuery('reservations')}`);
  cachedReservations = Array.isArray(data.items) ? data.items : [];
  const rows = cachedReservations.map((r) => {
    const paid = reservationPaidAmount(r);
    const total = r.totalPrice;
    const guests = reservationGuestsLabel(r);
    const statusMeta = reservationStatusMeta(r);
    return `
    <tr class="reservation-row" data-hostaway-id="${r.hostawayId}" tabindex="0">
      <td>
        <button type="button" class="reservation-id-btn" data-hostaway-id="${r.hostawayId}">#${r.hostawayId}</button>
      </td>
      <td>
        <div class="reservation-guest-cell">
          <strong>${esc(r.guestName || r.guestNameMasked || '–')}</strong>
          ${guests ? `<span class="muted">${esc(guests)}</span>` : ''}
        </div>
      </td>
      <td>
        <div class="reservation-contact-cell">
          <span>${esc(r.guestEmail ? softMaskEmail(r.guestEmail) : '–')}</span>
          <span class="muted">${esc(r.guestPhone ? softMaskPhone(r.guestPhone) : '–')}</span>
        </div>
      </td>
      <td>${esc(r.listing?.name || '–')}</td>
      <td class="cell-money">
        <div class="reservation-money-stack">
          <span>${esc(formatMoney(total))}</span>
          <span class="reservation-paid-amt">${esc(formatMoney(paid))}</span>
        </div>
      </td>
      <td>${esc(r.listing?.listingGroup?.name || '–')}</td>
      <td>
        <div class="reservation-dates-cell">
          <span>${formatDate(r.arrivalDate)}</span>
          <span class="muted">${formatDate(r.departureDate)}</span>
        </div>
      </td>
      <td><span class="reservation-status-pill ${statusMeta.cls}">${esc(statusMeta.label)}</span></td>
      <td class="reservation-actions-cell">
        <div class="reservation-actions-menu">
          <button type="button" class="btn ghost btn-sm reservation-actions-toggle" aria-expanded="false" data-hostaway-id="${r.hostawayId}" title="${esc(t('listings.actions'))}">⋮</button>
          <div class="reservation-actions-dropdown hidden" role="menu">
            <button type="button" class="reservation-action-item" data-action="open" data-hostaway-id="${r.hostawayId}">${esc(t('reservations.openDetails'))}</button>
            <a class="reservation-action-item" href="${esc(hostawayReservationUrl(r.hostawayId))}" target="_blank" rel="noopener noreferrer">${esc(t('payments.openInHostaway'))}</a>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');

  $('#reservations-table').innerHTML = `
    <table class="reservations-table"><thead><tr>
      ${sortTh('reservations', 'hostawayId', t('reservations.colId'))}
      ${sortTh('reservations', 'guestName', t('listings.guest'))}
      <th data-label="${esc(t('reservations.colContact'))}">${t('reservations.colContact')}</th>
      ${sortTh('reservations', 'listingName', t('reservations.colProperty'))}
      ${sortTh('reservations', 'totalPrice', t('reservations.colTotalPaid'))}
      <th data-label="${esc(t('listings.group'))}">${t('listings.group')}</th>
      ${sortTh('reservations', 'arrivalDate', t('reservations.colStay'))}
      ${sortTh('reservations', 'status', t('listings.status'))}
      <th data-label="${esc(t('listings.actions'))}">${t('listings.actions')}</th>
    </tr></thead><tbody>${rows || `<tr><td colspan="9">${t('table.infoEmpty')}</td></tr>`}</tbody></table>`;
  bindSortableHeaders('#reservations-table', 'reservations', loadReservations);
  bindReservationsTable();
  renderReservationsMobile(cachedReservations);
  renderTableInfo('#reservations-info', data);
  renderPagination('#reservations-pagination', data, 'reservations', loadReservations);
  scheduleEnhanceResponsiveTables();
}

let cachedReservations = [];
let expandedReservationId = null;
let reservationsMobileDetailCache = new Map();

function isReservationsMobile() {
  return window.matchMedia('(max-width: 1023px)').matches;
}

function reservationChipIcon(kind) {
  const icons = {
    date: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    property: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    status: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    payment: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
    channel: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    pin: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    mail: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 7L2 7"/></svg>',
    phone: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.7 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.74.34 1.53.57 2.34.7A2 2 0 0 1 22 16.92z"/></svg>',
    clock: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    chevron: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    more: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>',
  };
  return icons[kind] || '';
}

function reservationGuestCountShort(r) {
  const total = r.numberOfGuests != null ? Number(r.numberOfGuests) : null;
  if (total != null && Number.isFinite(total)) {
    return total === 1 ? t('reservations.guestOne') : t('reservations.guests', { n: total });
  }
  const adults = r.adults != null ? Number(r.adults) : 0;
  const children = r.children != null ? Number(r.children) : 0;
  const sum = (Number.isFinite(adults) ? adults : 0) + (Number.isFinite(children) ? children : 0);
  if (sum > 0) {
    return sum === 1 ? t('reservations.guestOne') : t('reservations.guests', { n: sum });
  }
  return reservationGuestsLabel(r);
}

function closeReservationsFilterSheet() {
  const sheet = $('#reservations-filter-sheet');
  if (!sheet) return;
  sheet.classList.add('hidden');
  sheet.hidden = true;
  document.body.classList.remove('reservations-filter-sheet-open');
}

function openReservationsFilterSheet(kind) {
  const sheet = $('#reservations-filter-sheet');
  const body = $('#reservations-filter-sheet-body');
  const titleEl = $('#reservations-filter-sheet-title');
  const toolbar = $('#reservations-toolbar');
  if (!sheet || !body || !toolbar) return;

  const titles = {
    date: t('reservations.filterDate'),
    groupId: t('reservations.filterProperty'),
    status: t('listings.status'),
    paymentStatus: t('reservations.filterPayment'),
    channel: t('reservations.filterChannel'),
  };
  if (titleEl) titleEl.textContent = titles[kind] || 'Filter';

  if (kind === 'date') {
    const s = tableState.reservations;
    body.innerHTML = `
      <div class="reservations-filter-date-sheet">
        <label>
          <span>${esc(t('reservations.filterDateFrom'))}</span>
          <input type="date" data-sheet-date="dateFrom" value="${esc(s.dateFrom || '')}" />
        </label>
        <label>
          <span>${esc(t('reservations.filterDateTo'))}</span>
          <input type="date" data-sheet-date="dateTo" value="${esc(s.dateTo || '')}" />
        </label>
        <div class="reservations-filter-date-actions">
          <button type="button" class="btn ghost" data-sheet-clear-dates>${esc(t('reservations.filterClearDates'))}</button>
          <button type="button" class="btn primary" data-sheet-apply-dates>${esc(t('reservations.filterApplyDates'))}</button>
        </div>
      </div>`;
    body.querySelector('[data-sheet-clear-dates]')?.addEventListener('click', () => {
      tableState.reservations.dateFrom = '';
      tableState.reservations.dateTo = '';
      tableState.reservations.page = 1;
      tableState.reservations.cancelledRecordedToday = false;
      syncReservationsToolbarControls(toolbar);
      syncReservationsFilterChips(toolbar);
      closeReservationsFilterSheet();
      loadReservations().catch((ex) => notify.error(ex.message));
    });
    body.querySelector('[data-sheet-apply-dates]')?.addEventListener('click', () => {
      const from = body.querySelector('[data-sheet-date="dateFrom"]')?.value || '';
      const to = body.querySelector('[data-sheet-date="dateTo"]')?.value || '';
      tableState.reservations.dateFrom = from;
      tableState.reservations.dateTo = to;
      tableState.reservations.page = 1;
      tableState.reservations.cancelledRecordedToday = false;
      syncReservationsToolbarControls(toolbar);
      syncReservationsFilterChips(toolbar);
      closeReservationsFilterSheet();
      loadReservations().catch((ex) => notify.error(ex.message));
    });
  } else {
    const sel = toolbar.querySelector(`[data-reservation-filter="${kind}"]`);
    if (!sel) return;
    const current = String(sel.value || '');
    body.innerHTML = `<div class="reservations-filter-sheet-options">${[...sel.options]
      .map((opt) => {
        const value = String(opt.value ?? '');
        const label = String(opt.textContent || '').trim() || value || 'All';
        const selected = value === current;
        return `<button type="button" class="reservations-filter-sheet-option${selected ? ' is-selected' : ''}" data-value="${esc(value)}">${esc(label)}</button>`;
      })
      .join('')}</div>`;
    body.querySelectorAll('[data-value]').forEach((btn) => {
      btn.addEventListener('click', () => {
        sel.value = btn.getAttribute('data-value') ?? '';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        closeReservationsFilterSheet();
      });
    });
  }

  sheet.classList.remove('hidden');
  sheet.hidden = false;
  document.body.classList.add('reservations-filter-sheet-open');
}

function syncReservationsFilterChips(root = document) {
  const s = tableState.reservations;
  const toolbar = root.querySelector?.('#reservations-toolbar') || root;
  if (!toolbar?.querySelector) return;
  const setChip = (key, active, text) => {
    const chip = toolbar.querySelector(`[data-reservations-chip="${key}"]`);
    if (!chip) return;
    chip.classList.toggle('is-active', !!active);
    const textEl = chip.querySelector('.reservations-filter-chip-text');
    if (textEl && text) textEl.textContent = text;
  };

  const dateActive = !!(s.dateFrom || s.dateTo);
  let dateText = t('reservations.filterDate');
  if (s.dateFrom && s.dateTo) dateText = `${s.dateFrom} → ${s.dateTo}`;
  else if (s.dateFrom) dateText = `${t('reservations.filterDateFrom')} ${s.dateFrom}`;
  else if (s.dateTo) dateText = `${t('reservations.filterDateTo')} ${s.dateTo}`;
  setChip('date', dateActive, dateText);

  const groupSel = toolbar.querySelector('[data-reservation-filter="groupId"]');
  const groupOpt = groupSel?.selectedOptions?.[0];
  setChip(
    'groupId',
    s.groupId && s.groupId !== 'all',
    groupOpt?.textContent?.trim() || t('reservations.filterProperty'),
  );

  const statusSel = toolbar.querySelector('[data-reservation-filter="status"]');
  const statusOpt = statusSel?.selectedOptions?.[0];
  setChip(
    'status',
    s.status && s.status !== 'all',
    statusOpt?.textContent?.trim() || t('listings.status'),
  );

  const paySel = toolbar.querySelector('[data-reservation-filter="paymentStatus"]');
  const payOpt = paySel?.selectedOptions?.[0];
  setChip(
    'paymentStatus',
    s.paymentStatus && s.paymentStatus !== 'all',
    payOpt?.textContent?.trim() || t('reservations.filterPayment'),
  );

  const channelSel = toolbar.querySelector('[data-reservation-filter="channel"]');
  const channelOpt = channelSel?.selectedOptions?.[0];
  setChip(
    'channel',
    s.channel && s.channel !== 'all',
    channelOpt?.textContent?.trim() || t('reservations.filterChannel'),
  );
}

function renderReservationsMobile(items) {
  const root = $('#reservations-mobile-list');
  if (!root) return;
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    root.innerHTML = `<div class="reservations-m-empty">${esc(t('table.infoEmpty'))}</div>`;
    return;
  }

  root.innerHTML = list
    .map((r) => {
      const statusMeta = reservationStatusMeta(r);
      const progress = reservationPaymentProgress(r);
      const nights = reservationNights(r.arrivalDate, r.departureDate);
      const guests = reservationGuestCountShort(r);
      const guestsDetail = reservationGuestsLabel(r);
      const city = r.listing?.city || r.listing?.listingGroup?.name || '';
      const channel = r.channelName || '–';
      const expanded = Number(expandedReservationId) === Number(r.hostawayId);
      const detail = reservationsMobileDetailCache.get(Number(r.hostawayId));
      const email = r.guestEmail ? softMaskEmail(r.guestEmail) : '–';
      const phone = r.guestPhone ? softMaskPhone(r.guestPhone) : '–';
      const activity = Array.isArray(detail?.activity) ? detail.activity.slice(0, 1) : [];
      const barCls = progress.pct >= 100 ? 'is-ok' : progress.pct > 0 ? 'is-partial' : 'is-due';

      return `
      <article class="reservations-m-card${expanded ? ' is-expanded' : ''}" data-hostaway-id="${esc(String(r.hostawayId))}">
        <div class="reservations-m-card-summary">
          <div class="reservations-m-card-top">
            <div class="reservations-m-id-row">
              <button type="button" class="reservations-m-id" data-open-reservation="${esc(String(r.hostawayId))}">#${esc(String(r.hostawayId))}</button>
              <span class="reservation-status-pill ${statusMeta.cls}">${esc(statusMeta.label)}</span>
            </div>
            <div class="reservations-m-top-actions">
              <div class="reservation-actions-menu">
                <button type="button" class="reservations-m-more reservation-actions-toggle" aria-expanded="false" data-hostaway-id="${esc(String(r.hostawayId))}" title="${esc(t('listings.actions'))}">${reservationChipIcon('more')}</button>
                <div class="reservation-actions-dropdown hidden" role="menu">
                  <button type="button" class="reservation-action-item" data-action="open" data-hostaway-id="${esc(String(r.hostawayId))}">${esc(t('reservations.openDetails'))}</button>
                  <a class="reservation-action-item" href="${esc(hostawayReservationUrl(r.hostawayId))}" target="_blank" rel="noopener noreferrer">${esc(t('payments.openInHostaway'))}</a>
                </div>
              </div>
              <button type="button" class="reservations-m-expand" data-expand-reservation="${esc(String(r.hostawayId))}" aria-expanded="${expanded ? 'true' : 'false'}" aria-label="${esc(expanded ? t('reservations.collapseCard') : t('reservations.expandCard'))}">${reservationChipIcon('chevron')}</button>
            </div>
          </div>
          <div class="reservations-m-guest-row">
            <div class="reservations-m-guest">
              <strong>${esc(r.guestName || r.guestNameMasked || '–')}</strong>
              ${guests ? `<span class="muted">${esc(guests)}</span>` : ''}
            </div>
            <div class="reservations-m-dates">
              <span>${esc(formatReservationLongDate(r.arrivalDate))} → ${esc(formatReservationLongDate(r.departureDate))}</span>
              ${nights != null ? `<span class="muted">${esc(t('reservations.nights', { n: nights }))}</span>` : ''}
            </div>
          </div>
          <div class="reservations-m-property-row">
            ${listingThumbHtml(r.listing || {})}
            <div class="reservations-m-property-meta">
              <div class="reservations-m-property-name">${esc(r.listing?.name || '–')}</div>
              <div class="reservations-m-property-sub">
                ${city ? `<span>${reservationChipIcon('pin')}${esc(city)}</span>` : ''}
                <span>${esc(channel)}</span>
              </div>
            </div>
            <div class="reservations-m-money">
              <strong>${esc(formatMoney(progress.total ?? r.totalPrice))}</strong>
              <span class="muted">${esc(t('reservations.paidLabel', { amount: formatMoney(progress.paid) }))}</span>
              <div class="reservations-m-progress ${barCls}" aria-hidden="true"><span style="width:${progress.pct}%"></span></div>
              <span class="reservations-m-pct">${progress.pct}%</span>
            </div>
          </div>
        </div>
        <div class="reservations-m-card-details"${expanded ? '' : ' hidden'}>
          <section class="reservations-m-detail-section">
            <h4>${esc(t('reservations.guestContact'))}</h4>
            <div class="reservations-m-detail-line">${reservationChipIcon('mail')}<span>${esc(email)}</span></div>
            <div class="reservations-m-detail-line">${reservationChipIcon('phone')}<span>${esc(phone)}</span></div>
          </section>
          <section class="reservations-m-detail-section">
            <h4>${esc(t('reservations.stayDetails'))}</h4>
            <div class="reservations-m-detail-line">${reservationChipIcon('date')}<span>${esc(formatReservationLongDate(r.arrivalDate))} → ${esc(formatReservationLongDate(r.departureDate))}${nights != null ? ` · ${esc(t('reservations.nights', { n: nights }))}` : ''}</span></div>
            ${guestsDetail ? `<div class="reservations-m-detail-line muted">${esc(guestsDetail)}</div>` : ''}
          </section>
          <section class="reservations-m-detail-section">
            <h4>${esc(t('reservations.sectionProperty'))}</h4>
            <div class="reservations-m-detail-line">${reservationChipIcon('property')}<span>${esc(r.listing?.name || '–')}</span></div>
            ${city ? `<div class="reservations-m-detail-line">${reservationChipIcon('pin')}<span>${esc(city)}</span></div>` : ''}
            <div class="reservations-m-detail-line">${reservationChipIcon('channel')}<span>${esc(channel)}</span></div>
          </section>
          <section class="reservations-m-detail-section">
            <h4>${esc(t('reservations.sectionPayment'))}</h4>
            <div class="reservations-m-detail-payment">
              <span>${esc(formatMoney(progress.total ?? r.totalPrice))} ${esc(t('reservations.totalSuffix'))}</span>
              <span>${esc(formatMoney(progress.paid))} ${esc(t('reservations.paymentPaid').toLowerCase())}</span>
              <span class="reservations-m-pay-status ${barCls}">${progress.pct >= 100 ? reservationDrawerIcon('check') : ''}${esc(progress.label)}</span>
            </div>
          </section>
          <section class="reservations-m-detail-section">
            <h4>${esc(t('reservations.recentActivity'))}</h4>
            ${
              activity.length
                ? activity
                    .map(
                      (ev) => `<div class="reservations-m-activity-line">${reservationChipIcon('clock')}<div><div class="muted">${esc(formatDateTime(ev.at))}</div><div>${esc(ev.title || '')}</div></div></div>`,
                    )
                    .join('')
                : `<div class="muted reservations-m-activity-loading">${esc(detail ? t('reservations.activityEmpty') : '…')}</div>`
            }
            <button type="button" class="reservations-m-view-all" data-open-reservation="${esc(String(r.hostawayId))}">${esc(t('reservations.viewAllActivity'))} →</button>
          </section>
        </div>
      </article>`;
    })
    .join('');

  bindReservationsMobileList(root);
}

async function toggleReservationMobileExpand(hostawayId) {
  const id = Number(hostawayId);
  if (!Number.isFinite(id)) return;
  if (Number(expandedReservationId) === id) {
    expandedReservationId = null;
    renderReservationsMobile(cachedReservations);
    return;
  }
  expandedReservationId = id;
  renderReservationsMobile(cachedReservations);
  if (!reservationsMobileDetailCache.has(id)) {
    try {
      const detail = await api(`/reservations/${id}`);
      reservationsMobileDetailCache.set(id, detail);
      if (Number(expandedReservationId) === id) {
        renderReservationsMobile(cachedReservations);
      }
    } catch {
      /* keep summary expand */
    }
  }
}

function bindReservationsMobileList(root) {
  root.querySelectorAll('[data-expand-reservation]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleReservationMobileExpand(btn.getAttribute('data-expand-reservation'));
    });
  });
  root.querySelectorAll('[data-open-reservation]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openReservationDrawer(Number(btn.getAttribute('data-open-reservation')));
    });
  });
  root.querySelectorAll('.reservations-m-card-summary').forEach((summary) => {
    summary.addEventListener('click', (e) => {
      if (e.target.closest('.reservation-actions-menu, [data-open-reservation], [data-expand-reservation]')) return;
      const card = summary.closest('[data-hostaway-id]');
      const id = card?.getAttribute('data-hostaway-id');
      if (id) toggleReservationMobileExpand(id);
    });
  });
  root.querySelectorAll('.reservation-actions-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.closest('.reservation-actions-menu');
      const drop = menu?.querySelector('.reservation-actions-dropdown');
      const open = drop && !drop.classList.contains('hidden');
      $$('.reservation-actions-dropdown').forEach((d) => d.classList.add('hidden'));
      $$('.reservation-actions-toggle').forEach((b) => b.setAttribute('aria-expanded', 'false'));
      if (!open && drop) {
        drop.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });
  root.querySelectorAll('.reservation-action-item[data-action="open"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openReservationDrawer(Number(btn.dataset.hostawayId));
    });
  });
}

let reservationsFacets = { groups: [], channels: [] };

async function loadReservationsStats() {
  const el = $('#reservations-stats');
  if (!el) return;
  const stats = await api('/reservations/stats');
  el.innerHTML = `
    <div class="reservations-stat-card">
      <div class="reservations-stat-icon is-total">${reservationStatIcon('total')}</div>
      <div>
        <div class="reservations-stat-label">${t('reservations.statTotal')}</div>
        <div class="reservations-stat-value">${formatCount(stats.total)}</div>
        <div class="reservations-stat-hint">${t('reservations.statTotalHint')}</div>
      </div>
    </div>
    <div class="reservations-stat-card">
      <div class="reservations-stat-icon is-arrive">${reservationStatIcon('arrive')}</div>
      <div>
        <div class="reservations-stat-label">${t('reservations.statArriving')}</div>
        <div class="reservations-stat-value">${formatCount(stats.arrivingSoon)}</div>
        <div class="reservations-stat-hint">${t('reservations.statArrivingHint')}</div>
      </div>
    </div>
    <div class="reservations-stat-card">
      <div class="reservations-stat-icon is-due">${reservationStatIcon('due')}</div>
      <div>
        <div class="reservations-stat-label">${t('reservations.statPaymentDue')}</div>
        <div class="reservations-stat-value">${formatCount(stats.paymentDue)}</div>
        <div class="reservations-stat-hint">${t('reservations.statPaymentDueHint')}</div>
      </div>
    </div>
    <div class="reservations-stat-card is-clickable" data-reservations-stat="cancelled-today" role="button" tabindex="0" title="${esc(t('reservations.statCancelledHint'))}">
      <div class="reservations-stat-icon is-cancel">${reservationStatIcon('cancel')}</div>
      <div>
        <div class="reservations-stat-label">${t('reservations.statCancelled')}</div>
        <div class="reservations-stat-value">${formatCount(stats.cancelledToday)}</div>
        <div class="reservations-stat-hint">${t('reservations.statCancelledHint')}</div>
      </div>
    </div>`;
  el.querySelectorAll('[data-reservations-stat="cancelled-today"]').forEach((card) => {
    const apply = () => applyReservationsCancelledRecordedTodayFilter();
    card.addEventListener('click', apply);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        apply();
      }
    });
  });
}

function applyReservationsCancelledRecordedTodayFilter() {
  Object.assign(tableState.reservations, {
    page: 1,
    search: '',
    status: 'all',
    paymentStatus: 'all',
    channel: 'all',
    groupId: 'all',
    dateFrom: '',
    dateTo: '',
    cancelledRecordedToday: true,
  });
  const toolbar = $('#reservations-toolbar');
  if (toolbar) {
    // Force rebuild so the active-filter note appears
    delete toolbar.dataset.toolbarInit;
  }
  ensureReservationsToolbar()
    .then(() => loadReservations())
    .catch((ex) => notify.error(ex.message));
}

function reservationStatIcon(kind) {
  const icons = {
    total: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    arrive: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>',
    due: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
    cancel: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
  };
  return icons[kind] || icons.total;
}

async function ensureReservationsToolbar() {
  const el = $('#reservations-toolbar');
  if (!el) return;
  const s = tableState.reservations;
  if (!reservationsFacets.groups.length || !reservationsFacets.channels?.length) {
    try {
      const facets = await api('/reservations/facets');
      reservationsFacets.groups = (facets.groups || []).map((g) => ({
        id: g.id,
        name: g.name,
      }));
      reservationsFacets.channels = facets.channels || [];
    } catch {
      // Fallback if facets unavailable — keep whatever we already have.
      if (!reservationsFacets.groups.length) {
        try {
          const groups = await api('/listing-groups?page=1&pageSize=200&sortBy=name&sortDir=asc');
          reservationsFacets.groups = (groups.items || []).map((g) => ({
            id: g.id,
            name: g.name,
          }));
        } catch {
          reservationsFacets.groups = [];
        }
      }
    }
  }

  if (el.dataset.toolbarInit === 'reservations-v8') {
    const search = el.querySelector('[data-table-search="reservations"]');
    if (search && document.activeElement !== search) search.value = s.search;
    syncReservationsToolbarControls(el);
    syncReservationsFilterChips(el);
    const note = el.querySelector('[data-cancelled-today-note]');
    if (note) note.hidden = !s.cancelledRecordedToday;
    return;
  }
  el.dataset.toolbarInit = 'reservations-v8';
  const groupOpts = [
    `<option value="all">${esc(t('reservations.filterAllGroups'))}</option>`,
    ...reservationsFacets.groups.map(
      (g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`,
    ),
  ].join('');
  const channelOpts = [
    `<option value="all">${esc(t('reservations.filterAllChannels'))}</option>`,
    ...(reservationsFacets.channels || []).map(
      (c) => `<option value="${esc(c)}">${esc(c)}</option>`,
    ),
  ].join('');
  el.innerHTML = `
    <div class="reservations-toolbar-row">
      <label class="reservations-search">
        <span class="sr-only">${t('table.search')}</span>
        <input type="search" data-table-search="reservations" value="${esc(s.search)}" placeholder="${esc(t('reservations.searchPlaceholder'))}" autocomplete="off" />
        <svg class="reservations-search-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      </label>
      <div class="reservations-filters">
        <label class="reservations-filter-desktop">
          <span>${t('reservations.filterDateFrom')}</span>
          <span class="reservations-date-field">
            <input type="date" data-reservation-filter="dateFrom" value="${esc(s.dateFrom || '')}" />
            <button type="button" class="reservations-date-picker-btn" data-date-picker-for="dateFrom" aria-label="${esc(t('reservations.openDatePicker'))}">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            </button>
          </span>
        </label>
        <label class="reservations-filter-desktop">
          <span>${t('reservations.filterDateTo')}</span>
          <span class="reservations-date-field">
            <input type="date" data-reservation-filter="dateTo" value="${esc(s.dateTo || '')}" />
            <button type="button" class="reservations-date-picker-btn" data-date-picker-for="dateTo" aria-label="${esc(t('reservations.openDatePicker'))}">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            </button>
          </span>
        </label>
        <label class="reservations-filter-desktop">
          <span>${t('listings.group')}</span>
          <select data-reservation-filter="groupId">${groupOpts}</select>
        </label>
        <label class="reservations-filter-desktop">
          <span>${t('listings.status')}</span>
          <select data-reservation-filter="status">
            <option value="all">${esc(t('reservations.filterAllStatuses'))}</option>
            <option value="new">${esc(t('reservations.statusNew'))}</option>
            <option value="modified">${esc(t('reservations.statusModified'))}</option>
            <option value="confirmed">${esc(t('reservations.statusConfirmed'))}</option>
            <option value="payment_due">${esc(t('reservations.statusPaymentDue'))}</option>
            <option value="cancelled">${esc(t('reservations.statusCancelled'))}</option>
            <option value="inquiry">${esc(t('reservations.statusInquiry'))}</option>
          </select>
        </label>
        <label class="reservations-filter-desktop">
          <span>${t('reservations.filterPayment')}</span>
          <select data-reservation-filter="paymentStatus">
            <option value="all">${esc(t('reservations.filterAllPayment'))}</option>
            <option value="paid">${esc(t('reservations.paymentPaid'))}</option>
            <option value="partial">${esc(t('reservations.paymentPartial'))}</option>
            <option value="due">${esc(t('reservations.paymentDue'))}</option>
          </select>
        </label>
        <label class="reservations-filter-desktop">
          <span>${t('reservations.filterChannel')}</span>
          <select data-reservation-filter="channel">${channelOpts}</select>
        </label>
      </div>
      <div class="reservations-mobile-chips" aria-label="Filters">
        <button type="button" class="reservations-filter-chip" data-reservations-chip="date">
          ${reservationChipIcon('date')}
          <span class="reservations-filter-chip-text">${esc(t('reservations.filterDate'))}</span>
          ${reservationChipIcon('chevron')}
        </button>
        <button type="button" class="reservations-filter-chip" data-reservations-chip="groupId">
          ${reservationChipIcon('property')}
          <span class="reservations-filter-chip-text">${esc(t('reservations.filterProperty'))}</span>
          ${reservationChipIcon('chevron')}
        </button>
        <button type="button" class="reservations-filter-chip" data-reservations-chip="status">
          ${reservationChipIcon('status')}
          <span class="reservations-filter-chip-text">${esc(t('listings.status'))}</span>
          ${reservationChipIcon('chevron')}
        </button>
        <button type="button" class="reservations-filter-chip" data-reservations-chip="paymentStatus">
          ${reservationChipIcon('payment')}
          <span class="reservations-filter-chip-text">${esc(t('reservations.filterPayment'))}</span>
          ${reservationChipIcon('chevron')}
        </button>
        <button type="button" class="reservations-filter-chip" data-reservations-chip="channel">
          ${reservationChipIcon('channel')}
          <span class="reservations-filter-chip-text">${esc(t('reservations.filterChannel'))}</span>
          ${reservationChipIcon('chevron')}
        </button>
      </div>
    </div>
    <div class="reservations-filter-note" data-cancelled-today-note ${s.cancelledRecordedToday ? '' : 'hidden'}>
      ${esc(t('reservations.filterCancelledTodayNote'))}
      <button type="button" class="btn link" data-clear-cancelled-today>${esc(t('reservations.clearSpecialFilter'))}</button>
    </div>`;
  syncReservationsToolbarControls(el);
  syncReservationsFilterChips(el);

  const searchInput = el.querySelector('[data-table-search="reservations"]');
  searchInput?.addEventListener('input', () => {
    clearTimeout(searchTimers.reservations);
    searchTimers.reservations = setTimeout(() => {
      tableState.reservations.search = searchInput.value;
      tableState.reservations.page = 1;
      tableState.reservations.cancelledRecordedToday = false;
      const note = el.querySelector('[data-cancelled-today-note]');
      if (note) note.hidden = true;
      loadReservations().catch((ex) => notify.error(ex.message));
    }, 300);
  });
  el.querySelectorAll('[data-reservation-filter]').forEach((control) => {
    const apply = () => {
      const key = control.getAttribute('data-reservation-filter');
      tableState.reservations[key] = control.value;
      tableState.reservations.page = 1;
      tableState.reservations.cancelledRecordedToday = false;
      const note = el.querySelector('[data-cancelled-today-note]');
      if (note) note.hidden = true;
      syncReservationsFilterChips(el);
      loadReservations().catch((ex) => notify.error(ex.message));
    };
    control.addEventListener('change', apply);
    if (control.matches('input[type="date"]')) {
      control.addEventListener('input', apply);
    }
  });
  el.querySelectorAll('[data-reservations-chip]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openReservationsFilterSheet(btn.getAttribute('data-reservations-chip'));
    });
  });
  el.querySelector('[data-clear-cancelled-today]')?.addEventListener('click', () => {
    tableState.reservations.cancelledRecordedToday = false;
    tableState.reservations.page = 1;
    const note = el.querySelector('[data-cancelled-today-note]');
    if (note) note.hidden = true;
    loadReservations().catch((ex) => notify.error(ex.message));
  });
  el.querySelectorAll('[data-date-picker-for]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = btn.getAttribute('data-date-picker-for');
      const input = el.querySelector(`[data-reservation-filter="${key}"]`);
      if (!input) return;
      try {
        if (typeof input.showPicker === 'function') {
          input.showPicker();
        } else {
          input.focus();
          input.click();
        }
      } catch {
        input.focus();
      }
    });
  });
}


function syncReservationsToolbarControls(el) {
  const s = tableState.reservations;
  el.querySelectorAll('[data-reservation-filter]').forEach((control) => {
    const key = control.getAttribute('data-reservation-filter');
    if (document.activeElement === control) return;
    control.value = s[key] ?? (control.tagName === 'SELECT' ? 'all' : '');
  });
}

function reservationGuestsLabel(r) {
  const adults = r.adults != null ? Number(r.adults) : null;
  const children = r.children != null ? Number(r.children) : null;
  const total = r.numberOfGuests != null ? Number(r.numberOfGuests) : null;
  if (adults != null || children != null) {
    const parts = [];
    if (adults != null) {
      parts.push(
        adults === 1
          ? t('reservations.adultOne')
          : t('reservations.adults', { n: adults }),
      );
    }
    if (children != null && children > 0) {
      parts.push(
        children === 1
          ? t('reservations.childOne')
          : t('reservations.children', { n: children }),
      );
    }
    return parts.join(' · ');
  }
  if (total != null && Number.isFinite(total)) {
    return total === 1
      ? t('reservations.guestOne')
      : t('reservations.guests', { n: total });
  }
  return '';
}

function reservationStatusMeta(r) {
  const raw = String(r.status || '').toLowerCase();
  const paid = reservationPaidAmount(r);
  const total = Number(r.totalPrice);
  const outstanding =
    r.isPaid === true
      ? false
      : Number.isFinite(total) && total > 0
        ? (paid ?? 0) + 0.5 < total
        : r.isPaid === false;

  if (raw.includes('cancel') || raw === 'declined' || raw === 'expired') {
    return { key: 'cancelled', cls: 'is-cancel', label: t('reservations.statusCancelled') };
  }
  if (raw.startsWith('inquiry')) {
    return { key: 'inquiry', cls: 'is-inquiry', label: t('reservations.statusInquiry') };
  }
  if (outstanding && !raw.includes('owner')) {
    return { key: 'payment_due', cls: 'is-due', label: t('reservations.statusPaymentDue') };
  }
  if (raw === 'modified') {
    return { key: 'modified', cls: 'is-modified', label: t('reservations.statusModified') };
  }
  if (raw.includes('owner')) {
    return { key: 'owner', cls: 'is-owner', label: t('reservations.statusOwner') };
  }
  if (raw === 'new') {
    return { key: 'new', cls: 'is-ok', label: t('reservations.statusNew') };
  }
  if (raw === 'confirmed') {
    return { key: 'confirmed', cls: 'is-ok', label: t('reservations.statusConfirmed') };
  }
  if (raw.includes('check') && raw.includes('in')) {
    return { key: 'checked_in', cls: 'is-checked-in', label: t('reservations.statusCheckedIn') };
  }
  return {
    key: raw || 'unknown',
    cls: 'is-muted',
    label: r.status || '–',
  };
}

function reservationPaymentProgress(r) {
  const total = Number(r.totalPrice);
  const paid = reservationPaidAmount(r) ?? 0;
  if (!Number.isFinite(total) || total <= 0) {
    return {
      pct: r.isPaid ? 100 : 0,
      label: r.isPaid ? t('reservations.paidInFull') : t('reservations.paymentUnknown'),
      paid,
      total: null,
    };
  }
  const pct = Math.max(0, Math.min(100, Math.round((paid / total) * 100)));
  const label =
    r.isPaid || paid + 0.5 >= total
      ? t('reservations.paidInFull')
      : paid > 0
        ? t('reservations.partiallyPaid')
        : t('reservations.paymentDue');
  return { pct, label, paid, total };
}

function bindReservationsTable() {
  $$('#reservations-table .reservation-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.reservation-actions-menu a, .reservation-actions-menu button, .reservation-action-item')) {
        return;
      }
      const id = Number(row.dataset.hostawayId);
      if (id) openReservationDrawer(id);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const id = Number(row.dataset.hostawayId);
        if (id) openReservationDrawer(id);
      }
    });
  });
  $$('#reservations-table .reservation-id-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openReservationDrawer(Number(btn.dataset.hostawayId));
    });
  });
  $$('#reservations-table .reservation-actions-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.closest('.reservation-actions-menu');
      const drop = menu?.querySelector('.reservation-actions-dropdown');
      const open = drop && !drop.classList.contains('hidden');
      $$('#reservations-table .reservation-actions-dropdown').forEach((d) => d.classList.add('hidden'));
      $$('#reservations-table .reservation-actions-toggle').forEach((b) => b.setAttribute('aria-expanded', 'false'));
      if (!open && drop) {
        drop.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });
  $$('#reservations-table .reservation-action-item[data-action="open"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openReservationDrawer(Number(btn.dataset.hostawayId));
    });
  });
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.reservation-actions-menu')) {
    $$('.reservation-actions-dropdown').forEach((d) => d.classList.add('hidden'));
    $$('.reservation-actions-toggle').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }
});

let reservationDrawerTab = 'details';
let reservationDrawerData = null;

async function openReservationDrawer(hostawayId) {
  const drawer = $('#reservation-drawer');
  if (!drawer || !Number.isFinite(hostawayId)) return;
  drawer.classList.remove('hidden');
  drawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('reservation-drawer-open');
  $('#reservation-drawer-title').textContent = `R-${hostawayId}`;
  $('#reservation-drawer-body').innerHTML = `<p class="muted">${esc(t('common.loading') !== 'common.loading' ? t('common.loading') : 'Loading…')}</p>`;
  try {
    reservationDrawerData = await api(`/reservations/${hostawayId}`);
    reservationDrawerTab = 'details';
    renderReservationDrawer();
  } catch (ex) {
    $('#reservation-drawer-body').innerHTML = `<p class="error">${esc(ex.message)}</p>`;
  }
}

function closeReservationDrawer() {
  const drawer = $('#reservation-drawer');
  if (!drawer) return;
  drawer.classList.add('hidden');
  drawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('reservation-drawer-open');
  reservationDrawerData = null;
}

function renderReservationDrawer() {
  const r = reservationDrawerData;
  if (!r) return;
  const statusMeta = reservationStatusMeta(r);
  const statusEl = $('#reservation-drawer-status');
  if (statusEl) {
    statusEl.className = `reservation-status-pill ${statusMeta.cls}`;
    statusEl.textContent = statusMeta.label;
  }
  const noteCount = Number(r.noteCount) || [r.hostNote, r.guestNote, r.comment].filter((n) => n?.trim()).length;
  const countEl = $('#reservation-drawer-notes-count');
  if (countEl) countEl.textContent = String(noteCount);

  $$('[data-reservation-drawer-tab]').forEach((btn) => {
    const active = btn.dataset.reservationDrawerTab === reservationDrawerTab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const body = $('#reservation-drawer-body');
  if (!body) return;
  if (reservationDrawerTab === 'notes') {
    body.innerHTML = renderReservationNotes(r);
    return;
  }
  body.innerHTML = renderReservationDetails(r);
  body.querySelector('[data-view-payments]')?.addEventListener('click', () => {
    const id = r.hostawayId;
    closeReservationDrawer();
    activateTab('payments');
    activatePaymentsView('history');
    tableState.paymentsHistory.search = String(id);
    tableState.paymentsHistory.page = 1;
    loadPayments().catch((ex) => notify.error(ex.message));
  });
  body.querySelector('[data-reveal-contact]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) {
      notify.error(t('perms.featureLocked'));
      return;
    }
    const box = btn.closest('.reservation-drawer-section');
    box?.querySelectorAll('[data-contact-field]').forEach((el) => {
      el.textContent = el.getAttribute('data-full') || el.textContent;
    });
    btn.remove();
  });
  body.querySelector('[data-view-listing]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const name = btn.getAttribute('data-listing-name') || '';
    const id = btn.getAttribute('data-view-listing') || '';
    closeReservationDrawer();
    activateTab('listings');
    tableState.listings.search = name || id;
    tableState.listings.page = 1;
    loadListings().catch((ex) => notify.error(ex.message));
  });
}

function renderReservationDetails(r) {
  const guests = reservationGuestsLabel(r);
  const progress = reservationPaymentProgress(r);
  const nights = reservationNights(r.arrivalDate, r.departureDate);
  const canPii = hasPermission('RESERVATIONS_VIEW_PII') || adminRole === 'SUPER_ADMIN';
  const emailRaw = r.guestEmail || '';
  const phoneRaw = r.guestPhone || '';
  const emailShown = emailRaw ? (canPii ? softMaskEmail(emailRaw) : emailRaw) : '–';
  const phoneShown = phoneRaw ? (canPii ? softMaskPhone(phoneRaw) : phoneRaw) : '–';
  const activity = Array.isArray(r.activity) ? r.activity : [];
  const activityPreview = activity.slice(0, 5);
  const paidOn = reservationLastPaidAt(r);
  const listingId = r.listing?.hostawayId || r.listing?.id;

  return `
    <section class="reservation-drawer-section">
      <div class="reservation-section-head">
        <span class="reservation-section-icon" aria-hidden="true">${reservationDrawerIcon('guest')}</span>
        <h4>${esc(t('reservations.sectionGuest'))}</h4>
      </div>
      <div class="reservation-drawer-row">
        <div class="reservation-drawer-kv">
          <strong>${esc(r.guestName || r.guestNameMasked || '–')}</strong>
          ${guests ? `<span class="muted">${esc(guests)}</span>` : ''}
        </div>
      </div>
    </section>
    <section class="reservation-drawer-section">
      <div class="reservation-section-head">
        <span class="reservation-section-icon" aria-hidden="true">${reservationDrawerIcon('stay')}</span>
        <h4>${esc(t('reservations.sectionStay'))}</h4>
      </div>
      <div class="reservation-drawer-row">
        <div class="reservation-stay-range">
          <div>
            <div class="reservation-stay-date">${esc(formatReservationLongDate(r.arrivalDate))}</div>
          </div>
          <span class="reservation-stay-arrow" aria-hidden="true">→</span>
          <div>
            <div class="reservation-stay-date">${esc(formatReservationLongDate(r.departureDate))}</div>
          </div>
        </div>
        ${nights != null ? `<span class="reservation-nights-badge">${esc(t('reservations.nights', { n: nights }))}</span>` : ''}
      </div>
    </section>
    <section class="reservation-drawer-section">
      <div class="reservation-section-head">
        <span class="reservation-section-icon" aria-hidden="true">${reservationDrawerIcon('payment')}</span>
        <h4>${esc(t('reservations.sectionPayment'))}</h4>
      </div>
      <div class="reservation-payment-block">
        <div class="reservation-payment-total">${esc(formatMoney(progress.total ?? r.totalPrice))} <span class="muted">${esc(t('reservations.totalSuffix'))}</span></div>
        <div class="reservation-payment-status ${progress.pct >= 100 ? 'is-ok' : 'is-due'}">${esc(progress.label)}</div>
        <div class="reservation-progress" aria-hidden="true"><span style="width:${progress.pct}%"></span></div>
        <div class="reservation-payment-footer">
          <span class="reservation-paid-meta">
            ${progress.pct >= 100 ? reservationDrawerIcon('check') : ''}
            ${paidOn
              ? esc(t('reservations.paidOn', { date: formatReservationLongDate(paidOn) }))
              : esc(t('reservations.paidOfTotal', { paid: formatMoney(progress.paid), total: formatMoney(progress.total ?? r.totalPrice) }))}
          </span>
          <button type="button" class="btn reservation-drawer-btn" data-view-payments>${esc(t('reservations.viewPayments'))}</button>
        </div>
      </div>
    </section>
    <section class="reservation-drawer-section">
      <div class="reservation-section-head">
        <span class="reservation-section-icon" aria-hidden="true">${reservationDrawerIcon('contact')}</span>
        <h4>${esc(t('reservations.sectionContact'))}</h4>
        ${emailRaw || phoneRaw
          ? `<button type="button" class="btn reservation-drawer-btn" data-reveal-contact ${canPii ? '' : 'disabled'}>${esc(t('reservations.reveal'))}</button>`
          : ''}
      </div>
      <div class="reservation-drawer-kv">
        <span data-contact-field="email" data-full="${esc(emailRaw || '–')}">${esc(emailShown)}</span>
        <span data-contact-field="phone" data-full="${esc(phoneRaw || '–')}">${esc(phoneShown)}</span>
      </div>
      <div class="reservation-contact-secure">
        ${reservationDrawerIcon('lock')}
        <span>${esc(t('reservations.contactSecureHint'))}</span>
      </div>
    </section>
    <section class="reservation-drawer-section">
      <div class="reservation-section-head">
        <span class="reservation-section-icon" aria-hidden="true">${reservationDrawerIcon('property')}</span>
        <h4>${esc(t('reservations.sectionProperty'))}</h4>
        ${listingId
          ? `<button type="button" class="btn reservation-drawer-btn" data-view-listing="${esc(String(listingId))}" data-listing-name="${esc(r.listing?.name || '')}">${esc(t('reservations.viewListing'))}</button>`
          : ''}
      </div>
      <div class="reservation-drawer-kv">
        <span>${esc(r.listing?.name || '–')}</span>
        <span class="muted">${esc(r.channelName || '–')}</span>
      </div>
    </section>
    <section class="reservation-drawer-section">
      <div class="reservation-section-head">
        <span class="reservation-section-icon is-hostaway" aria-hidden="true">${reservationDrawerIcon('hostaway')}</span>
        <h4>Hostaway</h4>
      </div>
      <div class="reservation-drawer-kv">
        <span>${esc(t('reservations.hostawayId', { id: r.hostawayId }))}</span>
        <a class="reservation-hostaway-open" href="${esc(hostawayReservationUrl(r.hostawayId))}" target="_blank" rel="noopener noreferrer">
          ${esc(t('payments.openInHostaway'))}
          ${reservationDrawerIcon('external')}
        </a>
      </div>
    </section>
    <section class="reservation-drawer-section">
      <div class="reservation-section-head">
        <span class="reservation-section-icon" aria-hidden="true">${reservationDrawerIcon('activity')}</span>
        <h4>${esc(t('reservations.sectionActivity'))}</h4>
      </div>
      <ol class="reservation-activity">
        ${activityPreview.length
          ? activityPreview
              .map(
                (ev) => `<li>
            <div class="reservation-activity-rail"><span class="reservation-activity-dot" data-type="${esc(ev.type || '')}"></span></div>
            <div>
              <div class="muted reservation-activity-when">${esc(formatDateTime(ev.at))}</div>
              <div class="reservation-activity-title">${esc(ev.title || '')}</div>
              <div class="muted">${esc(ev.detail || activitySourceLabel(ev.type))}</div>
            </div>
          </li>`,
              )
              .join('')
          : `<li class="muted">${esc(t('reservations.activityEmpty'))}</li>`}
      </ol>
    </section>`;
}

function reservationDrawerIcon(kind) {
  const icons = {
    guest: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    stay: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    payment: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
    contact: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-5 0-9.27-3.11-11-8 1.02-2.87 2.98-5.2 5.47-6.59"/><path d="M1 1l22 22"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c5 0 9.27 3.11 11 8a11.5 11.5 0 0 1-2.16 3.19"/></svg>',
    property: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    hostaway: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
    activity: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    external: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  };
  return icons[kind] || '';
}

function softMaskEmail(email) {
  const s = String(email);
  const at = s.indexOf('@');
  if (at <= 0) return s;
  const user = s.slice(0, at);
  const domain = s.slice(at);
  const keep = Math.min(6, Math.max(1, Math.floor(user.length / 2)));
  return `${user.slice(0, keep)}${'*'.repeat(Math.max(3, user.length - keep))}${domain}`;
}

function softMaskPhone(phone) {
  const s = String(phone);
  if (s.length < 6) return '***';
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(3, s.length - 6))}${s.slice(-2)}`;
}

function formatReservationLongDate(value) {
  if (!value) return '–';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat(locale(), {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(d);
  } catch {
    return formatDate(value);
  }
}

function reservationLastPaidAt(r) {
  const charges = Array.isArray(r.notifiedCharges) ? r.notifiedCharges : [];
  let latest = null;
  for (const c of charges) {
    const at = c.notifiedAt ? new Date(c.notifiedAt) : null;
    if (at && !Number.isNaN(at.getTime()) && (!latest || at > latest)) latest = at;
  }
  const allocs = Array.isArray(r.paymentAllocations) ? r.paymentAllocations : [];
  for (const a of allocs) {
    const at = a.createdAt
      ? new Date(a.createdAt)
      : a.externalPayment?.occurredAt
        ? new Date(a.externalPayment.occurredAt)
        : null;
    if (at && !Number.isNaN(at.getTime()) && (!latest || at > latest)) latest = at;
  }
  return latest;
}

function activitySourceLabel(type) {
  if (type === 'payment' || type === 'allocation' || type === 'automation' || type === 'system') {
    return t('reservations.activitySystem');
  }
  return t('reservations.activitySystem');
}

function renderReservationNotes(r) {
  const blocks = [
    { label: t('reservations.noteHost'), value: r.hostNote },
    { label: t('reservations.noteGuest'), value: r.guestNote },
    { label: t('reservations.noteComment'), value: r.comment },
  ].filter((b) => b.value && String(b.value).trim());
  if (!blocks.length) {
    return `<p class="muted">${esc(t('reservations.notesEmpty'))}</p>`;
  }
  return blocks
    .map(
      (b) => `<section class="reservation-drawer-section">
      <h4>${esc(b.label)}</h4>
      <pre class="reservation-note">${esc(b.value)}</pre>
    </section>`,
    )
    .join('');
}

function reservationNights(arrival, departure) {
  const a = new Date(arrival);
  const d = new Date(departure);
  if (Number.isNaN(a.getTime()) || Number.isNaN(d.getTime())) return null;
  const ms = d.setHours(0, 0, 0, 0) - a.setHours(0, 0, 0, 0);
  const n = Math.round(ms / 86400000);
  return n > 0 ? n : null;
}

function initReservationDrawer() {
  $$('[data-reservation-drawer-close]').forEach((el) => {
    el.addEventListener('click', () => closeReservationDrawer());
  });
  $$('[data-reservation-drawer-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      reservationDrawerTab = btn.dataset.reservationDrawerTab || 'details';
      renderReservationDrawer();
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#reservation-drawer')?.classList.contains('hidden')) {
      closeReservationDrawer();
    }
    if (e.key === 'Escape' && !$('#reservations-filter-sheet')?.classList.contains('hidden')) {
      closeReservationsFilterSheet();
    }
  });
  $$('[data-reservations-filter-close]').forEach((el) => {
    el.addEventListener('click', () => closeReservationsFilterSheet());
  });
}

initReservationDrawer();

let conversationsCache = [];
let conversationsSelectedId = null;
let conversationsMobileView = 'list';

function isConversationsMobile() {
  return window.matchMedia('(max-width: 1023px)').matches;
}

function setConversationsMobileView(view) {
  conversationsMobileView = view || 'list';
  const inbox = $('#conversations-inbox');
  if (!inbox) return;
  inbox.classList.remove('is-mobile-list', 'is-mobile-chat', 'is-mobile-details');
  const backBtn = $('#conversations-back-btn');
  const moreBtn = $('#conversations-more-btn');
  if (!isConversationsMobile()) {
    if (backBtn) backBtn.hidden = true;
    if (moreBtn) moreBtn.hidden = true;
    return;
  }
  inbox.classList.add(`is-mobile-${conversationsMobileView}`);
  if (backBtn) backBtn.hidden = conversationsMobileView === 'list';
  if (moreBtn) moreBtn.hidden = conversationsMobileView !== 'chat' || !conversationsSelectedId;
}

function conversationChannelKey(channelName) {
  const c = String(channelName || '').toLowerCase();
  if (c.includes('airbnb')) return 'airbnb';
  if (c.includes('bookingcom') || c.includes('booking.com')) return 'bookingcom';
  if (c.includes('vrbo') || c.includes('homeaway')) return 'vrbo';
  if (c.includes('expedia')) return 'expedia';
  if (c.includes('agoda')) return 'agoda';
  if (c.includes('check24')) return 'check24';
  if (c.includes('whatsapp')) return 'whatsapp';
  if (c.includes('bookingengine') || c.includes('direct') || c.includes('website')) return 'direct';
  return '';
}

function conversationChannelBadgeHtml(channelName) {
  const key = conversationChannelKey(channelName);
  if (!key) {
    if (!channelName) return '';
    const mark = String(channelName).replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
    return `<span class="conversations-channel-badge is-fallback" title="${esc(prettyChannel(channelName))}">${esc(mark)}</span>`;
  }
  if (key === 'whatsapp') {
    return `<span class="conversations-channel-badge is-whatsapp" title="WhatsApp" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M17.5 6.5A7.5 7.5 0 0 0 5.2 15.1L4 20l5-1.2A7.5 7.5 0 1 0 17.5 6.5zm-5.4 11.4h-.1a6.2 6.2 0 0 1-3.2-.9l-.2-.1-3.2.8.8-3.1-.1-.2a6.2 6.2 0 1 1 6 3.5zm3.4-4.6c-.2-.1-1.1-.6-1.3-.6-.2-.1-.3-.1-.5.1s-.5.6-.7.8-.3.2-.5.1a5 5 0 0 1-1.5-.9 5.5 5.5 0 0 1-1-1.3c-.1-.2 0-.3.1-.4l.3-.4.1-.3c0-.1 0-.3-.1-.4s-.5-1.1-.6-1.5-.4-.3-.5-.3h-.4c-.1 0-.4.1-.6.3s-.8.8-.8 1.9.8 2.2.9 2.3a7.5 7.5 0 0 0 3.1 2.5c1.1.4 1.5.4 2 .3.6-.1 1.1-.6 1.3-1.1.2-.5.2-1 .1-1.1s-.2-.2-.4-.3z"/></svg>
    </span>`;
  }
  return `<span class="conversations-channel-badge" title="${esc(prettyChannel(channelName))}"><img src="/admin/assets/portals/${esc(key)}.svg" alt="" width="14" height="14" loading="lazy" /></span>`;
}

function conversationRelativeSyncLabel(value) {
  if (!value) return t('conversations.syncDelayed');
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return t('conversations.syncJustNow');
  const mins = Math.round(ms / 60000);
  if (mins < 1) return t('conversations.syncJustNow');
  if (mins < 60) return t('conversations.syncMinutesAgo', { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 48) return t('conversations.syncHoursAgo', { n: hours });
  return formatDashboardDateTime(value);
}

function updateConversationsGlobalSync(items) {
  const latest = (items || [])
    .map((r) => r.lastSyncedAt)
    .filter(Boolean)
    .map((v) => new Date(v).getTime())
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a)[0];
  const label = latest
    ? t('conversations.synchronizedAgo', { time: conversationRelativeSyncLabel(latest) })
    : t('conversations.syncOk');
  const html = `<span class="conversations-sync-dot" aria-hidden="true"></span>${esc(label)}`;
  const desktop = $('#conversations-global-sync');
  const mobile = $('#conversations-mobile-sync');
  if (desktop) {
    desktop.hidden = false;
    desktop.innerHTML = html;
  }
  if (mobile) mobile.innerHTML = html;
  const note = $('#conversations-mobile-footer-note');
  if (note) {
    note.hidden = false;
    note.textContent = t('conversations.mobileFooterNote', {
      n: formatCount((items && items.length) || 0),
    });
  }
}
let conversationsDetailCache = null;
let conversationsMessagesCache = [];
let conversationsPoll = null;
let conversationsUiBound = false;

function conversationGuestName(r) {
  return r.guestName || r.guestNameMasked || t('conversations.unknownGuest');
}

function conversationInitials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
}

function conversationListingCoverUrl(listing) {
  if (!listing || typeof listing !== 'object') return '';
  const direct = String(
    listing.thumbnailUrl ||
      listing.pictureUrl ||
      listing.coverImageUrl ||
      listing.imageUrl ||
      listing.listingCoverUrl ||
      '',
  ).trim();
  if (/^https?:\/\//i.test(direct)) return direct;
  return listingCoverUrl(listing);
}

function conversationGuestPictureUrl(r) {
  if (!r || typeof r !== 'object') return '';
  const candidates = [
    r.guestPictureUrl,
    r.guestPhotoUrl,
    r.guestImageUrl,
    r.pictureUrl,
    r.guest?.pictureUrl,
    r.guest?.photoUrl,
  ];
  for (const value of candidates) {
    const url = String(value || '').trim();
    if (/^https?:\/\//i.test(url)) return url;
  }
  return '';
}

function conversationAvatarHtml(r, sizeClass = '') {
  const name = conversationGuestName(r);
  const initials = conversationInitials(name);
  const safeUrl = conversationGuestPictureUrl(r);
  const tone = (initials.charCodeAt(0) + (initials.charCodeAt(1) || 0)) % 6;
  const cls = ['conversations-avatar', sizeClass, safeUrl ? 'has-photo' : '', `tone-${tone}`]
    .filter(Boolean)
    .join(' ');
  return `
    <div class="${cls}" aria-hidden="true">
      ${safeUrl ? `<img class="conversations-avatar-img" src="${esc(safeUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" decoding="async" />` : ''}
      <span class="conversations-avatar-fallback">${esc(initials)}</span>
    </div>`;
}

function conversationListingBadgeHtml(r) {
  const cover = conversationListingCoverUrl(r?.listing);
  if (/^https?:\/\//i.test(cover)) {
    return `<span class="conversations-listing-badge" title="${esc(r?.listing?.name || '')}" aria-hidden="true"><img src="${esc(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement && this.parentElement.remove()" /></span>`;
  }
  return conversationChannelBadgeHtml(r?.channelName);
}

function bindConversationAvatarFallbacks(root = document) {
  (root.querySelectorAll?.('.conversations-avatar-img') || []).forEach((img) => {
    if (img.dataset.bound === '1') return;
    img.dataset.bound = '1';
    img.addEventListener('error', () => {
      img.remove();
      img.closest('.conversations-avatar')?.classList.remove('has-photo');
    });
  });
}

function conversationSyncMeta(r) {
  if (!r?.hostawayConversationId) {
    return { key: 'missing', cls: 'is-error', label: t('conversations.syncMissing') };
  }
  if (!r.lastSyncedAt) {
    return { key: 'delayed', cls: 'is-delayed', label: t('conversations.syncDelayed') };
  }
  const ageMs = Date.now() - new Date(r.lastSyncedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000) {
    return { key: 'delayed', cls: 'is-delayed', label: t('conversations.syncDelayed') };
  }
  return { key: 'ok', cls: 'is-ok', label: t('conversations.syncOk') };
}

function conversationListTime(r) {
  const value = r.lastSyncedAt || r.updatedAt || r.arrivalDate;
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const todayKey = conversationMessageDayKey(new Date());
  const yday = new Date();
  yday.setDate(yday.getDate() - 1);
  const key = conversationMessageDayKey(d);
  if (key === todayKey) {
    return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  }
  if (key === conversationMessageDayKey(yday)) return t('conversations.yesterday');
  return d.toLocaleDateString(locale(), { month: 'short', day: 'numeric' });
}

function conversationPreviewText(r) {
  if (!r.hostawayConversationId) return t('conversations.previewUnlinked');
  const channel = r.channelName ? String(r.channelName) : '';
  if (channel) return t('conversations.previewChannel', { channel });
  return t('conversations.previewOpen');
}

function ensureConversationsUi() {
  if (conversationsUiBound) {
    syncConversationsControls();
    return;
  }
  conversationsUiBound = true;

  const search = $('#conversations-search');
  if (search) {
    search.placeholder = t('conversations.searchPlaceholder');
    search.addEventListener('input', () => {
      clearTimeout(searchTimers.conversations);
      searchTimers.conversations = setTimeout(() => {
        tableState.conversations.search = search.value;
        tableState.conversations.page = 1;
        loadConversations().catch((ex) => notify.error(ex.message));
      }, 300);
    });
  }

  const channel = $('#conversations-channel');
  channel?.addEventListener('change', () => {
    tableState.conversations.channel = channel.value;
    tableState.conversations.page = 1;
    loadConversations().catch((ex) => notify.error(ex.message));
  });

  const status = $('#conversations-status');
  if (status) {
    status.innerHTML = `
      <option value="all">${esc(t('reservations.filterAllStatuses'))}</option>
      <option value="new">${esc(t('reservations.statusNew'))}</option>
      <option value="modified">${esc(t('reservations.statusModified'))}</option>
      <option value="confirmed">${esc(t('reservations.statusConfirmed'))}</option>
      <option value="payment_due">${esc(t('reservations.statusPaymentDue'))}</option>
      <option value="cancelled">${esc(t('reservations.statusCancelled'))}</option>
      <option value="inquiry">${esc(t('reservations.statusInquiry'))}</option>
    `;
    status.addEventListener('change', () => {
      tableState.conversations.status = status.value;
      tableState.conversations.page = 1;
      loadConversations().catch((ex) => notify.error(ex.message));
    });
  }

  const sort = $('#conversations-sort');
  if (sort) {
    sort.innerHTML = `
      <option value="updatedAt:desc">${esc(t('conversations.sortUpdated'))}</option>
      <option value="arrivalDate:desc">${esc(t('conversations.sortArrival'))}</option>
      <option value="guestName:asc">${esc(t('conversations.sortGuest'))}</option>
    `;
    sort.addEventListener('change', () => {
      const [sortBy, sortDir] = String(sort.value || 'updatedAt:desc').split(':');
      tableState.conversations.sortBy = sortBy || 'updatedAt';
      tableState.conversations.sortDir = sortDir || 'desc';
      tableState.conversations.page = 1;
      loadConversations().catch((ex) => notify.error(ex.message));
    });
  }

  const auto = $('#conversations-auto-refresh');
  auto?.addEventListener('change', () => {
    manageConversationsPoll();
  });

  $('#conversations-refresh-btn')?.addEventListener('click', () => {
    if (!conversationsSelectedId) return;
    refreshSelectedConversation().catch((ex) => notify.error(ex.message));
  });

  $('#conversations-back-btn')?.addEventListener('click', () => {
    setConversationsMobileView('list');
  });
  $('#conversations-more-btn')?.addEventListener('click', () => {
    if (!conversationsSelectedId) return;
    setConversationsMobileView('details');
  });
  $('#conversations-details-close-btn')?.addEventListener('click', () => {
    setConversationsMobileView(conversationsSelectedId ? 'chat' : 'list');
  });

  window.addEventListener('resize', () => {
    if (!isConversationsMobile()) {
      setConversationsMobileView('list');
    } else if (conversationsSelectedId && conversationsMobileView === 'list') {
      // keep list until user opens a chat
    } else {
      setConversationsMobileView(conversationsMobileView || 'list');
    }
  });

  $('#conversations-copy-convid')?.addEventListener('click', async () => {
    const id = conversationsDetailCache?.hostawayConversationId
      || conversationsCache.find((r) => String(r.hostawayId) === String(conversationsSelectedId))?.hostawayConversationId;
    if (!id) return;
    try {
      await navigator.clipboard.writeText(String(id));
      notify.success(t('conversations.copied'));
    } catch {
      notify.error(t('common.copyFailed') || 'Copy failed');
    }
  });

  syncConversationsControls();
}

function syncConversationsControls() {
  const s = tableState.conversations;
  const search = $('#conversations-search');
  if (search && document.activeElement !== search) search.value = s.search || '';
  const channel = $('#conversations-channel');
  if (channel) channel.value = s.channel || 'all';
  const status = $('#conversations-status');
  if (status) status.value = s.status || 'all';
  const sort = $('#conversations-sort');
  if (sort) sort.value = `${s.sortBy || 'updatedAt'}:${s.sortDir || 'desc'}`;
}

async function loadConversationsChannels() {
  const sel = $('#conversations-channel');
  if (!sel || sel.dataset.loaded === '1') return;
  try {
    const facets = await api('/reservations/facets');
    const channels = facets.channels || [];
    sel.innerHTML = [
      `<option value="all">${esc(t('reservations.filterAllChannels'))}</option>`,
      ...channels.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`),
    ].join('');
    sel.dataset.loaded = '1';
    sel.value = tableState.conversations.channel || 'all';
  } catch {
    sel.innerHTML = `<option value="all">${esc(t('reservations.filterAllChannels'))}</option>`;
  }
}

function manageConversationsPoll() {
  if (conversationsPoll) clearInterval(conversationsPoll);
  conversationsPoll = null;
  const auto = $('#conversations-auto-refresh');
  if (activeTab === 'conversations' && token && auto?.checked) {
    conversationsPoll = setInterval(() => {
      if (activeTab === 'conversations') {
        loadConversations({ silent: true }).catch(() => {});
      }
    }, 60000);
  }
}

async function loadConversations(opts = {}) {
  ensureConversationsUi();
  await loadConversationsChannels();
  manageConversationsPoll();

  const data = await api(`/reservations?${tableQuery('conversations')}`);
  conversationsCache = data.items || [];
  const countEl = $('#conversations-count-label');
  if (countEl) {
    countEl.textContent = t('conversations.count', { n: formatCount(data.total || 0) });
  }

  const list = $('#conversations-list');
  if (!list) return;

  if (!conversationsCache.length) {
    list.innerHTML = `<div class="conversations-empty-state is-compact"><p>${esc(t('table.infoEmpty'))}</p></div>`;
  } else {
    list.innerHTML = conversationsCache.map((r) => renderConversationListItem(r)).join('');
    bindConversationAvatarFallbacks(list);
  }

  list.querySelectorAll('[data-conversation-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectConversation(btn.getAttribute('data-conversation-id')).catch((ex) =>
        notify.error(ex.message),
      );
    });
  });
  bindConversationAvatarFallbacks(list);

  renderTableInfo('#conversations-info', data);
  renderPagination('#conversations-pagination', data, 'conversations', loadConversations, {
    compact: true,
    pageSizeOptions: [10, 25, 50],
  });
  syncConversationsControls();
  updateConversationsGlobalSync(conversationsCache);
  setConversationsMobileView(
    isConversationsMobile()
      ? conversationsSelectedId && conversationsMobileView !== 'list'
        ? conversationsMobileView
        : 'list'
      : 'list',
  );

  const stillThere = conversationsCache.some(
    (r) => String(r.hostawayId) === String(conversationsSelectedId),
  );
  if (conversationsSelectedId && stillThere) {
    highlightSelectedConversation();
  } else if (conversationsCache.length && !conversationsSelectedId && !isConversationsMobile()) {
    await selectConversation(conversationsCache[0].hostawayId);
  } else if (!stillThere) {
    conversationsSelectedId = null;
    showConversationEmpty();
    if (isConversationsMobile()) setConversationsMobileView('list');
  }
}

function renderConversationListItem(r) {
  const name = conversationGuestName(r);
  const sync = conversationSyncMeta(r);
  const selected = String(r.hostawayId) === String(conversationsSelectedId);
  const bookingId = r.hostawayId ? `#${r.hostawayId}` : '';
  return `
    <button type="button" class="conversations-list-item${selected ? ' is-selected' : ''}" data-conversation-id="${esc(String(r.hostawayId))}">
      <div class="conversations-list-avatar-wrap">
        ${conversationAvatarHtml(r)}
        ${conversationListingBadgeHtml(r)}
      </div>
      <div class="conversations-list-main">
        <div class="conversations-list-top">
          <span class="conversations-list-name">${esc(name)}</span>
          <span class="conversations-list-time">${esc(conversationListTime(r))}</span>
        </div>
        <div class="conversations-list-property">${esc(r.listing?.name || '–')}</div>
        <div class="conversations-list-idline">${esc(bookingId)}</div>
        <div class="conversations-list-preview">${esc(conversationPreviewText(r))}</div>
        <div class="conversations-list-bottom">
          <span class="conversations-list-id conversations-list-id-desktop">#${esc(String(r.hostawayConversationId || r.hostawayId))}</span>
          <span class="conversations-sync-badge ${sync.cls}">${esc(sync.label)}</span>
        </div>
      </div>
    </button>
  `;
}

function highlightSelectedConversation() {
  $$('#conversations-list [data-conversation-id]').forEach((el) => {
    el.classList.toggle(
      'is-selected',
      String(el.getAttribute('data-conversation-id')) === String(conversationsSelectedId),
    );
  });
}

function showConversationEmpty() {
  $('#conversations-chat-empty')?.classList.remove('hidden');
  $('#conversations-chat')?.classList.add('hidden');
  $('#conversations-details-empty')?.classList.remove('hidden');
  $('#conversations-details')?.classList.add('hidden');
  if (isConversationsMobile()) setConversationsMobileView('list');
}

async function selectConversation(hostawayId) {
  conversationsSelectedId = hostawayId;
  highlightSelectedConversation();
  const listItem = conversationsCache.find((r) => String(r.hostawayId) === String(hostawayId));
  $('#conversations-chat-empty')?.classList.add('hidden');
  $('#conversations-chat')?.classList.remove('hidden');
  $('#conversations-details-empty')?.classList.add('hidden');
  $('#conversations-details')?.classList.remove('hidden');
  if (isConversationsMobile()) setConversationsMobileView('chat');

  renderConversationChatShell(listItem);
  renderConversationDetailsLoading();

  const messagesEl = $('#conversations-messages');
  if (messagesEl) messagesEl.innerHTML = `<p class="conversations-loading">${esc(t('dashboard.syncRunning'))}</p>`;

  const [detail, conversation] = await Promise.all([
    api(`/reservations/${hostawayId}`).catch(() => listItem || null),
    api(`/reservations/${hostawayId}/conversation`).catch((ex) => ({ error: ex.message })),
  ]);

  conversationsDetailCache = detail;
  conversationsMessagesCache = conversation?.messages || [];
  renderConversationChatShell(detail || listItem, conversation);
  renderConversationMessages(conversation);
  renderConversationDetails(detail || listItem, conversation);
}

function renderConversationChatShell(r, conversation) {
  if (!r) return;
  const name = conversationGuestName(r);
  const sync = conversationSyncMeta({
    ...r,
    hostawayConversationId:
      conversation?.hostawayConversationId ?? r.hostawayConversationId,
  });
  const avatar = $('#conversations-chat-avatar');
  if (avatar) {
    const safeUrl = conversationGuestPictureUrl(r);
    const initials = conversationInitials(name);
    const tone = (initials.charCodeAt(0) + (initials.charCodeAt(1) || 0)) % 6;
    avatar.className = `conversations-avatar is-lg${safeUrl ? ' has-photo' : ''} tone-${tone}`;
    avatar.innerHTML = `
      ${safeUrl ? `<img class="conversations-avatar-img" src="${esc(safeUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" decoding="async" />` : ''}
      <span class="conversations-avatar-fallback">${esc(initials)}</span>`;
    bindConversationAvatarFallbacks(avatar);
  }
  const guest = $('#conversations-chat-guest');
  if (guest) guest.textContent = name;
  const listing = $('#conversations-chat-listing');
  if (listing) listing.textContent = r.listing?.name || '–';
  const convId = conversation?.hostawayConversationId ?? r.hostawayConversationId;
  const convEl = $('#conversations-chat-convid');
  if (convEl) {
    convEl.textContent = convId
      ? `${t('listings.conversation')} ${convId}`
      : t('conversations.noneShort');
  }
  const copyBtn = $('#conversations-copy-convid');
  if (copyBtn) copyBtn.hidden = !convId;
  const syncEl = $('#conversations-chat-sync');
  if (syncEl) {
    syncEl.className = `conversations-sync-badge conversations-sync-desktop ${sync.cls}`;
    syncEl.textContent = sync.label;
  }
  const syncMobile = $('#conversations-chat-sync-mobile');
  if (syncMobile) {
    syncMobile.hidden = false;
    syncMobile.className = `conversations-sync-badge conversations-sync-mobile ${sync.cls}`;
    syncMobile.textContent = sync.label;
  }
  const channelEl = $('#conversations-chat-channel');
  if (channelEl) {
    channelEl.textContent = r.channelName
      ? t('conversations.channelVia', { channel: r.channelName })
      : '';
  }
  const moreBtn = $('#conversations-more-btn');
  if (moreBtn) moreBtn.hidden = !isConversationsMobile();
  const backBtn = $('#conversations-back-btn');
  if (backBtn) backBtn.hidden = !isConversationsMobile();

  const bar = $('#conversations-reservation-bar');
  if (bar) {
    const statusMeta = reservationStatusMeta(r);
    const guests = reservationGuestsLabel(r) || '–';
    const nights = reservationNights(r.arrivalDate, r.departureDate);
    const stayLine = [
      `${formatDate(r.arrivalDate)} – ${formatDate(r.departureDate)}`,
      nights != null ? t('reservations.nights', { n: nights }) : '',
      guests !== '–' ? guests : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const thumb = conversationListingCoverUrl(r.listing);
    const safeThumb = /^https?:\/\//i.test(thumb) ? thumb : '';
    bar.innerHTML = `
      <button type="button" class="conversations-property-card" data-open-reservation="${esc(String(r.hostawayId))}">
        <span class="conversations-property-thumb" aria-hidden="true">
          ${safeThumb ? `<img src="${esc(safeThumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : `<span class="conversations-property-thumb-fallback">${esc((r.listing?.name || 'P').slice(0, 1).toUpperCase())}</span>`}
        </span>
        <span class="conversations-property-copy">
          <span class="conversations-property-title">${esc(r.listing?.name || '–')} <span class="conversations-property-id">#${esc(String(r.hostawayId))}</span></span>
          <span class="conversations-property-meta">${esc(stayLine)}</span>
        </span>
        <span class="conversations-property-chevron" aria-hidden="true">›</span>
      </button>
      <div class="conversations-res-grid">
        <div class="conversations-res-cell">
          <span class="conversations-res-label">${esc(t('conversations.reservation'))}</span>
          <button type="button" class="conversations-res-link" data-open-reservation="${esc(String(r.hostawayId))}">#${esc(String(r.hostawayId))}</button>
        </div>
        <div class="conversations-res-cell">
          <span class="conversations-res-label">${esc(t('conversations.checkIn'))}</span>
          <span>${esc(formatDate(r.arrivalDate))}</span>
        </div>
        <div class="conversations-res-cell">
          <span class="conversations-res-label">${esc(t('conversations.checkOut'))}</span>
          <span>${esc(formatDate(r.departureDate))}</span>
        </div>
        <div class="conversations-res-cell">
          <span class="conversations-res-label">${esc(t('listings.guest'))}</span>
          <span>${esc(guests)}</span>
        </div>
        <div class="conversations-res-cell">
          <span class="conversations-res-label">${esc(t('conversations.total'))}</span>
          <span>${esc(formatMoney(r.totalPrice))}</span>
        </div>
        <div class="conversations-res-cell">
          <span class="conversations-res-label">${esc(t('listings.status'))}</span>
          <span class="reservation-status-pill ${statusMeta.cls}">${esc(statusMeta.label)}</span>
        </div>
      </div>
    `;
    bar.querySelectorAll('[data-open-reservation]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        if (isConversationsMobile() && el.classList.contains('conversations-property-card')) {
          setConversationsMobileView('details');
          return;
        }
        openReservationFromConversation(r.hostawayId);
      });
    });
  }

  const openBtn = $('#conversations-open-hostaway');
  const url = hostawayReservationUrl(r.hostawayId);
  if (openBtn) {
    if (url) {
      openBtn.hidden = false;
      openBtn.href = url;
    } else {
      openBtn.hidden = true;
    }
  }
  const refreshBtn = $('#conversations-refresh-btn');
  if (refreshBtn) {
    refreshBtn.hidden = !hasPermission('CONVERSATIONS_MANAGE');
  }
}

function renderConversationMessages(conversation) {
  const el = $('#conversations-messages');
  if (!el) return;
  if (conversation?.error) {
    el.innerHTML = `<p class="error">${esc(conversation.error)}</p>`;
    return;
  }
  if (!conversation?.hostawayConversationId) {
    el.innerHTML = `<p class="conversations-empty-inline">${esc(t('conversations.none'))}</p>`;
    return;
  }
  const messages = conversation.messages || [];
  if (!messages.length) {
    el.innerHTML = `<p class="conversations-empty-inline">${esc(t('conversations.noMessages'))}</p>`;
    return;
  }

  const sorted = [...messages].sort((a, b) => {
    const ta = new Date(a.insertedOn || 0).getTime();
    const tb = new Date(b.insertedOn || 0).getTime();
    return ta - tb;
  });

  let html = '';
  let lastDay = '';
  let prevIncoming = null;
  const guestAvatarHtml = conversationAvatarHtml(
    conversationsDetailCache || { guestName: conversationGuestName(conversationsDetailCache) },
    'is-sm',
  );
  for (const m of sorted) {
    const day = conversationMessageDayKey(m.insertedOn);
    if (day && day !== lastDay) {
      html += `<div class="conversations-day-divider"><span>${esc(conversationDayLabel(m.insertedOn))}</span></div>`;
      lastDay = day;
      prevIncoming = null;
    }
    const incoming = m.isIncoming === 1;
    html += renderConversationMessage(m, {
      showGuestAvatar: incoming && prevIncoming !== true,
      guestAvatarHtml,
    });
    prevIncoming = incoming;
  }
  el.innerHTML = html;
  bindConversationAvatarFallbacks(el);
  el.scrollTop = el.scrollHeight;
}

function conversationDetailsIcon(kind) {
  const icons = {
    guest: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    listing: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z"/><path d="M9 21V12h6v9"/></svg>',
    channel: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>',
    messages: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 8h8M8 12h5"/></svg>',
    sync: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-15.5-6.4L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.5 6.4L21 16"/><path d="M16 16h5v5"/></svg>',
    tags: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 11 3H4v7l9.59 9.59a2 2 0 0 0 2.82 0l4.18-4.18a2 2 0 0 0 0-2.82z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
    external: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6"/></svg>',
  };
  return icons[kind] || '';
}

function renderConversationDetailsLoading() {
  const el = $('#conversations-details');
  if (el) el.innerHTML = `<p class="conversations-loading">${esc(t('dashboard.syncRunning'))}</p>`;
}

function renderConversationDetails(r, conversation) {
  const el = $('#conversations-details');
  if (!el || !r) return;
  const canPii = hasPermission('RESERVATIONS_VIEW_PII') || adminRole === 'SUPER_ADMIN';
  const name = conversationGuestName(r);
  const emailRaw = r.guestEmail || '';
  const phoneRaw = r.guestPhone || '';
  const emailShown = emailRaw ? (canPii ? softMaskEmail(emailRaw) : emailRaw) : '–';
  const phoneShown = phoneRaw ? (canPii ? softMaskPhone(phoneRaw) : phoneRaw) : '–';
  const sync = conversationSyncMeta({
    ...r,
    hostawayConversationId:
      conversation?.hostawayConversationId ?? r.hostawayConversationId,
  });
  const messages = conversation?.messages || [];
  const times = messages
    .map((m) => new Date(m.insertedOn || 0).getTime())
    .filter((n) => Number.isFinite(n) && n > 0);
  const firstMsg = times.length ? new Date(Math.min(...times)) : null;
  const lastMsg = times.length ? new Date(Math.max(...times)) : null;
  const tagSet = new Set();
  if (r.listing?.listingGroup?.name) tagSet.add(r.listing.listingGroup.name);
  if (Array.isArray(r.listing?.tags)) {
    r.listing.tags.filter(Boolean).forEach((tag) => tagSet.add(tag));
  }
  const tags = [...tagSet];

  el.innerHTML = `
    <div class="conversations-details-header">${esc(t('conversations.detailsTitle'))}</div>
    <div class="conversations-details-body">
      <section class="conversations-detail-row">
        <div class="conversations-detail-icon" aria-hidden="true">${conversationDetailsIcon('guest')}</div>
        <div class="conversations-detail-content">
          <div class="conversations-detail-name">${esc(name)}</div>
          <div class="conversations-detail-sub">${esc(emailShown)}</div>
          <div class="conversations-detail-sub">${esc(phoneShown)}</div>
        </div>
      </section>

      <section class="conversations-detail-row">
        <div class="conversations-detail-icon" aria-hidden="true">${conversationDetailsIcon('listing')}</div>
        <div class="conversations-detail-content">
          <div class="conversations-detail-name">${esc(r.listing?.name || '–')}</div>
          ${r.listingId
            ? `<button type="button" class="conversations-view-listing-btn" data-view-listing>
                <span>${esc(t('conversations.viewListing'))}</span>
                ${conversationDetailsIcon('external')}
              </button>`
            : ''}
        </div>
      </section>

      <section class="conversations-detail-row">
        <div class="conversations-detail-icon" aria-hidden="true">${conversationDetailsIcon('channel')}</div>
        <div class="conversations-detail-content">
          <div class="conversations-detail-name">${esc(r.channelName || '–')}</div>
        </div>
      </section>

      <section class="conversations-detail-row">
        <div class="conversations-detail-icon" aria-hidden="true">${conversationDetailsIcon('messages')}</div>
        <div class="conversations-detail-content">
          <div class="conversations-kv">
            <span>${esc(t('conversations.firstMessage'))}</span>
            <strong>${firstMsg ? esc(formatDateTime(firstMsg.toISOString())) : '–'}</strong>
          </div>
          <div class="conversations-kv">
            <span>${esc(t('conversations.lastMessage'))}</span>
            <strong>${lastMsg ? esc(formatDateTime(lastMsg.toISOString())) : '–'}</strong>
          </div>
          <div class="conversations-kv">
            <span>${esc(t('conversations.totalMessages'))}</span>
            <strong>${esc(String(messages.length))}</strong>
          </div>
        </div>
      </section>

      <section class="conversations-detail-row">
        <div class="conversations-detail-icon" aria-hidden="true">${conversationDetailsIcon('sync')}</div>
        <div class="conversations-detail-content">
          <div class="conversations-kv">
            <span>${esc(t('conversations.statusLabel'))}</span>
            <span class="conversations-sync-badge ${sync.cls}">${esc(sync.label)}</span>
          </div>
          <div class="conversations-kv">
            <span>${esc(t('conversations.lastSync'))}</span>
            <strong>${r.lastSyncedAt ? esc(formatDateTime(r.lastSyncedAt)) : '–'}</strong>
          </div>
          <div class="conversations-kv">
            <span>${esc(t('conversations.directionLabel'))}</span>
            <strong>${esc(t('conversations.syncDirectionShort'))}</strong>
          </div>
        </div>
      </section>

      <section class="conversations-detail-row is-last">
        <div class="conversations-detail-icon" aria-hidden="true">${conversationDetailsIcon('tags')}</div>
        <div class="conversations-detail-content">
          <div class="conversations-tags">
            ${tags.length
              ? tags.map((tag) => `<span class="conversations-tag">${esc(tag)}</span>`).join('')
              : `<span class="conversations-details-muted">${esc(t('conversations.noTags'))}</span>`}
          </div>
        </div>
      </section>
    </div>
  `;

  el.querySelector('[data-view-listing]')?.addEventListener('click', () => {
    if (!r.listingId) return;
    const btn = document.querySelector('.nav-btn[data-tab="listings"]');
    btn?.click();
    setTimeout(() => {
      tableState.listings.search = r.listing?.name || '';
      tableState.listings.page = 1;
      loadListings?.().catch(() => {});
    }, 50);
  });
}

function openReservationFromConversation(hostawayId) {
  const btn = document.querySelector('.nav-btn[data-tab="reservations"]');
  btn?.click();
  setTimeout(() => {
    if (typeof openReservationDrawer === 'function') {
      openReservationDrawer(hostawayId).catch(() => {});
    } else {
      tableState.reservations.search = String(hostawayId);
      loadReservations().catch(() => {});
    }
  }, 50);
}

async function refreshSelectedConversation() {
  if (!conversationsSelectedId) return;
  const result = await api(
    `/reservations/${conversationsSelectedId}/refresh-conversation`,
    { method: 'POST' },
  );
  notify.success(t('conversations.refreshed', { id: result.hostawayConversationId || '–' }));
  await loadConversations({ silent: true });
  await selectConversation(conversationsSelectedId);
}

// Legacy modal close handlers (modal kept for compatibility)
$('#conversation-modal-close')?.addEventListener('click', () => {
  $('#conversation-modal')?.classList.add('hidden');
  document.body.classList.remove('modal-open');
});
$('#conversation-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'conversation-modal') {
    $('#conversation-modal').classList.add('hidden');
    document.body.classList.remove('modal-open');
  }
});

const VERIFICATION_FIELDS = [
  'stayDates',
  'listingName',
  'phone',
  'email',
  'reservationId',
];

let rulesActiveView = 'verification';
let rulesUiBound = false;
let cachedVerificationPrompt = null;

function normalizeVerificationFields(fields) {
  const set = new Set();
  for (const field of fields ?? []) {
    if (field === 'arrivalDate' || field === 'departureDate' || field === 'stayDates') {
      set.add('stayDates');
    } else if (VERIFICATION_FIELDS.includes(field)) {
      set.add(field);
    }
  }
  if (!set.has('stayDates')) set.add('stayDates');
  return VERIFICATION_FIELDS.filter((f) => set.has(f));
}

function verificationFieldIcon(field) {
  const icons = {
    stayDates: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    listingName: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z"/><path d="M9 21V12h6v9"/></svg>',
    phone: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.68 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.74.32 1.53.55 2.34.68A2 2 0 0 1 22 16.92z"/></svg>',
    email: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 7L2 7"/></svg>',
    reservationId: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 9h14M5 15h14M10 4l-2 16M16 4l-2 16"/></svg>',
  };
  return icons[field] || icons.reservationId;
}

function verificationFieldHint(field, fieldMeta) {
  const key = `verification.fieldHint.${field}`;
  const translated = t(key);
  if (translated && translated !== key) return translated;
  return fieldMeta?.descriptions?.[field] || '';
}

function setRulesHearExpanded(expanded) {
  const card = $('#verification-prompt-preview');
  const toggle = $('#rules-hear-toggle');
  const expandBtn = $('#rules-hear-expand-btn');
  if (!card) return;
  card.classList.toggle('is-expanded', !!expanded);
  toggle?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  if (expandBtn) {
    const label = expandBtn.querySelector('[data-i18n="verification.expandScript"], span:last-child');
    if (label) label.textContent = expanded ? t('verification.collapseScript') : t('verification.expandScript');
  }
}

function updateVerificationMinMatchInfo() {
  const input = $('#verification-min-match');
  const info = $('#verification-min-match-info');
  if (!info) return;
  const count = Math.max(1, Number(input?.value) || 3);
  info.innerHTML = `<span class="verification-min-match-info-icon" aria-hidden="true">i</span><span>${esc(t('verification.minMatchesInfo', { count }))}</span>`;
}

function ensureRulesUi() {
  if (rulesUiBound) return;
  rulesUiBound = true;
  $$('[data-rules-view]').forEach((btn) => {
    btn.addEventListener('click', () => activateRulesView(btn.dataset.rulesView));
  });
  $('#verification-min-minus')?.addEventListener('click', () => stepVerificationMin(-1));
  $('#verification-min-plus')?.addEventListener('click', () => stepVerificationMin(1));
  $('#verification-min-match')?.addEventListener('input', updateVerificationMinMatchInfo);
  $('#verification-min-match')?.addEventListener('change', updateVerificationMinMatchInfo);
  $('#rules-hear-toggle')?.addEventListener('click', () => {
    const card = $('#verification-prompt-preview');
    setRulesHearExpanded(!card?.classList.contains('is-expanded'));
  });
  $('#rules-hear-expand-btn')?.addEventListener('click', () => {
    const card = $('#verification-prompt-preview');
    setRulesHearExpanded(!card?.classList.contains('is-expanded'));
  });
  document.addEventListener('langchange', () => {
    if (activeTab === 'rules' && cachedVerificationPrompt) {
      renderVerificationPromptPreview(cachedVerificationPrompt);
    }
    updateVerificationMinMatchInfo();
  });
}

function activateRulesView(view) {
  const next = view === 'approval' ? 'approval' : 'verification';
  rulesActiveView = next;
  $$('[data-rules-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.rulesView === next);
  });
  $('#rules-view-verification')?.classList.toggle('hidden', next !== 'verification');
  $('#rules-view-approval')?.classList.toggle('hidden', next !== 'approval');
  $('#rules-verification-actions')?.classList.toggle('hidden', next !== 'verification');
  const mobileSave = $('#rules-mobile-save-bar');
  if (mobileSave) {
    if (next === 'verification') mobileSave.removeAttribute('hidden');
    else mobileSave.setAttribute('hidden', '');
  }
}

function stepVerificationMin(delta) {
  const input = $('#verification-min-match');
  if (!input || input.disabled) return;
  const max = Number(input.max) || VERIFICATION_FIELDS.length;
  const min = Number(input.min) || 1;
  const next = Math.min(max, Math.max(min, (Number(input.value) || min) + delta));
  input.value = String(next);
  updateVerificationMinMatchInfo();
}

function renderVerificationLastSaved(updatedAt) {
  const targets = [$('#verification-last-saved'), $('#verification-last-saved-mobile')].filter(Boolean);
  if (!targets.length) return;
  if (!updatedAt) {
    targets.forEach((el) => {
      el.classList.add('hidden');
      el.textContent = '';
    });
    return;
  }
  const html = `<span class="rules-last-saved-ok" aria-hidden="true">✓</span> ${esc(t('verification.lastSaved', { when: formatDateTime(updatedAt) }))}`;
  targets.forEach((el) => {
    el.classList.remove('hidden');
    el.innerHTML = html;
  });
}

function renderVerificationForm(config, fieldMeta) {
  const container = $('#verification-field-checkboxes');
  if (!container) return;
  ensureRulesUi();
  const selected = new Set(normalizeVerificationFields(config?.requiredFields));
  const canRulesEdit = hasPermission('RULES_EDIT');
  $('#verification-config-id').value = config?.id ?? '';
  const minInput = $('#verification-min-match');
  if (minInput) {
    minInput.value = config?.minMatchCount ?? 3;
    minInput.max = VERIFICATION_FIELDS.length;
    minInput.disabled = !canRulesEdit;
  }
  $('#verification-min-minus')?.toggleAttribute('disabled', !canRulesEdit);
  $('#verification-min-plus')?.toggleAttribute('disabled', !canRulesEdit);
  updateVerificationMinMatchInfo();
  const offerCb = $('#verification-booking-offer');
  if (offerCb) {
    offerCb.checked = config?.bookingOfferEnabled !== false;
    offerCb.disabled = !canRulesEdit;
  }
  renderVerificationLastSaved(config?.updatedAt);
  renderVerificationPromptPreview(config?.fonioPrompt);

  container.innerHTML = VERIFICATION_FIELDS.map((field) => {
    const locked = field === 'stayDates';
    const checked = locked || selected.has(field);
    const disabled = locked || !canRulesEdit;
    const label = locked ? t('verification.field.stayDatesLockedTitle') : t(`verification.field.${field}`);
    const hint = verificationFieldHint(field, fieldMeta);
    return `
      <div class="verification-field-item${locked ? ' is-locked' : ''}${checked ? ' is-checked' : ''}">
        <div class="verification-field-icon" aria-hidden="true">${verificationFieldIcon(field)}</div>
        <div class="verification-field-copy">
          <strong>${esc(label)}</strong>
          ${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}
          ${locked ? `<span class="verification-always-required">${esc(t('verification.alwaysRequired'))}</span>` : ''}
        </div>
        <label class="toggle-switch${locked ? ' is-locked-toggle' : ''}">
          <input type="checkbox" name="verification-field" value="${field}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
          <span class="toggle-slider" aria-hidden="true"></span>
        </label>
      </div>`;
  }).join('');

  container.querySelectorAll('input[name="verification-field"]').forEach((input) => {
    input.addEventListener('change', () => {
      const row = input.closest('.verification-field-item');
      if (!row || input.disabled) return;
      row.classList.toggle('is-checked', input.checked);
    });
  });
}

function renderVerificationPromptPreview(prompt) {
  cachedVerificationPrompt = prompt || null;
  const quote = $('#verification-guest-script-quote');
  const script = $('#verification-guest-script');
  const lang = typeof getLang === 'function' ? getLang() : 'en';
  const text =
    lang === 'de'
      ? prompt?.guestScriptDe || prompt?.guestScriptEn || ''
      : prompt?.guestScriptEn || prompt?.guestScriptDe || '';
  if (quote) quote.textContent = text ? `“${text}”` : '–';
  if (script) script.value = text;

  const btn = $('#verification-copy-script');
  if (btn) {
    btn.replaceWith(btn.cloneNode(true));
    $('#verification-copy-script')?.addEventListener('click', () => {
      const value = $('#verification-guest-script')?.value || '';
      if (!value) return;
      navigator.clipboard.writeText(value);
      notify.success(t('common.copied'));
    });
  }
}

function getVerificationFormData() {
  const fields = ['stayDates'];
  $$('input[name="verification-field"]:checked').forEach((cb) => {
    if (cb.value !== 'stayDates') fields.push(cb.value);
  });
  const minMatch = Number($('#verification-min-match').value);
  return {
    requiredFields: [...new Set(fields)],
    minMatchCount: Math.min(minMatch, fields.length),
    bookingOfferEnabled: $('#verification-booking-offer')?.checked ?? true,
  };
}

$('#verification-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!hasPermission('RULES_EDIT')) {
    notify.error(t('perms.featureLocked'));
    return;
  }
  const id = $('#verification-config-id').value;
  if (!id) {
    notify.error(t('rules.noConfig'));
    return;
  }
  try {
    const saved = await api(`/verification-config/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(getVerificationFormData()),
    });
    notify.success(t('verification.saved'));
    renderVerificationLastSaved(saved?.updatedAt || new Date().toISOString());
    loadRules();
  } catch (ex) {
    notify.error(ex.message);
  }
});

async function loadRules() {
  ensureRulesUi();
  ensureRulesToolbar();
  const [rules, config, fieldMeta, listingsData, conditionSchema] = await Promise.all([
    api('/rules'),
    api('/verification-config'),
    api('/verification-config/fields'),
    api('/listings?pageSize=100'),
    api('/rules/condition-fields'),
  ]);
  cachedRules = rules;
  cachedConditionSchema = conditionSchema;
  cachedListings = listingsData.items || listingsData;
  populateListingSelect();
  renderVerificationForm(config, fieldMeta);
  updateRuleSelects();

  const modeFilter = tableState.rules.mode || 'all';
  const statusFilter = tableState.rules.status || 'all';
  let filtered = rules;
  if (modeFilter !== 'all') {
    filtered = filtered.filter((r) => r.mode === modeFilter);
  }
  if (statusFilter === 'active') {
    filtered = filtered.filter((r) => r.isActive !== false);
  } else if (statusFilter === 'inactive') {
    filtered = filtered.filter((r) => r.isActive === false);
  }

  const data = paginateClient(filtered, 'rules', (r) => [
    r.requestType,
    t(`requestType.${r.requestType}`) || r.requestType,
    formatRuleTypeDisplay(r.requestType),
    r.mode,
    t(`mode.${r.mode}`) || r.mode,
    r.listing?.name || t('rules.global'),
    r.priority,
    r.isActive !== false ? 'active' : 'inactive',
  ].join(' '));

  const title = $('#rules-existing-title');
  if (title) title.textContent = t('rules.existingRules');
  const countBadge = $('#rules-existing-count');
  if (countBadge) countBadge.textContent = String(filtered.length);

  const canEdit = hasPermission('RULES_EDIT');
  const canDelete = hasPermission('RULES_DELETE');
  const startIndex = (data.page - 1) * data.pageSize;
  const rows = data.items.map((r, idx) => {
    const active = r.isActive !== false;
    const listingLabel = r.listing?.name || t('rules.global');
    return `
    <tr data-rule-id="${r.id}" class="${editingRuleId === r.id ? 'selected' : ''}">
      <td class="rules-index-cell" data-label="#">${startIndex + idx + 1}</td>
      <td data-label="${esc(t('rules.col.type'))}"><strong>${esc(formatRuleTypeDisplay(r.requestType))}</strong></td>
      <td data-label="${esc(t('rules.col.mode'))}"><span class="rules-mode-badge ${modeBadgeClass(r.mode)}">${esc(t(`mode.${r.mode}`) || r.mode)}</span></td>
      <td data-label="${esc(t('rules.col.appliesTo'))}">${esc(listingLabel)}</td>
      <td class="rules-priority-cell" data-label="${esc(t('rules.col.priority'))}">${esc(String(r.priority))}</td>
      <td data-label="${esc(t('rules.col.status'))}">
        <span class="rules-status-dot ${active ? 'is-active' : 'is-inactive'}">
          <span class="rules-status-dot-mark" aria-hidden="true"></span>
          ${esc(active ? t('rules.active') : t('rules.inactive'))}
        </span>
      </td>
      <td class="rules-row-actions" data-label="${esc(t('rules.col.actions'))}">
        ${canEdit ? `<button type="button" class="rules-icon-btn" data-rule-edit="${r.id}" title="${esc(t('rules.editRule'))}" aria-label="${esc(t('rules.editRule'))}">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>` : '–'}
      </td>
    </tr>`;
  }).join('');

  $('#rules-table').innerHTML = `
    <table class="rules-existing-table">
      <thead><tr>
        <th class="rules-index-cell">#</th>
        <th>${t('rules.col.type')}</th>
        <th>${t('rules.col.mode')}</th>
        <th>${t('rules.col.appliesTo')}</th>
        <th class="rules-priority-cell">${t('rules.col.priority')}</th>
        <th>${t('rules.col.status')}</th>
        <th class="rules-row-actions">${t('rules.col.actions')}</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="7">${t('rules.none')}</td></tr>`}</tbody>
    </table>`;
  renderRulesMobileList(data.items, { canEdit, canDelete, totalCount: filtered.length });
  ensureRulesApprovalMobileUi();
  ensureRulesToolbar();
  renderTableInfo('#rules-info', data, data.maxTotal);
  renderPagination('#rules-pagination', data, 'rules', loadRules);
if (editingRuleId) {
    const current = rules.find((r) => r.id === editingRuleId);
    if (current) loadRuleIntoForm(current, { activate: false });
    else resetRuleForm();
  } else {
    updateRuleFormUI();
    renderRuleConditionsPanel();
  }
  bindRuleRowClicks();
  bindRuleRowActions();
  applyRoleUi();
  activateRulesView(rulesActiveView);
  scheduleEnhanceResponsiveTables();
}

let requestsListCache = [];
let selectedRequestId = null;
let requestDrawerTab = 'details';

function requestPayload(r) {
  const p = r?.payload;
  return p && typeof p === 'object' ? p : {};
}

function requestNeedsDelivery(r) {
  return r?.status === 'FORWARDED' && !r?.forwardedToHostaway;
}

function requestDeliveryKind(r) {
  if (r?.forwardedToHostaway) return 'delivered';
  if (requestNeedsDelivery(r)) return 'failed';
  if (r?.status === 'PENDING') return 'pending';
  return 'na';
}

function requestGuestLabel(r) {
  const res = r?.reservation;
  if (!res) return t('requests.unknownGuest');
  return res.guestName || res.guestNameMasked || t('requests.unknownGuest');
}

function requestGuestAvatarHtml(r) {
  const url = String(r?.reservation?.guestPictureUrl || '').trim();
  const fallback = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
  const safeUrl = /^https?:\/\//i.test(url) ? url : '';
  return `
    <span class="requests-guest-avatar${safeUrl ? ' has-photo' : ''}" aria-hidden="true">
      ${safeUrl ? `<img class="requests-guest-avatar-img" src="${esc(safeUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" decoding="async" />` : ''}
      <span class="requests-guest-avatar-fallback">${fallback}</span>
    </span>`;
}

function requestReservationCode(r) {
  const id = r?.reservation?.hostawayId;
  return id != null ? `RES-${id}` : '—';
}

function requestTypeIconSvg(type) {
  const common = 'xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  switch (type) {
    case 'ADD_GUEST':
      return `<svg ${common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
    case 'ADD_PET':
      return `<svg ${common}><circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.07Q6.6 17.8 6 16.5 5 14 9 10z"/></svg>`;
    case 'EARLY_CHECKIN':
    case 'LATE_CHECKOUT':
      return `<svg ${common}><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`;
    case 'CANCELLATION':
      return `<svg ${common}><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>`;
    case 'MODIFICATION':
      return `<svg ${common}><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
    default:
      return `<svg ${common}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
  }
}

function requestTypeTone(type) {
  switch (type) {
    case 'ADD_GUEST': return 'guest';
    case 'ADD_PET': return 'pet';
    case 'EARLY_CHECKIN': return 'early';
    case 'LATE_CHECKOUT': return 'late';
    case 'CANCELLATION': return 'cancel';
    case 'MODIFICATION': return 'mod';
    default: return 'other';
  }
}

function requestDecisionMeta(status) {
  switch (status) {
    case 'FORWARDED':
      return { cls: 'is-forwarded', label: t('requests.decision.forwarded') };
    case 'AUTO_APPROVED':
      return { cls: 'is-auto', label: t('requests.decision.auto') };
    case 'PENDING':
      return { cls: 'is-pending', label: t('requests.decision.pending') };
    case 'REJECTED':
      return { cls: 'is-rejected', label: t('requests.decision.rejected') };
    case 'COMPLETED':
      return { cls: 'is-completed', label: t('requests.decision.completed') };
    default:
      return { cls: 'is-pending', label: status || '—' };
  }
}

function requestDeliveryMeta(r) {
  const kind = requestDeliveryKind(r);
  if (kind === 'delivered') {
    return {
      kind,
      cls: 'is-delivered',
      label: t('requests.delivery.forwarded'),
      icon: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>`,
    };
  }
  if (kind === 'failed') {
    return {
      kind,
      cls: 'is-failed',
      label: t('requests.delivery.failed'),
      icon: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`,
    };
  }
  if (kind === 'pending') {
    return {
      kind,
      cls: 'is-pending',
      label: t('requests.delivery.pending'),
      icon: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
    };
  }
  return { kind: 'na', cls: 'is-na', label: t('requests.inboxNa'), icon: '' };
}

function formatRequestDetailsSummary(details) {
  if (!details || typeof details !== 'object') return '';
  const skip = new Set(['note']);
  const parts = Object.entries(details)
    .filter(([k, v]) => !skip.has(k) && v != null && String(v).trim() !== '')
    .map(([k, v]) => `${k}: ${v}`);
  return parts.join(' · ');
}

function formatRequestStay(res) {
  if (!res?.arrivalDate || !res?.departureDate) return '—';
  const start = formatDate(res.arrivalDate);
  const end = formatDate(res.departureDate);
  const a = new Date(res.arrivalDate);
  const b = new Date(res.departureDate);
  let nights = '';
  if (!Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime())) {
    const n = Math.max(0, Math.round((b - a) / 86400000));
    nights = ` (${n} ${t('requests.nights')})`;
  }
  return `${start} – ${end}${nights}`;
}

function formatRequestGuests(res) {
  if (!res) return '—';
  const adults = res.adults ?? res.numberOfGuests;
  const children = res.children ?? 0;
  const parts = [];
  if (adults != null) parts.push(`${adults} ${t('requests.adults')}`);
  if (children) parts.push(`${children} ${t('requests.children')}`);
  return parts.join(', ') || '—';
}

function isRequestsMobile() {
  return window.matchMedia('(max-width: 1023px)').matches;
}

function requestChipIcon(kind) {
  const icons = {
    type: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    property: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    date: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    delivery: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
    chevron: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    home: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    retry: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.5-6.2"/><path d="M21 3v6h-6"/></svg>',
    more: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>',
  };
  return icons[kind] || '';
}

function requestCardStatusIcon(r) {
  const decision = requestDecisionMeta(r.status);
  const delivery = requestDeliveryMeta(r);
  const common = 'xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  if (delivery.kind === 'failed' || decision.cls === 'is-rejected') {
    return { cls: 'is-failed', svg: `<svg ${common}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>` };
  }
  if (decision.cls === 'is-auto' || decision.cls === 'is-completed') {
    return { cls: 'is-auto', svg: `<svg ${common}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>` };
  }
  if (decision.cls === 'is-forwarded' || delivery.kind === 'delivered') {
    return { cls: 'is-forwarded', svg: `<svg ${common}><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>` };
  }
  return { cls: 'is-pending', svg: `<svg ${common}><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>` };
}

function closeRequestsFilterSheet() {
  const sheet = $('#requests-filter-sheet');
  if (!sheet) return;
  sheet.classList.add('hidden');
  sheet.hidden = true;
  document.body.classList.remove('requests-filter-sheet-open');
}

function openRequestsFilterSheet(kind) {
  const sheet = $('#requests-filter-sheet');
  const body = $('#requests-filter-sheet-body');
  const titleEl = $('#requests-filter-sheet-title');
  if (!sheet || !body) return;
  const titles = {
    type: t('requests.filterType'),
    listing: t('requests.filterProperty'),
    delivery: t('requests.filterDelivery'),
    date: t('requests.filterDate'),
  };
  if (titleEl) titleEl.textContent = titles[kind] || 'Filter';
  const s = tableState.requests;

  if (kind === 'date') {
    body.innerHTML = `
      <div class="requests-filter-date-sheet">
        <label><span>${esc(t('requests.dateFrom'))}</span><input type="date" data-sheet-date="dateFrom" value="${esc(s.dateFrom || '')}" /></label>
        <label><span>${esc(t('requests.dateTo'))}</span><input type="date" data-sheet-date="dateTo" value="${esc(s.dateTo || '')}" /></label>
        <div class="requests-filter-date-actions">
          <button type="button" class="btn ghost" data-sheet-clear-dates>${esc(t('requests.filterClearDates'))}</button>
          <button type="button" class="btn primary" data-sheet-apply-dates>${esc(t('requests.filterApplyDates'))}</button>
        </div>
      </div>`;
    body.querySelector('[data-sheet-clear-dates]')?.addEventListener('click', () => {
      tableState.requests.dateFrom = '';
      tableState.requests.dateTo = '';
      tableState.requests.page = 1;
      ensureRequestsToolbar();
      closeRequestsFilterSheet();
      renderRequestsTable();
    });
    body.querySelector('[data-sheet-apply-dates]')?.addEventListener('click', () => {
      tableState.requests.dateFrom = body.querySelector('[data-sheet-date="dateFrom"]')?.value || '';
      tableState.requests.dateTo = body.querySelector('[data-sheet-date="dateTo"]')?.value || '';
      tableState.requests.page = 1;
      ensureRequestsToolbar();
      closeRequestsFilterSheet();
      renderRequestsTable();
    });
  } else {
    const selId =
      kind === 'type' ? '#requests-filter-type' : kind === 'listing' ? '#requests-filter-listing' : '#requests-filter-delivery';
    const sel = $(selId);
    if (!sel) return;
    const current = String(sel.value || '');
    body.innerHTML = `<div class="requests-filter-sheet-options">${[...sel.options]
      .map((opt) => {
        const value = String(opt.value ?? '');
        const label = String(opt.textContent || '').trim() || value;
        return `<button type="button" class="requests-filter-sheet-option${value === current ? ' is-selected' : ''}" data-value="${esc(value)}">${esc(label)}</button>`;
      })
      .join('')}</div>`;
    body.querySelectorAll('[data-value]').forEach((btn) => {
      btn.addEventListener('click', () => {
        sel.value = btn.getAttribute('data-value') ?? 'all';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        closeRequestsFilterSheet();
      });
    });
  }

  sheet.classList.remove('hidden');
  sheet.hidden = false;
  document.body.classList.add('requests-filter-sheet-open');
}

function syncRequestsFilterChips() {
  const s = tableState.requests;
  const setChip = (key, active, text) => {
    const chip = $(`[data-requests-chip="${key}"]`);
    if (!chip) return;
    chip.classList.toggle('is-active', !!active);
    const textEl = chip.querySelector('.requests-filter-chip-text');
    if (textEl && text) textEl.textContent = text;
  };
  const typeSel = $('#requests-filter-type');
  setChip('type', s.type !== 'all', typeSel?.selectedOptions?.[0]?.textContent?.trim() || t('requests.filterType'));
  const listingSel = $('#requests-filter-listing');
  setChip('listing', s.listingId !== 'all', listingSel?.selectedOptions?.[0]?.textContent?.trim() || t('requests.filterProperty'));
  const deliverySel = $('#requests-filter-delivery');
  setChip('delivery', s.delivery !== 'all', deliverySel?.selectedOptions?.[0]?.textContent?.trim() || t('requests.filterDelivery'));
  let dateText = t('requests.filterDate');
  const dateActive = !!(s.dateFrom || s.dateTo);
  if (s.dateFrom && s.dateTo) dateText = `${s.dateFrom} → ${s.dateTo}`;
  else if (s.dateFrom) dateText = s.dateFrom;
  else if (s.dateTo) dateText = s.dateTo;
  setChip('date', dateActive, dateText);
}

function ensureRequestsToolbar() {
  const el = $('#requests-toolbar');
  if (!el) return;
  const s = tableState.requests;
  const types = [...new Set(requestsListCache.map((r) => r.requestType).filter(Boolean))].sort();
  const listings = [];
  const seen = new Set();
  for (const r of requestsListCache) {
    const listing = r.reservation?.listing;
    if (!listing?.id || seen.has(listing.id)) continue;
    seen.add(listing.id);
    listings.push({ id: listing.id, name: listing.name || listing.id });
  }
  listings.sort((a, b) => a.name.localeCompare(b.name));

  el.innerHTML = `
    <div class="requests-toolbar-row">
      <label class="requests-search-field">
        <span>${esc(t('table.search'))}</span>
        <span class="requests-search">
          <svg class="requests-search-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="search" id="requests-search" value="${esc(s.search)}" placeholder="${esc(t('requests.searchPlaceholder'))}" autocomplete="off" aria-label="${esc(t('requests.searchPlaceholder'))}" />
        </span>
      </label>
      <div class="requests-filters-desktop">
        <label>
          <span>${esc(t('requests.dateFrom'))}</span>
          <span class="requests-date-field">
            <input type="date" id="requests-date-from" value="${esc(s.dateFrom || '')}" />
            <button type="button" class="requests-date-picker-btn" data-requests-date-picker="from" aria-label="${esc(t('reservations.openDatePicker'))}">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            </button>
          </span>
        </label>
        <label>
          <span>${esc(t('requests.dateTo'))}</span>
          <span class="requests-date-field">
            <input type="date" id="requests-date-to" value="${esc(s.dateTo || '')}" />
            <button type="button" class="requests-date-picker-btn" data-requests-date-picker="to" aria-label="${esc(t('reservations.openDatePicker'))}">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            </button>
          </span>
        </label>
        <label>
          <span>${esc(t('requests.filterType'))}</span>
          <select id="requests-filter-type">
            <option value="all">${esc(t('requests.filterAll'))}</option>
            ${types.map((type) => `<option value="${esc(type)}"${s.type === type ? ' selected' : ''}>${esc(t(`requestType.${type}`) || type)}</option>`).join('')}
          </select>
        </label>
        <label>
          <span>${esc(t('requests.filterProperty'))}</span>
          <select id="requests-filter-listing">
            <option value="all">${esc(t('requests.filterAll'))}</option>
            ${listings.map((l) => `<option value="${esc(l.id)}"${s.listingId === l.id ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}
          </select>
        </label>
        <label>
          <span>${esc(t('requests.filterDelivery'))}</span>
          <select id="requests-filter-delivery">
            <option value="all">${esc(t('requests.filterAll'))}</option>
            <option value="delivered"${s.delivery === 'delivered' ? ' selected' : ''}>${esc(t('requests.delivery.forwarded'))}</option>
            <option value="pending"${s.delivery === 'pending' ? ' selected' : ''}>${esc(t('requests.delivery.pending'))}</option>
            <option value="failed"${s.delivery === 'failed' ? ' selected' : ''}>${esc(t('requests.delivery.failed'))}</option>
          </select>
        </label>
        <label class="requests-clear-field">
          <span>&nbsp;</span>
          <button type="button" class="btn ghost btn-sm requests-clear-filters" id="requests-clear-filters">${esc(t('requests.clearFilters'))}</button>
        </label>
      </div>
      <div class="requests-mobile-chips" aria-label="Filters">
        <button type="button" class="requests-filter-chip" data-requests-chip="type">${requestChipIcon('type')}<span class="requests-filter-chip-text">${esc(t('requests.filterType'))}</span>${requestChipIcon('chevron')}</button>
        <button type="button" class="requests-filter-chip" data-requests-chip="listing">${requestChipIcon('property')}<span class="requests-filter-chip-text">${esc(t('requests.filterProperty'))}</span>${requestChipIcon('chevron')}</button>
        <button type="button" class="requests-filter-chip" data-requests-chip="date">${requestChipIcon('date')}<span class="requests-filter-chip-text">${esc(t('requests.filterDate'))}</span>${requestChipIcon('chevron')}</button>
        <button type="button" class="requests-filter-chip" data-requests-chip="delivery">${requestChipIcon('delivery')}<span class="requests-filter-chip-text">${esc(t('requests.filterDelivery'))}</span>${requestChipIcon('chevron')}</button>
      </div>
    </div>
  `;

  const search = $('#requests-search');
  search?.addEventListener('input', () => {
    clearTimeout(searchTimers.requests);
    searchTimers.requests = setTimeout(() => {
      tableState.requests.search = search.value.trim();
      tableState.requests.page = 1;
      renderRequestsTable();
    }, 200);
  });
  const openRequestsDatePicker = (input) => {
    if (!input) return;
    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
        return;
      }
    } catch (_) {
      /* fall through */
    }
    input.focus();
    input.click();
  };
  $$('[data-requests-date-picker]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const which = btn.dataset.requestsDatePicker;
      openRequestsDatePicker($(which === 'to' ? '#requests-date-to' : '#requests-date-from'));
    });
  });
  $('#requests-date-from')?.addEventListener('change', (e) => {
    tableState.requests.dateFrom = e.target.value;
    tableState.requests.page = 1;
    syncRequestsFilterChips();
    renderRequestsTable();
  });
  $('#requests-date-to')?.addEventListener('change', (e) => {
    tableState.requests.dateTo = e.target.value;
    tableState.requests.page = 1;
    syncRequestsFilterChips();
    renderRequestsTable();
  });
  $('#requests-filter-type')?.addEventListener('change', (e) => {
    tableState.requests.type = e.target.value;
    tableState.requests.page = 1;
    syncRequestsFilterChips();
    renderRequestsTable();
  });
  $('#requests-filter-listing')?.addEventListener('change', (e) => {
    tableState.requests.listingId = e.target.value;
    tableState.requests.page = 1;
    syncRequestsFilterChips();
    renderRequestsTable();
  });
  $('#requests-filter-delivery')?.addEventListener('change', (e) => {
    tableState.requests.delivery = e.target.value;
    tableState.requests.page = 1;
    syncRequestsFilterChips();
    renderRequestsTable();
  });
  $('#requests-clear-filters')?.addEventListener('click', () => {
    tableState.requests.search = '';
    tableState.requests.dateFrom = '';
    tableState.requests.dateTo = '';
    tableState.requests.type = 'all';
    tableState.requests.listingId = 'all';
    tableState.requests.delivery = 'all';
    tableState.requests.page = 1;
    ensureRequestsToolbar();
    renderRequestsTable();
  });
  $$('[data-requests-chip]').forEach((btn) => {
    btn.addEventListener('click', () => openRequestsFilterSheet(btn.getAttribute('data-requests-chip')));
  });
  syncRequestsFilterChips();
}

function filterRequestsList(list) {
  const s = tableState.requests;
  const q = (s.search || '').toLowerCase();
  const fromMs = s.dateFrom ? new Date(`${s.dateFrom}T00:00:00`).getTime() : null;
  const toMs = s.dateTo ? new Date(`${s.dateTo}T23:59:59`).getTime() : null;

  return list.filter((r) => {
    if (s.tab === 'pending' && r.status !== 'PENDING') return false;
    if (s.tab === 'forwarded' && r.status !== 'FORWARDED') return false;
    if (s.tab === 'auto' && r.status !== 'AUTO_APPROVED') return false;
    if (s.tab === 'failed' && !requestNeedsDelivery(r)) return false;

    if (s.type !== 'all' && r.requestType !== s.type) return false;
    if (s.listingId !== 'all' && r.reservation?.listing?.id !== s.listingId) return false;
    if (s.delivery !== 'all' && requestDeliveryKind(r) !== s.delivery) return false;

    const created = new Date(r.createdAt).getTime();
    if (fromMs != null && !Number.isNaN(fromMs) && created < fromMs) return false;
    if (toMs != null && !Number.isNaN(toMs) && created > toMs) return false;

    if (!q) return true;
    const hay = [
      r.createdAt,
      r.requestType,
      r.status,
      requestGuestLabel(r),
      requestReservationCode(r),
      r.reservation?.listing?.name,
      r.reservation?.hostawayId,
      r.id,
      formatRequestDetailsSummary(requestPayload(r).details),
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function renderRequestsStats(list) {
  const el = $('#requests-stats');
  if (!el) return;
  const total = list.length;
  const forwarded = list.filter((r) => r.status === 'FORWARDED').length;
  const auto = list.filter((r) => r.status === 'AUTO_APPROVED').length;
  const attention = list.filter((r) => requestNeedsDelivery(r) || r.status === 'PENDING').length;
  const pct = (n) => (total ? `${((n / total) * 100).toFixed(1)}%` : '0%');

  el.innerHTML = `
    <article class="requests-stat-card">
      <span class="requests-stat-icon is-total" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      </span>
      <div>
        <div class="requests-stat-value">${formatCount(total)}</div>
        <div class="requests-stat-label">${esc(t('requests.statTotal'))}</div>
        <div class="requests-stat-hint">${esc(t('requests.statAllTime'))}</div>
      </div>
    </article>
    <article class="requests-stat-card">
      <span class="requests-stat-icon is-forwarded" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
      </span>
      <div>
        <div class="requests-stat-value">${formatCount(forwarded)}</div>
        <div class="requests-stat-label">${esc(t('requests.statForwarded'))}</div>
        <div class="requests-stat-hint">${esc(t('requests.statOfTotal', { pct: pct(forwarded) }))}</div>
      </div>
    </article>
    <article class="requests-stat-card">
      <span class="requests-stat-icon is-auto" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></svg>
      </span>
      <div>
        <div class="requests-stat-value">${formatCount(auto)}</div>
        <div class="requests-stat-label">${esc(t('requests.statAuto'))}</div>
        <div class="requests-stat-hint">${esc(t('requests.statOfTotal', { pct: pct(auto) }))}</div>
      </div>
    </article>
    <article class="requests-stat-card">
      <span class="requests-stat-icon is-attention" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
      </span>
      <div>
        <div class="requests-stat-value">${formatCount(attention)}</div>
        <div class="requests-stat-label">
          <span class="requests-stat-label-full">${esc(t('requests.statAttention'))}</span>
          <span class="requests-stat-label-short">${esc(t('requests.statAttentionShort'))}</span>
        </div>
        <div class="requests-stat-hint">${esc(t('requests.statOfTotal', { pct: pct(attention) }))}</div>
      </div>
    </article>
  `;

  const counts = {
    pending: list.filter((r) => r.status === 'PENDING').length,
    forwarded,
    auto,
    failed: list.filter((r) => requestNeedsDelivery(r)).length,
  };
  Object.entries(counts).forEach(([key, n]) => {
    const badge = $(`[data-requests-count="${key}"]`);
    if (badge) badge.textContent = String(n);
  });
  $$('.requests-tab').forEach((btn) => {
    const active = btn.dataset.requestsTab === tableState.requests.tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function bindRequestRowActions() {
  $$('#requests-table [data-open-request], #requests-mobile-list [data-open-request]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      openRequestDrawer(el.dataset.openRequest);
    });
  });
  $$('#requests-table .retry-forward-btn, #requests-mobile-list .retry-forward-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!hasPermission('REQUESTS_MANAGE')) return;
      try {
        const result = await api(`/guest-requests/${btn.dataset.requestId}/retry-forward`, { method: 'POST' });
        if (result.forwarded) notify.success(t('requests.retryOk'));
        else notify.error(t('requests.retryFail', { message: result.error || result.message || 'unknown' }));
        loadRequests();
      } catch (ex) {
        notify.error(t('requests.retryFail', { message: ex.message }));
      }
    });
  });
  $$('#requests-table [data-request-more], #requests-mobile-list [data-request-more]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openRequestDrawer(btn.dataset.requestMore);
    });
  });
}

function renderRequestsMobile(items) {
  const root = $('#requests-mobile-list');
  if (!root) return;
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    root.innerHTML = `<div class="requests-m-empty">${esc(t('requests.none'))}</div>`;
    return;
  }
  root.innerHTML = list
    .map((r) => {
      const decision = requestDecisionMeta(r.status);
      const delivery = requestDeliveryMeta(r);
      const statusIcon = requestCardStatusIcon(r);
      const typeLabel = t(`requestType.${r.requestType}`) || r.requestType;
      const listing = r.reservation?.listing;
      const listingName = listing?.name || '—';
      const listingId = listing?.hostawayId != null ? String(listing.hostawayId) : '';
      const payload = requestPayload(r);
      const ruleText = payload.ruleReason || payload.ruleId || decision.label;
      const canRetry = requestNeedsDelivery(r) && hasPermission('REQUESTS_MANAGE');
      const badgeCls = delivery.kind === 'failed' ? 'is-failed' : decision.cls;
      const badgeLabel = delivery.kind === 'failed' ? delivery.label : decision.label;
      return `
      <article class="requests-m-card${selectedRequestId === r.id ? ' is-selected' : ''}" data-open-request="${esc(r.id)}">
        <div class="requests-m-card-main">
          <span class="requests-m-status-icon ${statusIcon.cls}" aria-hidden="true">${statusIcon.svg}</span>
          <div class="requests-m-card-body">
            <div class="requests-m-card-top">
              <div class="requests-m-card-heading">
                <div class="requests-m-time">${esc(formatPaymentImportTime(r.createdAt))}</div>
                <div class="requests-m-title">${esc(typeLabel)}</div>
                <div class="requests-m-guest">${esc(requestGuestLabel(r))} · ${esc(requestReservationCode(r))}</div>
              </div>
              <div class="requests-m-card-aside">
                <button type="button" class="requests-m-more" data-request-more="${esc(r.id)}" aria-label="${esc(t('requests.openDetails'))}">${requestChipIcon('more')}</button>
                <span class="requests-decision-badge ${badgeCls}">${esc(badgeLabel)}</span>
              </div>
            </div>
            <div class="requests-m-property">${requestChipIcon('home')}<span>${esc(listingName)}${listingId ? ` · ${esc(listingId)}` : ''}</span></div>
            <div class="requests-m-meta">
              <span>${esc(t('requests.ruleLabel', { rule: ruleText }))}</span>
              <span>${esc(t('requests.hostawayLabel', { status: delivery.label }))}</span>
            </div>
            ${canRetry ? `<div class="requests-m-actions"><button type="button" class="btn btn-sm requests-m-retry retry-forward-btn" data-request-id="${esc(r.id)}">${requestChipIcon('retry')}<span>${esc(t('requests.retry'))}</span></button></div>` : ''}
          </div>
        </div>
      </article>`;
    })
    .join('');
}

function renderRequestsTable() {
  const filtered = filterRequestsList(requestsListCache);
  const savedSearch = tableState.requests.search;
  tableState.requests.search = '';
  const pageData = paginateClient(filtered, 'requests', () => '');
  tableState.requests.search = savedSearch;

  const rows = pageData.items.map((r) => {
    const decision = requestDecisionMeta(r.status);
    const delivery = requestDeliveryMeta(r);
    const listing = r.reservation?.listing;
    const listingLine = listing
      ? `${esc(listing.name || '—')}<span class="requests-sub">${esc(listing.hostawayId != null ? String(listing.hostawayId) : '')}</span>`
      : '—';
    const canRetry = requestNeedsDelivery(r) && hasPermission('REQUESTS_MANAGE');
    const typeLabel = t(`requestType.${r.requestType}`) || r.requestType;
    return `
    <tr class="requests-row${selectedRequestId === r.id ? ' is-selected' : ''}" data-open-request="${esc(r.id)}">
      <td class="requests-col-time">${esc(formatDashboardDateTime(r.createdAt))}</td>
      <td>
        <div class="requests-guest-cell">
          ${requestGuestAvatarHtml(r)}
          <div>
            <strong>${esc(requestGuestLabel(r))}</strong>
            <span class="requests-sub">${esc(requestReservationCode(r))}</span>
          </div>
        </div>
      </td>
      <td>
        <span class="requests-type-chip tone-${requestTypeTone(r.requestType)}">
          <span class="requests-type-icon" aria-hidden="true">${requestTypeIconSvg(r.requestType)}</span>
          ${esc(typeLabel)}
        </span>
      </td>
      <td><div class="requests-property-cell">${listingLine}</div></td>
      <td><span class="requests-decision-badge ${decision.cls}">${esc(decision.label)}</span></td>
      <td>
        <span class="requests-delivery ${delivery.cls}">
          ${delivery.icon ? `<span aria-hidden="true">${delivery.icon}</span>` : ''}
          ${esc(delivery.label)}
        </span>
      </td>
      <td class="requests-col-actions" onclick="event.stopPropagation()">
        <div class="requests-actions">
          ${canRetry ? `<button type="button" class="btn btn-sm requests-retry-btn retry-forward-btn" data-request-id="${esc(r.id)}">${esc(t('requests.retry'))}</button>` : ''}
          <button type="button" class="requests-more-btn" data-request-more="${esc(r.id)}" aria-label="${esc(t('requests.openDetails'))}">⋮</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  $('#requests-table').innerHTML = `
    <table class="requests-table">
      <thead><tr>
        <th>${esc(t('requests.time'))}</th>
        <th>${esc(t('requests.guestReservation'))}</th>
        <th>${esc(t('requests.requestType'))}</th>
        <th>${esc(t('requests.property'))}</th>
        <th>${esc(t('requests.ruleDecision'))}</th>
        <th>${esc(t('requests.hostawayDelivery'))}</th>
        <th>${esc(t('requests.actions'))}</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="7" class="requests-empty">${esc(t('requests.none'))}</td></tr>`}</tbody>
    </table>`;

  renderRequestsMobile(pageData.items);
  renderTableInfo('#requests-info', pageData, pageData.maxTotal);
  renderPagination('#requests-pagination', pageData, 'requests', () => renderRequestsTable());
bindRequestRowActions();
  $$('#requests-table .requests-guest-avatar-img').forEach((img) => {
    img.addEventListener('error', () => {
      img.remove();
      img.closest('.requests-guest-avatar')?.classList.remove('has-photo');
    });
  });
  applyRoleUi();
}


function openRequestDrawer(id) {
  const r = requestsListCache.find((item) => item.id === id);
  const drawer = $('#request-drawer');
  if (!r || !drawer) return;
  selectedRequestId = id;
  requestDrawerTab = 'details';
  $$('#requests-table .requests-row, #requests-mobile-list .requests-m-card').forEach((row) => {
    row.classList.toggle('is-selected', row.dataset.openRequest === id);
  });

  const payload = requestPayload(r);
  const details = payload.details || {};
  const typeLabel = t(`requestType.${r.requestType}`) || r.requestType;
  const decision = requestDecisionMeta(r.status);
  const delivery = requestDeliveryMeta(r);
  const res = r.reservation;
  const listing = res?.listing;
  const canPii = hasPermission('RESERVATIONS_VIEW_PII') || adminRole === 'SUPER_ADMIN';
  const email = canPii ? (res?.guestEmail || '—') : (res?.guestEmail ? '••••' : '—');
  const phone = canPii ? (res?.guestPhone || '—') : (res?.guestPhone ? '••••' : '—');
  const note = details.note ? String(details.note) : '';
  const proposed = formatRequestDetailsSummary(details);
  const canRetry = requestNeedsDelivery(r) && hasPermission('REQUESTS_MANAGE');
  const originalDates = formatRequestStay(res);
  const requestedDates =
    details.requestedDates ||
    details.newDates ||
    details.checkIn ||
    details.checkOut ||
    proposed ||
    '—';

  $('#request-drawer-title').textContent = t('requests.drawerTitle', { type: typeLabel });
  const subParts = [requestReservationCode(r), listing?.name].filter(Boolean);
  const subEl = $('#request-drawer-sub');
  if (subEl) subEl.textContent = subParts.join(' · ');
  $('#request-drawer-id').textContent = `REQ-${r.id.slice(0, 8).toUpperCase()}`;
  $('#request-drawer-icon').className = `request-drawer-icon tone-${requestTypeTone(r.requestType)}`;
  $('#request-drawer-icon').innerHTML = requestTypeIconSvg(r.requestType);

  $$('[data-request-drawer-tab]').forEach((btn) => {
    const active = btn.dataset.requestDrawerTab === requestDrawerTab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const timeline = [];
  timeline.push({
    done: true,
    title: t('requests.timeline.received'),
    at: r.createdAt,
  });
  timeline.push({
    done: r.status !== 'PENDING',
    title: t('requests.timeline.evaluated', { decision: decision.label }),
    at: r.createdAt,
    meta: payload.ruleReason
      ? `${t('requests.timeline.rule')}: ${payload.ruleReason}`
      : payload.ruleId
        ? `${t('requests.timeline.rule')}: ${payload.ruleId}`
        : '',
  });
  if (r.status === 'FORWARDED' || r.forwardedToHostaway) {
    timeline.push({
      done: !!r.forwardedToHostaway,
      title: t('requests.timeline.forwardedHostaway'),
      at: r.updatedAt || r.createdAt,
      meta: t('requests.timeline.inbox'),
    });
  }

  const deliveryBlock =
    delivery.kind === 'na'
      ? ''
      : `
    <section class="request-drawer-section request-panel" data-request-panel="details">
      <h4>${esc(t('requests.hostawayDelivery'))}</h4>
      <div class="request-delivery-card ${delivery.cls}">
        <div class="request-delivery-card-top">
          <span class="requests-delivery ${delivery.cls}">${delivery.icon || ''}${esc(delivery.label)}</span>
          <span class="request-delivery-time">${esc(formatDashboardDateTime(r.updatedAt || r.createdAt))}</span>
        </div>
        ${
          delivery.kind === 'failed'
            ? `<p class="request-delivery-error">${esc(t('requests.deliveryErrorDefault'))}</p>
        <p class="request-delivery-attempt">${esc(t('requests.lastAttempt'))}: ${esc(formatDashboardDateTime(r.updatedAt || r.createdAt))}</p>`
            : ''
        }
        ${
          delivery.kind === 'delivered' && r.hostawayMessageId != null
            ? `<p class="muted">${esc(t('requests.messageId'))}: ${esc(String(r.hostawayMessageId))}</p>`
            : ''
        }
      </div>
    </section>`;

  const footer = $('#request-drawer-footer');
  if (footer) {
    if (canRetry) {
      footer.hidden = false;
      footer.innerHTML = `
        <button type="button" class="btn primary requests-retry-delivery-btn retry-forward-btn" data-request-id="${esc(r.id)}">
          ${requestChipIcon('retry')}
          ${esc(t('requests.retryDelivery'))}
        </button>`;
    } else {
      footer.hidden = true;
      footer.innerHTML = '';
    }
  }

  $('#request-drawer-body').innerHTML = `
    <section class="request-drawer-section request-panel is-active" data-request-panel="details">
      <h4>${esc(t('requests.summary'))}</h4>
      <div class="request-m-detail-list">
        <div class="request-m-detail-line"><span class="request-m-detail-ico tone-${requestTypeTone(r.requestType)}" aria-hidden="true">${requestTypeIconSvg(r.requestType)}</span><div><div class="muted">${esc(t('requests.typeLabel'))}</div><strong>${esc(typeLabel)}</strong></div></div>
        <div class="request-m-detail-line"><span class="request-m-detail-ico" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span><div><div class="muted">${esc(t('requests.messageLabel'))}</div><strong>“${esc(note || t('requests.noGuestMessage'))}”</strong></div></div>
        <div class="request-m-detail-line"><span class="request-m-detail-ico" aria-hidden="true">${requestChipIcon('date')}</span><div><div class="muted">${esc(t('requests.originalDates'))}</div><strong>${esc(originalDates)}</strong></div></div>
        <div class="request-m-detail-line"><span class="request-m-detail-ico" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></span><div><div class="muted">${esc(t('requests.requestedDates'))}</div><strong>${esc(String(requestedDates))}</strong></div></div>
      </div>
      <dl class="request-kv request-desktop-kv">
        <div><dt>${esc(t('requests.requestedOn'))}</dt><dd>${esc(formatDashboardDateTime(r.createdAt))}</dd></div>
        <div><dt>${esc(t('requests.guestMessage'))}</dt><dd>${esc(note || t('requests.noGuestMessage'))}</dd></div>
        <div><dt>${esc(t('requests.proposedChange'))}</dt><dd>${esc(proposed || '—')}</dd></div>
      </dl>
    </section>
    ${deliveryBlock}
    <section class="request-drawer-section request-panel" data-request-panel="guest">
      <h4>${esc(t('requests.verifiedGuest'))}</h4>
      <dl class="request-kv">
        <div><dt>${esc(t('requests.guestName'))}</dt><dd>${esc(requestGuestLabel(r))}</dd></div>
        <div><dt>${esc(t('requests.email'))}</dt><dd>${esc(email)}</dd></div>
        <div><dt>${esc(t('requests.phone'))}</dt><dd>${esc(phone)}</dd></div>
        <div><dt>${esc(t('requests.reservation'))}</dt><dd>
          ${
            res?.hostawayId != null
              ? `<button type="button" class="link-btn" data-open-reservation="${esc(String(res.hostawayId))}">${esc(requestReservationCode(r))} ↗</button>`
              : '—'
          }
        </dd></div>
        <div><dt>${esc(t('requests.stay'))}</dt><dd>${esc(formatRequestStay(res))}</dd></div>
        <div><dt>${esc(t('requests.guests'))}</dt><dd>${esc(formatRequestGuests(res))}</dd></div>
      </dl>
    </section>
    <section class="request-drawer-section request-panel" data-request-panel="timeline">
      <h4>${esc(t('requests.decisionTimeline'))}</h4>
      <ol class="request-timeline">
        ${timeline
          .map(
            (item) => `
          <li class="${item.done ? 'is-done' : 'is-todo'}">
            <div class="request-timeline-dot" aria-hidden="true"></div>
            <div>
              <div class="request-timeline-title">${esc(item.title)}</div>
              <div class="request-timeline-at">${esc(formatDashboardDateTime(item.at))}</div>
              ${item.meta ? `<div class="request-timeline-meta">${esc(item.meta)}</div>` : ''}
            </div>
          </li>`,
          )
          .join('')}
      </ol>
    </section>
    ${
      canRetry
        ? `<section class="request-drawer-section request-drawer-retry request-desktop-retry">
      <p class="muted">${esc(t('requests.retryHint'))}</p>
      <button type="button" class="btn requests-retry-delivery-btn retry-forward-btn" data-request-id="${esc(r.id)}">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
        ${esc(t('requests.retryDelivery'))}
      </button>
    </section>`
        : ''
    }
  `;

  syncRequestDrawerPanels();
  drawer.classList.remove('hidden');
  drawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('request-drawer-open');

  const bindRetry = (btn) => {
    btn?.addEventListener('click', async () => {
      if (!hasPermission('REQUESTS_MANAGE')) return;
      try {
        const result = await api(`/guest-requests/${r.id}/retry-forward`, { method: 'POST' });
        if (result.forwarded) notify.success(t('requests.retryOk'));
        else notify.error(t('requests.retryFail', { message: result.error || result.message || 'unknown' }));
        await loadRequests();
        if (selectedRequestId) openRequestDrawer(selectedRequestId);
      } catch (ex) {
        notify.error(t('requests.retryFail', { message: ex.message }));
      }
    });
  };
  $$('#request-drawer .retry-forward-btn').forEach(bindRetry);
  $('#request-drawer-body [data-open-reservation]')?.addEventListener('click', (e) => {
    const hostawayId = Number(e.currentTarget.dataset.openReservation);
    if (Number.isFinite(hostawayId) && typeof openReservationDrawer === 'function') {
      openReservationDrawer(hostawayId);
    }
  });
}

function syncRequestDrawerPanels() {
  $$('[data-request-drawer-tab]').forEach((btn) => {
    const active = btn.dataset.requestDrawerTab === requestDrawerTab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $$('#request-drawer-body [data-request-panel]').forEach((panel) => {
    const match = panel.dataset.requestPanel === requestDrawerTab;
    panel.classList.toggle('is-active', match);
  });
}

function closeRequestDrawer() {
  const drawer = $('#request-drawer');
  if (!drawer) return;
  drawer.classList.add('hidden');
  drawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('request-drawer-open');
  selectedRequestId = null;
  $$('#requests-table .requests-row, #requests-mobile-list .requests-m-card').forEach((row) =>
    row.classList.remove('is-selected'),
  );
  const footer = $('#request-drawer-footer');
  if (footer) {
    footer.hidden = true;
    footer.innerHTML = '';
  }
}

async function loadRequests() {
  const requests = await api('/guest-requests');
  requestsListCache = Array.isArray(requests) ? requests : [];
  renderRequestsStats(requestsListCache);
  ensureRequestsToolbar();
  renderRequestsTable();
  if (selectedRequestId && requestsListCache.some((r) => r.id === selectedRequestId)) {
    openRequestDrawer(selectedRequestId);
  }
}

$$('.requests-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    tableState.requests.tab = btn.dataset.requestsTab || 'all';
    tableState.requests.page = 1;
    renderRequestsStats(requestsListCache);
    renderRequestsTable();
  });
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-request-drawer-close]')) closeRequestDrawer();
  if (e.target.closest('[data-requests-filter-close]')) closeRequestsFilterSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#request-drawer')?.classList.contains('hidden')) {
    closeRequestDrawer();
  }
  if (e.key === 'Escape' && !$('#requests-filter-sheet')?.classList.contains('hidden')) {
    closeRequestsFilterSheet();
  }
});

$$('[data-request-drawer-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    requestDrawerTab = btn.dataset.requestDrawerTab || 'details';
    syncRequestDrawerPanels();
  });
});

function paymentStatusBadge(status) {
  const cls =
    status === 'AUTO_APPLIED' || status === 'MANUALLY_APPLIED'
      ? 'live'
      : status === 'FAILED'
        ? 'manual'
        : status === 'PENDING_REVIEW'
          ? 'manual'
          : 'auto';
  const label = t(`payments.status.${status}`) || status;
  return `<span class="badge ${cls}">${label}</span>`;
}

/** History board status pills: Auto / By admin / Pending / Needs review / Skip */
function paymentHistoryStatusMeta(status) {
  if (status === 'AUTO_APPLIED') {
    return { key: 'matched', cls: 'is-ok is-auto', label: t('payments.historyStatus.auto') };
  }
  if (status === 'MANUALLY_APPLIED') {
    return { key: 'matched', cls: 'is-ok is-admin', label: t('payments.historyStatus.byAdmin') };
  }
  if (status === 'PENDING_REVIEW') {
    return { key: 'needs_review', cls: 'is-warn', label: t('payments.historyStatus.needsReview') };
  }
  if (status === 'SKIPPED') {
    return { key: 'skipped', cls: 'is-skip', label: t('payments.historyStatus.skipped') };
  }
  if (status === 'FAILED') {
    return { key: 'failed', cls: 'is-err', label: t('payments.historyStatus.failed') };
  }
  return { key: 'pending', cls: 'is-pending', label: t('payments.historyStatus.pending') };
}

function paymentHistoryStatusBadge(status) {
  const meta = paymentHistoryStatusMeta(status);
  return `<span class="payment-history-status ${meta.cls}"><span class="payment-history-status-dot" aria-hidden="true"></span>${esc(meta.label)}</span>`;
}

/** Offline (archived listing, local ledger) vs real Hostaway charge. */
function isPaymentOfflineApply(payment) {
  if (!payment) return false;
  const status = payment.status;
  if (status !== 'AUTO_APPLIED' && status !== 'MANUALLY_APPLIED') return false;
  const reason = `${payment.matchReason || ''} ${payment.reviewNote || ''}`.toLowerCase();
  if (/archiv|offline|local apply|without hostaway|kein hostaway/i.test(reason)) {
    return true;
  }
  const allocs = Array.isArray(payment.allocations) ? payment.allocations : [];
  const hasHostawayCharge =
    payment.hostawayChargeId != null ||
    allocs.some((a) => a && a.hostawayChargeId != null);
  return !hasHostawayCharge;
}

function paymentApplyModeHint(payment) {
  if (!payment) return '';
  if (payment.status !== 'AUTO_APPLIED' && payment.status !== 'MANUALLY_APPLIED') {
    return '';
  }
  if (isPaymentOfflineApply(payment)) {
    return `<span class="payment-history-apply-hint is-offline" title="${esc(t('payments.applyHint.offlineTitle'))}">${esc(t('payments.applyHint.offline'))}</span>`;
  }
  const chargeId = payment.hostawayChargeId;
  const label =
    chargeId != null
      ? t('payments.applyHint.hostawayWithId', { id: String(chargeId) })
      : t('payments.applyHint.hostaway');
  return `<span class="payment-history-apply-hint is-hostaway" title="${esc(t('payments.applyHint.hostawayTitle'))}">${esc(label)}</span>`;
}

function paymentHistorySourceLabel(source) {
  const key = `payments.sourceLabel.${String(source || '').toUpperCase()}`;
  const label = t(key);
  return label === key ? (source || '–') : label;
}

function reservationPaidAmount(reservation) {
  if (reservation?.paidAmount != null && Number.isFinite(Number(reservation.paidAmount))) {
    return Number(reservation.paidAmount);
  }
  const charges = Array.isArray(reservation?.notifiedCharges) ? reservation.notifiedCharges : [];
  const fromCharges = charges.reduce(
    (sum, charge) => sum + (Number(charge?.amount) > 0 ? Number(charge.amount) : 0),
    0,
  );
  if (reservation?.isPaid === true && reservation?.totalPrice != null) {
    return Math.max(fromCharges, Number(reservation.totalPrice) || 0);
  }
  return fromCharges > 0 ? fromCharges : null;
}

function formatMoney(amount, currency = 'EUR') {
  if (amount == null || !Number.isFinite(Number(amount))) return '–';
  try {
    return new Intl.NumberFormat(locale(), {
      style: 'currency',
      currency: currency || 'EUR',
    }).format(Number(amount));
  } catch {
    return `${Number(amount).toFixed(2)} ${currency}`;
  }
}

/** Short date+time for the payment review list (e.g. 31/08/2026 - 14:41). */
function formatCompactDateTime(value) {
  if (!value) return '–';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const day = pad2(d.getDate());
  const month = pad2(d.getMonth() + 1);
  const year = d.getFullYear();
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (getLang() === 'de') return `${day}.${month}.${year} - ${time}`;
  return `${day}/${month}/${year} - ${time}`;
}

function formatDayMonthYear(value) {
  if (!value) return '';
  const raw = String(value).slice(0, 10);
  let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, day] = raw.split('-').map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(value);
  }
  if (Number.isNaN(d.getTime())) return String(value);
  const day = pad2(d.getDate());
  const month = pad2(d.getMonth() + 1);
  const year = d.getFullYear();
  return getLang() === 'de' ? `${day}.${month}.${year}` : `${day}/${month}/${year}`;
}

function formatStayDates(arrival, departure) {
  if (!arrival && !departure) return '';
  const a = formatDayMonthYear(arrival);
  const b = departure ? formatDayMonthYear(departure) : '';
  if (!b) return a;
  return `${a} – ${b}`;
}

/** Compact label for dropdown / search options */
function formatReservationOption(c, currency = 'EUR') {
  const id = c.hostawayId ?? c.id;
  const guest = c.guestName || '';
  const listing = c.listingName || c.listing?.name || '';
  const dates = formatStayDates(c.arrivalDate, c.departureDate);
  const total = c.totalPrice != null ? formatMoney(c.totalPrice, currency) : '';
  const balance = c.balanceDue != null ? formatMoney(c.balanceDue, currency) : '';
  const channel = c.channelName ? prettyChannel(c.channelName) : '';
  return [
    `#${id}`,
    channel ? `[${channel}]` : '',
    guest,
    listing,
    dates,
    total ? `total ${total}` : '',
    balance && balance !== total ? `due ${balance}` : '',
  ].filter(Boolean).join(' — ');
}

/**
 * Short label for &lt;select&gt; options so the native picker does not overflow
 * on narrow / mobile layouts (full text still available via title on the select).
 */
function formatReservationOptionShort(c, currency = 'EUR') {
  const id = c.hostawayId ?? c.id;
  const guest = String(c.guestName || '').trim();
  const guestShort =
    guest.length > 28 ? `${guest.slice(0, 26)}…` : guest;
  const dates = formatStayDates(c.arrivalDate, c.departureDate);
  const balance =
    c.balanceDue != null
      ? formatMoney(c.balanceDue, currency)
      : c.totalPrice != null
        ? formatMoney(c.totalPrice, currency)
        : '';
  const channel = c.channelName ? prettyChannel(c.channelName) : '';
  return [
    `#${id}`,
    channel ? `[${channel}]` : '',
    guestShort,
    dates,
    balance ? balance : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function paymentDecisionLabel(decision) {
  if (!decision) return '–';
  const key = `payments.decision.${decision}`;
  const label = t(key);
  return label === key ? decision : label;
}

/** Map backend matcher reason strings (always English) to the active UI language. */
function translatePaymentMatchReason(reason) {
  const r = String(reason || '').trim();
  if (!r) return '';
  if (r.includes('; ')) {
    return r
      .split('; ')
      .map((part) => translatePaymentMatchReason(part))
      .filter(Boolean)
      .join('; ');
  }

  const rules = [
    { re: /^Guest email matches$/, key: 'payments.reason.guestEmail' },
    { re: /^Guest name matches$/, key: 'payments.reason.guestName' },
    { re: /^Guest name appears in reference$/, key: 'payments.reason.guestNameInRef' },
    { re: /^Listing name appears in reference$/, key: 'payments.reason.listingInRef' },
    { re: /^Stay dates appear in reference$/, key: 'payments.reason.datesInRef' },
    { re: /^Payment amount aligns with reference$/, key: 'payments.reason.amountInRef' },
    {
      re: /^Amount matches a typical deposit\/installment share of the total$/,
      key: 'payments.reason.depositShareTypical',
    },
    {
      re: /^Amount matches a likely deposit\/installment share of the total$/,
      key: 'payments.reason.depositShareLikely',
    },
    {
      re: /^Amount matches a likely deposit\/installment share of the outstanding balance$/,
      key: 'payments.reason.depositShareBalance',
    },
    { re: /^Payment amount appears in reservation notes$/, key: 'payments.reason.amountInNotes' },
    {
      re: /^Reservation notes mention a deposit or remaining balance$/,
      key: 'payments.reason.depositMentionedInNotes',
    },
    {
      re: /^Reservation #(\d+) in reference$/,
      key: 'payments.reason.reservationInRef',
      pick: (m) => ({ id: m[1] }),
    },
    {
      re: /^Amount equals outstanding balance \(([0-9.]+)\)$/,
      key: 'payments.reason.amountEqualsBalance',
      pick: (m) => ({ amount: m[1] }),
    },
    {
      re: /^Amount equals next installment due \(([0-9.]+)\)$/,
      key: 'payments.reason.amountEqualsNextDue',
      pick: (m) => ({ amount: m[1] }),
    },
    {
      re: /^Amount equals reservation total \(([0-9.]+)\)$/,
      key: 'payments.reason.amountEqualsTotal',
      pick: (m) => ({ amount: m[1] }),
    },
    {
      re: /^Guest match with Restzahlung\/Teilzahlung fits the outstanding balance$/,
      key: 'payments.reason.restzahlungPartial',
    },
    {
      re: /^Soft amount guess: ~30\/50\/70% of booking total$/,
      key: 'payments.reason.softAmountPercent',
    },
    {
      re: /^Soft amount guess: within deposit\/installment range of total$/,
      key: 'payments.reason.softAmountRange',
    },
    {
      re: /^Soft amount guess: close to reservation total \(([0-9.]+)\)$/,
      key: 'payments.reason.softAmountCloseTotal',
      pick: (m) => ({ amount: m[1] }),
    },
    {
      re: /^Soft amount guess: fits within outstanding balance$/,
      key: 'payments.reason.softAmountInBalance',
    },
  ];

  for (const rule of rules) {
    const m = r.match(rule.re);
    if (m) return t(rule.key, rule.pick ? rule.pick(m) : undefined);
  }
  return r;
}

/**
 * Build a reviewer-friendly explanation without internal match scores.
 * Works for already-stored queue items too (recomputes from candidates).
 */
function explainWhyNotAutoMatched(payment) {
  const decision = payment.matchDecision || '';
  const candidates = Array.isArray(payment.matchCandidates) ? payment.matchCandidates : [];
  const reservation = payment.matchedReservation;
  const best =
    candidates.find((c) => Number(c.hostawayId) === Number(reservation?.hostawayId)) ||
    candidates[0];
  const second = candidates.find((c) => Number(c.hostawayId) !== Number(best?.hostawayId));
  const reasons = Array.isArray(best?.reasons) ? best.reasons : [];
  const reasonText = reasons.join(' ').toLowerCase();
  const amountLabel = formatMoney(payment.amount, payment.currency || 'EUR');

  const missing = [];
  if (!/reservation #\d+/.test(reasonText)) {
    missing.push(t('payments.missing.reservationNumber'));
  }
  if (!reasonText.includes('email')) {
    missing.push(t('payments.missing.guestEmail'));
  }
  const amountOk =
    reasonText.includes('equals outstanding balance') ||
    reasonText.includes('equals reservation total') ||
    reasonText.includes('deposit/installment') ||
    reasonText.includes('payment amount aligns') ||
    reasonText.includes('appears in reservation notes');
  if (!amountOk) {
    if (best?.balanceDue != null && best?.totalPrice != null) {
      missing.push(
        t('payments.missing.amountBoth', {
          amount: amountLabel,
          total: formatMoney(best.totalPrice, payment.currency || 'EUR'),
          due: formatMoney(best.balanceDue, payment.currency || 'EUR'),
        }),
      );
    } else if (best?.totalPrice != null) {
      missing.push(
        t('payments.missing.amountTotal', {
          amount: amountLabel,
          total: formatMoney(best.totalPrice, payment.currency || 'EUR'),
        }),
      );
    } else {
      missing.push(t('payments.missing.amountUnknown', { amount: amountLabel }));
    }
  }
  if (!reasonText.includes('listing name')) {
    missing.push(t('payments.missing.listing'));
  }
  if (!reasonText.includes('stay dates')) {
    missing.push(t('payments.missing.dates'));
  }

  if (decision === 'AMBIGUOUS' && best && second) {
    return t('payments.why.ambiguous', {
      a: `#${best.hostawayId}${best.guestName ? ` (${best.guestName})` : ''}`,
      b: `#${second.hostawayId}${second.guestName ? ` (${second.guestName})` : ''}`,
    });
  }

  if (decision === 'NO_MATCH') {
    return t('payments.why.noMatch');
  }

  const translatedReasons = reasons.map(translatePaymentMatchReason);
  const found = translatedReasons.length
    ? t('payments.why.matchedOn', { signals: translatedReasons.join('; ') })
    : t('payments.why.weakMatch');
  const missingText = missing.length
    ? ` ${t('payments.why.missingBecause', { missing: missing.join('; ') })}`
    : ` ${t('payments.why.needsConfirmation')}`;
  return `${found}${missingText}`;
}

let expandableSeq = 0;

/**
 * Render text collapsed to `shortLen` chars with a "more / less" toggle.
 * Falls back to plain text when it already fits.
 */
function renderExpandableText(text, shortLen = 90) {
  const full = String(text || '').trim();
  if (!full) return '';
  if (full.length <= shortLen) return esc(full);
  const cut = full.slice(0, shortLen);
  const short = cut.slice(0, Math.max(cut.lastIndexOf(' '), 40));
  const id = `exp-${++expandableSeq}`;
  return `<span class="expandable" data-exp-id="${id}">` +
    `<span class="expandable-short">${esc(short)}… ` +
    `<a href="#" class="expandable-toggle" data-exp-target="${id}" data-exp-action="more">${t('ui.more')}</a></span>` +
    `<span class="expandable-full hidden">${esc(full)} ` +
    `<a href="#" class="expandable-toggle" data-exp-target="${id}" data-exp-action="less">${t('ui.less')}</a></span>` +
    `</span>`;
}

function bindExpandableToggles(rootSelector) {
  const root = $(rootSelector);
  if (!root || root.dataset.expBound) return;
  root.dataset.expBound = '1';
  root.addEventListener('click', (event) => {
    const link = event.target.closest('.expandable-toggle');
    if (!link) return;
    event.preventDefault();
    const wrap = link.closest('.expandable');
    if (!wrap) return;
    wrap.querySelector('.expandable-short')?.classList.toggle('hidden');
    wrap.querySelector('.expandable-full')?.classList.toggle('hidden');
  });
}

/** Deep-link into the Hostaway dashboard reservation detail page. */
function hostawayReservationUrl(hostawayId) {
  const id = Number(hostawayId);
  if (!id) return null;
  return `https://dashboard.hostaway.com/reservations/${id}`;
}

function renderOpenInHostawayButton(hostawayId, extraClass = '') {
  const url = hostawayReservationUrl(hostawayId);
  if (!url) return '';
  return `<a class="btn payment-btn-hostaway btn-sm payment-open-hostaway ${extraClass}"
    href="${esc(url)}" target="_blank" rel="noopener noreferrer"
    data-hostaway-id="${idOrEmpty(hostawayId)}"
    title="${t('payments.openInHostawayHint')}">
    <span>${t('payments.openInHostaway')}</span>
    <svg class="payment-ext-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">
      <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        d="M14 3h7v7M10 14 21 3M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6"/>
    </svg>
  </a>`;
}

function idOrEmpty(hostawayId) {
  const id = Number(hostawayId);
  return id || '';
}

/**
 * True when the booking came from an OTA where the base stay is paid
 * on-platform (so a later direct bank/PayPal payment is an extra charge).
 * The direct "bookingengine" channel is explicitly excluded.
 */
function isOtaChannel(channelName) {
  const c = String(channelName || '').toLowerCase();
  if (c.includes('bookingengine')) return false;
  return /airbnb|bookingcom|booking\.com|vrbo|expedia|homeaway|agoda/.test(c);
}

/** Colored badge for the booking source / channel. */
function renderChannelBadge(channelName) {
  if (!channelName) return '';
  const c = String(channelName).toLowerCase();
  let cls = 'channel-ota';
  if (c.includes('airbnb')) cls = 'channel-airbnb';
  else if (c.includes('bookingengine')) cls = 'channel-direct';
  else if (c.includes('booking')) cls = 'channel-booking';
  else if (c.includes('vrbo') || c.includes('homeaway')) cls = 'channel-vrbo';
  else if (c.includes('expedia')) cls = 'channel-expedia';
  else if (!isOtaChannel(c)) cls = 'channel-direct';
  return `<span class="channel-badge ${cls}" title="${t('payments.channel')}">${esc(prettyChannel(channelName))}</span>`;
}

function prettyChannel(channelName) {
  const c = String(channelName || '').toLowerCase();
  if (c.includes('airbnb')) return 'Airbnb';
  if (c.includes('bookingengine')) return t('payments.channelDirect');
  if (c.includes('bookingcom') || c.includes('booking.com')) return 'Booking.com';
  if (c.includes('vrbo') || c.includes('homeaway')) return 'Vrbo';
  if (c.includes('expedia')) return 'Expedia';
  if (c.includes('ical')) return 'iCal';
  if (c === 'direct' || c.includes('website') || c.includes('manual') || c.includes('partner'))
    return t('payments.channelDirect');
  return channelName;
}

/**
 * Classify how this bank payment relates to the booking total.
 * - full: settles total or outstanding balance
 * - partial: installment/deposit toward the booking (booking stays not fully paid)
 * - additional: extra charge (OTA extras, Nachbuchung, over-balance)
 */
function classifyPaymentKind(payment, totalPrice, balanceDue, channelName, hostNote) {
  const amount = payment?.amount;
  if (amount == null || amount <= 0) return null;

  const amountMatchesTotal =
    totalPrice != null && Math.abs(amount - totalPrice) < 0.5;
  const amountMatchesBalance =
    balanceDue != null && Math.abs(amount - balanceDue) < 0.5;
  if (amountMatchesTotal || amountMatchesBalance) return 'full';

  const noteText = String(hostNote || '').toLowerCase();
  const notesSayExtra =
    /nachbuchung|zusatzperson|zusätzliche|zusatzgast|extra (person|guest|night)|4\.\s*person|additional guest/.test(
      noteText,
    );
  const overBalance = balanceDue != null && amount > balanceDue + 0.5;
  const remainingAfter =
    balanceDue != null
      ? Math.round((balanceDue - amount) * 100) / 100
      : totalPrice != null
        ? Math.round((totalPrice - amount) * 100) / 100
        : null;

  // Amount clearly toward an open booking total → partial (deposit / installment)
  const looksPartial =
    remainingAfter != null &&
    remainingAfter > 0.5 &&
    !overBalance &&
    !notesSayExtra;

  if (looksPartial) return 'partial';
  if (notesSayExtra || overBalance || isOtaChannel(channelName)) return 'additional';
  if (totalPrice != null && amount < totalPrice) return 'partial';
  return null;
}

/**
 * Payment breakdown so a reviewer can see, at a glance, whether this is a
 * full settlement, a partial/deposit payment, or an extra charge.
 * Distinguishes already-recorded payments from this incoming bank payment.
 */
function renderPaymentMath(
  payment,
  totalPrice,
  balanceDue,
  channelName,
  hostNote = null,
  alreadyPaid = null,
  paymentPlan = null,
) {
  if (totalPrice == null && balanceDue == null && !(paymentPlan?.nextDueAmount > 0)) return '';
  const currency = payment?.currency || paymentPlan?.currency || 'EUR';
  const amount = payment?.amount != null ? Number(payment.amount) : null;
  const kind = classifyPaymentKind(payment, totalPrice, balanceDue, channelName, hostNote);

  let paidSoFar = alreadyPaid != null && Number.isFinite(Number(alreadyPaid))
    ? Math.max(0, Number(alreadyPaid))
    : null;
  if (
    paidSoFar == null &&
    totalPrice != null &&
    balanceDue != null &&
    Number.isFinite(Number(totalPrice)) &&
    Number.isFinite(Number(balanceDue))
  ) {
    paidSoFar = Math.max(0, Math.round((Number(totalPrice) - Number(balanceDue)) * 100) / 100);
  }
  if (paidSoFar == null) paidSoFar = 0;

  const remainingBefore =
    balanceDue != null && Number.isFinite(Number(balanceDue))
      ? Math.max(0, Number(balanceDue))
      : totalPrice != null
        ? Math.max(0, Math.round((Number(totalPrice) - paidSoFar) * 100) / 100)
        : null;

  const remainingAfter =
    amount != null && remainingBefore != null
      ? Math.max(0, Math.round((remainingBefore - amount) * 100) / 100)
      : null;

  let badge = '';
  let hint = '';
  let boxClass = 'payment-math';
  if (kind === 'partial') {
    boxClass += ' is-partial';
    badge = `<span class="payment-kind-badge payment-partial-badge">${t('payments.partialPayment')}</span>`;
    hint = t('payments.partialPaymentHint');
  } else if (kind === 'additional') {
    boxClass += ' is-additional';
    badge = `<span class="payment-kind-badge payment-additional-badge">${t('payments.additionalPayment')}</span>`;
    hint = isOtaChannel(channelName)
      ? t('payments.additionalPaymentOta', { channel: prettyChannel(channelName) })
      : t('payments.additionalPaymentHint');
  } else if (kind === 'full') {
    boxClass += ' is-full';
    badge = `<span class="payment-kind-badge payment-full-badge">${t('payments.fullPayment')}</span>`;
  }

  const lines = [];
  if (paymentPlan?.enabled && paymentPlan.nextDueAmount != null && Number(paymentPlan.nextDueAmount) > 0) {
    boxClass += ' has-plan';
    lines.push(
      `<div class="payment-math-line is-plan">
        <span class="payment-math-k">${esc(t('payments.suggestionNextDue'))}</span>
        <span class="payment-math-v">${esc(formatMoney(paymentPlan.nextDueAmount, currency))}${
          paymentPlan.nextDueAt ? ` · ${esc(formatDate(paymentPlan.nextDueAt))}` : ''
        }</span>
      </div>`,
    );
  }
  if (totalPrice != null && (kind === 'partial' || kind === 'full' || kind === 'additional')) {
    lines.push(
      `<div class="payment-math-line">
        <span class="payment-math-k">${esc(t('payments.alreadyPaidLabel'))}</span>
        <span class="payment-math-v">${esc(t('payments.paidOfTotalValue', {
          paid: formatMoney(paidSoFar, currency),
          total: formatMoney(totalPrice, currency),
        }))}</span>
      </div>`,
    );
    if (amount != null && remainingBefore != null) {
      lines.push(
        `<div class="payment-math-line is-focus">
          <span class="payment-math-k">${esc(t('payments.thisPayment'))}</span>
          <span class="payment-math-v">${esc(t('payments.thisPaymentOfRemaining', {
            amount: formatMoney(amount, currency),
            remaining: formatMoney(remainingBefore, currency),
          }))}</span>
        </div>`,
      );
    } else if (amount != null) {
      lines.push(
        `<div class="payment-math-line is-focus">
          <span class="payment-math-k">${esc(t('payments.thisPayment'))}</span>
          <span class="payment-math-v">${esc(formatMoney(amount, currency))}</span>
        </div>`,
      );
    }
    if (remainingAfter != null) {
      const openPct =
        totalPrice > 0
          ? Math.min(100, Math.round((remainingAfter / totalPrice) * 100))
          : null;
      lines.push(
        `<div class="payment-math-line">
          <span class="payment-math-k">${esc(t('payments.openLabel'))}</span>
          <span class="payment-math-v">${esc(t('payments.openRemainingValue', {
            pct: openPct != null ? String(openPct) : '–',
            amount: formatMoney(remainingAfter, currency),
          }))}</span>
        </div>`,
      );
    }
  } else {
    if (totalPrice != null) {
      lines.push(
        `<div class="payment-math-line"><span class="payment-math-k">${t('payments.bookingAmount')}</span><span class="payment-math-v">${esc(formatMoney(totalPrice, currency))}</span></div>`,
      );
    }
    if (amount != null) {
      lines.push(
        `<div class="payment-math-line is-focus"><span class="payment-math-k">${t('payments.thisPayment')}</span><span class="payment-math-v">${esc(formatMoney(amount, currency))}</span></div>`,
      );
    }
    if (remainingAfter != null && remainingAfter > 0.5) {
      lines.push(
        `<div class="payment-math-line is-focus"><span class="payment-math-k">${t('payments.remainingAfter')}</span><span class="payment-math-v">${esc(formatMoney(remainingAfter, currency))}</span></div>`,
      );
    } else if (balanceDue != null && !(amount != null && remainingAfter != null)) {
      lines.push(
        `<div class="payment-math-line"><span class="payment-math-k">${t('payments.balanceDue')}</span><span class="payment-math-v">${esc(formatMoney(balanceDue, currency))}</span></div>`,
      );
    }
  }

  return `<div class="${boxClass}"${hint ? ` title="${esc(hint)}"` : ''}>
    ${badge}
    <div class="payment-math-stack">${lines.join('')}</div>
  </div>`;
}

function suggestionListingThumbHtml(reservation, candidate) {
  if (reservation?.listing) return listingThumbHtml(reservation.listing);
  const url = candidate?.listingCoverUrl;
  if (url) {
    return `<span class="listing-thumb-frame payment-suggestion-thumb-frame"><img class="listing-thumb" src="${esc(url)}" alt="" loading="lazy" onerror="listingThumbFallback(this)" /></span>`;
  }
  return listingThumbPlaceholderHtml();
}

function renderSuggestedReservation(reservation, candidate, currency = 'EUR', payment = null) {
  const src = reservation || candidate;
  if (!src) {
    return `<div class="payment-suggestion is-empty">
      <div class="payment-suggestion-empty-mark">—</div>
      <button type="button" class="btn payment-btn-find payment-find-booking" data-payment-id="${esc(payment?.id || '')}">
        ${t('payments.findBooking')}
      </button>
    </div>`;
  }
  const hostawayId = reservation?.hostawayId ?? candidate?.hostawayId;
  const guest = reservation?.guestName ?? candidate?.guestName ?? '';
  const listingName = reservation?.listing?.name ?? candidate?.listingName ?? '';
  const roomType =
    reservation?.listing?.roomType ?? candidate?.listingRoomType ?? '';
  const arrival = reservation?.arrivalDate ?? candidate?.arrivalDate;
  const departure = reservation?.departureDate ?? candidate?.departureDate;
  const totalPrice = reservation?.totalPrice ?? candidate?.totalPrice;
  let balanceDue = candidate?.balanceDue;
  let alreadyPaid = reservationPaidAmount(reservation);
  if (
    alreadyPaid == null &&
    candidate?.totalPrice != null &&
    candidate?.balanceDue != null
  ) {
    alreadyPaid = Math.max(
      0,
      Math.round((Number(candidate.totalPrice) - Number(candidate.balanceDue)) * 100) / 100,
    );
  }
  if (
    balanceDue == null &&
    reservation?.totalPrice != null &&
    Array.isArray(reservation?.notifiedCharges)
  ) {
    const paid = reservation.notifiedCharges.reduce(
      (sum, charge) => sum + (Number(charge.amount) || 0),
      0,
    );
    alreadyPaid = alreadyPaid != null ? alreadyPaid : paid;
    balanceDue = Math.max(
      0,
      Math.round((Number(reservation.totalPrice) - paid) * 100) / 100,
    );
  }
  if (alreadyPaid == null) alreadyPaid = 0;
  if (
    balanceDue == null &&
    totalPrice != null &&
    Number.isFinite(Number(totalPrice))
  ) {
    balanceDue = Math.max(
      0,
      Math.round((Number(totalPrice) - alreadyPaid) * 100) / 100,
    );
  }
  const channelName = reservation?.channelName ?? candidate?.channelName ?? null;
  const hostNote = reservation?.hostNote ?? candidate?.hostNote ?? null;
  const stay = formatStayDates(arrival, departure);
  const score = Number(candidate?.score ?? payment?.matchScore);
  const pct = Number.isFinite(score) ? Math.min(99, Math.round(score)) : null;
  const confidence =
    pct != null
      ? `<div class="payment-suggestion-conf">
          <span class="payment-confidence ${pct >= 85 ? 'is-high' : 'is-mid'}">${
            pct >= 85
              ? t('payments.confidenceHighShort')
              : t('payments.confidencePossibleShort')
          }</span>
          <span class="payment-suggestion-pct">${pct}%</span>
        </div>`
      : '';
  const hostawayUrl = hostawayReservationUrl(hostawayId);
  const idLabel = hostawayId ? `#${hostawayId}` : '';
  const titleId = hostawayUrl
    ? `<a class="payment-hostaway-link payment-suggestion-id" href="${esc(hostawayUrl)}" target="_blank" rel="noopener noreferrer" title="${t('payments.openInHostawayHint')}">${esc(idLabel)}</a>`
    : idLabel
      ? `<span class="payment-suggestion-id">${esc(idLabel)}</span>`
      : '';
  const channelBadge = renderChannelBadge(channelName);
  const boardHead =
    titleId || guest || channelBadge
      ? `<div class="payment-suggestion-board-head">
          <div class="payment-suggestion-board-title">
            ${titleId}${guest ? ` <span class="payment-suggestion-board-guest">– ${esc(guest)}</span>` : ''}
            ${channelBadge ? `<span class="payment-suggestion-board-channel">${channelBadge}</span>` : ''}
          </div>
        </div>`
      : '';

  return `<div class="payment-suggestion">
    ${boardHead}
    <div class="payment-suggestion-card">
      ${suggestionListingThumbHtml(reservation, candidate)}
      <div class="payment-suggestion-info">
        ${listingName ? `<div class="payment-suggestion-listing">${esc(listingName)}</div>` : ''}
        ${roomType ? `<div class="payment-suggestion-room">${esc(roomType)}</div>` : ''}
        ${stay ? `<div class="payment-suggestion-dates">${esc(stay)}</div>` : ''}
        ${confidence}
      </div>
    </div>
    <div class="payment-suggestion-board">
      ${renderPaymentMath(
        payment,
        totalPrice,
        balanceDue,
        channelName,
        hostNote,
        alreadyPaid,
        reservation?.paymentPlan || candidate?.paymentPlan || null,
      )}
    </div>
  </div>`;
}

/** Map matcher reason strings to short bilingual review chips. */
function buildMatchSignalChips(payment, bestCandidate) {
  const reasons = Array.isArray(bestCandidate?.reasons) ? bestCandidate.reasons : [];
  const blob = reasons.join(' ').toLowerCase();
  const chips = [];

  const idOk = /reservation #\d+ in reference/.test(blob);
  chips.push({
    ok: idOk,
    label: idOk ? t('payments.signal.idOk') : t('payments.signal.idMissing'),
  });

  const emailOk = blob.includes('guest email matches');
  if (payment.payerEmail || emailOk) {
    chips.push({
      ok: emailOk,
      label: emailOk ? t('payments.signal.emailOk') : t('payments.signal.emailMissing'),
    });
  }

  const nameOk =
    blob.includes('guest name matches') || blob.includes('guest name appears');
  chips.push({
    ok: nameOk,
    label: nameOk ? t('payments.signal.nameOk') : t('payments.signal.nameMissing'),
  });

  const datesOk = blob.includes('stay dates appear');
  chips.push({
    ok: datesOk,
    label: datesOk ? t('payments.signal.datesOk') : t('payments.signal.datesMissing'),
  });

  const amountExact =
    blob.includes('equals outstanding balance') ||
    blob.includes('equals reservation total') ||
    blob.includes('payment amount aligns') ||
    blob.includes('appears in reservation notes');
  const amountPartialRest = blob.includes('restzahlung/teilzahlung');
  const amountSoft =
    blob.includes('soft amount guess') ||
    blob.includes('deposit/installment share');

  if (amountExact) {
    chips.push({ ok: true, label: t('payments.signal.amountOk') });
  } else if (amountPartialRest) {
    chips.push({ ok: false, label: t('payments.signal.amountPartialRest') });
  } else if (amountSoft) {
    chips.push({ ok: false, label: t('payments.signal.amountGuess') });
  } else {
    chips.push({ ok: false, label: t('payments.signal.amountUnclear') });
  }

  const listingOk = blob.includes('listing name appears');
  if (listingOk) {
    chips.push({
      ok: true,
      label: t('payments.signal.listingOk'),
    });
  }

  return chips;
}

/** Short note when payment ≠ remaining but Restzahlung/Teilzahlung was used. */
function renderAmountMatchNote(payment, candidate) {
  const reasons = Array.isArray(candidate?.reasons) ? candidate.reasons : [];
  const blob = reasons.join(' ').toLowerCase();
  const pay = Number(payment?.amount);
  const due = candidate?.balanceDue != null ? Number(candidate.balanceDue) : null;
  const currency = payment?.currency || 'EUR';
  if (!Number.isFinite(pay)) return '';

  if (blob.includes('equals outstanding balance') || blob.includes('equals reservation total')) {
    return '';
  }

  if (blob.includes('restzahlung/teilzahlung') && due != null && Number.isFinite(due)) {
    return `<div class="payment-match-amount-note">${esc(
      t('payments.amountNote.partialRest', {
        payment: formatMoney(pay, currency),
        remaining: formatMoney(due, currency),
      }),
    )}</div>`;
  }

  if (
    (blob.includes('soft amount guess') || blob.includes('deposit/installment')) &&
    due != null &&
    Number.isFinite(due)
  ) {
    return `<div class="payment-match-amount-note">${esc(
      t('payments.amountNote.amountGuess', {
        payment: formatMoney(pay, currency),
        remaining: formatMoney(due, currency),
      }),
    )}</div>`;
  }

  return '';
}

function matchDecisionBadgeClass(decision) {
  if (decision === 'UNAMBIGUOUS') return 'is-ok';
  if (decision === 'NO_MATCH') return 'is-err';
  if (decision === 'AMBIGUOUS' || decision === 'PARTIAL_UNCLEAR') return 'is-warn';
  return 'is-muted';
}

function candidateMatchHint(candidate) {
  const reasons = Array.isArray(candidate?.reasons) ? candidate.reasons : [];
  const blob = reasons.join(' ').toLowerCase();
  if (blob.includes('equals outstanding balance')) {
    return t('payments.candidateHint.balanceExact');
  }
  if (blob.includes('restzahlung/teilzahlung')) {
    return t('payments.candidateHint.balancePartial');
  }
  if (blob.includes('guest name')) {
    return t('payments.candidateHint.guest');
  }
  if (blob.includes('soft amount guess') || blob.includes('30/50/70') || blob.includes('deposit/installment')) {
    return t('payments.candidateHint.amountGuess');
  }
  if (blob.includes('listing name')) {
    return t('payments.candidateHint.listing');
  }
  if (blob.includes('reservation #')) {
    return t('payments.candidateHint.reservationId');
  }
  return '';
}

function renderMatchCandidateButton(payment, candidate, rank, isBest) {
  const id = Number(candidate.hostawayId);
  const guest = String(candidate.guestName || '').trim();
  const score = Number(candidate.score);
  const pct = Number.isFinite(score) ? Math.min(99, Math.round(score)) : null;
  const label = id ? `#${id}${guest ? ` – ${guest}` : ''}` : guest || '–';
  const hint = candidateMatchHint(candidate);
  return `<button type="button" class="payment-match-candidate${isBest ? ' is-best' : ''}"
    role="listitem"
    data-payment-id="${esc(payment.id)}"
    data-hostaway-id="${id}"
    title="${esc(t('payments.useSuggestedBooking'))}">
    <span class="payment-match-candidate-main">
      <span class="payment-match-candidate-rank">${rank}</span>
      <span class="payment-match-candidate-text">
        <span class="payment-match-candidate-label">${esc(label)}</span>
        ${hint ? `<span class="payment-match-candidate-hint">${esc(hint)}</span>` : ''}
      </span>
    </span>
    ${
      pct != null
        ? `<span class="payment-match-candidate-pct">${t('payments.matchConfidence', { pct })}</span>`
        : ''
    }
  </button>`;
}

function renderMatchSignalChipsHtml(payment, bestCandidate) {
  const chips = buildMatchSignalChips(payment, bestCandidate);
  if (!chips.length) return '';
  const chipsHtml = chips
    .map((chip) => {
      const icon = chip.ok ? '✓' : '!';
      const cls = chip.ok ? 'is-ok' : 'is-warn';
      return `<div class="payment-match-chip ${cls}"><span class="payment-match-chip-icon">${icon}</span>${esc(chip.label)}</div>`;
    })
    .join('');
  return `<div class="payment-match-signals-label">${t('payments.matchingSignals')}</div>
    <div class="payment-match-chips">${chipsHtml}</div>`;
}

function renderMatchCell(payment, candidates, bestCandidate) {
  const decision = payment.matchDecision || payment.status || '';
  const decisionLabel = paymentDecisionLabel(decision);
  const list = Array.isArray(candidates) ? candidates.slice(0, 5) : [];
  const count = list.length;
  let summaryLine = '';
  if (count > 1) {
    summaryLine = t('payments.matchCandidatesCount', { count });
  } else if (decision === 'NO_MATCH' || count === 0) {
    summaryLine = t('payments.matchNoneFound');
  } else if (count === 1) {
    summaryLine = t('payments.matchOneFound');
  }

  const best = bestCandidate || list[0] || null;
  const bestId = best ? Number(best.hostawayId) : null;
  const bestIndex = bestId
    ? list.findIndex((c) => Number(c.hostawayId) === bestId)
    : 0;
  const bestRank = bestIndex >= 0 ? bestIndex + 1 : 1;
  const others = list.filter((c) => Number(c.hostawayId) !== bestId);
  const otherCount = others.length;

  const bestHtml = best
    ? `<div class="payment-match-candidates" role="list">
        ${renderMatchCandidateButton(payment, best, bestRank, true)}
      </div>`
    : '';

  const othersHtml = otherCount
    ? `<div class="payment-match-others" hidden>
        <div class="payment-match-others-label">${esc(
          t('payments.otherBookings', { count: otherCount }),
        )}</div>
        <div class="payment-match-candidates is-others" role="list">
          ${others
            .map((c, idx) => {
              const rankInFull = list.findIndex(
                (x) => Number(x.hostawayId) === Number(c.hostawayId),
              );
              return renderMatchCandidateButton(
                payment,
                c,
                rankInFull >= 0 ? rankInFull + 1 : idx + 2,
                false,
              );
            })
            .join('')}
        </div>
      </div>
      <button type="button" class="payment-match-more-toggle" data-payment-id="${esc(payment.id)}" data-other-count="${otherCount}" aria-expanded="false">
        ${esc(t('payments.showOtherBookings', { count: otherCount }))}
      </button>`
    : '';

  return `<div class="payment-match-block" data-payment-id="${esc(payment.id)}">
    <div class="payment-match-status ${matchDecisionBadgeClass(decision)}">${esc(decisionLabel)}</div>
    ${summaryLine ? `<div class="payment-match-summary">${esc(summaryLine)}</div>` : ''}
    ${payment.error ? `<div class="payment-apply-error" role="alert"><strong>${esc(t('payments.applyFailedTitle'))}</strong> ${esc(payment.error)} <span class="muted">${esc(t('payments.applyFailedHint'))}</span></div>` : ''}
    ${bestHtml}
    ${renderAmountMatchNote(payment, best)}
    ${best ? renderMatchSignalChipsHtml(payment, best) : ''}
    ${othersHtml}
  </div>`;
}

function renderPaymentPayerCell(payment) {
  const when = formatCompactDateTime(payment.occurredAt || payment.createdAt);
  const source = String(payment.source || '').toLowerCase() === 'paypal' ? 'PayPal' : (payment.source || '–');
  const sourceCls =
    String(payment.source || '').toUpperCase() === 'PAYPAL'
      ? 'is-paypal'
      : String(payment.source || '').toUpperCase() === 'QONTO'
        ? 'is-qonto'
        : '';
  const name = payment.payerName || '–';
  const email = payment.payerEmail ? String(payment.payerEmail).trim() : '';
  const ref = payment.reference ? String(payment.reference).trim() : '';
  return `<div class="payment-payer-combo">
    <div class="payment-compact-amount">${esc(formatMoney(payment.amount, payment.currency))}</div>
    <div class="payment-compact-meta">
      <span class="payment-source-pill ${sourceCls}">${esc(source)}</span>
      <span class="payment-compact-when">${esc(when)}</span>
    </div>
    <div class="payment-payer-name">${esc(name)}</div>
    ${email ? `<div class="payment-payer-email">${esc(email)}</div>` : ''}
    ${ref ? `<div class="payment-payer-ref" title="${esc(ref)}">${esc(ref)}</div>` : ''}
  </div>`;
}

function renderPaymentCell(payment) {
  const when = formatCompactDateTime(payment.occurredAt || payment.createdAt);
  const source = String(payment.source || '').toLowerCase() === 'paypal' ? 'PayPal' : (payment.source || '–');
  const sourceCls =
    String(payment.source || '').toUpperCase() === 'PAYPAL'
      ? 'is-paypal'
      : String(payment.source || '').toUpperCase() === 'QONTO'
        ? 'is-qonto'
        : '';
  return `<div class="payment-compact">
    <div class="payment-compact-amount">${esc(formatMoney(payment.amount, payment.currency))}</div>
    <div class="payment-compact-source"><span class="payment-source-pill ${sourceCls}">${esc(source)}</span></div>
    <div class="payment-compact-when">${esc(when)}</div>
  </div>`;
}

function renderPayerCell(payment) {
  const name = payment.payerName || '–';
  const email = payment.payerEmail ? String(payment.payerEmail).trim() : '';
  const ref = payment.reference ? String(payment.reference).trim() : '';
  return `<div class="payment-payer-block">
    <div class="payment-payer-name">${esc(name)}</div>
    ${email ? `<div class="payment-payer-email">${esc(email)}</div>` : ''}
    ${ref ? `<div class="payment-payer-ref"><span class="payment-payer-ref-label">${t('payments.referenceLabel')}</span> ${esc(ref)}</div>` : ''}
  </div>`;
}

const reservationSearchCache = new Map();
let paymentResSearchBound = false;

function isActiveStayReservation(r) {
  const status = String(r?.status || '').toLowerCase();
  if (/cancel|inquiry|ownerstay|owner.?stay/.test(status)) return false;
  if (!r?.departureDate) return true;
  const dep = new Date(r.departureDate);
  if (Number.isNaN(dep.getTime())) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return dep >= today;
}

function filterReservationSearchItems(items, channelFilter, stayFilter) {
  return (items || []).filter((r) => {
    if (stayFilter === 'active' && !isActiveStayReservation(r)) return false;
    if (channelFilter && channelFilter !== 'all') {
      const pretty = prettyChannel(r.channelName || '').toLowerCase();
      if (channelFilter === 'direct') {
        return pretty === prettyChannel('direct').toLowerCase()
          || /direct|bookingengine|website|manual|partner/i.test(String(r.channelName || ''));
      }
      if (channelFilter === 'airbnb') return /airbnb/i.test(String(r.channelName || ''));
      if (channelFilter === 'booking') return /booking/i.test(String(r.channelName || '')) && !/bookingengine/i.test(String(r.channelName || ''));
    }
    return true;
  });
}

function buildReservationSearchResultButton(r, currency) {
  const id = r.hostawayId;
  const guest = r.guestName || '–';
  const listing = r.listing?.name || r.listingName || '';
  const dates = formatStayDates(r.arrivalDate, r.departureDate);
  const totalLabel = r.totalPrice != null ? formatMoney(r.totalPrice, currency) : '';
  const paid = reservationPaidAmount(r);
  const paidLabel = paid != null ? formatMoney(paid, currency) : '';
  const meta = [listing, dates].filter(Boolean).join(' · ');
  return `
    <button type="button" class="payment-res-result" data-hostaway-id="${id}" role="option">
      <span class="payment-res-result-main">
        <span class="payment-res-result-title">#${esc(String(id))} — ${esc(guest)}</span>
        ${meta ? `<span class="payment-res-result-meta">${esc(meta)}</span>` : ''}
      </span>
      <span class="payment-res-result-side">
        ${r.channelName ? renderChannelBadge(r.channelName) : ''}
        <span class="payment-res-result-amounts">
          ${totalLabel ? `<span class="payment-res-result-total">${esc(totalLabel)}</span>` : ''}
          ${paidLabel ? `<span class="payment-res-result-paid">${esc(t('listings.paidAmount'))}: ${esc(paidLabel)}</span>` : `<span class="payment-res-result-paid">${esc(t('listings.paidAmount'))}: –</span>`}
        </span>
      </span>
    </button>`;
}

function closeReservationSearchPanels(except = null) {
  document.querySelectorAll('.payment-res-search').forEach((wrap) => {
    if (wrap === except) return;
    wrap.classList.remove('is-open');
    const panel = wrap.querySelector('.payment-res-search-panel');
    if (panel) panel.hidden = true;
  });
}

function ensureSelectHasReservationOption(select, reservation, currency) {
  if (!select || !reservation?.hostawayId) return;
  cachePaymentReservation(reservation);
  const id = String(reservation.hostawayId);
  let opt = select.querySelector(`option[value="${id}"]`);
  if (!opt) {
    opt = document.createElement('option');
    opt.value = id;
    select.appendChild(opt);
  }
  const guest = String(reservation.guestName || '').trim();
  const dates = formatStayDates(reservation.arrivalDate, reservation.departureDate);
  const listing = reservation.listing?.name || reservation.listingName || '';
  const paid = reservationPaidAmount(reservation);
  const amountLabel =
    reservation.totalPrice != null
      ? formatMoney(reservation.totalPrice, currency)
      : '';
  const paidLabel = paid != null ? formatMoney(paid, currency) : '';
  opt.dataset.guest = guest;
  opt.dataset.dates = dates;
  opt.dataset.listing = listing;
  opt.dataset.amountLabel = amountLabel;
  opt.dataset.paidLabel = paidLabel;
  opt.dataset.channel = reservation.channelName ? prettyChannel(reservation.channelName) : '';
  opt.dataset.channelRaw = reservation.channelName || '';
  opt.dataset.totalPrice = reservation.totalPrice != null ? String(Number(reservation.totalPrice)) : '';
  opt.dataset.arrival = reservation.arrivalDate
    ? String(reservation.arrivalDate).slice(0, 10)
    : '';
  opt.dataset.departure = reservation.departureDate
    ? String(reservation.departureDate).slice(0, 10)
    : '';
  opt.dataset.roomType = reservation.listing?.roomType || reservation.listingRoomType || '';
  opt.dataset.coverUrl =
    reservation.listingCoverUrl ||
    reservation.listing?.rawMetadata?.coverImageUrl ||
    '';
  if (paid != null) opt.dataset.paidAmount = String(paid);
  opt.title = formatReservationOption(reservation, currency);
  opt.textContent = formatReservationOptionShort(reservation, currency);
}

const paymentReservationCache = new Map();

function cachePaymentReservation(reservation) {
  const id = Number(reservation?.hostawayId);
  if (!id || !reservation) return;
  paymentReservationCache.set(id, reservation);
}

function bookingFromSelectOption(opt) {
  if (!opt?.value) return null;
  const totalPrice = opt.dataset.totalPrice ? Number(opt.dataset.totalPrice) : null;
  const paidAmount = opt.dataset.paidAmount ? Number(opt.dataset.paidAmount) : null;
  const balanceDue =
    totalPrice != null && paidAmount != null
      ? Math.max(0, Math.round((totalPrice - paidAmount) * 100) / 100)
      : totalPrice;
  return {
    hostawayId: Number(opt.value),
    guestName: opt.dataset.guest || null,
    listingName: opt.dataset.listing || '',
    listingRoomType: opt.dataset.roomType || null,
    listingCoverUrl: opt.dataset.coverUrl || null,
    arrivalDate: opt.dataset.arrival || null,
    departureDate: opt.dataset.departure || null,
    channelName: opt.dataset.channelRaw || null,
    totalPrice: Number.isFinite(totalPrice) ? totalPrice : null,
    paidAmount: Number.isFinite(paidAmount) ? paidAmount : null,
    balanceDue: Number.isFinite(balanceDue) ? balanceDue : null,
  };
}

function resolvePaymentBooking(payment, hostawayId, rowEl = null) {
  const id = Number(hostawayId);
  if (!id) return { reservation: null, candidate: null };
  const candidates = Array.isArray(payment?.matchCandidates) ? payment.matchCandidates : [];
  const candidate = candidates.find((c) => Number(c.hostawayId) === id) || null;
  if (
    payment?.matchedReservation &&
    Number(payment.matchedReservation.hostawayId) === id
  ) {
    return { reservation: payment.matchedReservation, candidate };
  }
  const cached = paymentReservationCache.get(id);
  if (cached) return { reservation: cached, candidate };
  const select = rowEl?.querySelector?.('.payment-assign-select');
  const opt = select?.querySelector(`option[value="${id}"]`);
  const synthetic = bookingFromSelectOption(opt);
  if (synthetic) {
    return {
      reservation: {
        ...synthetic,
        listing: {
          name: synthetic.listingName,
          roomType: synthetic.listingRoomType,
          rawMetadata: synthetic.listingCoverUrl
            ? { coverImageUrl: synthetic.listingCoverUrl }
            : null,
        },
      },
      candidate: candidate || synthetic,
    };
  }
  if (candidate) return { reservation: null, candidate };
  return { reservation: null, candidate: null };
}

function collectPaymentPreviewSelections(paymentId) {
  const container = $(`.payment-split-rows[data-payment-id="${paymentId}"]`);
  if (!container) return [];
  return [...container.querySelectorAll('.payment-split-row')]
    .map((row) => {
      const select = row.querySelector('.payment-assign-select');
      const manual = row.querySelector('.payment-assign-manual');
      const amountInput = row.querySelector('.payment-split-amount');
      const hostawayId =
        parseReservationIdInput(manual?.value) ||
        (select?.value ? Number(select.value) : undefined);
      return {
        hostawayId,
        amount: Math.round((Number(amountInput?.value) || 0) * 100) / 100,
        row,
      };
    })
    .filter((row) => row.hostawayId);
}

function renderMatchBlockForBooking(payment, candidate, reservation) {
  const hostawayId = reservation?.hostawayId ?? candidate?.hostawayId;
  const guest = reservation?.guestName ?? candidate?.guestName ?? '';
  const score = Number(candidate?.score);
  const confidenceLine = Number.isFinite(score)
    ? `<div class="payment-match-confidence">${t('payments.matchConfidence', {
        pct: Math.min(99, Math.round(score)),
      })}</div>`
    : '';
  const chips = buildMatchSignalChips(payment, candidate);
  const chipsHtml = chips
    .map((chip) => {
      const icon = chip.ok ? '✓' : '!';
      const cls = chip.ok ? 'is-ok' : 'is-warn';
      return `<div class="payment-match-chip ${cls}"><span class="payment-match-chip-icon">${icon}</span>${esc(chip.label)}</div>`;
    })
    .join('');
  const title = hostawayId
    ? `#${hostawayId}${guest ? ` – ${esc(guest)}` : ''}`
    : guest || t('payments.reservation');
  return `<div class="payment-match-booking">
    <div class="payment-match-booking-title">${title}</div>
    ${confidenceLine}
    ${
      chipsHtml
        ? `<div class="payment-match-signals-label">${t('payments.matchingSignals')}</div><div class="payment-match-chips">${chipsHtml}</div>`
        : `<div class="payment-match-summary">${esc(t('payments.manualSelection'))}</div>`
    }
  </div>`;
}

function renderMatchCellForSelections(payment, selections) {
  const candidates = Array.isArray(payment.matchCandidates) ? payment.matchCandidates : [];
  const selectedId = selections[0]?.hostawayId;
  const best =
    (selectedId &&
      candidates.find((c) => Number(c.hostawayId) === Number(selectedId))) ||
    candidates[0] ||
    null;
  // Keep count + candidate list visible; do not collapse to a single booking block.
  return renderMatchCell(payment, candidates, best);
}

function renderSuggestedReservationsForSelections(payment, selections) {
  if (!selections.length) {
    return renderSuggestedReservation(null, null, payment.currency, payment);
  }
  return `<div class="payment-suggestion-stack">
    ${selections
      .map((sel) => {
        const { reservation, candidate } = resolvePaymentBooking(
          payment,
          sel.hostawayId,
          sel.row,
        );
        const paymentView = {
          ...payment,
          amount: sel.amount > 0 ? sel.amount : payment.amount,
        };
        return renderSuggestedReservation(
          reservation,
          candidate,
          payment.currency,
          paymentView,
        );
      })
      .join('')}
  </div>`;
}

function bindMatchCellInteractions(root = document) {
  const scope = typeof root.querySelectorAll === 'function' ? root : document;
  scope.querySelectorAll('.payment-match-candidate').forEach((btn) => {
    if (btn.dataset.boundPick) return;
    btn.dataset.boundPick = '1';
    btn.addEventListener('click', () => {
      const paymentId = btn.dataset.paymentId;
      const hostawayId = Number(btn.dataset.hostawayId);
      if (!paymentId || !hostawayId) return;
      const select = $(
        `.payment-split-row[data-payment-id="${paymentId}"][data-row-index="0"] .payment-assign-select`,
      );
      if (!select) return;
      const hasOption = [...select.options].some(
        (opt) => Number(opt.value) === hostawayId,
      );
      if (!hasOption) return;
      select.value = String(hostawayId);
      const wrap = select.closest('.payment-assign-wrap');
      if (wrap) syncAssignDropdown(wrap, select);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  scope.querySelectorAll('.payment-match-more-toggle').forEach((btn) => {
    if (btn.dataset.boundToggle) return;
    btn.dataset.boundToggle = '1';
    btn.addEventListener('click', () => {
      const block = btn.closest('.payment-match-block');
      const others = block?.querySelector('.payment-match-others');
      if (!others) return;
      const open = others.hasAttribute('hidden');
      if (open) others.removeAttribute('hidden');
      else others.setAttribute('hidden', '');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      const count = Number(btn.dataset.otherCount) || 0;
      btn.textContent = open
        ? t('payments.hideOtherBookings')
        : t('payments.showOtherBookings', { count });
    });
  });
}

function bindPaymentMatchCandidatePicks() {
  bindMatchCellInteractions(document);
}

function refreshPaymentReviewSidePanels(paymentId) {
  const payment = window.__paymentSplitById?.get(paymentId);
  const row = $(`.payment-review-row[data-payment-id="${paymentId}"]`);
  if (!payment || !row) return;
  const selections = collectPaymentPreviewSelections(paymentId);
  const matchCell = row.querySelector('.payment-match-cell');
  const suggestionCell = row.querySelector('.payment-suggestion-cell');
  if (matchCell) {
    matchCell.innerHTML = renderMatchCellForSelections(payment, selections);
    bindMatchCellInteractions(matchCell);
  }
  if (suggestionCell) {
    suggestionCell.innerHTML = renderSuggestedReservationsForSelections(
      payment,
      selections,
    );
  }
  const openBtn = row.querySelector('.payment-open-hostaway');
  const firstId = selections[0]?.hostawayId;
  if (openBtn && firstId) {
    const url = hostawayReservationUrl(firstId);
    if (url) {
      openBtn.href = url;
      openBtn.dataset.hostawayId = String(firstId);
    }
  }
  row.querySelectorAll('.payment-find-booking').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(
        `.payment-actions-stack[data-payment-id="${paymentId}"] .payment-assign-manual`,
      );
      input?.focus();
      input?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  });
}

function applyReservationSearchPick(wrap, reservation) {
  const row = wrap.closest('.payment-split-row');
  const select = row?.querySelector('.payment-assign-select');
  const manual = wrap.querySelector('.payment-assign-manual');
  const stack = wrap.closest('.payment-actions-stack');
  const currency = stack?.dataset.currency || 'EUR';
  const paymentId = wrap.dataset.paymentId || select?.dataset.paymentId;
  if (!select || !reservation?.hostawayId) return;

  ensureSelectHasReservationOption(select, reservation, currency);
  select.value = String(reservation.hostawayId);
  if (manual) manual.value = `#${reservation.hostawayId}`;
  const assignWrap = select.closest('.payment-assign-wrap');
  if (assignWrap) {
    const list = assignWrap.querySelector('.payment-assign-choices');
    if (list) {
      const existing = [...list.querySelectorAll('.payment-assign-choice')]
        .find((btn) => btn.dataset.value === String(reservation.hostawayId));
      if (!existing) {
        const opt = select.querySelector(`option[value="${reservation.hostawayId}"]`);
        if (opt) list.insertAdjacentHTML('afterbegin', buildAssignChoiceButton(opt));
      }
    }
    syncAssignDropdown(assignWrap, select);
  }
  closeReservationSearchPanels();
  closePaymentAssignDropdowns();
  select.dispatchEvent(new Event('change', { bubbles: true }));
  if (row && paymentId) {
    applySplitRowPercentage(paymentId, row);
    updatePaymentSplitUi(paymentId);
  }
}

function renderReservationSearchPanel(wrap) {
  const panel = wrap.querySelector('.payment-res-search-panel');
  const resultsEl = wrap.querySelector('.payment-res-search-results');
  const countEl = wrap.querySelector('.payment-res-search-count');
  const moreBtn = wrap.querySelector('.payment-res-search-more');
  if (!panel || !resultsEl) return;

  const state = wrap._resSearch || { items: [], page: 1, pageSize: 20, total: 0, q: '' };
  const channelFilter = wrap.querySelector('.payment-res-filter-channel')?.value || 'all';
  const stayFilter = wrap.querySelector('.payment-res-filter-stay')?.value || 'active';
  const stack = wrap.closest('.payment-actions-stack');
  const currency = stack?.dataset.currency || 'EUR';
  const filtered = filterReservationSearchItems(state.items, channelFilter, stayFilter);
  const visible = filtered;

  if (countEl) {
    countEl.textContent = t('payments.searchMatchCount', { count: filtered.length });
  }
  if (!visible.length) {
    resultsEl.innerHTML = `<div class="payment-res-search-empty">${esc(t('payments.searchNoResults'))}</div>`;
  } else {
    resultsEl.innerHTML = visible
      .map((r) => buildReservationSearchResultButton(r, currency))
      .join('');
  }
  if (moreBtn) {
    const hasMore = Number(state.total) > Number(state.items.length);
    moreBtn.classList.toggle('hidden', !hasMore);
  }
  closePaymentAssignDropdowns();
  wrap.classList.add('is-open');
  panel.hidden = false;
}

async function runReservationSearch(wrap, { loadMore = false } = {}) {
  const input = wrap.querySelector('.payment-assign-manual');
  const q = String(input?.value || '').trim();
  if (q.length < 2) {
    closeReservationSearchPanels();
    return;
  }
  if (/^#?\d{5,10}$/.test(q) && !loadMore) {
    closeReservationSearchPanels();
    return;
  }

  const state = wrap._resSearch || { items: [], page: 1, pageSize: 20, total: 0, q: '' };
  const nextPage = loadMore ? state.page + 1 : 1;
  const cacheKey = `${q}|p${nextPage}`;

  try {
    let pageData = reservationSearchCache.get(cacheKey);
    if (!pageData) {
      const res = await api(`/reservations?search=${encodeURIComponent(q)}&pageSize=20&page=${nextPage}`);
      pageData = {
        items: res.items || [],
        total: res.total ?? (res.items || []).length,
      };
      reservationSearchCache.set(cacheKey, pageData);
    }
    const merged = loadMore
      ? [...(state.items || []), ...pageData.items]
      : pageData.items;
    wrap._resSearch = {
      items: merged,
      page: nextPage,
      pageSize: 20,
      total: pageData.total,
      q,
    };
    renderReservationSearchPanel(wrap);
  } catch {
    /* search is best-effort */
  }
}

function bindReservationSearchInputs() {
  $$('.payment-assign-manual').forEach((input) => {
    if (input.dataset.searchBound) return;
    input.dataset.searchBound = '1';

    let wrap = input.closest('.payment-res-search');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'payment-res-search';
      wrap.dataset.paymentId = input.dataset.paymentId || '';
      wrap.dataset.rowIndex = input.dataset.rowIndex || '0';
      input.parentNode?.insertBefore(wrap, input);
      const inputWrap = document.createElement('div');
      inputWrap.className = 'payment-res-search-input-wrap';
      inputWrap.innerHTML = '<span class="payment-res-search-icon" aria-hidden="true"></span>';
      wrap.appendChild(inputWrap);
      inputWrap.appendChild(input);
    }
    wrap.dataset.paymentId = input.dataset.paymentId || wrap.dataset.paymentId || '';
    wrap.dataset.rowIndex = input.dataset.rowIndex || wrap.dataset.rowIndex || '0';
    input.removeAttribute('list');
    if (!input.closest('.payment-res-search-input-wrap')) {
      const inputWrap = document.createElement('div');
      inputWrap.className = 'payment-res-search-input-wrap';
      inputWrap.innerHTML = '<span class="payment-res-search-icon" aria-hidden="true"></span>';
      input.parentNode?.insertBefore(inputWrap, input);
      inputWrap.appendChild(input);
    }
    if (!wrap.querySelector('.payment-res-search-panel')) {
      const panel = document.createElement('div');
      panel.className = 'payment-res-search-panel';
      panel.hidden = true;
      panel.innerHTML = `
        <div class="payment-res-search-meta">
          <span class="payment-res-search-count"></span>
          <div class="payment-res-search-filters">
            <select class="payment-res-filter payment-res-filter-channel" aria-label="${esc(t('payments.searchFilterChannel'))}">
              <option value="all">${esc(t('payments.searchAllChannels'))}</option>
              <option value="direct">${esc(t('payments.channelDirect'))}</option>
              <option value="airbnb">Airbnb</option>
              <option value="booking">Booking.com</option>
            </select>
            <select class="payment-res-filter payment-res-filter-stay" aria-label="${esc(t('payments.searchFilterStay'))}">
              <option value="active">${esc(t('payments.searchActiveStays'))}</option>
              <option value="all">${esc(t('payments.searchAllStays'))}</option>
            </select>
          </div>
        </div>
        <div class="payment-res-search-results" role="listbox"></div>
        <div class="payment-res-search-footer">
          <span class="payment-res-search-hint">${esc(t('payments.searchNavHint'))}</span>
          <button type="button" class="payment-res-search-more hidden">${esc(t('payments.searchLoadMore'))}</button>
        </div>`;
      wrap.appendChild(panel);
    }

    const timerKey = `res-search-${wrap.dataset.paymentId}-${wrap.dataset.rowIndex}`;
    input.addEventListener('input', () => {
      clearTimeout(searchTimers[timerKey]);
      searchTimers[timerKey] = setTimeout(() => {
        runReservationSearch(wrap).catch(() => {});
      }, 280);
    });
    input.addEventListener('focus', () => {
      if (String(input.value || '').trim().length >= 2 && wrap._resSearch?.items?.length) {
        renderReservationSearchPanel(wrap);
      }
    });
  });

  if (paymentResSearchBound) return;
  paymentResSearchBound = true;
  document.addEventListener('click', (e) => {
    if (e.target.closest('.payment-res-search')) return;
    closeReservationSearchPanels();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeReservationSearchPanels();
  });
  document.addEventListener('change', (e) => {
    const filter = e.target.closest('.payment-res-filter');
    if (!filter) return;
    const wrap = filter.closest('.payment-res-search');
    if (wrap?._resSearch) renderReservationSearchPanel(wrap);
  });
  document.addEventListener('click', (e) => {
    const more = e.target.closest('.payment-res-search-more');
    if (more) {
      const wrap = more.closest('.payment-res-search');
      if (!wrap) return;
      e.preventDefault();
      runReservationSearch(wrap, { loadMore: true }).catch(() => {});
      return;
    }
    const result = e.target.closest('.payment-res-result');
    if (!result) return;
    const wrap = result.closest('.payment-res-search');
    const id = Number(result.dataset.hostawayId);
    const reservation = wrap?._resSearch?.items?.find((r) => Number(r.hostawayId) === id);
    if (wrap && reservation) applyReservationSearchPick(wrap, reservation);
  });
}

function parseReservationIdInput(value) {
  const match = String(value || '').match(/#?(\d{5,10})/);
  return match ? Number(match[1]) : undefined;
}

/** Keep "Open in Hostaway" pointed at the currently selected / typed reservation. */
function bindPaymentHostawayOpeners() {
  const syncOpener = (paymentId) => {
    const select = $(`.payment-assign-select[data-payment-id="${paymentId}"]`);
    const manual = $(`.payment-assign-manual[data-payment-id="${paymentId}"]`);
    const cell = select?.closest('.payment-actions-cell') || manual?.closest('.payment-actions-cell');
    const btn = cell?.querySelector('.payment-open-hostaway');
    if (!btn) return;
    const fromManual = parseReservationIdInput(manual?.value);
    const fromSelect = select?.value ? Number(select.value) : undefined;
    const hostawayId = fromManual || fromSelect || Number(btn.dataset.hostawayId) || undefined;
    const url = hostawayReservationUrl(hostawayId);
    if (!url) {
      btn.setAttribute('aria-disabled', 'true');
      btn.classList.add('is-disabled');
      btn.removeAttribute('href');
      return;
    }
    btn.classList.remove('is-disabled');
    btn.removeAttribute('aria-disabled');
    btn.href = url;
    btn.dataset.hostawayId = String(hostawayId);
  };

  $$('.payment-assign-select').forEach((select) => {
    select.addEventListener('change', () => syncOpener(select.dataset.paymentId));
  });
  $$('.payment-assign-manual').forEach((input) => {
    input.addEventListener('input', () => syncOpener(input.dataset.paymentId));
  });
}

function formatQontoPollMeta(last) {
  if (!last?.metadata || typeof last.metadata !== 'object') return '';
  const m = last.metadata;
  const parts = [];
  if (m.fetched != null) parts.push(t('payments.qontoFetched', { n: m.fetched }));
  if (m.ingested != null) parts.push(t('payments.qontoIngested', { n: m.ingested }));
  if (m.skippedInternal != null && m.skippedInternal > 0) {
    parts.push(t('payments.qontoSkipped', { n: m.skippedInternal }));
  }
  return parts.length ? ` — ${parts.join(', ')}` : '';
}

async function loadQontoStatus() {
  const line = $('#qonto-status-line');
  const whenEl = $('#qonto-status-when');
  const agoEl = $('#qonto-status-ago');
  const btn = $('#qonto-poll-btn');
  const badge = $('#qonto-connected-badge');
  const okIcon = $('#qonto-ok-icon');
  const newItems = $('#qonto-new-items');
  const lastSyncEl = $('#payments-last-sync');
  if (!whenEl) return;
  try {
    const status = await api('/payments/qonto-status');
    const last = status.last;
    const stamp = last?.finishedAt || last?.startedAt;
    let whenText = '–';
    let ago = '';
    let meta = '';
    const connected = !!(status.enabled && status.configured);
    if (badge) badge.hidden = !connected;
    if (okIcon) okIcon.hidden = !connected;

    if (!status.enabled) {
      whenText = '–';
      meta = t('payments.qontoDisabled');
      if (newItems) newItems.textContent = '–';
    } else if (!status.configured) {
      whenText = '–';
      meta = t('payments.qontoNotConfigured');
      if (newItems) newItems.textContent = '–';
    } else if (status.inProgress || last?.status === 'running') {
      whenText = stamp ? formatPaymentImportTime(stamp) : '–';
      meta = t('payments.qontoRunningShort');
      if (newItems) newItems.textContent = '…';
    } else if (last?.status === 'failed') {
      whenText = stamp ? formatPaymentImportTime(stamp) : '–';
      meta = t('payments.qontoFailedShort', { error: last.error || '–' });
      if (newItems) newItems.textContent = '–';
    } else if (last) {
      whenText = stamp ? formatPaymentImportTime(stamp) : '–';
      ago = stamp ? formatRelativeAgo(stamp) : '';
      const ingested = last.metadata?.ingested ?? last.ingested;
      const fetched = last.metadata?.fetched ?? last.fetched;
      const newCount = ingested ?? fetched;
      if (newItems) {
        newItems.textContent =
          newCount != null ? String(newCount) : '–';
      }
      const counts = formatQontoPollMeta(last).replace(/^ — /, '');
      meta = [counts, t('payments.qontoIntervalShort', { n: status.intervalMinutes || 5 })]
        .filter(Boolean)
        .join(' · ');
    } else {
      whenText = '–';
      meta = t('payments.qontoNever');
      if (newItems) newItems.textContent = '0';
    }

    whenEl.textContent = whenText;
    if (agoEl) agoEl.textContent = ago;
    if (line) line.textContent = meta;
    if (lastSyncEl) {
      lastSyncEl.textContent =
        whenText && whenText !== '–'
          ? t('payments.lastSync', { when: whenText })
          : t('payments.lastSyncUnknown');
    }
    const mobileMeta = $('#payments-mobile-sync-meta');
    if (mobileMeta) mobileMeta.textContent = lastSyncEl?.textContent || '';

    const mobileBtn = $('#qonto-poll-btn-mobile');
    if (btn || mobileBtn) {
      const canPoll =
        (hasPermission('PAYMENTS_ADMIN') || hasPermission('PAYMENTS_REVIEW')) &&
        status.enabled &&
        status.configured;
      if (btn) {
        btn.disabled = !canPoll || status.inProgress;
        btn.classList.toggle(
          'hidden',
          !(hasPermission('PAYMENTS_ADMIN') || hasPermission('PAYMENTS_REVIEW')),
        );
      }
      if (mobileBtn) {
        mobileBtn.disabled = !canPoll || status.inProgress;
        mobileBtn.classList.toggle(
          'hidden',
          !(hasPermission('PAYMENTS_ADMIN') || hasPermission('PAYMENTS_REVIEW')),
        );
      }
    }
  } catch (ex) {
    whenEl.textContent = '–';
    if (agoEl) agoEl.textContent = '';
    if (line) line.textContent = ex.message || t('payments.qontoStatusError');
    if (badge) badge.hidden = true;
    if (okIcon) okIcon.hidden = true;
    if (newItems) newItems.textContent = '–';
    if (lastSyncEl) lastSyncEl.textContent = t('payments.lastSyncUnknown');
    const mobileMeta = $('#payments-mobile-sync-meta');
    if (mobileMeta) mobileMeta.textContent = t('payments.lastSyncUnknown');
  }
}

async function loadPaypalStatus() {
  const line = $('#paypal-status-line');
  const whenEl = $('#paypal-status-when');
  const agoEl = $('#paypal-status-ago');
  const badge = $('#paypal-connected-badge');
  const okIcon = $('#paypal-ok-icon');
  const newItems = $('#paypal-new-items');
  if (!whenEl) return;
  try {
    const status = await api('/payments/paypal-status');
    if (!status.enabled) {
      whenEl.textContent = '–';
      if (agoEl) agoEl.textContent = '';
      if (line) line.textContent = t('payments.paypalDisabled');
      if (badge) badge.hidden = true;
      if (okIcon) okIcon.hidden = true;
      if (newItems) newItems.textContent = '–';
      return;
    }
    if (!status.configured) {
      whenEl.textContent = '–';
      if (agoEl) agoEl.textContent = '';
      if (line) line.textContent = t('payments.paypalNotConfigured');
      if (badge) badge.hidden = true;
      if (okIcon) okIcon.hidden = true;
      if (newItems) newItems.textContent = '–';
      return;
    }
    if (badge) badge.hidden = false;
    if (okIcon) okIcon.hidden = false;
    if (status.last?.createdAt) {
      whenEl.textContent = formatPaymentImportTime(status.last.createdAt);
      const ago = formatRelativeAgo(status.last.createdAt);
      if (agoEl) agoEl.textContent = '';
      if (line) {
        line.textContent = [t('payments.paypalCaption'), ago].filter(Boolean).join(' · ');
      }
      if (newItems) newItems.textContent = String(status.count ?? 0);
    } else {
      whenEl.textContent = '–';
      if (agoEl) agoEl.textContent = '';
      if (line) line.textContent = t('payments.paypalNeverShort');
      if (newItems) newItems.textContent = '0';
    }
  } catch (ex) {
    whenEl.textContent = '–';
    if (agoEl) agoEl.textContent = '';
    if (line) line.textContent = ex.message || t('payments.paypalStatusError');
    if (badge) badge.hidden = true;
    if (okIcon) okIcon.hidden = true;
    if (newItems) newItems.textContent = '–';
  }
}

function isPaymentsMobileLayout() {
  return window.matchMedia('(max-width: 1023px)').matches;
}

function syncPaymentsMobileChrome() {
  const onPayments = activeTab === 'payments';
  document.body.classList.toggle('payments-mobile-active', onPayments && isPaymentsMobileLayout());
  $$('#payments-mobile-bottom-nav [data-payments-view]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.paymentsView === paymentsView);
  });
  const meta = $('#payments-mobile-sync-meta');
  const lastSync = $('#payments-last-sync');
  if (meta && lastSync) meta.textContent = lastSync.textContent || '';
}

function updatePaymentsMobileQueueBadge(count) {
  const badge = $('#payments-mobile-nav-badge');
  if (!badge) return;
  const n = Number(count) || 0;
  badge.textContent = String(n);
  badge.hidden = n <= 0;
}

$('#qonto-poll-btn')?.addEventListener('click', async () => {
  if (!hasPermission('PAYMENTS_ADMIN') && !hasPermission('PAYMENTS_REVIEW')) return;
  const btn = $('#qonto-poll-btn');
  const mobileBtn = $('#qonto-poll-btn-mobile');
  const result = $('#qonto-poll-result');
  if (btn) btn.disabled = true;
  if (mobileBtn) mobileBtn.disabled = true;
  if (result) result.textContent = t('payments.qontoPolling');
  try {
    const res = await api('/payments/qonto-poll', { method: 'POST', body: '{}' });
    if (result) {
      result.textContent = t('payments.qontoPollOk', {
        fetched: res.fetched ?? 0,
        ingested: res.ingested ?? 0,
      });
    }
    notify.success(t('payments.qontoPollOkShort'));
    loadPayments();
  } catch (ex) {
    if (result) result.textContent = ex.message;
    notify.error(ex.message);
    loadQontoStatus();
  }
});

function activatePaymentsView(view) {
  const next =
    view === 'portal'
      ? 'portal'
      : view === 'plans'
        ? 'plans'
        : view === 'history'
          ? 'history'
          : 'reconcile';
  paymentsView = next;
  $$('#tab-payments .payments-subnav-btn[data-payments-view]').forEach((btn) => {
    const active = btn.dataset.paymentsView === next;
    btn.classList.toggle('active', active);
    if (active && typeof btn.scrollIntoView === 'function') {
      try {
        btn.scrollIntoView({
          behavior: 'smooth',
          inline: 'center',
          block: 'nearest',
        });
      } catch {
        btn.scrollIntoView();
      }
    }
  });
  $$('#payments-mobile-bottom-nav [data-payments-view]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.paymentsView === next);
  });
  $('#payments-view-reconcile')?.classList.toggle('hidden', next !== 'reconcile');
  $('#payments-view-history')?.classList.toggle('hidden', next !== 'history');
  $('#payments-view-plans')?.classList.toggle('hidden', next !== 'plans');
  $('#payments-view-portal')?.classList.toggle('hidden', next !== 'portal');
  syncPaymentsMobileChrome();
  if (activeTab === 'payments') {
    try {
      const url = new URL(window.location.href);
      if (next === 'reconcile') url.searchParams.delete('paymentsView');
      else url.searchParams.set('paymentsView', next);
      window.history.replaceState({}, '', url.toString());
    } catch {
      /* ignore */
    }
    if (next === 'portal') {
      loadPortalPaymentRules().catch((ex) => notify.error(ex.message));
    } else if (next === 'plans') {
      loadPaymentPlans().catch((ex) => notify.error(ex.message));
    } else if (next === 'history') {
      loadPaymentsHistory();
    } else {
      loadPaymentsReconcile();
    }
  }
}

function applyPaymentsViewFromUrl() {
  try {
    const view = new URLSearchParams(window.location.search).get('paymentsView');
    if (view === 'portal') activatePaymentsView('portal');
    else if (view === 'plans') activatePaymentsView('plans');
    else if (view === 'history') activatePaymentsView('history');
    else activatePaymentsView('reconcile');
  } catch {
    activatePaymentsView('reconcile');
  }
}

function activateTab(tab) {
  if (!tab) return;
  const btn = $(`.nav-btn[data-tab="${tab}"]`);
  if (!btn || btn.classList.contains('hidden')) return;
  activeTab = tab;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach((el) => el.classList.add('hidden'));
  $(`#tab-${tab}`)?.classList.remove('hidden');
  updateMobilePageTitle(tab);
  updateMobileBottomNav(tab);
  closeSidebar();
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    if (tab !== 'payments') url.searchParams.delete('paymentsView');
    window.history.replaceState({}, '', url.toString());
  } catch {
    /* ignore */
  }
  if (tab === 'payments') applyPaymentsViewFromUrl();
  if (tab === 'conversations' && isConversationsMobile()) {
    setConversationsMobileView(conversationsSelectedId ? conversationsMobileView || 'chat' : 'list');
  }
  refreshActiveTab();
}

function applyTabFromUrl() {
  try {
    const tab = new URLSearchParams(window.location.search).get('tab');
    if (tab) activateTab(tab);
  } catch {
    /* ignore */
  }
}

function buildAssignOptionsHtml(payment, selectedHostawayId) {
  const reservation = payment.matchedReservation;
  const candidates = Array.isArray(payment.matchCandidates) ? payment.matchCandidates : [];
  const seenIds = new Set();
  const options = [];
  const preferred = selectedHostawayId != null ? Number(selectedHostawayId) : null;

  const pushOption = (c, selected) => {
    const id = Number(c.hostawayId);
    if (!id || seenIds.has(id)) return;
    seenIds.add(id);
    cachePaymentReservation(c.listing ? c : {
      ...c,
      listing: c.listingName
        ? {
            name: c.listingName,
            roomType: c.listingRoomType || null,
            rawMetadata: c.listingCoverUrl ? { coverImageUrl: c.listingCoverUrl } : null,
          }
        : c.listing,
    });
    const fullLabel = formatReservationOption(c, payment.currency);
    const guest = String(c.guestName || '').trim();
    const dates = formatStayDates(c.arrivalDate, c.departureDate);
    const listing = c.listingName || c.listing?.name || '';
    const totalLabel =
      c.totalPrice != null ? formatMoney(c.totalPrice, payment.currency) : '';
    let paidLabel = '';
    let paidAmount = null;
    if (c.paidAmount != null && Number.isFinite(Number(c.paidAmount))) {
      paidAmount = Number(c.paidAmount);
      paidLabel = formatMoney(paidAmount, payment.currency);
    } else if (
      c.totalPrice != null &&
      c.balanceDue != null &&
      Number.isFinite(Number(c.totalPrice)) &&
      Number.isFinite(Number(c.balanceDue))
    ) {
      paidAmount = Math.max(0, Math.round((Number(c.totalPrice) - Number(c.balanceDue)) * 100) / 100);
      if (paidAmount > 0) paidLabel = formatMoney(paidAmount, payment.currency);
    }
    const channelRaw = c.channelName || '';
    const channel = channelRaw ? prettyChannel(channelRaw) : '';
    const arrival = c.arrivalDate ? String(c.arrivalDate).slice(0, 10) : '';
    const departure = c.departureDate ? String(c.departureDate).slice(0, 10) : '';
    const roomType = c.listingRoomType || c.listing?.roomType || '';
    const coverUrl =
      c.listingCoverUrl ||
      c.listing?.rawMetadata?.coverImageUrl ||
      '';
    options.push(
      `<option value="${id}"` +
        ` title="${esc(fullLabel)}"` +
        ` data-total-price="${c.totalPrice != null ? Number(c.totalPrice) : ''}"` +
        ` data-guest="${esc(guest)}"` +
        ` data-dates="${esc(dates)}"` +
        ` data-listing="${esc(listing)}"` +
        ` data-amount-label="${esc(totalLabel)}"` +
        ` data-paid-label="${esc(paidLabel)}"` +
        ` data-paid-amount="${paidAmount != null ? paidAmount : ''}"` +
        ` data-channel="${esc(channel)}"` +
        ` data-channel-raw="${esc(channelRaw)}"` +
        ` data-arrival="${esc(arrival)}"` +
        ` data-departure="${esc(departure)}"` +
        ` data-room-type="${esc(roomType)}"` +
        ` data-cover-url="${esc(coverUrl)}"` +
        `${selected ? ' selected' : ''}>${esc(formatReservationOptionShort(c, payment.currency))}</option>`,
    );
  };

  for (const c of candidates) {
    const id = Number(c.hostawayId);
    if (!id) continue;
    const selected = preferred
      ? preferred === id
      : reservation?.hostawayId && Number(reservation.hostawayId) === id;
    pushOption(c, selected);
  }
  if (reservation?.hostawayId && !seenIds.has(Number(reservation.hostawayId))) {
    const id = Number(reservation.hostawayId);
    const selected = preferred ? preferred === id : true;
    pushOption(
      {
        hostawayId: reservation.hostawayId,
        guestName: reservation.guestName,
        listingName: reservation.listing?.name,
        listingRoomType: reservation.listing?.roomType,
        listingCoverUrl: reservation.listing?.rawMetadata?.coverImageUrl,
        listing: reservation.listing,
        arrivalDate: reservation.arrivalDate,
        departureDate: reservation.departureDate,
        totalPrice: reservation.totalPrice,
        paidAmount: reservationPaidAmount(reservation),
        channelName: reservation.channelName,
        balanceDue: reservation.balanceDue,
      },
      selected,
    );
  }
  return options.join('');
}

/** Native &lt;select&gt; popups overflow on mobile — custom dropdown with responsive panel. */
let paymentAssignDropdownBound = false;

function bindPaymentAssignDropdownGlobal() {
  if (paymentAssignDropdownBound) return;
  paymentAssignDropdownBound = true;
  document.addEventListener('click', (e) => {
    if (e.target.closest('.payment-assign-wrap')) return;
    closePaymentAssignDropdowns();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePaymentAssignDropdowns();
  });
}

function setPaymentAssignDropdownOpen(wrap, open) {
  if (!wrap) return;
  const trigger = wrap.querySelector('.payment-assign-trigger');
  const panel = wrap.querySelector('.payment-assign-panel');
  wrap.classList.toggle('is-open', open);
  trigger?.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (panel) panel.hidden = !open;
  if (open) closeReservationSearchPanels();
}

function closePaymentAssignDropdowns(exceptWrap = null) {
  document.querySelectorAll('.payment-assign-wrap').forEach((wrap) => {
    if (wrap === exceptWrap) return;
    const panel = wrap.querySelector('.payment-assign-panel');
    if (wrap.classList.contains('is-open') || (panel && !panel.hidden)) {
      setPaymentAssignDropdownOpen(wrap, false);
    }
  });
}

function buildAssignChoiceButton(opt) {
  const guest = opt.dataset.guest || '';
  const dates = opt.dataset.dates || '';
  const listing = opt.dataset.listing || '';
  const amount = opt.dataset.amountLabel || '';
  const paid = opt.dataset.paidLabel || '';
  const channelRaw = opt.dataset.channelRaw || '';
  const meta = [listing, dates].filter(Boolean).join(' · ');
  const titleGuest = guest || '–';
  return `
    <button type="button" class="payment-assign-choice payment-res-result" data-value="${esc(opt.value)}"
      role="option" title="${esc(opt.title || opt.textContent || '')}">
      <span class="payment-res-result-main">
        <span class="payment-res-result-title">#${esc(opt.value)} — ${esc(titleGuest)}</span>
        ${meta ? `<span class="payment-res-result-meta">${esc(meta)}</span>` : ''}
      </span>
      <span class="payment-res-result-side">
        ${channelRaw ? renderChannelBadge(channelRaw) : ''}
        <span class="payment-res-result-amounts">
          ${amount ? `<span class="payment-res-result-total">${esc(amount)}</span>` : ''}
          <span class="payment-res-result-paid">${esc(t('listings.paidAmount'))}: ${esc(paid || '–')}</span>
        </span>
      </span>
    </button>`;
}

function syncAssignDropdown(wrap, select) {
  const label = wrap.querySelector('.payment-assign-trigger-label');
  const selectedOpt = select.selectedOptions?.[0];
  if (label) {
    label.textContent = selectedOpt?.value
      ? (selectedOpt.textContent || '').trim()
      : t('payments.pickReservation');
  }
  wrap.querySelectorAll('.payment-assign-choice').forEach((btn) => {
    const on = btn.dataset.value === select.value;
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function mountAssignChoices(root = document) {
  bindPaymentAssignDropdownGlobal();
  const selects = root.querySelectorAll
    ? root.querySelectorAll('.payment-assign-select')
    : [];
  selects.forEach((select) => {
    if (!(select instanceof HTMLSelectElement)) return;

    let wrap = select.closest('.payment-assign-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'payment-assign-wrap';
      select.parentNode?.insertBefore(wrap, select);
      wrap.appendChild(select);
    }

    wrap.querySelector('.payment-assign-dropdown')?.remove();
    select.classList.remove('payment-assign-select-hidden');
    select.removeAttribute('aria-hidden');
    select.tabIndex = -1;

    const dropdown = document.createElement('div');
    dropdown.className = 'payment-assign-dropdown';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'payment-assign-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = `
      <span class="payment-assign-trigger-label">${esc(t('payments.pickReservation'))}</span>
      <span class="payment-assign-trigger-caret" aria-hidden="true"></span>
    `;

    const panel = document.createElement('div');
    panel.className = 'payment-assign-panel';
    panel.hidden = true;

    const list = document.createElement('div');
    list.className = 'payment-assign-choices';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', t('payments.pickReservation'));
    list.innerHTML = [...select.options]
      .filter((opt) => opt.value)
      .map((opt) => buildAssignChoiceButton(opt))
      .join('');

    panel.appendChild(list);
    dropdown.appendChild(trigger);
    dropdown.appendChild(panel);
    wrap.appendChild(dropdown);
    // Hide native select only after the visible trigger is in the DOM.
    select.classList.add('payment-assign-select-hidden');

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = wrap.classList.contains('is-open') && !panel.hidden;
      closePaymentAssignDropdowns();
      if (!open) setPaymentAssignDropdownOpen(wrap, true);
    });

    list.addEventListener('click', (e) => {
      const btn = e.target.closest('.payment-assign-choice');
      if (!btn) return;
      select.value = btn.dataset.value;
      syncAssignDropdown(wrap, select);
      setPaymentAssignDropdownOpen(wrap, false);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    syncAssignDropdown(wrap, select);
  });
}

function paymentSplitRowTemplate(paymentId, optionsHtml, rowIndex, amount, selectedHostawayId, percent) {
  const amountValue = amount != null && Number.isFinite(Number(amount))
    ? Number(amount).toFixed(2)
    : '';
  const percentValue = percent != null && Number.isFinite(Number(percent))
    ? String(Number(percent))
    : '';
  let options = optionsHtml;
  if (selectedHostawayId) {
    // Ensure selected option is marked for this row.
    options = options
      .replace(/ selected/g, '')
      .replace(
        new RegExp(`value="${Number(selectedHostawayId)}"`),
        `value="${Number(selectedHostawayId)}" selected`,
      );
  }
  return `
    <div class="payment-split-row" data-payment-id="${paymentId}" data-row-index="${rowIndex}">
      <div class="payment-split-row-head">
        <label class="payment-field-label">${t('payments.assignLabel')} ${rowIndex + 1}</label>
        <button type="button" class="btn ghost btn-sm payment-split-remove" data-payment-id="${paymentId}" data-row-index="${rowIndex}" title="${t('payments.splitRemove')}">${t('payments.splitRemove')}</button>
      </div>
      <div class="payment-booking-pick">
        <div class="payment-booking-pick-block">
          <span class="payment-field-label">${t('payments.suggestedBookingSelect')}</span>
          <div class="payment-assign-wrap">
            <select class="payment-assign-select" data-payment-id="${paymentId}" data-row-index="${rowIndex}" aria-label="${esc(t('payments.suggestedBookingSelect'))}">
              <option value="">${t('payments.pickReservation')}</option>
              ${options}
            </select>
          </div>
        </div>
        <div class="payment-booking-pick-block">
          <div class="payment-res-search" data-payment-id="${paymentId}" data-row-index="${rowIndex}">
            <div class="payment-res-search-input-wrap">
              <svg class="payment-res-search-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
                <circle cx="11" cy="11" r="6.25" fill="none" stroke="currentColor" stroke-width="2"/>
                <path d="M16 16.5 20 20.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
              <input type="text" class="payment-assign-manual" data-payment-id="${paymentId}" data-row-index="${rowIndex}"
                autocomplete="off"
                placeholder="${t('payments.manualReservationId')}"
                title="${t('payments.manualReservationHint')}"
                aria-label="${esc(t('payments.searchBooking'))}" />
            </div>
          </div>
        </div>
      </div>
      <div class="payment-split-fields">
        <div class="payment-split-field">
          <label class="payment-field-label">${t('payments.splitPercent')}</label>
          <div class="payment-split-percent-wrap">
            <input type="number" class="payment-split-percent" data-payment-id="${paymentId}" data-row-index="${rowIndex}"
              min="0.01" max="100" step="0.01" value="${percentValue}"
              placeholder="25" title="${t('payments.splitPercentHint')}" />
            <span class="payment-split-percent-suffix">%</span>
          </div>
        </div>
        <div class="payment-split-field">
          <label class="payment-field-label">${t('payments.splitAmount')}</label>
          <input type="number" class="payment-split-amount" data-payment-id="${paymentId}" data-row-index="${rowIndex}"
            min="0.01" step="0.01" value="${amountValue}" />
        </div>
      </div>
    </div>`;
}

function getSplitRowBookingTotal(paymentId, row) {
  const payment = window.__paymentSplitById?.get(paymentId);
  const select = row.querySelector('.payment-assign-select');
  const manual = row.querySelector('.payment-assign-manual');
  const hostawayId =
    parseReservationIdInput(manual?.value) ||
    (select?.value ? Number(select.value) : undefined);
  if (!hostawayId) return null;

  const opt = select?.querySelector(`option[value="${hostawayId}"]`);
  const fromOpt = Number(opt?.dataset?.totalPrice);
  if (Number.isFinite(fromOpt) && fromOpt > 0) return fromOpt;

  const candidates = Array.isArray(payment?.matchCandidates) ? payment.matchCandidates : [];
  const candidate = candidates.find((c) => Number(c.hostawayId) === hostawayId);
  if (candidate?.totalPrice != null && Number(candidate.totalPrice) > 0) {
    return Number(candidate.totalPrice);
  }
  if (
    Number(payment?.matchedReservation?.hostawayId) === hostawayId &&
    payment.matchedReservation.totalPrice != null &&
    Number(payment.matchedReservation.totalPrice) > 0
  ) {
    return Number(payment.matchedReservation.totalPrice);
  }
  return null;
}

function applySplitRowPercentage(paymentId, row) {
  const pctInput = row.querySelector('.payment-split-percent');
  const amountInput = row.querySelector('.payment-split-amount');
  if (!pctInput || !amountInput) return false;
  const pct = Number(pctInput.value);
  if (!Number.isFinite(pct) || pct <= 0) return false;
  const bookingTotal = getSplitRowBookingTotal(paymentId, row);
  if (bookingTotal == null) return false;
  amountInput.value = (Math.round(bookingTotal * pct) / 100).toFixed(2);
  return true;
}

function initPaymentSplitRows(paymentId, paymentAmount, optionsHtml, rows) {
  const container = $(`.payment-split-rows[data-payment-id="${paymentId}"]`);
  if (!container) return;
  const seed = Array.isArray(rows) && rows.length
    ? rows
    : [{ reservationHostawayId: undefined, amount: paymentAmount }];
  container.innerHTML = seed.map((row, index) =>
    paymentSplitRowTemplate(
      paymentId,
      optionsHtml,
      index,
      row.amount != null ? row.amount : (seed.length === 1 ? paymentAmount : ''),
      row.reservationHostawayId,
      row.percent,
    ),
  ).join('');
  // Recalculate amounts from percentage when both booking + % are set.
  // If amount is set but % empty and booking total known, derive %.
  container.querySelectorAll('.payment-split-row').forEach((row) => {
    const pctInput = row.querySelector('.payment-split-percent');
    if (pctInput?.value) {
      applySplitRowPercentage(paymentId, row);
      return;
    }
    const bookingTotal = getSplitRowBookingTotal(paymentId, row);
    const amount = Number(row.querySelector('.payment-split-amount')?.value);
    if (bookingTotal && amount > 0 && pctInput) {
      const pct = Math.round((amount / bookingTotal) * 10000) / 100;
      if (pct > 0 && pct <= 100) pctInput.value = String(pct);
    }
  });
  mountAssignChoices(container);
  updatePaymentSplitUi(paymentId);
}

function updatePaymentSplitUi(paymentId) {
  const container = $(`.payment-split-rows[data-payment-id="${paymentId}"]`);
  const stack = $(`.payment-actions-stack[data-payment-id="${paymentId}"]`);
  const totalEl = $(`.payment-split-total[data-payment-id="${paymentId}"]`);
  if (!container || !stack) return;
  const rows = [...container.querySelectorAll('.payment-split-row')];
  const paymentAmount = Number(stack.dataset.paymentAmount || 0);
  rows.forEach((row, index) => {
    row.dataset.rowIndex = String(index);
    const label = row.querySelector('.payment-split-row-head .payment-field-label');
    if (label) label.textContent = `${t('payments.assignLabel')} ${index + 1}`;
    row.querySelectorAll('[data-row-index]').forEach((el) => {
      el.dataset.rowIndex = String(index);
    });
    const removeBtn = row.querySelector('.payment-split-remove');
    if (removeBtn) removeBtn.classList.toggle('hidden', rows.length <= 1);
    const amountInput = row.querySelector('.payment-split-amount');
    if (amountInput && rows.length === 1 && !amountInput.value) {
      amountInput.value = paymentAmount.toFixed(2);
    }
  });
  const sum = Math.round(
    rows.reduce((acc, row) => acc + (Number(row.querySelector('.payment-split-amount')?.value) || 0), 0) * 100,
  ) / 100;
  if (totalEl) {
    const ok = Math.abs(sum - paymentAmount) <= 0.01;
    const currency = stack.dataset.currency || 'EUR';
    totalEl.innerHTML = `${esc(t('payments.allocationTotal', {
      sum: formatMoney(sum, currency),
    }))}${ok ? '<span class="payment-alloc-check" aria-hidden="true">✓</span>' : ''}`;
    totalEl.classList.toggle('is-invalid', !ok);
    totalEl.classList.toggle('is-ok', ok);
  }
  stack.classList.toggle('is-split', rows.length > 1);
  refreshPaymentReviewSidePanels(paymentId);
}

function collectPaymentSplitAllocations(paymentId) {
  const container = $(`.payment-split-rows[data-payment-id="${paymentId}"]`);
  if (!container) return [];
  return [...container.querySelectorAll('.payment-split-row')].map((row) => {
    const select = row.querySelector('.payment-assign-select');
    const manual = row.querySelector('.payment-assign-manual');
    const amountInput = row.querySelector('.payment-split-amount');
    const fromManual = parseReservationIdInput(manual?.value);
    const fromSelect = select?.value ? Number(select.value) : undefined;
    return {
      reservationHostawayId: fromManual || fromSelect,
      amount: Math.round((Number(amountInput?.value) || 0) * 100) / 100,
    };
  }).filter((row) => row.reservationHostawayId && row.amount >= 0.01);
}

function bindPaymentSplitControls(paymentItems) {
  const byId = new Map((paymentItems || []).map((p) => [p.id, p]));
  window.__paymentSplitById = byId;

  $$('.payment-split-add').forEach((btn) => {
    btn.addEventListener('click', () => {
      const paymentId = btn.dataset.paymentId;
      const payment = window.__paymentSplitById?.get(paymentId);
      const container = $(`.payment-split-rows[data-payment-id="${paymentId}"]`);
      if (!container || !payment) return;
      const optionsHtml = buildAssignOptionsHtml(payment);
      const index = container.querySelectorAll('.payment-split-row').length;
      const allocated = Math.round(
        [...container.querySelectorAll('.payment-split-amount')].reduce(
          (acc, input) => acc + (Number(input.value) || 0),
          0,
        ) * 100,
      ) / 100;
      const remaining = Math.round((Number(payment.amount) - allocated) * 100) / 100;
      container.insertAdjacentHTML(
        'beforeend',
        paymentSplitRowTemplate(
          paymentId,
          optionsHtml,
          index,
          remaining >= 0.01 ? remaining : '',
        ),
      );
      mountAssignChoices(container);
      updatePaymentSplitUi(paymentId);
      bindReservationSearchInputs();
      bindPaymentHostawayOpeners();
    });
  });

  $$('.payment-apply-split-hint').forEach((btn) => {
    btn.addEventListener('click', () => {
      const paymentId = btn.dataset.paymentId;
      const payment = window.__paymentSplitById?.get(paymentId);
      const hint = payment?.combinedDepositHint;
      if (!payment || !hint?.reservationHostawayIds?.length) return;
      const optionsHtml = buildAssignOptionsHtml(payment);
      initPaymentSplitRows(
        paymentId,
        payment.amount,
        optionsHtml,
        hint.reservationHostawayIds.map((id, idx) => {
          const bookingTotal = (() => {
            const candidates = Array.isArray(payment.matchCandidates) ? payment.matchCandidates : [];
            const c = candidates.find((row) => Number(row.hostawayId) === Number(id));
            return c?.totalPrice != null ? Number(c.totalPrice) : null;
          })();
          const suggested = hint.suggestedAmounts?.[idx];
          const looksLike25 =
            bookingTotal != null &&
            suggested != null &&
            Math.abs(suggested - bookingTotal * 0.25) <= 1.01;
          return {
            reservationHostawayId: id,
            amount: suggested,
            percent: looksLike25 ? 25 : undefined,
          };
        }),
      );
      bindReservationSearchInputs();
      bindPaymentHostawayOpeners();
      refreshPaymentReviewSidePanels(paymentId);
    });
  });

  const table = $('#payments-table');
  if (table && !table.dataset.splitDelegationBound) {
    table.dataset.splitDelegationBound = '1';
    table.addEventListener('click', (e) => {
      const removeBtn = e.target.closest?.('.payment-split-remove');
      if (!removeBtn) return;
      const paymentId = removeBtn.dataset.paymentId;
      const row = removeBtn.closest('.payment-split-row');
      const container = $(`.payment-split-rows[data-payment-id="${paymentId}"]`);
      if (!row || !container) return;
      if (container.querySelectorAll('.payment-split-row').length <= 1) return;
      row.remove();
      updatePaymentSplitUi(paymentId);
    });
    table.addEventListener('input', (e) => {
      const paymentId = e.target.dataset?.paymentId;
      if (!paymentId) return;
      const row = e.target.closest?.('.payment-split-row');
      if (e.target.classList?.contains('payment-split-percent')) {
        if (row) applySplitRowPercentage(paymentId, row);
        updatePaymentSplitUi(paymentId);
        return;
      }
      if (e.target.classList?.contains('payment-split-amount')) {
        // Manual amount override — clear % so it does not fight the typed value.
        const pct = row?.querySelector('.payment-split-percent');
        if (pct) pct.value = '';
        updatePaymentSplitUi(paymentId);
      }
    });
    table.addEventListener('change', (e) => {
      if (!e.target.classList?.contains('payment-assign-select')) return;
      const paymentId = e.target.dataset.paymentId;
      const row = e.target.closest('.payment-split-row');
      if (!paymentId || !row) return;
      if (row.querySelector('.payment-split-percent')?.value) {
        applySplitRowPercentage(paymentId, row);
      }
      updatePaymentSplitUi(paymentId);
    });
  }
}

async function loadPayments() {
  if (paymentsView === 'portal') {
    return loadPortalPaymentRules().catch((ex) => notify.error(ex.message));
  }
  if (paymentsView === 'plans') {
    return loadPaymentPlans().catch((ex) => notify.error(ex.message));
  }
  if (paymentsView === 'history') {
    return loadPaymentsHistory();
  }
  return loadPaymentsReconcile();
}

async function loadPaymentsReconcile() {
  loadQontoStatus();
  loadPaypalStatus();
  try {
    const response = await api('/payments/review-queue');
    const paymentList = Array.isArray(response) ? response : (response.items || []);
    ensurePaymentsToolbar(loadPayments);

    const dateFilter = tableState.payments.date || 'all';
    const now = Date.now();
    const dateMs =
      dateFilter === '24h'
        ? 24 * 60 * 60 * 1000
        : dateFilter === '7d'
          ? 7 * 24 * 60 * 60 * 1000
          : dateFilter === '30d'
            ? 30 * 24 * 60 * 60 * 1000
            : null;
    let filtered = paymentList.filter((p) => {
      if (dateMs != null) {
        const ts = new Date(p.occurredAt || p.createdAt).getTime();
        if (!Number.isFinite(ts) || now - ts > dateMs) return false;
      }
      return true;
    });
    // Weakest matches first so hard review cases surface early.
    filtered = [...filtered].sort((a, b) => {
      const scoreA = Number(a.matchScore);
      const scoreB = Number(b.matchScore);
      const sa = Number.isFinite(scoreA) ? scoreA : 999;
      const sb = Number.isFinite(scoreB) ? scoreB : 999;
      if (sa !== sb) return sa - sb;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });

    const countEl = $('#payments-queue-count');
    if (countEl) {
      countEl.textContent = String(filtered.length);
      countEl.hidden = filtered.length === 0;
    }
    updatePaymentsMobileQueueBadge(filtered.length);

    const data = paginateClient(filtered, 'payments', (p) => [
      p.createdAt,
      p.source,
      p.status,
      p.matchDecision,
      p.payerName,
      p.payerEmail,
      p.reference,
      p.matchedReservation?.listing?.name,
      p.matchedReservation?.guestName,
    ].join(' '));
  const rows = data.items.map((p) => {
    const reservation = p.matchedReservation;
    const candidates = Array.isArray(p.matchCandidates) ? p.matchCandidates : [];
    const bestCandidate =
      candidates.find((c) => Number(c.hostawayId) === Number(reservation?.hostawayId)) ||
      candidates[0];
    const canReview = hasPermission('PAYMENTS_REVIEW');
    const defaultOpenId =
      reservation?.hostawayId ||
      bestCandidate?.hostawayId ||
      (candidates[0] && candidates[0].hostawayId);
    const openHostawayBtn = renderOpenInHostawayButton(defaultOpenId);
    const hint = p.combinedDepositHint;
    const hintHtml = hint
      ? `<div class="payment-split-hint" data-payment-id="${p.id}">
          <span class="payment-split-hint-icon" aria-hidden="true">!</span>
          <div class="payment-split-hint-body">
            <strong>${t('payments.combinedDepositHintTitle')}</strong>
            <span>${t('payments.combinedDepositHint', { guest: hint.guestName || '–' })}</span>
          </div>
          <button type="button" class="payment-split-hint-link payment-apply-split-hint" data-payment-id="${p.id}">${t('payments.combinedDepositLearnMore')}</button>
        </div>`
      : '';
    const suggestionHtml =
      candidates.length > 1
        ? `<div class="payment-suggestion-stack">${candidates
            .slice(0, 3)
            .map((c) =>
              renderSuggestedReservation(
                Number(reservation?.hostawayId) === Number(c.hostawayId)
                  ? reservation
                  : null,
                c,
                p.currency,
                p,
              ),
            )
            .join('')}</div>`
        : renderSuggestedReservation(reservation, bestCandidate, p.currency, p);
    const initialAmount = Number(p.amount) || 0;
    const actionsCell = canReview
      ? `<td class="payment-actions-cell">
        <div class="payment-actions-stack" data-payment-id="${p.id}" data-payment-amount="${initialAmount}" data-currency="${esc(p.currency || 'EUR')}">
          ${hintHtml}
          <div class="payment-split-rows" data-payment-id="${p.id}"></div>
          <div class="payment-split-toolbar">
            <button type="button" class="btn payment-btn-split payment-split-add" data-payment-id="${p.id}">${t('payments.split')}</button>
            <span class="payment-split-total muted" data-payment-id="${p.id}"></span>
          </div>
          <div class="payment-action-footer">
            <div class="payment-action-btns">
              <button type="button" class="btn payment-btn-confirm payment-confirm-btn" data-payment-id="${p.id}">${t('payments.confirm')}</button>
              <button type="button" class="btn payment-btn-skip payment-skip-btn" data-payment-id="${p.id}">${t('payments.skip')}</button>
              ${openHostawayBtn}
            </div>
          </div>
        </div>
      </td>`
      : `<td class="payment-actions-cell is-readonly">
        ${openHostawayBtn || `<span class="muted feature-locked-hint">${t('perms.featureLocked')}</span>`}
      </td>`;
    return `
    <tr class="payment-review-row" data-payment-id="${p.id}">
      <td class="payment-payment-cell">${renderPaymentPayerCell(p)}</td>
      <td class="payment-match-cell">${renderMatchCell(p, candidates, bestCandidate)}</td>
      <td class="payment-suggestion-cell">${suggestionHtml}</td>
      ${actionsCell}
    </tr>`;
  }).join('');
  const emptyHtml = rows
    ? ''
    : `<p class="payments-empty">${t('payments.none')}</p>`;
  $('#payments-table').innerHTML = `
    <table class="payments-review-table"><colgroup>
      <col class="col-payment" /><col class="col-match" />
      <col class="col-reservation" /><col class="col-actions" />
    </colgroup><thead><tr>
      <th>${t('payments.paymentPayerCol')}</th>
      <th>${t('payments.match')}</th>
      <th>${t('payments.reservation')}</th>
      <th>${t('payments.actions')}</th>
    </tr></thead>
    <tbody>${rows}</tbody></table>
    ${emptyHtml}`;
  renderTableInfo('#payments-info', data, data.maxTotal);
  renderPagination('#payments-pagination', data, 'payments', loadPayments);

  // One booking row by default; combined-deposit hint is opt-in via button.
  window.__paymentSplitById = new Map(data.items.map((p) => [p.id, p]));
  data.items.forEach((p) => {
    if (p.matchedReservation) cachePaymentReservation(p.matchedReservation);
    (Array.isArray(p.matchCandidates) ? p.matchCandidates : []).forEach((c) => {
      cachePaymentReservation({
        ...c,
        listing: {
          name: c.listingName,
          roomType: c.listingRoomType || null,
          rawMetadata: c.listingCoverUrl ? { coverImageUrl: c.listingCoverUrl } : null,
        },
      });
    });
    const optionsHtml = buildAssignOptionsHtml(p);
    const defaultId =
      p.matchedReservation?.hostawayId ||
      (Array.isArray(p.matchCandidates) && p.matchCandidates[0]?.hostawayId) ||
      undefined;
    initPaymentSplitRows(p.id, p.amount, optionsHtml, [
      { reservationHostawayId: defaultId, amount: p.amount },
    ]);
  });

  bindReservationSearchInputs();
  bindExpandableToggles('#payments-table');
  bindPaymentHostawayOpeners();
  bindPaymentSplitControls(data.items);
  bindPaymentMatchCandidatePicks();

  $$('.payment-find-booking').forEach((btn) => {
    btn.addEventListener('click', () => {
      const paymentId = btn.dataset.paymentId;
      const input = $(
        `.payment-actions-stack[data-payment-id="${paymentId}"] .payment-assign-manual`,
      );
      input?.focus();
      input?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  });

  $$('.payment-confirm-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!hasPermission('PAYMENTS_REVIEW')) return;
      const paymentId = btn.dataset.paymentId;
      const stack = $(`.payment-actions-stack[data-payment-id="${paymentId}"]`);
      const paymentAmount = Number(stack?.dataset.paymentAmount || 0);
      const allocations = collectPaymentSplitAllocations(paymentId);
      if (!allocations.length) {
        notify.error(t('payments.splitNeedReservation'));
        return;
      }
      const sum = Math.round(allocations.reduce((acc, row) => acc + row.amount, 0) * 100) / 100;
      if (Math.abs(sum - paymentAmount) > 0.01) {
        notify.error(t('payments.splitSumMismatch', {
          sum: formatMoney(sum),
          total: formatMoney(paymentAmount),
        }));
        return;
      }
      const body = allocations.length === 1
        ? { reservationHostawayId: allocations[0].reservationHostawayId }
        : { allocations };
      try {
        await api(`/payments/${paymentId}/confirm`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        notify.success(
          allocations.length > 1 ? t('payments.splitOk') : t('payments.confirmOk'),
        );
        loadPayments();
      } catch (ex) {
        notify.error(ex.message);
      }
    });
  });

  $$('.payment-skip-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!hasPermission('PAYMENTS_REVIEW')) return;
      try {
        await api(`/payments/${btn.dataset.paymentId}/skip`, { method: 'POST', body: '{}' });
        notify.success(t('payments.skipOk'));
        loadPayments();
      } catch (ex) {
        notify.error(ex.message);
      }
    });
  });
  applyRoleUi();
  scheduleEnhanceResponsiveTables();
  } catch (ex) {
    notify.error(ex.message);
    $('#payments-table').innerHTML = `<p class="error">${esc(ex.message)}</p>`;
  }
}

async function loadPortalPaymentRules() {
  const list = $('#portal-rules-list');
  const statsEl = $('#portal-rules-stats');
  if (!list) return;

  const fetched = await api('/payments/portal-rules');
  const rules = Array.isArray(fetched) ? fetched : [];
  const canEdit = hasPermission('PAYMENTS_ADMIN');
  const unitPercent = t('payments.portalUnitPercent');
  const unitDays = t('payments.portalUnitDays');

  const optionalStr = (v) => (v == null || v === '' ? '' : String(v));
  const portalMark = (name, key) => {
    const src = String(name || key || '').replace(/[^a-zA-Z0-9]/g, '');
    return (src.slice(0, 2) || '??').toUpperCase();
  };
  const PORTAL_LOGO_KEYS = new Set([
    'airbnb',
    'bookingcom',
    'vrbo',
    'expedia',
    'agoda',
    'check24',
    'hometogo',
    'interhome',
    'atraveo',
    'travanto',
    'direct',
  ]);
  const portalLogoHtml = (displayName, portalKey) => {
    const key = String(portalKey || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    if (PORTAL_LOGO_KEYS.has(key)) {
      return `<span class="portal-rule-logo" aria-hidden="true"><img src="/admin/assets/portals/${esc(key)}.svg" alt="" width="38" height="38" loading="lazy" /></span>`;
    }
    return `<span class="portal-rule-logo is-fallback" aria-hidden="true">${esc(portalMark(displayName, portalKey))}</span>`;
  };
  const automationFlags = (rule) =>
    [
      rule.skipUnpaidReminder,
      rule.autoRequestInbox,
      rule.autoRequestOnImport,
      rule.autoSendGuestPaymentLink,
      rule.autoCancelIfUnpaid,
    ].filter(Boolean).length;

  const numField = ({ name, label, help, value, suffix, min, max, disabled }) => `
    <label class="portal-field">
      <span>${esc(label)}</span>
      <span class="portal-input-wrap">
        <input type="number" name="${esc(name)}" min="${min}" max="${max}" value="${esc(value)}" placeholder="—" ${disabled ? 'disabled' : ''} />
        <span class="portal-input-suffix">${esc(suffix)}</span>
      </span>
      <span class="portal-field-help">${esc(help)}</span>
    </label>`;

  const switchRow = ({ name, label, help, checked, disabled }) => `
    <label class="portal-switch-row">
      <span class="portal-switch-copy">
        <strong>${esc(label)}</strong>
        <small>${esc(help)}</small>
      </span>
      <span class="portal-switch">
        <input type="checkbox" name="${esc(name)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
        <span class="portal-switch-ui"></span>
      </span>
    </label>`;

  const enabledCount = rules.filter((r) => r.enabled).length;
  let lastSavedMs = 0;
  for (const rule of rules) {
    const ts = Date.parse(rule.updatedAt || '');
    if (Number.isFinite(ts) && ts > lastSavedMs) lastSavedMs = ts;
  }
  const lastSavedLabel =
    lastSavedMs > 0
      ? (typeof formatDashboardDateTime === 'function'
          ? formatDashboardDateTime(new Date(lastSavedMs).toISOString())
          : formatDateTime(new Date(lastSavedMs).toISOString()))
      : '–';

  if (statsEl) {
    statsEl.innerHTML = `
      <span class="portal-rules-stat">${esc(t('payments.portalChannelsCount', { count: rules.length }))}</span>
      <span class="portal-rules-stat is-enabled">${esc(t('payments.portalEnabledCount', { count: enabledCount }))}</span>
      <span class="portal-rules-stat">${esc(t('payments.portalLastSaved', { when: lastSavedLabel }))}</span>`;
  }

  const defaultOpenKey =
    (rules.find((r) => r.enabled) || rules[0] || {})?.portalKey || '';

  list.innerHTML = rules
    .map((rule) => {
      const matchers = Array.isArray(rule.channelMatchers)
        ? rule.channelMatchers.join(', ')
        : '';
      const enabled = !!rule.enabled;
      const autoCount = automationFlags(rule);
      const portalPct = Number(rule.portalAssumedPaidPercent) || 0;
      const hostPct = Number(rule.hostDuePercent) || 0;
      const summaryMeta = enabled
        ? `<strong>${esc(t('payments.portalShareSummary', { portal: portalPct, host: hostPct }))}</strong><br />${esc(
            t(
              autoCount === 1
                ? 'payments.portalAutomationCount'
                : 'payments.portalAutomationCountPlural',
              { count: autoCount },
            ),
          )}`
        : esc(t('payments.portalNoRules'));
      const badgeClass = enabled
        ? 'portal-rule-badge is-enabled'
        : 'portal-rule-badge';
      const badgeText = enabled
        ? t('payments.portalEnabled')
        : t('payments.portalNotConfigured');
      const logoHtml = portalLogoHtml(rule.displayName, rule.portalKey);
      const isOpen = rule.portalKey === defaultOpenKey;
      const disabledAttr = !canEdit;
      const matchersDisabled = rule.isFallback || !canEdit;

      const initial = {
        enabled,
        skipUnpaidReminder: !!rule.skipUnpaidReminder,
        autoRequestInbox: !!rule.autoRequestInbox,
        autoRequestOnImport: !!rule.autoRequestOnImport,
        autoSendGuestPaymentLink: !!rule.autoSendGuestPaymentLink,
        autoCancelIfUnpaid: !!rule.autoCancelIfUnpaid,
        portalAssumedPaidPercent: String(portalPct),
        hostDuePercent: String(hostPct),
        depositDuePercent: optionalStr(rule.depositDuePercent),
        depositDueDaysAfterBooking: optionalStr(rule.depositDueDaysAfterBooking),
        treatAsPaidUntilDaysBeforeArrival: optionalStr(
          rule.treatAsPaidUntilDaysBeforeArrival,
        ),
        treatAsPaidUntilDaysAfterDeparture: optionalStr(
          rule.treatAsPaidUntilDaysAfterDeparture,
        ),
        hostDueByDaysBeforeArrival: optionalStr(rule.hostDueByDaysBeforeArrival),
        hostDueByDaysAfterDeparture: optionalStr(rule.hostDueByDaysAfterDeparture),
        overdueGraceDays: optionalStr(rule.overdueGraceDays),
        paymentDeadlineDays: optionalStr(rule.paymentDeadlineDays),
        guestReminderDaysBeforeDeadline: optionalStr(
          rule.guestReminderDaysBeforeDeadline,
        ),
        channelMatchers: matchers,
      };

      return `
      <article class="portal-rule-card${isOpen ? ' is-open' : ''}" data-portal-key="${esc(rule.portalKey)}">
        <button type="button" class="portal-rule-summary" aria-expanded="${isOpen ? 'true' : 'false'}">
          <span class="portal-rule-brand">
            ${logoHtml}
            <span>
              <span class="portal-rule-name">${esc(rule.displayName)}${rule.isFallback ? ` · ${esc(t('payments.portalFallback'))}` : ''}</span>
              <span class="portal-rule-key">${esc(rule.portalKey)}</span>
            </span>
          </span>
          <span class="${esc(badgeClass)}">${esc(badgeText)}</span>
          <span class="portal-rule-summary-meta">${summaryMeta}</span>
          <span class="portal-rule-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="portal-rule-body">
          <form class="portal-rule-form" data-portal-key="${esc(rule.portalKey)}" data-initial="${encodeURIComponent(JSON.stringify(initial))}">
            <div class="portal-rule-layout">
              <div class="portal-rule-panel">
                <h4>${esc(t('payments.portalSectionStatus'))}</h4>
                ${switchRow({
                  name: 'enabled',
                  label: t('payments.portalEnabled'),
                  help: t('payments.portalEnabledHelp'),
                  checked: enabled,
                  disabled: disabledAttr,
                })}
                <label class="portal-field">
                  <span>${esc(t('payments.portalMatchers'))}</span>
                  <span class="portal-input-wrap is-text">
                    <input type="text" name="channelMatchers" value="${esc(matchers)}" ${matchersDisabled ? 'disabled' : ''} />
                  </span>
                  <span class="portal-field-help">${esc(t('payments.portalMatchersHelp'))}</span>
                </label>
                <h4>${esc(t('payments.portalSectionDeposit'))}</h4>
                <div class="portal-rule-fields">
                  ${numField({
                    name: 'depositDuePercent',
                    label: t('payments.portalDepositPercent'),
                    help: t('payments.portalDepositPercentHelp'),
                    value: initial.depositDuePercent,
                    suffix: unitPercent,
                    min: 0,
                    max: 100,
                    disabled: disabledAttr,
                  })}
                  ${numField({
                    name: 'depositDueDaysAfterBooking',
                    label: t('payments.portalDepositDays'),
                    help: t('payments.portalDepositDaysHelp'),
                    value: initial.depositDueDaysAfterBooking,
                    suffix: unitDays,
                    min: 0,
                    max: 365,
                    disabled: disabledAttr,
                  })}
                  ${numField({
                    name: 'paymentDeadlineDays',
                    label: t('payments.portalPaymentDeadline'),
                    help: t('payments.portalPaymentDeadlineHelp'),
                    value: initial.paymentDeadlineDays,
                    suffix: unitDays,
                    min: 0,
                    max: 365,
                    disabled: disabledAttr,
                  })}
                  ${numField({
                    name: 'guestReminderDaysBeforeDeadline',
                    label: t('payments.portalGuestReminder'),
                    help: t('payments.portalGuestReminderHelp'),
                    value: initial.guestReminderDaysBeforeDeadline,
                    suffix: unitDays,
                    min: 0,
                    max: 90,
                    disabled: disabledAttr,
                  })}
                </div>
              </div>
              <div class="portal-rule-panel">
                <h4>${esc(t('payments.portalSectionRecognition'))}</h4>
                <div class="portal-rule-fields">
                  ${numField({
                    name: 'portalAssumedPaidPercent',
                    label: t('payments.portalAssumed'),
                    help: t('payments.portalAssumedHelp'),
                    value: initial.portalAssumedPaidPercent,
                    suffix: unitPercent,
                    min: 0,
                    max: 100,
                    disabled: disabledAttr,
                  })}
                  ${numField({
                    name: 'hostDuePercent',
                    label: t('payments.portalHostDue'),
                    help: t('payments.portalHostDueHelp'),
                    value: initial.hostDuePercent,
                    suffix: unitPercent,
                    min: 0,
                    max: 100,
                    disabled: disabledAttr,
                  })}
                  ${numField({
                    name: 'treatAsPaidUntilDaysBeforeArrival',
                    label: t('payments.portalUnverifiedUntil'),
                    help: t('payments.portalUnverifiedUntilHelp'),
                    value: initial.treatAsPaidUntilDaysBeforeArrival,
                    suffix: unitDays,
                    min: 0,
                    max: 365,
                    disabled: disabledAttr,
                  })}
                  ${numField({
                    name: 'treatAsPaidUntilDaysAfterDeparture',
                    label: t('payments.portalUnverifiedAfterCheckout'),
                    help: t('payments.portalUnverifiedAfterCheckoutHelp'),
                    value: initial.treatAsPaidUntilDaysAfterDeparture,
                    suffix: unitDays,
                    min: 0,
                    max: 365,
                    disabled: disabledAttr,
                  })}
                  ${numField({
                    name: 'hostDueByDaysBeforeArrival',
                    label: t('payments.portalHostDueBy'),
                    help: t('payments.portalHostDueByHelp'),
                    value: initial.hostDueByDaysBeforeArrival,
                    suffix: unitDays,
                    min: 0,
                    max: 365,
                    disabled: disabledAttr,
                  })}
                  ${numField({
                    name: 'hostDueByDaysAfterDeparture',
                    label: t('payments.portalHostDueByAfterCheckout'),
                    help: t('payments.portalHostDueByAfterCheckoutHelp'),
                    value: initial.hostDueByDaysAfterDeparture,
                    suffix: unitDays,
                    min: 0,
                    max: 365,
                    disabled: disabledAttr,
                  })}
                  ${numField({
                    name: 'overdueGraceDays',
                    label: t('payments.portalOverdueGrace'),
                    help: t('payments.portalOverdueGraceHelp'),
                    value: initial.overdueGraceDays,
                    suffix: unitDays,
                    min: 0,
                    max: 90,
                    disabled: disabledAttr,
                  })}
                </div>
              </div>
              <div class="portal-rule-panel">
                <h4>${esc(t('payments.portalSectionAutomation'))}</h4>
                <div class="portal-rule-fields is-stack">
                  ${switchRow({
                    name: 'skipUnpaidReminder',
                    label: t('payments.portalSkipReminder'),
                    help: t('payments.portalSkipReminderHelp'),
                    checked: !!rule.skipUnpaidReminder,
                    disabled: disabledAttr,
                  })}
                  ${switchRow({
                    name: 'autoRequestInbox',
                    label: t('payments.portalAutoInbox'),
                    help: t('payments.portalAutoInboxHelp'),
                    checked: !!rule.autoRequestInbox,
                    disabled: disabledAttr,
                  })}
                  ${switchRow({
                    name: 'autoRequestOnImport',
                    label: t('payments.portalAutoImport'),
                    help: t('payments.portalAutoImportHelp'),
                    checked: !!rule.autoRequestOnImport,
                    disabled: disabledAttr,
                  })}
                  ${switchRow({
                    name: 'autoSendGuestPaymentLink',
                    label: t('payments.portalGuestPayLink'),
                    help: t('payments.portalGuestPayLinkHelp'),
                    checked: !!rule.autoSendGuestPaymentLink,
                    disabled: disabledAttr,
                  })}
                  ${switchRow({
                    name: 'autoCancelIfUnpaid',
                    label: t('payments.portalAutoCancel'),
                    help: t('payments.portalAutoCancelHelp'),
                    checked: !!rule.autoCancelIfUnpaid,
                    disabled: disabledAttr,
                  })}
                </div>
              </div>
            </div>
            <div class="portal-rule-actions">
              <span class="portal-rule-save-meta">✓ ${esc(t('payments.portalAllSaved'))}</span>
              ${
                canEdit
                  ? `<div class="portal-rule-actions-right">
                <button type="button" class="btn ghost btn-sm portal-rule-reset">${esc(t('payments.portalReset'))}</button>
                <button type="submit" class="btn primary btn-sm">${esc(t('payments.portalSaveNamed', { name: rule.displayName }))}</button>
              </div>`
                  : ''
              }
            </div>
          </form>
        </div>
      </article>`;
    })
    .join('');

  const restoreForm = (form) => {
    let initial;
    try {
      initial = JSON.parse(
        decodeURIComponent(form.getAttribute('data-initial') || '') || '{}',
      );
    } catch {
      initial = {};
    }
    const setCheck = (name, val) => {
      const el = form.querySelector(`[name="${name}"]`);
      if (el) el.checked = !!val;
    };
    const setVal = (name, val) => {
      const el = form.querySelector(`[name="${name}"]`);
      if (el) el.value = val == null ? '' : String(val);
    };
    setCheck('enabled', initial.enabled);
    setCheck('skipUnpaidReminder', initial.skipUnpaidReminder);
    setCheck('autoRequestInbox', initial.autoRequestInbox);
    setCheck('autoRequestOnImport', initial.autoRequestOnImport);
    setCheck('autoSendGuestPaymentLink', initial.autoSendGuestPaymentLink);
    setCheck('autoCancelIfUnpaid', initial.autoCancelIfUnpaid);
    setVal('portalAssumedPaidPercent', initial.portalAssumedPaidPercent);
    setVal('hostDuePercent', initial.hostDuePercent);
    setVal('depositDuePercent', initial.depositDuePercent);
    setVal('depositDueDaysAfterBooking', initial.depositDueDaysAfterBooking);
    setVal(
      'treatAsPaidUntilDaysBeforeArrival',
      initial.treatAsPaidUntilDaysBeforeArrival,
    );
    setVal(
      'treatAsPaidUntilDaysAfterDeparture',
      initial.treatAsPaidUntilDaysAfterDeparture,
    );
    setVal('hostDueByDaysBeforeArrival', initial.hostDueByDaysBeforeArrival);
    setVal('hostDueByDaysAfterDeparture', initial.hostDueByDaysAfterDeparture);
    setVal('overdueGraceDays', initial.overdueGraceDays);
    setVal('paymentDeadlineDays', initial.paymentDeadlineDays);
    setVal(
      'guestReminderDaysBeforeDeadline',
      initial.guestReminderDaysBeforeDeadline,
    );
    setVal('channelMatchers', initial.channelMatchers);
  };

  list.querySelectorAll('.portal-rule-summary').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.portal-rule-card');
      if (!card) return;
      const willOpen = !card.classList.contains('is-open');
      list.querySelectorAll('.portal-rule-card.is-open').forEach((openCard) => {
        openCard.classList.remove('is-open');
        openCard
          .querySelector('.portal-rule-summary')
          ?.setAttribute('aria-expanded', 'false');
      });
      if (willOpen) {
        card.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });

  list.querySelectorAll('.portal-rule-reset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const form = btn.closest('form');
      if (form) restoreForm(form);
    });
  });

  list.querySelectorAll('.portal-rule-form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!hasPermission('PAYMENTS_ADMIN')) return;
      const portalKey = form.getAttribute('data-portal-key');
      const fd = new FormData(form);
      const optionalInt = (name) => {
        const raw = String(fd.get(name) ?? '').trim();
        if (!raw) return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      };
      const matchersRaw = String(fd.get('channelMatchers') ?? '');
      const body = {
        enabled: form.querySelector('[name="enabled"]')?.checked === true,
        skipUnpaidReminder:
          form.querySelector('[name="skipUnpaidReminder"]')?.checked === true,
        autoRequestInbox:
          form.querySelector('[name="autoRequestInbox"]')?.checked === true,
        autoRequestOnImport:
          form.querySelector('[name="autoRequestOnImport"]')?.checked === true,
        autoSendGuestPaymentLink:
          form.querySelector('[name="autoSendGuestPaymentLink"]')?.checked ===
          true,
        autoCancelIfUnpaid:
          form.querySelector('[name="autoCancelIfUnpaid"]')?.checked === true,
        portalAssumedPaidPercent: Number(fd.get('portalAssumedPaidPercent')) || 0,
        hostDuePercent: Number(fd.get('hostDuePercent')) || 0,
        depositDuePercent: optionalInt('depositDuePercent'),
        depositDueDaysAfterBooking: optionalInt('depositDueDaysAfterBooking'),
        paymentDeadlineDays: optionalInt('paymentDeadlineDays'),
        guestReminderDaysBeforeDeadline: optionalInt(
          'guestReminderDaysBeforeDeadline',
        ),
        treatAsPaidUntilDaysBeforeArrival: optionalInt(
          'treatAsPaidUntilDaysBeforeArrival',
        ),
        treatAsPaidUntilDaysAfterDeparture: optionalInt(
          'treatAsPaidUntilDaysAfterDeparture',
        ),
        hostDueByDaysBeforeArrival: optionalInt('hostDueByDaysBeforeArrival'),
        hostDueByDaysAfterDeparture: optionalInt('hostDueByDaysAfterDeparture'),
        overdueGraceDays: optionalInt('overdueGraceDays'),
        channelMatchers: matchersRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      };
      try {
        await api(`/payments/portal-rules/${encodeURIComponent(portalKey)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        notify.success(t('payments.portalSaved'));
        await loadPortalPaymentRules();
      } catch (ex) {
        notify.error(ex.message);
      }
    });
  });
}

async function loadPaymentsHistory() {
  try {
    const response = await api('/payments?pageSize=100');
    const paymentList = Array.isArray(response) ? response : (response.items || []);
    ensurePaymentsHistoryToolbar(loadPaymentsHistory);
    const s = tableState.paymentsHistory;
    const sourceFilter = s.source || 'all';
    const filtered = paymentList.filter((p) => {
      if (sourceFilter !== 'all' && String(p.source || '').toUpperCase() !== sourceFilter) return false;
      return true;
    });
    const data = paginateClient(filtered, 'paymentsHistory', (p) => [
      p.createdAt,
      p.source,
      p.status,
      p.payerName,
      p.reference,
      p.reviewedBy,
      p.matchedReservation?.listing?.name,
      p.matchedReservation?.hostawayId,
      ...(Array.isArray(p.allocations)
        ? p.allocations.flatMap((a) => [a.reservation?.hostawayId, a.reservation?.listing?.name])
        : []),
    ].join(' '));
    const rows = data.items.map((p) => {
      const reservation = p.matchedReservation;
      const allocations = Array.isArray(p.allocations) ? p.allocations : [];
      let reservationLabel = '<span class="payment-history-empty">–</span>';
      if (allocations.length > 1) {
        reservationLabel = allocations.map((a) => {
          const hostawayId = a.reservation?.hostawayId;
          const listing = a.reservation?.listing?.name || '';
          return `<div class="payment-history-booking"><span class="payment-history-booking-id">#${esc(String(hostawayId || '?'))}</span>${listing ? `<span class="payment-history-booking-name">${esc(listing)}</span>` : ''}</div>`;
        }).join('');
      } else if (reservation) {
        reservationLabel = `<div class="payment-history-booking"><span class="payment-history-booking-id">#${esc(String(reservation.hostawayId))}</span>${reservation.listing?.name ? `<span class="payment-history-booking-name">${esc(reservation.listing.name)}</span>` : ''}</div>`;
      } else if (allocations.length === 1) {
        const a = allocations[0];
        const listing = a.reservation?.listing?.name || '';
        reservationLabel = `<div class="payment-history-booking"><span class="payment-history-booking-id">#${esc(String(a.reservation?.hostawayId || '?'))}</span>${listing ? `<span class="payment-history-booking-name">${esc(listing)}</span>` : ''}</div>`;
      }
      const retryBtn = (p.status === 'FAILED' || p.status === 'RECEIVED') && hasPermission('PAYMENTS_REVIEW')
        ? `<button type="button" class="btn ghost btn-sm payment-retry-btn" data-payment-id="${p.id}">${t('payments.retry')}</button>`
        : '';
      const undoBtn = (p.status === 'AUTO_APPLIED' || p.status === 'MANUALLY_APPLIED') && hasPermission('PAYMENTS_REVIEW')
        ? `<button type="button" class="btn ghost btn-sm payment-undo-btn" data-payment-id="${p.id}">${t('payments.undo')}</button>`
        : '';
      const actions = (retryBtn || undoBtn)
        ? `<div class="payment-history-actions">${retryBtn}${undoBtn}</div>`
        : '';
      const sourceLabel = paymentHistorySourceLabel(p.source);
      const sourceCls =
        String(p.source || '').toUpperCase() === 'PAYPAL'
          ? 'is-paypal'
          : String(p.source || '').toUpperCase() === 'QONTO'
            ? 'is-qonto'
            : '';
      p.__mobileCard = `
        <article class="payments-history-card" data-payment-id="${p.id}">
          <div class="payments-history-card-top">
            <span class="payment-history-received">${esc(formatDateTime(p.createdAt))}</span>
            <div class="payment-history-status-cell">
              ${paymentHistoryStatusBadge(p.status)}
              ${paymentApplyModeHint(p)}
              ${allocations.length > 1 ? `<span class="badge auto">${t('payments.splitBadge')}</span>` : ''}
            </div>
          </div>
          <div class="payment-history-amount">${esc(formatMoney(p.amount, p.currency))}</div>
          <div class="payments-history-card-meta">
            <span class="payment-source-pill ${sourceCls}">${esc(sourceLabel)}</span>
            <span class="payment-history-payer-name">${esc(p.payerName || '–')}</span>
            ${p.reference ? `<span class="payment-history-payer-ref">${esc(p.reference)}</span>` : ''}
          </div>
          ${reservationLabel !== '<span class="payment-history-empty">–</span>' ? `<div class="payments-history-card-booking">${reservationLabel}</div>` : ''}
          ${p.error ? `<div class="payments-history-card-error">${esc(p.error)}</div>` : ''}
          <div class="payments-history-card-foot">
            <span class="payment-history-reviewed-by">${esc(p.reviewedBy || '–')}</span>
            ${actions}
          </div>
        </article>`;
      return `
      <tr>
        <td data-label="${esc(t('payments.time'))}"><span class="payment-history-received">${esc(formatDateTime(p.createdAt))}</span></td>
        <td data-label="${esc(t('payments.source'))}">${esc(sourceLabel)}</td>
        <td data-label="${esc(t('payments.amount'))}" class="cell-money payment-history-amount">${esc(formatMoney(p.amount, p.currency))}</td>
        <td data-label="${esc(t('payments.payer'))}">
          <div class="payment-history-payer">
            <span class="payment-history-payer-name">${esc(p.payerName || '–')}</span>
            ${p.reference ? `<span class="payment-history-payer-ref">${esc(p.reference)}</span>` : ''}
          </div>
        </td>
        <td data-label="${esc(t('payments.status'))}">
          <div class="payment-history-status-cell">
            ${paymentHistoryStatusBadge(p.status)}
            ${paymentApplyModeHint(p)}
            ${p.error ? `<span class="field-hint">${esc(p.error)}</span>` : ''}
            ${allocations.length > 1 ? `<span class="badge auto">${t('payments.splitBadge')}</span>` : ''}
          </div>
        </td>
        <td data-label="${esc(t('payments.reservation'))}">${reservationLabel}</td>
        <td data-label="${esc(t('payments.reviewedBy'))}">
          <div class="payment-history-reviewed">
            <span>${esc(p.reviewedBy || '–')}</span>
            ${actions}
          </div>
        </td>
      </tr>`;
    }).join('');
    $('#payments-history-table').innerHTML = `
      <table class="payments-history-table">
        <thead><tr>
          <th class="is-sorted">${t('payments.time')}</th>
          <th>${t('payments.source')}</th>
          <th>${t('payments.amount')}</th>
          <th>${t('payments.payer')}</th>
          <th>${t('payments.status')}</th>
          <th>${t('payments.reservation')}</th>
          <th>${t('payments.reviewedBy')}</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="7"><div class="payment-history-empty-state">${t('payments.historyNone')}</div></td></tr>`}</tbody>
      </table>`;
    const mobileList = $('#payments-history-mobile-list');
    if (mobileList) {
      mobileList.innerHTML = data.items.length
        ? data.items.map((p) => p.__mobileCard).join('')
        : `<div class="payment-history-empty-state">${t('payments.historyNone')}</div>`;
    }
    renderTableInfo('#payments-history-info', data, data.maxTotal);
    renderPagination('#payments-history-pagination', data, 'paymentsHistory', loadPaymentsHistory);

    $$('.payment-retry-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!hasPermission('PAYMENTS_REVIEW')) return;
        try {
          await api(`/payments/${btn.dataset.paymentId}/retry`, { method: 'POST', body: '{}' });
          notify.success(t('payments.retryOk'));
          loadPayments();
        } catch (ex) {
          notify.error(ex.message);
        }
      });
    });

    $$('.payment-undo-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!hasPermission('PAYMENTS_REVIEW')) return;
        const ok = await notify.confirm(
          t('payments.undoConfirm'),
          { title: t('payments.undoTitle'), okLabel: t('payments.undo') },
        );
        if (!ok) return;
        try {
          const result = await api(`/payments/${btn.dataset.paymentId}/undo`, {
            method: 'POST',
            body: '{}',
          });
          if (result?.hostawayChargeCancelled === false && (result?.hostawayChargeIdsFailed?.length || result?.hostawayChargeId)) {
            const ids = (result.hostawayChargeIdsFailed || [result.hostawayChargeId]).filter(Boolean);
            notify.info(t('payments.undoHostawayManual', { chargeId: ids.join(', ') }));
          } else {
            notify.success(t('payments.undoOk'));
          }
          loadPayments();
        } catch (ex) {
          notify.error(ex.message);
        }
      });
    });
    scheduleEnhanceResponsiveTables();
  } catch (ex) {
    notify.error(ex.message);
    $('#payments-history-table').innerHTML = `<p class="error">${esc(ex.message)}</p>`;
  }
}

async function runInboxBackfill(triggerBtn) {
  if (!hasPermission('CONVERSATIONS_MANAGE')) return;
  const buttons = [$('#inbox-backfill-btn'), $('#inbox-backfill-btn-mobile')].filter(Boolean);
  buttons.forEach((btn) => {
    btn.disabled = true;
  });
  try {
    const result = await api('/sync/conversations-backfill', { method: 'POST' });
    notify.success(t('requests.backfillDone', {
      linked: result.linked ?? 0,
      succeeded: result.inboxRetries?.succeeded ?? 0,
      attempted: result.inboxRetries?.attempted ?? 0,
    }));
    loadRequests();
  } catch (ex) {
    notify.error(ex.message);
  } finally {
    const can = hasPermission('CONVERSATIONS_MANAGE');
    buttons.forEach((btn) => {
      btn.disabled = !can;
    });
    if (triggerBtn) triggerBtn.blur?.();
  }
}

$('#inbox-backfill-btn')?.addEventListener('click', () => runInboxBackfill($('#inbox-backfill-btn')));
$('#inbox-backfill-btn-mobile')?.addEventListener('click', () => runInboxBackfill($('#inbox-backfill-btn-mobile')));

function truncateText(text, max = 100) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

async function loadLogSettings() {
  try {
    const settings = await api('/log-settings');
    $('#log-debug-days').value = settings.debugRetentionDays ?? 14;
    $('#log-operational-days').value = settings.operationalRetentionDays ?? 30;
    $('#log-pii-days').value = settings.piiRetentionDays ?? 30;
    $('#log-max-days').value = settings.maxRetentionDays ?? 90;
    $('#log-debug-enabled').checked = settings.debugAutoDelete !== false;
    $('#log-operational-enabled').checked = settings.operationalAutoDelete !== false;
    $('#log-pii-enabled').checked = settings.piiAutoDelete !== false;
    $('#log-auto-purge-enabled').checked = settings.autoPurgeEnabled !== false;
    syncLogRetentionInputs();
    markLogSettingsClean();
    await loadLogRetentionStatus();
  } catch {
    /* keep defaults */
  }
  applyRoleUi();
}

function syncLogRetentionInputs() {
  const pairs = [
    ['#log-debug-enabled', '#log-debug-days'],
    ['#log-operational-enabled', '#log-operational-days'],
    ['#log-pii-enabled', '#log-pii-days'],
  ];
  pairs.forEach(([cbSel, inputSel]) => {
    const cb = $(cbSel);
    const input = $(inputSel);
    if (!cb || !input) return;
    input.toggleAttribute('disabled', !cb.checked || !hasPermission('LOG_SETTINGS_EDIT'));
  });
  syncLogRetentionRuleSummaries();
}

function syncLogRetentionRuleSummaries() {
  const rules = {
    debug: ['#log-debug-days', '#log-debug-enabled'],
    operational: ['#log-operational-days', '#log-operational-enabled'],
    pii: ['#log-pii-days', '#log-pii-enabled'],
    cleanup: ['#log-max-days', '#log-auto-purge-enabled'],
  };
  Object.entries(rules).forEach(([rule, selectors]) => {
    const input = $(selectors[0]);
    const enabled = $(selectors[1]);
    const summary = $(`[data-retention-summary="${rule}"]`);
    if (!summary || !input) return;
    summary.textContent = enabled?.checked === false
      ? t('logs.disabled')
      : t('logs.daysCount', { count: input.value || '–' });
  });
}

['#log-debug-enabled', '#log-operational-enabled', '#log-pii-enabled'].forEach((sel) => {
  $(sel)?.addEventListener('change', syncLogRetentionInputs);
});

['#log-debug-days', '#log-operational-days', '#log-pii-days', '#log-max-days',
  '#log-debug-enabled', '#log-operational-enabled', '#log-pii-enabled', '#log-auto-purge-enabled']
  .forEach((sel) => {
    $(sel)?.addEventListener('input', syncLogRetentionRuleSummaries);
    $(sel)?.addEventListener('change', syncLogRetentionRuleSummaries);
  });

$$('[data-retention-toggle]').forEach((button) => {
  button.addEventListener('click', () => {
    const card = button.closest('[data-retention-rule-card]');
    if (!card) return;
    const expanded = !card.classList.contains('is-expanded');
    card.classList.toggle('is-expanded', expanded);
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });
});

const LOG_PURGE_TZ = 'Europe/Berlin';

/** Next 03:00 Europe/Berlin (same schedule as the purge cron). */
function computeNextBerlinPurgeIso() {
  const now = new Date();
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: LOG_PURGE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: LOG_PURGE_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  let day = dateFmt.format(now);
  if (timeFmt.format(now) >= '03:00') {
    const [y, m, d] = day.split('-').map(Number);
    day = dateFmt.format(new Date(Date.UTC(y, m - 1, d, 12) + 86_400_000));
  }
  const [y, m, d] = day.split('-').map(Number);
  let utcMs = Date.UTC(y, m - 1, d, 3, 0, 0);
  for (let i = 0; i < 3; i += 1) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: LOG_PURGE_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(utcMs));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const hour = get('hour') === 24 ? 0 : get('hour');
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
    const target = Date.UTC(y, m - 1, d, 3, 0, 0);
    utcMs += target - asUtc;
  }
  return new Date(utcMs).toISOString();
}

function formatPurgeScheduleTime(value) {
  if (!value) return '–';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '–';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LOG_PURGE_TZ,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('day')} ${get('month')} ${get('hour')}:${get('minute')}`;
}

function markLogSettingsDirty() {
  const el = $('#log-settings-dirty');
  if (!el) return;
  el.classList.remove('is-clean');
  el.classList.add('is-dirty');
  el.innerHTML = `<span>${esc(t('logs.hasUnsaved'))}</span>`;
}

function markLogSettingsClean() {
  const el = $('#log-settings-dirty');
  if (!el) return;
  el.classList.add('is-clean');
  el.classList.remove('is-dirty');
  el.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg><span>${esc(t('logs.noUnsaved'))}</span>`;
}

['#log-debug-days', '#log-operational-days', '#log-pii-days', '#log-max-days',
  '#log-debug-enabled', '#log-operational-enabled', '#log-pii-enabled', '#log-auto-purge-enabled']
  .forEach((sel) => {
    $(sel)?.addEventListener('input', markLogSettingsDirty);
    $(sel)?.addEventListener('change', markLogSettingsDirty);
  });

$('#log-settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/log-settings', {
      method: 'PATCH',
      body: JSON.stringify({
        debugRetentionDays: Number($('#log-debug-days').value),
        operationalRetentionDays: Number($('#log-operational-days').value),
        piiRetentionDays: Number($('#log-pii-days').value),
        maxRetentionDays: Number($('#log-max-days').value),
        debugAutoDelete: $('#log-debug-enabled').checked,
        operationalAutoDelete: $('#log-operational-enabled').checked,
        piiAutoDelete: $('#log-pii-enabled').checked,
        autoPurgeEnabled: $('#log-auto-purge-enabled').checked,
      }),
    });
    notify.success(t('logs.retentionSaved'));
    markLogSettingsClean();
    await loadLogSettings();
  } catch (ex) {
    notify.error(ex.message);
  }
});

$('#log-purge-now-btn')?.addEventListener('click', async () => {
  if (!hasPermission('LOG_SETTINGS_EDIT')) return;
  const ok = await notify.confirm(t('logs.purgeHint'), {
    title: t('logs.purgeNow'),
    okLabel: t('logs.purgeNow'),
  });
  if (!ok) return;
  try {
    const result = await api('/log-settings/purge-expired', { method: 'POST' });
    notify.success(t('logs.purgeDone', { count: result.deleted ?? 0 }));
    await loadLogRetentionStatus();
    await loadLogs();
  } catch (ex) {
    notify.error(ex.message);
  }
});

async function loadLogRetentionStatus() {
  const box = $('#log-retention-status');
  const overview = $('#log-retention-overview');
  const samplesEl = $('#log-retention-samples');
  try {
    const status = await api('/log-settings/status');
    logsRetentionStatus = status;
    renderLogsKpis(status);
    if (box) {
      box.classList.add('hidden');
      box.setAttribute('aria-hidden', 'true');
    }
    const purgeOn = status.settings?.autoPurgeEnabled !== false;
    const nextAt = purgeOn ? computeNextBerlinPurgeIso() : null;
    const nextLabel = nextAt ? formatPurgeScheduleTime(nextAt) : '–';
    if (overview) {
      overview.innerHTML = `
        <article class="logs-overview-card">
          <span class="logs-overview-icon is-ok" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6"/></svg></span>
          <div>
            <div class="logs-overview-label">${esc(t('logs.kpiStored'))}</div>
            <div class="logs-overview-value">${esc(Number(status.totalLogs ?? 0).toLocaleString())}</div>
          </div>
        </article>
        <article class="logs-overview-card">
          <span class="logs-overview-icon is-warn" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></span>
          <div>
            <div class="logs-overview-label">${esc(t('logs.kpiExpired'))}</div>
            <div class="logs-overview-value">${esc(Number(status.expiredLogs ?? 0).toLocaleString())}</div>
            <div class="logs-overview-sub">${esc(t('logs.kpiExpiredSub'))}</div>
          </div>
        </article>
        <article class="logs-overview-card">
          <span class="logs-overview-icon is-ok" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg></span>
          <div>
            <div class="logs-overview-label">${esc(t('logs.kpiNext'))}</div>
            <div class="logs-overview-value">${esc(purgeOn ? nextLabel : '–')}</div>
            <div class="logs-overview-sub">${esc(purgeOn ? formatRelativeUntil(nextAt) : t('logs.kpiNextOff'))}</div>
          </div>
        </article>
        <article class="logs-overview-card">
          <span class="logs-overview-icon is-err" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></span>
          <div>
            <div class="logs-overview-label">${esc(t('logs.statusPermanentShort'))}</div>
            <div class="logs-overview-sub">${esc(t('logs.statusPermanent'))}</div>
          </div>
        </article>
      `;
    }
    if (samplesEl && status.samples?.length) {
      const rows = status.samples.map((s) => `
        <tr>
          <td>${esc(formatAuditDateTime(s.createdAt))}</td>
          <td>${esc(s.source)} / <code>${esc(s.action)}</code></td>
          <td>${esc(t(`logs.rule.${s.retentionRule}`))}</td>
          <td>${esc(formatAuditDateTime(s.expiresAt))}</td>
        </tr>
      `).join('');
      const visibleSamples = logsRetentionSamplesExpanded ? status.samples : status.samples.slice(0, 4);
      const mobileCards = visibleSamples.map((s) => `
        <article class="logs-upcoming-card">
          <div class="logs-upcoming-event">${esc(s.source)} / <code>${esc(s.action)}</code></div>
          <div class="logs-upcoming-card-meta">
            <span><small>${esc(t('logs.received'))}</small>${esc(formatAuditDateTime(s.createdAt))}</span>
            <span class="logs-upcoming-rule">${esc(t(`logs.rule.${s.retentionRule}`))}</span>
            <span><small>${esc(t('logs.deletesOn'))}</small>${esc(formatAuditDateTime(s.expiresAt))}</span>
          </div>
        </article>
      `).join('');
      const showMore = status.samples.length > 4
        ? `<button type="button" class="logs-upcoming-more" id="logs-upcoming-more">${esc(logsRetentionSamplesExpanded ? t('logs.showLess') : t('logs.showMore'))}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>`
        : '';
      samplesEl.innerHTML = `
        <div class="table-wrap logs-upcoming-table-wrap">
          <table class="logs-data-table retention-samples-table">
            <thead><tr>
              <th>${t('logs.time')}</th>
              <th>${t('logs.source')}</th>
              <th>${t('logs.retentionRule')}</th>
              <th>${t('logs.deletesOn')}</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="logs-upcoming-mobile">${mobileCards}${showMore}</div>`;
      samplesEl.querySelector('#logs-upcoming-more')?.addEventListener('click', () => {
        logsRetentionSamplesExpanded = !logsRetentionSamplesExpanded;
        loadLogRetentionStatus();
      });
      scheduleEnhanceResponsiveTables();
    } else if (samplesEl) {
      samplesEl.innerHTML = `<p class="field-hint">${esc(t('logs.upcomingEmpty'))}</p>`;
    }
  } catch {
    if (overview) overview.innerHTML = '';
    if (samplesEl) samplesEl.innerHTML = '';
  }
}

function formatAuditDateTime(value) {
  if (!value) return '–';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${pad2(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatAuditShortDate(value) {
  if (!value) return '–';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${pad2(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function formatRelativeUntil(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return t('logs.overdue');
  const hours = Math.round(diffMs / 36e5);
  if (hours < 48) return t('logs.inHours', { count: hours });
  const days = Math.round(hours / 24);
  return t('logs.inDays', { count: days });
}

function httpStatusLabel(code) {
  if (code == null || code === '') return '–';
  const n = Number(code);
  const map = {
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    204: 'No Content',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable',
    429: 'Too Many Requests',
    500: 'Server Error',
    502: 'Bad Gateway',
    503: 'Unavailable',
  };
  return Number.isFinite(n) ? `${n} ${map[n] || ''}`.trim() : String(code);
}

function httpStatusTone(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return 'neutral';
  if (n >= 200 && n < 300) return n === 202 ? 'info' : 'ok';
  if (n >= 400 && n < 500) return 'warn';
  if (n >= 500) return 'err';
  return 'neutral';
}

function logSourceMeta(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('hostaway')) return { label: source, tone: 'hostaway', mark: 'H' };
  if (s.includes('airbnb')) return { label: source, tone: 'airbnb', mark: 'A' };
  if (s.includes('stripe')) return { label: source, tone: 'stripe', mark: 'S' };
  if (s.includes('paypal')) return { label: source, tone: 'paypal', mark: 'P' };
  if (s.includes('qonto')) return { label: source, tone: 'qonto', mark: 'Q' };
  if (s.includes('fonio')) return { label: source, tone: 'fonio', mark: 'f' };
  if (s.includes('check24')) return { label: source, tone: 'check24', mark: '24' };
  if (s.includes('admin') || s.includes('brainions')) return { label: source, tone: 'admin', mark: 'b' };
  const mark = String(source || 'API').replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || 'API';
  return { label: source || '–', tone: 'default', mark };
}

function logRetentionLabel(log) {
  if (!log?.expiresAt) return '–';
  const created = log.createdAt ? new Date(log.createdAt) : null;
  const expires = new Date(log.expiresAt);
  if (Number.isNaN(expires.getTime())) return '–';
  let days = null;
  if (created && !Number.isNaN(created.getTime())) {
    days = Math.max(1, Math.round((expires.getTime() - created.getTime()) / 864e5));
  }
  const when = formatAuditShortDate(log.expiresAt);
  return days != null ? `${days} ${t('logs.daysShort')}, ${when}` : when;
}

function renderLogsKpis(status) {
  const el = $('#logs-kpis');
  if (!el) return;
  const purgeOn = status?.settings?.autoPurgeEnabled !== false;
  const next = purgeOn ? computeNextBerlinPurgeIso() : null;
  const cards = [
    {
      tone: 'blue',
      icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/>',
      label: t('logs.kpiStored'),
      labelHtml: `<span class="logs-kpi-label-full">${esc(t('logs.kpiStored'))}</span><span class="logs-kpi-label-short">${esc(t('logs.kpiStoredShort'))}</span>`,
      value: Number(status?.totalLogs ?? 0).toLocaleString(),
      sub: t('logs.kpiStoredSub'),
    },
    {
      tone: 'warn',
      icon: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
      label: t('logs.kpiExpired'),
      value: Number(status?.expiredLogs ?? 0).toLocaleString(),
      sub: t('logs.kpiExpiredSub'),
    },
    {
      tone: 'ok',
      icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
      label: t('logs.kpiCleanup'),
      value: purgeOn ? t('logs.kpiCleanupAuto') : t('logs.kpiCleanupOff'),
      sub: purgeOn ? t('logs.kpiCleanupSub') : t('logs.statusPurgeOff'),
    },
    {
      tone: 'purple',
      icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
      label: t('logs.kpiNext'),
      value: '–',
      sub: purgeOn ? formatRelativeUntil(next) : t('logs.kpiNextOff'),
    },
  ];
  if (purgeOn && next) {
    cards[3].value = formatPurgeScheduleTime(next);
  }
  el.innerHTML = cards.map((c) => `
    <article class="logs-kpi">
      <span class="logs-kpi-icon is-${esc(c.tone)}" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${c.icon}</svg>
      </span>
      <div class="logs-kpi-body">
        <div class="logs-kpi-label">${c.labelHtml || esc(c.label)}</div>
        <div class="logs-kpi-value">${esc(String(c.value))}</div>
        <div class="logs-kpi-sub">${esc(c.sub)}</div>
      </div>
    </article>
  `).join('');
}

function setLogsView(view) {
  logsActiveView = view === 'retention' ? 'retention' : 'entries';
  $$('.logs-tab').forEach((btn) => {
    const on = btn.dataset.logsTab === logsActiveView;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $('#logs-view-entries')?.classList.toggle('hidden', logsActiveView !== 'entries');
  $('#logs-view-retention')?.classList.toggle('hidden', logsActiveView !== 'retention');
}


function isLogsMobileLayout() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1023px)').matches;
}

function closeLogsFilterSheet() {
  const sheet = $('#logs-filter-sheet');
  if (!sheet) return;
  sheet.classList.add('hidden');
  sheet.hidden = true;
  document.body.classList.remove('logs-filter-sheet-open');
}

function openLogsFilterSheet(kind) {
  const sheet = $('#logs-filter-sheet');
  const body = $('#logs-filter-sheet-body');
  const titleEl = $('#logs-filter-sheet-title');
  if (!sheet || !body) return;
  const titles = {
    source: t('logs.source'),
    action: t('logs.action'),
    status: t('logs.status'),
    date: t('logs.filterDate'),
  };
  if (titleEl) titleEl.textContent = titles[kind] || 'Filter';
  const s = tableState.logs;

  if (kind === 'date') {
    body.innerHTML = `
      <div class="logs-filter-date-sheet">
        <label><span>${esc(t('logs.filterDateFrom'))}</span><input type="date" data-sheet-date="dateFrom" value="${esc(s.dateFrom || '')}" /></label>
        <label><span>${esc(t('logs.filterDateTo'))}</span><input type="date" data-sheet-date="dateTo" value="${esc(s.dateTo || '')}" /></label>
        <div class="logs-filter-date-actions">
          <button type="button" class="btn ghost" data-sheet-clear-dates>${esc(t('logs.filterClearDates'))}</button>
          <button type="button" class="btn primary" data-sheet-apply-dates>${esc(t('logs.filterApplyDates'))}</button>
        </div>
      </div>`;
    body.querySelector('[data-sheet-clear-dates]')?.addEventListener('click', () => {
      if ($('#logs-date-from')) $('#logs-date-from').value = '';
      if ($('#logs-date-to')) $('#logs-date-to').value = '';
      tableState.logs.dateFrom = '';
      tableState.logs.dateTo = '';
      tableState.logs.page = 1;
      closeLogsFilterSheet();
      loadLogs({ silent: true });
    });
    body.querySelector('[data-sheet-apply-dates]')?.addEventListener('click', () => {
      const from = body.querySelector('[data-sheet-date="dateFrom"]')?.value || '';
      const to = body.querySelector('[data-sheet-date="dateTo"]')?.value || '';
      if ($('#logs-date-from')) $('#logs-date-from').value = from;
      if ($('#logs-date-to')) $('#logs-date-to').value = to;
      tableState.logs.dateFrom = from;
      tableState.logs.dateTo = to;
      tableState.logs.page = 1;
      closeLogsFilterSheet();
      loadLogs({ silent: true });
    });
  } else {
    const selId =
      kind === 'source' ? '#logs-filter-source' : kind === 'action' ? '#logs-filter-action' : '#logs-filter-status';
    const sel = $(selId);
    if (!sel) return;
    const current = String(sel.value || 'all');
    body.innerHTML = `<div class="logs-filter-sheet-options">${[...sel.options]
      .map((opt) => {
        const value = String(opt.value ?? '');
        const label = String(opt.textContent || '').trim() || value;
        return `<button type="button" class="logs-filter-sheet-option${value === current ? ' is-selected' : ''}" data-value="${esc(value)}">${esc(label)}</button>`;
      })
      .join('')}</div>`;
    body.querySelectorAll('[data-value]').forEach((btn) => {
      btn.addEventListener('click', () => {
        sel.value = btn.getAttribute('data-value') ?? 'all';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        closeLogsFilterSheet();
      });
    });
  }

  sheet.classList.remove('hidden');
  sheet.hidden = false;
  document.body.classList.add('logs-filter-sheet-open');
}

function syncLogsFilterChips() {
  const s = tableState.logs;
  const setChip = (key, active, text) => {
    const chip = $(`[data-logs-chip="${key}"]`);
    if (!chip) return;
    chip.classList.toggle('is-active', !!active);
    const textEl = chip.querySelector('.logs-filter-chip-text');
    if (textEl && text) textEl.textContent = text;
  };
  const sourceSel = $('#logs-filter-source');
  setChip('source', s.source !== 'all', sourceSel?.selectedOptions?.[0]?.textContent?.trim() || t('logs.source'));
  const actionSel = $('#logs-filter-action');
  setChip('action', s.action !== 'all', actionSel?.selectedOptions?.[0]?.textContent?.trim() || t('logs.action'));
  const statusSel = $('#logs-filter-status');
  setChip('status', s.status !== 'all', statusSel?.selectedOptions?.[0]?.textContent?.trim() || t('logs.status'));
  let dateText = t('logs.filterDate');
  const dateActive = !!(s.dateFrom || s.dateTo);
  if (s.dateFrom && s.dateTo) dateText = `${s.dateFrom} → ${s.dateTo}`;
  else if (s.dateFrom) dateText = s.dateFrom;
  else if (s.dateTo) dateText = s.dateTo;
  setChip('date', dateActive, dateText);
}

function renderLogsMobile(items) {
  const root = $('#logs-mobile-list');
  if (!root) return;
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    root.innerHTML = `<div class="logs-m-empty">${esc(t('logs.empty'))}</div>`;
    return;
  }
  root.innerHTML = list
    .map((l) => {
      const src = logSourceMeta(l.source);
      const tone = httpStatusTone(l.statusCode);
      const retain = t('logs.retainUntil', { date: formatAuditShortDate(l.expiresAt) });
      const selected = logsDrawerLog && String(logsDrawerLog.id) === String(l.id);
      return `
      <article class="logs-m-card${selected ? ' is-selected' : ''}" data-log-detail="${esc(l.id)}">
        <span class="logs-source-icon is-${esc(src.tone)}" aria-hidden="true">${esc(src.mark)}</span>
        <div class="logs-m-card-body">
          <div class="logs-m-card-top">
            <div>
              <div class="logs-m-time">${esc(formatPaymentImportTime(l.createdAt))}</div>
              <div class="logs-m-action">${esc(l.action || '–')}</div>
            </div>
            <span class="logs-http-pill is-${tone}">${esc(httpStatusLabel(l.statusCode))}</span>
          </div>
          <div class="logs-m-summary">${esc(formatLogSummary(l))}</div>
          <div class="logs-m-retain">${esc(retain)}</div>
        </div>
      </article>`;
    })
    .join('');
  root.querySelectorAll('[data-log-detail]').forEach((card) => {
    card.addEventListener('click', () => {
      const log = logsCache.find((x) => String(x.id) === String(card.dataset.logDetail));
      if (log) showLogDetail(log);
    });
  });
}

function logsDrawerMetaHtml(log) {
  const meta = log.metadata ?? {};
  const src = logSourceMeta(log.source);
  const sample = (logsRetentionStatus?.samples || []).find((s) => s.id === log.id);
  const ruleKey = sample?.retentionRule;
  return `
    <dl class="logs-meta-list">
      <div><dt>${t('logs.summary')}</dt><dd>${esc(formatLogSummary(log))}</dd></div>
      <div><dt>${t('logs.source')}</dt><dd><span class="logs-source"><span class="logs-source-icon is-${esc(src.tone)}">${esc(src.mark)}</span>${esc(src.label)}</span></dd></div>
      <div><dt>${t('logs.action')}</dt><dd><code>${esc(log.action || '–')}</code></dd></div>
      <div><dt>${t('logs.httpStatus')}</dt><dd><span class="logs-http-pill is-${httpStatusTone(log.statusCode)}">${esc(httpStatusLabel(log.statusCode))}</span></dd></div>
      <div><dt>${t('logs.time')}</dt><dd>${esc(formatAuditDateTime(log.createdAt))}</dd></div>
      ${meta.callId || meta.requestId ? `<div><dt>${t('logs.requestId')}</dt><dd><code>${esc(meta.callId || meta.requestId)}</code></dd></div>` : ''}
      ${log.ipHash ? `<div><dt>${t('logs.ipHash')}</dt><dd><code>${esc(log.ipHash)}</code></dd></div>` : ''}
      ${meta.userAgent ? `<div><dt>${t('logs.userAgent')}</dt><dd>${esc(meta.userAgent)}</dd></div>` : ''}
      <div><dt>${t('logs.environment')}</dt><dd><span class="logs-env-pill">${esc(t('logs.envProduction'))}</span></dd></div>
    </dl>
    <section class="logs-retention-card">
      <h4>${t('logs.retentionInfo')}</h4>
      <dl class="logs-meta-list compact">
        <div><dt>${t('logs.retentionRule')}</dt><dd>${esc(ruleKey ? t(`logs.rule.${ruleKey}`) : t('logs.rule.operational'))}</dd></div>
        <div><dt>${t('logs.retentionCol')}</dt><dd>${esc(logRetentionLabel(log))}</dd></div>
        <div><dt>${t('logs.deletesOn')}</dt><dd>${esc(formatAuditDateTime(log.expiresAt))}</dd></div>
      </dl>
      <button type="button" class="btn ghost btn-sm" id="logs-drawer-to-retention">${t('logs.goRetentionSettings')}</button>
    </section>`;
}

function logsDrawerFullHtml(log) {
  const meta = log.metadata ?? {};
  const req = meta.requestReceived ?? meta.request ?? null;
  const res = meta.responseRecorded ?? meta.response ?? null;
  return `
    ${logsDrawerMetaHtml(log)}
    ${renderLogsJsonBlock(t('logs.requestBlock'), req, t('logs.noRequestBody'))}
    ${renderLogsJsonBlock(t('logs.responseBlock'), res || meta, t('logs.noResponseBody'))}
  `;
}

function renderLogsDrawerBody() {
  const log = logsDrawerLog;
  const body = $('#logs-drawer-body');
  if (!log || !body) return;
  const meta = log.metadata ?? {};
  const req = meta.requestReceived ?? meta.request ?? null;
  const res = meta.responseRecorded ?? meta.response ?? null;
  const mobile = isLogsMobileLayout() && !logsDrawerFull;
  if (!mobile) {
    body.innerHTML = logsDrawerFullHtml(log);
  } else if (logsDrawerTab === 'request') {
    body.innerHTML = renderLogsJsonBlock(t('logs.requestBlock'), req, t('logs.noRequestBody'));
  } else if (logsDrawerTab === 'response') {
    body.innerHTML = renderLogsJsonBlock(t('logs.responseBlock'), res || meta, t('logs.noResponseBody'));
  } else if (logsDrawerTab === 'metadata') {
    body.innerHTML = renderLogsJsonBlock(t('logs.tabMetadata'), meta, t('logs.noResponseBody'));
  } else {
    body.innerHTML = logsDrawerMetaHtml(log);
  }
  body.querySelector('#logs-drawer-to-retention')?.addEventListener('click', () => {
    closeLogsDrawer();
    setLogsView('retention');
  });
}

function bindLogsUi() {
  if (logsUiBound) return;
  logsUiBound = true;

  $$('.logs-tab').forEach((btn) => {
    btn.addEventListener('click', () => setLogsView(btn.dataset.logsTab));
  });
  $('#logs-open-retention-btn')?.addEventListener('click', () => setLogsView('retention'));

  const syncFiltersFromDom = () => {
    const s = tableState.logs;
    s.search = $('#logs-search')?.value || '';
    s.dateFrom = $('#logs-date-from')?.value || '';
    s.dateTo = $('#logs-date-to')?.value || '';
    s.source = $('#logs-filter-source')?.value || 'all';
    s.action = $('#logs-filter-action')?.value || 'all';
    s.status = $('#logs-filter-status')?.value || 'all';
    s.retention = $('#logs-filter-retention')?.value || 'all';
    s.method = 'all';
    s.page = 1;
    syncLogsFilterChips();
    loadLogs({ silent: true });
  };
$('#logs-search')?.addEventListener('input', () => {
    clearTimeout(searchTimers.logs);
    searchTimers.logs = setTimeout(syncFiltersFromDom, 280);
  });
  ['#logs-date-from', '#logs-date-to', '#logs-filter-source', '#logs-filter-action', '#logs-filter-status', '#logs-filter-retention']
    .forEach((sel) => $(sel)?.addEventListener('change', syncFiltersFromDom));

  $('#logs-clear-filters-btn')?.addEventListener('click', () => {
    tableState.logs.search = '';
    tableState.logs.dateFrom = '';
    tableState.logs.dateTo = '';
    tableState.logs.source = 'all';
    tableState.logs.action = 'all';
    tableState.logs.retention = 'all';
    tableState.logs.status = 'all';
    tableState.logs.method = 'all';
    tableState.logs.page = 1;
    if ($('#logs-search')) $('#logs-search').value = '';
    if ($('#logs-date-from')) $('#logs-date-from').value = '';
    if ($('#logs-date-to')) $('#logs-date-to').value = '';
    if ($('#logs-filter-source')) $('#logs-filter-source').value = 'all';
    if ($('#logs-filter-action')) $('#logs-filter-action').value = 'all';
    if ($('#logs-filter-status')) $('#logs-filter-status').value = 'all';
    if ($('#logs-filter-retention')) $('#logs-filter-retention').value = 'all';
    syncLogsFilterChips();
    loadLogs({ silent: true });
  });

  $$('[data-logs-chip]').forEach((btn) => {
    btn.addEventListener('click', () => openLogsFilterSheet(btn.getAttribute('data-logs-chip')));
  });
  document.querySelectorAll('[data-logs-filter-close]').forEach((el) => {
    el.addEventListener('click', closeLogsFilterSheet);
  });

  document.querySelectorAll('[data-logs-drawer-close]').forEach((el) => {
    el.addEventListener('click', closeLogsDrawer);
  });
  $$('[data-logs-drawer-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      logsDrawerTab = btn.dataset.logsDrawerTab || 'details';
      logsDrawerFull = false;
      $$('[data-logs-drawer-tab]').forEach((tab) => {
        const on = tab.dataset.logsDrawerTab === logsDrawerTab;
        tab.classList.toggle('is-active', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      renderLogsDrawerBody();
    });
  });
  $('#logs-drawer-full-btn')?.addEventListener('click', () => {
    logsDrawerFull = true;
    renderLogsDrawerBody();
    const body = $('#logs-drawer-body');
    body?.scrollTo?.({ top: 0, behavior: 'smooth' });
  });
}

function isCleanLogAction(action) {
  const a = String(action || '').trim();
  if (!a) return false;
  // Drop raw HTTP route actions like "PATCH /api/v1/admin/..."
  if (/^(GET|POST|PUT|PATCH|DELETE)\s+\//i.test(a)) return false;
  if (/^\/?api\//i.test(a)) return false;
  if (a.includes('/api/')) return false;
  return true;
}

function logMetadataObject(log) {
  const meta = log?.metadata;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  return meta;
}

function logLooksLikePii(log) {
  const hints = ['email', 'phone', 'token', 'password', 'guest', 'caller'];
  const scan = (value, depth = 0) => {
    if (depth > 5 || value == null) return false;
    if (Array.isArray(value)) return value.some((item) => scan(item, depth + 1));
    if (typeof value === 'object') {
      return Object.entries(value).some(([key, nested]) => {
        const lower = String(key).toLowerCase();
        if (hints.some((h) => lower.includes(h))) return true;
        return scan(nested, depth + 1);
      });
    }
    return false;
  };
  return scan(logMetadataObject(log));
}

function logRetentionRule(log) {
  const settings = logsRetentionStatus?.settings || {};
  const debugOn = settings.debugAutoDelete !== false;
  const piiOn = settings.piiAutoDelete !== false;
  const opsOn = settings.operationalAutoDelete !== false;
  const level = String(log?.level || '').toUpperCase();
  if (level === 'DEBUG' && debugOn) return 'debug';
  if (logLooksLikePii(log) && piiOn) return 'pii';
  if (!opsOn) return 'max_cap';
  return 'operational';
}

function populateLogsFilterOptions(facets = logsFacets) {
  const sources = [...(facets.sources || [])].filter(Boolean).sort();
  const actions = [...(facets.actions || [])]
    .filter(isCleanLogAction)
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));

  const fill = (sel, allKey, values, format = (v) => v) => {
    const el = $(sel);
    if (!el) return;
    const current = el.value || 'all';
    el.innerHTML = `<option value="all">${esc(t(allKey))}</option>${values
      .map((v) => `<option value="${esc(String(v))}">${esc(String(format(v)))}</option>`)
      .join('')}`;
    el.value = [...el.options].some((o) => o.value === current) ? current : 'all';
  };
  fill('#logs-filter-source', 'logs.filterSourceAll', sources);
  fill('#logs-filter-action', 'logs.filterActionAll', actions);
  const retentionSel = $('#logs-filter-retention');
  if (retentionSel && document.activeElement !== retentionSel) {
    retentionSel.value = tableState.logs.retention || 'all';
  }
  const statusSel = $('#logs-filter-status');
  if (statusSel && document.activeElement !== statusSel) {
    statusSel.value = tableState.logs.status || 'all';
  }
  syncLogsFilterChips();
}

function renderLogsTable() {
  const s = tableState.logs;
  const items = logsPageResult.items || [];
  const pageData = {
    items,
    total: logsPageResult.total || 0,
    page: logsPageResult.page || s.page || 1,
    pageSize: logsPageResult.pageSize || s.pageSize || DEFAULT_PAGE_SIZE,
    totalPages: logsPageResult.totalPages || 1,
    maxTotal: logsPageResult.total || 0,
  };
  if (s.page !== pageData.page) s.page = pageData.page;

  const rows = items.map((l) => {
    const src = logSourceMeta(l.source);
    const tone = httpStatusTone(l.statusCode);
    return `
      <tr data-log-id="${esc(l.id)}">
        <td class="logs-col-time">${esc(formatAuditDateTime(l.createdAt))}</td>
        <td class="logs-col-source">
          <span class="logs-source">
            <span class="logs-source-icon is-${esc(src.tone)}" aria-hidden="true">${esc(src.mark)}</span>
            <span class="logs-source-label">${esc(src.label)}</span>
          </span>
        </td>
        <td class="logs-col-action"><code class="logs-action-code">${esc(l.action || '–')}</code></td>
        <td class="logs-col-http"><span class="logs-http-pill is-${tone}">${esc(httpStatusLabel(l.statusCode))}</span></td>
        <td class="logs-col-summary" title="${esc(formatLogSummary(l))}">${esc(formatLogSummary(l))}</td>
        <td class="logs-col-retention">${esc(logRetentionLabel(l))}</td>
        <td class="logs-col-actions">
          <button type="button" class="btn ghost btn-sm logs-view-btn" data-log-detail="${esc(l.id)}">${t('logs.viewDetails')}</button>
        </td>
      </tr>`;
  }).join('');

  const tableEl = $('#logs-table');
  if (tableEl) {
    tableEl.innerHTML = `
      <table class="logs-data-table">
        <thead><tr>
          ${sortTh('logs', 'createdAt', t('logs.time'))}
          ${sortTh('logs', 'source', t('logs.source'))}
          ${sortTh('logs', 'action', t('logs.action'))}
          <th>${t('logs.httpStatus')}</th>
          <th>${t('logs.summary')}</th>
          <th>${t('logs.retentionCol')}</th>
          <th>${t('logs.actions')}</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="7" class="empty-row">—</td></tr>`}</tbody>
      </table>`;
    bindSortableHeaders('#logs-table', 'logs', () => loadLogs({ silent: true }));
    tableEl.querySelectorAll('[data-log-detail]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const log = logsCache.find((x) => String(x.id) === String(btn.dataset.logDetail));
        if (log) showLogDetail(log);
      });
    });
  }
  renderTableInfo('#logs-info', pageData, pageData.maxTotal);
  renderPagination('#logs-pagination', pageData, 'logs', () => loadLogs({ silent: true }));
  scheduleEnhanceResponsiveTables();
  renderLogsMobile(items);
}

async function loadLogs({ silent = false } = {}) {
  bindLogsUi();
  setLogsView(logsActiveView);
if (!silent) await loadLogSettings();
  else if (!logsRetentionStatus) await loadLogRetentionStatus();

  const s = tableState.logs;
  const params = new URLSearchParams();
  params.set('page', String(s.page || 1));
  params.set('pageSize', String(s.pageSize || DEFAULT_PAGE_SIZE));
  if (s.search?.trim()) params.set('search', s.search.trim());
  if (s.source && s.source !== 'all') params.set('source', s.source);
  if (s.action && s.action !== 'all') params.set('action', s.action);
  if (s.status && s.status !== 'all') params.set('status', s.status);
  if (s.retention && s.retention !== 'all') params.set('retention', s.retention);
  if (s.dateFrom) params.set('dateFrom', s.dateFrom);
  if (s.dateTo) params.set('dateTo', s.dateTo);
  if (s.sortBy) {
    params.set('sortBy', s.sortBy);
    params.set('sortDir', s.sortDir || 'desc');
  }

  const data = await api(`/logs?${params.toString()}`);
  if (Array.isArray(data)) {
    // Legacy API fallback (hard-capped list)
    logsPageResult = {
      items: data,
      total: data.length,
      page: 1,
      pageSize: data.length || DEFAULT_PAGE_SIZE,
      totalPages: 1,
    };
    logsFacets = {
      sources: [...new Set(data.map((l) => l.source).filter(Boolean))],
      actions: [...new Set(data.map((l) => l.action).filter(Boolean))],
    };
  } else {
    logsPageResult = {
      items: Array.isArray(data.items) ? data.items : [],
      total: Number(data.total) || 0,
      page: Number(data.page) || s.page || 1,
      pageSize: Number(data.pageSize) || s.pageSize || DEFAULT_PAGE_SIZE,
      totalPages: Number(data.totalPages) || 1,
    };
    if (data.facets) {
      logsFacets = {
        sources: data.facets.sources || [],
        actions: data.facets.actions || [],
      };
    }
  }
  tableState.logs.page = logsPageResult.page;
  logsCache = logsPageResult.items;
  populateLogsFilterOptions(logsFacets);
  renderLogsTable();
}

function formatLogSummary(log) {
  const meta = log.metadata ?? {};
  if (typeof meta.middlewareAction === 'string' && meta.middlewareAction) {
    return truncateText(meta.middlewareAction, 120);
  }
  if (meta.outcomeDetail) {
    return truncateText(`${meta.outcome ?? 'result'}: ${meta.outcomeDetail}`, 120);
  }
  if (meta.event) return truncateText(meta.event, 120);
  if (meta.path) return truncateText(`${log.method ?? ''} ${meta.path}`.trim(), 120);
  if (meta.role) return truncateText(`${meta.role}${meta.adminId ? ` · ${meta.adminId.slice(0, 8)}…` : ''}`, 120);
  const parts = [];
  if (meta.verified === true) parts.push('verified');
  if (meta.verified === false) parts.push(`failed: ${meta.message ?? '?'}`);
  if (meta.reservationId) parts.push(`res#${meta.reservationId}`);
  if (meta.city) parts.push(meta.city);
  if (meta.availableCount !== undefined) parts.push(`${meta.availableCount} available`);
  if (meta.requestType) parts.push(meta.requestType);
  if (meta.status) parts.push(meta.status);
  if (log.ipHash) parts.push(`ip: ${log.ipHash}`);
  if (parts.length) return truncateText(parts.join(' · '), 120);
  const keys = Object.keys(meta);
  if (!keys.length) return '–';
  return truncateText(keys.slice(0, 4).map((k) => `${k}=…`).join(' · '), 120);
}

function formatLogMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return '–';
  return JSON.stringify(metadata, null, 2);
}

function renderReadableFields(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
  const skip = new Set(['hintDe', 'hintEn', 'guestScriptDe', 'guestScriptEn', 'verificationInstructionsDe']);
  const rows = Object.entries(obj)
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && v !== '')
    .slice(0, 12)
    .map(([k, v]) => {
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `<tr><th>${esc(k)}</th><td>${esc(truncateText(val, 200))}</td></tr>`;
    });
  if (!rows.length) return '';
  return `<table class="meta-kv-table"><tbody>${rows.join('')}</tbody></table>`;
}

function renderRawJsonDetails(label, data) {
  const json = typeof data === 'string' ? data : JSON.stringify(data ?? {}, null, 2);
  return `<details class="modal-details-raw"><summary>${esc(label)}</summary><pre class="json-block">${esc(json)}</pre></details>`;
}

function renderLogsJsonBlock(title, data, emptyHint) {
  const empty = data == null || (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0);
  const json = empty ? null : (typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return `
    <section class="logs-json-block">
      <header class="logs-json-header">
        <h4>${esc(title)}</h4>
        <span class="logs-sanitized-pill">${esc(t('logs.sanitized'))}</span>
      </header>
      ${empty
        ? `<p class="field-hint">${esc(emptyHint || t('logs.noRequestBody'))}</p>`
        : `<pre class="logs-json-pre">${esc(json)}</pre>`}
    </section>`;
}

function renderModalMetadataSections(meta) {
  const req = meta.requestReceived;
  const res = meta.responseRecorded ?? meta;
  const parts = [];

  if (meta.middlewareAction) {
    parts.push(`<p><strong>${t('fonioActivity.middlewareAction')}:</strong> ${esc(meta.middlewareAction)}</p>`);
  }
  if (meta.outcomeDetail) {
    parts.push(`<p class="field-hint">${esc(meta.outcomeDetail)}</p>`);
  }

  const reqEmpty = !req || (typeof req === 'object' && Object.keys(req).length === 0);
  parts.push(`<h5>${t('fonioActivity.requestSection')}</h5>`);
  if (reqEmpty) {
    parts.push(`<p class="field-hint">${t('logs.noRequestBody')}</p>`);
  } else if (typeof req === 'string') {
    parts.push(`<p>${esc(req)}</p>`);
  } else {
    parts.push(renderReadableFields(req));
    parts.push(renderRawJsonDetails(t('logs.rawRequest'), req));
  }

  if (res?.hintDe || res?.hintEn) {
    const hint =
      (typeof getLang === 'function' && getLang() === 'de'
        ? res.hintDe || res.hintEn
        : res.hintEn || res.hintDe) || '';
    parts.push(`<h5>${t('logs.verificationRule')}</h5>`);
    parts.push(`<p class="modal-highlight">${esc(hint)}</p>`);
  } else if (res?.guestScriptDe || res?.guestScriptEn) {
    const script =
      (typeof getLang === 'function' && getLang() === 'de'
        ? res.guestScriptDe || res.guestScriptEn
        : res.guestScriptEn || res.guestScriptDe) || '';
    parts.push(`<h5>${t('verification.guestScript')}</h5>`);
    parts.push(`<p class="modal-highlight">${esc(script)}</p>`);
  }

  parts.push(`<h5>${t('fonioActivity.responseSection')}</h5>`);
  if (res && typeof res === 'object') {
    parts.push(renderReadableFields(res));
  }
  parts.push(renderRawJsonDetails(t('logs.fullMetadata'), res));

  return parts.join('');
}

function closeLogsDrawer() {
  const drawer = $('#logs-drawer');
  if (!drawer) return;
  drawer.classList.add('hidden');
  drawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('logs-drawer-open');
  logsDrawerLog = null;
  logsDrawerFull = false;
  renderLogsMobile(logsCache);
}

function showLogDetail(log) {
  const meta = log.metadata ?? {};
  const drawer = $('#logs-drawer');
  const body = $('#logs-drawer-body');
  if (!drawer || !body) {
    const modal = $('#log-detail-modal');
    const modalBody = $('#log-detail-modal-body');
    if (modal && modalBody) {
      $('#log-detail-modal-title').textContent = `${t('logs.detailTitle')} — ${log.source} / ${log.action}`;
      modalBody.innerHTML = `
        <p><strong>${t('logs.time')}:</strong> ${formatDateTime(log.createdAt)} · <strong>${t('logs.status')}:</strong> ${log.statusCode ?? '–'}</p>
        <p><strong>${t('logs.summary')}:</strong> ${esc(formatLogSummary(log))}</p>
        ${renderModalMetadataSections(meta)}
      `;
      modal.classList.remove('hidden');
      document.body.classList.add('modal-open');
    }
    return;
  }

  logsDrawerLog = log;
  logsDrawerTab = 'details';
  logsDrawerFull = false;
  const src = logSourceMeta(log.source);
  const icon = $('#logs-drawer-icon');
  if (icon) {
    icon.className = `logs-source-icon is-${src.tone}`;
    icon.textContent = src.mark;
  }
  const titleEl = $('#logs-drawer-title');
  if (titleEl) titleEl.textContent = log.action || t('logs.eventDetails');
  const sub = $('#logs-drawer-sub');
  if (sub) sub.textContent = `${src.label} · ${formatPaymentImportTime(log.createdAt)}`;
  const statusEl = $('#logs-drawer-status');
  if (statusEl) {
    statusEl.className = `logs-http-pill is-${httpStatusTone(log.statusCode)}`;
    statusEl.textContent = httpStatusLabel(log.statusCode);
  }
  $$('[data-logs-drawer-tab]').forEach((tab) => {
    const on = tab.dataset.logsDrawerTab === 'details';
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  renderLogsDrawerBody();
  drawer.classList.remove('hidden');
  drawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('logs-drawer-open');
  renderLogsMobile(logsCache);
}

$('#log-detail-modal-close')?.addEventListener('click', () => {
  $('#log-detail-modal')?.classList.add('hidden');
  document.body.classList.remove('modal-open');
});
$('#log-detail-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'log-detail-modal') {
    $('#log-detail-modal').classList.add('hidden');
    document.body.classList.remove('modal-open');
  }
});

const FONIO_ACTIVITY_ACTIONS = [
  'call_context',
  'availability_search',
  'availability_weekends_search',
  'guest_verify',
  'guest_reservation',
  'guest_request',
  'guest_payment',
  'guest_send_checkin_info',
  'booking_offer',
  'verify_requirements',
  'setup',
];

const FONIO_ACTIVITY_POLL_MS = 60000;

function manageFonioActivityPoll() {
  if (fonioActivityPoll) clearInterval(fonioActivityPoll);
  fonioActivityPoll = null;
  const auto = $('#fonio-activity-auto-refresh');
  if (activeTab === 'fonioActivity' && token && auto?.checked) {
    fonioActivityPoll = setInterval(() => {
      if (activeTab === 'fonioActivity') {
        loadFonioActivity({ silent: true }).catch(() => {});
      }
    }, FONIO_ACTIVITY_POLL_MS);
  }
}

function ensureFonioActivityUi() {
  if (fonioActivityUiBound) return;
  fonioActivityUiBound = true;

  const auto = $('#fonio-activity-auto-refresh');
  auto?.addEventListener('change', () => {
    manageFonioActivityPoll();
  });

  $$('[data-fonio-chart-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const days = Number(btn.getAttribute('data-fonio-chart-range'));
      if (days !== 7 && days !== 30) return;
      fonioActivityChartDays = days;
      renderFonioActivityChart(fonioActivityCache);
    });
  });

  $$('[data-fonio-drawer-close]').forEach((el) => {
    el.addEventListener('click', () => closeFonioActivityDrawer());
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#fonio-activity-drawer')?.classList.contains('hidden')) {
      closeFonioActivityDrawer();
    }
  });

  $('#fonio-activity-copy-callid')?.addEventListener('click', async () => {
    const log = fonioActivityCache.find((l) => String(l.id) === String(fonioActivitySelectedId));
    const meta = log?.metadata ?? {};
    const value = meta.callId || log?.id;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(String(value));
      notify.success(t('common.copied'));
    } catch (_) {
      notify.error(t('common.copyFailed') !== 'common.copyFailed' ? t('common.copyFailed') : 'Copy failed');
    }
  });

  $('#fonio-activity-drawer')?.addEventListener('click', (e) => {
    const copyBtn = e.target.closest?.('[data-fonio-copy-details]');
    if (copyBtn) {
      const log = fonioActivityCache.find((l) => String(l.id) === String(fonioActivitySelectedId));
      if (log) copyFonioActivityDetails(log);
      return;
    }
    const openBtn = e.target.closest?.('[data-fonio-open-inquiry]');
    if (openBtn) {
      openFonioInquiry(openBtn.getAttribute('data-fonio-open-inquiry'));
    }
  });
}

function fonioActivityDayBounds(offsetDays = 0) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays + 1);
  return { start: start.getTime(), end: end.getTime() };
}

function fonioLogInRange(log, startMs, endMs) {
  const ts = new Date(log.createdAt).getTime();
  return Number.isFinite(ts) && ts >= startMs && ts < endMs;
}

function fonioOutcomeKind(log) {
  const meta = log.metadata ?? {};
  if (meta.outcome === 'success') return 'success';
  if (meta.outcome === 'failed') return 'failed';
  if (meta.verified === true) return 'success';
  if (meta.verified === false) return 'failed';
  const code = Number(log.statusCode);
  if (Number.isFinite(code)) {
    if (code >= 200 && code < 300) return 'success';
    if (code >= 400) return 'failed';
  }
  return 'unknown';
}

function fonioStatusBucket(statusCode) {
  const code = Number(statusCode);
  if (!Number.isFinite(code)) return '';
  if (code >= 200 && code < 300) return '2xx';
  if (code >= 400 && code < 500) return '4xx';
  if (code >= 500) return '5xx';
  return '';
}

function fonioIsAvailabilityAction(action) {
  return action === 'availability_search' || action === 'availability_weekends_search';
}

function fonioIsVerifyFailure(log) {
  return log.action === 'guest_verify' && fonioOutcomeKind(log) === 'failed';
}

function fonioWindowStats(logs, startMs, endMs) {
  const inWindow = logs.filter((l) => fonioLogInRange(l, startMs, endMs));
  const calls = inWindow.length;
  const success = inWindow.filter((l) => fonioOutcomeKind(l) === 'success').length;
  const verifyFail = inWindow.filter((l) => fonioIsVerifyFailure(l)).length;
  const availability = inWindow.filter((l) => fonioIsAvailabilityAction(l.action)).length;
  const successRate = calls ? (success / calls) * 100 : 0;
  return { calls, success, verifyFail, availability, successRate };
}

function fonioDeltaHtml(today, yesterday, opts = {}) {
  const { asPoints = false, invert = false } = opts;
  const diff = today - yesterday;
  let cls = 'is-flat';
  if (diff > 0.0001) cls = invert ? 'is-down' : 'is-up';
  if (diff < -0.0001) cls = invert ? 'is-up' : 'is-down';

  let value;
  if (asPoints) {
    const sign = diff > 0 ? '+' : '';
    value = `${sign}${diff.toFixed(1)}pp`;
  } else if (yesterday === 0) {
    if (today === 0) value = '0%';
    else value = '+100%';
  } else {
    const pct = (diff / yesterday) * 100;
    const sign = pct > 0 ? '+' : '';
    value = `${sign}${pct.toFixed(1)}%`;
  }

  const label = t('fonioActivity.vsYesterday');
  return `<div class="fonio-activity-stat-delta ${cls}"><span>${esc(label)}</span> ${esc(value)}</div>`;
}

function fonioActivityStatIcon(kind) {
  const attrs =
    'xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  if (kind === 'calls') {
    return `<svg ${attrs}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
  }
  if (kind === 'success') {
    return `<svg ${attrs}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
  }
  if (kind === 'verify') {
    return `<svg ${attrs}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`;
  }
  return `<svg ${attrs}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;
}

function renderFonioActivityStats(logs) {
  const el = $('#fonio-activity-stats');
  if (!el) return;
  const today = fonioActivityDayBounds(0);
  const yesterday = fonioActivityDayBounds(-1);
  const tStats = fonioWindowStats(logs, today.start, today.end);
  const yStats = fonioWindowStats(logs, yesterday.start, yesterday.end);

  const card = (iconKind, iconClass, value, label, deltaHtml) => `
    <article class="fonio-activity-stat-card ${iconClass}">
      <span class="fonio-activity-stat-icon ${iconClass}" aria-hidden="true">${fonioActivityStatIcon(iconKind)}</span>
      <div class="fonio-activity-stat-value">${value}</div>
      <div class="fonio-activity-stat-label">${esc(label)}</div>
      ${deltaHtml}
    </article>`;

  el.innerHTML = [
    card('calls', 'is-calls', formatCount(tStats.calls), t('fonioActivity.statCalls'), fonioDeltaHtml(tStats.calls, yStats.calls)),
    card('success', 'is-success', `${tStats.successRate.toFixed(1)}%`, t('fonioActivity.statSuccessRate'), fonioDeltaHtml(tStats.successRate, yStats.successRate, { asPoints: true })),
    card('verify', 'is-verify', formatCount(tStats.verifyFail), t('fonioActivity.statVerifyFail'), fonioDeltaHtml(tStats.verifyFail, yStats.verifyFail, { invert: true })),
    card('availability', 'is-availability', formatCount(tStats.availability), t('fonioActivity.statAvailability'), fonioDeltaHtml(tStats.availability, yStats.availability)),
  ].join('');
}

function syncFonioActivityChartTitle() {
  const title = $('#fonio-activity-chart-title');
  if (title) {
    title.textContent =
      fonioActivityChartDays === 30
        ? t('fonioActivity.chartTitleMonth')
        : t('fonioActivity.chartTitleWeek');
  }
  $$('[data-fonio-chart-range]').forEach((btn) => {
    btn.classList.toggle('is-active', Number(btn.getAttribute('data-fonio-chart-range')) === fonioActivityChartDays);
  });
}

function renderFonioActivityChart(logs) {
  const el = $('#fonio-activity-chart');
  if (!el) return;
  syncFonioActivityChartTitle();

  const days = fonioActivityChartDays === 30 ? 30 : 7;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const buckets = days;
  const bucketStarts = Array.from({ length: buckets }, (_, i) => {
    const d = new Date(todayStart);
    d.setDate(d.getDate() - (buckets - 1 - i));
    return d.getTime();
  });
  const rangeStart = bucketStarts[0];
  const rangeEnd = todayStart.getTime() + 24 * 60 * 60 * 1000;

  const calls = Array(buckets).fill(0);
  const success = Array(buckets).fill(0);

  logs.forEach((log) => {
    const ts = new Date(log.createdAt).getTime();
    if (!Number.isFinite(ts) || ts < rangeStart || ts >= rangeEnd) return;
    const dayMs = 24 * 60 * 60 * 1000;
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((ts - rangeStart) / dayMs)));
    calls[idx] += 1;
    if (fonioOutcomeKind(log) === 'success') success[idx] += 1;
  });

  const rates = calls.map((c, i) => (c ? (success[i] / c) * 100 : null));
  const maxCalls = Math.max(1, ...calls);
  const total = calls.reduce((a, b) => a + b, 0);

  if (!total) {
    el.innerHTML = `<p class="field-hint">${esc(
      days === 30 ? t('fonioActivity.chartEmptyMonth') : t('fonioActivity.chartEmptyWeek'),
    )}</p>`;
    return;
  }

  const w = 720;
  const h = 240;
  const padL = 84;
  const padR = 44;
  const padT = 16;
  const padB = 36;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const barGap = days > 14 ? 0.22 : 0.32;
  const barW = (plotW / buckets) * (1 - barGap);

  const xAt = (i) => padL + (plotW * (i + 0.5)) / buckets;
  const yRate = (v) => padT + plotH - (v / 100) * plotH;

  const niceMax = (() => {
    if (maxCalls <= 4) return maxCalls;
    const step = Math.ceil(maxCalls / 4);
    return step * 4;
  })();
  const yCallsNice = (v) => padT + plotH - (v / niceMax) * plotH;

  const callsUnit = t('fonioActivity.chartCallsUnit');
  const gridSteps = 4;
  const grid = Array.from({ length: gridSteps + 1 }, (_, i) => {
    const val = Math.round((niceMax / gridSteps) * i);
    const y = yCallsNice(val);
    const label = `${val}${callsUnit}`;
    return `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="rgba(148,163,184,0.16)" stroke-width="1" stroke-dasharray="4 4" />
      <text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="#8b9cb3" font-size="11">${esc(label)}</text>`;
  }).join('');

  const rateGrid = [0, 50, 100]
    .map((val) => {
      const y = yRate(val);
      return `<text x="${w - padR + 8}" y="${y + 4}" fill="#8b9cb3" font-size="11">${val}%</text>`;
    })
    .join('');

  const bars = calls
    .map((c, i) => {
      const x = xAt(i) - barW / 2;
      const y = yCallsNice(c);
      const bh = padT + plotH - y;
      return `<rect class="fonio-chart-bar" x="${x}" y="${y}" width="${barW}" height="${Math.max(bh, 0)}" rx="3" fill="rgba(59,130,246,0.72)" />`;
    })
    .join('');

  const linePts = [];
  rates.forEach((r, i) => {
    if (r == null) return;
    linePts.push(`${xAt(i)},${yRate(r)}`);
  });
  const linePoints = linePts.join(' ');
  const dots = rates
    .map((r, i) => {
      if (r == null) return '';
      return `<circle class="fonio-chart-dot" cx="${xAt(i)}" cy="${yRate(r)}" r="3.2" fill="#34d399" stroke="#0f1419" stroke-width="1.2" />`;
    })
    .join('');

  const labelEvery = days === 30 ? 5 : 1;
  const xLabels = Array.from({ length: buckets }, (_, i) => {
    if (i % labelEvery !== 0 && i !== buckets - 1) return '';
    const d = new Date(bucketStarts[i]);
    const label =
      days === 30
        ? `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`
        : d.toLocaleDateString(typeof locale === 'function' ? locale() : 'en-GB', {
            weekday: 'short',
            day: 'numeric',
          });
    return `<text class="fonio-chart-label" x="${xAt(i)}" y="${h - 10}" text-anchor="middle" fill="#8b9cb3" font-size="11">${esc(label)}</text>`;
  }).join('');

  const titleKey = days === 30 ? 'fonioActivity.chartTitleMonth' : 'fonioActivity.chartTitleWeek';
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(t(titleKey))}">
      ${grid}
      ${rateGrid}
      ${bars}
      ${linePoints ? `<polyline class="fonio-chart-line" fill="none" stroke="#34d399" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" points="${linePoints}" />` : ''}
      ${dots}
      ${xLabels}
    </svg>
  `;
}

function updateFonioActivityLastUpdated() {
  const el = $('#fonio-activity-last-updated');
  if (!el) return;
  if (!fonioActivityLastFetchedAt) {
    el.textContent = '';
    return;
  }
  el.textContent = t('fonioActivity.lastUpdated', {
    time: formatDashboardDateTime(fonioActivityLastFetchedAt),
  });
}

function filterFonioActivityList(logs) {
  const s = tableState.fonioActivity;
  const fromMs = s.dateFrom ? new Date(`${s.dateFrom}T00:00:00`).getTime() : null;
  const toMs = s.dateTo ? new Date(`${s.dateTo}T23:59:59.999`).getTime() : null;

  return logs.filter((log) => {
    const meta = log.metadata ?? {};
    const ts = new Date(log.createdAt).getTime();
    if (fromMs != null && Number.isFinite(fromMs) && (!Number.isFinite(ts) || ts < fromMs)) return false;
    if (toMs != null && Number.isFinite(toMs) && (!Number.isFinite(ts) || ts > toMs)) return false;

    if (s.statusFilter) {
      if (fonioStatusBucket(log.statusCode) !== s.statusFilter) return false;
    }

    if (s.outcomeFilter) {
      const kind = fonioOutcomeKind(log);
      if (s.outcomeFilter === 'success' && kind !== 'success') return false;
      if (s.outcomeFilter === 'failed' && kind !== 'failed') return false;
      if (s.outcomeFilter === 'unknown' && kind !== 'unknown') return false;
    }

    const q = (s.search || '').trim().toLowerCase();
    if (!q) return true;
    const haystack = [
      log.createdAt,
      log.action,
      log.statusCode,
      log.method,
      log.path,
      log.durationMs,
      meta.callId,
      meta.middlewareAction,
      meta.outcome,
      meta.outcomeDetail,
      JSON.stringify(meta.requestReceived ?? {}),
      JSON.stringify(meta.responseRecorded ?? {}),
      formatFonioRequestSummary(meta.requestReceived, log.action, meta),
      formatFonioActionSummary(log.action, meta),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

function fonioActionChip(action) {
  const tone = fonioActionTone(action);
  return `<span class="fonio-activity-action-chip tone-${tone}">${esc(action)}</span>`;
}

function fonioActionTone(action) {
  if (action === 'guest_verify' || action === 'verify_requirements') return 'verify';
  if (fonioIsAvailabilityAction(action)) return 'availability';
  if (action === 'guest_payment' || action === 'booking_offer') return 'money';
  if (action === 'guest_request' || action === 'guest_send_checkin_info') return 'guest';
  if (action === 'call_context') return 'call';
  if (action === 'setup') return 'setup';
  return 'default';
}

function fonioStatusPill(statusCode) {
  const code = statusCode == null || statusCode === '' ? null : Number(statusCode);
  if (code == null || !Number.isFinite(code)) {
    return `<span class="fonio-activity-status-pill is-unknown">-</span>`;
  }
  let cls = 'is-other';
  if (code >= 200 && code < 300) cls = 'is-ok';
  else if (code >= 400 && code < 500) cls = 'is-client';
  else if (code >= 500) cls = 'is-server';
  return `<span class="fonio-activity-status-pill ${cls}">${code}</span>`;
}

function fonioOutcomePill(log) {
  const kind = fonioOutcomeKind(log);
  if (kind === 'success') {
    return `<span class="fonio-activity-outcome-pill is-ok">${esc(t('fonioActivity.outcomeSuccess'))}</span>`;
  }
  if (kind === 'failed') {
    return `<span class="fonio-activity-outcome-pill is-fail">${esc(t('fonioActivity.outcomeFailed'))}</span>`;
  }
  const fallback = formatFonioOutcome(log.metadata ?? {});
  if (fallback && fallback !== '-') return fallback;
  return `<span class="fonio-activity-outcome-pill is-unknown">-</span>`;
}

function fonioDurationLabel(ms) {
  if (ms == null || ms === '') return '-';
  const n = Number(ms);
  if (!Number.isFinite(n)) return '-';
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}


function syncFonioActivityToolbarControls() {
  const el = $('#fonio-activity-toolbar');
  if (!el) return;
  const s = tableState.fonioActivity;
  const search = el.querySelector('#fonio-activity-search');
  if (search && document.activeElement !== search) search.value = s.search || '';
  const dateFrom = el.querySelector('#fonio-activity-date-from');
  if (dateFrom && document.activeElement !== dateFrom) dateFrom.value = s.dateFrom || '';
  const dateTo = el.querySelector('#fonio-activity-date-to');
  if (dateTo && document.activeElement !== dateTo) dateTo.value = s.dateTo || '';
  const action = el.querySelector('#fonio-activity-action-filter');
  if (action && document.activeElement !== action) action.value = s.actionFilter || '';
  const status = el.querySelector('#fonio-activity-status-filter');
  if (status && document.activeElement !== status) status.value = s.statusFilter || '';
  const outcome = el.querySelector('#fonio-activity-outcome-filter');
  if (outcome && document.activeElement !== outcome) outcome.value = s.outcomeFilter || '';
syncFonioActivityMobileChips();
}

function closeFonioActivityFilterSheet() {
  const sheet = $('#fonio-activity-filter-sheet');
  if (!sheet) return;
  sheet.classList.add('hidden');
  sheet.hidden = true;
  document.body.classList.remove('fonio-activity-filter-open');
}

function openFonioActivityFilterSheet(kind) {
  const sheet = $('#fonio-activity-filter-sheet');
  const body = $('#fonio-activity-filter-body');
  const title = $('#fonio-activity-filter-title');
  if (!sheet || !body || !title) return;
  const s = tableState.fonioActivity;
  const titles = {
    action: t('fonioActivity.filterAction'),
    status: t('fonioActivity.filterStatus'),
    outcome: t('fonioActivity.filterOutcome'),
    date: t('fonioActivity.filterDate'),
  };
  title.textContent = titles[kind] || 'Filter';

  if (kind === 'date') {
    body.innerHTML = `
      <div class="fonio-activity-filter-dates">
        <label><span>${esc(t('fonioActivity.filterDateFrom'))}</span><input type="date" data-fonio-sheet-date="from" value="${esc(s.dateFrom || '')}" /></label>
        <label><span>${esc(t('fonioActivity.filterDateTo'))}</span><input type="date" data-fonio-sheet-date="to" value="${esc(s.dateTo || '')}" /></label>
        <div class="fonio-activity-filter-actions">
          <button type="button" class="btn ghost" data-fonio-clear-dates>${esc(t('logs.filterClearDates'))}</button>
          <button type="button" class="btn primary" data-fonio-apply-dates>${esc(t('logs.filterApplyDates'))}</button>
        </div>
      </div>`;
    body.querySelector('[data-fonio-clear-dates]')?.addEventListener('click', () => {
      s.dateFrom = '';
      s.dateTo = '';
      s.page = 1;
      syncFonioActivityToolbarControls();
      closeFonioActivityFilterSheet();
      renderFonioActivityTable();
    });
    body.querySelector('[data-fonio-apply-dates]')?.addEventListener('click', () => {
      s.dateFrom = body.querySelector('[data-fonio-sheet-date="from"]')?.value || '';
      s.dateTo = body.querySelector('[data-fonio-sheet-date="to"]')?.value || '';
      s.page = 1;
      syncFonioActivityToolbarControls();
      closeFonioActivityFilterSheet();
      renderFonioActivityTable();
    });
  } else {
    const select =
      kind === 'action'
        ? $('#fonio-activity-action-filter')
        : kind === 'status'
          ? $('#fonio-activity-status-filter')
          : $('#fonio-activity-outcome-filter');
    if (!select) return;
    body.innerHTML = `<div class="fonio-activity-filter-options">${[...select.options]
      .map((option) => `<button type="button" class="fonio-activity-filter-option${option.value === select.value ? ' is-selected' : ''}" data-value="${esc(option.value)}">${esc(option.textContent.trim())}</button>`)
      .join('')}</div>`;
    body.querySelectorAll('[data-value]').forEach((button) => {
      button.addEventListener('click', () => {
        select.value = button.getAttribute('data-value') || '';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        closeFonioActivityFilterSheet();
      });
    });
  }

  sheet.classList.remove('hidden');
  sheet.hidden = false;
  document.body.classList.add('fonio-activity-filter-open');
}

function syncFonioActivityMobileChips() {
  const s = tableState.fonioActivity;
  $$('[data-fonio-quick-action]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.fonioQuickAction === (s.actionFilter || ''));
  });
  const set = (kind, active, text) => {
    const button = $(`[data-fonio-mobile-filter="${kind}"]`);
    if (!button) return;
    button.classList.toggle('is-active', active);
    const label = button.querySelector('span');
    if (label) label.textContent = text;
  };
  set('action', !!s.actionFilter, $('#fonio-activity-action-filter')?.selectedOptions?.[0]?.textContent?.trim() || t('fonioActivity.filterAction'));
  set('status', !!s.statusFilter, $('#fonio-activity-status-filter')?.selectedOptions?.[0]?.textContent?.trim() || t('fonioActivity.filterStatus'));
  set('outcome', !!s.outcomeFilter, $('#fonio-activity-outcome-filter')?.selectedOptions?.[0]?.textContent?.trim() || t('fonioActivity.filterOutcome'));
  const dateActive = !!(s.dateFrom || s.dateTo);
  const dateText = s.dateFrom && s.dateTo ? `${s.dateFrom} → ${s.dateTo}` : s.dateFrom || s.dateTo || t('fonioActivity.filterDate');
  set('date', dateActive, dateText);
}

function renderFonioActivityMobileCards(items) {
  const root = $('#fonio-activity-mobile-list');
  if (!root) return;
  if (!items.length) {
    root.innerHTML = `<div class="fonio-activity-mobile-empty">${esc(t('fonioActivity.none'))}</div>`;
    return;
  }
  root.innerHTML = items.map((log) => {
    const meta = log.metadata ?? {};
    const kind = fonioOutcomeKind(log);
    const request = formatFonioRequestSummary(meta.requestReceived, log.action, meta);
    const summary = formatFonioActionSummary(log.action, meta);
    const callId = String(meta.callId || log.id || '—');
    const selected = String(log.id) === String(fonioActivitySelectedId);
    return `
      <article class="fonio-activity-mobile-card is-${esc(kind)}${selected ? ' is-selected' : ''}" data-fonio-mobile-row="${esc(String(log.id))}" tabindex="0">
        <div class="fonio-activity-mobile-card-top">
          ${fonioActionChip(log.action)}
          ${fonioStatusPill(log.statusCode)}
          <time>${esc(new Date(log.createdAt).toLocaleTimeString(typeof locale === 'function' ? locale() : 'en-GB', { hour: '2-digit', minute: '2-digit' }))}</time>
          <span class="fonio-activity-mobile-user">${fonioSvg('<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/>', 11)}${esc(truncateText(callId, 10))}</span>
        </div>
        <div class="fonio-activity-mobile-card-main">
          <div>
            <strong>${esc(fonioActionDisplayTitle(log.action))}</strong>
            <span>${esc(summary || request || '—')}</span>
          </div>
          <div class="fonio-activity-mobile-outcome">${fonioOutcomePill(log)}<span class="fonio-activity-mobile-chevron">›</span></div>
        </div>
      </article>`;
  }).join('');
  root.querySelectorAll('[data-fonio-mobile-row]').forEach((card) => {
    const open = () => openFonioActivityDrawer(card.dataset.fonioMobileRow);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  });
}

function ensureFonioActivityToolbar() {
  const el = $('#fonio-activity-toolbar');
  if (!el) return;
  const s = tableState.fonioActivity;

  if (el.dataset.toolbarInit === 'fonio-activity-v2') {
    syncFonioActivityToolbarControls();
    return;
  }
  el.dataset.toolbarInit = 'fonio-activity-v2';

  const actionOpts = FONIO_ACTIVITY_ACTIONS.map(
    (a) => `<option value="${esc(a)}">${esc(a)}</option>`,
  ).join('');

  el.innerHTML = `
    <div class="fonio-activity-toolbar-row">
      <div class="fonio-activity-search">
        <svg class="fonio-activity-search-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input type="search" id="fonio-activity-search" value="${esc(s.search || '')}" placeholder="${esc(t('fonioActivity.searchPlaceholder'))}" autocomplete="off" aria-label="${esc(t('fonioActivity.searchPlaceholder'))}" />
      </div>
      <label>
        <span>${esc(t('fonioActivity.filterDateFrom'))}</span>
        <input type="date" id="fonio-activity-date-from" value="${esc(s.dateFrom || '')}" />
      </label>
      <label>
        <span>${esc(t('fonioActivity.filterDateTo'))}</span>
        <input type="date" id="fonio-activity-date-to" value="${esc(s.dateTo || '')}" />
      </label>
      <label>
        <span>${esc(t('fonioActivity.filterAction'))}</span>
        <select id="fonio-activity-action-filter">
          <option value="">${esc(t('fonioActivity.filterAll'))}</option>
          ${actionOpts}
        </select>
      </label>
      <label>
        <span>${esc(t('fonioActivity.filterStatus'))}</span>
        <select id="fonio-activity-status-filter">
          <option value="">${esc(t('fonioActivity.filterStatusAll'))}</option>
          <option value="2xx">2xx</option>
          <option value="4xx">4xx</option>
          <option value="5xx">5xx</option>
        </select>
      </label>
      <label>
        <span>${esc(t('fonioActivity.filterOutcome'))}</span>
        <select id="fonio-activity-outcome-filter">
          <option value="">${esc(t('fonioActivity.filterOutcomeAll'))}</option>
          <option value="success">${esc(t('fonioActivity.outcomeSuccess'))}</option>
          <option value="failed">${esc(t('fonioActivity.outcomeFailed'))}</option>
          <option value="unknown">${esc(t('fonioActivity.outcomeUnknown'))}</option>
        </select>
      </label>
      <button type="button" class="btn ghost btn-sm" id="fonio-activity-reset-filters">${esc(t('fonioActivity.resetFilters'))}</button>
    </div>
    <div class="fonio-activity-mobile-filters">
      <button type="button" class="fonio-activity-mobile-chip is-active" data-fonio-quick-action="">${esc(t('common.all'))}</button>
      <button type="button" class="fonio-activity-mobile-chip" data-fonio-quick-action="guest_verify">${esc(t('fonioActivity.quickVerify'))}</button>
      <button type="button" class="fonio-activity-mobile-chip" data-fonio-quick-action="availability_search">${esc(t('fonioActivity.quickSearch'))}</button>
      <button type="button" class="fonio-activity-mobile-chip" data-fonio-quick-action="booking_offer">${esc(t('fonioActivity.quickBooking'))}</button>
      <button type="button" class="fonio-activity-mobile-chip" data-fonio-mobile-filter="action"><span>${esc(t('fonioActivity.filterAction'))}</span></button>
      <button type="button" class="fonio-activity-mobile-chip" data-fonio-mobile-filter="status"><span>${esc(t('fonioActivity.filterStatus'))}</span></button>
      <button type="button" class="fonio-activity-mobile-chip" data-fonio-mobile-filter="outcome"><span>${esc(t('fonioActivity.filterOutcome'))}</span></button>
      <button type="button" class="fonio-activity-mobile-chip" data-fonio-mobile-filter="date"><span>${esc(t('fonioActivity.filterDate'))}</span></button>
    </div>
  `;

  const search = $('#fonio-activity-search');
  search?.addEventListener('input', () => {
    clearTimeout(searchTimers.fonioActivity);
    searchTimers.fonioActivity = setTimeout(() => {
      tableState.fonioActivity.search = search.value.trim();
      tableState.fonioActivity.page = 1;
      renderFonioActivityTable();
    }, 200);
  });

  $('#fonio-activity-date-from')?.addEventListener('change', (e) => {
    tableState.fonioActivity.dateFrom = e.target.value;
    tableState.fonioActivity.page = 1;
    renderFonioActivityTable();
  });
  $('#fonio-activity-date-to')?.addEventListener('change', (e) => {
    tableState.fonioActivity.dateTo = e.target.value;
    tableState.fonioActivity.page = 1;
    renderFonioActivityTable();
  });
  $('#fonio-activity-action-filter')?.addEventListener('change', (e) => {
    tableState.fonioActivity.actionFilter = e.target.value;
    tableState.fonioActivity.page = 1;
    loadFonioActivity().catch((ex) => notify.error(ex.message));
  });
  $('#fonio-activity-status-filter')?.addEventListener('change', (e) => {
    tableState.fonioActivity.statusFilter = e.target.value;
    tableState.fonioActivity.page = 1;
    renderFonioActivityTable();
  });
  $('#fonio-activity-outcome-filter')?.addEventListener('change', (e) => {
    tableState.fonioActivity.outcomeFilter = e.target.value;
    tableState.fonioActivity.page = 1;
    renderFonioActivityTable();
  });
  $('#fonio-activity-reset-filters')?.addEventListener('click', () => {
    const hadAction = !!tableState.fonioActivity.actionFilter;
    Object.assign(tableState.fonioActivity, {
      page: 1,
      search: '',
      actionFilter: '',
      statusFilter: '',
      outcomeFilter: '',
      dateFrom: '',
      dateTo: '',
    });
    syncFonioActivityToolbarControls();
    if (hadAction) {
      loadFonioActivity().catch((ex) => notify.error(ex.message));
    } else {
      renderFonioActivityTable();
    }
  });
  $$('[data-fonio-quick-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.fonioQuickAction || '';
      const select = $('#fonio-activity-action-filter');
      if (!select) return;
      select.value = action;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  $$('[data-fonio-mobile-filter]').forEach((button) => {
    button.addEventListener('click', () => openFonioActivityFilterSheet(button.dataset.fonioMobileFilter));
  });
  $$('[data-fonio-filter-close]').forEach((button) => {
    button.addEventListener('click', closeFonioActivityFilterSheet);
  });

  syncFonioActivityToolbarControls();
}

function renderFonioActivityTable() {
  ensureFonioActivityToolbar();
const filtered = filterFonioActivityList(fonioActivityCache);
  const savedSearch = tableState.fonioActivity.search;
  tableState.fonioActivity.search = '';
  const data = paginateClient(filtered, 'fonioActivity', () => '');
  tableState.fonioActivity.search = savedSearch;

  const rows = data.items
    .map((log) => {
      const meta = log.metadata ?? {};
      const requestText = formatFonioRequestSummary(meta.requestReceived, log.action, meta);
      const summary = formatFonioActionSummary(log.action, meta);
      const selected = String(log.id) === String(fonioActivitySelectedId);
      return `
      <tr class="fonio-activity-row${selected ? ' is-selected' : ''}" data-fonio-row="${esc(String(log.id))}" tabindex="0">
        <td class="fonio-activity-col-time">${esc(formatDashboardDateTime(log.createdAt))}</td>
        <td>${fonioActionChip(log.action)}</td>
        <td>${fonioStatusPill(log.statusCode)}</td>
        <td class="metadata-cell oneline" title="${esc(requestText)}">${esc(requestText)}</td>
        <td>${fonioOutcomePill(log)}</td>
        <td class="metadata-cell oneline" title="${esc(summary)}">${esc(summary)}</td>
        <td class="fonio-activity-col-duration">${esc(fonioDurationLabel(log.durationMs))}</td>
      </tr>`;
    })
    .join('');

  const tableEl = $('#fonio-activity-table');
  if (tableEl) {
    tableEl.innerHTML = `
      <table class="fonio-activity-table">
        <thead><tr>
          ${sortTh('fonioActivity', 'createdAt', t('logs.time'))}
          ${sortTh('fonioActivity', 'action', t('fonioActivity.action'))}
          <th>${t('logs.status')}</th>
          <th>${t('fonioActivity.request')}</th>
          <th>${t('fonioActivity.outcome')}</th>
          <th>${t('fonioActivity.summary')}</th>
          <th>${t('fonioActivity.duration')}</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="7">${esc(t('fonioActivity.none'))}</td></tr>`}</tbody>
      </table>`;
  }

  bindSortableHeaders('#fonio-activity-table', 'fonioActivity', renderFonioActivityTable);
  renderTableInfo('#fonio-activity-info', data, data.maxTotal);
  renderPagination('#fonio-activity-pagination', data, 'fonioActivity', renderFonioActivityTable);
  renderFonioActivityMobileCards(data.items);

  $$('#fonio-activity-table [data-fonio-row]').forEach((row) => {
    const open = () => openFonioActivityDrawer(row.getAttribute('data-fonio-row'));
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });

  scheduleEnhanceResponsiveTables();
}

function fonioSvg(paths, size = 16) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function fonioActionDisplayTitle(action) {
  const key = `fonioActivity.actionTitle.${action}`;
  const labeled = t(key);
  if (labeled && labeled !== key) return labeled;
  return String(action || '—')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function fonioActionDrawerIcon(action) {
  const tone = fonioActionTone(action);
  let paths =
    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>';
  if (action === 'booking_offer' || action === 'guest_reservation') {
    paths =
      '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>';
  } else if (fonioIsAvailabilityAction(action)) {
    paths = '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>';
  } else if (action === 'guest_verify' || action === 'verify_requirements') {
    paths = '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/>';
  } else if (action === 'guest_request' || action === 'guest_send_checkin_info') {
    paths = '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>';
  } else if (action === 'guest_payment') {
    paths = '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>';
  } else if (action === 'call_context') {
    paths =
      '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>';
  }
  return { tone, html: fonioSvg(paths, 18) };
}

function fonioFieldLabel(key) {
  const map = {
    note: 'fonioActivity.field.note',
    phone: 'fonioActivity.field.phone',
    guests: 'fonioActivity.field.guests',
    checkIn: 'fonioActivity.field.checkIn',
    checkOut: 'fonioActivity.field.checkOut',
    listing: 'fonioActivity.field.listing',
    listingId: 'fonioActivity.field.listingId',
    listingName: 'fonioActivity.field.listing',
    guest: 'fonioActivity.field.guest',
    guestEmail: 'fonioActivity.field.email',
    email: 'fonioActivity.field.email',
    city: 'fonioActivity.field.city',
    arrivalDate: 'fonioActivity.field.checkIn',
    departureDate: 'fonioActivity.field.checkOut',
    reservationId: 'fonioActivity.field.reservationId',
    requestType: 'fonioActivity.field.requestType',
    pets: 'fonioActivity.field.pets',
    fieldsProvided: 'fonioActivity.field.fieldsProvided',
    callerNumber: 'fonioActivity.field.phone',
    status: 'fonioActivity.field.status',
    offerCreated: 'fonioActivity.field.offerCreated',
  };
  const i18nKey = map[key];
  if (i18nKey) {
    const v = t(i18nKey);
    if (v !== i18nKey) return v;
  }
  return String(key)
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase());
}

function fonioFormatFieldValue(key, value) {
  if (value == null || value === '') return '—';
  if (typeof value === 'boolean') return value ? t('common.yes') : t('common.no');
  if (key === 'checkIn' || key === 'checkOut' || key === 'arrivalDate' || key === 'departureDate') {
    try {
      const d = new Date(`${String(value).slice(0, 10)}T12:00:00`);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleDateString(typeof locale === 'function' ? locale() : 'en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });
      }
    } catch (_) {
      /* fall through */
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    if (!value.length) return '—';
    if (value.every((v) => v == null || ['string', 'number', 'boolean'].includes(typeof v))) {
      return value.map((v) => (typeof v === 'boolean' ? (v ? t('common.yes') : t('common.no')) : String(v))).join(', ');
    }
    return null;
  }
  if (typeof value === 'object') return null;
  return String(value);
}

function fonioIsUsefulRecordedValue(value) {
  if (value == null || value === '') return false;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) {
    return (
      value.length > 0 &&
      value.length <= 20 &&
      value.every((v) => v == null || ['string', 'number', 'boolean'].includes(typeof v))
    );
  }
  return false;
}

function fonioCollectRequestFields(log) {
  const meta = log.metadata ?? {};
  const req = meta.requestReceived && typeof meta.requestReceived === 'object' ? meta.requestReceived : {};
  const res = meta.responseRecorded && typeof meta.responseRecorded === 'object' ? meta.responseRecorded : {};
  const fields = [];
  const push = (key, raw) => {
    if (raw == null || raw === '') return;
    const value = fonioFormatFieldValue(key, raw);
    if (value == null || value === '') return;
    fields.push({ key, label: fonioFieldLabel(key), value });
  };

  push('note', req.note);
  push('phone', req.phone || req.callerNumber);
  push('guests', req.guests ?? meta.guests);
  push('checkIn', req.checkIn || req.arrivalDate || res.checkIn);
  push('checkOut', req.checkOut || req.departureDate || res.checkOut);

  const listingName = req.listingName || res.listingName || meta.listingName;
  const listingId = req.listingId || meta.listingId;
  if (listingName || listingId) {
    const listing =
      listingName && listingId ? `${listingName} · ${listingId}` : listingName || String(listingId);
    push('listing', listing);
  }

  const guestName = [req.guestFirstName, req.guestLastName].filter(Boolean).join(' ').trim();
  if (guestName) push('guest', guestName);
  push('guestEmail', req.guestEmail || req.email);
  push('city', req.city || meta.city);
  push('reservationId', req.reservationId);
  push('requestType', req.requestType);
  if (req.pets != null && req.pets !== '' && req.pets !== 0 && req.pets !== false) {
    push('pets', req.pets);
  }
  push('fieldsProvided', req.fieldsProvided);

  if (!fields.length && typeof meta.requestReceived === 'string' && meta.requestReceived) {
    fields.push({
      key: 'raw',
      label: t('fonioActivity.requestSection'),
      value: meta.requestReceived,
    });
  }
  return fields;
}

function fonioCollectRecordedFields(log) {
  const meta = log.metadata ?? {};
  const res =
    meta.responseRecorded && typeof meta.responseRecorded === 'object' ? { ...meta.responseRecorded } : {};
  const skip = new Set([
    'hintDe',
    'hintEn',
    'guestScriptDe',
    'guestScriptEn',
    'verificationInstructionsDe',
    'message',
    'listings',
    'availableListings',
    'available',
    'results',
    'items',
    'weekends',
    'days',
    'calendar',
    'properties',
    'raw',
    'payload',
    'data',
    'matches',
    'options',
  ]);
  const fields = [];
  Object.entries(res).forEach(([k, v]) => {
    if (skip.has(k) || !fonioIsUsefulRecordedValue(v)) return;
    const value = fonioFormatFieldValue(k, v);
    if (value == null || value === '' || String(value).includes('[object Object]')) return;
    fields.push({ key: k, label: fonioFieldLabel(k), value });
  });
  if (meta.reservationId && !fields.some((f) => f.key === 'reservationId')) {
    fields.push({
      key: 'reservationId',
      label: fonioFieldLabel('reservationId'),
      value: String(meta.reservationId),
    });
  }
  return fields;
}

function fonioSummaryHeadline(log) {
  const kind = fonioOutcomeKind(log);
  const meta = log.metadata ?? {};
  if (log.action === 'booking_offer') {
    return kind === 'success'
      ? t('fonioActivity.summary.bookingOfferOk')
      : t('fonioActivity.summary.bookingOfferFail');
  }
  if (log.action === 'guest_verify') {
    return kind === 'success'
      ? t('fonioActivity.summary.verifyOk')
      : t('fonioActivity.summary.verifyFail');
  }
  if (kind === 'success') return t('fonioActivity.summary.success');
  if (kind === 'failed') return t('fonioActivity.summary.failed');
  return formatFonioActionSummary(log.action, meta) || t('fonioActivity.outcomeUnknown');
}

function fonioSummarySubline(log) {
  const meta = log.metadata ?? {};
  const reservationId = meta.reservationId || meta.responseRecorded?.reservationId;
  if (log.action === 'booking_offer' && reservationId) {
    const name = meta.listingName || meta.responseRecorded?.listingName || '';
    return t('fonioActivity.summary.bookingOfferSub', {
      id: reservationId,
      name: name || '—',
    });
  }
  if (meta.middlewareAction) return meta.middlewareAction;
  return formatFonioActionSummary(log.action, meta);
}

function fonioInquiryId(log) {
  const meta = log.metadata ?? {};
  return (
    meta.reservationId ||
    meta.responseRecorded?.reservationId ||
    meta.requestReceived?.reservationId ||
    null
  );
}

function buildFonioActivitySteps(log) {
  const meta = log.metadata ?? {};
  const requestText = formatFonioRequestSummary(meta.requestReceived, log.action, meta);
  const kind = fonioOutcomeKind(log);
  const endMs = new Date(log.createdAt).getTime();
  const duration = Number(log.durationMs);
  const startMs = Number.isFinite(duration) && duration > 0 ? endMs - duration : endMs;
  const midMs = startMs + Math.max(0, (endMs - startMs) / 2);
  const steps = [
    {
      key: 'received',
      title: t('fonioActivity.stepReceived'),
      detail: requestText && requestText !== '-' && requestText !== '–' ? requestText : t('logs.noRequestBody'),
      state: 'done',
      at: startMs,
    },
    {
      key: 'processed',
      title: t('fonioActivity.stepProcessed'),
      detail: meta.middlewareAction || t('fonioActivity.stepProcessedFallback'),
      state: meta.middlewareAction ? 'done' : 'skip',
      at: midMs,
    },
    {
      key: 'responded',
      title: t('fonioActivity.stepResponded'),
      detail:
        meta.outcomeDetail ||
        formatFonioActionSummary(log.action, meta) ||
        t('fonioActivity.stepRespondedFallback'),
      state: kind === 'failed' ? 'fail' : kind === 'success' ? 'ok' : 'done',
      at: endMs,
    },
  ];
  return steps;
}

function fonioDetailGridHtml(fields) {
  if (!fields.length) {
    return `<p class="field-hint">${esc(t('logs.noRequestBody'))}</p>`;
  }
  return `<div class="fonio-activity-detail-grid">${fields
    .map(
      (f) => `
      <div class="fonio-activity-detail-item">
        <div class="fonio-activity-detail-label">${esc(f.label)}</div>
        <div class="fonio-activity-detail-value">${esc(f.value)}</div>
      </div>`,
    )
    .join('')}</div>`;
}

function fonioSectionTitle(iconPaths, label, tone = 'blue') {
  return `<h4 class="fonio-activity-section-title tone-${tone}">${fonioSvg(iconPaths, 15)}<span>${esc(label)}</span></h4>`;
}

function renderFonioActivityDrawerBody(log) {
  const meta = log.metadata ?? {};
  const kind = fonioOutcomeKind(log);
  const summary = formatFonioActionSummary(log.action, meta);
  const headline = fonioSummaryHeadline(log);
  const subline = fonioSummarySubline(log);
  const steps = buildFonioActivitySteps(log);
  const requestFields = fonioCollectRequestFields(log);
  const recordedFields = fonioCollectRecordedFields(log);
  const requestJson =
    typeof meta.requestReceived === 'string'
      ? meta.requestReceived
      : JSON.stringify(meta.requestReceived ?? {}, null, 2);
  const metaJson = JSON.stringify(meta ?? {}, null, 2);
  const outcomeText = meta.outcomeDetail || summary;
  const outcomeCls = kind === 'failed' ? 'is-fail' : kind === 'success' ? 'is-ok' : 'is-unknown';

  const stepsHtml = steps
    .map(
      (step) => `
      <li class="fonio-activity-step is-${esc(step.state)}">
        <div class="fonio-activity-step-dot" aria-hidden="true"></div>
        <div class="fonio-activity-step-body">
          <div class="fonio-activity-step-top">
            <div class="fonio-activity-step-title">${esc(step.title)}</div>
            <time class="fonio-activity-step-time">${esc(
              Number.isFinite(step.at)
                ? new Date(step.at).toLocaleTimeString(typeof locale === 'function' ? locale() : 'en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })
                : '',
            )}</time>
          </div>
          <div class="fonio-activity-step-detail">${esc(step.detail)}</div>
        </div>
      </li>`,
    )
    .join('');

  const heroIcon =
    kind === 'failed'
      ? fonioSvg('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>', 22)
      : fonioSvg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>', 22);

  const recordedSection = recordedFields.length
    ? `<section class="fonio-activity-drawer-section">
      <details class="fonio-activity-collapse">
        <summary>
          ${fonioSvg('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6"/>', 15)}
          <span>${esc(t('fonioActivity.recordedData'))}</span>
        </summary>
        <div class="fonio-activity-collapse-body">
          ${fonioDetailGridHtml(recordedFields)}
        </div>
      </details>
    </section>`
    : '';

  return `
    <div class="fonio-activity-drawer-meta">
      <div class="fonio-activity-drawer-pills">
        ${fonioActionChip(log.action)}
        ${fonioStatusPill(log.statusCode)}
        ${fonioOutcomePill(log)}
      </div>
      <time class="fonio-activity-drawer-when">${esc(formatDashboardDateTime(log.createdAt))}</time>
    </div>

    <section class="fonio-activity-hero ${outcomeCls}">
      <div class="fonio-activity-hero-top">
        <span class="fonio-activity-hero-icon" aria-hidden="true">${heroIcon}</span>
        <div class="fonio-activity-hero-copy">
          <div class="fonio-activity-hero-title">${esc(headline)}</div>
          <div class="fonio-activity-hero-sub">${esc(subline)}</div>
        </div>
      </div>
      <div class="fonio-activity-hero-metrics">
        <div class="fonio-activity-hero-metric">
          <div class="fonio-activity-hero-metric-label">
            ${fonioSvg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', 14)}
            <span>${esc(t('fonioActivity.duration'))}</span>
          </div>
          <strong>${esc(fonioDurationLabel(log.durationMs))}</strong>
        </div>
        <div class="fonio-activity-hero-metric">
          <div class="fonio-activity-hero-metric-label">
            ${fonioSvg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>', 14)}
            <span>${esc(t('fonioActivity.field.method'))}</span>
          </div>
          <strong><code>${esc(log.method || '—')}</code></strong>
        </div>
        <div class="fonio-activity-hero-metric fonio-activity-hero-endpoint">
          <div class="fonio-activity-hero-metric-label">
            ${fonioSvg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>', 14)}
            <span>${esc(t('fonioActivity.field.endpoint'))}</span>
          </div>
          <strong><code title="${esc(log.path || '')}">${esc(log.path || '—')}</code></strong>
        </div>
      </div>
    </section>

    <section class="fonio-activity-drawer-section">
      ${fonioSectionTitle('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>', t('fonioActivity.requestDetails'))}
      ${fonioDetailGridHtml(requestFields)}
    </section>

    <section class="fonio-activity-drawer-section">
      ${fonioSectionTitle('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', t('fonioActivity.timelineTitle'))}
      <ol class="fonio-activity-steps">${stepsHtml}</ol>
    </section>

    <section class="fonio-activity-drawer-section">
      ${fonioSectionTitle('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>', t('fonioActivity.outcome'))}
      <div class="fonio-activity-outcome-banner ${outcomeCls}">
        <span aria-hidden="true">${
          kind === 'failed'
            ? fonioSvg('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>', 16)
            : fonioSvg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>', 16)
        }</span>
        <p>${esc(outcomeText)}</p>
      </div>
    </section>

    ${recordedSection}

    <section class="fonio-activity-drawer-section fonio-activity-raw-stack">
      <details class="fonio-activity-raw">
        <summary>
          ${fonioSvg('<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>', 14)}
          <span>${esc(t('logs.rawRequest'))}</span>
        </summary>
        <pre class="json-block">${esc(requestJson)}</pre>
      </details>
      <details class="fonio-activity-raw">
        <summary>
          ${fonioSvg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>', 14)}
          <span>${esc(t('logs.fullMetadata'))}</span>
        </summary>
        <pre class="json-block">${esc(metaJson)}</pre>
      </details>
    </section>
  `;
}

function renderFonioActivityDrawerFooter(log) {
  const inquiryId = fonioInquiryId(log);
  const openBtn = inquiryId
    ? `<button type="button" class="btn primary" data-fonio-open-inquiry="${esc(String(inquiryId))}">
        ${fonioSvg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>', 15)}
        ${esc(t('fonioActivity.openInquiry'))}
      </button>`
    : '';
  return `
    <button type="button" class="btn ghost" data-fonio-copy-details>
      ${fonioSvg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 15)}
      ${esc(t('fonioActivity.copyEventDetails'))}
    </button>
    ${openBtn}
  `;
}

async function copyFonioActivityDetails(log) {
  const meta = log.metadata ?? {};
  const text = [
    `Action: ${log.action}`,
    `Call ID: ${meta.callId || log.id}`,
    `Status: ${log.statusCode ?? '—'}`,
    `Outcome: ${fonioOutcomeKind(log)}`,
    `Time: ${formatDateTime(log.createdAt)}`,
    `Duration: ${fonioDurationLabel(log.durationMs)}`,
    `Method: ${log.method || '—'}`,
    `Path: ${log.path || '—'}`,
    `Middleware: ${meta.middlewareAction || '—'}`,
    `Summary: ${formatFonioActionSummary(log.action, meta)}`,
    meta.outcomeDetail ? `Detail: ${meta.outcomeDetail}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    notify.success(t('common.copied'));
  } catch (_) {
    notify.error(t('common.copyFailed') !== 'common.copyFailed' ? t('common.copyFailed') : 'Copy failed');
  }
}

function openFonioInquiry(reservationId) {
  const id = Number(reservationId);
  if (!Number.isFinite(id)) return;
  closeFonioActivityDrawer();
  activateTab('reservations');
  setTimeout(() => {
    openReservationDrawer(id).catch(() => {});
  }, 250);
}

function openFonioActivityDrawer(id) {
  const log = fonioActivityCache.find((l) => String(l.id) === String(id));
  const drawer = $('#fonio-activity-drawer');
  if (!log || !drawer) return;

  fonioActivitySelectedId = log.id;
  const meta = log.metadata ?? {};
  const icon = fonioActionDrawerIcon(log.action);
  const iconEl = $('#fonio-activity-drawer-icon');
  if (iconEl) {
    iconEl.className = `fonio-activity-drawer-icon tone-${icon.tone}`;
    iconEl.innerHTML = icon.html;
  }
  $('#fonio-activity-drawer-title').textContent = fonioActionDisplayTitle(log.action);
  const idEl = $('#fonio-activity-drawer-id');
  if (idEl) idEl.textContent = String(meta.callId || log.id || '—');

  const body = $('#fonio-activity-drawer-body');
  if (body) body.innerHTML = renderFonioActivityDrawerBody(log);
  const footer = $('#fonio-activity-drawer-footer');
  if (footer) footer.innerHTML = renderFonioActivityDrawerFooter(log);

  drawer.classList.remove('hidden');
  drawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('fonio-activity-drawer-open');

  $$('#fonio-activity-table .fonio-activity-row').forEach((row) => {
    row.classList.toggle('is-selected', row.getAttribute('data-fonio-row') === String(log.id));
  });
  $$('#fonio-activity-mobile-list [data-fonio-mobile-row]').forEach((card) => {
    card.classList.toggle('is-selected', card.getAttribute('data-fonio-mobile-row') === String(log.id));
  });
}

function closeFonioActivityDrawer() {
  const drawer = $('#fonio-activity-drawer');
  if (!drawer) return;
  drawer.classList.add('hidden');
  drawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('fonio-activity-drawer-open');
  fonioActivitySelectedId = null;
  $$('#fonio-activity-table .fonio-activity-row').forEach((row) => {
    row.classList.remove('is-selected');
  });
  $$('#fonio-activity-mobile-list [data-fonio-mobile-row]').forEach((card) => {
    card.classList.remove('is-selected');
  });
}

function showFonioActivityDetail(logOrId) {
  const id = logOrId && typeof logOrId === 'object' ? logOrId.id : logOrId;
  openFonioActivityDrawer(id);
}

async function loadFonioActivity(opts = {}) {
  ensureFonioActivityUi();
  ensureFonioActivityToolbar();
  manageFonioActivityPoll();

  const state = tableState.fonioActivity;
  const params = new URLSearchParams({ limit: '500' });
  if (state.actionFilter) params.set('action', state.actionFilter);

  const logs = await api(`/fonio-activity?${params}`);
  fonioActivityCache = Array.isArray(logs) ? logs : [];
  fonioActivityLastFetchedAt = new Date().toISOString();

  renderFonioActivityStats(fonioActivityCache);
  renderFonioActivityChart(fonioActivityCache);
  updateFonioActivityLastUpdated();
  renderFonioActivityTable();

  if (fonioActivitySelectedId) {
    const stillThere = fonioActivityCache.some(
      (l) => String(l.id) === String(fonioActivitySelectedId),
    );
    if (stillThere && !opts.silent) {
      openFonioActivityDrawer(fonioActivitySelectedId);
    } else if (!stillThere) {
      closeFonioActivityDrawer();
    } else if (stillThere && opts.silent) {
      const body = $('#fonio-activity-drawer-body');
      const footer = $('#fonio-activity-drawer-footer');
      const log = fonioActivityCache.find(
        (l) => String(l.id) === String(fonioActivitySelectedId),
      );
      if (log && !$('#fonio-activity-drawer')?.classList.contains('hidden')) {
        if (body) body.innerHTML = renderFonioActivityDrawerBody(log);
        if (footer) footer.innerHTML = renderFonioActivityDrawerFooter(log);
      }
    }
  }
}

function formatFonioRequestSummary(requestReceived, action, meta) {
  const req = requestReceived && typeof requestReceived === 'object' ? requestReceived : null;
  if (!req || Object.keys(req).length === 0) {
    return formatLegacyFonioRequest(action, meta);
  }
  const parts = [];
  if (req.city) parts.push(`city=${req.city}`);
  if (req.checkIn && req.checkOut) parts.push(`${req.checkIn}→${req.checkOut}`);
  if (req.guests) parts.push(`guests=${req.guests}`);
  if (req.arrivalDate && req.departureDate) parts.push(`${req.arrivalDate}→${req.departureDate}`);
  if (req.fieldsProvided?.length) parts.push(`fields=[${req.fieldsProvided.join(',')}]`);
  if (req.listingName) parts.push(`listing=${req.listingName}`);
  if (req.reservationId) parts.push(`reservationId=${req.reservationId}`);
  if (req.requestType) parts.push(`type=${req.requestType}`);
  if (req.listingId) parts.push(`listingId=${req.listingId}`);
  if (req.callerNumber || req.phone) parts.push('phone=[masked]');
  if (req.email || req.guestEmail) parts.push('email=[masked]');
  if (parts.length > 0) return parts.join(' · ');
  return JSON.stringify(req);
}

function formatLegacyFonioRequest(action, meta) {
  switch (action) {
    case 'availability_search':
      return `${meta.city ?? '–'} ${meta.checkIn ?? ''}→${meta.checkOut ?? ''} guests=${meta.guests ?? '–'}`;
    case 'guest_verify':
      return `${meta.arrivalDate ?? ''}→${meta.departureDate ?? ''}${meta.hadReservationId ? ' +reservationId' : ''}`;
    case 'verify_requirements':
      return t('logs.getNoBody');
    default:
      return '–';
  }
}

function formatFonioOutcome(meta) {
  const outcome = meta.outcome;
  if (outcome === 'success') {
    return `<span class="badge ok">${t('fonioActivity.outcomeSuccess')}</span>`;
  }
  if (outcome === 'failed') {
    return `<span class="badge warn">${t('fonioActivity.outcomeFailed')}</span>`;
  }
  if (meta.verified === true) {
    return `<span class="badge ok">${t('fonioActivity.outcomeSuccess')}</span>`;
  }
  if (meta.verified === false) {
    return `<span class="badge warn">${t('fonioActivity.outcomeFailed')}</span>`;
  }
  return '–';
}

function formatFonioActionSummary(action, meta) {
  switch (action) {
    case 'call_context': {
      const recognized =
        meta.caller_recognized ??
        meta.responseRecorded?.caller_recognized ??
        meta.responseRecorded?.callerRecognized;
      return recognized ? t('fonioActivity.callerRecognized') : t('fonioActivity.callerUnknown');
    }
    case 'availability_search':
      return t('fonioActivity.availabilityResult', {
        city: meta.city ?? '–',
        count: meta.availableCount ?? 0,
        source: meta.dataSource ?? 'cache',
      });
    case 'guest_verify':
      return meta.verified
        ? t('fonioActivity.verifyOk', { id: meta.reservationId ?? '–' })
        : t('fonioActivity.verifyFail', { message: meta.message ?? '–' });
    case 'guest_reservation':
      return t('fonioActivity.reservationFetched', { name: meta.listingName ?? '–' });
    case 'guest_request':
      return t('fonioActivity.requestResult', {
        type: meta.requestType ?? '–',
        status: meta.status ?? '–',
      });
    case 'guest_send_checkin_info':
      return meta.emailSent
        ? t('fonioActivity.checkinEmailOk', {
            name: meta.templateName ?? meta.responseRecorded?.templateName ?? '–',
          })
        : t('fonioActivity.checkinEmailFail', {
            message: meta.outcomeDetail ?? meta.message ?? '–',
          });
    case 'booking_offer':
      return meta.offerCreated !== false && meta.reservationId
        ? t('fonioActivity.bookingOfferOk', {
            name: meta.listingName ?? meta.responseRecorded?.listingName ?? '–',
            id: meta.reservationId ?? meta.responseRecorded?.reservationId ?? '–',
          })
        : t('fonioActivity.bookingOfferFail', {
            message: meta.outcomeDetail ?? meta.message ?? '–',
          });
    case 'verify_requirements':
      return t('fonioActivity.verifyRequirements', {
        count: meta.responseRecorded?.minMatchCount ?? meta.minMatchCount ?? '–',
      });
    default:
      return '–';
  }
}

let usersUiBound = false;
let usersActiveView = 'list';
let usersSecurityCache = [];

const USERS_PERM_GROUPS = [
  {
    id: 'pages',
    labelKey: 'perms.pages',
    unitKey: 'perms.unitPages',
    tone: 'blue',
    icon: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    match: (item) => item.group === 'pages',
  },
  {
    id: 'data',
    labelKey: 'perms.data',
    unitKey: 'perms.unitData',
    tone: 'purple',
    icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6"/>',
    match: (item) => ['RESERVATIONS_VIEW_PII', 'LISTINGS_EDIT'].includes(item.key),
  },
  {
    id: 'operations',
    labelKey: 'perms.operations',
    unitKey: 'perms.unitActions',
    tone: 'orange',
    icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    match: (item) =>
      ['CONVERSATIONS_MANAGE', 'RULES_EDIT', 'RULES_DELETE', 'REQUESTS_MANAGE', 'PAYMENTS_REVIEW'].includes(item.key),
  },
  {
    id: 'integrations',
    labelKey: 'perms.integrations',
    unitKey: 'perms.unitIntegrations',
    tone: 'teal',
    icon: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    match: (item) =>
      ['SYNC_RUN', 'SYNC_SETTINGS_EDIT', 'WEBHOOKS_MANAGE', 'FONIO_SETUP_VIEW', 'FONIO_ACTIVITY_VIEW'].includes(item.key),
  },
  {
    id: 'administration',
    labelKey: 'perms.administration',
    unitKey: 'perms.unitAdmin',
    tone: 'rose',
    icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    match: (item) =>
      ['USERS_MANAGE', 'ROLE_PERMISSIONS_MANAGE', 'LOG_SETTINGS_EDIT', 'PAYMENTS_ADMIN', 'LOGS_VIEW'].includes(item.key),
  },
];

function userDisplayName(user) {
  const email = String(user?.email || '');
  const local = email.split('@')[0] || email;
  return local
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || email || '–';
}

function userInitials(user) {
  const name = userDisplayName(user);
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase() || '?';
}

function userRoleTone(role) {
  if (role === 'SUPER_ADMIN') return 'super';
  if (role === 'ADMIN') return 'admin';
  if (role === 'BACK_OFFICE') return 'backoffice';
  return 'default';
}

function formatUserShortDate(value) {
  if (!value) return '–';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatUserLastActive(value) {
  if (!value) return '–';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '–';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (sameDay) return t('users.todayAt', { time });
  return `${formatUserShortDate(value)}, ${time}`;
}

function passwordStrength(value) {
  const v = String(value || '');
  if (!v) return { score: 0, label: '' };
  let score = 0;
  if (v.length >= 8) score += 1;
  if (v.length >= 12) score += 1;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score += 1;
  if (/\d/.test(v) && /[^A-Za-z0-9]/.test(v)) score += 1;
  const labels = ['', 'users.strengthWeak', 'users.strengthFair', 'users.strengthGood', 'users.strengthStrong'];
  return { score, label: labels[score] ? t(labels[score]) : '' };
}

function generateTempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@$%*?';
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

function updateUserPasswordWarning() {
  const input = $('#user-password');
  const warning = $('#user-password-warning');
  if (!input || !warning) return;
  const value = input.value;
  const show = value.length > 0 && value.length < 8;
  warning.classList.toggle('hidden', !show);
  warning.textContent = t('users.passwordTooShort');
  const strength = passwordStrength(value);
  const wrap = $('#user-password-strength');
  const label = $('#user-password-strength-label');
  if (wrap) {
    wrap.dataset.score = String(strength.score);
    wrap.classList.toggle('is-empty', !value);
  }
  if (label) label.textContent = value ? strength.label : '';
}

function setUsersView(view) {
  usersActiveView = ['list', 'perms', 'security'].includes(view) ? view : 'list';
  $$('.users-tab').forEach((btn) => {
    const on = btn.dataset.usersTab === usersActiveView;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $('#users-view-list')?.classList.toggle('hidden', usersActiveView !== 'list');
  $('#users-view-perms')?.classList.toggle('hidden', usersActiveView !== 'perms');
  $('#users-view-security')?.classList.toggle('hidden', usersActiveView !== 'security');
  $('#tab-users .users-page-header')?.classList.toggle('hidden', usersActiveView !== 'list');
  $('#users-kpis')?.classList.toggle('hidden', usersActiveView !== 'list');
  const securityHint = $('#users-view-security .users-security-heading .field-hint');
  if (securityHint) {
    securityHint.textContent = isUsersMobileLayout()
      ? t('users.securityHintMobile')
      : t('users.securityHint');
  }
  const securitySearch = $('#users-security-search');
  if (securitySearch) {
    securitySearch.placeholder = isUsersMobileLayout()
      ? t('users.securitySearchPlaceholderMobile')
      : t('users.securitySearchPlaceholder');
  }
  document.body.classList.toggle('users-perms-view', usersActiveView === 'perms');
  if (usersActiveView === 'security') loadUsersSecurityActivity();
  if (usersActiveView === 'perms') loadRolePermissionsMatrix();
}

function isUsersMobileLayout() {
  return window.matchMedia('(max-width: 1023px)').matches;
}

function closeUsersFilterSheet() {
  const sheet = $('#users-filter-sheet');
  if (!sheet) return;
  sheet.classList.add('hidden');
  sheet.hidden = true;
  document.body.classList.remove('users-filter-open');
}

function openUsersFilterSheet(kind) {
  const sheet = $('#users-filter-sheet');
  const body = $('#users-filter-sheet-body');
  const title = $('#users-filter-sheet-title');
  if (!sheet || !body || !title) return;
  const select = kind === 'status' ? $('#users-filter-status') : $('#users-filter-role');
  if (!select) return;
  title.textContent = kind === 'status' ? t('users.col.status') : t('users.col.role');
  const current = select.value;
  body.innerHTML = [...select.options].map((opt) => `
    <button type="button" class="users-filter-option${opt.value === current ? ' is-selected' : ''}" data-users-filter-value="${esc(opt.value)}">
      ${esc(opt.textContent || opt.value)}
    </button>
  `).join('');
  body.querySelectorAll('[data-users-filter-value]').forEach((btn) => {
    btn.addEventListener('click', () => {
      select.value = btn.dataset.usersFilterValue;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      closeUsersFilterSheet();
    });
  });
  sheet.classList.remove('hidden');
  sheet.hidden = false;
  document.body.classList.add('users-filter-open');
}

function syncUsersFilterChips() {
  const role = tableState.users.role || 'all';
  const status = tableState.users.status || 'all';
  const roleBtn = $('[data-users-mobile-filter="role"]');
  const statusBtn = $('[data-users-mobile-filter="status"]');
  const roleSelect = $('#users-filter-role');
  const statusSelect = $('#users-filter-status');
  if (roleBtn) {
    roleBtn.classList.toggle('is-active', role !== 'all');
    const label = roleBtn.querySelector('span');
    if (label) label.textContent = roleSelect?.selectedOptions?.[0]?.textContent?.trim() || t('users.col.role');
  }
  if (statusBtn) {
    statusBtn.classList.toggle('is-active', status !== 'all');
    const label = statusBtn.querySelector('span');
    if (label) label.textContent = statusSelect?.selectedOptions?.[0]?.textContent?.trim() || t('users.col.status');
  }
}

function syncUserFormHints({ editing = false } = {}) {
  const passwordHint = $('#user-password-hint');
  const activeHelp = $('#user-active-help');
  if (passwordHint) {
    passwordHint.textContent = editing ? t('users.passwordHint') : t('users.passwordHintGenerate');
  }
  if (activeHelp) {
    activeHelp.textContent = editing ? t('users.activeHelp') : t('users.activeHelpCreate');
  }
}

function openUsersDrawer() {
  const drawer = $('#users-drawer');
  if (!drawer) return;
  drawer.classList.remove('hidden');
  drawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('users-drawer-open');
  renderUsersDrawerPermPreview();
}

function closeUsersDrawer() {
  const drawer = $('#users-drawer');
  if (!drawer) return;
  drawer.classList.add('hidden');
  drawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('users-drawer-open');
  resetUserForm({ keepDrawerClosed: true });
}

function resetUserForm({ keepDrawerClosed = false } = {}) {
  editingUserId = null;
  usersDrawerPermOpen = false;
  $('#user-id').value = '';
  $('#user-email').value = '';
  $('#user-email').removeAttribute('readonly');
  $('#user-password').value = '';
  $('#user-password').required = true;
  $('#user-password').type = 'password';
  $('#user-role').value = 'ADMIN';
  $('#user-active').checked = true;
  $('#user-form-title').textContent = t('users.addAdminUser');
  $('#users-drawer-subtitle').textContent = t('users.drawerHint');
  $('#user-submit-btn').textContent = t('users.addUser');
  $('#user-delete-btn')?.classList.add('hidden');
  syncUserFormHints({ editing: false });
  updateUserPasswordWarning();
  updateUserRowSelection(null);
  renderUsersDrawerPermPreview();
  if (!keepDrawerClosed) closeUsersDrawer();
}

function loadUserIntoForm(user) {
  editingUserId = user.id;
  usersDrawerPermOpen = false;
  $('#user-id').value = user.id;
  $('#user-email').value = user.email;
  $('#user-email').setAttribute('readonly', 'readonly');
  $('#user-password').value = '';
  $('#user-password').required = false;
  $('#user-password').type = 'password';
  $('#user-role').value = ['BACK_OFFICE', 'ADMIN', 'SUPER_ADMIN'].includes(user.role)
    ? user.role
    : 'BACK_OFFICE';
  $('#user-active').checked = user.isActive;
  $('#user-form-title').textContent = t('users.editUser');
  $('#users-drawer-subtitle').textContent = t('users.editDrawerHint');
  $('#user-submit-btn').textContent = t('users.save');
  $('#user-delete-btn')?.classList.toggle('hidden', !user.isActive);
  syncUserFormHints({ editing: true });
  updateUserPasswordWarning();
  updateUserRowSelection(user.id);
  openUsersDrawer();
  renderUsersDrawerPermPreview();
}

function updateUserRowSelection(userId) {
  $$('#users-table tbody tr').forEach((row) => {
    row.classList.toggle('selected', userId && row.dataset.userId === userId);
  });
  $$('#users-mobile-list .users-mobile-card').forEach((card) => {
    card.classList.toggle('is-selected', userId && card.dataset.userId === userId);
  });
}

function bindUserRowClicks(root = document) {
  root.querySelectorAll('[data-user-edit]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.userEdit;
      const user = cachedUsers.find((u) => u.id === id);
      if (user) loadUserIntoForm(user);
    });
  });
  root.querySelectorAll('[data-user-menu]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.userMenu;
      const menu = $(`#users-menu-${id}`) || $(`#users-mobile-menu-${id}`);
      $$('.users-row-menu').forEach((el) => {
        if (el !== menu) el.classList.add('hidden');
      });
      menu?.classList.toggle('hidden');
    });
  });
}

function permCountsForRole(role) {
  const catalog = cachedPermMatrix?.catalog || [];
  const selected = new Set(
    role === 'SUPER_ADMIN'
      ? catalog.map((item) => item.key)
      : cachedPermMatrix?.matrix?.[role] || [],
  );
  return USERS_PERM_GROUPS.map((group) => {
    const items = catalog.filter(group.match);
    const enabled = items.filter((item) => selected.has(item.key)).length;
    return {
      ...group,
      enabled,
      total: items.length || 1,
    };
  });
}

function renderPermPreviewCards(targetSel, role) {
  const el = $(targetSel);
  if (!el) return;
  const cards = permCountsForRole(role);
  el.innerHTML = cards.map((c) => `
    <article class="users-perm-card">
      <span class="users-perm-card-icon is-${esc(c.tone)}" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${c.icon}</svg>
      </span>
      <div>
        <div class="users-perm-card-label">${esc(t(c.labelKey))}</div>
        <div class="users-perm-card-value">${c.enabled} / ${c.total} ${esc(t(c.unitKey))}</div>
      </div>
    </article>
  `).join('');
}

let usersDrawerPermOpen = false;

function renderUsersDrawerPermPreview() {
  const role = $('#user-role')?.value || 'BACK_OFFICE';
  const el = $('#users-drawer-perm-preview');
  if (!el) return;
  const cards = permCountsForRole(role);
  const enabled = cards.reduce((sum, c) => sum + c.enabled, 0);
  const total = cards.reduce((sum, c) => sum + c.total, 0) || 1;
  const summaryKey = `users.permSummary.${role}`;
  const summary = t(summaryKey);
  const summaryText = summary === summaryKey ? t('users.permPreviewHint') : summary;
  el.classList.toggle('is-open', usersDrawerPermOpen);
  el.innerHTML = `
    <button type="button" class="users-drawer-perm-summary" data-users-perm-toggle aria-expanded="${usersDrawerPermOpen ? 'true' : 'false'}">
      <span class="users-drawer-perm-summary-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      </span>
      <span class="users-drawer-perm-summary-copy">
        <strong>${esc(t('users.permPreviewTitleShort'))}</strong>
        <small>${esc(summaryText)}</small>
      </span>
      <span class="users-drawer-perm-summary-count">${esc(t('users.permPreviewOf', { enabled, total }))}</span>
      <span class="users-drawer-perm-summary-chevron" aria-hidden="true"></span>
    </button>
    <div class="users-drawer-perm-list${usersDrawerPermOpen ? '' : ' is-collapsed'}">
      ${cards.map((c) => `
        <div class="users-drawer-perm-row">
          <span class="users-perm-card-icon is-${esc(c.tone)}" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${c.icon}</svg>
          </span>
          <span>${esc(t(c.labelKey))}</span>
          <strong>${c.enabled}/${c.total}</strong>
        </div>
      `).join('')}
    </div>
  `;
  el.querySelector('[data-users-perm-toggle]')?.addEventListener('click', () => {
    usersDrawerPermOpen = !usersDrawerPermOpen;
    renderUsersDrawerPermPreview();
  });
}

function renderUsersKpis(users) {
  const el = $('#users-kpis');
  if (!el) return;
  const total = users.length;
  const supers = users.filter((u) => u.role === 'SUPER_ADMIN').length;
  const admins = users.filter((u) => u.role === 'ADMIN').length;
  const backOffice = users.filter((u) => u.role === 'BACK_OFFICE').length;
  const cards = [
    {
      tone: 'blue',
      value: total,
      label: t('users.kpiTotal', { count: total }),
      sub: t('users.kpiTotalSub'),
      icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    },
    {
      tone: 'purple',
      value: supers,
      label: t('users.kpiSuper', { count: supers }),
      sub: t('users.kpiSuperSub'),
      icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    },
    {
      tone: 'orange',
      value: admins,
      label: t('users.kpiAdmin', { count: admins }),
      sub: t('users.kpiAdminSub'),
      icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    },
    {
      tone: 'teal',
      value: backOffice,
      label: t('users.kpiBackOffice', { count: backOffice }),
      sub: t('users.kpiBackOfficeSub'),
      icon: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    },
  ];
  el.innerHTML = cards.map((c) => `
    <article class="users-kpi">
      <span class="users-kpi-icon is-${esc(c.tone)}" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${c.icon}</svg>
      </span>
      <div class="users-kpi-body">
        <div class="users-kpi-value">${esc(String(c.value))} <span class="users-kpi-value-label">${esc(c.label)}</span></div>
        <div class="users-kpi-sub">${esc(c.sub)}</div>
      </div>
    </article>
  `).join('');
}

function filterUsersList(users) {
  const s = tableState.users;
  const q = String(s.search || '').trim().toLowerCase();
  return users.filter((u) => {
    if (s.role && s.role !== 'all' && u.role !== s.role) return false;
    if (s.status === 'active' && !u.isActive) return false;
    if (s.status === 'inactive' && u.isActive) return false;
    if (!q) return true;
    const hay = [u.email, u.role, userDisplayName(u), formatRoleLabel(u.role)].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function renderUsersMobile(items) {
  const root = $('#users-mobile-list');
  if (!root) return;
  if (!items.length) {
    root.innerHTML = `<div class="users-mobile-empty">${esc(t('users.none'))}</div>`;
    return;
  }
  root.innerHTML = items.map((u) => {
    const tone = userRoleTone(u.role);
    const selected = editingUserId === u.id;
    return `
      <article class="users-mobile-card${selected ? ' is-selected' : ''}${u.isActive ? '' : ' is-inactive'}" data-user-id="${esc(u.id)}">
        <div class="users-mobile-card-top">
          <span class="users-avatar is-${esc(tone)}" aria-hidden="true">${esc(userInitials(u))}</span>
          <div class="users-mobile-card-identity">
            <strong>${esc(userDisplayName(u))}</strong>
            <span>${esc(u.email)}</span>
            <div class="users-mobile-card-badges">
              <span class="users-role-pill is-${esc(tone)}">${esc(formatRoleLabel(u.role))}</span>
              <span class="users-status ${u.isActive ? 'is-active' : 'is-inactive'}">
                <span class="users-status-dot" aria-hidden="true"></span>
                ${esc(u.isActive ? t('users.active') : t('users.inactive'))}
              </span>
            </div>
          </div>
          <div class="users-actions-wrap users-mobile-actions">
            <button type="button" class="users-menu-btn" data-user-edit="${esc(u.id)}" aria-label="${esc(t('users.editUser'))}">⋯</button>
          </div>
        </div>
        <div class="users-mobile-card-meta">
          <span>${esc(t('users.createdOn', { date: formatUserShortDate(u.createdAt) }))}</span>
          <span>${esc(t('users.lastActiveOn', { date: formatUserLastActive(u.updatedAt) }))}</span>
        </div>
      </article>`;
  }).join('');
  bindUserRowClicks(root);
}

function renderUsersTable() {
  const filtered = filterUsersList(cachedUsers);
  const s = tableState.users;
  const sorted = [...filtered];
  if (s.sortBy) {
    const dir = s.sortDir === 'asc' ? 1 : -1;
    sorted.sort((a, b) => {
      const av = a?.[s.sortBy];
      const bv = b?.[s.sortBy];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      if (typeof av === 'boolean' && typeof bv === 'boolean') return ((av === bv) ? 0 : av ? 1 : -1) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  }
  const pageSize = s.pageSize || 10;
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
  if (s.page > totalPages) s.page = totalPages;
  if (s.page < 1) s.page = 1;
  const start = (s.page - 1) * pageSize;
  const items = sorted.slice(start, start + pageSize);
  const pageData = { items, total, page: s.page, pageSize, totalPages, maxTotal: total };

  const rows = items.map((u) => {
    const tone = userRoleTone(u.role);
    const canEdit = true;
    return `
      <tr data-user-id="${esc(u.id)}" class="${editingUserId === u.id ? 'selected' : ''}">
        <td class="users-col-user">
          <div class="users-person">
            <span class="users-avatar is-${esc(tone)}" aria-hidden="true">${esc(userInitials(u))}</span>
            <span class="users-person-meta">
              <strong>${esc(userDisplayName(u))}</strong>
              <span>${esc(formatRoleLabel(u.role))}</span>
            </span>
          </div>
        </td>
        <td class="users-col-email">${esc(u.email)}</td>
        <td><span class="users-role-pill is-${esc(tone)}">${esc(formatRoleLabel(u.role))}</span></td>
        <td>
          <span class="users-status ${u.isActive ? 'is-active' : 'is-inactive'}">
            <span class="users-status-dot" aria-hidden="true"></span>
            ${esc(u.isActive ? t('users.active') : t('users.inactive'))}
          </span>
        </td>
        <td class="users-col-date">${esc(formatUserShortDate(u.createdAt))}</td>
        <td class="users-col-date">${esc(formatUserLastActive(u.updatedAt))}</td>
        <td class="users-col-actions">
          <div class="users-actions-wrap">
            <button type="button" class="users-menu-btn" data-user-menu="${esc(u.id)}" aria-label="${esc(t('users.actions'))}">⋯</button>
            <div id="users-menu-${esc(u.id)}" class="users-row-menu hidden">
              ${canEdit
                ? `<button type="button" data-user-edit="${esc(u.id)}">${esc(t('users.editUser'))}</button>`
                : `<span class="users-menu-locked">${esc(t('users.superLocked'))}</span>`}
            </div>
          </div>
        </td>
      </tr>`;
  }).join('');

  const tableEl = $('#users-table');
  if (tableEl) {
    tableEl.innerHTML = `
      <table class="users-data-table">
        <thead><tr>
          <th>${t('users.col.user')}</th>
          <th>${t('users.col.email')}</th>
          <th>${t('users.col.role')}</th>
          <th>${t('users.col.status')}</th>
          <th>${t('users.col.created')}</th>
          <th>${t('users.col.lastActive')}</th>
          <th>${t('users.actions')}</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="7" class="empty-row">${esc(t('users.none'))}</td></tr>`}</tbody>
      </table>`;
  }
  renderUsersMobile(items);
  syncUsersFilterChips();
renderTableInfo('#users-info', pageData, pageData.maxTotal);
  renderPagination('#users-pagination', pageData, 'users', () => renderUsersTable());
  bindUserRowClicks($('#users-table') || document);
  scheduleEnhanceResponsiveTables();
}

let cachedUsers = [];


function bindUsersUi() {
  if (usersUiBound) return;
  usersUiBound = true;
$$('.users-tab').forEach((btn) => {
    btn.addEventListener('click', () => setUsersView(btn.dataset.usersTab));
  });
  $('#users-open-perms-btn')?.addEventListener('click', () => setUsersView('perms'));

  const syncFilters = () => {
    tableState.users.search = $('#users-search')?.value || '';
    tableState.users.role = $('#users-filter-role')?.value || 'all';
    tableState.users.status = $('#users-filter-status')?.value || 'all';
    tableState.users.page = 1;
    renderUsersTable();
  };
  $('#users-search')?.addEventListener('input', () => {
    clearTimeout(searchTimers.users);
    searchTimers.users = setTimeout(syncFilters, 220);
  });
  $('#users-filter-role')?.addEventListener('change', syncFilters);
  $('#users-filter-status')?.addEventListener('change', syncFilters);
  $('#users-clear-filters-btn')?.addEventListener('click', () => {
    if ($('#users-search')) $('#users-search').value = '';
    if ($('#users-filter-role')) $('#users-filter-role').value = 'all';
    if ($('#users-filter-status')) $('#users-filter-status').value = 'all';
    syncFilters();
  });

  $$('[data-users-mobile-filter]').forEach((btn) => {
    btn.addEventListener('click', () => openUsersFilterSheet(btn.dataset.usersMobileFilter));
  });
  $$('[data-users-filter-close]').forEach((el) => {
    el.addEventListener('click', () => closeUsersFilterSheet());
  });

  $('#users-preview-role')?.addEventListener('change', () => {
    renderPermPreviewCards('#users-perm-preview-cards', $('#users-preview-role').value);
  });
  $('#user-role')?.addEventListener('change', renderUsersDrawerPermPreview);

  $$('[data-users-drawer-close]').forEach((el) => {
    el.addEventListener('click', () => closeUsersDrawer());
  });

  $('#user-password-generate')?.addEventListener('click', () => {
    const input = $('#user-password');
    if (!input) return;
    input.type = 'text';
    input.value = generateTempPassword();
    updateUserPasswordWarning();
  });
  $('#user-password-toggle')?.addEventListener('click', () => {
    const input = $('#user-password');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.users-actions-wrap')) {
      $$('.users-row-menu').forEach((el) => el.classList.add('hidden'));
    }
  });
}

const USERS_SECURITY_STATE = {
  page: 1,
  pageSize: 10,
  search: '',
  event: 'all',
  status: 'all',
  dateRange: '7',
};
let usersSecurityUiBound = false;
let usersSecurityPageResult = { items: [], total: 0, page: 1, pageSize: 10, totalPages: 1 };
let usersSecurityMobileItems = [];
let usersSecurityMobileLoading = false;
let permDraft = new Set();
let permSavedSnapshot = new Set();
let permUiBound = false;
let permSearchQuery = '';
let permSectionFilter = 'all';
let permAccordionOpen = { pages: true, features: false, sensitive: false };
let permSectionExpanded = { pages: false, features: false, sensitive: false };
const PERM_MOBILE_PREVIEW_COUNT = 8;

const PERM_SENSITIVE_KEYS = new Set([
  'LOG_SETTINGS_EDIT',
  'SYNC_RUN',
  'SYNC_SETTINGS_EDIT',
  'WEBHOOKS_MANAGE',
  'ROLE_PERMISSIONS_MANAGE',
]);

const PERM_ROLE_DEFAULTS = {
  BACK_OFFICE: [
    'DASHBOARD_VIEW',
    'RESERVATIONS_VIEW',
    'RESERVATIONS_VIEW_PII',
    'CONVERSATIONS_VIEW',
    'CONVERSATIONS_MANAGE',
    'PAYMENTS_VIEW',
    'PAYMENTS_REVIEW',
  ],
  ADMIN: null, // filled from catalog minus USERS_MANAGE / ROLE_PERMISSIONS_MANAGE
};

const PERM_ROW_ICONS = {
  DASHBOARD_VIEW: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  LISTINGS_VIEW: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  LISTINGS_EDIT: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  GROUPS_VIEW: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  RESERVATIONS_VIEW: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  RESERVATIONS_VIEW_PII: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  CONVERSATIONS_VIEW: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  CONVERSATIONS_MANAGE: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h8M8 14h5"/>',
  RULES_VIEW: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  RULES_EDIT: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  RULES_DELETE: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  REQUESTS_VIEW: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  PAYMENTS_VIEW: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  PAYMENTS_REVIEW: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  PAYMENTS_ADMIN: '<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
  USERS_MANAGE: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  ROLE_PERMISSIONS_MANAGE: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  LOGS_VIEW: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/>',
  LOG_SETTINGS_EDIT: '<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
  SYNC_RUN: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  SYNC_SETTINGS_EDIT: '<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
  WEBHOOKS_MANAGE: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
};

function permRowIcon(key) {
  const path = PERM_ROW_ICONS[key] || '<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2"/>';
  return `<span class="users-perm-row-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${path}</svg></span>`;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function defaultPermsForRole(role) {
  if (role === 'BACK_OFFICE') return [...PERM_ROLE_DEFAULTS.BACK_OFFICE];
  const catalog = cachedPermMatrix?.catalog || [];
  return catalog
    .map((item) => item.key)
    .filter((key) => key !== 'USERS_MANAGE' && key !== 'ROLE_PERMISSIONS_MANAGE');
}

function permDesc(key) {
  const descKey = `perm.desc.${key}`;
  const text = t(descKey);
  return text === descKey ? '' : text;
}

function formatSecurityEventTitle(log) {
  const action = String(log?.action || '');
  if (action === 'login_success') return t('users.securityEventLoginSuccess');
  if (action === 'login_failed') return t('users.securityEventLoginFailed');
  if (action.startsWith('GET ') || action.startsWith('POST ') || action.startsWith('PUT ') || action.startsWith('PATCH ') || action.startsWith('DELETE ')) {
    const method = action.split(' ')[0];
    const path = action.slice(method.length).trim();
    if (path.includes('/sync/conversations')) return t('users.securityEventSyncConversations');
    if (path.includes('/sync/settings')) return t('users.securityEventUpdateSyncSettings');
    if (path.includes('/role-permissions')) return t('users.securityEventUpdatePermissions');
    if (path.includes('/users')) return t('users.securityEventUpdateUser');
    return action.replace(/^([A-Z]+)\s+\/api\/v1\/admin\//, '$1 ');
  }
  return action || '–';
}

function formatSecurityActor(log) {
  const meta = log?.metadata || {};
  const adminId = meta.adminId ? String(meta.adminId) : '';
  const roleRaw = meta.role ? String(meta.role) : '';
  if (adminId) {
    const user = cachedUsers.find((u) => u.id === adminId);
    if (user) {
      return {
        name: userDisplayName(user) || formatRoleLabel(user.role),
        sub: `${user.role || roleRaw || 'ADMIN'} · ${adminId.slice(0, 8)}…`,
        role: user.role || roleRaw,
        initials: userInitials(user),
        tone: userRoleTone(user.role),
      };
    }
    const role = roleRaw ? formatRoleLabel(roleRaw) : t('role.SUPER_ADMIN');
    return {
      name: role,
      sub: `${roleRaw || 'SUPER_ADMIN'} · ${adminId.slice(0, 8)}…`,
      role: roleRaw || 'SUPER_ADMIN',
      initials: (role || 'AD').slice(0, 2).toUpperCase(),
      tone: userRoleTone(roleRaw) || 'super',
    };
  }
  if (meta.emailHash) {
    return {
      name: t('users.securityUnknownActor'),
      sub: String(meta.emailHash),
      role: '',
      initials: '?',
      tone: 'default',
    };
  }
  return {
    name: '–',
    sub: '',
    role: '',
    initials: '?',
    tone: 'default',
  };
}

function formatSecurityEndpoint(log) {
  if (log?.method && log?.path) return `${log.method} ${log.path}`;
  const action = String(log?.action || '');
  if (/^(GET|POST|PUT|PATCH|DELETE)\s+\//.test(action)) return action;
  return '—';
}

function formatSecurityStatus(log) {
  const action = String(log?.action || '');
  if (action === 'login_success') {
    return { label: t('users.securityStatusSuccessful'), tone: 'ok' };
  }
  if (action === 'login_failed') {
    return { label: t('users.securityStatusFailed'), tone: 'err' };
  }
  return {
    label: httpStatusLabel(log?.statusCode),
    tone: httpStatusTone(log?.statusCode),
  };
}

function securityDateFrom() {
  const range = USERS_SECURITY_STATE.dateRange;
  if (range === 'all') return '';
  const days = Number(range) || 7;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (days > 1) d.setDate(d.getDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

function syncPermFooter() {
  const enabled = permDraft.size;
  const dirty = !setsEqual(permDraft, permSavedSnapshot);
  const role = $('#perm-role-select')?.value || 'BACK_OFFICE';
  const defaults = new Set(defaultPermsForRole(role));
  const isCustom = !setsEqual(permDraft, defaults);

  const countEl = $('#perm-enabled-count');
  if (countEl) countEl.textContent = t('perms.enabledCount', { count: enabled });

  const dirtyEl = $('#perm-dirty-status');
  if (dirtyEl) {
    dirtyEl.classList.toggle('is-clean', !dirty);
    dirtyEl.classList.toggle('is-dirty', dirty);
    dirtyEl.innerHTML = dirty
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg><span>${esc(t('perms.unsaved'))}</span>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg><span>${esc(t('perms.noUnsaved'))}</span>`;
  }

  const discardBtn = $('#perm-discard-btn');
  const saveBtn = $('#perm-save-btn');
  if (discardBtn) discardBtn.disabled = !dirty;
  if (saveBtn) {
    saveBtn.disabled = !dirty;
    saveBtn.textContent = isUsersMobileLayout() ? t('perms.saveShort') : t('perms.save');
  }

  const badge = $('#perm-access-badge');
  if (badge) badge.hidden = !isCustom;

  const mobileRole = $('#perm-mobile-role-name');
  if (mobileRole) mobileRole.textContent = formatRoleLabel(role);
  const mobileAccess = $('#perm-mobile-access-label');
  if (mobileAccess) {
    mobileAccess.textContent = isCustom ? t('perms.customAccess') : t('perms.defaultAccess');
    mobileAccess.classList.toggle('is-custom', isCustom);
  }
  const mobileEnabled = $('#perm-mobile-enabled');
  if (mobileEnabled) mobileEnabled.textContent = t('perms.enabledShort', { count: enabled });

  const filterBtn = $('#perm-filter-btn');
  if (filterBtn) filterBtn.classList.toggle('is-active', permSectionFilter !== 'all');
}

function matchesPermSearch(item) {
  const q = permSearchQuery.trim().toLowerCase();
  if (!q) return true;
  const label = String(t(item.labelKey) || item.key).toLowerCase();
  const desc = String(permDesc(item.key) || '').toLowerCase();
  return label.includes(q) || desc.includes(q) || String(item.key).toLowerCase().includes(q);
}

function filterPermItems(items, section) {
  return items.filter((item) => {
    if (!matchesPermSearch(item)) return false;
    if (permSectionFilter === 'pages' && section !== 'pages') return false;
    if (permSectionFilter === 'features' && section !== 'features') return false;
    if (permSectionFilter === 'sensitive' && section !== 'sensitive') return false;
    if (permSectionFilter === 'enabled' && !permDraft.has(item.key)) return false;
    if (permSectionFilter === 'disabled' && permDraft.has(item.key)) return false;
    return true;
  });
}

function renderPermToggleRow(item, { withIcon = false } = {}) {
  const on = permDraft.has(item.key);
  const desc = permDesc(item.key);
  return `
    <label class="users-perm-row">
      ${withIcon ? permRowIcon(item.key) : ''}
      <span class="users-perm-row-copy">
        <strong>${esc(t(item.labelKey) || item.key)}</strong>
        ${desc ? `<span>${esc(desc)}</span>` : ''}
      </span>
      <span class="users-switch">
        <input type="checkbox" data-perm-key="${esc(item.key)}" ${on ? 'checked' : ''} />
        <span class="users-switch-ui" aria-hidden="true"></span>
      </span>
    </label>
  `;
}

function bindPermToggleInputs(root) {
  root.querySelectorAll('input[data-perm-key]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.permKey;
      if (input.checked) permDraft.add(key);
      else permDraft.delete(key);
      renderRolePermissionCheckboxes();
    });
  });
}

function renderPermMobileAccordion(sections) {
  const mobile = isUsersMobileLayout();
  return sections.map((section) => {
    const open = !!permAccordionOpen[section.id];
    const filtered = filterPermItems(section.items, section.id);
    const onCount = section.items.filter((item) => permDraft.has(item.key)).length;
    const expanded = !!permSectionExpanded[section.id];
    const preview = mobile && !expanded && filtered.length > PERM_MOBILE_PREVIEW_COUNT
      ? filtered.slice(0, PERM_MOBILE_PREVIEW_COUNT)
      : filtered;
    const hiddenCount = Math.max(0, filtered.length - preview.length);
    const countLabel = section.id === 'sensitive'
      ? `${onCount} ${t('perms.enabled')}`
      : `${onCount} ${t('perms.of')} ${section.items.length} ${t('perms.enabled')}`;
    return `
      <section class="users-perms-accordion${section.sensitive ? ' is-sensitive' : ''}${open ? ' is-open' : ''}" data-perm-section="${esc(section.id)}">
        <button type="button" class="users-perms-accordion-head" data-perm-accordion="${esc(section.id)}" aria-expanded="${open ? 'true' : 'false'}">
          <span class="users-perms-accordion-title">
            <span class="users-perms-column-icon ${esc(section.iconClass)}" aria-hidden="true">${section.iconSvg}</span>
            <span>
              <strong>${esc(section.title)}</strong>
              <small>${esc(countLabel)}</small>
            </span>
          </span>
          <span class="users-perms-accordion-chevron" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
          </span>
        </button>
        <div class="users-perms-accordion-body"${open ? '' : ' hidden'}>
          <div class="users-perms-rows">
            ${preview.map((item) => renderPermToggleRow(item, { withIcon: mobile })).join('') || `<div class="users-perms-empty">${esc(t('perms.noMatches'))}</div>`}
          </div>
          ${hiddenCount > 0 ? `<button type="button" class="users-perms-show-more" data-perm-show-more="${esc(section.id)}">${esc(t('perms.showMore', { count: hiddenCount }))}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>` : ''}
        </div>
      </section>
    `;
  }).join('');
}

function renderRolePermissionCheckboxes() {
  const wrap = $('#perm-checkboxes');
  const role = $('#perm-role-select')?.value || 'BACK_OFFICE';
  if (!wrap || !cachedPermMatrix) return;
  const catalog = cachedPermMatrix.catalog || [];
  const pages = catalog.filter((item) => item.group === 'pages');
  const actions = catalog.filter((item) => item.group === 'actions');
  const general = actions.filter((item) => !PERM_SENSITIVE_KEYS.has(item.key));
  const sensitive = actions.filter((item) => PERM_SENSITIVE_KEYS.has(item.key));
  const pagesOn = pages.filter((item) => permDraft.has(item.key)).length;
  const actionsOn = actions.filter((item) => permDraft.has(item.key)).length;
  const mobile = isUsersMobileLayout();

  const sections = [
    {
      id: 'pages',
      title: t('perms.pages'),
      items: pages,
      iconClass: 'is-pages',
      iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>',
    },
    {
      id: 'features',
      title: t('perms.actions'),
      items: general,
      iconClass: 'is-features',
      iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>',
    },
    {
      id: 'sensitive',
      title: t('perms.sensitiveAccess'),
      items: sensitive,
      sensitive: true,
      iconClass: 'is-sensitive',
      iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    },
  ];

  if (mobile) {
    wrap.className = 'users-perms-mobile-sections';
    wrap.innerHTML = renderPermMobileAccordion(sections);
    wrap.querySelectorAll('[data-perm-accordion]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.permAccordion;
        permAccordionOpen[id] = !permAccordionOpen[id];
        renderRolePermissionCheckboxes();
      });
    });
    wrap.querySelectorAll('[data-perm-show-more]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.permShowMore;
        permSectionExpanded[id] = true;
        renderRolePermissionCheckboxes();
      });
    });
    bindPermToggleInputs(wrap);
    syncPermFooter();
    return;
  }

  wrap.className = 'users-perms-columns';
  wrap.innerHTML = `
    <section class="users-perms-column">
      <header class="users-perms-column-head">
        <div>
          <div class="users-perms-column-title">
            <span class="users-perms-column-icon is-pages" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>
            </span>
            <h4 data-i18n="perms.pages">${esc(t('perms.pages'))}</h4>
          </div>
          <p>${esc(t('perms.pagesHint'))}</p>
        </div>
        <span class="users-perms-column-count">${pagesOn} ${esc(t('perms.of'))} ${pages.length} ${esc(t('perms.enabled'))}</span>
      </header>
      <div class="users-perms-rows">${pages.map((item) => renderPermToggleRow(item)).join('')}</div>
    </section>
    <section class="users-perms-column">
      <header class="users-perms-column-head">
        <div>
          <div class="users-perms-column-title">
            <span class="users-perms-column-icon is-features" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>
            </span>
            <h4>${esc(t('perms.actions'))}</h4>
          </div>
          <p>${esc(t('perms.actionsHint'))}</p>
        </div>
        <span class="users-perms-column-count">${actionsOn} ${esc(t('perms.of'))} ${actions.length} ${esc(t('perms.enabled'))}</span>
      </header>
      <div class="users-perms-rows">
        <div class="users-perms-subhead">${esc(t('perms.generalFeatures'))}</div>
        ${general.map((item) => renderPermToggleRow(item)).join('')}
        <div class="users-perms-subhead is-sensitive">
          <span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            ${esc(t('perms.sensitiveAccess'))}
          </span>
          <em>${esc(t('perms.sensitiveHint'))}</em>
        </div>
        ${sensitive.map((item) => renderPermToggleRow(item)).join('')}
      </div>
    </section>
  `;

  bindPermToggleInputs(wrap);
  syncPermFooter();
}

function closePermsFilterSheet() {
  const sheet = $('#perms-filter-sheet');
  if (!sheet) return;
  sheet.classList.add('hidden');
  sheet.hidden = true;
  document.body.classList.remove('users-filter-open');
}

function openPermsFilterSheet() {
  const sheet = $('#perms-filter-sheet');
  const body = $('#perms-filter-sheet-body');
  if (!sheet || !body) return;
  const options = [
    { value: 'all', label: t('perms.filterAll') },
    { value: 'pages', label: t('perms.pages') },
    { value: 'features', label: t('perms.actions') },
    { value: 'sensitive', label: t('perms.sensitiveAccess') },
    { value: 'enabled', label: t('perms.filterEnabled') },
    { value: 'disabled', label: t('perms.filterDisabled') },
  ];
  body.innerHTML = options.map((opt) => `
    <button type="button" class="users-filter-option${opt.value === permSectionFilter ? ' is-selected' : ''}" data-perm-filter-value="${esc(opt.value)}">
      ${esc(opt.label)}
    </button>
  `).join('');
  body.querySelectorAll('[data-perm-filter-value]').forEach((btn) => {
    btn.addEventListener('click', () => {
      permSectionFilter = btn.dataset.permFilterValue || 'all';
      if (permSectionFilter === 'pages') permAccordionOpen = { pages: true, features: false, sensitive: false };
      if (permSectionFilter === 'features') permAccordionOpen = { pages: false, features: true, sensitive: false };
      if (permSectionFilter === 'sensitive') permAccordionOpen = { pages: false, features: false, sensitive: true };
      closePermsFilterSheet();
      renderRolePermissionCheckboxes();
    });
  });
  sheet.classList.remove('hidden');
  sheet.hidden = false;
  document.body.classList.add('users-filter-open');
}

function loadPermDraftFromRole(role, { resetToDefaults = false } = {}) {
  const source = resetToDefaults
    ? defaultPermsForRole(role)
    : (cachedPermMatrix?.matrix?.[role] || []);
  permDraft = new Set(source);
  if (!resetToDefaults) permSavedSnapshot = new Set(source);
}

function bindPermUi() {
  if (permUiBound) return;
  permUiBound = true;
  $('#perm-role-select')?.addEventListener('change', () => {
    const role = $('#perm-role-select')?.value || 'BACK_OFFICE';
    loadPermDraftFromRole(role);
    renderRolePermissionCheckboxes();
  });
  $('#perm-discard-btn')?.addEventListener('click', () => {
    permDraft = new Set(permSavedSnapshot);
    renderRolePermissionCheckboxes();
  });
  $('#perm-reset-btn')?.addEventListener('click', async () => {
    const role = $('#perm-role-select')?.value || 'BACK_OFFICE';
    const ok = await notify.confirm(t('perms.resetConfirm'), {
      title: t('perms.reset'),
      okLabel: t('perms.reset'),
    });
    if (!ok) return;
    loadPermDraftFromRole(role, { resetToDefaults: true });
    renderRolePermissionCheckboxes();
  });
  $('#perm-copy-btn')?.addEventListener('click', async () => {
    const role = $('#perm-role-select')?.value || 'BACK_OFFICE';
    const other = role === 'ADMIN' ? 'BACK_OFFICE' : 'ADMIN';
    const ok = await notify.confirm(t('perms.copyConfirm', { role: formatRoleLabel(other) }), {
      title: t('perms.copyRole'),
      okLabel: t('perms.copyRole'),
    });
    if (!ok) return;
    permDraft = new Set(cachedPermMatrix?.matrix?.[other] || []);
    renderRolePermissionCheckboxes();
  });
  $('#perm-save-btn')?.addEventListener('click', async () => {
    const role = $('#perm-role-select')?.value;
    if (!role) return;
    try {
      await api('/role-permissions', {
        method: 'PUT',
        body: JSON.stringify({ role, permissions: [...permDraft] }),
      });
      notify.success(t('perms.saved'));
      await loadRolePermissionsMatrix();
    } catch (ex) {
      notify.error(ex.message);
    }
  });
  let permSearchTimer = null;
  $('#perm-search')?.addEventListener('input', (e) => {
    clearTimeout(permSearchTimer);
    permSearchTimer = setTimeout(() => {
      permSearchQuery = e.target.value || '';
      renderRolePermissionCheckboxes();
    }, 180);
  });
  $('#perm-filter-btn')?.addEventListener('click', openPermsFilterSheet);
  document.querySelectorAll('[data-perms-filter-close]').forEach((el) => {
    el.addEventListener('click', closePermsFilterSheet);
  });
  window.addEventListener('resize', () => {
    if (usersActiveView === 'perms' && cachedPermMatrix) renderRolePermissionCheckboxes();
  });
}

async function loadUsersSecurityActivity({ silent = false, append = false } = {}) {
  const tableEl = $('#users-security-table');
  if (!tableEl) return;
  bindUsersSecurityUi();
if (!append) {
    USERS_SECURITY_STATE.page = tableState.usersSecurity.page || USERS_SECURITY_STATE.page;
  }
  USERS_SECURITY_STATE.pageSize = tableState.usersSecurity.pageSize || USERS_SECURITY_STATE.pageSize;
  const s = USERS_SECURITY_STATE;
  const params = new URLSearchParams();
  params.set('page', String(s.page));
  params.set('pageSize', String(s.pageSize));
  params.set('source', 'admin');
  params.set('sortBy', 'createdAt');
  params.set('sortDir', 'desc');
  if (s.search) params.set('search', s.search);
  if (s.status !== 'all') params.set('status', s.status);
  if (s.event === 'login_success' || s.event === 'login_failed') params.set('action', s.event);
  const dateFrom = securityDateFrom();
  if (dateFrom) params.set('dateFrom', dateFrom);
  try {
    const data = await api(`/logs?${params.toString()}`);
    let items = Array.isArray(data?.items) ? data.items : [];
    const total = Number(data?.total || items.length);
    if (s.event === 'mutations') {
      items = items.filter((l) => !['login_success', 'login_failed'].includes(l.action));
    }
    if (append && isUsersMobileLayout()) {
      const seen = new Set(usersSecurityMobileItems.map((l) => String(l.id)));
      usersSecurityMobileItems = [
        ...usersSecurityMobileItems,
        ...items.filter((l) => !seen.has(String(l.id))),
      ];
    } else {
      usersSecurityMobileItems = items;
    }
    usersSecurityCache = isUsersMobileLayout() ? usersSecurityMobileItems : items;
    usersSecurityPageResult = {
      items: isUsersMobileLayout() ? usersSecurityMobileItems : items,
      total,
      page: Number(data?.page || s.page),
      pageSize: Number(data?.pageSize || s.pageSize),
      totalPages: Number(data?.totalPages || Math.max(1, Math.ceil(total / s.pageSize))),
      maxTotal: total,
    };
    tableState.usersSecurity.page = usersSecurityPageResult.page;
    tableState.usersSecurity.pageSize = usersSecurityPageResult.pageSize;
    renderUsersSecurityTable();
    refreshUsersSecurityKpiCache();
  } catch (ex) {
    if (!silent) notify.error(ex.message);
    tableEl.innerHTML = `<p class="field-hint">${esc(ex.message)}</p>`;
    const mobileList = $('#users-security-mobile-list');
    if (mobileList) mobileList.innerHTML = `<div class="users-security-mobile-empty">${esc(ex.message)}</div>`;
  } finally {
    usersSecurityMobileLoading = false;
    syncUsersSecurityLoadMore();
  }
}

function renderUsersSecurityKpiCards(pool) {
  const el = $('#users-security-kpis');
  if (!el) return;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todays = (pool || []).filter((l) => new Date(l.createdAt) >= today);
  const successful = todays.filter((l) => {
    const code = Number(l.statusCode);
    return l.action === 'login_success' || (code >= 200 && code < 300);
  }).length;
  const failed = todays.filter((l) => l.action === 'login_failed' || Number(l.statusCode) >= 400).length;
  const last = todays[0]?.createdAt
    ? new Date(todays[0].createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : '–';
  const mobile = isUsersMobileLayout();
  el.innerHTML = [
    { tone: 'blue', value: String(todays.length), label: mobile ? t('users.securityKpiTodayShort') : t('users.securityKpiToday'), icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>' },
    { tone: 'green', value: String(successful), label: mobile ? t('users.securityKpiSuccessfulShort') : t('users.securityKpiSuccessful'), icon: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>' },
    { tone: 'red', value: String(failed), label: mobile ? t('users.securityKpiFailedShort') : t('users.securityKpiFailed'), icon: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>' },
    { tone: 'blue', value: last, label: mobile ? t('users.securityKpiLastShort') : t('users.securityKpiLast'), icon: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>' },
  ].map((c) => `
    <article class="users-security-kpi">
      <span class="users-security-kpi-icon is-${esc(c.tone)}" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${c.icon}</svg>
      </span>
      <div>
        <div class="users-security-kpi-value">${esc(c.value)}</div>
        <div class="users-security-kpi-label">${esc(c.label)}</div>
      </div>
    </article>
  `).join('');
}

let usersSecurityKpiCache = [];
let usersSecurityKpiLoading = false;

async function refreshUsersSecurityKpiCache() {
  if (usersSecurityKpiLoading) return;
  usersSecurityKpiLoading = true;
  try {
    const dateFrom = new Date().toISOString().slice(0, 10);
    const data = await api(`/logs?page=1&pageSize=100&source=admin&dateFrom=${dateFrom}&sortBy=createdAt&sortDir=desc`);
    usersSecurityKpiCache = Array.isArray(data?.items) ? data.items : [];
    if (usersActiveView === 'security') renderUsersSecurityKpiCards(usersSecurityKpiCache);
  } catch {
    renderUsersSecurityKpiCards(usersSecurityCache);
  } finally {
    usersSecurityKpiLoading = false;
  }
}

function syncUsersSecurityLoadMore() {
  const btn = $('#users-security-load-more');
  if (!btn) return;
  const total = Number(usersSecurityPageResult?.total || 0);
  const loaded = usersSecurityMobileItems.length;
  const hasMore = isUsersMobileLayout() && loaded < total;
  btn.hidden = !hasMore;
  btn.disabled = usersSecurityMobileLoading;
  btn.textContent = usersSecurityMobileLoading ? t('users.securityLoading') : t('users.securityLoadMore');
}

function syncUsersSecurityFiltersBtn() {
  const btn = $('#users-security-filters-btn');
  if (!btn) return;
  const active = USERS_SECURITY_STATE.event !== 'all' || USERS_SECURITY_STATE.status !== 'all';
  btn.classList.toggle('is-active', active);
}

function renderUsersSecurityMobileCards(items) {
  const root = $('#users-security-mobile-list');
  if (!root) return;
  if (!isUsersMobileLayout()) {
    root.innerHTML = '';
    const btn = $('#users-security-load-more');
    if (btn) btn.hidden = true;
    return;
  }
  if (!items.length) {
    root.innerHTML = `<div class="users-security-mobile-empty">${esc(t('users.securityEmpty'))}</div>`;
    syncUsersSecurityLoadMore();
    return;
  }
  root.innerHTML = items.map((l) => {
    const actor = formatSecurityActor(l);
    const status = formatSecurityStatus(l);
    const endpoint = formatSecurityEndpoint(l);
    const eventTone = l.action === 'login_success' || l.action === 'login_failed' ? 'login' : 'system';
    const time = formatAuditDateTime(l.createdAt).replace(',', ' ·');
    const showEndpoint = endpoint && endpoint !== '—' && !String(l.action || '').startsWith('login_');
    return `
      <article class="users-security-mobile-card" data-security-id="${esc(String(l.id))}">
        <div class="users-security-mobile-card-top">
          <span class="users-security-event-icon is-${eventTone}" aria-hidden="true">
            ${eventTone === 'login'
              ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
              : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>'}
          </span>
          <div class="users-security-mobile-card-title">
            <strong>${esc(formatSecurityEventTitle(l))}</strong>
            <time>${esc(time)}</time>
          </div>
          <span class="users-security-status-pill is-${esc(status.tone)}">${esc(status.label)}</span>
          <span class="users-security-mobile-chevron" aria-hidden="true">›</span>
        </div>
        <div class="users-security-mobile-actor">
          <span class="users-avatar is-${esc(actor.tone)}" aria-hidden="true">${esc(actor.initials)}</span>
          <span class="users-security-mobile-actor-meta">
            <strong>${esc(actor.name)}</strong>
            ${actor.sub ? `<small>${esc(actor.sub)}</small>` : ''}
          </span>
        </div>
        ${showEndpoint ? `<code class="users-security-mobile-endpoint">${esc(endpoint)}</code>` : ''}
      </article>`;
  }).join('');
  syncUsersSecurityLoadMore();
}

function renderUsersSecurityTable() {
  const tableEl = $('#users-security-table');
  if (!tableEl) return;
  const items = usersSecurityPageResult.items || [];

  // Keep desktop table on current page only when mobile is accumulating
  const tableItems = isUsersMobileLayout()
    ? items.slice(Math.max(0, items.length - USERS_SECURITY_STATE.pageSize))
    : items;

  const rows = tableItems.map((l) => {
    const actor = formatSecurityActor(l);
    const status = formatSecurityStatus(l);
    const eventTone = l.action === 'login_success' || l.action === 'login_failed' ? 'login' : 'system';
    return `
      <tr data-security-id="${esc(String(l.id))}">
        <td class="users-security-col-time">${esc(formatAuditDateTime(l.createdAt).replace(',', ' ·'))}</td>
        <td class="users-security-col-event">
          <span class="users-security-event">
            <span class="users-security-event-icon is-${eventTone}" aria-hidden="true">
              ${eventTone === 'login'
                ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
                : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>'}
            </span>
            <span>${esc(formatSecurityEventTitle(l))}</span>
          </span>
        </td>
        <td class="users-security-col-actor">
          <div class="users-security-actor">
            <span class="users-avatar is-${esc(actor.tone)}" aria-hidden="true">${esc(actor.initials)}</span>
            <span class="users-security-actor-meta">
              <strong>${esc(actor.name)}</strong>
              ${actor.sub ? `<small>${esc(actor.sub)}</small>` : ''}
            </span>
          </div>
        </td>
        <td class="users-security-col-endpoint"><code>${esc(formatSecurityEndpoint(l))}</code></td>
        <td><span class="users-security-status-pill is-${esc(status.tone)}">${esc(status.label)}</span></td>
      </tr>`;
  }).join('');
  tableEl.innerHTML = `
    <table class="users-data-table users-security-data-table">
      <thead><tr>
        <th>${t('logs.time')}</th>
        <th>${t('users.securityColEvent')}</th>
        <th>${t('users.securityColActor')}</th>
        <th>${t('users.securityColEndpoint')}</th>
        <th>${t('users.col.status')}</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="empty-row">${esc(t('users.securityEmpty'))}</td></tr>`}</tbody>
    </table>`;
  renderUsersSecurityMobileCards(isUsersMobileLayout() ? items : []);
  renderTableInfo('#users-security-info', usersSecurityPageResult, usersSecurityPageResult.maxTotal);
  renderPagination('#users-security-pagination', usersSecurityPageResult, 'usersSecurity', () => {
    USERS_SECURITY_STATE.page = tableState.usersSecurity.page;
    loadUsersSecurityActivity({ silent: true });
  });
  syncUsersSecurityFiltersBtn();
  scheduleEnhanceResponsiveTables();
}

function closeUsersSecurityFilterSheet() {
  const sheet = $('#users-security-filter-sheet');
  if (!sheet) return;
  sheet.classList.add('hidden');
  sheet.hidden = true;
  document.body.classList.remove('users-filter-open');
}

function openUsersSecurityFilterSheet() {
  const sheet = $('#users-security-filter-sheet');
  const body = $('#users-security-filter-sheet-body');
  if (!sheet || !body) return;
  const eventSelect = $('#users-security-event-filter');
  const statusSelect = $('#users-security-status-filter');
  body.innerHTML = `
    <div class="users-security-filter-group">
      <h4>${esc(t('users.securityFilterEvent'))}</h4>
      ${[...eventSelect.options].map((opt) => `
        <button type="button" class="users-filter-option${opt.value === eventSelect.value ? ' is-selected' : ''}" data-security-filter-kind="event" data-security-filter-value="${esc(opt.value)}">
          ${esc(opt.textContent || opt.value)}
        </button>
      `).join('')}
    </div>
    <div class="users-security-filter-group">
      <h4>${esc(t('users.securityFilterStatus'))}</h4>
      ${[...statusSelect.options].map((opt) => `
        <button type="button" class="users-filter-option${opt.value === statusSelect.value ? ' is-selected' : ''}" data-security-filter-kind="status" data-security-filter-value="${esc(opt.value)}">
          ${esc(opt.textContent || opt.value)}
        </button>
      `).join('')}
    </div>
  `;
  body.querySelectorAll('[data-security-filter-value]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.securityFilterKind;
      const value = btn.dataset.securityFilterValue;
      if (kind === 'event' && eventSelect) {
        eventSelect.value = value;
        eventSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (kind === 'status' && statusSelect) {
        statusSelect.value = value;
        statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      closeUsersSecurityFilterSheet();
    });
  });
  sheet.classList.remove('hidden');
  sheet.hidden = false;
  document.body.classList.add('users-filter-open');
}


function bindUsersSecurityUi() {
  if (usersSecurityUiBound) return;
  usersSecurityUiBound = true;
  const sync = () => {
    USERS_SECURITY_STATE.search = $('#users-security-search')?.value || '';
    USERS_SECURITY_STATE.event = $('#users-security-event-filter')?.value || 'all';
    USERS_SECURITY_STATE.status = $('#users-security-status-filter')?.value || 'all';
    USERS_SECURITY_STATE.dateRange = $('#users-security-date-filter')?.value || '7';
    USERS_SECURITY_STATE.page = 1;
    tableState.usersSecurity.page = 1;
    usersSecurityMobileItems = [];
    syncUsersSecurityFiltersBtn();
    loadUsersSecurityActivity({ silent: true });
  };
  $('#users-security-search')?.addEventListener('input', () => {
    clearTimeout(searchTimers.usersSecurity);
    searchTimers.usersSecurity = setTimeout(sync, 220);
  });
  $('#users-security-event-filter')?.addEventListener('change', sync);
  $('#users-security-status-filter')?.addEventListener('change', sync);
  $('#users-security-date-filter')?.addEventListener('change', sync);
  $('#users-security-refresh-btn')?.addEventListener('click', () => {
    usersSecurityMobileItems = [];
    USERS_SECURITY_STATE.page = 1;
    tableState.usersSecurity.page = 1;
    loadUsersSecurityActivity();
  });
  $('#users-security-filters-btn')?.addEventListener('click', openUsersSecurityFilterSheet);
  document.querySelectorAll('[data-security-filter-close]').forEach((el) => {
    el.addEventListener('click', closeUsersSecurityFilterSheet);
  });
  $('#users-security-load-more')?.addEventListener('click', async () => {
    if (usersSecurityMobileLoading) return;
    if (USERS_SECURITY_STATE.page >= (usersSecurityPageResult.totalPages || 1)) return;
    usersSecurityMobileLoading = true;
    syncUsersSecurityLoadMore();
    USERS_SECURITY_STATE.page += 1;
    tableState.usersSecurity.page = USERS_SECURITY_STATE.page;
    await loadUsersSecurityActivity({ silent: true, append: true });
  });
  window.addEventListener('resize', () => {
    if (usersActiveView === 'security') {
      renderUsersSecurityKpiCards(usersSecurityKpiCache.length ? usersSecurityKpiCache : usersSecurityCache);
      renderUsersSecurityTable();
    }
  });
}

// Patch renderPagination callback path: keep usersSecurity page in USERS_SECURITY_STATE
if (!tableState.usersSecurity) {
  tableState.usersSecurity = { page: 1, pageSize: 10 };
}

async function loadUsers() {
  if (!canSuperAdmin()) return;
  bindUsersUi();
  bindPermUi();
  setUsersView(usersActiveView);
  const users = await api('/users');
  cachedUsers = Array.isArray(users) ? users : [];
  renderUsersKpis(cachedUsers);
  renderUsersTable();
  if (editingUserId) {
    const current = cachedUsers.find((u) => u.id === editingUserId);
    if (current) loadUserIntoForm(current);
    else resetUserForm({ keepDrawerClosed: true });
  }
  await loadRolePermissionsMatrix();
  renderPermPreviewCards('#users-perm-preview-cards', $('#users-preview-role')?.value || 'ADMIN');
  renderUsersDrawerPermPreview();
}

let cachedPermMatrix = null;

async function loadRolePermissionsMatrix() {
  if (!hasPermission('ROLE_PERMISSIONS_MANAGE') && adminRole !== 'SUPER_ADMIN') {
    $('#role-permissions-card')?.classList.add('hidden');
    $$('[data-users-tab="perms"]').forEach((btn) => btn.classList.add('hidden'));
    return;
  }
  $('#role-permissions-card')?.classList.remove('hidden');
  $$('[data-users-tab="perms"]').forEach((btn) => btn.classList.remove('hidden'));
  bindPermUi();
  try {
    cachedPermMatrix = await api('/role-permissions');
    const role = $('#perm-role-select')?.value || 'BACK_OFFICE';
    loadPermDraftFromRole(role);
    renderRolePermissionCheckboxes();
    renderPermPreviewCards('#users-perm-preview-cards', $('#users-preview-role')?.value || 'ADMIN');
    renderUsersDrawerPermPreview();
  } catch (ex) {
    notify.error(ex.message);
  }
}

$('#user-new-btn')?.addEventListener('click', () => {
  resetUserForm({ keepDrawerClosed: true });
  openUsersDrawer();
});

$('#user-cancel-btn')?.addEventListener('click', () => closeUsersDrawer());

$('#user-password')?.addEventListener('input', updateUserPasswordWarning);

$('#user-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#user-email').value.trim();
  const password = $('#user-password').value;
  const role = $('#user-role').value;
  const isActive = $('#user-active').checked;

  if (password && password.length < 8) {
    updateUserPasswordWarning();
    notify.error(t('users.passwordTooShort'));
    return;
  }

  try {
    if (editingUserId) {
      const body = { role, isActive };
      if (password) body.password = password;
      await api(`/users/${editingUserId}`, { method: 'PATCH', body: JSON.stringify(body) });
      notify.success(t('users.saved'));
      closeUsersDrawer();
    } else {
      if (!password) {
        notify.error(t('users.passwordRequired'));
        return;
      }
      await api('/users', {
        method: 'POST',
        body: JSON.stringify({ email, password, role }),
      }).then(async (created) => {
        if (!isActive && created?.id) {
          await api(`/users/${created.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ isActive: false }),
          });
        }
      });
      notify.success(t('users.created'));
      closeUsersDrawer();
    }
    loadUsers();
  } catch (ex) {
    notify.error(ex.message);
  }
});

$('#user-delete-btn')?.addEventListener('click', async () => {
  if (!editingUserId) return;
  const user = cachedUsers.find((u) => u.id === editingUserId);
  if (!user) return;
  const ok = await notify.confirm(
    t('users.deactivateConfirm', { email: user.email }),
    { title: t('users.deactivateTitle'), okLabel: t('users.deactivate') },
  );
  if (!ok) return;
  try {
    await api(`/users/${editingUserId}`, { method: 'DELETE' });
    notify.success(t('users.deactivated'));
    closeUsersDrawer();
    loadUsers();
  } catch (ex) {
    notify.error(ex.message);
  }
});

const FONIO_SETUP_GROUPS = [
  {
    id: 'call_context',
    titleKey: 'fonio.group.callContext',
    icon: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>',
    keys: ['call_context_webhook'],
  },
  {
    id: 'availability',
    titleKey: 'fonio.group.availability',
    icon: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    keys: ['availability', 'availability_weekends'],
  },
  {
    id: 'verification',
    titleKey: 'fonio.group.verification',
    icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/>',
    keys: ['guest_verify', 'guest_verify_requirements'],
  },
  {
    id: 'guest_actions',
    titleKey: 'fonio.group.guestActions',
    icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    keys: ['guest_reservation', 'guest_requests', 'guest_payments', 'guest_send_checkin_info'],
  },
  {
    id: 'booking',
    titleKey: 'fonio.group.booking',
    icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    keys: ['booking_offer'],
  },
  {
    id: 'webhooks',
    titleKey: 'fonio.group.webhooks',
    icon: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    keys: ['hostaway_webhook', 'swagger_docs'],
  },
];

const FONIO_ENDPOINT_META = {
  call_context_webhook: { method: 'POST', descKey: 'fonio.ep.call_context' },
  availability: { method: 'GET', descKey: 'fonio.ep.availability' },
  availability_weekends: { method: 'GET', descKey: 'fonio.ep.availability_weekends' },
  guest_verify: { method: 'POST', descKey: 'fonio.ep.guest_verify' },
  guest_verify_requirements: { method: 'GET', descKey: 'fonio.ep.guest_verify_requirements' },
  guest_reservation: { method: 'GET', descKey: 'fonio.ep.guest_reservation' },
  guest_requests: { method: 'POST', descKey: 'fonio.ep.guest_requests' },
  guest_payments: { method: 'POST', descKey: 'fonio.ep.guest_payments' },
  guest_send_checkin_info: { method: 'POST', descKey: 'fonio.ep.guest_send_checkin_info' },
  booking_offer: { method: 'POST', descKey: 'fonio.ep.booking_offer' },
  hostaway_webhook: { method: 'POST', descKey: 'fonio.ep.hostaway_webhook' },
  swagger_docs: { method: 'GET', descKey: 'fonio.ep.swagger_docs' },
};

let fonioSetupCache = null;
let fonioSetupUiBound = false;
let fonioSetupOpenGroups = new Set(['verification']);

function fonioSvgIcon(paths, size = 16) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function fonioProductionBase(urls) {
  const first = Object.values(urls || {})[0];
  if (!first) return '';
  try {
    return new URL(String(first)).origin;
  } catch {
    return String(first).replace(/\/api\/.*$/, '').replace(/\/$/, '');
  }
}

function fonioApiBasePath(urls) {
  const base = fonioProductionBase(urls);
  return base ? `${base}/api/v1/fonio` : '';
}

function ensureFonioSetupUi() {
  if (fonioSetupUiBound) return;
  fonioSetupUiBound = true;

  $('#fonio-setup-actions')?.addEventListener('click', async (e) => {
    const docs = e.target.closest?.('[data-fonio-open-docs]');
    if (docs) {
      const url = docs.getAttribute('data-fonio-open-docs');
      if (url) window.open(url, '_blank', 'noopener');
      return;
    }
    const testBtn = e.target.closest?.('[data-fonio-test-connection]');
    if (testBtn) {
      await testFonioConnection();
    }
  });

  $('#fonio-setup')?.addEventListener('click', async (e) => {
    const docs = e.target.closest?.('[data-fonio-open-docs]');
    if (docs) {
      const url = docs.getAttribute('data-fonio-open-docs');
      if (url) window.open(url, '_blank', 'noopener');
      return;
    }
    const testBtn = e.target.closest?.('[data-fonio-test-connection]');
    if (testBtn) {
      await testFonioConnection();
      return;
    }
    const checklistToggle = e.target.closest?.('[data-fonio-checklist-toggle]');
    if (checklistToggle) {
      const card = checklistToggle.closest('.fonio-setup-checklist-card');
      const expanded = !card?.classList.contains('is-open');
      card?.classList.toggle('is-open', expanded);
      checklistToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      return;
    }
    const toggle = e.target.closest?.('[data-fonio-group-toggle]');
    if (toggle) {
      const id = toggle.getAttribute('data-fonio-group-toggle');
      if (fonioSetupOpenGroups.has(id)) fonioSetupOpenGroups.delete(id);
      else fonioSetupOpenGroups.add(id);
      renderFonioSetup(fonioSetupCache);
      return;
    }

    const copyUrl = e.target.closest?.('[data-fonio-copy-url]');
    if (copyUrl) {
      const url = copyUrl.getAttribute('data-fonio-copy-url');
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        notify.success(t('common.copied'));
      } catch {
        notify.error(t('common.copyFailed') !== 'common.copyFailed' ? t('common.copyFailed') : 'Copy failed');
      }
      return;
    }

    const copyHeader = e.target.closest?.('[data-fonio-copy-header]');
    if (copyHeader) {
      const key = String(fonioSetupCache?.fonioApiKey || '').trim();
      if (!key) {
        notify.error(t('fonio.check.keyMissing'));
        return;
      }
      try {
        await navigator.clipboard.writeText(`x-api-key: ${key}`);
        notify.success(t('common.copied'));
      } catch {
        notify.error(t('common.copyFailed') !== 'common.copyFailed' ? t('common.copyFailed') : 'Copy failed');
      }
      return;
    }

    const reveal = e.target.closest?.('[data-fonio-reveal-key]');
    if (reveal) {
      const field = $('#fonio-setup-key-value');
      const key = String(fonioSetupCache?.fonioApiKey || '').trim();
      if (!field || !key) return;
      const shown = field.dataset.revealed === '1';
      if (shown) {
        field.dataset.revealed = '0';
        field.textContent = '*'.repeat(Math.min(16, Math.max(8, key.length)));
        reveal.innerHTML = `${fonioSvgIcon('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>', 14)} ${esc(t('fonio.reveal'))}`;
      } else {
        field.dataset.revealed = '1';
        field.textContent = key;
        reveal.innerHTML = `${fonioSvgIcon('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="m1 1 22 22"/>', 14)} ${esc(t('fonio.hide'))}`;
      }
    }
  });
}

async function testFonioConnection() {
  const started = performance.now();
  try {
    await api('/fonio-setup');
    const ms = Math.round(performance.now() - started);
    notify.success(t('fonio.testOk', { ms: String(ms) }));
    await loadFonio({ silent: true });
  } catch (ex) {
    notify.error(ex.message || t('fonio.testFail'));
  }
}

function pickLastFonioSuccess(logs) {
  const list = Array.isArray(logs) ? logs : [];
  for (const log of list) {
    const kind = typeof fonioOutcomeKind === 'function' ? fonioOutcomeKind(log) : null;
    const ok =
      kind === 'success' ||
      (Number(log.statusCode) >= 200 && Number(log.statusCode) < 300);
    if (ok) return log;
  }
  return null;
}

function renderFonioSetup(data) {
  if (!data) return;
  const urls = data.production ?? {};
  const keyOk = !!data.fonioApiKeyConfigured || !!String(data.fonioApiKey || '').trim();
  const apiKey = String(data.fonioApiKey || '').trim();
  const maskedKey = apiKey ? '*'.repeat(Math.min(16, Math.max(8, apiKey.length))) : '****************';
  const base = fonioProductionBase(urls);
  const apiBase = fonioApiBasePath(urls);
  const docsUrl = urls.swagger_docs || (base ? `${base}/docs` : '');
  const endpointCount = Object.keys(urls).length;
  const last = data.lastSuccess || null;
  const lastAt = last?.createdAt ? formatDashboardDateTime(last.createdAt) : t('fonio.noRecentCall');
  const lastMs =
    last?.durationMs != null && Number.isFinite(Number(last.durationMs))
      ? t('fonio.responseMs', { ms: String(last.durationMs) })
      : t('fonio.noLatency');

  const statusEl = $('#fonio-setup-status');
  if (statusEl) {
    statusEl.innerHTML = `
      <span class="fonio-setup-pill is-ok">${fonioSvgIcon('<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>', 10)} ${esc(t('fonio.statusConnected'))}</span>
      <span class="fonio-setup-pill is-ok subtle">${esc(t('fonio.statusHealthy'))}</span>
    `;
  }

  const actionsEl = $('#fonio-setup-actions');
  if (actionsEl) {
    actionsEl.innerHTML = `
      <button type="button" class="btn ghost" data-fonio-open-docs="${esc(docsUrl)}" ${docsUrl ? '' : 'disabled'}>
        ${fonioSvgIcon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>', 15)}
        ${esc(t('fonio.openDocs'))}
        ${fonioSvgIcon('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>', 13)}
      </button>
      <button type="button" class="btn primary" data-fonio-test-connection>
        ${fonioSvgIcon('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>', 15)}
        ${esc(t('fonio.testConnection'))}
      </button>
    `;
  }

  const groupsHtml = FONIO_SETUP_GROUPS.map((group) => {
    const entries = group.keys
      .filter((k) => urls[k])
      .map((k) => ({ key: k, url: urls[k], meta: FONIO_ENDPOINT_META[k] || { method: 'POST', descKey: '' } }));
    if (!entries.length) return '';
    const open = fonioSetupOpenGroups.has(group.id);
    const rows = entries
      .map((ep) => {
        const desc = ep.meta.descKey ? t(ep.meta.descKey) : '';
        const methodCls = ep.meta.method === 'GET' ? 'is-get' : 'is-post';
        return `
          <div class="fonio-setup-endpoint">
            <span class="fonio-setup-method ${methodCls}">${esc(ep.meta.method)}</span>
            <div class="fonio-setup-endpoint-main">
              <div class="fonio-setup-endpoint-title"><span class="fonio-endpoint-title-desktop">${esc(ep.key)}</span><span class="fonio-endpoint-title-mobile">${esc(desc && desc !== ep.meta.descKey ? desc : ep.key)}</span></div>
              ${desc && desc !== ep.meta.descKey ? `<div class="fonio-setup-endpoint-desc">${esc(desc)}</div>` : ''}
              <code class="fonio-setup-endpoint-url">${esc(ep.url)}</code>
            </div>
            <div class="fonio-setup-endpoint-actions">
              <button type="button" class="btn ghost btn-sm" data-fonio-copy-url="${esc(ep.url)}">
                ${fonioSvgIcon('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 14)}
                ${esc(t('common.copy'))}
              </button>
            </div>
          </div>`;
      })
      .join('');

    return `
      <section class="fonio-setup-accordion ${open ? 'is-open' : ''}">
        <button type="button" class="fonio-setup-accordion-head" data-fonio-group-toggle="${esc(group.id)}" aria-expanded="${open ? 'true' : 'false'}">
          <span class="fonio-setup-accordion-icon">${fonioSvgIcon(group.icon, 16)}</span>
          <span class="fonio-setup-accordion-title">${esc(t(group.titleKey))}</span>
          <span class="fonio-setup-accordion-count"><span class="fonio-count-desktop">${entries.length}</span><span class="fonio-count-mobile">${esc(t('fonio.endpointsCount', { count: entries.length }))}</span></span>
          <span class="fonio-setup-accordion-chevron" aria-hidden="true"></span>
        </button>
        <div class="fonio-setup-accordion-body">${rows}</div>
      </section>`;
  }).join('');

  const checklist = [
    {
      ok: keyOk,
      title: t('fonio.check.key'),
      detail: keyOk ? t('fonio.check.keyOk') : t('fonio.check.keyMissing'),
    },
    {
      ok: !!urls.hostaway_webhook,
      title: t('fonio.check.webhook'),
      detail: t('fonio.check.webhookOk'),
    },
    {
      ok: true,
      title: t('fonio.check.masking'),
      detail: t('fonio.check.maskingOk'),
    },
    {
      ok: !!docsUrl,
      title: t('fonio.check.docs'),
      detail: t('fonio.check.docsOk'),
    },
    {
      ok: null,
      warn: true,
      title: t('fonio.check.rotate'),
      detail: t('fonio.check.rotateHint'),
    },
  ];

  const checklistHtml = checklist
    .map((item) => {
      const cls = item.warn ? 'is-warn' : item.ok ? 'is-ok' : 'is-fail';
      const icon = item.warn
        ? fonioSvgIcon('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>', 14)
        : item.ok
          ? fonioSvgIcon('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>', 14)
          : fonioSvgIcon('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>', 14);
      return `
        <li class="fonio-setup-check ${cls}">
          <span class="fonio-setup-check-icon">${icon}</span>
          <div>
            <div class="fonio-setup-check-title">${esc(item.title)}</div>
            <div class="fonio-setup-check-detail">${esc(item.detail)}</div>
          </div>
        </li>`;
    })
    .join('');
  const checklistDone = checklist.filter((item) => item.ok === true).length;

  $('#fonio-setup').innerHTML = `
    <div class="fonio-setup-stats">
      <article class="fonio-setup-stat is-endpoints">
        <span class="fonio-setup-stat-icon">${fonioSvgIcon('<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>', 18)}</span>
        <div class="fonio-setup-stat-value">${endpointCount}</div>
        <div class="fonio-setup-stat-label"><span class="fonio-stat-label-desktop">${esc(t('fonio.stat.endpoints'))}</span><span class="fonio-stat-label-mobile">${esc(t('fonio.stat.endpointsShort'))}</span></div>
        <div class="fonio-setup-stat-sub">${esc(t('fonio.stat.endpointsSub'))}</div>
      </article>
      <article class="fonio-setup-stat is-auth">
        <span class="fonio-setup-stat-icon">${fonioSvgIcon('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>', 18)}</span>
        <div class="fonio-setup-stat-label"><span class="fonio-stat-label-desktop">${esc(t('fonio.stat.auth'))}</span><span class="fonio-stat-label-mobile">${esc(t('fonio.stat.authShort'))}</span></div>
        <div class="fonio-setup-stat-value ${keyOk ? 'is-ok' : 'is-fail'}">${esc(keyOk ? t('fonio.stat.authConfigured') : t('fonio.stat.authMissing'))}</div>
        <div class="fonio-setup-stat-sub">${esc(t('fonio.stat.authSub'))}</div>
      </article>
      <article class="fonio-setup-stat is-last-call">
        <span class="fonio-setup-stat-icon">${fonioSvgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', 18)}</span>
        <div class="fonio-setup-stat-label">${esc(t('fonio.stat.lastCall'))}</div>
        <div class="fonio-setup-stat-value is-sm">${esc(lastAt)}</div>
        <div class="fonio-setup-stat-sub ${last ? 'is-ok' : ''}">${esc(lastMs)}</div>
      </article>
      <article class="fonio-setup-stat is-environment">
        <span class="fonio-setup-stat-icon">${fonioSvgIcon('<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>', 18)}</span>
        <div class="fonio-setup-stat-label">${esc(t('fonio.stat.env'))}</div>
        <div class="fonio-setup-stat-value is-ok">${esc(t('fonio.stat.envProd'))}</div>
        <div class="fonio-setup-stat-sub"><a class="fonio-setup-link" href="${esc(base)}" target="_blank" rel="noopener">${esc(base || '—')}</a></div>
      </article>
    </div>

    <div class="fonio-setup-mobile-actions">
      <button type="button" class="btn primary" data-fonio-test-connection>
        ${fonioSvgIcon('<circle cx="12" cy="12" r="10"/><path d="m10 8 6 4-6 4Z"/>', 15)}
        ${esc(t('fonio.testConnection'))}
      </button>
      <button type="button" class="btn ghost" data-fonio-open-docs="${esc(docsUrl)}" ${docsUrl ? '' : 'disabled'}>
        ${fonioSvgIcon('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>', 15)}
        ${esc(t('fonio.openDocs'))}
      </button>
    </div>
    <div class="fonio-setup-mobile-last-call">
      <span>${esc(t('fonio.stat.lastCall'))}</span>
      <strong>${esc(lastAt)}</strong>
      <small>${esc(lastMs)}</small>
    </div>

    <div class="fonio-setup-layout">
      <div class="fonio-setup-main">
        ${groupsHtml}
        <div class="fonio-setup-https-note">
          ${fonioSvgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>', 15)}
          <span>${esc(t('fonio.httpsNote', { base: apiBase || base || '—' }))}</span>
        </div>
      </div>

      <aside class="fonio-setup-side">
        <div class="card fonio-setup-side-card fonio-setup-checklist-card">
          <button type="button" class="fonio-setup-checklist-mobile-head" data-fonio-checklist-toggle aria-expanded="false">
            <span class="fonio-setup-accordion-icon">${fonioSvgIcon('<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>', 16)}</span>
            <span><strong>${esc(t('fonio.checklistTitle'))}</strong><small>${esc(t('fonio.checklistProgress', { done: checklistDone, total: checklist.length }))}</small></span>
            <span class="fonio-setup-accordion-chevron" aria-hidden="true"></span>
          </button>
          <h3 class="fonio-setup-checklist-desktop-title">${esc(t('fonio.checklistTitle'))}</h3>
          <div class="fonio-setup-checklist-body">
            <ul class="fonio-setup-checklist">${checklistHtml}</ul>
          ${
            docsUrl
              ? `<a class="fonio-setup-side-link" href="${esc(docsUrl)}" target="_blank" rel="noopener">${esc(t('fonio.viewChecklist'))} ${fonioSvgIcon('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>', 13)}</a>`
              : ''
          }
          </div>
        </div>

        <div class="card fonio-setup-side-card fonio-setup-key-card">
          <h3>${esc(t('fonio.apiKeyTitle'))}</h3>
          <p class="fonio-setup-side-hint">${esc(t('fonio.apiKeyHint'))}</p>
          <div class="fonio-setup-key-box">
            <code>x-api-key:</code>
            <span id="fonio-setup-key-value" data-revealed="0">${esc(maskedKey)}</span>
            <button type="button" class="btn ghost btn-sm" data-fonio-reveal-key ${apiKey ? '' : 'disabled'}>
              ${fonioSvgIcon('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>', 14)}
              ${esc(t('fonio.reveal'))}
            </button>
          </div>
          <button type="button" class="btn ghost fonio-setup-copy-header" data-fonio-copy-header ${apiKey ? '' : 'disabled'}>
            ${fonioSvgIcon('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 14)}
            <span class="fonio-copy-label-desktop">${esc(t('fonio.copyHeader'))}</span><span class="fonio-copy-label-mobile">${esc(t('common.copy'))}</span>
          </button>
          <p class="fonio-setup-key-note">${esc(apiKey ? t('fonio.apiKeyReadyNote') : t('fonio.check.keyMissing'))}</p>
        </div>
      </aside>
    </div>
  `;
}

async function loadFonio(opts = {}) {
  ensureFonioSetupUi();
  const [setup, activity] = await Promise.all([
    api('/fonio-setup'),
    api('/fonio-activity?limit=50').catch(() => []),
  ]);
  const lastSuccess = pickLastFonioSuccess(activity);
  fonioSetupCache = {
    ...(setup || {}),
    lastSuccess,
  };
  renderFonioSetup(fonioSetupCache);
  if (!opts.silent) {
    // keep accordion state
  }
}

let check24Cache = { status: null, mappings: [], bookings: [] };
let check24UiBound = false;
let check24ActiveTab = 'overview';
let check24Syncing = false;
let check24SyncPollTimer = null;
let check24PipeExpanded = false;
const check24TableState = {
  apartments: { page: 1, pageSize: DEFAULT_PAGE_SIZE, search: '', status: 'all', sort: 'name', mobileLimit: 8 },
  bookings: { page: 1, pageSize: DEFAULT_PAGE_SIZE, search: '', status: 'all', sort: 'newest' },
};

function isCheck24MobileLayout() {
  return window.matchMedia('(max-width: 1023px)').matches;
}

function syncCheck24MobileChrome() {
  const onCheck24 = activeTab === 'check24';
  document.body.classList.toggle('check24-mobile-active', onCheck24 && isCheck24MobileLayout());
  $$('#check24-mobile-bottom-nav .check24-mobile-nav-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-check24-tab') === check24ActiveTab);
  });
}

function check24FmtTs(value) {
  if (!value) return null;
  try {
    return formatDashboardDateTime(value);
  } catch {
    return String(value);
  }
}

function check24MappingState(m) {
  if (m.listing?.status === 'HIDDEN' || m.listing?.isBookable === false) {
    return 'archived';
  }
  const synced =
    m.contentSyncedAt && m.availabilitySyncedAt && m.ratesSyncedAt;
  // Fully synced apartments are Ready even if a later retry left a stale lastError.
  if (synced) return 'ready';
  if (m.lastError) return 'error';
  return 'partial';
}

function check24AttentionReason(m) {
  if (m.listing?.status === 'HIDDEN' || m.listing?.isBookable === false) {
    return t('check24.attentionReason.archived');
  }
  if (m.lastError) return String(m.lastError);
  const missing = [];
  if (!m.contentSyncedAt) missing.push(t('check24.col.data'));
  if (!m.availabilitySyncedAt) missing.push(t('check24.col.availability'));
  if (!m.ratesSyncedAt) missing.push(t('check24.col.prices'));
  if (missing.length) {
    return t('check24.attentionReason.missing', { fields: missing.join(', ') });
  }
  return t('check24.attentionReason.generic');
}

function check24InfoIcon(title) {
  return `<span class="check24-info-tip" title="${esc(title)}" aria-label="${esc(title)}">${fonioSvgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>', 13)}</span>`;
}

function check24SyncChip(kind, at) {
  if (!at) {
    return `<span class="check24-sync-chip is-missing" title="${esc(t('check24.chip.notSyncedHelp.' + kind) || t('check24.chip.notSynced'))}">${fonioSvgIcon('<path d="M18 6 6 18M6 6l12 12"/>', 12)} ${esc(t('check24.chip.notSynced'))}</span>`;
  }
  const ageMs = Date.now() - new Date(at).getTime();
  const stale = Number.isFinite(ageMs) && ageMs > 36 * 60 * 60 * 1000;
  if (stale) {
    return `<span class="check24-sync-chip is-stale" title="${esc(t('check24.chip.outdatedHelp'))}">${fonioSvgIcon('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>', 12)} ${esc(t('check24.chip.outdated'))}</span>`;
  }
  const label =
    kind === 'data'
      ? t('check24.chip.complete')
      : t('check24.chip.synced');
  return `<span class="check24-sync-chip is-ok">${fonioSvgIcon('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>', 12)} ${esc(label)}</span>`;
}

function check24BookingStatusMeta(status) {
  const s = String(status || '').toLowerCase();
  if (['booked', 'requested', 'confirmed', 'accepted'].includes(s)) {
    return { cls: 'is-booked', label: t('check24.bookingStatus.booked') };
  }
  if (['canceled', 'cancelled', 'declined', 'failed'].includes(s)) {
    return { cls: 'is-cancelled', label: t('check24.bookingStatus.cancelled') };
  }
  return { cls: 'is-other', label: String(status || '—').toUpperCase() };
}

function check24NextRun(settings) {
  if (!settings?.autoSyncEnabled) return null;
  const interval = Number(settings.intervalMinutes) || 30;
  const last = settings.lastAutoSyncAt ? new Date(settings.lastAutoSyncAt).getTime() : Date.now();
  if (!Number.isFinite(last)) return null;
  return new Date(last + interval * 60 * 1000);
}

function ensureCheck24Ui() {
  if (check24UiBound) return;
  check24UiBound = true;

  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest?.('[data-check24-tab]');
    if (!tabBtn || !document.getElementById('tab-check24')?.contains(tabBtn)) return;
    const tab = tabBtn.getAttribute('data-check24-tab');
    if (!tab) return;
    activateCheck24Tab(tab);
  });

  $('#check24-apartments-search')?.addEventListener('input', () => {
    clearTimeout(searchTimers.check24Apartments);
    searchTimers.check24Apartments = setTimeout(() => {
      check24TableState.apartments.search = ($('#check24-apartments-search')?.value || '').trim();
      check24TableState.apartments.page = 1;
      renderCheck24ApartmentsTable();
    }, 200);
  });

  $('#check24-bookings-search')?.addEventListener('input', () => {
    clearTimeout(searchTimers.check24Bookings);
    searchTimers.check24Bookings = setTimeout(() => {
      check24TableState.bookings.search = ($('#check24-bookings-search')?.value || '').trim();
      check24TableState.bookings.page = 1;
      renderCheck24BookingsTable();
    }, 200);
  });

  const syncMaster = $('#check24-auto-sync-master');
  const syncEnabled = $('#check24-auto-sync-enabled');
  const syncContent = $('#check24-auto-sync-content');
  const syncContentRow = $('#check24-auto-sync-content-row');

  const syncAutoUi = (on) => {
    if (syncEnabled) syncEnabled.checked = on;
    if (syncMaster) syncMaster.checked = on;
    updateCheck24AutoSyncMasterLabel(on);
    if (syncContent) {
      syncContent.disabled = !on;
      if (!on) syncContent.checked = false;
    }
    syncContentRow?.classList.toggle('is-disabled', !on);
  };

  syncMaster?.addEventListener('change', () => syncAutoUi(syncMaster.checked));
  syncEnabled?.addEventListener('change', () => syncAutoUi(syncEnabled.checked));

  $('#check24-settings-sync-btn')?.addEventListener('click', () => {
    $('#check24-sync-btn')?.click();
  });

  $('#check24-copy-base-url')?.addEventListener('click', async () => {
    const url = $('#check24-base-url')?.value || '';
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      notify.success(t('common.copied'));
    } catch {
      notify.error(t('common.copyFailed') || 'Copy failed');
    }
  });

  $('#check24-bookings-status-filter')?.addEventListener('change', (e) => {
    check24TableState.bookings.status = e.target.value || 'all';
    check24TableState.bookings.page = 1;
    renderCheck24BookingsTable();
  });
  $('#check24-bookings-sort')?.addEventListener('change', (e) => {
    check24TableState.bookings.sort = e.target.value || 'newest';
    renderCheck24BookingsTable();
  });
  $('#check24-apartments-status-filter')?.addEventListener('change', (e) => {
    if (!isCheck24MobileLayout()) return;
    check24TableState.apartments.status = e.target.value || 'all';
    check24TableState.apartments.page = 1;
    check24TableState.apartments.mobileLimit = 8;
    renderCheck24ApartmentsTable();
  });
  $('#check24-apartments-sort')?.addEventListener('change', (e) => {
    if (!isCheck24MobileLayout()) return;
    check24TableState.apartments.sort = e.target.value || 'name';
    renderCheck24ApartmentsTable();
  });
  $('#check24-apartments-load-more')?.addEventListener('click', () => {
    check24TableState.apartments.mobileLimit = (Number(check24TableState.apartments.mobileLimit) || 8) + 8;
    renderCheck24ApartmentsTable();
  });
  document.querySelectorAll('[data-check24-filter-close]').forEach((el) => {
    el.addEventListener('click', closeCheck24FilterSheet);
  });
  $('#check24-mobile-more-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#check24-mobile-more-menu');
    const btn = $('#check24-mobile-more-btn');
    if (!menu) return;
    const open = menu.classList.contains('hidden');
    if (open) {
      menu.classList.remove('hidden');
      menu.hidden = false;
      btn?.setAttribute('aria-expanded', 'true');
    } else {
      closeCheck24MoreMenu();
    }
  });
  document.querySelectorAll('[data-check24-more]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-check24-more');
      closeCheck24MoreMenu();
      if (action === 'refresh') $('#check24-refresh-btn')?.click();
      if (action === 'settings') activateCheck24Tab('settings');
    });
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('#check24-mobile-more-btn') && !e.target.closest?.('#check24-mobile-more-menu')) {
      closeCheck24MoreMenu();
    }
  });
  window.addEventListener('resize', () => {
    if (activeTab === 'check24') {
      const wasMobile = $('#check24-flow')?.classList.contains('is-mobile-compact');
      syncCheck24MobileChrome();
      const nowMobile = isCheck24MobileLayout();
      if (wasMobile !== nowMobile) {
        const status = check24Cache.status;
        const connected =
          Boolean(status?.enabled) &&
          Boolean(status?.configured) &&
          Boolean(status?.ping?.ok);
        renderCheck24Header(status, connected);
        renderCheck24Pipeline(connected);
      }
    }
    if (activeTab === 'payments') syncPaymentsMobileChrome();
  });
}

function updateCheck24AutoSyncMasterLabel(on) {
  const label = $('#check24-auto-sync-master-label');
  if (!label) return;
  label.textContent = on ? t('check24.autoSyncCurrentlyOn') : t('check24.autoSyncCurrentlyOff');
}

function activateCheck24Tab(tab) {
  check24ActiveTab = tab || 'overview';
  $$('.check24-tab').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-check24-tab') === check24ActiveTab);
  });
  $$('[data-check24-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.getAttribute('data-check24-panel') !== check24ActiveTab);
  });
  syncCheck24MobileChrome();
  closeCheck24FilterSheet();
  closeCheck24MoreMenu();
}

function renderCheck24Header(status, connected) {
  const el = $('#check24-header-status');
  if (!el) return;
  const job = status?.lastJob;
  const jobStatus = String(job?.status || '').toLowerCase();
  const jobRunning =
    check24Syncing ||
    ['running', 'pending', 'in_progress', 'started', 'queued'].includes(jobStatus);
  const lastSync = check24FmtTs(job?.finishedAt || job?.startedAt || status?.settings?.lastAutoSyncAt);
  const opsLabel = jobRunning
    ? t('check24.syncingOps')
    : connected
      ? t('check24.systemsOk')
      : t('check24.systemsBad');
  const opsClass = jobRunning ? 'is-syncing' : connected ? 'is-ok' : 'is-bad';

  if (isCheck24MobileLayout()) {
    const syncText = jobRunning
      ? t('check24.syncing')
      : t('check24.lastSyncInline', { time: lastSync || t('check24.none') });
    el.innerHTML = `
      <span class="check24-header-ops ${opsClass}">
        <span class="check24-ops-dot"></span>
        <span class="check24-header-ops-label">${esc(opsLabel)}</span>
        <span class="check24-header-ops-sep" aria-hidden="true">-</span>
        <span class="check24-header-meta">${esc(syncText)}</span>
      </span>
    `;
    return;
  }

  const syncMeta = jobRunning
    ? `<span class="check24-header-meta is-syncing">${fonioSvgIcon('<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>', 13)} ${esc(t('check24.syncing'))}</span>`
    : `<span class="check24-header-meta">${esc(t('check24.lastSyncLabel', { time: lastSync || t('check24.none') }))}</span>`;
  el.innerHTML = `
    <div class="check24-header-status-row">
      <span class="check24-pill-status ${connected ? 'is-ok' : 'is-bad'}">${esc(connected ? t('check24.connected') : t('check24.disconnected'))}</span>
      ${syncMeta}
    </div>
    <span class="check24-header-ops ${opsClass}">
      <span class="check24-ops-dot"></span>
      ${esc(opsLabel)}
    </span>
  `;
}

function setCheck24Syncing(on) {
  check24Syncing = Boolean(on);
  const status = check24Cache.status;
  const connected =
    Boolean(status?.enabled) &&
    Boolean(status?.configured) &&
    Boolean(status?.ping?.ok);
  renderCheck24Header(status, connected);
  if (check24SyncPollTimer) {
    clearInterval(check24SyncPollTimer);
    check24SyncPollTimer = null;
  }
  if (!on) return;
  let polls = 0;
  check24SyncPollTimer = setInterval(async () => {
    polls += 1;
    try {
      await loadCheck24({ silent: true });
      if (!check24Syncing || polls >= 48) {
        clearInterval(check24SyncPollTimer);
        check24SyncPollTimer = null;
        check24Syncing = false;
        await loadCheck24();
      }
    } catch {
      /* keep trying */
    }
  }, 2500);
}

function check24LogoMarkup(className = 'check24-inline-logo') {
  return `<img src="/admin/assets/check24-logo-white.png" alt="CHECK24" class="${esc(className)}" width="220" height="58" />`;
}

function renderCheck24Pipeline(connected) {
  const el = $('#check24-flow');
  if (!el) return;
  const mobile = isCheck24MobileLayout();
  const showBadges = !mobile || check24PipeExpanded;
  const badge = showBadges
    ? connected
      ? `<span class="check24-mini-badge is-ok">${fonioSvgIcon('<path d="M20 6 9 17l-5-5"/>', 11)} ${esc(t('check24.connected'))}</span>`
      : `<span class="check24-mini-badge is-bad">${esc(t('check24.disconnected'))}</span>`
    : '';
  const linkIcon = connected
    ? `<span class="check24-pipe-check" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.5 10 17 18.5 7"/></svg></span>`
    : '';
  const step3Title = mobile
    ? `<strong>${esc(t('check24.step3Title'))}</strong>`
    : `<strong class="check24-pipe-brand">${check24LogoMarkup('check24-pipe-logo')}</strong>`;
  el.classList.toggle('is-mobile-compact', mobile);
  el.classList.toggle('is-expanded', mobile && check24PipeExpanded);
  el.innerHTML = `
    <div class="check24-pipe-step">
      <div class="check24-pipe-num">1</div>
      <div class="check24-pipe-copy">
        <strong>${esc(t('check24.step1Title'))}</strong>
        <p>${esc(t('check24.step1Role'))}</p>
        ${badge}
      </div>
    </div>
    <div class="check24-pipe-link ${connected ? 'is-ok' : ''}" aria-hidden="true">${linkIcon}</div>
    <div class="check24-pipe-step">
      <div class="check24-pipe-num">2</div>
      <div class="check24-pipe-copy">
        <strong>${esc(t('check24.step2Title'))}</strong>
        <p>${esc(t('check24.step2Role'))}</p>
        ${badge}
      </div>
    </div>
    <div class="check24-pipe-link ${connected ? 'is-ok' : ''}" aria-hidden="true">${linkIcon}</div>
    <div class="check24-pipe-step">
      <div class="check24-pipe-num">3</div>
      <div class="check24-pipe-copy">
        ${step3Title}
        <p>${esc(t('check24.step3Role'))}</p>
        ${badge}
      </div>
    </div>
    ${
      mobile
        ? `<button type="button" class="check24-pipe-toggle" aria-expanded="${check24PipeExpanded ? 'true' : 'false'}" aria-label="${esc(t('check24.pipelineToggle'))}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
          </button>`
        : ''
    }
  `;
}

function renderCheck24Kpis(mappings, bookings) {
  const el = $('#check24-kpis');
  if (!el) return;
  const active = mappings.filter((m) => check24MappingState(m) !== 'archived');
  const total = active.length;
  const ready = active.filter((m) => check24MappingState(m) === 'ready').length;
  const attention = active.filter((m) => check24MappingState(m) !== 'ready').length;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const bookings7d = bookings.filter((b) => {
    const ts = new Date(b.processedAt || b.createdAt).getTime();
    return Number.isFinite(ts) && ts >= weekAgo;
  }).length;
  const pct = total ? Math.round((ready / total) * 100) : 0;

  el.innerHTML = `
    <article class="check24-kpi">
      <span class="check24-kpi-icon is-blue">${fonioSvgIcon('<path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6"/>', 18)}</span>
      <div class="check24-kpi-body">
        <div class="check24-kpi-value">${formatCount(total)}</div>
        <div class="check24-kpi-meta">
          <div class="check24-kpi-label">${esc(t('check24.kpi.apartmentsSent'))} ${check24InfoIcon(t('check24.kpi.apartmentsSentTip'))}</div>
          <div class="check24-kpi-sub">${esc(t('check24.kpi.apartmentsSentSub', { pct: String(pct) }))}</div>
        </div>
      </div>
    </article>
    <article class="check24-kpi">
      <span class="check24-kpi-icon is-purple">${fonioSvgIcon('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>', 18)}</span>
      <div class="check24-kpi-body">
        <div class="check24-kpi-value">${formatCount(bookings7d)}</div>
        <div class="check24-kpi-meta">
          <div class="check24-kpi-label">${esc(t('check24.kpi.importedBookings'))} ${check24InfoIcon(t('check24.kpi.importedBookingsTip'))}</div>
          <div class="check24-kpi-sub">${esc(t('check24.kpi.importedBookingsSub'))}</div>
        </div>
      </div>
    </article>
    <article class="check24-kpi">
      <span class="check24-kpi-icon is-ok">${fonioSvgIcon('<path d="M20 6 9 17l-5-5"/>', 18)}</span>
      <div class="check24-kpi-body">
        <div class="check24-kpi-value">${formatCount(ready)}</div>
        <div class="check24-kpi-meta">
          <div class="check24-kpi-label is-ok">${esc(t('check24.kpi.readyShort'))} ${check24InfoIcon(t('check24.kpi.readyTip'))}</div>
          <div class="check24-kpi-sub">${esc(t('check24.kpi.apartmentsNoun'))}</div>
        </div>
      </div>
    </article>
    <article class="check24-kpi">
      <span class="check24-kpi-icon is-warn">${fonioSvgIcon('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>', 18)}</span>
      <div class="check24-kpi-body">
        <div class="check24-kpi-value">${formatCount(attention)}</div>
        <div class="check24-kpi-meta">
          <div class="check24-kpi-label is-warn">${esc(t('check24.kpi.attention'))} ${check24InfoIcon(t('check24.kpi.attentionTip'))}</div>
          <div class="check24-kpi-sub">${esc(t('check24.kpi.apartmentsNoun'))}</div>
        </div>
      </div>
    </article>
  `;
}

function renderCheck24SyncHealth(status, bookings) {
  const el = $('#check24-sync-health');
  if (!el) return;
  const settings = status?.settings || {};
  const enabled = Boolean(settings.autoSyncEnabled);
  const interval = Number(settings.intervalMinutes) || 30;
  const next = check24NextRun(settings);
  const lastSync = check24FmtTs(status?.lastJob?.finishedAt || status?.lastJob?.startedAt || settings.lastAutoSyncAt) || t('check24.none');
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentCount = (bookings || []).filter((b) => {
    const ts = new Date(b.processedAt || b.createdAt).getTime();
    return Number.isFinite(ts) && ts >= weekAgo;
  }).length;
  const lastImport = bookings?.[0]
    ? check24FmtTs(bookings[0].processedAt || bookings[0].createdAt)
    : null;

  el.innerHTML = `
    <div class="check24-card-head">
      <h3>${esc(t('check24.syncHealth'))}</h3>
      <label class="check24-switch">
        <span>${esc(t('check24.autoSyncEnableShort'))}</span>
        <input type="checkbox" id="check24-health-auto-toggle" ${enabled ? 'checked' : ''} />
        <span class="check24-switch-ui" aria-hidden="true"></span>
      </label>
    </div>
    <div class="check24-health-meta">
      <span>${fonioSvgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', 14)} ${esc(t('check24.intervalMin', { minutes: String(interval) }))}</span>
      <span>${fonioSvgIcon('<path d="M5 12h14M12 5l7 7-7 7"/>', 14)} ${esc(t('check24.nextRun', { time: next ? check24FmtTs(next.toISOString()) : t('check24.autoSyncOff') }))}</span>
    </div>
    <ul class="check24-health-list">
      <li class="is-ok"><span class="check24-health-dot"></span><div><strong>${esc(t('check24.health.lastSync'))}</strong><p>${esc(lastSync)}</p></div></li>
      <li class="is-ok"><span class="check24-health-dot"></span><div><strong>${esc(t('check24.health.availability'))}</strong><p>${esc(t('check24.health.upToDate'))}</p></div></li>
      <li class="is-ok"><span class="check24-health-dot"></span><div><strong>${esc(t('check24.health.prices'))}</strong><p>${esc(t('check24.health.upToDate'))}</p></div></li>
      <li class="is-ok"><span class="check24-health-dot"></span><div><strong>${esc(t('check24.health.bookingImport'))}</strong><p>${esc(t('check24.health.lastImport', { time: lastImport || t('check24.none'), count: String(recentCount) }))}</p></div></li>
    </ul>
  `;

  const healthToggle = $('#check24-health-auto-toggle');
  if (healthToggle) {
    healthToggle.onchange = async (e) => {
      const on = e.target.checked;
      const intervalMinutes = Number($('#check24-auto-sync-interval')?.value) || interval;
      try {
        await api('/check24/sync/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            autoSyncEnabled: on,
            autoSyncContent: $('#check24-auto-sync-content')?.checked ?? false,
            intervalMinutes,
          }),
        });
        if ($('#check24-auto-sync-enabled')) $('#check24-auto-sync-enabled').checked = on;
        notify.success(t('check24.autoSyncSaved'));
        await loadCheck24();
      } catch (ex) {
        e.target.checked = !on;
        notify.error(ex.message);
      }
    };
  }
}

function check24ApartmentIsOutdated(m) {
  const state = check24MappingState(m);
  if (state === 'archived' || state === 'ready') return false;
  return true;
}

function renderCheck24ApartmentsSummary(targetId, mappings) {
  const el = $(targetId);
  if (!el) return;
  const active = (mappings || []).filter((m) => check24MappingState(m) !== 'archived');
  const complete = active.filter((m) => check24MappingState(m) === 'ready').length;
  const outdated = active.length - complete;
  el.innerHTML = `
    <div class="check24-summary-chip">
      <span class="check24-summary-icon is-blue" aria-hidden="true">${fonioSvgIcon('<path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6"/>', 14)}</span>
      <span>${esc(t('check24.summaryTotal', { count: String(active.length) }))}</span>
    </div>
    <div class="check24-summary-chip is-ok">
      <span class="check24-summary-icon is-ok" aria-hidden="true">${fonioSvgIcon('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>', 14)}</span>
      <span>${esc(t('check24.summaryComplete', { count: String(complete) }))}</span>
    </div>
    <div class="check24-summary-chip is-warn">
      <span class="check24-summary-icon is-warn" aria-hidden="true">${fonioSvgIcon('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>', 14)}</span>
      <span>${esc(t('check24.summaryOutdated', { count: String(outdated) }))}</span>
    </div>
  `;
}

function renderCheck24BookingCards(bookings, { showChevron = true } = {}) {
  if (!bookings.length) {
    return `<div class="check24-empty">${esc(t('check24.bookingsNone'))}</div>`;
  }
  return bookings
    .map((b) => {
      const meta = check24BookingStatusMeta(b.status);
      const stay =
        b.dateFrom && b.dateTo ? `${b.dateFrom} → ${b.dateTo}` : '—';
      const amount =
        typeof b.totalPrice === 'number'
          ? `${b.totalPrice.toFixed(2)} ${b.currencyCode || 'EUR'}`
          : '—';
      return `
        <article class="check24-m-booking-card">
          <div class="check24-m-booking-top">
            <span class="check24-booking-pill ${meta.cls}">${esc(meta.label)}</span>
            <strong class="check24-m-booking-price">${esc(amount)}</strong>
          </div>
          <div class="check24-m-booking-main">
            <div class="check24-m-booking-copy">
              <strong>${esc(b.guestName || '—')}</strong>
              <span>${esc(b.listingName || t('check24.bookingNoProperty'))}</span>
              <span class="check24-m-booking-dates">${fonioSvgIcon('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>', 12)} ${esc(stay)}</span>
            </div>
            ${showChevron ? '<span class="check24-m-chevron" aria-hidden="true">›</span>' : ''}
          </div>
        </article>`;
    })
    .join('');
}

function renderCheck24ApartmentCards(mappings) {
  if (!mappings.length) {
    return `<div class="check24-empty">${esc(t('check24.none'))}</div>`;
  }
  return mappings
    .map((m) => {
      const state = check24MappingState(m);
      const statusLabel =
        state === 'ready'
          ? t('check24.statusReady')
          : state === 'archived'
            ? t('check24.statusArchived')
            : t('check24.statusAttention');
      const statusCls =
        state === 'ready' ? 'is-ready' : state === 'archived' ? 'is-archived' : 'is-attention';
      const last =
        check24FmtTs(m.ratesSyncedAt || m.availabilitySyncedAt || m.contentSyncedAt) ||
        t('check24.notSynced');
      return `
        <article class="check24-m-apartment-card">
          <div class="check24-m-apartment-top">
            <strong>${esc(m.listing?.name || '—')}</strong>
            <span class="check24-status-badge ${statusCls}">${esc(statusLabel)}</span>
          </div>
          <div class="check24-m-apartment-ids">
            <span>Hostaway ID ${esc(String(m.listing?.hostawayId ?? '—'))}</span>
            <span class="check24-m-sep">|</span>
            <span>CHECK24 ID ${esc(m.check24PropertyId || '—')}</span>
          </div>
          <div class="check24-m-apartment-sync">
            <div><span>${esc(t('check24.col.data'))}</span>${state === 'archived' ? '—' : check24SyncChip('data', m.contentSyncedAt)}</div>
            <div><span>${esc(t('check24.col.availability'))}</span>${state === 'archived' ? '—' : check24SyncChip('availability', m.availabilitySyncedAt)}</div>
            <div><span>${esc(t('check24.col.prices'))}</span>${state === 'archived' ? '—' : check24SyncChip('prices', m.ratesSyncedAt)}</div>
          </div>
          <div class="check24-m-apartment-foot">
            <span>${fonioSvgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', 13)} ${esc(t('check24.col.lastSent'))}: ${esc(last)}</span>
            <span class="check24-m-chevron" aria-hidden="true">›</span>
          </div>
        </article>`;
    })
    .join('');
}

function filterCheck24Bookings(all) {
  const q = (check24TableState.bookings.search || '').toLowerCase();
  const status = check24TableState.bookings.status || 'all';
  const mobile = isCheck24MobileLayout();
  let filtered = all.filter((b) => {
    if (mobile && status === 'booked') {
      const meta = check24BookingStatusMeta(b.status);
      if (meta.cls !== 'is-booked') return false;
    } else if (mobile && status === 'cancelled') {
      const meta = check24BookingStatusMeta(b.status);
      if (meta.cls !== 'is-cancelled') return false;
    }
    if (!q) return true;
    const hay = [
      b.guestName,
      b.listingName,
      b.status,
      b.dateFrom,
      b.dateTo,
      b.hostawayReservationId,
      b.check24BookingId,
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
  if (!mobile) return filtered;
  const sort = check24TableState.bookings.sort || 'newest';
  filtered = [...filtered].sort((a, b) => {
    if (sort === 'amount_desc' || sort === 'amount_asc') {
      const av = Number(a.totalPrice) || 0;
      const bv = Number(b.totalPrice) || 0;
      return sort === 'amount_desc' ? bv - av : av - bv;
    }
    const at = new Date(a.processedAt || a.createdAt || a.dateFrom || 0).getTime();
    const bt = new Date(b.processedAt || b.createdAt || b.dateFrom || 0).getTime();
    return sort === 'oldest' ? at - bt : bt - at;
  });
  return filtered;
}

function filterCheck24Apartments(all) {
  const q = (check24TableState.apartments.search || '').toLowerCase();
  const status = check24TableState.apartments.status || 'all';
  const mobile = isCheck24MobileLayout();
  let filtered = all.filter((m) => {
    const state = check24MappingState(m);
    if (mobile && status === 'ready' && state !== 'ready') return false;
    if (mobile && status === 'outdated' && (state === 'ready' || state === 'archived')) return false;
    if (mobile && status === 'archived' && state !== 'archived') return false;
    if (!q) return true;
    const hay = [m.listing?.name, m.listing?.hostawayId, m.check24PropertyId, m.lastError]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
  if (!mobile) return filtered;
  const sort = check24TableState.apartments.sort || 'name';
  filtered = [...filtered].sort((a, b) => {
    if (sort === 'recent') {
      const at = new Date(a.ratesSyncedAt || a.availabilitySyncedAt || a.contentSyncedAt || 0).getTime();
      const bt = new Date(b.ratesSyncedAt || b.availabilitySyncedAt || b.contentSyncedAt || 0).getTime();
      return bt - at;
    }
    if (sort === 'attention') {
      const as = check24MappingState(a) === 'ready' ? 1 : 0;
      const bs = check24MappingState(b) === 'ready' ? 1 : 0;
      return as - bs;
    }
    return String(a.listing?.name || '').localeCompare(String(b.listing?.name || ''));
  });
  return filtered;
}

function closeCheck24FilterSheet() {
  const sheet = $('#check24-filter-sheet');
  if (!sheet) return;
  sheet.classList.add('hidden');
  sheet.hidden = true;
  document.body.classList.remove('users-filter-open');
}

function openCheck24FilterSheet(kind) {
  const sheet = $('#check24-filter-sheet');
  const body = $('#check24-filter-sheet-body');
  const title = $('#check24-filter-sheet-title');
  if (!sheet || !body || !title) return;
  let options = [];
  let current = 'all';
  if (kind === 'bookings-filter') {
    title.textContent = t('check24.filter');
    current = check24TableState.bookings.status;
    options = [
      { value: 'all', label: t('check24.filterAllStatus') },
      { value: 'booked', label: t('check24.bookingStatus.booked') },
      { value: 'cancelled', label: t('check24.bookingStatus.cancelled') },
    ];
  } else if (kind === 'bookings-sort') {
    title.textContent = t('check24.sort');
    current = check24TableState.bookings.sort;
    options = [
      { value: 'newest', label: t('check24.sortNewest') },
      { value: 'oldest', label: t('check24.sortOldest') },
      { value: 'amount_desc', label: t('check24.sortAmountDesc') },
      { value: 'amount_asc', label: t('check24.sortAmountAsc') },
    ];
  } else if (kind === 'apartments-filter') {
    title.textContent = t('check24.filter');
    current = check24TableState.apartments.status;
    options = [
      { value: 'all', label: t('check24.filterAllApartments') },
      { value: 'ready', label: t('check24.statusReady') },
      { value: 'outdated', label: t('check24.chip.outdated') },
      { value: 'archived', label: t('check24.statusArchived') },
    ];
  } else if (kind === 'apartments-sort') {
    title.textContent = t('check24.sort');
    current = check24TableState.apartments.sort;
    options = [
      { value: 'name', label: t('check24.sortName') },
      { value: 'recent', label: t('check24.sortRecent') },
      { value: 'attention', label: t('check24.sortAttention') },
    ];
  }
  body.innerHTML = options
    .map(
      (opt) => `
    <button type="button" class="users-filter-option${opt.value === current ? ' is-selected' : ''}" data-check24-sheet-value="${esc(opt.value)}">
      ${esc(opt.label)}
    </button>`,
    )
    .join('');
  body.querySelectorAll('[data-check24-sheet-value]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.check24SheetValue;
      if (kind === 'bookings-filter') {
        check24TableState.bookings.status = value;
        const sel = $('#check24-bookings-status-filter');
        if (sel) sel.value = value;
        check24TableState.bookings.page = 1;
        renderCheck24BookingsTable();
      } else if (kind === 'bookings-sort') {
        check24TableState.bookings.sort = value;
        const sel = $('#check24-bookings-sort');
        if (sel) sel.value = value;
        renderCheck24BookingsTable();
      } else if (kind === 'apartments-filter') {
        check24TableState.apartments.status = value;
        check24TableState.apartments.page = 1;
        check24TableState.apartments.mobileLimit = 8;
        renderCheck24ApartmentsTable();
      } else if (kind === 'apartments-sort') {
        check24TableState.apartments.sort = value;
        renderCheck24ApartmentsTable();
      }
      closeCheck24FilterSheet();
    });
  });
  sheet.classList.remove('hidden');
  sheet.hidden = false;
  document.body.classList.add('users-filter-open');
}

function closeCheck24MoreMenu() {
  const menu = $('#check24-mobile-more-menu');
  const btn = $('#check24-mobile-more-btn');
  if (menu) {
    menu.classList.add('hidden');
    menu.hidden = true;
  }
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function renderCheck24BookingsRows(bookings, { limit = null } = {}) {
  const rows = limit != null ? bookings.slice(0, limit) : bookings;
  if (!rows.length) {
    return `<div class="check24-empty">${esc(t('check24.bookingsNone'))}</div>`;
  }
  return `
    <div class="table-wrap">
      <table class="check24-data-table">
        <thead>
          <tr>
            <th>${esc(t('check24.col.status'))}</th>
            <th>${esc(t('check24.bookingGuest'))}</th>
            <th>${esc(t('check24.bookingProperty'))}</th>
            <th>${esc(t('check24.col.stay'))}</th>
            <th>${esc(t('check24.col.amount'))}</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((b) => {
              const meta = check24BookingStatusMeta(b.status);
              const stay =
                b.dateFrom && b.dateTo ? `${b.dateFrom} → ${b.dateTo}` : '—';
              const amount =
                typeof b.totalPrice === 'number'
                  ? `${b.totalPrice.toFixed(2)} ${b.currencyCode || 'EUR'}`
                  : '—';
              return `<tr>
                <td><span class="check24-booking-pill ${meta.cls}">${esc(meta.label)}</span></td>
                <td>${esc(b.guestName || '—')}</td>
                <td>${esc(b.listingName || t('check24.bookingNoProperty'))}</td>
                <td>${esc(stay)}</td>
                <td>${esc(amount)}</td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>`;
}

function renderCheck24ApartmentsRows(mappings) {
  if (!mappings.length) {
    return `<div class="check24-empty">${esc(t('check24.none'))}</div>`;
  }
  return `
    <div class="table-wrap">
      <table class="check24-data-table">
        <thead>
          <tr>
            <th>${esc(t('check24.col.property'))}</th>
            <th>${esc(t('check24.col.hostawayId'))}</th>
            <th>${esc(t('check24.col.check24Id'))}</th>
            <th title="${esc(t('check24.col.dataTip'))}">${esc(t('check24.col.data'))} ${check24InfoIcon(t('check24.col.dataTip'))}</th>
            <th>${esc(t('check24.col.availability'))}</th>
            <th>${esc(t('check24.col.prices'))}</th>
            <th>${esc(t('check24.col.lastSent'))}</th>
            <th>${esc(t('check24.col.status'))}</th>
          </tr>
        </thead>
        <tbody>
          ${mappings
            .map((m) => {
              const state = check24MappingState(m);
              const statusLabel =
                state === 'ready'
                  ? t('check24.statusReady')
                  : state === 'archived'
                    ? t('check24.statusArchived')
                    : t('check24.statusAttention');
              const statusCls =
                state === 'ready'
                  ? 'is-ready'
                  : state === 'archived'
                    ? 'is-archived'
                    : 'is-attention';
              const reason = state === 'ready' ? '' : check24AttentionReason(m);
              const dataCell =
                state === 'archived'
                  ? `<span class="check24-sync-chip is-stale">${fonioSvgIcon('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>', 12)} ${esc(t('check24.chip.archived'))}</span>`
                  : state !== 'ready' && m.lastError && !m.contentSyncedAt
                    ? `${check24SyncChip('data', m.contentSyncedAt)}<div class="check24-row-error" title="${esc(m.lastError)}">${esc(m.lastError)}</div>`
                    : check24SyncChip('data', m.contentSyncedAt);
              const last =
                check24FmtTs(
                  m.ratesSyncedAt || m.availabilitySyncedAt || m.contentSyncedAt,
                ) || t('check24.notSynced');
              return `<tr class="${state === 'ready' ? '' : state === 'archived' ? 'is-archived-row' : 'is-attention-row'}">
                <td data-col="property" data-label="${esc(t('check24.col.property'))}"><strong>${esc(m.listing?.name || '—')}</strong></td>
                <td data-col="hostaway" data-label="${esc(t('check24.col.hostawayId'))}"><code>${esc(String(m.listing?.hostawayId ?? '—'))}</code></td>
                <td data-col="check24" data-label="${esc(t('check24.col.check24Id'))}"><code>${esc(m.check24PropertyId || '—')}</code></td>
                <td data-col="data" data-label="${esc(t('check24.col.data'))}">${dataCell}</td>
                <td data-col="availability" data-label="${esc(t('check24.col.availability'))}">${state === 'archived' ? '—' : check24SyncChip('availability', m.availabilitySyncedAt)}</td>
                <td data-col="prices" data-label="${esc(t('check24.col.prices'))}">${state === 'archived' ? '—' : check24SyncChip('prices', m.ratesSyncedAt)}</td>
                <td data-col="last" data-label="${esc(t('check24.col.lastSent'))}">${esc(last)}</td>
                <td data-col="status" data-label="${esc(t('check24.col.status'))}"><span class="check24-status-badge ${statusCls}" title="${esc(reason)}">${esc(statusLabel)}</span></td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>`;
}

function renderCheck24ApartmentsTable() {
  const all = check24Cache.mappings || [];
  const filtered = filterCheck24Apartments(all);

  const pageSize = check24TableState.apartments.pageSize || DEFAULT_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  if (check24TableState.apartments.page > totalPages) {
    check24TableState.apartments.page = totalPages;
  }
  const page = check24TableState.apartments.page;
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  const list = $('#check24-mappings-table');
  if (list) list.innerHTML = renderCheck24ApartmentsRows(items);
  const preview = $('#check24-apartments-preview');
  if (preview) preview.innerHTML = renderCheck24ApartmentsRows(filtered.slice(0, 5));
  renderCheck24ApartmentsSummary('#check24-apartments-summary', all);
  renderCheck24ApartmentsSummary('#check24-apartments-overview-summary', all);

  const mobileLimit = Math.max(8, Number(check24TableState.apartments.mobileLimit) || 8);
  const mobileItems = filtered.slice(0, mobileLimit);
  const mobileList = $('#check24-apartments-mobile-list');
  if (mobileList) mobileList.innerHTML = renderCheck24ApartmentCards(mobileItems);
  const loadMore = $('#check24-apartments-load-more');
  if (loadMore) {
    loadMore.hidden = mobileItems.length >= filtered.length;
    loadMore.textContent = t('check24.loadMoreApartments');
  }

  const badge = $('#check24-count-badge');
  if (badge) {
    const active = all.filter((m) => check24MappingState(m) !== 'archived');
    const ready = active.filter((m) => check24MappingState(m) === 'ready').length;
    const attention = active.length - ready;
    const archived = all.length - active.length;
    badge.textContent = t('check24.apartmentsCount', { count: String(active.length) });
    badge.title = t('check24.apartmentsCountTip', {
      ready: String(ready),
      attention: String(attention),
    }) + (archived ? ` · ${t('check24.apartmentsArchivedTip', { count: String(archived) })}` : '');
  }
  const mobileBadge = $('#check24-apartments-mobile-badge');
  if (mobileBadge) {
    const active = all.filter((m) => check24MappingState(m) !== 'archived');
    mobileBadge.textContent = String(active.length);
  }
  const aptStatusSel = $('#check24-apartments-status-filter');
  if (aptStatusSel) aptStatusSel.value = check24TableState.apartments.status || 'all';
  const aptSortSel = $('#check24-apartments-sort');
  if (aptSortSel) aptSortSel.value = check24TableState.apartments.sort || 'name';

  const info = {
    page,
    pageSize,
    total: filtered.length,
    totalPages,
  };
  renderTableInfo('#check24-apartments-info', info, all.length);
  renderPagination(
    '#check24-apartments-pagination',
    info,
    'check24Apartments',
    renderCheck24ApartmentsTable,
    { state: check24TableState.apartments },
  );
}

function renderCheck24BookingsTable() {
  const all = check24Cache.bookings || [];
  const filtered = filterCheck24Bookings(all);

  const pageSize = check24TableState.bookings.pageSize || DEFAULT_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  if (check24TableState.bookings.page > totalPages) check24TableState.bookings.page = totalPages;
  const page = check24TableState.bookings.page;
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  const list = $('#check24-bookings-table');
  if (list) list.innerHTML = renderCheck24BookingsRows(items);
  const recent = $('#check24-recent-bookings');
  if (recent) recent.innerHTML = renderCheck24BookingsRows(all, { limit: 5 });
  const recentMobile = $('#check24-recent-bookings-mobile');
  if (recentMobile) recentMobile.innerHTML = renderCheck24BookingCards(all.slice(0, 5));
  const mobileList = $('#check24-bookings-mobile-list');
  if (mobileList) mobileList.innerHTML = renderCheck24BookingCards(items);
  const mobileCount = $('#check24-bookings-mobile-count');
  if (mobileCount) {
    mobileCount.hidden = false;
    mobileCount.textContent = t('check24.bookingsCount', { count: String(filtered.length) });
  }

  const badge = $('#check24-bookings-badge');
  if (badge) badge.textContent = String(all.length);

  const info = {
    page,
    pageSize,
    total: filtered.length,
    totalPages,
  };
  renderTableInfo('#check24-bookings-info', info, all.length);
  renderPagination(
    '#check24-bookings-pagination',
    info,
    'check24Bookings',
    renderCheck24BookingsTable,
    { state: check24TableState.bookings },
  );
}

async function loadCheck24(opts = {}) {
  ensureCheck24Ui();
  const [status, mappings, bookings] = await Promise.all([
    api('/check24/status'),
    api('/check24/mappings'),
    api('/check24/bookings?limit=200'),
  ]);

  check24Cache = {
    status,
    mappings: Array.isArray(mappings) ? mappings : [],
    bookings: Array.isArray(bookings) ? bookings : [],
  };

  const connected =
    Boolean(status?.enabled) &&
    Boolean(status?.configured) &&
    Boolean(status?.ping?.ok);
  const baseUrl = String(status?.baseUrl || '');

  const jobStatus = String(status?.lastJob?.status || '').toLowerCase();
  const jobStillRunning = ['running', 'pending', 'in_progress', 'started', 'queued'].includes(jobStatus);
  if (check24Syncing && !jobStillRunning && status?.lastJob?.finishedAt) {
    check24Syncing = false;
    if (check24SyncPollTimer) {
      clearInterval(check24SyncPollTimer);
      check24SyncPollTimer = null;
    }
  }

  renderCheck24Header(status, connected);
  if (opts.silent) {
    // Keep tables/settings as-is during poll; only header status updates above.
    applyRoleUi();
    return;
  }
  renderCheck24Pipeline(connected);
  renderCheck24Kpis(check24Cache.mappings, check24Cache.bookings);
  renderCheck24SyncHealth(status, check24Cache.bookings);
  renderCheck24BookingsTable();
  renderCheck24ApartmentsTable();
  activateCheck24Tab(check24ActiveTab);

  const job = status.lastJob;
  const jobWhen = job ? check24FmtTs(job.finishedAt || job.startedAt) : null;
  const jobStatusRaw = String(job?.status || '');
  const jobStatusLower = jobStatusRaw.toLowerCase();
  const jobOk =
    !job ||
    ['completed', 'completed_with_errors', 'success', 'ok', 'done'].includes(jobStatusLower);
  const hint = $('#check24-status-hint');
  if (hint) {
    if (!job) {
      hint.innerHTML = `<span class="check24-last-send-line">${esc(t('check24.none'))}</span>`;
    } else {
      const statusLabel = jobOk ? t('check24.jobCompleted') : esc(jobStatusRaw || '—');
      hint.innerHTML = `
        <span class="check24-last-send-line ${jobOk ? 'is-ok' : 'is-bad'}">
          <span class="check24-ops-dot"></span>
          <span class="check24-job-pill ${jobOk ? 'is-ok' : 'is-bad'}">${jobOk ? esc(statusLabel) : esc(jobStatusRaw)}</span>
          ${jobWhen ? `<span class="check24-job-when">· ${esc(jobWhen)}</span>` : ''}
        </span>
        ${job.error ? `<span class="error">${esc(job.error)}</span>` : ''}
      `;
    }
  }

  const baseUrlEl = $('#check24-base-url');
  if (baseUrlEl) baseUrlEl.value = baseUrl;
  const envBadge = $('#check24-env-badge');
  if (envBadge) {
    const isStaging = /staging|test|check24-test/i.test(baseUrl);
    envBadge.textContent = isStaging ? t('check24.envStaging') : t('check24.envLive');
    envBadge.title = isStaging ? t('check24.envStagingTip') : t('check24.envLiveTip');
    envBadge.classList.toggle('is-live', !isStaging);
  }

  const conn = $('#check24-settings-conn');
  if (conn) {
    conn.innerHTML = `
      <div class="check24-settings-conn-row ${connected ? 'is-ok' : 'is-bad'}">
        <span class="check24-ops-dot"></span>
        <div>
          <strong>${esc(connected ? t('check24.connected') : t('check24.disconnected'))}</strong>
          <p>${esc(connected ? t('check24.systemsOk') : t('check24.systemsBad'))}</p>
        </div>
      </div>
    `;
  }

  const settings = status.settings || {};
  const enabled = Boolean(settings.autoSyncEnabled);
  const enabledEl = $('#check24-auto-sync-enabled');
  const contentEl = $('#check24-auto-sync-content');
  const intervalEl = $('#check24-auto-sync-interval');
  const masterEl = $('#check24-auto-sync-master');
  if (enabledEl) enabledEl.checked = enabled;
  if (masterEl) masterEl.checked = enabled;
  updateCheck24AutoSyncMasterLabel(enabled);
  if (contentEl) {
    contentEl.checked = Boolean(settings.autoSyncContent) && enabled;
    contentEl.disabled = !enabled;
  }
  $('#check24-auto-sync-content-row')?.classList.toggle('is-disabled', !enabled);
  if (intervalEl) {
    const minutes = String(settings.intervalMinutes ?? 30);
    if (![...intervalEl.options].some((o) => o.value === minutes)) {
      const opt = document.createElement('option');
      opt.value = minutes;
      opt.textContent = minutes;
      intervalEl.appendChild(opt);
    }
    intervalEl.value = minutes;
  }

  const lastAuto = check24FmtTs(settings.lastAutoSyncAt);
  const lastAutoEl = $('#check24-settings-last-auto');
  if (lastAutoEl) {
    lastAutoEl.innerHTML = `${fonioSvgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', 14)} <span>${esc(lastAuto || t('check24.none'))}</span>`;
  }

  const autoHint = $('#check24-auto-sync-hint');
  if (autoHint) {
    const parts = [
      settings.autoSyncEnabled
        ? t('check24.autoSyncNext', { minutes: String(settings.intervalMinutes ?? 30) })
        : t('check24.autoSyncOff'),
    ];
    if (lastAuto) parts.push(t('check24.autoSyncLast', { time: lastAuto }));
    autoHint.innerHTML = `${fonioSvgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>', 14)} <span>${esc(parts.join(' · '))}</span>`;
  }

  applyRoleUi();
}

$('#check24-sync-settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const intervalMinutes = Number($('#check24-auto-sync-interval').value);
  if (
    !Number.isFinite(intervalMinutes) ||
    intervalMinutes < 5 ||
    intervalMinutes > 1440
  ) {
    notify.error(t('check24.autoSyncIntervalInvalid'));
    return;
  }
  const enabled =
    Boolean($('#check24-auto-sync-master')?.checked) ||
    Boolean($('#check24-auto-sync-enabled')?.checked);
  try {
    await api('/check24/sync/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        autoSyncEnabled: enabled,
        autoSyncContent: $('#check24-auto-sync-content').checked,
        intervalMinutes,
      }),
    });
    notify.success(t('check24.autoSyncSaved'));
    await loadCheck24();
  } catch (ex) {
    notify.error(ex.message);
  }
});

$('#check24-refresh-btn')?.addEventListener('click', () => {
  loadCheck24().catch((ex) => notify.error(ex.message));
});

$('#check24-flow')?.addEventListener('click', (e) => {
  const toggle = e.target.closest?.('.check24-pipe-toggle');
  if (!toggle) return;
  check24PipeExpanded = !check24PipeExpanded;
  const status = check24Cache.status;
  const connected =
    Boolean(status?.enabled) &&
    Boolean(status?.configured) &&
    Boolean(status?.ping?.ok);
  renderCheck24Pipeline(connected);
});

$('#check24-sync-btn')?.addEventListener('click', async () => {
  const el = $('#check24-action-result');
  try {
    setCheck24Syncing(true);
    const data = await api('/check24/sync', {
      method: 'POST',
      body: JSON.stringify({ content: true, availability: true, rates: true }),
    });
    if (data.started === false) {
      setCheck24Syncing(false);
      el.textContent = t('check24.syncAlready');
      notify.info(t('check24.syncAlready'));
      await loadCheck24();
    } else {
      el.textContent = t('check24.syncStarted');
      notify.success(t('check24.syncStarted'));
    }
  } catch (ex) {
    setCheck24Syncing(false);
    el.textContent = ex.message;
    notify.error(ex.message);
  }
});

$('#check24-webhook-btn')?.addEventListener('click', async () => {
  const el = $('#check24-action-result');
  try {
    const data = await api('/check24/webhooks/bookings/register', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    el.textContent = t('check24.webhookOk', { url: data.url || '' });
    notify.success(t('check24.webhookOk', { url: data.url || '' }));
  } catch (ex) {
    el.textContent = ex.message;
    notify.error(ex.message);
  }
});

$('#check24-poll-btn')?.addEventListener('click', async () => {
  const el = $('#check24-action-result');
  try {
    const data = await api('/check24/bookings/poll', { method: 'POST' });
    el.textContent = t('check24.pollOk', {
      processed: String(data.processed ?? 0),
    });
    notify.success(el.textContent);
    loadCheck24().catch(() => {});
  } catch (ex) {
    el.textContent = ex.message;
    notify.error(ex.message);
  }
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  navigator.clipboard.writeText(btn.dataset.copy);
  const toast = btn.parentElement?.querySelector('.copy-toast');
  if (!toast) return;
  toast.textContent = t('common.copied');
  toast.classList.add('show');
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => toast.classList.remove('show'), 2000);
});

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

if (token) {
  restoreSession().then((ok) => {
    if (ok) showApp();
  });
}
