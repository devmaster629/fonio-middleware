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
    const rows = (Array.isArray(plans) ? plans : [])
      .map((plan) => {
        const res = plan.reservation || {};
        return `<tr>
          <td>#${esc(String(res.hostawayId ?? ''))}</td>
          <td>${esc(res.guestName || '–')}</td>
          <td>${esc(res.listingName || '–')}</td>
          <td class="cell-money">${esc(formatMoney(plan.installmentAmount, plan.currency))}</td>
          <td>${esc(freqLabel(plan.frequency))}</td>
          <td class="cell-money">${esc(formatMoney(plan.nextDueAmount, plan.currency))}</td>
          <td>${plan.nextDueAt ? esc(formatDate(plan.nextDueAt)) : '–'}</td>
          <td class="cell-money">${esc(formatMoney(plan.paidTowardPlan, plan.currency))}</td>
          <td>
            <button type="button" class="btn ghost btn-sm payment-plan-edit-btn" data-hostaway-id="${esc(String(res.hostawayId))}">
              ${t('payments.plansEdit')}
            </button>
          </td>
        </tr>`;
      })
      .join('');
    list.innerHTML = `
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
        <tbody>${rows || `<tr><td colspan="9">${t('payments.plansNone')}</td></tr>`}</tbody>
      </table>`;
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
    const frequency = plan?.frequency || 'MONTHLY';
    const nextDueAt = plan?.nextDueAt ? String(plan.nextDueAt).slice(0, 10) : '';
    editor.classList.remove('hidden');
    editor.innerHTML = `
      <div class="payment-plan-editor-card">
        <div class="payment-plan-editor-meta">
          <strong>#${esc(String(hostawayId))}</strong>
          ${reservation.guestName ? ` · ${esc(reservation.guestName)}` : ''}
          ${reservation.totalPrice != null ? ` · ${esc(formatMoney(reservation.totalPrice))}` : ''}
          ${
            reservation.arrivalDate
              ? ` · ${esc(formatDate(reservation.arrivalDate))} → ${esc(formatDate(reservation.departureDate))}`
              : ''
          }
        </div>
        <form id="payment-plan-editor-form" class="payment-plan-editor-form" data-hostaway-id="${esc(String(hostawayId))}">
          <div class="payment-plan-grid">
            <label class="checkbox-row">
              <input type="checkbox" name="enabled" ${plan?.enabled !== false ? 'checked' : ''} ${canEdit ? '' : 'disabled'} />
              <span>${t('payments.plansEnabled')}</span>
            </label>
            <label>
              <span>${t('payments.plansInstallment')}</span>
              <input type="number" name="installmentAmount" min="0.01" step="0.01" required value="${plan?.installmentAmount ?? ''}" ${canEdit ? '' : 'disabled'} />
            </label>
            <label>
              <span>${t('payments.plansFrequency')}</span>
              <select name="frequency" ${canEdit ? '' : 'disabled'}>${paymentPlanFrequencyOptions(frequency)}</select>
            </label>
            <label class="payment-plan-custom-days${frequency === 'CUSTOM' ? '' : ' hidden'}">
              <span>${t('payments.plansCustomDays')}</span>
              <input type="number" name="customIntervalDays" min="1" max="365" value="${plan?.customIntervalDays ?? ''}" ${canEdit ? '' : 'disabled'} />
            </label>
            <label>
              <span>${t('payments.plansNextDue')}</span>
              <input type="number" name="nextDueAmount" min="0" step="0.01" value="${plan?.nextDueAmount ?? plan?.installmentAmount ?? ''}" ${canEdit ? '' : 'disabled'} />
            </label>
            <label>
              <span>${t('payments.plansNextDueAt')}</span>
              <input type="date" name="nextDueAt" value="${esc(nextDueAt)}" ${canEdit ? '' : 'disabled'} />
            </label>
            <label>
              <span>${t('payments.plansPaidToward')}</span>
              <input type="number" name="paidTowardPlan" min="0" step="0.01" value="${plan?.paidTowardPlan ?? 0}" ${canEdit ? '' : 'disabled'} />
            </label>
            <label>
              <span>${t('payments.plansCurrency')}</span>
              <input type="text" name="currency" maxlength="8" value="${esc(plan?.currency || 'EUR')}" ${canEdit ? '' : 'disabled'} />
            </label>
          </div>
          <label>
            <span>${t('payments.plansNote')}</span>
            <textarea name="note" rows="2" maxlength="2000" ${canEdit ? '' : 'disabled'}>${esc(plan?.note || '')}</textarea>
          </label>
          <div class="form-action-btns">
            ${
              canEdit && plan
                ? `<button type="button" class="btn ghost danger" id="payment-plan-delete">${t('payments.plansDelete')}</button>`
                : ''
            }
            ${
              canEdit
                ? `<button type="submit" class="btn primary">${t('payments.plansSave')}</button>`
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

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!canEdit) return;
      const fd = new FormData(form);
      const body = {
        enabled: form.querySelector('[name="enabled"]')?.checked === true,
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
        await api(`/payments/payment-plans/${hostawayId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        notify.success(t('payments.plansSaved'));
        await loadPaymentPlans();
        await openPaymentPlanEditor(hostawayId);
      } catch (ex) {
        notify.error(ex.message);
      }
    });

    $('#payment-plan-delete')?.addEventListener('click', async () => {
      if (!canEdit) return;
      const ok = await notify.confirm(t('payments.plansDeleteConfirm'), {
        confirmLabel: t('payments.plansDelete'),
      });
      if (!ok) return;
      try {
        await api(`/payments/payment-plans/${hostawayId}`, { method: 'DELETE' });
        notify.success(t('payments.plansDeleted'));
        editor.classList.add('hidden');
        editor.innerHTML = '';
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
