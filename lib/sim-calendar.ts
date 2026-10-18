/**
 * The backdated calendar the simulated Phase 9 runs on (spec 2026-10-18 § G).
 *
 * Labs has no clock to move. What it offers is backdating (synthetic visit
 * dates, every supply-chain `*_on` field, `source.sent_on`) and weekly history
 * rebuilt as of past dates (`workflow_rebuild_history`, Monday-Sunday). So a
 * "4-week" simulation is laid out in the PAST:
 *
 *   sim_start = the Monday on or before (run_started_at − (N+1) weeks)
 *   week 0    = sim_start .. +6d          procurement + fulfilment
 *   weeks 1..N                            delivery weeks
 *
 * Every day of it is strictly before the run's start date, so every as-of read
 * means something. A future-dated record would make `stock_position`,
 * `workflow_preview_as_of` and the weekly review all report a world that does
 * not exist yet.
 *
 * The known inconsistency is deliberate and documented in the weekly review:
 * the solicitation and award carry real wall-clock dates, later than the
 * simulated procurement they precede.
 *
 * `weeks[w]` is week `w` (index = week number), which is how the supply-chain
 * skills address it (`products.simulation.calendar.weeks[0].start`). Pure, and
 * UTC throughout; `lib/supply-chain-ref.ts` `simulatedDate` dates an event
 * inside a week.
 */

export class SimCalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimCalendarError';
  }
}

export interface SimWeek {
  /** 0 = procurement + fulfilment; 1..N = delivery. */
  w: number;
  /** Monday, YYYY-MM-DD. */
  start: string;
  /** Sunday, YYYY-MM-DD. */
  end: string;
}

export interface SimCalendar {
  /** The run start the calendar was derived from (YYYY-MM-DD, UTC). */
  run_started_on: string;
  /** Monday of week 0. */
  sim_start: string;
  /** N, the delivery weeks (excludes week 0). */
  delivery_weeks: number;
  /** weeks[w] is week w: N+1 entries. */
  weeks: SimWeek[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
export const MAX_DELIVERY_WEEKS = 12; // lib/optional-steps.ts caps simulate_weeks at 12

function toDay(value: string, label: string): Date {
  const head = value.trim().slice(0, 10);
  if (!ISO_DATE.test(head)) throw new SimCalendarError(`${label} ${JSON.stringify(value)} is not an ISO date or timestamp`);
  const d = new Date(`${head}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new SimCalendarError(`${label} ${JSON.stringify(value)} is not a real date`);
  return d;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

/** The Monday on or before `d` (UTC). */
export function mondayOnOrBefore(d: Date): Date {
  const dow = d.getUTCDay(); // 0 = Sunday
  const back = (dow + 6) % 7;
  return addDays(d, -back);
}

/**
 * Lay out week 0 plus `deliveryWeeks` delivery weeks, all before `runStartedAt`.
 * `runStartedAt` is the run's start (an ISO date or timestamp; only the UTC
 * date is used), so the calendar is a function of the run and a resume
 * computes the same one.
 */
export function computeSimCalendar(runStartedAt: string, deliveryWeeks: number): SimCalendar {
  if (!Number.isInteger(deliveryWeeks) || deliveryWeeks < 1 || deliveryWeeks > MAX_DELIVERY_WEEKS) {
    throw new SimCalendarError(`delivery weeks ${deliveryWeeks} must be an integer 1-${MAX_DELIVERY_WEEKS}`);
  }
  const run = toDay(runStartedAt, 'runStartedAt');
  const simStart = mondayOnOrBefore(addDays(run, -7 * (deliveryWeeks + 1)));
  const weeks: SimWeek[] = [];
  for (let w = 0; w <= deliveryWeeks; w++) {
    const start = addDays(simStart, 7 * w);
    weeks.push({ w, start: iso(start), end: iso(addDays(start, 6)) });
  }
  const cal: SimCalendar = { run_started_on: iso(run), sim_start: iso(simStart), delivery_weeks: deliveryWeeks, weeks };
  assertSimCalendar(cal);
  return cal;
}

/**
 * Validate a calendar read back from run_state (or built by hand outside a
 * run): Monday-aligned, contiguous 7-day weeks indexed 0..N, entirely before
 * the run start. Throws naming the first violation.
 */
export function assertSimCalendar(cal: SimCalendar): void {
  if (!cal || !Array.isArray(cal.weeks) || cal.weeks.length < 2) {
    throw new SimCalendarError('calendar needs week 0 and at least one delivery week');
  }
  const run = toDay(cal.run_started_on, 'run_started_on');
  if (cal.weeks[0].start !== cal.sim_start) {
    throw new SimCalendarError(`sim_start ${cal.sim_start} is not week 0's start ${cal.weeks[0].start}`);
  }
  if (cal.delivery_weeks !== cal.weeks.length - 1) {
    throw new SimCalendarError(`delivery_weeks ${cal.delivery_weeks} disagrees with ${cal.weeks.length - 1} delivery weeks listed`);
  }
  cal.weeks.forEach((wk, i) => {
    if (wk.w !== i) throw new SimCalendarError(`weeks[${i}] is labelled w=${wk.w}; weeks[w] must be week w`);
    const start = toDay(wk.start, `week ${i} start`);
    const end = toDay(wk.end, `week ${i} end`);
    if (start.getUTCDay() !== 1) throw new SimCalendarError(`week ${i} starts ${wk.start}, not a Monday`);
    if (end.getTime() - start.getTime() !== 6 * DAY_MS) throw new SimCalendarError(`week ${i} is not Monday-Sunday (${wk.start}..${wk.end})`);
    if (i > 0) {
      const prevEnd = toDay(cal.weeks[i - 1].end, `week ${i - 1} end`);
      if (start.getTime() - prevEnd.getTime() !== DAY_MS) throw new SimCalendarError(`week ${i} does not follow week ${i - 1}`);
    }
    if (end.getTime() >= run.getTime()) {
      throw new SimCalendarError(`week ${i} ends ${wk.end}, not before the run start ${cal.run_started_on}; the simulation is backdated`);
    }
  });
}

/** The delivery window synthetic data is generated for: week 1 start .. week N end. */
export function deliveryWindow(cal: SimCalendar): { start_date: string; end_date: string; weeks: number } {
  assertSimCalendar(cal);
  return { start_date: cal.weeks[1].start, end_date: cal.weeks[cal.weeks.length - 1].end, weeks: cal.delivery_weeks };
}

/** Which week a date falls in, or null if outside the calendar. */
export function weekOf(cal: SimCalendar, date: string): number | null {
  const d = iso(toDay(date, 'date'));
  const hit = cal.weeks.find((wk) => wk.start <= d && d <= wk.end);
  return hit ? hit.w : null;
}
