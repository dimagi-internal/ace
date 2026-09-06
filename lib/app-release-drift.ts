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
 * (dimagi-internal/ace#1789, ace#1807)
 *
 * `commcare_make_build` versions the CCHQ draft; `run-form-walk --draft-only`
 * reads THAT draft, and it counts on a DIFFERENT BASIS from Nova's `get_app`
 * in two independent ways: it never emits `kind: hidden` fields (#1789), and a
 * container contributes a row only if it rendered a label (#1807). A caller who
 * feeds the classifier a raw Nova total — or one normalized only for hidden
 * fields — gets a mismatch. `countNovaVisibleFields` is the boundary fix and
 * carries the full derivation; do not re-derive the rule by hand.
 *
 * Live repro (`bednet-check-2-visit/20260828-0629`): Learn 44 (Nova, raw) vs
 * 32 (HQ draft); Deliver 17 vs 14. Excluding hidden fields both matched
 * exactly, and both apps had `novaEditedSinceDeploy: false`. Residual repro
 * (`spark-facilitator/20260828-0703`): the meeting form still read 54 vs 53
 * after the #1789 correction, the whole delta being one unlabelled container.
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
   * Field count across all forms on the Nova blueprint, on the SAME BASIS the
   * HQ draft walk uses. **Compute it with `countNovaVisibleFields` — do not do
   * the arithmetic by hand and do not pass the raw `get_app` total.** Two
   * separate normalizations are required and each was found the hard way
   * (ace#1789, then ace#1807); the rule is stated on that function.
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

/**
 * One field as Nova's blueprint carries it (`get_app` / `get_form`) — the same
 * shape `lib/screen-shape.ts § ScreenField` reads.
 */
export interface NovaBlueprintField {
  /** `group`, `repeat`, `single_select`, `label`, `hidden`, `text`, … */
  kind: string;
  /** Rendered label text. A container with an EMPTY label is the ace#1807 case. */
  label?: string;
  /** Children of a `group` / `repeat`. */
  children?: NovaBlueprintField[];
}

/** Nova kinds that contain other fields rather than being one. */
const CONTAINER_KINDS = new Set(['group', 'repeat']);

/**
 * `novaVisibleFieldCount` — Nova's blueprint counted on the basis the HQ draft
 * walk actually produces, so `classifyAppDrift` compares like with like.
 *
 * **The rule: every non-`hidden` LEAF, plus every container that carries a
 * NON-EMPTY label.**
 *
 * ## Why each half is here, and how each was measured
 *
 * `commcare_make_build` versions the CCHQ draft; `scripts/run-form-walk.ts
 * --draft-only --with-fields` reads that draft. Its `walkFormFields` skips the
 * `<group>` element itself but recurses into it, so a group contributes a row
 * **iff it emitted a `<label>` child** — and it emits no hidden fields at all.
 * Nova's `get_app` counts every field including hidden ones and every
 * container regardless of label. Two different bases, two corrections:
 *
 * 1. **Hidden leaves (ace#1789).** Every ACE app carries them (`user_score`,
 *    `qN_score`, `case_name`, `entity_key`, `entity_label`, …), so a raw Nova
 *    total mismatches on essentially every run. Live repro
 *    `bednet-check-2-visit/20260828-0629`: Learn 44 (raw) vs 32 (HQ draft),
 *    Deliver 17 vs 14; excluding hidden leaves both matched exactly.
 *
 * 2. **Unlabelled containers (ace#1807).** A group whose label is empty
 *    compiles to a self-closing `<group ref="…"/>` with no `<label>` child, so
 *    the walk emits nothing while Nova still counts 1.
 *
 * ## ace#1807's stated mechanism was REFUTED, and this is the corrected rule
 *
 * The issue read the delta as *"a group whose children are all hidden has no
 * body element at all"*. The compiled artifact says otherwise. Released Deliver
 * build `b08533bdf26a48a295a362ff204fb88d` (spark-facilitator/20260828-0703),
 * vendored verbatim at `test/fixtures/ccz/spark-facilitator-meeting-record.xml`:
 *
 * ```
 * $ # every <group ref=...> in <h:body>
 * group elements in body: 14      # all 14, meeting_summary INCLUDED
 * ...
 * '  </input>\n    </group>\n    <group ref="/data/meeting_summary"/>\n  </h:body>'
 * ```
 *
 * The element is emitted. What is absent is its **label** — and it is absent
 * because Nova's label for that group is the empty string, not because its
 * eight children happen to be hidden. Those two properties merely coincide on
 * this one group. Excluding on "all descendants hidden" would therefore be
 * wrong in both directions: it would drop a LABELLED all-hidden container that
 * the walk does count, and keep an UNLABELLED container with visible children
 * that the walk does not.
 *
 * ## The arithmetic, both forms, both sides measured
 *
 * `walkFormFields` run on the two vendored compiled forms:
 *
 * ```
 * modules-0/forms-0.xml: walkFormFields emits 16
 * modules-1/forms-0.xml: walkFormFields emits 53
 * ```
 *
 * and this function on the same app's Nova blueprint:
 *
 * | Form | Nova raw | hidden leaves | labelled containers | this fn | HQ walk |
 * |---|---|---|---|---|---|
 * | Community enrolment      | 20 | 4  | 4 of 4  | 16 | 16 |
 * | Community meeting record | 65 | 11 | 13 of 14 | 53 | 53 |
 *
 * `test/lib/app-release-drift.test.ts` recomputes the right-hand column from
 * those fixtures at test time rather than trusting these numbers.
 */
export function countNovaVisibleFields(fields: NovaBlueprintField[]): number {
  let n = 0;
  for (const f of fields) {
    if (CONTAINER_KINDS.has(f.kind)) {
      // A container is a row on the HQ side only if it rendered a label.
      if ((f.label ?? '').trim() !== '') n += 1;
      n += countNovaVisibleFields(f.children ?? []);
      continue;
    }
    if (f.kind === 'hidden') continue;
    n += 1;
  }
  return n;
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
