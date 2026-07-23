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
let cachedRules = [];
let cachedListings = [];
let cachedConditionSchema = null;
let editingRuleId = null;
let editingUserId = null;
let editingListingAliases = null;
let dashboardPoll = null;
let syncSettingsDirty = false;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const tableState = {
  listings: { page: 1, pageSize: 10, search: '', sortBy: 'name', sortDir: 'asc' },
  groups: { page: 1, pageSize: 10, search: '', sortBy: 'name', sortDir: 'asc' },
  reservations: { page: 1, pageSize: 10, search: '', sortBy: 'arrivalDate', sortDir: 'desc' },
  conversations: { page: 1, pageSize: 10, search: '' },
  rules: { page: 1, pageSize: 10, search: '', sortBy: 'priority', sortDir: 'asc' },
  requests: { page: 1, pageSize: 10, search: '', sortBy: 'createdAt', sortDir: 'desc' },
  payments: { page: 1, pageSize: 10, search: '', sortBy: 'createdAt', sortDir: 'desc' },
  paymentsHistory: { page: 1, pageSize: 10, search: '', sortBy: 'createdAt', sortDir: 'desc' },
  logs: { page: 1, pageSize: 10, search: '', sortBy: 'createdAt', sortDir: 'desc' },
  webhooks: { page: 1, pageSize: 10, search: '' },
  users: { page: 1, pageSize: 10, search: '', sortBy: 'createdAt', sortDir: 'desc' },
  fonioActivity: { page: 1, pageSize: 25, search: '', sortBy: 'createdAt', sortDir: 'desc', actionFilter: '' },
};
const searchTimers = {};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDateTime(value) {
  if (!value) return '–';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
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
  const canListingsEdit = hasPermission('LISTINGS_EDIT');
  const canRequestsManage = hasPermission('REQUESTS_MANAGE');

  const syncBtn = $('#sync-btn');
  syncBtn?.toggleAttribute('disabled', !canSyncRun);
  if (syncBtn) {
    syncBtn.title = canSyncRun ? '' : t('dashboard.syncReadonly');
  }
  setControlsDisabled($('#sync-settings-form'), !canSyncSettings);
  $('#sync-settings-readonly-hint')?.classList.toggle('hidden', canSyncSettings);

  setControlsDisabled($('#log-settings-form'), !canLogSettings);
  $('#log-purge-now-btn')?.toggleAttribute('disabled', !canLogSettings);
  $('#log-settings-readonly-hint')?.classList.toggle('hidden', canLogSettings);

  setControlsDisabled($('#rule-form'), !canRulesEdit, {
    exceptIds: canRulesDelete && editingRuleId ? ['rule-delete-btn'] : [],
  });
  $('#rule-new-btn')?.toggleAttribute('disabled', !canRulesEdit);
  $('#rule-new-btn')?.classList.toggle('hidden', !canRulesEdit);
  $('#rule-delete-btn')?.classList.toggle('hidden', !canRulesDelete || !editingRuleId);

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
  $('#verification-readonly-hint')?.classList.toggle('hidden', canRulesEdit);

  $('#inbox-backfill-btn')?.toggleAttribute('disabled', !canConversationsManage);
  $('#inbox-backfill-btn')?.classList.toggle('hidden', !canConversationsManage);

  $$('.listing-aliases-edit').forEach((btn) => {
    btn.classList.toggle('hidden', !canListingsEdit);
  });
  $$('.payment-confirm-btn, .payment-skip-btn, .payment-assign-select, .payment-assign-manual, .payment-retry-btn').forEach((el) => {
    el.toggleAttribute('disabled', !canPaymentsReview);
    if (el.matches('button')) el.classList.toggle('hidden', !canPaymentsReview);
  });
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

  if (!hasPermission(NAV_PERMISSIONS[activeTab] || 'DASHBOARD_VIEW')) {
    const first = [...$$('.nav-btn')].find((b) => !b.classList.contains('hidden'));
    activeTab = first?.dataset.tab || 'dashboard';
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
    $$('.tab').forEach((tab) => tab.classList.add('hidden'));
    $(`#tab-${activeTab}`)?.classList.remove('hidden');
  }
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
    users: loadUsers,
  };
  updateRuleSelects();
  loaders[activeTab]?.();
}

function manageDashboardPoll() {
  if (dashboardPoll) clearInterval(dashboardPoll);
  dashboardPoll = null;
  if (activeTab === 'dashboard' && token) {
    dashboardPoll = setInterval(() => {
      if (activeTab === 'dashboard') loadDashboard();
    }, 5000);
  }
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
  return params.toString();
}

function sortIndicator(tabKey, column) {
  const s = tableState[tabKey];
  if (s.sortBy !== column) return '';
  return s.sortDir === 'asc' ? ' ▲' : ' ▼';
}

