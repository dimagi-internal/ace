/**
 * Did OCS fail to deliver a message to a PersonalID (commcare_connect) participant?
 *
 * `POST /api/trigger_bot` answers 200 and a session id as soon as OCS ACCEPTS the send; for a Connect
 * participant the delivery to PersonalID happens afterwards, and a failure there is recorded only as a team
 * notification, "Message Delivery Failed for <bot>", whose event rows read "An error occurred while
 * delivering a message to <participant> via Commcare_Connect". So a 200 (and labs' `send_via_bot`
 * `delivery.sent: true`) is not evidence the phone got anything (ace#3348, ace#3362). This reads those
 * notifications; the pages are HTML fragments, parsed here as pure functions over the markup.
 */

export interface NotificationRow {
  timestamp: string;
  title: string;
  level: string;
  /** Path of the event page, e.g. `/notifications/event/890/`. */
  eventPath: string;
}

export interface DeliveryFailure {
  timestamp: string;
  participant: string;
  platform: string;
  /** `.../s/<session-uuid>/view/` in the row's "View Session" link. */
  sessionId: string | null;
  botPublicId: string | null;
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const rows = (html: string) => html.match(/<tr\b[\s\S]*?<\/tr>/g) ?? [];

/** The notification list (`/notifications/table/`): one row per notification, newest first. */
export function parseNotificationList(html: string): NotificationRow[] {
  const out: NotificationRow[] = [];
  for (const row of rows(html)) {
    const eventPath = /data-redirect-url="([^"]*)"/.exec(row)?.[1] ?? '';
    const timestamp = /<time[^>]*datetime="([^"]+)"/.exec(row)?.[1];
    const cells = row.match(/<td\b[\s\S]*?<\/td>/g) ?? [];
    if (!timestamp || !eventPath || cells.length < 3) continue;
    out.push({ timestamp, eventPath, title: text(cells[1]), level: text(cells[2]) });
  }
  return out;
}

/** An event page's rows (`/notifications/event/<id>/table/?`): one row per occurrence. */
export function parseDeliveryFailures(html: string): DeliveryFailure[] {
  const out: DeliveryFailure[] = [];
  for (const row of rows(html)) {
    const timestamp = /<time[^>]*datetime="([^"]+)"/.exec(row)?.[1];
    const m = /delivering a message to (\S+) via (\S+?)(?:\s|<|$)/.exec(text(row));
    if (!timestamp || !m) continue;
    const session = /\/s\/([0-9a-f-]{36})\/view\//.exec(row)?.[1] ?? null;
    const bot = /\/chatbots\/e\/([0-9a-f-]{36})\//.exec(row)?.[1] ?? null;
    out.push({ timestamp, participant: m[1], platform: m[2], sessionId: session, botPublicId: bot });
  }
  return out;
}

/** The notifications that are delivery failures, from the list. */
export const deliveryFailureEvents = (list: NotificationRow[]): NotificationRow[] =>
  list.filter((n) => /^(?:.*\s)?Message Delivery Failed\b/.test(n.title));

/** Failures at or after `since`, optionally for one participant (their PersonalID username). */
export function failuresSince(
  failures: DeliveryFailure[],
  since: Date,
  participant?: string,
): DeliveryFailure[] {
  return failures.filter(
    (f) => new Date(f.timestamp) >= since && (participant === undefined || f.participant === participant),
  );
}
