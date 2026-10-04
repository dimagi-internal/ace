/**
 * A close date may only claim a buffer when there is one.
 *
 * ## The failure class
 *
 * On `spark-facilitator/20261001-2208` the Phase 4 row
 * `opportunity-end-date-spark` told reviewers "The Connect opportunity closes
 * on 26 February 2027, including a two-week buffer", while the run's own
 * delivery-window row (`opportunity-dates`, Phase 1) said "The design proposes
 * delivery from 2 November 2026 to 26 February 2027". Same day. The PDD's
 * timeline arithmetic did include two weeks of slack ("1 week enrolment + 13
 * weeks Goal Setting + 2 weeks buffer"), but that slack sits INSIDE the stated
 * delivery window, so on the page a reader sees a buffer of zero days described
 * as two weeks. The phrase was carried from the PDD's source line into prose
 * with no check that the dates still supported it.
 *
 * ## The rule
 *
 * A decision row that claims a buffer for a close/end date must sit beside a
 * stated delivery end that is EARLIER than that date. When the run states a
 * delivery end on or after the close date, the claim is false and the write is
 * refused (`lib/decisions-write.ts`, code `UNSUPPORTED_BUFFER_CLAIM`). When the
 * run states no delivery end at all, there is nothing to compare and the row
 * passes — this rule refuses a contradiction, it does not demand evidence.
 *
 * Pure; no I/O.
 */

export interface BufferClaimRow {
  id: string;
  'ai-default'?: string;
  override?: string;
  plain?: string;
  reasoning?: string;
  superseded_by?: string;
}

export interface BufferClaimViolation {
  id: string;
  closeDate: string;
  deliveryRowId: string;
  deliveryEnd: string;
  detail: string;
}

/** Rows whose value is the delivery window (start to end), by id. */
const DELIVERY_WINDOW_ID = /^(opportunity-dates|delivery-window|delivery-dates|delivery-end(?:-date)?)(?:-|$)/;

/** Rows whose value is the opportunity close / end date, by id. */
const CLOSE_DATE_ID = /^(opportunity-end-date|opportunity-close-date|end-date)(?:-|$)/;

const BUFFER = /\bbuffer\b/i;
const NEGATED_BUFFER = /\b(no|without|excluding|not including|zero)\b[^.]{0,30}\bbuffer\b/i;
const ISO = /\b(\d{4}-\d{2}-\d{2})\b/g;

function effective(row: BufferClaimRow): string {
  return String(row.override ?? row['ai-default'] ?? '');
}

function lastIsoDate(text: string): string | null {
  const all = text.match(ISO);
  return all && all.length ? all[all.length - 1] : null;
}

/** True when the row's reader-facing text asserts a buffer. */
export function claimsBuffer(row: BufferClaimRow): boolean {
  return [row.plain, row.reasoning, effective(row)].some(
    (t) => typeof t === 'string' && BUFFER.test(t) && !NEGATED_BUFFER.test(t),
  );
}

/**
 * Check every live close-date row that claims a buffer against the live
 * delivery-window row. Returns one violation per false claim.
 */
export function checkBufferClaims(rows: readonly BufferClaimRow[]): BufferClaimViolation[] {
  const live = rows.filter((r) => r && typeof r.id === 'string' && !r.superseded_by);
  const deliveryRows = live.filter((r) => DELIVERY_WINDOW_ID.test(r.id));
  // The last live delivery-window row wins (append order = write order).
  const delivery = deliveryRows[deliveryRows.length - 1];
  if (!delivery) return [];
  const deliveryEnd = lastIsoDate(effective(delivery));
  if (!deliveryEnd) return [];

  const out: BufferClaimViolation[] = [];
  for (const row of live) {
    if (!CLOSE_DATE_ID.test(row.id) || !claimsBuffer(row)) continue;
    const closeDate = lastIsoDate(effective(row));
    if (!closeDate) continue;
    if (deliveryEnd >= closeDate) {
      out.push({
        id: row.id,
        closeDate,
        deliveryRowId: delivery.id,
        deliveryEnd,
        detail:
          `\`${row.id}\` says the opportunity closing on ${closeDate} includes a buffer, but ` +
          `\`${delivery.id}\` has delivery ending ${deliveryEnd}` +
          (deliveryEnd === closeDate ? ' — the same day, so there is no buffer.' : ' — after the close date.') +
          ' Claim a buffer only when the close date is later than the delivery end; otherwise state the date plainly.',
      });
    }
  }
  return out;
}
