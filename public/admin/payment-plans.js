/* Installment payment plans — Admin → Payments → Payment plans */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function freqLabel(frequency) {
    const key = `payments.plansFreq.${frequency}`;
    const label = t(key);
    return label === key ? frequency : label;
  }

  function paymentPlanFrequencyOptions(selected) {
    return ['MONTHLY', 'SEMI_MONTHLY', 'WEEKLY', 'CUSTOM']
      .map(
        (f) =>
          `<option value="${f}"${f === selected ? ' selected' : ''}>${esc(
            freqLabel(f),
          )}</option>`,
      )
      .join('');
  }

  window.loadPaymentPlans = async function loadPaymentPlans() {
    const list = $('#payment-plans-list');
    if (!list) return;
    const canEdit = hasPermission('PAYMENTS_ADMIN');
    $('#payment-plans-readonly-hint')?.classList.toggle('hidden', canEdit);
    const plans = await api('/payments/payment-plans?limit=200');
    const planList = Array.isArray(plans) ? plans : [];
    const countEl = $('#payment-plans-active-count');
    if (countEl) countEl.textContent = String(planList.length);

    if (!planList.length) {
      list.innerHTML = `
        <div class="payment-plans-empty">
          <span class="payment-plans-empty-icon" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
          </span>
          <p class="payment-plans-empty-title">${t('payments.plansNone')}</p>
          <p class="payment-plans-empty-hint">${t('payments.plansEmptyHint')}</p>
        </div>`;
      return;
    }

    const rows = planList
      .map((plan) => {
        const res = plan.reservation || {};
        return `<tr>
          <td data-label="${esc(t('payments.plansColReservation'))}">#${esc(String(res.hostawayId ?? ''))}</td>
          <td data-label="${esc(t('listings.guest'))}">${esc(res.guestName || '–')}</td>
          <td data-label="${esc(t('listings.name'))}">${esc(res.listingName || '–')}</td>
          <td class="cell-money" data-label="${esc(t('payments.plansInstallment'))}">${esc(formatMoney(plan.installmentAmount, plan.currency))}</td>
          <td data-label="${esc(t('payments.plansFrequency'))}">${esc(freqLabel(plan.frequency))}</td>
          <td class="cell-money" data-label="${esc(t('payments.plansNextDue'))}">${esc(formatMoney(plan.nextDueAmount, plan.currency))}</td>
          <td data-label="${esc(t('payments.plansNextDueAt'))}">${plan.nextDueAt ? esc(formatDate(plan.nextDueAt)) : '–'}</td>
          <td class="cell-money" data-label="${esc(t('payments.plansPaidToward'))}">${esc(formatMoney(plan.paidTowardPlan, plan.currency))}</td>
          <td>
            <button type="button" class="btn ghost btn-sm payment-plan-edit-btn" data-hostaway-id="${esc(String(res.hostawayId))}">
              ${t('payments.plansEdit')}
            </button>
          </td>
        </tr>`;
      })
      .join('');
    list.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>${t('payments.plansColReservation')}</th>
            <th>${t('listings.guest')}</th>
            <th>${t('listings.name')}</th>
            <th>${t('payments.plansInstallment')}</th>
            <th>${t('payments.plansFrequency')}</th>
            <th>${t('payments.plansNextDue')}</th>
            <th>${t('payments.plansNextDueAt')}</th>
            <th>${t('payments.plansPaidToward')}</th>
            <th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    $$('.payment-plan-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idInput = $('#payment-plan-hostaway-id');
        if (idInput) idInput.value = btn.dataset.hostawayId || '';
        openPaymentPlanEditor(Number(btn.dataset.hostawayId));
      });
    });
    if (typeof scheduleEnhanceResponsiveTables === 'function') {
      scheduleEnhanceResponsiveTables();
    }
  };

  window.renderPaymentPlanEditor = function renderPaymentPlanEditor(payload) {
    const editor = $('#payment-plan-editor');
    if (!editor) return;
    const canEdit = hasPermission('PAYMENTS_ADMIN');
    const reservation = payload?.reservation || {};
    const plan = payload?.plan || null;
    const hostawayId = reservation.hostawayId;
    const currency = plan?.currency || 'EUR';
    const frequency = plan?.frequency || 'MONTHLY';
    const nextDueAt = plan?.nextDueAt ? String(plan.nextDueAt).slice(0, 10) : '';
    const paidToward = plan?.paidTowardPlan ?? 0;

    function formatStayDate(iso) {
      if (!iso) return '';
      try {
        return new Intl.DateTimeFormat(locale(), {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        }).format(new Date(iso));
      } catch {
        return formatDate(iso);
      }
    }

    const stayLabel =
      reservation.arrivalDate
        ? `${formatStayDate(reservation.arrivalDate)} – ${formatStayDate(reservation.departureDate)}`
        : '–';

    const iconDoc = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>`;
    const iconCal = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
    const iconWallet = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7H10a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Z"/><path d="M16 12h.01"/><path d="M6 7V5a2 2 0 0 1 2-2h8"/></svg>`;

    function closeEditor() {
      editor.classList.add('hidden');
      editor.innerHTML = '';
    }

    editor.classList.remove('hidden');
    editor.innerHTML = `
      <div class="payment-plan-editor-card">
        <div class="payment-plan-editor-top">
          <div class="payment-plan-editor-heading">
            <h3>${t('payments.plansEditorTitle')}</h3>
            <p class="payment-plan-editor-subtitle">
              #${esc(String(hostawayId))}${reservation.guestName ? ` · ${esc(reservation.guestName)}` : ''}
            </p>
          </div>
          <div class="payment-plan-editor-top-actions">
            <label class="payment-plan-enabled-toggle">
              <span>${t('payments.plansEnabledShort')}</span>
              <span class="toggle-switch payment-plan-toggle">
                <input type="checkbox" name="enabled" form="payment-plan-editor-form" ${plan?.enabled !== false ? 'checked' : ''} ${canEdit ? '' : 'disabled'} />
                <span class="toggle-slider" aria-hidden="true"></span>
              </span>
            </label>
            <div class="payment-plan-menu">
              <button type="button" class="btn icon-btn ghost payment-plan-menu-btn" id="payment-plan-menu-toggle" aria-label="${esc(t('payments.plansMore'))}" aria-expanded="false" ${canEdit && plan ? '' : 'disabled'}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
              </button>
              <div class="payment-plan-menu-dropdown hidden" id="payment-plan-menu-dropdown">
                <button type="button" class="payment-plan-menu-item is-danger" id="payment-plan-delete">${t('payments.plansDelete')}</button>
              </div>
            </div>
          </div>
        </div>

        <div class="payment-plan-summary">
          <div class="payment-plan-summary-item">
            <span class="payment-plan-summary-icon">${iconDoc}</span>
            <div class="payment-plan-summary-copy">
              <span class="payment-plan-summary-label">${t('payments.plansBookingTotal')}</span>
              <span class="payment-plan-summary-value">${esc(formatMoney(reservation.totalPrice, currency))}</span>
            </div>
          </div>
          <div class="payment-plan-summary-item">
            <span class="payment-plan-summary-icon">${iconCal}</span>
            <div class="payment-plan-summary-copy">
              <span class="payment-plan-summary-label">${t('payments.plansStay')}</span>
              <span class="payment-plan-summary-value">${esc(stayLabel)}</span>
            </div>
          </div>
          <div class="payment-plan-summary-item">
            <span class="payment-plan-summary-icon">${iconWallet}</span>
            <div class="payment-plan-summary-copy">
              <span class="payment-plan-summary-label">${t('payments.plansPaidToward')}</span>
              <span class="payment-plan-summary-value">${esc(formatMoney(paidToward, currency))}</span>
              <span class="payment-plan-summary-hint">${t('payments.plansPaidTowardHint')}</span>
            </div>
          </div>
        </div>

        <form id="payment-plan-editor-form" class="payment-plan-editor-form" data-hostaway-id="${esc(String(hostawayId))}">
          <input type="hidden" name="paidTowardPlan" value="${paidToward}" />
          <input type="hidden" name="currency" value="${esc(currency)}" />
          <div class="payment-plan-grid">
            <label>
              <span>${t('payments.plansInstallment')}</span>
              <span class="payment-plan-input-affix">
                <input type="number" name="installmentAmount" min="0.01" step="0.01" required value="${plan?.installmentAmount ?? ''}" ${canEdit ? '' : 'disabled'} />
                <span class="payment-plan-affix">${esc(currency)}</span>
              </span>
            </label>
            <label>
              <span>${t('payments.plansFrequency')}</span>
              <select name="frequency" ${canEdit ? '' : 'disabled'}>${paymentPlanFrequencyOptions(frequency)}</select>
            </label>
            <label>
              <span>${t('payments.plansNextDue')}</span>
              <span class="payment-plan-input-affix">
                <input type="number" name="nextDueAmount" min="0" step="0.01" value="${plan?.nextDueAmount ?? plan?.installmentAmount ?? ''}" ${canEdit ? '' : 'disabled'} />
                <span class="payment-plan-affix">${esc(currency)}</span>
              </span>
            </label>
            <label>
              <span>${t('payments.plansNextDueAt')}</span>
              <input type="date" name="nextDueAt" value="${esc(nextDueAt)}" ${canEdit ? '' : 'disabled'} />
            </label>
          </div>
          <label class="payment-plan-custom-days${frequency === 'CUSTOM' ? '' : ' hidden'}">
            <span>${t('payments.plansCustomDays')}</span>
            <input type="number" name="customIntervalDays" min="1" max="365" value="${plan?.customIntervalDays ?? ''}" ${canEdit ? '' : 'disabled'} />
          </label>
          <label class="payment-plan-note-field">
            <span>${t('payments.plansNote')}</span>
            <textarea name="note" rows="3" maxlength="2000" placeholder="${esc(t('payments.plansNotePlaceholder'))}" ${canEdit ? '' : 'disabled'}>${esc(plan?.note || '')}</textarea>
          </label>
          <div class="payment-plan-editor-actions">
            <button type="button" class="btn ghost" id="payment-plan-cancel">${t('payments.plansCancel')}</button>
            ${
              canEdit
                ? `<button type="submit" class="btn primary">${t('payments.plansSavePaymentPlan')}</button>`
                : ''
            }
          </div>
        </form>
      </div>`;

    const form = $('#payment-plan-editor-form');
    const freqSelect = form?.querySelector('[name="frequency"]');
    const customWrap = form?.querySelector('.payment-plan-custom-days');
    freqSelect?.addEventListener('change', () => {
      customWrap?.classList.toggle('hidden', freqSelect.value !== 'CUSTOM');
    });

    $('#payment-plan-cancel')?.addEventListener('click', () => closeEditor());

    const menuToggle = $('#payment-plan-menu-toggle');
    const menuDropdown = $('#payment-plan-menu-dropdown');
    menuToggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menuToggle.disabled) return;
      const open = !menuDropdown?.classList.contains('hidden');
      menuDropdown?.classList.toggle('hidden', open);
      menuToggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    menuDropdown?.addEventListener('click', (e) => e.stopPropagation());
    const onDocClick = () => {
      menuDropdown?.classList.add('hidden');
      menuToggle?.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDocClick);
    };
    setTimeout(() => document.addEventListener('click', onDocClick), 0);

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!canEdit) return;
      const fd = new FormData(form);
      const enabledInput =
        form.querySelector('[name="enabled"]') ||
        document.querySelector('input[name="enabled"][form="payment-plan-editor-form"]');
      const body = {
        enabled: enabledInput?.checked === true,
        installmentAmount: Number(fd.get('installmentAmount')),
        frequency: String(fd.get('frequency') || 'MONTHLY'),
        customIntervalDays:
          fd.get('frequency') === 'CUSTOM' && fd.get('customIntervalDays') !== ''
            ? Number(fd.get('customIntervalDays'))
            : null,
        nextDueAmount:
          fd.get('nextDueAmount') === ''
            ? undefined
            : Number(fd.get('nextDueAmount')),
        nextDueAt: fd.get('nextDueAt') ? String(fd.get('nextDueAt')) : null,
        paidTowardPlan:
          fd.get('paidTowardPlan') === ''
            ? undefined
            : Number(fd.get('paidTowardPlan')),
        currency: String(fd.get('currency') || 'EUR'),
        note: String(fd.get('note') || '').trim() || null,
      };
      try {
        const result = await api(`/payments/payment-plans/${hostawayId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        const autoApplied = Number(result?.rematch?.autoApplied) || 0;
        notify.success(
          autoApplied > 0
            ? t('payments.plansSavedRematch', { n: autoApplied })
            : t('payments.plansSaved'),
        );
        closeEditor();
        await loadPaymentPlans();
      } catch (ex) {
        notify.error(ex.message);
      }
    });

    $('#payment-plan-delete')?.addEventListener('click', async () => {
      if (!canEdit || !plan) return;
      const ok = await notify.confirm(t('payments.plansDeleteConfirm'), {
        confirmLabel: t('payments.plansDelete'),
      });
      if (!ok) return;
      try {
        const result = await api(`/payments/payment-plans/${hostawayId}`, {
          method: 'DELETE',
        });
        const restored = Number(result?.restored?.undone) || 0;
        notify.success(
          restored > 0
            ? t('payments.plansDeletedRestored', { n: restored })
            : t('payments.plansDeleted'),
        );
        closeEditor();
        await loadPaymentPlans();
      } catch (ex) {
        notify.error(ex.message);
      }
    });

    if (typeof setControlsDisabled === 'function') {
      setControlsDisabled(editor, !canEdit);
    }
  };

  window.openPaymentPlanEditor = async function openPaymentPlanEditor(hostawayId) {
    if (!Number.isFinite(hostawayId) || hostawayId <= 0) {
      notify.error(t('payments.plansInvalidId'));
      return;
    }
    try {
      const payload = await api(`/payments/payment-plans/${hostawayId}`);
      renderPaymentPlanEditor(payload);
    } catch (ex) {
      notify.error(ex.message);
    }
  };

  document.getElementById('payment-plan-lookup')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = Number(document.getElementById('payment-plan-hostaway-id')?.value);
    openPaymentPlanEditor(id);
  });
})();
