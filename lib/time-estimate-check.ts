//
// Pure sanity check: is every `connect.learn_module.time_estimate` in a
// released Learn CCZ plausible AS HOURS against the PDD's stated module
// duration?
//
// Contract truth (dimagi-internal/ace#1077, resolved 2026-07-30 against
// dimagi/commcare-connect + dimagi/commcare-android source): the unit is
// HOURS everywhere Connect touches the value.
//
//   - Model:  commcare_connect/opportunity/models.py:297
//             `time_estimate = models.IntegerField(help_text="Estimated
//             hours to complete the module")`
//   - PM UI:  commcare_connect/opportunity/tables.py:1677-1678
//             `render_time_estimate` returns `f"{value}hr"`
//   - Ingest: commcare_connect/opportunity/app_xml.py:107-108 reads the
//             `<time_estimate>` element straight into `int()` — no unit
//             conversion anywhere between CCZ and render; tasks.py:95
//             writes it verbatim onto `LearnModule`.
//   - FLW UI: commcare-android
//             app/src/org/commcare/fragments/connect/ConnectJobIntroFragment.kt:64-77
//             sums `timeEstimate` across modules and renders the plural
//             resource `connect_opportunity_estimated_hours`
//             ("Estimated time: %d hours", app/res/values/strings.xml:717).
//
// Nova's `create_form`/`update_form` schema description ("Estimated
// minutes") is the stale side — upstream issue filed against
// voidcraft-labs/nova-plugin. Until it is fixed, an architect that obeys
// the schema description writes a raw minute count, and a 20-minute module
// renders as "20 hours" on every FLW's onboarding screen.
//
// Why this is a parser and not a rubric line: the failure mode
// (spark-facilitator/20260730-1718) shipped through `validate_app`,
// `make_build`, release, and marker-presence QA because nothing reads the
// VALUE. The class is 100% mechanically detectable from the CCZ projection
// + the PDD's stated durations, so it lands here per "class-level
// preventers > instance-level fixes".
//

/** How badly a value misrepresents the module's real duration. */
export type TimeEstimateSeverity = 'blocker' | 'warn';

export type TimeEstimateViolationClass =
  /** No `<time_estimate>` on the learn-module marker at all. */
  | 'missing'
  /** Zero or negative — renders as "0 hours" (or nonsense). */
  | 'non-positive'
  /** Not an integer — Connect's column is an IntegerField. */
  | 'non-integer'
  /**
   * The value equals (or nearly equals) the module's budgeted MINUTES —
   * the ace#1077 signature: an architect followed Nova's stale
   * "Estimated minutes" schema description, and a 20-minute module will
   * render as "20 hours".
   */
  | 'minutes-not-hours'
  /** Outside the sane hour range implied by the PDD's stated duration. */
  | 'out-of-range';

export interface TimeEstimateInput {
  /** Connect slug of the learn module (`projected_connect_state.learn_modules[].slug`). */
  moduleId: string;
  /** The `<time_estimate>` value carried in the CCZ marker, if any. */
  timeEstimate: number | undefined;
  /**
   * The PDD's stated duration for this module, in MINUTES. Omit when the
   * PDD does not state one — the check then falls back to absolute
   * plausibility bounds.
   */
  budgetedMinutes?: number;
}

export interface TimeEstimateViolation {
  moduleId: string;
  timeEstimate: number | null;
  budgetedMinutes: number | null;
  /** The value the module SHOULD carry (hours, round up, min 1); null when unbudgeted. */
  expectedHours: number | null;
  violationClass: TimeEstimateViolationClass;
  severity: TimeEstimateSeverity;
  message: string;
}

export interface TimeEstimateReport {
  modulesChecked: number;
  violations: TimeEstimateViolation[];
}

/**
 * Hours a module budgeted at `minutes` should declare: round UP, floor 1.
 * (Per skills/pdd-to-learn-app: "If a module genuinely takes less than an
 * hour, round up to 1".)
 */
export function expectedHoursForMinutes(minutes: number): number {
  return Math.max(1, Math.ceil(minutes / 60));
}

