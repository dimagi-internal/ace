/**
 * Pre-build drift detection between a Nova blueprint and its CommCare HQ
 * DRAFT (dimagi-internal/ace#1643).
 *
 * ## The defect
 *
 * `commcare_make_build` versions the **CCHQ draft**. It does not pull from
 * Nova. So any Nova edit made after `app-deploy` is silently absent from the
 * released CCZ and the release still reports success.
 *
 * Live on `hh-poverty-targeting/20260824-1404`: four fixes were applied to the
 * Nova apps after `app-deploy`; the first Deliver release (`1b1d9f35…`, v5)
 * shipped without them. Verified against the live HQ draft at the time — 48
 * fields where Nova had 50, zero hits for the new consent sentence, `area_ref`
 * with no constraint. The Learn app was clean only because its edits landed
 * BEFORE the deploy. It is a pure ordering hazard.
 *
 * ## Why marker checks could not catch it
 *
 * `app-release` Step 6 verifies Connect MARKERS, and the markers were correct
 * on the stale build too — the stale build was a perfectly well-formed build of
 * the wrong content. **Marker integrity is not a proxy for content
 * integrity**, which is why this check is content-level and sits BEFORE the
 * build rather than after it.
 *
 * ## The asymmetry that shapes the rules
 *
 * The two branches are not symmetrical, so the classifier is deliberately not
 * symmetrical either:
 *
 * - **Re-uploading when there was no drift** costs one idempotent upload plus a
 *   re-apply of `app-hq-settings` (which the re-upload path owes anyway).
 * - **Skipping the re-upload when there WAS drift** ships the wrong app and
 *   reports success. That is the bug.
 *
 * So: any positive signal means drift, and the DEFAULT under missing or
 * unreadable signals is also drift. Skipping the re-upload is a decision that
 * has to be earned.
 *
 * ## Counts detect drift; they never PROVE its absence
 *
 * Of the three Deliver edits in the live repro, only one (`gps_lat`/`gps_lon`)
 * moved a count. Extending the consent paragraph and adding an `area_ref`
 * `constraint` changed no form count and no field count at all. A count-only
 * check would have caught that run by luck and missed a text-only edit
 * entirely.
 *
 * Therefore `countsMatch` can only ever fail to fire — it can never on its own
 * produce a `build-directly` verdict. Clearing the build-directly branch
 * requires an ORDERING fact: either the run states outright that it made no
 * Nova edit after `app-deploy` (`novaEditedSinceDeploy: false`), or the two
 * timestamps parse and the Nova app was last edited at or before the deploy.
 *
 * ## Field counts vs form counts — one has a confound, the other doesn't
 * (dimagi-internal/ace#1789)
 *
 * `commcare_make_build` versions the CCHQ draft; `run-form-walk --draft-only`
 * reads THAT draft. It never emits `kind: hidden` fields. Nova's `get_app`
 * does. Every ACE app carries hidden fields (`user_score`, `qN_score`,
 * `case_name`, `entity_key`, `entity_label`, …), so a caller who feeds the
 * classifier a raw Nova field-count total gets a mismatch on essentially
 * every run — see `novaVisibleFieldCount` below for the boundary fix.
 *
 * Live repro (`bednet-check-2-visit/20260828-0629`): Learn 44 (Nova, raw) vs
 * 32 (HQ draft); Deliver 17 vs 14. Excluding hidden fields both matched
 * exactly, and both apps had `novaEditedSinceDeploy: false`.
 *
 * Form counts have no equivalent confound — a hidden field never creates a
 * new form — so a form-count mismatch stays a hard, unconditional drift
 * signal. A field-count mismatch does not: it is downgraded to corroboration
 * whenever a direct ORDERING fact (`novaEditedSinceDeploy: false`, or
 * timestamps proving the Nova edit was at or before the deploy) is present.
 * An ordering-clear fact is first-party knowledge; an unnormalized field
 * count is not, and must not be able to override it. When no ordering fact
 * resolves the question, a field-count mismatch still falls back to the
 * conservative default (drift) — the boundary rename does not weaken that.
 */

/** What `app-release` should do before `commcare_make_build`, per app. */
export type DriftAction =
  /** `upload_app_to_hq` → re-apply `app-hq-settings` → build. */
  | 'reupload-reapply-settings-then-build'
  /** Straight to `commcare_make_build`. */
  | 'build-directly';

