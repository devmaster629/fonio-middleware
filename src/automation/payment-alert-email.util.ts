import { ExternalPaymentSource } from '@prisma/client';
import type { PaymentMatchCandidate } from './automation.types';

const BERLIN_TZ = 'Europe/Berlin';

export function formatAmountDe(amount: number, currency: string): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: currency || 'EUR',
  }).format(amount);
}

export function formatReceivedAtDe(date: Date): string {
  const day = new Intl.DateTimeFormat('de-DE', {
    timeZone: BERLIN_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
  const time = new Intl.DateTimeFormat('de-DE', {
    timeZone: BERLIN_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return `${day} – ${time} Uhr`;
}

export function paymentSourceLabelDe(source: ExternalPaymentSource | string): string {
  if (source === ExternalPaymentSource.PAYPAL || source === 'PAYPAL') {
    return 'PayPal';
  }
  if (source === ExternalPaymentSource.QONTO || source === 'QONTO') {
    return 'Qonto – Banküberweisung';
  }
  return String(source);
}

export function prettyChannelDe(channelName: string | null | undefined): string | null {
  if (!channelName) return null;
  const c = channelName.toLowerCase();
  if (c.includes('airbnb')) return 'Airbnb';
  if (c.includes('bookingcom') || c.includes('booking.com')) return 'Booking.com';
  if (c.includes('vrbo') || c.includes('homeaway')) return 'Vrbo';
  if (c.includes('expedia')) return 'Expedia';
  if (c.includes('agoda')) return 'Agoda';
  if (c.includes('bookingengine') || c === 'direct' || c.includes('direct')) {
    return 'Direktbuchung';
  }
  return channelName;
}

export function scorePercent(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function reasonsBlob(candidate: PaymentMatchCandidate | undefined): string {
  return (candidate?.reasons ?? []).join(' ').toLowerCase();
}

export function buildKiSignals(candidate: PaymentMatchCandidate | undefined): string[] {
  if (!candidate) return [];
  const blob = reasonsBlob(candidate);
  const signals: string[] = [];
  if (
    blob.includes('guest name matches') ||
    blob.includes('guest name appears')
  ) {
    signals.push('Gastname gefunden ✓');
  }
  if (blob.includes('stay dates appear')) {
    signals.push('Reisezeitraum gefunden ✓');
  }
  if (blob.includes('guest email matches')) {
    signals.push('E-Mail gefunden ✓');
  }
  if (blob.includes('listing name appears')) {
    signals.push('Unterkunft gefunden ✓');
  }
  if (
    blob.includes('outstanding balance') ||
    blob.includes('reservation total') ||
    blob.includes('deposit') ||
    blob.includes('payment amount aligns')
  ) {
    signals.push('Betrag passt zur Buchung ✓');
  }
  if (/reservation #\d+/.test(blob)) {
    signals.push('Reservierungsnummer gefunden ✓');
  }
  return signals;
}

export interface NeedsReviewEmailInput {
  amount: number;
  currency: string;
  source: ExternalPaymentSource | string;
  payerName?: string | null;
  reference?: string | null;
  occurredAt?: Date | null;
  matchReason?: string | null;
  candidates?: PaymentMatchCandidate[];
  dashboardUrl: string;
  correlationId: string;
}

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

function padLabel(label: string, width = 16): string {
  return `${label}:`.padEnd(width, ' ');
}

export function buildNeedsReviewEmail(input: NeedsReviewEmailInput): BuiltEmail {
  const amountLabel = formatAmountDe(input.amount, input.currency);
  const guest = input.payerName?.trim() || '–';
  const sourceLabel = paymentSourceLabelDe(input.source);
  const candidates = (input.candidates ?? []).slice(0, 5);
  const top = candidates[0];
  const second = candidates[1];
  const channel =
    prettyChannelDe(top?.channelName) ||
    prettyChannelDe(second?.channelName) ||
    '–';
  const reservationIds = candidates
    .map((c) => `#${c.hostawayId}`)
    .filter((v, i, arr) => arr.indexOf(v) === i);
  const reservationLabel =
    reservationIds.length === 0
      ? '–'
      : reservationIds.length === 1
        ? reservationIds[0]
        : reservationIds.length === 2
          ? `${reservationIds[0]} / ${reservationIds[1]}`
          : reservationIds.join(' / ');
  const received =
    input.occurredAt != null ? formatReceivedAtDe(input.occurredAt) : '–';

  const subjectGuest = guest !== '–' ? ` – ${guest}` : '';
  const subject = `Zahlung erhalten – Manuelle Zuordnung erforderlich – ${amountLabel}${subjectGuest}`;

  const summaryRows: Array<[string, string]> = [
    ['Status', 'Manuelle Prüfung erforderlich'],
    ['Betrag', amountLabel],
    ['Gast', guest],
    ['Zahlungsquelle', sourceLabel],
    ['Buchungsquelle', channel],
    ['Reservierung', reservationLabel],
    ['Eingegangen', received],
  ];
  if (input.reference?.trim()) {
    summaryRows.push(['Verwendungszweck', input.reference.trim().slice(0, 160)]);
  }

  const kiLines: string[] = [];
  if (candidates.length >= 2) {
    kiLines.push(`Es wurden ${candidates.length} mögliche Reservierungen gefunden.`);
    candidates.slice(0, 3).forEach((c, i) => {
      kiLines.push(
        `Vorschlag ${i + 1}: ${scorePercent(c.score)} % Übereinstimmung (#${c.hostawayId}${c.guestName ? ` – ${c.guestName}` : ''})`,
      );
    });
    kiLines.push('Bitte die richtige Reservierung auswählen.');
  } else if (candidates.length === 1) {
    kiLines.push(
      `Bester Treffer: ${scorePercent(top!.score)} % Wahrscheinlichkeit (#${top!.hostawayId}${top!.guestName ? ` – ${top!.guestName}` : ''})`,
    );
  } else {
    kiLines.push('Es wurde keine klare Reservierung gefunden.');
  }

  const signals = buildKiSignals(top);
  if (signals.length > 0) {
    kiLines.push('');
    kiLines.push(...signals);
  }
  if (second) {
    kiLines.push(
      `Zweiter möglicher Treffer: ${scorePercent(second.score)} % (#${second.hostawayId})`,
    );
  }
  if (input.matchReason?.trim()) {
    kiLines.push('');
    kiLines.push('Weitere Details:');
    kiLines.push(input.matchReason.trim());
  }

  const textLines = [
    'Zahlung erhalten – Manuelle Zuordnung erforderlich',
    '',
    'Eine Zahlung konnte nicht automatisch zugeordnet werden.',
    '',
    ...summaryRows.map(([k, v]) => `${padLabel(k)}${v}`),
    '',
    'Zahlung jetzt zuordnen:',
    input.dashboardUrl,
    '',
    '────────────────────────────────',
    'KI-Analyse',
    '',
    ...kiLines,
    '',
    `Korrelations-ID: ${input.correlationId}`,
  ];

  const htmlRows = summaryRows
    .map(
      ([k, v]) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;width:160px;vertical-align:top;">${escapeHtml(k)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:600;vertical-align:top;">${escapeHtml(v)}</td>
        </tr>`,
    )
    .join('');

  const kiHtml = kiLines
    .map((line) => {
      if (!line) return '<div style="height:8px;"></div>';
      return `<div style="margin:0 0 6px;color:#374151;line-height:1.45;">${escapeHtml(line)}</div>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="de">
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:640px;margin:24px auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="padding:20px 24px 8px;">
      <div style="font-size:15px;color:#92400e;font-weight:700;margin-bottom:8px;">Zahlung erhalten – Manuelle Zuordnung erforderlich</div>
      <p style="margin:0 0 16px;color:#374151;line-height:1.5;">Eine Zahlung konnte nicht automatisch zugeordnet werden.</p>
      <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 20px;">
        ${htmlRows}
      </table>
      <div style="text-align:center;margin:8px 0 24px;">
        <a href="${escapeHtml(input.dashboardUrl)}"
           style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:700;">
          Zahlung jetzt zuordnen
        </a>
      </div>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 16px;" />
      <div style="font-size:14px;font-weight:700;color:#111827;margin-bottom:10px;">KI-Analyse</div>
      ${kiHtml}
      <p style="margin:20px 0 0;color:#9ca3af;font-size:12px;">Korrelations-ID: ${escapeHtml(input.correlationId)}</p>
    </div>
  </div>
</body>
</html>`;

  return {
    subject,
    text: textLines.join('\n'),
    html,
  };
}

export function buildAppliedEmail(input: {
  reservationHostawayId: number;
  amount: number;
  currency: string;
  source: ExternalPaymentSource | string;
  reference?: string;
  occurredAt?: Date;
  appliedMode: 'automatic' | 'manual';
  reviewedBy?: string;
  chargeId: number;
  guestName?: string | null;
  listingName?: string | null;
  dashboardUrl: string;
  correlationId: string;
}): BuiltEmail {
  const amountLabel = formatAmountDe(input.amount, input.currency);
  const sourceLabel = paymentSourceLabelDe(input.source);
  const modeLabel =
    input.appliedMode === 'automatic' ? 'automatisch verbucht' : 'manuell verbucht';
  const subject = `Zahlung ${modeLabel} – ${amountLabel} – Reservierung #${input.reservationHostawayId}`;

  const rows: Array<[string, string]> = [
    ['Status', `Zahlung ${modeLabel}`],
    ['Reservierung', `#${input.reservationHostawayId}`],
  ];
  if (input.listingName) rows.push(['Unterkunft', input.listingName]);
  if (input.guestName) rows.push(['Gast', input.guestName]);
  rows.push(['Betrag', amountLabel]);
  rows.push(['Zahlungsquelle', sourceLabel]);
  if (input.occurredAt) {
    rows.push(['Eingegangen', formatReceivedAtDe(input.occurredAt)]);
  }
  rows.push(['Hostaway-Charge-ID', String(input.chargeId)]);
  if (input.reference) rows.push(['Verwendungszweck', input.reference]);
  if (input.reviewedBy) rows.push(['Geprüft von', input.reviewedBy]);

  const text = [
    `Eine Zahlung wurde in Hostaway ${modeLabel}.`,
    '',
    ...rows.map(([k, v]) => `${padLabel(k)}${v}`),
    '',
    `Dashboard: ${input.dashboardUrl}`,
    `Korrelations-ID: ${input.correlationId}`,
    '',
    'Diese Benachrichtigung kommt vom Middleware-System, weil Hostaway für per API erstellte Offline-Zahlungen keine zuverlässige E-Mail sendet.',
  ].join('\n');

  const htmlRows = rows
    .map(
      ([k, v]) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;width:180px;">${escapeHtml(k)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:600;">${escapeHtml(v)}</td>
        </tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="de">
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:640px;margin:24px auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="padding:20px 24px;">
      <div style="font-size:15px;color:#166534;font-weight:700;margin-bottom:8px;">Zahlung ${escapeHtml(modeLabel)}</div>
      <p style="margin:0 0 16px;color:#374151;">Eine Zahlung wurde in Hostaway ${escapeHtml(modeLabel)}.</p>
      <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 20px;">${htmlRows}</table>
      <div style="text-align:center;margin:8px 0 16px;">
        <a href="${escapeHtml(input.dashboardUrl)}"
           style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:700;">
          Zahlungen öffnen
        </a>
      </div>
      <p style="margin:16px 0 0;color:#6b7280;font-size:12px;line-height:1.45;">Diese Benachrichtigung kommt vom Middleware-System, weil Hostaway für per API erstellte Offline-Zahlungen keine zuverlässige E-Mail sendet.</p>
      <p style="margin:12px 0 0;color:#9ca3af;font-size:12px;">Korrelations-ID: ${escapeHtml(input.correlationId)}</p>
    </div>
  </div>
</body>
</html>`;

  return { subject, text, html };
}

export function buildReviewDigestEmail(input: {
  slot: 'evening' | 'morning';
  count: number;
  samples: Array<{
    amount: number;
    currency: string;
    source: string;
    payerName?: string | null;
    reference?: string | null;
  }>;
  dashboardUrl: string;
  correlationId: string;
}): BuiltEmail {
  const when =
    input.slot === 'evening'
      ? 'Abend-Erinnerung (19:00)'
      : 'Morgen-Erinnerung (08:00)';
  const subject =
    input.count === 1
      ? '1 unzugeordnete Zahlung wartet auf Zuordnung'
      : `${input.count} unzugeordnete Zahlungen warten auf Zuordnung`;

  const sampleLines = input.samples.map((p) => {
    const amountLabel = formatAmountDe(p.amount, p.currency || 'EUR');
    const payer = p.payerName || '–';
    const ref = p.reference ? ` — ${p.reference.slice(0, 80)}` : '';
    return `• ${amountLabel} (${paymentSourceLabelDe(p.source)}) — ${payer}${ref}`;
  });

  const intro =
    input.count === 1
      ? 'Aktuell wartet 1 unzugeordnete Zahlung auf Zuordnung.'
      : `Aktuell warten ${input.count} unzugeordnete Zahlungen auf Zuordnung.`;

  const text = [
    intro,
    'Bitte prüfen und im Zahlungsabgleich zuordnen.',
    '',
    `Dies ist die geplante ${when}.`,
    '',
    'Aktuelle Einträge:',
    ...sampleLines,
    input.samples.length < input.count
      ? `… und ${input.count - input.samples.length} weitere`
      : '',
    '',
    `Zahlung jetzt zuordnen: ${input.dashboardUrl}`,
    `Korrelations-ID: ${input.correlationId}`,
  ]
    .filter(Boolean)
    .join('\n');

  const samplesHtml = sampleLines
    .map(
      (line) =>
        `<div style="margin:0 0 6px;color:#374151;">${escapeHtml(line)}</div>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="de">
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:640px;margin:24px auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="padding:20px 24px;">
      <div style="font-size:15px;color:#92400e;font-weight:700;margin-bottom:8px;">${escapeHtml(subject)}</div>
      <p style="margin:0 0 8px;color:#374151;">${escapeHtml(intro)}</p>
      <p style="margin:0 0 16px;color:#6b7280;">Dies ist die geplante ${escapeHtml(when)}.</p>
      <div style="margin:0 0 20px;">${samplesHtml}</div>
      <div style="text-align:center;margin:8px 0 16px;">
        <a href="${escapeHtml(input.dashboardUrl)}"
           style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:700;">
          Zahlung jetzt zuordnen
        </a>
      </div>
      <p style="margin:12px 0 0;color:#9ca3af;font-size:12px;">Korrelations-ID: ${escapeHtml(input.correlationId)}</p>
    </div>
  </div>
</body>
</html>`;

  return { subject, text, html };
}


export function buildUnpaidReminderEmail(input: {
  reservationHostawayId: number;
  guestName?: string | null;
  listingName?: string | null;
  channelName?: string | null;
  arrivalDate: Date;
  departureDate: Date;
  totalPrice: number;
  paidAmount: number;
  balanceDue: number;
  currency: string;
  hostawayUrl: string;
  dashboardUrl: string;
  correlationId: string;
}): BuiltEmail {
  const amountDue = formatAmountDe(input.balanceDue, input.currency);
  const totalLabel = formatAmountDe(input.totalPrice, input.currency);
  const paidLabel = formatAmountDe(input.paidAmount, input.currency);
  const arrival = formatReceivedAtDe(input.arrivalDate).split(' – ')[0];
  const departure = formatReceivedAtDe(input.departureDate).split(' – ')[0];
  const channel = prettyChannelDe(input.channelName) ?? '–';
  const subject = `Zahlungserinnerung – offener Restbetrag ${amountDue} – Reservierung #${input.reservationHostawayId}`;

  const textLines = [
    subject,
    '',
    'Diese Buchung ist 4 Wochen vor Anreise noch nicht vollständig bezahlt.',
    '',
    `Reservierung: #${input.reservationHostawayId}`,
    input.listingName ? `Unterkunft: ${input.listingName}` : null,
    input.guestName ? `Gast: ${input.guestName}` : null,
    `Kanal: ${channel}`,
    `Anreise: ${arrival}`,
    `Abreise: ${departure}`,
    `Buchungsbetrag: ${totalLabel}`,
    `Bereits erfasst: ${paidLabel}`,
    `Offener Restbetrag: ${amountDue}`,
    '',
    `Hostaway öffnen: ${input.hostawayUrl}`,
    `Zahlungs-Dashboard: ${input.dashboardUrl}`,
    '',
    `Korrelations-ID: ${input.correlationId}`,
  ].filter((line): line is string => line != null);

  const rowsHtml = [
    ['Reservierung', `#${input.reservationHostawayId}`],
    input.listingName ? ['Unterkunft', input.listingName] : null,
    input.guestName ? ['Gast', input.guestName] : null,
    ['Kanal', channel],
    ['Anreise', arrival],
    ['Abreise', departure],
    ['Buchungsbetrag', totalLabel],
    ['Bereits erfasst', paidLabel],
    ['Offener Restbetrag', amountDue],
  ]
    .filter((row): row is [string, string] => Array.isArray(row))
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 0;color:#6b7280;width:40%;">${escapeHtml(label)}</td><td style="padding:6px 0;color:#111827;font-weight:600;">${escapeHtml(value)}</td></tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="de">
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:640px;margin:24px auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="padding:20px 24px;">
      <div style="font-size:15px;color:#92400e;font-weight:700;margin-bottom:8px;">${escapeHtml(subject)}</div>
      <p style="margin:0 0 16px;color:#374151;">Diese Buchung ist 4 Wochen vor Anreise noch nicht vollständig bezahlt.</p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 20px;">${rowsHtml}</table>
      <div style="text-align:center;margin:8px 0 12px;">
        <a href="${escapeHtml(input.hostawayUrl)}"
           style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:700;">
          Reservierung in Hostaway öffnen
        </a>
      </div>
      <p style="margin:0 0 8px;text-align:center;">
        <a href="${escapeHtml(input.dashboardUrl)}" style="color:#2563eb;text-decoration:none;">Zum Zahlungs-Dashboard</a>
      </p>
      <p style="margin:12px 0 0;color:#9ca3af;font-size:12px;">Korrelations-ID: ${escapeHtml(input.correlationId)}</p>
    </div>
  </div>
</body>
</html>`;

  return { subject, text: textLines.join('\n'), html };
}