/**
 * A single learn module without a PDD budget can plausibly declare up to
 * this many hours before the only realistic explanation is a raw minute
 * count. (The skill brief: "typical … is 1 (one hour) or 2; never a
 * two-digit minute count.")
 */
const UNBUDGETED_MAX_HOURS = 9;

export function checkLearnModuleTimeEstimates(
  inputs: TimeEstimateInput[],
): TimeEstimateReport {
  const violations: TimeEstimateViolation[] = [];

  for (const { moduleId, timeEstimate, budgetedMinutes } of inputs) {
    const budget = budgetedMinutes ?? null;
    const expected = budget !== null ? expectedHoursForMinutes(budget) : null;

    const add = (
      violationClass: TimeEstimateViolationClass,
      severity: TimeEstimateSeverity,
      message: string,
    ) =>
      violations.push({
        moduleId,
        timeEstimate: timeEstimate ?? null,
        budgetedMinutes: budget,
        expectedHours: expected,
        violationClass,
        severity,
        message,
      });

    if (timeEstimate === undefined || timeEstimate === null) {
      add(
        'missing',
        'blocker',
        `learn module '${moduleId}' carries no time_estimate — Connect's LearnModule.time_estimate is a required IntegerField`,
      );
      continue;
    }
    if (!Number.isInteger(timeEstimate)) {
      add(
        'non-integer',
        'blocker',
        `learn module '${moduleId}' time_estimate=${timeEstimate} is not an integer — Connect's column is an IntegerField`,
      );
      continue;
    }
    if (timeEstimate < 1) {
      add(
        'non-positive',
        'blocker',
        `learn module '${moduleId}' time_estimate=${timeEstimate} would render as "${timeEstimate}hr" on the Connect dashboard`,
      );
      continue;
    }

    if (expected !== null && budget !== null) {
      if (timeEstimate === expected) continue;

      // The ace#1077 signature: the value tracks the MINUTE budget, not the
      // hour conversion. Only meaningful when minutes and hours diverge.
      const looksLikeMinutes =
        budget >= 10 &&
        expected < budget &&
        Math.abs(timeEstimate - budget) <= Math.max(2, budget * 0.15);
      if (looksLikeMinutes) {
        add(
          'minutes-not-hours',
          'blocker',
          `learn module '${moduleId}' time_estimate=${timeEstimate} matches its ${budget}-minute PDD budget — the unit is HOURS, so this renders as "${timeEstimate} hours" (expected ${expected})`,
        );
        continue;
      }

      // Inflated or understated relative to the budget. More than double
      // the expected hours (beyond a +1 rounding cushion) is an
      // order-of-magnitude misstatement -> blocker; anything else off by
      // >= 1 hour is a warn.
      if (timeEstimate > expected * 2 + 1) {
        add(
          'out-of-range',
          'blocker',
          `learn module '${moduleId}' time_estimate=${timeEstimate}hr vs a ${budget}-minute PDD budget (expected ${expected})`,
        );
      } else {
        add(
          'out-of-range',
          'warn',
          `learn module '${moduleId}' time_estimate=${timeEstimate}hr differs from the ${budget}-minute PDD budget (expected ${expected})`,
        );
      }
      continue;
    }

    // No PDD budget: absolute plausibility only.
    if (timeEstimate > UNBUDGETED_MAX_HOURS) {
      add(
        'minutes-not-hours',
        'blocker',
        `learn module '${moduleId}' time_estimate=${timeEstimate} reads as a raw minute count — the unit is HOURS ("never a two-digit minute count")`,
      );
    }
  }

  return { modulesChecked: inputs.length, violations };
}

/** Human-readable block for the QA verdict / halt message. */
export function formatTimeEstimateReport(report: TimeEstimateReport): string {
  if (report.violations.length === 0) {
    return `time_estimate: ${report.modulesChecked} learn module(s) checked, all plausible as hours`;
  }
  const lines = report.violations.map(
    (v) => `  [${v.severity.toUpperCase()}] (${v.violationClass}) ${v.message}`,
  );
  return [
    `time_estimate: ${report.violations.length} violation(s) across ${report.modulesChecked} learn module(s):`,
    ...lines,
  ].join('\n');
}