function sortTh(tabKey, column, label) {
  return `<th class="sortable" data-sort="${column}" role="button" tabindex="0">${label}${sortIndicator(tabKey, column)}</th>`;
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

function ensureTableToolbar(toolbarId, tabKey, loader) {
  const el = $(toolbarId);
  if (!el) return;
  if (el.dataset.toolbarInit === tabKey) return;
  el.dataset.toolbarInit = tabKey;
  const s = tableState[tabKey];
  el.innerHTML = `
    <div class="table-length">
      <label>
        ${t('table.show')}
        <select data-table-length="${tabKey}">
          ${PAGE_SIZE_OPTIONS.map((n) =>
            `<option value="${n}"${n === s.pageSize ? ' selected' : ''}>${n}</option>`,
          ).join('')}
        </select>
        ${t('table.entries')}
      </label>
    </div>
    <div class="table-filter">
      <label>
        ${t('table.search')}
        <input type="search" data-table-search="${tabKey}" value="${esc(s.search)}" autocomplete="off" />
      </label>
    </div>
  `;
  el.querySelector(`[data-table-length="${tabKey}"]`)?.addEventListener('change', (e) => {
    tableState[tabKey].pageSize = Number(e.target.value);
    tableState[tabKey].page = 1;
    loader();
  });
  el.querySelector(`[data-table-search="${tabKey}"]`)?.addEventListener('input', (e) => {
    clearTimeout(searchTimers[tabKey]);
    searchTimers[tabKey] = setTimeout(() => {
      tableState[tabKey].search = e.target.value;
      tableState[tabKey].page = 1;
      loader();
    }, 300);
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

function renderPagination(containerId, data, tabKey, loader) {
  const el = $(containerId);
  if (!el || !data) return;
  const { page, totalPages } = data;
  const pages = buildPageList(page, totalPages);
  el.innerHTML = `
    <div class="paginate" role="navigation" aria-label="Pagination">
      <button type="button" class="page-btn prev" data-page="prev" ${page <= 1 ? 'disabled' : ''} aria-label="Previous">‹</button>
      ${pages.map((p) => {
        if (p === '…') return `<span class="page-btn ellipsis">…</span>`;
        return `<button type="button" class="page-btn${p === page ? ' active' : ''}" data-page="${p}">${p}</button>`;
      }).join('')}
      <button type="button" class="page-btn next" data-page="next" ${page >= totalPages ? 'disabled' : ''} aria-label="Next">›</button>
    </div>
  `;
  el.querySelector('[data-page="prev"]')?.addEventListener('click', () => {
    if (page > 1) { tableState[tabKey].page = page - 1; loader(); }
  });
  el.querySelector('[data-page="next"]')?.addEventListener('click', () => {
    if (page < totalPages) { tableState[tabKey].page = page + 1; loader(); }
  });
  el.querySelectorAll('[data-page]').forEach((btn) => {
    if (btn.dataset.page === 'prev' || btn.dataset.page === 'next') return;
    btn.addEventListener('click', () => {
      tableState[tabKey].page = Number(btn.dataset.page);
      loader();
    });
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

function renderConversationMessage(message) {
  const incoming = message.isIncoming === 1;
  const direction = incoming ? t('conversations.incoming') : t('conversations.outgoing');
  return `
    <div class="conversation-msg ${incoming ? 'incoming' : 'outgoing'}">
      <div class="meta">
        <span class="channel">${channelLabel(message.communicationType)}</span>
        <span>${direction}</span>
        <span>${formatMessageDate(message.insertedOn)}</span>
      </div>
      <div class="message-body">${formatMessageContent(message)}</div>
    </div>
  `;
}

function updateRuleSelects() {
  const types = [
    'ADD_GUEST', 'ADD_PET', 'CANCELLATION', 'MODIFICATION',
    'EARLY_CHECKIN', 'LATE_CHECKOUT', 'RESERVATION_QUESTION', 'OTHER',
  ];
  const modes = ['AUTO', 'MANUAL', 'DENY'];
  const typeSel = $('#rule-type');
  const modeSel = $('#rule-mode');
  if (!typeSel || !modeSel) return;
  const curType = typeSel.value;
  const curMode = modeSel.value;
  typeSel.innerHTML = types.map((v) =>
    `<option value="${v}">${t(`requestType.${v}`)}</option>`,
  ).join('');
  modeSel.innerHTML = modes.map((v) =>
    `<option value="${v}">${t(`mode.${v}`)}</option>`,
  ).join('');
  typeSel.value = types.includes(curType) ? curType : types[0];
  modeSel.value = modes.includes(curMode) ? curMode : modes[0];
  syncRuleModeForType();
  renderRuleConditionsPanel();
}

function syncRuleModeForType() {
  const type = $('#rule-type')?.value;
  const modeSel = $('#rule-mode');
  if (!modeSel) return;
  const autoOpt = modeSel.querySelector('option[value="AUTO"]');
  if (autoOpt) autoOpt.disabled = type === 'CANCELLATION';
  if (type === 'CANCELLATION' && modeSel.value === 'AUTO') modeSel.value = 'MANUAL';
}

function renderRuleConditionsPanel() {
  const panel = $('#rule-conditions-panel');
  const note = $('#rule-conditions-note');
  const fields = $('#rule-conditions-fields');
  if (!panel || !note || !fields) return;

  const type = $('#rule-type')?.value;
  const mode = $('#rule-mode')?.value;
  const schema = cachedConditionSchema?.[type];
  const showAuto = mode === 'AUTO' && type !== 'CANCELLATION';

  panel.classList.toggle('hidden', !schema && !showAuto);
  note.classList.add('hidden');
  fields.innerHTML = '';

  if (!schema) return;

  if (schema.noteKey) {
    note.textContent = t(schema.noteKey);
    note.classList.remove('hidden');
  }

  if (!showAuto) {
    panel.classList.remove('hidden');
    return;
  }

  panel.classList.remove('hidden');
  fields.innerHTML = (schema.fields || []).map((field) => {
    const id = `rule-cond-${field.key}`;
    const label = t(field.labelKey);
    const hint = field.hintKey ? t(field.hintKey) : '';
    if (field.type === 'boolean') {
      return `
        <label class="checkbox-row">
          <input type="checkbox" id="${id}" data-cond-key="${field.key}" data-cond-type="boolean" />
          <span><strong>${label}</strong>${hint ? `<br><span class="field-hint">${esc(hint)}</span>` : ''}</span>
        </label>`;
    }
    const inputType = field.type === 'time' ? 'time' : 'number';
    const step = field.type === 'time' ? '' : ' min="1"';
    const defaultVal = field.default ?? '';
    return `
      <label class="cond-field">
        <span>${label}</span>
        <input type="${inputType}" id="${id}" data-cond-key="${field.key}" data-cond-type="${field.type}"${step} value="${defaultVal}" />
        ${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}
      </label>`;
  }).join('');
}

function buildConditionsFromForm() {
  const mode = $('#rule-mode')?.value;
  const type = $('#rule-type')?.value;
  if (mode !== 'AUTO' || type === 'CANCELLATION') return undefined;

  const schema = cachedConditionSchema?.[type];
  if (!schema?.fields?.length) return undefined;

  const conditions = {};
  schema.fields.forEach((field) => {
    const el = $(`#rule-cond-${field.key}`);
    if (!el) return;
    if (field.type === 'boolean') {
      if (el.checked) conditions[field.key] = true;
      return;
    }
    const val = el.value?.trim();
    if (val) conditions[field.key] = field.type === 'number' ? Number(val) : val;
  });
  return Object.keys(conditions).length ? conditions : {};
}

function loadConditionsIntoForm(conditions) {
  const type = $('#rule-type')?.value;
  renderRuleConditionsPanel();
  const schema = cachedConditionSchema?.[type];
  if (!schema?.fields) return;
  const c = conditions || {};
  schema.fields.forEach((field) => {
    const el = $(`#rule-cond-${field.key}`);
    if (!el) return;
    if (field.type === 'boolean') {
      el.checked = Boolean(c[field.key]);
    } else if (c[field.key] !== undefined && c[field.key] !== null) {
      el.value = String(c[field.key]);
    }
  });
}

$('#rule-type')?.addEventListener('change', () => {
  syncRuleModeForType();
  renderRuleConditionsPanel();
});
$('#rule-mode')?.addEventListener('change', renderRuleConditionsPanel);

$$('.lang-select').forEach((sel) => {
  sel.addEventListener('change', () => setLang(sel.value));
});

document.addEventListener('langchange', () => {
  resetTableToolbars();
  refreshActiveTab();
  updateRuleFormUI();
  renderRuleConditionsPanel();
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

$$('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    activateTab(btn.dataset.tab);
  });
});

$('#auto-sync-enabled')?.addEventListener('change', () => {
  syncSettingsDirty = true;
});
$('#auto-sync-interval')?.addEventListener('input', () => {
  syncSettingsDirty = true;
});

$('#sync-settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const intervalMinutes = Number($('#auto-sync-interval').value);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
    notify.error(t('dashboard.autoSyncIntervalInvalid'));
    return;
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
    notify.success(t('dashboard.autoSyncSaved'));
    loadDashboard();
  } catch (ex) {
    notify.error(ex.message);
  }
});

$('#sync-btn').addEventListener('click', async () => {
  const el = $('#sync-result');
  el.innerHTML = `<p>${t('dashboard.syncRunning')}</p>`;
  $('#sync-btn').disabled = true;
  try {
    const data = await api('/sync', { method: 'POST' });
    if (!data.started) {
      el.innerHTML = `<p class="field-hint">${t('dashboard.syncAlreadyRunning')}</p>`;
      notify.info(t('dashboard.syncAlreadyRunning'));
    } else {
      el.innerHTML = `<p>${t('dashboard.syncStarted')}</p>`;
      notify.success(t('dashboard.syncStarted'));
    }
    loadDashboard();
  } catch (ex) {
    el.innerHTML = `<p class="error">${t('dashboard.syncError', { message: ex.message })}</p>`;
    notify.error(t('dashboard.syncError', { message: ex.message }));
  } finally {
    $('#sync-btn').disabled = !hasPermission('SYNC_RUN');
  }
});

$('#rule-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!hasPermission('RULES_EDIT')) {
    notify.error(t('perms.featureLocked'));
    return;
  }
  const payload = {
    requestType: $('#rule-type').value,
    mode: $('#rule-mode').value,
    listingId: $('#rule-listing').value || null,
    priority: Number($('#rule-priority').value),
    isActive: $('#rule-active').checked,
  };
  const conditions = buildConditionsFromForm();
  if (conditions !== undefined) payload.conditions = conditions;
  try {
    if (editingRuleId) {
      await api(`/rules/${editingRuleId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify.success(t('rules.updated'));
    } else {
      await api('/rules', { method: 'POST', body: JSON.stringify(payload) });
      notify.success(t('rules.created'));
    }
    await loadRules();
  } catch (ex) {
    notify.error(t('rules.error', { message: ex.message }));
  }
});

$('#rule-new-btn').addEventListener('click', resetRuleForm);

$('#rule-delete-btn').addEventListener('click', async () => {
  if (!editingRuleId || !hasPermission('RULES_DELETE')) return;
  const ok = await notify.confirm(t('rules.deleteConfirm'), {
    title: t('rules.deleteTitle'),
    okLabel: t('rules.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/rules/${editingRuleId}`, { method: 'DELETE' });
    notify.success(t('rules.deleted'));
    resetRuleForm();
    await loadRules();
  } catch (ex) {
    notify.error(t('rules.error', { message: ex.message }));
  }
});

function updateRuleFormUI() {
  const title = $('#rule-form-title');
  const submit = $('#rule-submit-btn');
  if (title) title.textContent = editingRuleId ? t('rules.editRule') : t('rules.newRule');
  if (submit) submit.textContent = editingRuleId ? t('rules.updateRule') : t('rules.addRule');
  $('#rule-delete-btn')?.classList.toggle('hidden', !editingRuleId || !hasPermission('RULES_DELETE'));
  applyRoleUi();
}

function resetRuleForm() {
  if (!hasPermission('RULES_EDIT')) return;
  editingRuleId = null;
  $('#rule-id').value = '';
  $('#rule-type').value = 'ADD_GUEST';
  $('#rule-mode').value = 'MANUAL';
  $('#rule-listing').value = '';
  $('#rule-priority').value = 0;
  $('#rule-active').checked = true;
  syncRuleModeForType();
  renderRuleConditionsPanel();
  updateRuleFormUI();
  highlightSelectedRule(null);
}

function loadRuleIntoForm(rule) {
  editingRuleId = rule.id;
  $('#rule-id').value = rule.id;
  $('#rule-type').value = rule.requestType;
  $('#rule-mode').value = rule.mode;
  $('#rule-listing').value = rule.listingId || '';
  $('#rule-priority').value = rule.priority;
  $('#rule-active').checked = rule.isActive !== false;
  syncRuleModeForType();
  loadConditionsIntoForm(rule.conditions);
  updateRuleFormUI();
  highlightSelectedRule(rule.id);
}

function populateListingSelect() {
  const sel = $('#rule-listing');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">${t('rules.global')}</option>` +
    cachedListings.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  sel.value = current;
}

function highlightSelectedRule(ruleId) {
  $$('#rules-table tbody tr').forEach((row) => {
    row.classList.toggle('selected', ruleId && row.dataset.ruleId === ruleId);
  });
}

function bindRuleRowClicks() {
  $$('#rules-table tbody tr[data-rule-id]').forEach((row) => {
    row.addEventListener('click', () => {
      if (!hasPermission('RULES_EDIT')) return;
      const rule = cachedRules.find((r) => r.id === row.dataset.ruleId);
      if (rule) loadRuleIntoForm(rule);
    });
  });
}

async function loadDashboard() {
  const [status, webhooks] = await Promise.all([
    api('/sync/status'),
    api('/sync/webhook-activity'),
  ]);
  const last = status.last;
  const settings = status.settings;
  const syncLabel = formatSyncPhase(last, status.inProgress);
  const syncTime = formatSyncTime(last, status.inProgress);
  $('#stats').innerHTML = `
    <div class="stat-card"><div class="value">${status.listingCount}</div><div class="label">${t('dashboard.listings')}</div></div>
    <div class="stat-card"><div class="value">${status.reservationCount}</div><div class="label">${t('dashboard.reservations')}</div></div>
    <div class="stat-card"><div class="value">${esc(syncLabel)}</div><div class="label">${t('dashboard.lastSync')}</div></div>
    <div class="stat-card"><div class="value">${syncTime}</div><div class="label">${t('dashboard.syncTime')}</div></div>
  `;
  if (last?.status === 'completed' && last.metadata) {
    const meta = last.metadata;
    $('#sync-result').innerHTML = `<p class="success">✓ ${t('dashboard.syncDone', {
      listings: meta.listings ?? status.listingCount,
      reservations: meta.reservations ?? status.reservationCount,
    })}</p>`;
  }
  if (!syncSettingsDirty) {
    $('#auto-sync-enabled').checked = settings?.autoSyncEnabled ?? true;
    $('#auto-sync-interval').value = settings?.intervalMinutes ?? 30;
  }
  $('#auto-sync-hint').textContent = settings?.autoSyncEnabled
    ? t('dashboard.autoSyncNext', { minutes: settings.intervalMinutes })
    : t('dashboard.autoSyncOff');

  ensureTableToolbar('#webhooks-toolbar', 'webhooks', loadDashboard);
  const webhookData = paginateClient(webhooks, 'webhooks', (w) => [
    w.startedAt,
    w.jobType,
    w.status,
    JSON.stringify(w.metadata || {}),
    w.error || '',
  ].join(' '));
  const whRows = webhookData.items.map((w) => {
    const meta = w.metadata || {};
    const result = w.status === 'completed'
      ? `${meta.listings ?? 0} ${t('dashboard.listings')}, ${meta.reservations ?? 0} ${t('dashboard.reservations')}`
      : w.error || w.status;
    return `<tr>
      <td>${formatDateTime(w.startedAt)}</td>
      <td>${esc(w.jobType.replace('webhook:', ''))}</td>
      <td>${esc(String(result))}</td>
    </tr>`;
  }).join('');
  $('#webhook-activity').innerHTML = `
    <table><thead><tr>
      <th>${t('dashboard.webhookCol.time')}</th>
      <th>${t('dashboard.webhookCol.event')}</th>
      <th>${t('dashboard.webhookCol.result')}</th>
    </tr></thead>
    <tbody>${whRows || `<tr><td colspan="3">${t('dashboard.webhookEmpty')}</td></tr>`}</tbody></table>`;
  renderTableInfo('#webhooks-info', webhookData, webhookData.maxTotal);
  renderPagination('#webhooks-pagination', webhookData, 'webhooks', loadDashboard);
  applyRoleUi();
}

async function loadListings() {
  ensureTableToolbar('#listings-toolbar', 'listings', loadListings);
  const data = await api(`/listings?${tableQuery('listings')}`);
  cachedListings = data.items || [];
  const rows = cachedListings.map((l) => {
    const aliasText = (l.aliases && l.aliases.length)
      ? esc(l.aliases.join(', '))
      : `<span class="muted">${t('listings.aliasesEmpty')}</span>`;
    const editBtn = hasPermission('LISTINGS_EDIT')
      ? `<button type="button" class="btn ghost btn-sm listing-aliases-edit" data-id="${esc(l.id)}">${t('listings.aliasesEdit')}</button>`
      : '';
    return `
    <tr>
      <td>${l.hostawayId}</td>
      <td>${esc(l.name)}</td>
      <td class="listing-aliases-cell">${aliasText}</td>
      <td>${esc(l.city || '–')}</td>
      <td>${esc(l.listingGroup?.name || '–')}</td>
      <td>${l.personCapacity}</td>
      <td><span class="badge live">${l.status}</span></td>
      <td>${l.isBookable ? t('common.yes') : t('common.no')}</td>
      <td>${editBtn}</td>
    </tr>
  `;
  }).join('');
  $('#listings-table').innerHTML = `
    <table><thead><tr>
      ${sortTh('listings', 'hostawayId', t('listings.id'))}
      ${sortTh('listings', 'name', t('listings.name'))}
      <th>${t('listings.aliases')}</th>
      ${sortTh('listings', 'city', t('listings.city'))}
      <th>${t('listings.group')}</th>
      ${sortTh('listings', 'personCapacity', t('listings.guests'))}
      ${sortTh('listings', 'status', t('listings.status'))}
      <th>${t('listings.bookable')}</th>
      <th></th>
    </tr></thead><tbody>${rows || `<tr><td colspan="9">${t('table.infoEmpty')}</td></tr>`}</tbody></table>`;
  bindSortableHeaders('#listings-table', 'listings', loadListings);
  $$('.listing-aliases-edit').forEach((btn) => {
    btn.addEventListener('click', () => openListingAliasesModal(btn.dataset.id));
  });
  renderTableInfo('#listings-info', data);
  renderPagination('#listings-pagination', data, 'listings', loadListings);
  applyRoleUi();
}

function parseAliasesInput(raw) {
  return [...new Set(
    raw.split(/[,;\n]+/).map((s) => s.trim()).filter((s) => s.length >= 2),
  )].slice(0, 30);
}

function openListingAliasesModal(listingId) {
  const listing = cachedListings.find((l) => l.id === listingId);
  if (!listing) return;
  editingListingAliases = { id: listing.id, name: listing.name };
  $('#listing-aliases-modal-listing').textContent = listing.name;
  $('#listing-aliases-input').value = (listing.aliases || []).join(', ');
  $('#listing-aliases-modal').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeListingAliasesModal() {
  editingListingAliases = null;
  $('#listing-aliases-modal').classList.add('hidden');
  document.body.classList.remove('modal-open');
}

$('#listing-aliases-cancel')?.addEventListener('click', closeListingAliasesModal);
$('#listing-aliases-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'listing-aliases-modal') closeListingAliasesModal();
});
$('#listing-aliases-save')?.addEventListener('click', async () => {
  if (!editingListingAliases || !hasPermission('LISTINGS_EDIT')) return;
  try {
    const aliases = parseAliasesInput($('#listing-aliases-input').value);
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
  ensureTableToolbar('#groups-toolbar', 'groups', loadGroups);
  const data = await api(`/listing-groups?${tableQuery('groups')}`);
  const rows = data.items.map((g) => `
    <tr>
      <td>${g.hostawayParentId}</td>
      <td>${esc(g.name)}</td>
      <td>${esc(g.city || '–')}</td>
      <td>${g.availabilityMode}</td>
      <td>${g.listings?.length ?? 0}</td>
      <td>${(g.listings || []).map((l) => esc(l.name)).join(', ') || '–'}</td>
    </tr>
  `).join('');
  $('#listing-groups-table').innerHTML = `
    <table><thead><tr>
      ${sortTh('groups', 'hostawayParentId', 'ID')}
      ${sortTh('groups', 'name', t('listings.name'))}
      ${sortTh('groups', 'city', t('listings.city'))}
      <th>Mode</th><th>#</th><th>${t('listings.title')}</th>
    </tr></thead><tbody>${rows || `<tr><td colspan="6">${t('table.infoEmpty')}</td></tr>`}</tbody></table>`;
  bindSortableHeaders('#listing-groups-table', 'groups', loadGroups);
  renderTableInfo('#groups-info', data);
  renderPagination('#groups-pagination', data, 'groups', loadGroups);
}

async function loadReservations() {
  ensureTableToolbar('#reservations-toolbar', 'reservations', loadReservations);
  const data = await api(`/reservations?${tableQuery('reservations')}`);
  const rows = data.items.map((r) => `
    <tr>
      <td>${r.hostawayId}</td>
      <td>${esc(r.guestName || r.guestNameMasked || '–')}</td>
      <td>${esc(r.guestPhone || '–')}</td>
      <td>${esc(r.guestEmail || '–')}</td>
      <td>${esc(r.listing?.name || '–')}</td>
      <td>${esc(r.listing?.listingGroup?.name || '–')}</td>
      <td>${formatDate(r.arrivalDate)}</td>
      <td>${formatDate(r.departureDate)}</td>
      <td>${r.status}</td>
    </tr>
  `).join('');
  $('#reservations-table').innerHTML = `
    <table><thead><tr>
      ${sortTh('reservations', 'hostawayId', 'ID')}
      ${sortTh('reservations', 'guestName', t('listings.guest'))}
      <th>${t('listings.phone')}</th><th>${t('listings.email')}</th>
      ${sortTh('reservations', 'listingName', t('listings.name'))}
      <th>${t('listings.group')}</th>
      ${sortTh('reservations', 'arrivalDate', t('listings.arrival'))}
      ${sortTh('reservations', 'departureDate', t('listings.departure'))}
      ${sortTh('reservations', 'status', t('listings.status'))}
    </tr></thead><tbody>${rows || `<tr><td colspan="9">${t('table.infoEmpty')}</td></tr>`}</tbody></table>`;
  bindSortableHeaders('#reservations-table', 'reservations', loadReservations);
  renderTableInfo('#reservations-info', data);
  renderPagination('#reservations-pagination', data, 'reservations', loadReservations);
}

async function loadConversations() {
  ensureTableToolbar('#conversations-toolbar', 'conversations', loadConversations);
  const data = await api(`/reservations?${tableQuery('conversations')}`);
  const canManageConversations = hasPermission('CONVERSATIONS_MANAGE');
  const rows = data.items.map((r) => `
    <tr>
      <td>${r.hostawayId}</td>
      <td>${esc(r.guestName || '–')}</td>
      <td>${esc(r.listing?.name || '–')}</td>
      <td>${r.hostawayConversationId ?? '–'}</td>
      <td>${r.lastSyncedAt ? formatDateTime(r.lastSyncedAt) : '–'}</td>
      <td>
        <button type="button" class="btn ghost btn-sm" data-view-conv="${r.hostawayId}">${t('conversations.view')}</button>
        ${canManageConversations
          ? `<button type="button" class="btn ghost btn-sm" data-refresh-conv="${r.hostawayId}">${t('conversations.refresh')}</button>`
          : ''}
      </td>
    </tr>
  `).join('');
  $('#conversations-table').innerHTML = `
    <table><thead><tr>
      <th>ID</th><th>${t('listings.guest')}</th><th>${t('listings.name')}</th>
      <th>${t('listings.conversation')}</th><th>${t('conversations.synced')}</th><th></th>
    </tr></thead><tbody>${rows || `<tr><td colspan="6">${t('table.infoEmpty')}</td></tr>`}</tbody></table>`;
  renderTableInfo('#conversations-info', data);
  renderPagination('#conversations-pagination', data, 'conversations', loadConversations);
  bindConversationButtons();
  applyRoleUi();
}

function bindConversationButtons() {
  $$('[data-view-conv]').forEach((btn) => {
    btn.addEventListener('click', () => openConversationModal(btn.dataset.viewConv));
  });
  $$('[data-refresh-conv]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const result = await api(`/reservations/${btn.dataset.refreshConv}/refresh-conversation`, { method: 'POST' });
        notify.success(t('conversations.refreshed', { id: result.hostawayConversationId || '–' }));
        loadConversations();
      } catch (ex) {
        notify.error(ex.message);
      }
    });
  });
}

async function openConversationModal(hostawayId) {
  const modal = $('#conversation-modal');
  const body = $('#conversation-modal-body');
  $('#conversation-modal-title').textContent = `${t('nav.conversations')} #${hostawayId}`;
  body.innerHTML = `<p>${t('dashboard.syncRunning')}</p>`;
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
  try {
    const result = await api(`/reservations/${hostawayId}/conversation`);
    if (!result.hostawayConversationId) {
      body.innerHTML = `<p class="field-hint">${t('conversations.none')}</p>`;
      return;
    }
    const msgs = (result.messages || []).map((m) => renderConversationMessage(m)).join('');
    body.innerHTML = `
      <p><strong>${t('listings.conversation')}:</strong> ${result.hostawayConversationId}</p>
      ${msgs || `<p>${t('conversations.noMessages')}</p>`}`;
  } catch (ex) {
    body.innerHTML = `<p class="error">${esc(ex.message)}</p>`;
  }
}

$('#conversation-modal-close').addEventListener('click', () => {
  $('#conversation-modal').classList.add('hidden');
  document.body.classList.remove('modal-open');
});
$('#conversation-modal').addEventListener('click', (e) => {
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

function renderVerificationForm(config, fieldMeta) {
  const container = $('#verification-field-checkboxes');
  if (!container) return;
  const selected = new Set(normalizeVerificationFields(config?.requiredFields));
  const canRulesEdit = hasPermission('RULES_EDIT');
  $('#verification-config-id').value = config?.id ?? '';
  $('#verification-min-match').value = config?.minMatchCount ?? 3;
  $('#verification-min-match').max = VERIFICATION_FIELDS.length;
  const offerCb = $('#verification-booking-offer');
  if (offerCb) offerCb.checked = config?.bookingOfferEnabled !== false;
  renderVerificationPromptPreview(config?.fonioPrompt);

  container.innerHTML = VERIFICATION_FIELDS.map((field) => {
    const locked = field === 'stayDates';
    const checked = locked || selected.has(field);
    const disabled = locked || !canRulesEdit;
    const label = t(`verification.field.${field}`);
    const hint = fieldMeta?.descriptions?.[field] ?? '';
    return `
      <label class="checkbox-row verification-field-row${locked ? ' locked' : ''}">
        <input type="checkbox" name="verification-field" value="${field}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
        <span>
          <strong>${label}</strong>
          ${locked ? `<em class="field-hint">(${t('verification.field.stayDatesLocked')})</em>` : ''}
          ${hint ? `<br><span class="field-hint">${esc(hint)}</span>` : ''}
        </span>
      </label>`;
  }).join('');
}

function renderVerificationPromptPreview(prompt) {
  const box = $('#verification-prompt-preview');
  const script = $('#verification-guest-script');
  const block = $('#verification-instructions-block');
  if (!box || !script || !block) return;
  if (!prompt?.guestScriptDe) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  script.value = prompt.guestScriptDe;
  block.value = prompt.verificationInstructionsDe ?? '';
  $('#verification-copy-script')?.replaceWith($('#verification-copy-script').cloneNode(true));
  $('#verification-copy-block')?.replaceWith($('#verification-copy-block').cloneNode(true));
  $('#verification-copy-script')?.addEventListener('click', () => {
    navigator.clipboard.writeText(script.value);
    notify.success(t('common.copied'));
  });
  $('#verification-copy-block')?.addEventListener('click', () => {
    navigator.clipboard.writeText(block.value);
    notify.success(t('common.copied'));
  });
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
    await api(`/verification-config/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(getVerificationFormData()),
    });
    notify.success(t('verification.saved'));
    loadRules();
  } catch (ex) {
    notify.error(ex.message);
  }
});

async function loadRules() {
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

  ensureTableToolbar('#rules-toolbar', 'rules', loadRules);
  const data = paginateClient(rules, 'rules', (r) => [
    r.requestType,
    r.mode,
    r.listing?.name,
    r.priority,
    r.isActive,
  ].join(' '));
  const rows = data.items.map((r) => `
    <tr data-rule-id="${r.id}">
      <td>${t(`requestType.${r.requestType}`) || r.requestType}</td>
      <td><span class="badge ${r.mode === 'AUTO' ? 'auto' : r.mode === 'DENY' ? 'manual' : 'manual'}">${t(`mode.${r.mode}`) || r.mode}</span></td>
      <td>${r.listing?.name || t('rules.global')}</td>
      <td>${r.priority}</td>
      <td>${r.isActive ? t('rules.active') : t('rules.inactive')}</td>
    </tr>
  `).join('');
  $('#rules-table').innerHTML = `
    <table><thead><tr>
      <th>${t('rules.col.type')}</th><th>${t('rules.col.mode')}</th><th>${t('rules.col.listing')}</th>
      <th>${t('rules.col.priority')}</th><th>${t('rules.col.status')}</th>
    </tr></thead><tbody>${rows || `<tr><td colspan="5">${t('rules.none')}</td></tr>`}</tbody></table>`;
  renderTableInfo('#rules-info', data, data.maxTotal);
  renderPagination('#rules-pagination', data, 'rules', loadRules);
  if (editingRuleId) {
    const current = rules.find((r) => r.id === editingRuleId);
    if (current) loadRuleIntoForm(current);
    else resetRuleForm();
  } else {
    updateRuleFormUI();
    renderRuleConditionsPanel();
  }
  bindRuleRowClicks();
  applyRoleUi();
}

async function loadRequests() {
  const requests = await api('/guest-requests');
  ensureTableToolbar('#requests-toolbar', 'requests', loadRequests);
  const data = paginateClient(requests, 'requests', (r) => [
    r.createdAt,
    r.requestType,
    r.status,
    r.reservation?.listing?.name,
    r.forwardedToHostaway,
  ].join(' '));
  const rows = data.items.map((r) => {
    const inboxCell = r.status === 'FORWARDED'
      ? (r.forwardedToHostaway
        ? t('requests.inboxYes')
        : (hasPermission('REQUESTS_MANAGE')
          ? `<button type="button" class="btn ghost btn-sm retry-forward-btn" data-request-id="${r.id}">${t('requests.retry')}</button> <span class="field-hint">${t('requests.inboxPending')}</span>`
          : `<span class="field-hint">${t('requests.inboxPending')}</span>`))
      : t('requests.inboxNa');
    return `
    <tr>
      <td>${formatDateTime(r.createdAt)}</td>
      <td>${t(`requestType.${r.requestType}`) || r.requestType}</td>
      <td><span class="badge manual">${r.status}</span></td>
      <td>${r.reservation?.listing?.name || '–'}</td>
      <td>${inboxCell}</td>
    </tr>`;
  }).join('');
  $('#requests-table').innerHTML = `
    <table><thead><tr>
      <th>${t('requests.time')}</th><th>${t('requests.type')}</th><th>${t('requests.status')}</th>
      <th>${t('requests.listing')}</th><th>${t('requests.hostaway')}</th>
    </tr></thead>
    <tbody>${rows || `<tr><td colspan="5">${t('requests.none')}</td></tr>`}</tbody></table>`;
  renderTableInfo('#requests-info', data, data.maxTotal);
  renderPagination('#requests-pagination', data, 'requests', loadRequests);
  $$('.retry-forward-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
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
  applyRoleUi();
}

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

function formatMoney(amount, currency = 'EUR') {
  if (amount == null || !Number.isFinite(Number(amount))) return '–';
  return `${Number(amount).toFixed(2)} ${currency}`;
}

function formatStayDates(arrival, departure) {
  if (!arrival && !departure) return '';
  return `${formatDate(arrival)}${departure ? ` → ${formatDate(departure)}` : ''}`;
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

function paymentDecisionLabel(decision) {
  if (!decision) return '–';
  const key = `payments.decision.${decision}`;
  const label = t(key);
  return label === key ? decision : label;
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
    reasonText.includes('outstanding balance') ||
    reasonText.includes('reservation total') ||
    reasonText.includes('deposit share') ||
    reasonText.includes('payment amount aligns');
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

  // Prefer a freshly built plain-language explanation over old "score 40" text.
  const stored = String(payment.matchReason || '');
  const looksLikeScoreJargon =
    /score|threshold|confidence too low|auto-apply/i.test(stored);
  if (stored && !looksLikeScoreJargon) return stored;

  const found = reasons.length
    ? t('payments.why.matchedOn', { signals: reasons.join('; ') })
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
  return `<a class="btn ghost btn-sm payment-open-hostaway ${extraClass}"
    href="${esc(url)}" target="_blank" rel="noopener noreferrer"
    data-hostaway-id="${idOrEmpty(hostawayId)}"
    title="${t('payments.openInHostawayHint')}">${t('payments.openInHostaway')}</a>`;
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
 */
function renderPaymentMath(payment, totalPrice, balanceDue, channelName, hostNote = null) {
  if (totalPrice == null && balanceDue == null) return '';
  const currency = payment?.currency || 'EUR';
  const amount = payment?.amount;
  const alreadyPaid =
    totalPrice != null && balanceDue != null
      ? Math.max(0, Math.round((totalPrice - balanceDue) * 100) / 100)
      : null;
  const kind = classifyPaymentKind(payment, totalPrice, balanceDue, channelName, hostNote);
  const remainingAfter =
    amount != null && balanceDue != null
      ? Math.max(0, Math.round((balanceDue - amount) * 100) / 100)
      : amount != null && totalPrice != null && alreadyPaid != null
        ? Math.max(0, Math.round((totalPrice - alreadyPaid - amount) * 100) / 100)
        : null;

  const lines = [];
  if (totalPrice != null) {
    lines.push(`${t('payments.bookingAmount')}: <strong>${esc(formatMoney(totalPrice, currency))}</strong>`);
  }
  if (alreadyPaid != null) {
    lines.push(`${t('payments.alreadyRecorded')}: ${esc(formatMoney(alreadyPaid, currency))}`);
  }
  if (balanceDue != null) {
    lines.push(`${t('payments.balanceDue')}: ${esc(formatMoney(balanceDue, currency))}`);
  }
  if (amount != null) {
    lines.push(`${t('payments.thisPayment')}: <strong>${esc(formatMoney(amount, currency))}</strong>`);
  }
  if (kind === 'partial' && remainingAfter != null) {
    lines.push(
      `${t('payments.remainingAfter')}: <strong>${esc(formatMoney(remainingAfter, currency))}</strong>`,
    );
  }

  let badge = '';
  let note = '';
  let boxClass = 'payment-math';
  if (kind === 'partial') {
    boxClass += ' is-partial';
    badge = `<span class="payment-kind-badge payment-partial-badge">${t('payments.partialPayment')}</span>`;
    note = `<div class="payment-kind-note">${t('payments.partialPaymentHint')}</div>`;
  } else if (kind === 'additional') {
    boxClass += ' is-additional';
    badge = `<span class="payment-kind-badge payment-additional-badge">${t('payments.additionalPayment')}</span>`;
    note = `<div class="payment-kind-note">${
      isOtaChannel(channelName)
        ? t('payments.additionalPaymentOta', { channel: prettyChannel(channelName) })
        : t('payments.additionalPaymentHint')
    }</div>`;
  } else if (kind === 'full') {
    boxClass += ' is-full';
    badge = `<span class="payment-kind-badge payment-full-badge">${t('payments.fullPayment')}</span>`;
  }

  return `<div class="${boxClass}">
    ${badge}
    <div class="payment-math-lines">${lines.join(' · ')}</div>
    ${note}
  </div>`;
}

function renderSuggestedReservation(reservation, candidate, currency = 'EUR', payment = null) {
  const src = reservation || candidate;
  if (!src) return '–';
  const hostawayId = reservation?.hostawayId ?? candidate?.hostawayId;
  const guest = reservation?.guestName ?? candidate?.guestName;
  const listing = reservation?.listing?.name ?? candidate?.listingName;
  const arrival = reservation?.arrivalDate ?? candidate?.arrivalDate;
  const departure = reservation?.departureDate ?? candidate?.departureDate;
  const totalPrice = reservation?.totalPrice ?? candidate?.totalPrice;
  const balanceDue = candidate?.balanceDue;
  const channelName = reservation?.channelName ?? candidate?.channelName ?? null;
  const hostNote = reservation?.hostNote ?? candidate?.hostNote ?? null;
  const reasons = Array.isArray(candidate?.reasons) ? candidate.reasons : [];
  const hostawayUrl = hostawayReservationUrl(hostawayId);
  const titleId = hostawayUrl
    ? `<a class="payment-hostaway-link" href="${esc(hostawayUrl)}" target="_blank" rel="noopener noreferrer" title="${t('payments.openInHostawayHint')}">#${hostawayId}</a>`
    : `#${hostawayId}`;
  const channelBadge = renderChannelBadge(channelName);
  const notesBlock = hostNote
    ? `<div class="field-hint payment-host-note"><strong>${t('payments.hostNote')}:</strong> ${renderExpandableText(hostNote, 90)}</div>`
    : '';

  return `<div class="payment-suggestion">
    <div class="payment-suggestion-title">${titleId}${guest ? ` — ${esc(guest)}` : ''}${channelBadge ? ` ${channelBadge}` : ''}</div>
    <div class="field-hint">${esc(listing || '–')}</div>
    <div class="field-hint">${t('payments.stay')}: ${esc(formatStayDates(arrival, departure) || '–')}</div>
    ${renderPaymentMath(payment, totalPrice, balanceDue, channelName, hostNote)}
    ${notesBlock}
    ${reasons.length ? `<div class="field-hint">${t('payments.matchSignals')}: ${renderExpandableText(reasons.join('; '), 60)}</div>` : ''}
  </div>`;
}

const reservationSearchCache = new Map();

function bindReservationSearchInputs() {
  $$('.payment-assign-manual').forEach((input) => {
    input.addEventListener('input', () => {
      const q = input.value.trim();
      const listId = input.getAttribute('list');
      const datalist = listId ? document.getElementById(listId) : null;
      if (!datalist || q.length < 2 || /^#?\d+$/.test(q)) return;
      clearTimeout(searchTimers[`res-search-${listId}`]);
      searchTimers[`res-search-${listId}`] = setTimeout(async () => {
        try {
          let items = reservationSearchCache.get(q);
          if (!items) {
            const res = await api(`/reservations?search=${encodeURIComponent(q)}&pageSize=20`);
            items = res.items || [];
            reservationSearchCache.set(q, items);
          }
          datalist.innerHTML = items.map((r) => {
            const total = r.totalPrice != null ? ` · ${formatMoney(r.totalPrice)}` : '';
            const dates = formatStayDates(r.arrivalDate, r.departureDate);
            const channel = r.channelName ? ` [${prettyChannel(r.channelName)}]` : '';
            return `<option value="#${r.hostawayId}${esc(channel)} — ${esc(r.guestName || '')} — ${esc(r.listing?.name || '')} — ${esc(dates)}${esc(total)}"></option>`;
          }).join('');
        } catch {
          /* search is best-effort */
        }
      }, 300);
    });
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
  const intervalEl = $('#qonto-status-interval');
  const btn = $('#qonto-poll-btn');
  if (!line) return;
  try {
    const status = await api('/payments/qonto-status');
    const last = status.last;
    const when = formatSyncTime(last, status.inProgress);
    let detail;
    let whenText = when;
    if (!status.enabled) {
      detail = t('payments.qontoDisabled');
      whenText = '–';
    } else if (!status.configured) {
      detail = t('payments.qontoNotConfigured');
      whenText = '–';
    } else if (status.inProgress || last?.status === 'running') {
      detail = t('payments.qontoRunning', { when });
      whenText = when;
    } else if (last?.status === 'failed') {
      detail = t('payments.qontoFailed', {
        when,
        error: last.error || '–',
      });
    } else if (last) {
      detail = t('payments.qontoLastOk', {
        when: '',
        meta: formatQontoPollMeta(last).replace(/^ — /, '') || t('payments.qontoInterval', { n: status.intervalMinutes || 5 }),
      });
    } else {
      detail = t('payments.qontoNever');
      whenText = '–';
    }
    if (whenEl) whenEl.textContent = whenText;
    line.textContent = detail;
    if (intervalEl) {
      intervalEl.textContent =
        status.enabled && status.configured
          ? t('payments.qontoInterval', { n: status.intervalMinutes || 5 })
          : '';
    }
    if (btn) {
      const canPoll =
        (hasPermission('PAYMENTS_ADMIN') || hasPermission('PAYMENTS_REVIEW')) &&
        status.enabled &&
        status.configured;
      btn.disabled = !canPoll || status.inProgress;
      btn.classList.toggle(
        'hidden',
        !(hasPermission('PAYMENTS_ADMIN') || hasPermission('PAYMENTS_REVIEW')),
      );
    }
  } catch (ex) {
    line.textContent = ex.message || t('payments.qontoStatusError');
    if (whenEl) whenEl.textContent = '–';
  }
}

$('#qonto-poll-btn')?.addEventListener('click', async () => {
  if (!hasPermission('PAYMENTS_ADMIN') && !hasPermission('PAYMENTS_REVIEW')) return;
  const btn = $('#qonto-poll-btn');
  const result = $('#qonto-poll-result');
  if (btn) btn.disabled = true;
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

function activateTab(tab) {
  if (!tab) return;
  const btn = $(`.nav-btn[data-tab="${tab}"]`);
  if (!btn || btn.classList.contains('hidden')) return;
  activeTab = tab;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach((el) => el.classList.add('hidden'));
  $(`#tab-${tab}`)?.classList.remove('hidden');
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.replaceState({}, '', url.toString());
  } catch {
    /* ignore */
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

async function loadPayments() {
  loadPaymentsHistory();
  loadQontoStatus();
  try {
    const response = await api('/payments/review-queue');
    const paymentList = Array.isArray(response) ? response : (response.items || []);
    ensureTableToolbar('#payments-toolbar', 'payments', loadPayments);
    const data = paginateClient(paymentList, 'payments', (p) => [
    p.createdAt,
    p.source,
    p.status,
    p.payerName,
    p.reference,
    p.matchedReservation?.listing?.name,
  ].join(' '));
  const rows = data.items.map((p) => {
    const reservation = p.matchedReservation;
    const candidates = Array.isArray(p.matchCandidates) ? p.matchCandidates : [];
    const bestCandidate =
      candidates.find((c) => Number(c.hostawayId) === Number(reservation?.hostawayId)) ||
      candidates[0];
    const seenIds = new Set();
    const assignOptions = [];
    for (const c of candidates) {
      const id = Number(c.hostawayId);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      const selected = reservation?.hostawayId && Number(reservation.hostawayId) === id ? ' selected' : '';
      assignOptions.push(
        `<option value="${id}"${selected}>${esc(formatReservationOption(c, p.currency))}</option>`,
      );
    }
    if (reservation?.hostawayId && !seenIds.has(Number(reservation.hostawayId))) {
      assignOptions.push(
        `<option value="${reservation.hostawayId}" selected>${esc(formatReservationOption({
          hostawayId: reservation.hostawayId,
          guestName: reservation.guestName,
          listingName: reservation.listing?.name,
          arrivalDate: reservation.arrivalDate,
          departureDate: reservation.departureDate,
          totalPrice: reservation.totalPrice,
        }, p.currency))}</option>`,
      );
    }
    const whyText = explainWhyNotAutoMatched(p);
    const whyNotAuto = whyText
      ? `<div class="payment-why-not-auto"><strong>${t('payments.whyNotAuto')}:</strong> ${renderExpandableText(whyText, 80)}</div>`
      : '';
    const canReview = hasPermission('PAYMENTS_REVIEW');
    const defaultOpenId =
      reservation?.hostawayId ||
      bestCandidate?.hostawayId ||
      (candidates[0] && candidates[0].hostawayId);
    const openHostawayBtn = renderOpenInHostawayButton(defaultOpenId);
    const actionsCell = canReview
      ? `<td class="payment-actions-cell">
        <select class="payment-assign-select" data-payment-id="${p.id}">
          <option value="">${t('payments.pickReservation')}</option>
          ${assignOptions.join('')}
        </select>
        <input type="text" class="payment-assign-manual" data-payment-id="${p.id}"
          list="payment-res-list-${p.id}" autocomplete="off"
          placeholder="${t('payments.manualReservationId')}"
          title="${t('payments.manualReservationHint')}" />
        <datalist id="payment-res-list-${p.id}"></datalist>
        <input type="text" class="payment-note-input" data-payment-id="${p.id}"
          autocomplete="off" maxlength="200"
          placeholder="${t('payments.notePlaceholder')}"
          title="${t('payments.noteHint')}"
          value="${esc(p.reference || '')}" />
        <div class="payment-action-btns">
          <button type="button" class="btn primary btn-sm payment-confirm-btn" data-payment-id="${p.id}">${t('payments.confirm')}</button>
          <button type="button" class="btn ghost btn-sm payment-skip-btn" data-payment-id="${p.id}">${t('payments.skip')}</button>
          ${openHostawayBtn}
        </div>
      </td>`
      : `<td class="payment-actions-cell is-readonly">
        ${openHostawayBtn || `<span class="muted feature-locked-hint">${t('perms.featureLocked')}</span>`}
      </td>`;
    return `
    <tr>
      <td>${formatDateTime(p.createdAt)}</td>
      <td>${p.source}</td>
      <td>${p.amount.toFixed(2)} ${p.currency}</td>
      <td>${esc(p.payerName || '–')}<br><span class="field-hint">${esc(p.reference || '')}</span></td>
      <td>
        <span class="badge manual">${esc(paymentDecisionLabel(p.matchDecision || p.status))}</span>
        ${whyNotAuto}
      </td>
      <td>${renderSuggestedReservation(reservation, bestCandidate, p.currency, p)}</td>
      ${actionsCell}
    </tr>`;
  }).join('');
  $('#payments-table').innerHTML = `
    <table><thead><tr>
      <th>${t('payments.time')}</th><th>${t('payments.source')}</th><th>${t('payments.amount')}</th>
      <th>${t('payments.payer')}</th><th>${t('payments.match')}</th><th>${t('payments.reservation')}</th><th>${t('payments.actions')}</th>
    </tr></thead>
    <tbody>${rows || `<tr><td colspan="7">${t('payments.none')}</td></tr>`}</tbody></table>`;
  renderTableInfo('#payments-info', data, data.maxTotal);
  renderPagination('#payments-pagination', data, 'payments', loadPayments);
  bindReservationSearchInputs();
  bindExpandableToggles('#payments-table');
  bindPaymentHostawayOpeners();

  $$('.payment-confirm-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!hasPermission('PAYMENTS_REVIEW')) return;
      const paymentId = btn.dataset.paymentId;
      const select = $(`.payment-assign-select[data-payment-id="${paymentId}"]`);
      const manual = $(`.payment-assign-manual[data-payment-id="${paymentId}"]`);
      const noteInput = $(`.payment-note-input[data-payment-id="${paymentId}"]`);
      const fromSelect = select?.value ? Number(select.value) : undefined;
      const fromManual = parseReservationIdInput(manual?.value);
      const reservationHostawayId = fromManual || fromSelect || undefined;
      const note = noteInput?.value?.trim() || undefined;
      try {
        await api(`/payments/${paymentId}/confirm`, {
          method: 'POST',
          body: JSON.stringify({ reservationHostawayId, note }),
        });
        notify.success(t('payments.confirmOk'));
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
  } catch (ex) {
    notify.error(ex.message);
    $('#payments-table').innerHTML = `<p class="error">${esc(ex.message)}</p>`;
  }
}

async function loadPaymentsHistory() {
  try {
    const response = await api('/payments?pageSize=100');
    const paymentList = Array.isArray(response) ? response : (response.items || []);
    ensureTableToolbar('#payments-history-toolbar', 'paymentsHistory', loadPaymentsHistory);
    const data = paginateClient(paymentList, 'paymentsHistory', (p) => [
      p.createdAt,
      p.source,
      p.status,
      p.payerName,
      p.reference,
      p.reviewedBy,
      p.matchedReservation?.listing?.name,
      p.matchedReservation?.hostawayId,
    ].join(' '));
    const rows = data.items.map((p) => {
      const reservation = p.matchedReservation;
      const reservationLabel = reservation
        ? `#${reservation.hostawayId} — ${esc(reservation.listing?.name || '')}`
        : '–';
      const retryBtn = (p.status === 'FAILED' || p.status === 'RECEIVED') && hasPermission('PAYMENTS_REVIEW')
        ? `<button type="button" class="btn ghost btn-sm payment-retry-btn" data-payment-id="${p.id}">${t('payments.retry')}</button>`
        : '';
      return `
      <tr>
        <td>${formatDateTime(p.createdAt)}</td>
        <td>${p.source}</td>
        <td>${p.amount.toFixed(2)} ${p.currency}</td>
        <td>${esc(p.payerName || '–')}<br><span class="field-hint">${esc(p.reference || '')}</span></td>
        <td>${paymentStatusBadge(p.status)}${p.error ? `<br><span class="field-hint">${esc(p.error)}</span>` : ''}</td>
        <td>${reservationLabel}</td>
        <td>${esc(p.reviewedBy || '–')} ${retryBtn}</td>
      </tr>`;
    }).join('');
    $('#payments-history-table').innerHTML = `
      <table><thead><tr>
        <th>${t('payments.time')}</th><th>${t('payments.source')}</th><th>${t('payments.amount')}</th>
        <th>${t('payments.payer')}</th><th>${t('payments.status')}</th><th>${t('payments.reservation')}</th><th>${t('payments.reviewedBy')}</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="7">${t('payments.historyNone')}</td></tr>`}</tbody></table>`;
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
  } catch (ex) {
    notify.error(ex.message);
    $('#payments-history-table').innerHTML = `<p class="error">${esc(ex.message)}</p>`;
  }
}

$('#inbox-backfill-btn')?.addEventListener('click', async () => {
  if (!hasPermission('CONVERSATIONS_MANAGE')) return;
  const btn = $('#inbox-backfill-btn');
  btn.disabled = true;
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
    btn.disabled = !hasPermission('CONVERSATIONS_MANAGE');
  }
});

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
}

['#log-debug-enabled', '#log-operational-enabled', '#log-pii-enabled'].forEach((sel) => {
  $(sel)?.addEventListener('change', syncLogRetentionInputs);
});

async function loadLogRetentionStatus() {
  const box = $('#log-retention-status');
  const list = $('#log-retention-status-list');
  const samplesEl = $('#log-retention-samples');
  if (!box || !list) return;
  try {
    const status = await api('/log-settings/status');
    box.classList.remove('hidden');
    const purgeOn = status.settings?.autoPurgeEnabled !== false;
    list.innerHTML = `
      <li>${t('logs.statusStored', { count: status.totalLogs ?? 0 })}</li>
      <li>${t('logs.statusExpired', { count: status.expiredLogs ?? 0 })}</li>
      <li>${purgeOn ? t('logs.statusPurgeOn', { when: formatDateTime(status.nextPurgeAt) }) : t('logs.statusPurgeOff')}</li>
      <li>${t('logs.statusPermanent')}</li>
    `;
    if (samplesEl && status.samples?.length) {
      const rows = status.samples.map((s) => `
        <tr>
          <td>${formatDateTime(s.createdAt)}</td>
          <td>${esc(s.source)} / <code>${esc(s.action)}</code></td>
          <td>${t(`logs.rule.${s.retentionRule}`)}</td>
          <td>${formatDateTime(s.expiresAt)}</td>
        </tr>
      `).join('');
      samplesEl.innerHTML = `
        <p class="field-hint">${t('logs.statusSamplesHint')}</p>
        <table class="meta-kv-table retention-samples-table">
          <thead><tr>
            <th>${t('logs.time')}</th>
            <th>${t('logs.source')}</th>
            <th>${t('logs.retentionRule')}</th>
            <th>${t('logs.deletesOn')}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    } else if (samplesEl) {
      samplesEl.innerHTML = '';
    }
  } catch {
    box.classList.add('hidden');
  }
}

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
    await loadLogSettings();
  } catch (ex) {
    notify.error(ex.message);
  }
});

$('#log-purge-now-btn')?.addEventListener('click', async () => {
  if (!hasPermission('LOG_SETTINGS_EDIT')) return;
  try {
    const result = await api('/log-settings/purge-expired', { method: 'POST' });
    notify.success(t('logs.purgeDone', { count: result.deleted ?? 0 }));
    await loadLogRetentionStatus();
    await loadLogs();
  } catch (ex) {
    notify.error(ex.message);
  }
});

async function loadLogs() {
  await loadLogSettings();
  const logs = await api('/logs');
  ensureTableToolbar('#logs-toolbar', 'logs', loadLogs);
  const data = paginateClient(logs, 'logs', (l) => [
    l.createdAt,
    l.source,
    l.action,
    l.statusCode,
    formatLogSummary(l),
  ].join(' '));
  const rows = data.items.map((l, idx) => `
    <tr>
      <td>${formatDateTime(l.createdAt)}</td>
      <td>${l.source}</td>
      <td><code>${esc(l.action)}</code></td>
      <td>${l.statusCode || '–'}</td>
      <td class="metadata-cell oneline" title="${esc(formatLogSummary(l))}">${esc(formatLogSummary(l))}</td>
      <td><button type="button" class="btn ghost btn-sm" data-log-detail="${idx}">${t('logs.viewDetails')}</button></td>
    </tr>
  `).join('');
  $('#logs-table').innerHTML = `
    <table><thead><tr>
      ${sortTh('logs', 'createdAt', t('logs.time'))}
      ${sortTh('logs', 'source', t('logs.source'))}
      ${sortTh('logs', 'action', t('logs.action'))}
      <th>${t('logs.status')}</th>
      <th>${t('logs.details')}</th>
      <th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  bindSortableHeaders('#logs-table', 'logs', loadLogs);
  renderTableInfo('#logs-info', data, data.maxTotal);
  renderPagination('#logs-pagination', data, 'logs', loadLogs);
  data.items.forEach((log, idx) => {
    $(`[data-log-detail="${idx}"]`)?.addEventListener('click', () => showLogDetail(log));
  });
}

function formatLogSummary(log) {
  const meta = log.metadata ?? {};
  if (typeof meta.middlewareAction === 'string' && meta.middlewareAction) {
    return truncateText(meta.middlewareAction, 100);
  }
  if (meta.outcomeDetail) {
    return truncateText(`${meta.outcome ?? 'result'}: ${meta.outcomeDetail}`, 100);
  }
  if (meta.event) return truncateText(meta.event, 100);
  if (meta.path) return truncateText(`${log.method ?? ''} ${meta.path}`.trim(), 100);
  if (meta.role) return truncateText(`${meta.role}${meta.adminId ? ` · ${meta.adminId.slice(0, 8)}…` : ''}`, 100);
  const parts = [];
  if (meta.verified === true) parts.push('verified');
  if (meta.verified === false) parts.push(`failed: ${meta.message ?? '?'}`);
  if (meta.reservationId) parts.push(`res#${meta.reservationId}`);
  if (meta.city) parts.push(meta.city);
  if (meta.availableCount !== undefined) parts.push(`${meta.availableCount} available`);
  if (meta.requestType) parts.push(meta.requestType);
  if (meta.status) parts.push(meta.status);
  if (parts.length) return truncateText(parts.join(' · '), 100);
  const keys = Object.keys(meta);
  if (!keys.length) return '–';
  return truncateText(keys.slice(0, 4).map((k) => `${k}=…`).join(' · '), 100);
}

function formatLogMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return '–';
  return JSON.stringify(metadata, null, 2);
}

function renderReadableFields(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
  const skip = new Set(['hintDe', 'guestScriptDe', 'verificationInstructionsDe']);
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

  if (res?.hintDe) {
    parts.push(`<h5>${t('logs.verificationRule')}</h5>`);
    parts.push(`<p class="modal-highlight">${esc(res.hintDe)}</p>`);
  } else if (res?.guestScriptDe) {
    parts.push(`<h5>${t('verification.guestScript')}</h5>`);
    parts.push(`<p class="modal-highlight">${esc(res.guestScriptDe)}</p>`);
  }

  parts.push(`<h5>${t('fonioActivity.responseSection')}</h5>`);
  if (res && typeof res === 'object') {
    parts.push(renderReadableFields(res));
  }
  parts.push(renderRawJsonDetails(t('logs.fullMetadata'), res));

  return parts.join('');
}

function showLogDetail(log) {
  const meta = log.metadata ?? {};
  const modal = $('#log-detail-modal');
  const body = $('#log-detail-modal-body');
  $('#log-detail-modal-title').textContent =
    `${t('logs.detailTitle')} — ${log.source} / ${log.action}`;
  body.innerHTML = `
    <p><strong>${t('logs.time')}:</strong> ${formatDateTime(log.createdAt)} · <strong>${t('logs.status')}:</strong> ${log.statusCode ?? '–'}${meta.callId ? ` · <strong>${t('fonioActivity.callId')}:</strong> ${esc(meta.callId)}` : ''}</p>
    <p><strong>${t('logs.summary')}:</strong> ${esc(formatLogSummary(log))}</p>
    ${renderModalMetadataSections(meta)}
  `;
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

$('#log-detail-modal-close')?.addEventListener('click', () => {
  $('#log-detail-modal').classList.add('hidden');
  document.body.classList.remove('modal-open');
});
$('#log-detail-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'log-detail-modal') {
    $('#log-detail-modal').classList.add('hidden');
    document.body.classList.remove('modal-open');
  }
});

async function loadFonioActivity() {
  const state = tableState.fonioActivity;
  const params = new URLSearchParams({ limit: '300' });
  if (state.actionFilter) params.set('action', state.actionFilter);
  const logs = await api(`/fonio-activity?${params}`);
  ensureFonioActivityToolbar(loadFonioActivity);
  const data = paginateClient(logs, 'fonioActivity', (l) => {
    const meta = l.metadata ?? {};
    return [
      l.createdAt,
      l.action,
      l.statusCode,
      meta.callId,
      meta.middlewareAction,
      meta.outcome,
      JSON.stringify(meta.requestReceived ?? {}),
      JSON.stringify(meta.responseRecorded ?? meta),
    ].join(' ');
  });
  const rows = data.items.map((l, idx) => {
    const meta = l.metadata ?? {};
    const summary = formatFonioActionSummary(l.action, meta);
    const requestText = formatFonioRequestSummary(meta.requestReceived, l.action, meta);
    const actionText = truncateText(meta.middlewareAction ?? '–', 80);
    const outcome = formatFonioOutcome(meta);
    return `
    <tr>
      <td>${formatDateTime(l.createdAt)}</td>
      <td><code>${esc(l.action)}</code></td>
      <td>${l.statusCode || '–'}</td>
      <td>${esc(meta.callId ?? '–')}</td>
      <td class="metadata-cell oneline" title="${esc(requestText)}">${esc(requestText)}</td>
      <td class="metadata-cell oneline" title="${esc(actionText)}">${esc(actionText)}</td>
      <td>${outcome}</td>
      <td>${summary}</td>
      <td><button type="button" class="btn ghost btn-sm" data-fonio-detail="${idx}">${t('fonioActivity.viewDetails')}</button></td>
    </tr>`;
  }).join('');
  $('#fonio-activity-table').innerHTML = `
    <table><thead><tr>
      ${sortTh('fonioActivity', 'createdAt', t('logs.time'))}
      ${sortTh('fonioActivity', 'action', t('fonioActivity.action'))}
      <th>${t('logs.status')}</th>
      <th>${t('fonioActivity.callId')}</th>
      <th>${t('fonioActivity.request')}</th>
      <th>${t('fonioActivity.middlewareAction')}</th>
      <th>${t('fonioActivity.outcome')}</th>
      <th>${t('fonioActivity.summary')}</th>
      <th></th>
    </tr></thead><tbody>${rows || `<tr><td colspan="9">${t('fonioActivity.none')}</td></tr>`}</tbody></table>`;
  bindSortableHeaders('#fonio-activity-table', 'fonioActivity', loadFonioActivity);
  renderTableInfo('#fonio-activity-info', data, data.maxTotal);
  renderPagination('#fonio-activity-pagination', data, 'fonioActivity', loadFonioActivity);
  data.items.forEach((log, idx) => {
    $(`[data-fonio-detail="${idx}"]`)?.addEventListener('click', () => showFonioActivityDetail(log));
  });
}

function ensureFonioActivityToolbar(loader) {
  ensureTableToolbar('#fonio-activity-toolbar', 'fonioActivity', loader);
  const el = $('#fonio-activity-toolbar');
  if (!el || el.dataset.fonioFilterInit) return;
  el.dataset.fonioFilterInit = '1';
  const filterWrap = document.createElement('div');
  filterWrap.className = 'table-filter';
  const actions = [
    '', 'call_context', 'availability_search', 'guest_verify',
    'guest_reservation', 'guest_request', 'booking_offer', 'verify_requirements',
  ];
  filterWrap.innerHTML = `
    <label>
      ${t('fonioActivity.filterAction')}
      <select id="fonio-activity-action-filter">
        <option value="">${t('fonioActivity.filterAll')}</option>
        ${actions.filter(Boolean).map((a) => `<option value="${a}">${a}</option>`).join('')}
      </select>
    </label>`;
  el.appendChild(filterWrap);
  const select = $('#fonio-activity-action-filter');
  select.value = tableState.fonioActivity.actionFilter;
  select.addEventListener('change', (e) => {
    tableState.fonioActivity.actionFilter = e.target.value;
    tableState.fonioActivity.page = 1;
    loader();
  });
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
  if (parts.length > 0) return truncateText(parts.join(' · '), 80);
  return truncateText(JSON.stringify(req), 80);
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

function showFonioActivityDetail(log) {
  const meta = log.metadata ?? {};
  const modal = $('#fonio-activity-modal');
  const body = $('#fonio-activity-modal-body');
  $('#fonio-activity-modal-title').textContent =
    `${t('fonioActivity.modalTitle')} — ${log.action}`;
  body.innerHTML = `
    <p><strong>${t('logs.time')}:</strong> ${formatDateTime(log.createdAt)} · <strong>${t('logs.status')}:</strong> ${log.statusCode ?? '–'} · <strong>${t('fonioActivity.callId')}:</strong> ${esc(meta.callId ?? '–')}</p>
    ${renderModalMetadataSections(meta)}
  `;
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

$('#fonio-activity-modal-close')?.addEventListener('click', () => {
  $('#fonio-activity-modal').classList.add('hidden');
  document.body.classList.remove('modal-open');
});
$('#fonio-activity-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'fonio-activity-modal') {
    $('#fonio-activity-modal').classList.add('hidden');
    document.body.classList.remove('modal-open');
  }
});

function formatFonioActionSummary(action, meta) {
  switch (action) {
    case 'call_context':
      return meta.caller_recognized ? t('fonioActivity.callerRecognized') : t('fonioActivity.callerUnknown');
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

function resetUserForm() {
  editingUserId = null;
  $('#user-id').value = '';
  $('#user-email').value = '';
  $('#user-email').removeAttribute('readonly');
  $('#user-password').value = '';
  $('#user-password').required = true;
  $('#user-role').value = 'BACK_OFFICE';
  $('#user-active').checked = true;
  $('#user-form-title').textContent = t('users.addUser');
  $('#user-submit-btn').textContent = t('users.addUser');
  $('#user-cancel-btn')?.classList.add('hidden');
  $('#user-delete-btn')?.classList.add('hidden');
  updateUserRowSelection(null);
}

function loadUserIntoForm(user) {
  editingUserId = user.id;
  $('#user-id').value = user.id;
  $('#user-email').value = user.email;
  $('#user-email').setAttribute('readonly', 'readonly');
  $('#user-password').value = '';
  $('#user-password').required = false;
  $('#user-role').value = ['BACK_OFFICE', 'ADMIN'].includes(user.role)
    ? user.role
    : 'BACK_OFFICE';
  $('#user-active').checked = user.isActive;
  $('#user-form-title').textContent = t('users.editUser');
  $('#user-submit-btn').textContent = t('users.save');
  $('#user-cancel-btn')?.classList.remove('hidden');
  $('#user-delete-btn')?.classList.toggle('hidden', !user.isActive);
  updateUserRowSelection(user.id);
}

function updateUserRowSelection(userId) {
  $$('#users-table tbody tr').forEach((row) => {
    row.classList.toggle('selected', userId && row.dataset.userId === userId);
  });
}

function bindUserRowClicks() {
  $$('#users-table tr[data-user-id]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.userId;
      const user = cachedUsers.find((u) => u.id === id);
      if (user && user.role !== 'SUPER_ADMIN') loadUserIntoForm(user);
    });
  });
}

let cachedUsers = [];

async function loadUsers() {
  if (!canSuperAdmin()) return;
  const users = await api('/users');
  cachedUsers = users;
  ensureTableToolbar('#users-toolbar', 'users', loadUsers);
  const data = paginateClient(users, 'users', (u) => [
    u.email,
    u.role,
    u.isActive,
    u.createdAt,
  ].join(' '));
  const rows = data.items.map((u) => `
    <tr data-user-id="${u.id}">
      <td>${esc(u.email)}</td>
      <td>${formatRoleLabel(u.role)}</td>
      <td>${u.isActive ? t('users.active') : t('users.inactive')}</td>
      <td>${formatDateTime(u.createdAt)}</td>
    </tr>
  `).join('');
  $('#users-table').innerHTML = `
    <table><thead><tr>
      <th>${t('users.col.email')}</th><th>${t('users.col.role')}</th><th>${t('users.col.status')}</th><th>${t('users.col.created')}</th>
    </tr></thead><tbody>${rows || `<tr><td colspan="4">${t('users.none')}</td></tr>`}</tbody></table>`;
  renderTableInfo('#users-info', data, data.maxTotal);
  renderPagination('#users-pagination', data, 'users', loadUsers);
  if (editingUserId) {
    const current = users.find((u) => u.id === editingUserId);
    if (current) loadUserIntoForm(current);
    else resetUserForm();
  }
  bindUserRowClicks();
  await loadRolePermissionsMatrix();
}

let cachedPermMatrix = null;

async function loadRolePermissionsMatrix() {
  if (!hasPermission('ROLE_PERMISSIONS_MANAGE') && adminRole !== 'SUPER_ADMIN') {
    $('#role-permissions-card')?.classList.add('hidden');
    return;
  }
  $('#role-permissions-card')?.classList.remove('hidden');
  try {
    cachedPermMatrix = await api('/role-permissions');
    renderRolePermissionCheckboxes();
  } catch (ex) {
    notify.error(ex.message);
  }
}

function renderRolePermissionCheckboxes() {
  const wrap = $('#perm-checkboxes');
  const role = $('#perm-role-select')?.value || 'BACK_OFFICE';
  if (!wrap || !cachedPermMatrix) return;
  const selected = new Set(cachedPermMatrix.matrix?.[role] || []);
  const catalog = cachedPermMatrix.catalog || [];
  const renderGroup = (group, titleKey) => {
    const items = catalog.filter((item) => item.group === group);
    return `
      <section class="perm-section">
        <h4 class="perm-section-title">${esc(t(titleKey))}</h4>
        <div class="perm-options">
          ${items.map((item) => `
            <label class="perm-option">
              <input type="checkbox" data-perm-key="${item.key}" ${selected.has(item.key) ? 'checked' : ''} />
              <span>${esc(t(item.labelKey) || item.key)}</span>
            </label>
          `).join('')}
        </div>
      </section>
    `;
  };
  wrap.innerHTML =
    renderGroup('pages', 'perms.pages') +
    renderGroup('actions', 'perms.actions');
}

$('#perm-role-select')?.addEventListener('change', () => renderRolePermissionCheckboxes());

$('#perm-save-btn')?.addEventListener('click', async () => {
  const role = $('#perm-role-select')?.value;
  if (!role) return;
  const permissions = [...$$('#perm-checkboxes input[data-perm-key]:checked')].map(
    (el) => el.dataset.permKey,
  );
  try {
    await api('/role-permissions', {
      method: 'PUT',
      body: JSON.stringify({ role, permissions }),
    });
    notify.success(t('perms.saved'));
    await loadRolePermissionsMatrix();
  } catch (ex) {
    notify.error(ex.message);
  }
});

$('#user-new-btn')?.addEventListener('click', () => resetUserForm());

$('#user-cancel-btn')?.addEventListener('click', () => resetUserForm());

$('#user-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#user-email').value.trim();
  const password = $('#user-password').value;
  const role = $('#user-role').value;
  const isActive = $('#user-active').checked;

  try {
    if (editingUserId) {
      const body = { role, isActive };
      if (password) body.password = password;
      await api(`/users/${editingUserId}`, { method: 'PATCH', body: JSON.stringify(body) });
      notify.success(t('users.saved'));
    } else {
      if (!password || password.length < 8) {
        notify.error(t('users.passwordRequired'));
        return;
      }
      await api('/users', {
        method: 'POST',
        body: JSON.stringify({ email, password, role }),
      });
      notify.success(t('users.created'));
      resetUserForm();
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
    t('users.deactivateTitle'),
    t('users.deactivateConfirm', { email: user.email }),
  );
  if (!ok) return;
  try {
    await api(`/users/${editingUserId}`, { method: 'DELETE' });
    notify.success(t('users.deactivated'));
    resetUserForm();
    loadUsers();
  } catch (ex) {
    notify.error(ex.message);
  }
});

async function loadFonio() {
  const data = await api('/fonio-setup');
  const renderUrls = (title, urls) => {
    const rows = Object.entries(urls).map(([key, url]) => `
      <div class="url-row">
        <div><strong>${key}</strong><br><code>${esc(url)}</code></div>
        <div class="copy-wrap">
          <span class="copy-toast">${t('common.copied')}</span>
          <button type="button" class="btn copy" data-copy="${esc(url)}">${t('common.copy')}</button>
        </div>
      </div>
    `).join('');
    return `<h3>${title}</h3>${rows}`;
  };
  const urls = data.production ?? data;
  $('#fonio-setup').innerHTML = `
    ${renderUrls(t('fonio.production'), urls)}
    <p style="margin-top:1rem;color:var(--muted);font-size:0.85rem">
      ${t('fonio.headerNote')} <code>x-api-key: &lt;FONIO_API_KEY&gt;</code>
    </p>
  `;
}

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
