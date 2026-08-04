import { HostawayMessageTemplate } from './hostaway.types';

const CHECKIN_NAME_RE =
  /anreise|check[\s-]?in|zugang|adresse|arrival|door\s*code/i;
const CHECKIN_BODY_RE =
  /anreise|adresse|door.?code|zugang|pin|haustür|wohnungstür|schlüssel/i;

export function htmlToPlainText(input: string): string {
  return input
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function scoreCheckinTemplate(
  template: HostawayMessageTemplate,
  listingHostawayId?: number | null,
): number {
  const name = template.name ?? '';
  const message = template.message ?? '';
  if (!message.trim()) return 0;

  let score = 0;
  if (CHECKIN_NAME_RE.test(name)) score += 100;
  if (CHECKIN_BODY_RE.test(message)) score += 25;

  const listingMapId = template.listingMapId;
  if (
    listingHostawayId != null &&
    listingMapId != null &&
    String(listingMapId) === String(listingHostawayId)
  ) {
    score += 40;
  }

  return score;
}

export function pickCheckinTemplate(
  templates: HostawayMessageTemplate[],
  listingHostawayId?: number | null,
): HostawayMessageTemplate | null {
  let best: HostawayMessageTemplate | null = null;
  let bestScore = 0;

  for (const template of templates) {
    const score = scoreCheckinTemplate(template, listingHostawayId);
    if (score > bestScore) {
      best = template;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}