export interface AppDriftInputs {
  /** Which app this decision is about — used only for the reason strings. */
  app: string;
  /**
   * ISO-8601 from `3-commcare/app-deploy_summary.md` frontmatter `uploaded_at`
   * — when the HQ draft last received the Nova blueprint. ACE writes this key,
   * so it is the one input that is always available on a healthy run.
   */
  deployedAt?: string | null;
  /**
   * ISO-8601 of the Nova blueprint's most recent edit, when the Nova surface
   * exposes one. Omit rather than guess — an omitted signal is handled
   * (inconclusive → re-upload); an invented one is not.
   */
  novaEditedAt?: string | null;
  /**
   * Direct knowledge, and the strongest signal available: did THIS RUN edit the
   * Nova app after `app-deploy` ran? A run that dispatched `/nova:edit`, an
   * eval-driven repair round, or a build-rejection fix knows the answer for
   * certain. `null`/undefined means "not known", not "no".
   */
  novaEditedSinceDeploy?: boolean | null;
  /** Form count on the Nova blueprint (`nova get_app`). */
  novaFormCount?: number | null;
  /** Form count on the HQ draft (`run-form-walk --draft-only`). */
  hqDraftFormCount?: number | null;
  /**
   * Field count across all forms on the Nova blueprint, EXCLUDING `kind:
   * hidden` fields (`user_score`, `qN_score`, `case_name`, `entity_key`,
   * `entity_label`, …). The HQ draft walk never emits hidden fields, so a
   * raw `get_app` total is not the same basis and will disagree on
   * essentially every ACE app (dimagi-internal/ace#1789). Filter before
   * passing this in — don't pass the raw Nova total.
   */
  novaVisibleFieldCount?: number | null;
  /** Field count across all forms on the HQ draft (`--with-fields`). Already visible-only — the draft walk has no hidden fields to exclude. */
  hqDraftVisibleFieldCount?: number | null;
}

export interface AppDriftDecision {
  app: string;
  /** True when the HQ draft may not match the Nova blueprint. */
  drift: boolean;
  action: DriftAction;
  /**
   * True when the verdict rests on a signal that actually resolved. A
   * `drift: true, conclusive: false` verdict is the safe default taken because
   * the inputs did not settle the question — record it as such in the summary
   * rather than claiming drift was observed.
   */
  conclusive: boolean;
  /** One line per signal that fired, in evaluation order. Never empty. */
  reasons: string[];
  /** Every comparison the classifier was able to make, for the audit trail. */
  signals: {
    novaEditedSinceDeploy: boolean | null;
    orderingComparable: boolean;
    novaEditedAfterDeploy: boolean | null;
    formCounts: CountComparison;
    fieldCounts: CountComparison;
  };
}

export interface CountComparison {
  nova: number | null;
  hq: number | null;
  comparable: boolean;
  /** `true` when both sides are known and DIFFER. */
  mismatch: boolean;
}

function compareCounts(nova?: number | null, hq?: number | null): CountComparison {
  const n = typeof nova === 'number' && Number.isFinite(nova) ? nova : null;
  const h = typeof hq === 'number' && Number.isFinite(hq) ? hq : null;
  const comparable = n !== null && h !== null;
  return { nova: n, hq: h, comparable, mismatch: comparable && n !== h };
}

function parseTime(value?: string | null): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * Decide whether the HQ draft has drifted from the Nova blueprint, and
 * therefore whether `app-release` must re-upload before building.
 *
 * Deterministic and side-effect free — the whole point is that the decision is
 * unit-testable rather than living only in skill prose.
 */
