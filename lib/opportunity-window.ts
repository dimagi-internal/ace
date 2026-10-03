/**
 * The opportunity's delivery window, and a guard against quoting a COUNTDOWN
 * as if it were that window (dimagi-internal/ace#2610).
 *
 * The window is configuration: `start_date` / `end_date` on the Connect
 * opportunity (`connect_get_opportunity` is authoritative; the PDD's
 * `program_parameters.opportunity_{start,end}_date` is the design-time copy).
 *
 * The job card's "Days to complete" is NOT the window. It is a countdown from
 * the DEVICE CLOCK to the end date — `dimagi/commcare-android`
 * `ConnectJobRecord.getDaysRemaining()` (master c21bc58c0):
 *
 *   millis = projectEndDate - now; millis += 86399999;
 *   return millis >= 0 ? toDays(millis) + 1 : 0;
 *
 * So a frame captured on 2026-10-01 for an opportunity ending 2027-02-26 reads
 * 149, and a reader looking at the card on any other day sees another number.
 * The spark-facilitator LLO guide quoted that 149 next to a 2026-11-02 →
 * 2027-02-26 window (116 days) and the eval caught the contradiction.
 */

const DAY_MS = 86_400_000;

export interface OpportunityWindow {
  start: string;
  end: string;
  /** end − start, in whole days (what "a 116-day window" means). */
  days: number;
  /** Counting both the first and the last day (117 for the same window). */
  inclusiveDays: number;
}

function parseIsoDate(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`not an ISO date (YYYY-MM-DD): ${JSON.stringify(s)}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function opportunityWindow(start: string, end: string): OpportunityWindow {
  const a = parseIsoDate(start);
  const b = parseIsoDate(end);
  if (b < a) throw new Error(`end ${end} is before start ${start}`);
  const days = Math.round((b - a) / DAY_MS);
  return { start: start.trim(), end: end.trim(), days, inclusiveDays: days + 1 };
}

/**
 * What the app's "Days to complete" shows on `viewedOn` (a calendar date, as
 * the device sees it). Exposed so a guide can EXPLAIN the countdown — never so
 * it can print one as a fact about the opportunity.
 */
export function appDaysRemaining(end: string, viewedOn: string): number {
  const diff = parseIsoDate(end) - parseIsoDate(viewedOn);
  if (diff < 0) return 0;
  return Math.floor((diff + DAY_MS - 1) / DAY_MS) + 1;
}

export interface DayCountFinding {
  /** The sentence fragment that carried the number. */
  excerpt: string;
  claimed: number;
  window: OpportunityWindow;
}

/**
 * Phrases that state a DURATION of the work: "149 days to complete",
 * "a 116-day window", "runs for 117 days", "window of 116 days".
 * A number of days that is neither `days` nor `inclusiveDays` is a finding.
 */
const DURATION_PATTERNS: RegExp[] = [
  /\b(\d{1,4})\s*days?\s+to\s+complete\b/gi,
  /\b(\d{1,4})[- ]day\s+(?:window|pilot|opportunity|delivery\s+period|period)\b/gi,
  /\b(?:window|pilot|opportunity|delivery\s+period)\s+of\s+(\d{1,4})\s+days?\b/gi,
  /\bruns?\s+for\s+(\d{1,4})\s+days?\b/gi,
];

/**
 * Scan prose for a stated duration that contradicts the configured window.
 * A sentence that names the figure as a countdown ("counts down", "days
 * remaining", "days left") is explaining the card, not stating the window,
 * and is not flagged.
 */
export function findDayCountDrift(markdown: string, window: OpportunityWindow): DayCountFinding[] {
  const ok = new Set([window.days, window.inclusiveDays]);
  const out: DayCountFinding[] = [];
  for (const re of DURATION_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(markdown))) {
      const claimed = Number(m[1]);
      if (ok.has(claimed)) continue;
      const from = Math.max(0, markdown.lastIndexOf('\n', m.index) + 1);
      const toNl = markdown.indexOf('\n', m.index);
      const sentence = markdown.slice(from, toNl === -1 ? undefined : toNl);
      if (/count(?:s|ing)?\s+down|days?\s+(?:remaining|left)/i.test(sentence)) continue;
      out.push({ excerpt: m[0], claimed, window });
    }
  }
  return out;
}