export function classifyAppDrift(inputs: AppDriftInputs): AppDriftDecision {
  const app = inputs.app;
  const formCounts = compareCounts(inputs.novaFormCount, inputs.hqDraftFormCount);
  const fieldCounts = compareCounts(inputs.novaVisibleFieldCount, inputs.hqDraftVisibleFieldCount);

  const editedSince =
    typeof inputs.novaEditedSinceDeploy === 'boolean' ? inputs.novaEditedSinceDeploy : null;

  const deployedAt = parseTime(inputs.deployedAt);
  const novaEditedAt = parseTime(inputs.novaEditedAt);
  const orderingComparable = deployedAt !== null && novaEditedAt !== null;
  const novaEditedAfterDeploy = orderingComparable
    ? (novaEditedAt as number) > (deployedAt as number)
    : null;

  // A direct ORDERING fact — first-party knowledge, not an inferred count —
  // clears the skip. Computed up front because it also decides whether a
  // field-count mismatch is allowed to force drift below (ace#1789).
  const orderingClear = editedSince === false || novaEditedAfterDeploy === false;

  const reasons: string[] = [];
  let hardDrift = false;

  // ── Hard positive drift signals — never overridable ────────────────
  if (editedSince === true) {
    reasons.push(
      `${app}: the run edited the Nova app after app-deploy — the HQ draft predates those edits.`,
    );
    hardDrift = true;
  }
  if (novaEditedAfterDeploy === true) {
    reasons.push(
      `${app}: Nova blueprint last edited ${inputs.novaEditedAt}, after the draft was uploaded at ${inputs.deployedAt}.`,
    );
    hardDrift = true;
  }
  if (formCounts.mismatch) {
    // Forms have no hidden-field-shaped confound — a hidden field never
    // creates a new form — so this stays unconditional.
    reasons.push(
      `${app}: form count differs — Nova ${formCounts.nova}, HQ draft ${formCounts.hq}.`,
    );
    hardDrift = true;
  }

  // ── Field-count mismatch — a SOFT signal (ace#1789) ─────────────────
  // Nova's visible-field count and the HQ draft's are only the same basis if
  // the caller actually excluded `kind: hidden` fields on the Nova side. A
  // mismatch here can never PROVE drift the way a form-count mismatch can,
  // so it forces drift only when no ordering fact has already settled the
  // question; once ordering is clear, it is downgraded to corroboration.
  if (fieldCounts.mismatch && !orderingClear) {
    reasons.push(
      `${app}: field count differs — Nova ${fieldCounts.nova}, HQ draft ${fieldCounts.hq}.`,
    );
    hardDrift = true;
  }

  const signals = {
    novaEditedSinceDeploy: editedSince,
    orderingComparable,
    novaEditedAfterDeploy,
    formCounts,
    fieldCounts,
  };

  if (hardDrift) {
    return {
      app,
      drift: true,
      action: 'reupload-reapply-settings-then-build',
      conclusive: true,
      reasons,
      signals,
    };
  }

  // ── No hard positive signal. Can the skip be EARNED? ────────────────
  // Only an ordering fact clears it. Matching counts are corroboration and
  // nothing more: two of the three drifting edits in the ace#1643 repro moved
  // no count at all.
  if (orderingClear) {
    const basis =
      editedSince === false
        ? 'the run made no Nova edit after app-deploy'
        : `Nova last edited ${inputs.novaEditedAt}, at or before the ${inputs.deployedAt} upload`;
    const corroboration = [
      formCounts.comparable ? `form counts agree (${formCounts.nova})` : null,
      fieldCounts.comparable && !fieldCounts.mismatch
        ? `field counts agree (${fieldCounts.nova})`
        : null,
      fieldCounts.mismatch
        ? `field counts differ (Nova ${fieldCounts.nova}, HQ draft ${fieldCounts.hq}) but that is ` +
          `not treated as drift — Nova's raw count includes hidden fields the HQ draft walk ` +
          `never emits (ace#1789)`
        : null,
    ].filter(Boolean);
    reasons.push(
      `${app}: no drift — ${basis}` +
        (corroboration.length ? `; ${corroboration.join(', ')}.` : '.'),
    );
    return { app, drift: false, action: 'build-directly', conclusive: true, reasons, signals };
  }

  reasons.push(
    `${app}: drift undetermined — no ordering signal resolved ` +
      `(novaEditedSinceDeploy=${editedSince === null ? 'unknown' : editedSince}, ` +
      `timestamps ${orderingComparable ? 'comparable' : 'not comparable'}). ` +
      'Defaulting to re-upload: a needless upload costs one idempotent call, ' +
      'a skipped one ships the wrong app and reports success (ace#1643).',
  );
  return {
    app,
    drift: true,
    action: 'reupload-reapply-settings-then-build',
    conclusive: false,
    reasons,
    signals,
  };
}

/** One-line audit string for `app-release_summary.md`. */
export function formatDriftDecision(d: AppDriftDecision): string {
  const verdict = d.drift
    ? d.conclusive
      ? 'DRIFT'
      : 'DRIFT (undetermined — defaulted)'
    : 'NO DRIFT';
  return `${d.app}: ${verdict} → ${d.action}. ${d.reasons.join(' ')}`;
}
