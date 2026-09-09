/**
 * Three ways a DDD scene reports `ok: true` while demonstrating nothing — all
 * decidable from the spec, before a single frame is rendered.
 *
 * All three surfaced on the SAME run, spark-facilitator/20260813-2126.
 *
 * ## #1379 — the click landed on prose
 *
 * Scene 3 filters twenty facilitators down to nine:
 *
 * ```yaml
 * - kind: click     target: text:Needs a look
 * - kind: wait_for  target: text:Showing
 * ```
 *
 * `record_video` reported **39 actions: all ok**. The frame showed the
 * checkbox UNCHECKED and the table reading "showing 20 of 20 facilitators".
 * `getByText('Needs a look')` matched THREE nodes — a card-subtitle DIV, the
 * actual LABEL control, and a reconciliation-sentence DIV — and `.first()`
 * took the DIV. **Clicking a div succeeds.** And `wait_for text:Showing` is
 * satisfied in both states, so the gate could not fail either.
 *
 * The extra DIV had been added by an earlier craft pass reconciling three
 * attention counts — a legitimate product improvement silently broke a
 * walkthrough scene, which is why "target the control, not the words" is a
 * contract and not a style note.
 *
 * ## #1380 — the scene was not idempotent
 *
 * Scene 5 clicks "Draft coaching message". The first render CREATED coaching
 * draft #5139 on the live dashboard. On the next render the button read "Open
 * draft #5139", the click failed `target_not_found`, and the scene captured
 * the un-drafted state while the narration described a draft being written.
 *
 * Worse: the frame-fit verifier replays the same actions, so **running the
 * verifier consumes the precondition for the render that follows it**. Two
 * tools that each need pristine state, run back to back, guarantee the second
 * sees dirty state.
 *
 * ## #1365 — the artifact framed under a fixed header (RETRACTED, ace#1660)
 *
 * This module used to carry a `scroll-under-fixed-header` check: it flagged
 * every `scroll_to` whose `offset` was under 72px and told the author to pass
 * `offset: 96`. **Both halves were wrong, and the check is deleted. Do not
 * re-add it.**
 *
 * 1. **The remediation named a field canopy REJECTS.** `ScrollToAction` in
 *    canopy's `runtime/scripts/narrative/models.py` declares only `kind` and
 *    `target` (plus `note` / `must_succeed` / `timeout_ms` from `_ActionBase`),
 *    and `_ActionBase` sets `model_config = ConfigDict(extra="forbid")` — which
 *    its own docstring calls "the whole point of the discriminated union".
 *    Constructed against canopy 0.2.423:
 *    `ScrollToAction(kind="scroll_to", target="…", offset=96)` →
 *    `('offset',) Extra inputs are not permitted`. An author who followed the
 *    remediation converted a passing spec into one canopy refuses.
 *
 * 2. **The premise was stale.** The recorder does not stop at
 *    `scroll_into_view_if_needed`. `runtime/scripts/walkthrough/_lib/recorder.py`
 *    chases it with an explicit centring scroll —
 *    `window.scrollTo({top: y + window.scrollY - window.innerHeight / 2})` —
 *    which puts the element's top edge at the vertical CENTRE of the viewport,
 *    unreachable by a 72px fixed bar on any viewport taller than ~144px. That
 *    is ace#1365's own fix, closed COMPLETED 2026-08-14; the check outlived it
 *    and kept reporting a defect that had already been repaired.
 *
 * On bednet-check-2-visit/20260825-1310 it drew 5 findings, all false, on a
 * spec that validates clean. There is no `offset`-shaped field in canopy's
 * schema at any level, so the only honest levers on framing today are `scroll`
 * to `top`/`bottom` (its `value` takes a pixel offset) or a per-scene
 * `viewport`. This is the same shape as ace#1519 — a checker inventing syntax
 * for a system it does not own — which is why the remediation vocabulary is
 * now pinned by a test (see `test/lib/ddd-scene-actions.test.ts`).
 *
 * ## #1670 — the demonstration was impossible on the data
 *
 * Different failure, same shape: the spec is structurally perfect and
 * semantically empty. On bednet-check-2-visit/20260825-1310 a scene filtered a
 * **five-worker** cohort. Filtering 5 rows removes at most 4 of them, so the
 * before-frame and the after-frame are the same screenshot minus a line or two
 * and the demonstration has no observable effect. Every existing gate passed
 * it — the action is well-formed (`checkSceneActions`), the spec is valid
 * (`scripts.ddd.validate`) — and it was only caught by the concept judge after
 * a full render, four iterations in, ending the loop `stopped_not_converged`
 * at concept 3.0.
 *
 * The two numbers that decide it existed before the first frame was recorded:
 * the generator's own `synthetic_generate_from_manifest` response carried
 * `record_counts` = `{opportunity: 1, user_visits: 276, user_data: 5, ...}`.
 * `demo-narrative` simply had no cardinality input — `realized.json` is a flat
 * URL map by design, and `products.synthetic.source` carried no counts. So the
 * skill could not tell a filter over 5 rows from one over 500.
 *
 * `checkSceneCardinality` is that check: each demonstration verb needs a
 * MINIMUM cardinality on a specific axis to be observable, and the axis it
 * needs is not always the axis the dataset is big on — 276 visits spread over
 * one week is a trend demo with nothing to plot, on the same dataset where a
 * worker filter has nothing to filter.
 *
 * ## #1841 — the demonstration was DETECTION, and the rule could not see it
 *
 * ace#1670's sibling, one verb over. On hh-poverty-targeting/20260828-0702 the
 * premise of the whole demo was *"the platform's automated flag finds the
 * worker you would otherwise miss"* — over a **seven-worker** cohort.
 * `checkSceneCardinality` returned ok with zero findings, `checkSceneActions`
 * was clean, and the concept judge then said post-render exactly what a
 * cardinality rule says pre-render:
 *
 * > the demo is 7 workers on one screen, where a manager can find sigma 7.1 by
 * > eye — so automated flagging is never shown doing work a person couldn't do
 *
 * `stopped_not_converged`, concept 2.0/5, four render iterations. #1670's cost
 * profile exactly.
 *
 * Two things were missing, and BOTH were load-bearing:
 *
 * 1. **No detection verb.** `DEMONSTRATION_VERBS` knew filter/trend/comparison
 *    and nothing else, so a flag-finds-the-outlier scene matched no pattern.
 * 2. **The text surface was too narrow to carry the verb even once it existed.**
 *    The check read `title` plus action targets only. Measured against that
 *    run's spec (`7-synthetic/hh-poverty-targeting-answer-quality.yaml`, Drive
 *    1ZDKLQFHBGX9s3Xp9FmjyHzlRPecwwv50lEbUDuZ08TA): the detection vocabulary
 *    appears **20+ times and in not one title** — it lives in `show`,
 *    `concept_claim`, and `features[].description` / `.verify`, which are where
 *    an author states what a surface renders. So the check now reads those too.
 *    They are real canopy `Scene` fields (`models.py`), not invented ones.
 *
 * The same measurement corrected the vocabulary. The issue proposed
 * `flag|outlier|anomaly|detect|surfaces|catches|spots|misses`; in that spec
 * `flagged` appears only in top-level `capabilities`/`getting_started` and
 * `detectable` only inside a provenance slug — **zero per-scene hits**. The
 * word the run actually used is `mark` (marks / marked / marking / marker), 20
 * of the 20-odd hits. A pattern without it would have shipped green and caught
 * nothing, which is why the vocabulary is read off the artifact rather than
 * guessed (CLAUDE.md § close the loop to the source of truth).
 *
 * ## Scope
 *
 * The RUNTIME halves belong in canopy's walkthrough runner — resolving an
 * ambiguous `text:` target to the interactive node, comparing a gate against
 * the captured before-frame, and replaying restores.
 * This module is the ACE half: what `demo-narrative` can decide about its own
 * spec before handing off to the DDD loop.
 */

export interface SceneAction {
  kind: string;
  target?: string;
}

export interface SceneFeature {
  description?: string;
  verify?: string;
}

export interface DddScene {
  title?: string;
  actions?: SceneAction[];
  /** Off-camera actions restoring this scene's precondition (#1380). */
  restore?: SceneAction[];
  /**
   * The author's own prose about what this scene DEMONSTRATES — canopy `Scene`
   * fields, all three (`show`, `concept_claim`, `features`) declared in
   * `runtime/scripts/narrative/models.py`. `checkSceneCardinality` reads them
   * because a title frequently does not name the demonstration at all: across
   * the eight scenes of hh-poverty-targeting/20260828-0702 the detection
   * vocabulary appears 20+ times and in NOT ONE title (ace#1841).
   */
  show?: string;
  concept_claim?: string;
  features?: SceneFeature[];
}

export type SceneFindingKind =
  | 'ambiguous-text-target'
  | 'non-discriminating-gate'
  | 'mutation-without-restore'
  /** #1670 — the demonstration needs more cardinality than the data has. */
  | 'insufficient-cardinality'
  /** #1670 — the axis this demonstration depends on is not in the handoff. */
  | 'unknown-cardinality'
  /** ace#2316 — the below-programme-scale escape was taken and its promise broken. */
  | 'escaped-payoff-unhonoured';

export interface SceneFinding {
  kind: SceneFindingKind;
  scene: string;
  detail: string;
}

export interface SceneReport {
  ok: boolean;
  findings: SceneFinding[];
}

/**
 * canopy's recorder prefixes, verbatim.
 *
 * `_PREFIXES = ("css", "text", "testid", "aria", "role")` with
 * `_PREFIX_SEPARATOR = ":"` in
 * `runtime/scripts/walkthrough/_lib/targets.py` (read against canopy 0.2.423).
 * `parse_target` looks for an exact `<prefix>:` match and returns
 * `("auto", target)` for everything else — so any OTHER spelling (`css=`,
 * `label:`, `xpath=`) falls through to the bare-string heuristic, i.e. the very
 * ambiguous-text resolution these checks exist to guard against. There is no
 * `=` form. (ace#1519.)
 */
const RECORDER_PREFIXES = ['css', 'text', 'testid', 'aria', 'role'] as const;

/**
 * The subset that names a CONTROL rather than whatever text matches first —
 * every recorder prefix except `text:` (the ambiguous form). `role:` also takes
 * a name segment (`role:button:Save`), which is why matching is prefix-only.
 */
const CONTROL_SELECTOR = /^(css:|testid:|aria:|role:)/i;

/** Strips any recorder prefix, so a word count sees the author's words only. */
const ANY_RECORDER_PREFIX = new RegExp(`^(${RECORDER_PREFIXES.join('|')}):`, 'i');

/**
 * Verbs whose click CREATES or DESTROYS something, so the same action finds a
 * different affordance on a re-run.
 */
const MUTATING_VERB =
  /\b(draft|create|send|submit|award|approve|reject|delete|discard|publish|invite|assign|archive)\b/i;

function targetText(t: string | undefined): string {
  return (t ?? '').replace(ANY_RECORDER_PREFIX, '').trim();
}

export function checkSceneActions(scenes: DddScene[]): SceneReport {
  const findings: SceneFinding[] = [];

  for (const s of scenes ?? []) {
    const name = s.title ?? '(untitled)';
    const actions = s.actions ?? [];
    const hasRestore = (s.restore ?? []).length > 0;

    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];

      if (a.kind === 'click' && !CONTROL_SELECTOR.test(a.target ?? '')) {
        findings.push({
          kind: 'ambiguous-text-target',
          scene: name,
          detail:
            `click targets "${a.target}" by TEXT. A text selector resolves .first() in DOM order, and ` +
            'clicking a non-interactive node SUCCEEDS — so the action reports ok while nothing happens. ' +
            'Target the control with a recorder prefix — css: / testid: / aria: / role:',
        });
      }

      if (a.kind === 'click' && MUTATING_VERB.test(targetText(a.target)) && !hasRestore) {
        findings.push({
          kind: 'mutation-without-restore',
          scene: name,
          detail:
            `click "${a.target}" creates or destroys a persistent object, so this scene is ` +
            'NOT idempotent — on the second render the same action finds a different affordance and ' +
            'fails. Declare a `restore:` block that returns the page to this scene\'s precondition — ' +
            'and note it must run before EVERY render and before every frame-fit pass, since the ' +
            'verifier replays these actions too',
        });
      }

      if (a.kind === 'wait_for') {
        // A gate must name something only the POST state contains. The tell of
        // a gate that cannot discriminate is that it is a bare prefix — no
        // number, no changed word — of text present either way.
        //
        // The heuristic is a WORD COUNT, so it only means anything on a target
        // made of words. A control selector (`testid:`/`css:`/`aria:`/`role:`)
        // names one specific element by id, and whether that element is present
        // only in the post-state is a fact about the DOM that no amount of
        // counting its id's words can answer — `testid:coverage-table` would be
        // flagged and `testid:coverage-table-9` waved through, for the same
        // gate. So: skip the heuristic when the author has already named a
        // control, and apply it to `text:`/bare targets, whose words ARE the
        // gate. Before ace#1660 only `text:` was stripped, so every control
        // selector was measured with its prefix still attached and flagged
        // unless its id happened to contain a digit — penalising exactly the
        // form `ambiguous-text-target` tells authors to use.
        const named = CONTROL_SELECTOR.test(a.target ?? '');
        const gate = targetText(a.target);
        const discriminating = /\d/.test(gate) || gate.split(/\s+/).length >= 4;
        if (!named && !discriminating) {
          findings.push({
            kind: 'non-discriminating-gate',
            scene: name,
            detail:
              `wait_for "${gate}" is satisfied before the action as well as after, so it gates nothing. ` +
              'Gate on a value only the post-state carries (a count, a status word, the new id)',
          });
        }
      }

    }
  }

  return { ok: findings.length === 0, findings };
}

/* ────────────────────────── #1670 — cardinality ────────────────────────── */

/**
 * The three axes a demonstration can need. Which one a verb needs is the whole
 * point — a dataset can be large on one axis and empty on another, and the
 * scene only cares about the axis its own demonstration acts on.
 *
 * - `rows`    — entities the surface enumerates one line per; what a filter,
 *               a search, or a sort acts on.
 * - `periods` — distinct time buckets the data spans; what a trend plots.
 * - `groups`  — distinct groups (LLOs, sites, cohorts, arms) a comparison
 *               contrasts.
 */
export type CardinalityAxis = 'rows' | 'periods' | 'groups';

/**
 * The realized dataset's shape, per axis. Sourced from the generator's own
 * numbers via `demo-data-setup` — see `datasetShapeFromRecordCounts` for what
 * `record_counts` can and cannot answer.
 *
 * An axis left `undefined` is UNKNOWN, not zero, and produces an
 * `unknown-cardinality` finding rather than silence: silence on an unknown
 * axis is precisely the ace#1670 failure, where the skill had no cardinality
 * input at all and authored the scene anyway.
 */
export interface DatasetShape {
  rows?: number;
  periods?: number;
  groups?: number;
}

/**
 * Minimum cardinality per axis for the demonstration to be OBSERVABLE. Each is
 * derived from what has to be visible in a captured frame, not picked to fit
 * the one run that failed.
 */
export const MIN_CARDINALITY: Readonly<Record<CardinalityAxis, number>> = {
  /**
   * **12 rows for a filter / search / sort.**
   *
   * Principle: a filter demonstration is observable only if BOTH frames read
   * as lists AND the difference between them registers without counting. So
   * the after-state must still be a list (≥3 rows — two rows read as a pair,
   * one reads as an empty state), and the filter must remove enough rows that
   * the change is legible at a glance rather than a diff (~8 rows, roughly a
   * third of a table's visible height at 1280x800, is the smallest drop a
   * viewer registers as "the list got shorter"). 3 + 8 = 11, rounded to 12 —
   * about one screenful of a dashboard table before it scrolls.
   *
   * The observed failure was 5, but 5 is not the rule: at 5 rows the maximum
   * possible removal is 4 and the after-state is 1-2 lines, so it fails both
   * halves at once. A 9-row cohort fails the second half alone and is just as
   * unwatchable.
   */
  rows: 12,
  /**
   * **4 periods for a trend.**
   *
   * Principle: a trend claim is a claim about DIRECTION, and the narration
   * always names a turn ("it was flat, then the coaching landed"). Two points
   * are a line with no shape; three can show one change of direction but leave
   * no baseline before it; four is the smallest series carrying a baseline,
   * the turn, and a period after it — i.e. the smallest series where the claim
   * is READ off the plot rather than asserted over it. Below 4, the honest
   * scene is a single-value callout, not a trend.
   */
  periods: 4,
  /**
   * **3 groups for a comparison.**
   *
   * Principle: with two groups one is always above the other, so the ordering
   * is the only possible outcome and carries no information about whether
   * being behind is unusual. Three is the smallest set where a comparison
   * shows a DISTRIBUTION — one group visibly off the pace of the others —
   * which is what "this site needs attention" actually claims.
   */
  groups: 3,
};

/**
 * **24 rows for a detection demonstration** — the one verb whose floor is NOT
 * its axis default (ace#1841).
 *
 * Filter and detection both act on `rows`, and they need different amounts of
 * it, because they are claims of different strength:
 *
 * - A filter claims **narrowing is meaningful** — the after-state still reads
 *   as a list and the drop registers at a glance. `MIN_CARDINALITY.rows` = 12.
 * - A detection claims **unaided scanning is not viable** — that the flag finds
 *   a worker a supervisor would otherwise miss. That is a claim about a human's
 *   working memory, and it is FALSE the moment the whole cohort fits in one
 *   look. At n=7 the judge found the outlier by eye and said so.
 *
 * The anchor is the one this module already fixed rather than a new estimate:
 * the `rows: 12` derivation calls 12 "about one screenful of a dashboard table
 * before it scrolls" at 1280x800. A cohort that fits in one screenful is
 * scannable by definition — you hold it all at once. For the comparison to
 * require scroll-and-compare across a fold, the cohort has to span more than
 * one look, so the floor is **two screenfuls: 2 x 12 = 24.**
 *
 * That derivation is only as good as the 12 it rests on, and neither number is
 * measured — no one has sat a reviewer in front of a 23-row table and timed
 * them. It is a stated, falsifiable estimate: if a detection demo at 24 rows
 * still reads as eyeballable to a judge, this number is wrong and the fix is to
 * raise BOTH constants, since they share an anchor. (ace#1841 estimated 25
 * independently, from the same screenful reasoning — close enough to be worth
 * recording, not close enough to matter.)
 */
export const DETECTION_MIN_ROWS = 24;

/**
 * Which axis each demonstration verb needs, and the vocabulary that names it.
 *
 * Derived from the scene the same way `checkSceneActions` derives its verbs —
 * from the words in the declared action targets (any recorder prefix stripped)
 * — plus the scene's own `title`, which is the author's name for the
 * demonstration and often the only readable place the verb appears when the
 * control is an opaque id like `testid:f1`.
 *
 * The vocabulary is deliberately TIGHT. A word that also occurs as ordinary
 * spec syntax or dashboard chrome must not be in it: `top` is a `scroll`
 * target, `weekly` is half the labs template names (`llo_weekly_review`), and
 * either would fire this check on scenes that demonstrate nothing of the kind.
 * Missing a demonstration costs one un-flagged scene; inventing one costs the
 * author's trust in every flag after it.
 */
const DEMONSTRATION_VERBS: ReadonlyArray<{
  axis: CardinalityAxis;
  verb: string;
  pattern: RegExp;
  /**
   * Floor for THIS verb, when the axis default is not the right bar. Two verbs
   * can act on the same axis and need different amounts of it — see
   * `DETECTION_MIN_ROWS` (ace#1841). Omitted = `MIN_CARDINALITY[axis]`.
   */
  min?: number;
  /**
   * How the scene fails when the floor is not met, in this verb's own terms.
   * A filter fails because the two frames look alike; a detection fails because
   * the reader beats the flag to the answer. Omitted = the before/after-frame
   * wording, which is what the original three verbs describe.
   */
  whyItFails?: string;
}> = [
  {
    axis: 'rows',
    verb: 'filter / search / sort',
    pattern: /\b(filter|filters|filtered|filtering|search|searches|searched|sort|sorts|sorted|narrow|narrows|narrowed|refine|refines|refined|shortlist)\b/i,
  },
  {
    /**
     * Detection acts on `rows` like a filter, but claims something stronger —
     * that the cohort is too large to scan — so it carries its own, higher
     * floor. ace#1841.
     *
     * The vocabulary is READ OFF the run that failed, not guessed. In
     * hh-poverty-targeting/20260828-0702's spec the words carrying the
     * detection premise are `mark` / `marks` / `marked` / `marking` / `marker`
     * (20 of ~22 hits) and `surfaced`; `flagged` occurs only in the top-level
     * `capabilities` block and `detectable` only inside a provenance slug, so
     * the issue's proposed pattern alone would have matched ZERO scenes.
     *
     * Deliberately OUT, on the module's own tight-vocabulary rule: bare `mark`
     * (matches the given name Mark), `missing` (`missing data` is dashboard
     * chrome), `mark-up`/`benchmark` (word boundaries already exclude them),
     * and `signal` / `unusual` / `stands out`, which are ordinary narrative
     * prose long before they are demonstrations.
     *
     * **`marker` / `markers` were also in, and came back OUT (ace#1893).**
     * They are the only NOUN forms the vocabulary ever carried, and a noun
     * names a thing on the screen rather than an act the platform performs.
     * Every other word here is a verb, an event, or the name of the object
     * detection produces (`outlier`, `anomaly`); `marker` is a badge.
     *
     * The false positive: hh-poverty-targeting/20260901-1932's payoff scene
     * `closing-the-window-on-the-record` claims only that *"A collection window
     * ends in a disposition stored per worker"* — a decision beat with no
     * detection claim in it — and matched on nothing but the word `marker`,
     * used twice for the small "recorded on this run" badge beside a saved
     * disposition (`show` and `features[].verify`). Reproduced by restoring the
     * author's original wording; the live artifact says `badge` because the
     * author renamed the noun to get past the flag, which IS the cost this
     * check is trying not to pay.
     *
     * Measured before removing them, over **10 authored specs / 59 scenes** —
     * every unified spec in Drive across 4 opps and 10 runs
     * (hh-poverty-targeting 20260824-1404 / 20260827-0323 / 20260828-0702 /
     * 20260901-1932, bednet-check-2-visit 20260817-1720 / 20260825-1310 /
     * 20260828-0629, spark-facilitator 20260820-0817 / 20260828-0703,
     * turmeric-market-study 20260807-1903), read over the same fields
     * `sceneWords` reads:
     *
     * - **26 scenes match the detection vocabulary. 24 of them carry a verb
     *   form.** Only 2 match on `marker` alone — and they are the SAME scene
     *   (`a-different-question`) in two revisions of one narrative. Add the
     *   reconstructed false positive and the noun forms are 1 true / 1 false
     *   across the two distinct scenes they alone decide: **~50% precise, and
     *   responsible for 8% of matches.**
     * - Removing them costs one scene of recall, and that scene IS a detection
     *   demonstration — but its `marker` hits are UI nouns too ("a
     *   band-boundary marker whose text repeats that worker's own share"). The
     *   check was right about it for the wrong reason: its actual detection
     *   premise ("separates workers the operations page showed as
     *   unremarkable") contains no vocabulary word at all. So the noun is not
     *   the signal in the true case either.
     * - **Spec-level recall is unchanged: 8 specs flagged before, 8 after.**
     *   Every spec containing a noun-only scene also contains a verb-form
     *   scene, so no spec that was flagged stops being flagged — 20260828-0702
     *   goes 6 findings -> 5 and 20260827-0323 goes 3 -> 2, while the fork
     *   20260901-1932 goes 1 -> 0, which is the defect. That is the metric that
     *   decides this: `checkSceneCardinality` FLAGS a spec for its author to
     *   resolve, and the second flag on a spec already flagged adds nothing.
     *
     * Two narrower repairs were measured and REJECTED rather than argued:
     *
     * - *Require a corroborating second vocabulary word for a noun-only match.*
     *   **24/26 — bit-identical to deletion on all 10 specs**, because every
     *   noun-only scene in the corpus matches on `marker` and nothing else. It
     *   buys no recall and costs a branch.
     * - *Exempt `features[].verify` as a test assertion rather than a claim.*
     *   **23/26, and strictly worse:** it does NOT clear the false positive
     *   (whose other hit is in `show`) and it silences two genuine verb-form
     *   scenes that declare themselves only in `verify`.
     */
    axis: 'rows',
    verb: 'detection / flagging',
    min: DETECTION_MIN_ROWS,
    whyItFails:
      'The whole cohort fits in one look, so a reviewer finds the flagged row by eye before the ' +
      'flag does — the demonstration renders green and never shows the platform doing work a ' +
      'person could not',
    pattern: /\b(flag|flags|flagged|flagging|outlier|outliers|anomaly|anomalies|anomalous|detect|detects|detected|detection|detectable|surfaces|surfaced|catches|spots|misses|missed|miss|marks|marked|marking)\b/i,
  },
  {
    axis: 'periods',
    verb: 'trend',
    pattern: /\b(trend|trends|trending|trajectory|timeline|progression|over time|week[- ]over[- ]week|month[- ]over[- ]month|recovery curve)\b/i,
  },
  {
    axis: 'groups',
    verb: 'comparison',
    pattern: /\b(compare|compares|compared|comparison|versus|vs|benchmark|benchmarks|leaderboard|ranking|rankings|side[- ]by[- ]side)\b/i,
  },
];

/**
 * The generator's `record_counts`, read honestly.
 *
 * `synthetic_generate_from_manifest` returns e.g.
 * `{opportunity: 1, user_visits: 276, user_data: 5, completed_works: 0,
 *   completed_module: 0}`. Only ONE of those keys is an entity population a
 * dashboard enumerates one row per: `user_data` (the worker cohort — the five
 * workers of ace#1670). `user_visits` is the FACT table those rows aggregate,
 * `completed_works` / `completed_module` are progress counters, and
 * `opportunity` is the container. So:
 *
 * - `rows` is answerable, and defaults to `user_data`.
 * - `periods` and `groups` are **NOT answerable from `record_counts`** — the
 *   response carries no dates and no grouping. They come from the generator
 *   MANIFEST (`demo-data-setup_manifest.yaml`: the `timeline` week span, and
 *   the number of opportunities / LLO cohorts), which `demo-data-setup`
 *   resolves and persists alongside the counts. Pass them via `known`.
 *
 * `known` also overrides `rows` — a dashboard that enumerates visits rather
 * than workers has 276 rows, not 5, and only the skill that authored the
 * dashboard knows which population it lists.
 */
export function datasetShapeFromRecordCounts(
  recordCounts: Record<string, number> | undefined,
  known: DatasetShape = {},
): DatasetShape {
  const rows = recordCounts?.user_data;
  const shape: DatasetShape = {};
  if (typeof rows === 'number') shape.rows = rows;
  for (const axis of ['rows', 'periods', 'groups'] as const) {
    if (typeof known[axis] === 'number') shape[axis] = known[axis];
  }
  return shape;
}

/**
 * Every word in a scene that could name its demonstration.
 *
 * The `title` and the action targets (any recorder prefix stripped) were the
 * whole surface until ace#1841, and they were not enough: an author names the
 * demonstration wherever it reads best, and across the eight scenes of
 * hh-poverty-targeting/20260828-0702 that was never the title. `show`,
 * `concept_claim` and `features[]` are the author's declarations of what the
 * surface renders — and all three are real canopy `Scene` fields, so reading
 * them invents no syntax (the ace#1519 hazard).
 *
 * This widening applies to EVERY verb, not just detection. An asymmetric
 * surface — this verb reads prose, that one does not — is a bug generator, and
 * a `show:` that says "the roster sorted by coverage" describes a sort demo
 * whichever field it sits in. Measured on the same spec: the filter / trend /
 * comparison vocabularies occur ZERO times anywhere in it, so the widening
 * added no finding there. That is one artifact, not a proof; the residual is
 * that prose is looser than a title and a verb word can appear in it
 * incidentally. The check FLAGS rather than rejects, which is the posture that
 * makes that residual affordable.
 *
 * The residual came due on the very next run (ace#1893), and the repair was to
 * the VOCABULARY, not to this surface: a noun (`marker`) names a thing prose
 * renders, so widening the surface to prose is exactly what promotes it from
 * harmless to load-bearing. The widening stayed — ablating it back to
 * title + targets took the same spec from 6 findings to 0 — and the noun forms
 * went. See `DEMONSTRATION_VERBS`' detection entry for the corpus measurement.
 */
function sceneWords(s: DddScene): string {
  return [
    s.title ?? '',
    ...(s.actions ?? []).map((a) => targetText(a.target)),
    s.show ?? '',
    s.concept_claim ?? '',
    ...(s.features ?? []).flatMap((f) => [f.description ?? '', f.verify ?? '']),
  ].join(' ');
}

/**
 * Name the axis the author should reach for instead — because "pick a
 * different demonstration" is only actionable if you know which one the data
 * can carry (ace#1841). On the hh-poverty-targeting cohort that is six weeks,
 * not seven workers.
 *
 * Written WITHOUT a colon after the axis name on purpose. Every remediation
 * this module emits is audited against canopy's own vocabulary, and `periods:`
 * would read as a spec key canopy rejects — the ace#1660 failure class, pinned
 * by `describe('remediation vocabulary')`.
 */
function axisWithRoom(shape: DatasetShape | undefined, failing: CardinalityAxis): string {
  const roomy = (['rows', 'periods', 'groups'] as const)
    .filter((a) => a !== failing)
    .filter((a) => typeof shape?.[a] === 'number' && (shape[a] as number) >= MIN_CARDINALITY[a])
    .map((a) => `${a} (${shape![a]})`);

  return roomy.length
    ? `The axis with room on this dataset is ${roomy.join(', and ')} — a demonstration on that ` +
        'axis needs no regeneration'
    : 'No other axis in the handoff has room either, so a different demonstration will not rescue ' +
        'this dataset — regenerate, or pass the counts for the axes the handoff is missing';
}

/**
 * Flag any scene whose demonstration needs more cardinality than the realized
 * dataset has (ace#1670).
 *
 * **This FLAGS, it does not reject** — and the distinction is deliberate. The
 * rule reads the data's shape but not the dashboard's rendering, so it cannot
 * know for certain WHICH population a given surface enumerates; a scene over a
 * 5-worker cohort may legitimately be filtering 276 visit rows. Refusing a
 * legal spec on a heuristic that can be wrong about the population is the
 * ace#1238 failure class — a guard predicting a rejection and blocking correct
 * work. A flag costs the author one decision and moves the discovery from
 * "four render iterations in" to "before the first frame". The skill's
 * contract is that every flag is RESOLVED explicitly — the demonstration
 * changes, the data is regenerated, or the author records which population the
 * surface actually lists — never silently carried past.
 */
/**
 * The DECLARED half of the detection floor (ace#2131).
 *
 * `checkSceneCardinality` enforces `DETECTION_MIN_ROWS` by reading the
 * NARRATIVE's vocabulary. That works only when the author writes `flag`,
 * `outlier` or `detect` — and a detection demo written in plain descriptive
 * language matches nothing. On `bednet-check-2-visit/20260902-1555` the scenes
 * said "Nadia R. records consent re-affirmed on all 54 of her follow-ups while
 * the other four workers sit between 79.2% and 88.0%" over a five-worker cohort:
 * textbook outlier detection, zero detection tokens, no finding — and Phase 7
 * ended `stopped_not_converged` at concept 2.0/5 on exactly the objection the
 * floor exists to pre-empt, raised independently by all five per-scene judges.
 *
 * Broadening the vocabulary is the wrong repair. ace#1841 PRUNED that list for
 * precision (26 scenes matched it, 24 carried a real verb), and a report-only
 * check that cries wolf is how the real misses get waved through (ace#1744).
 *
 * The fact is already stated one layer up, without inference.
 * `demo-data-setup` writes BOTH of these into the same `source` block, before
 * `demo-narrative` runs and long before anything renders:
 *
 *   source.detectable_signal   — the PDD control this demo instantiates
 *   source.data_shape.rows     — the cohort it actually realized
 *
 * A declared detection control against a cohort below the floor is a
 * contradiction knowable at authoring time, where the remedy is one manifest
 * edit and a regenerate rather than two burnt render+judge iterations.
 *
 * The two checks catch opposite halves and both are worth keeping: this one
 * catches a demo whose DATA cannot support the control it declares; the
 * vocabulary rule catches a narrative that CLAIMS detection the data never
 * declared.
 *
 * Silent when it cannot decide — an absent `detectable_signal`, the documented
 * `none` escape (the PDD declares no verification rules), or an unstated
 * `rows`. Guessing here would re-create the false-positive problem this design
 * is avoiding.
 */
export interface DeclaredSignalSource {
  detectable_signal?: unknown;
  data_shape?: DatasetShape;
}

export function checkDetectionCohortFloor(
  source: DeclaredSignalSource | undefined,
): SceneReport {
  const findings: SceneFinding[] = [];
  const signal = source?.detectable_signal;

  if (!declaresDetection(signal)) return { ok: true, findings };

  // The programme's OWN roster can sit below the floor, and then no honest demo
  // can clear it (ace#2131 follow-up). bednet-check-2-visit specifies "3-5
  // front-line workers"; step 1c REQUIRES instantiating a control whenever the
  // PDD declares one; and 24 synthetic workers would misrepresent a five-worker
  // pilot. Without this escape those three rules are jointly unsatisfiable, and
  // the only ways out are to lie about the scale or to strip a signal the data
  // should carry.
  //
  // So separate the two roles the signal plays. Carrying it in the DATA is what
  // makes the dashboards honest and is always right. Hanging the demo's PAYOFF
  // on unaided detection is the part that needs 24 rows. A programme below the
  // floor declares `below_programme_scale` with the PDD quote that proves it —
  // the same cite-your-source discipline step 1c already imposes on the signal
  // itself — and the demo keeps the signal while building its payoff elsewhere.
  const escape = programmeScaleEscape(signal);
  if (escape) return { ok: true, findings };

  const rows = source?.data_shape?.rows;
  if (typeof rows !== 'number' || !Number.isFinite(rows)) return { ok: true, findings };

  if (rows < DETECTION_MIN_ROWS) {
    findings.push({
      kind: 'insufficient-cardinality',
      scene: '(dataset)',
      detail:
        `this run DECLARES a detection control (${describeSignal(signal)}) and realized a cohort of ` +
        `${rows} row(s), below the ${DETECTION_MIN_ROWS} a detection demonstration needs to be ` +
        `observable. A detection claims unaided scanning is not viable; that claim is false the moment ` +
        `the whole cohort fits in one look, and a judge will say so. Fix it in the MANIFEST — raise the ` +
        `cohort and regenerate — not in the narration: no wording makes ${rows} rows unscannable. ` +
        `If the demo is not really about detection, drop detectable_signal or record the documented ` +
        `\`none\` escape, and this goes quiet`,
    });
  }

  return { ok: findings.length === 0, findings };
}

/**
 * Is a detection control actually declared? Accepts the two shapes the skill
 * documents — a structured block, or a string — and treats the `none` escape
 * ("detectable_signal: none (PDD declares no verification rules)") as NOT
 * declared, since that is the honest opt-out the authoring step provides.
 */
/**
 * An explicit, EVIDENCED declaration that the programme's own roster is below
 * `DETECTION_MIN_ROWS`, so the cohort cannot be raised without misrepresenting
 * it. Requires a non-empty quote: an unevidenced flag would be a silencer, and
 * this check is only worth having if turning it off costs the author the same
 * citation step 1c asks for.
 */
function programmeScaleEscape(signal: unknown): boolean {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return false;
  const v = (signal as Record<string, unknown>).below_programme_scale;
  return typeof v === 'string' && v.trim().length > 0;
}

function declaresDetection(signal: unknown): boolean {
  if (signal === undefined || signal === null) return false;
  if (typeof signal === 'string') return !/^\s*none\b/i.test(signal.trim());
  if (Array.isArray(signal)) return signal.length > 0;
  if (typeof signal === 'object') return Object.keys(signal as object).length > 0;
  return false;
}

function describeSignal(signal: unknown): string {
  if (typeof signal === 'string') return signal.slice(0, 80);
  if (signal && typeof signal === 'object') {
    const c = (signal as Record<string, unknown>).pdd_control;
    if (typeof c === 'string') return c.slice(0, 80);
  }
  return 'declared in source.detectable_signal';
}

export function checkSceneCardinality(
  scenes: DddScene[],
  shape: DatasetShape | undefined,
): SceneReport {
  const findings: SceneFinding[] = [];

  for (const s of scenes ?? []) {
    const name = s.title ?? '(untitled)';
    const words = sceneWords(s);

    for (const { axis, verb, pattern, min, whyItFails } of DEMONSTRATION_VERBS) {
      if (!pattern.test(words)) continue;
      const need = min ?? MIN_CARDINALITY[axis];
      const have = shape?.[axis];

      if (typeof have !== 'number') {
        findings.push({
          kind: 'unknown-cardinality',
          scene: name,
          detail:
            `this scene demonstrates ${verb}, which is observable only with enough ${axis} — at least ` +
            `${need} — and the realized dataset's shape carries no ${axis} count. A filter over 5 rows ` +
            'and one over 500 are indistinguishable from the spec alone, which is how ace#1670 reached ' +
            'the concept judge. Read the generator record_counts and manifest shape that demo-data-setup ' +
            'persists under products.synthetic.source, and pass them before authoring this scene',
        });
        continue;
      }

      if (have < need) {
        findings.push({
          kind: 'insufficient-cardinality',
          scene: name,
          detail:
            `this scene demonstrates ${verb}, which needs at least ${need} ${axis} to be observable, ` +
            `and the realized dataset has ${have}. ` +
            (whyItFails ??
              'The before-frame and the after-frame differ by too little to read as a ' +
                'demonstration, so the scene renders green and shows nothing') +
            '. That is how ace#1670 and ace#1841 both ended stopped_not_converged, four render ' +
            'iterations after the two numbers that decided it were already known. Two branches, ' +
            'both taken BEFORE authoring — pick a demonstration ' +
            `this dashboard's data can carry, or go back and regenerate with a larger cohort. ` +
            `${axisWithRoom(shape, axis)}. If this surface actually enumerates a different population ` +
            `than the ${axis} count given, say which and pass that count`,
        });
      }
    }
  }

  return { ok: findings.length === 0, findings };
}

/**
 * The `below_programme_scale` escape is a PROMISE. This is what keeps it.
 *
 * `checkDetectionCohortFloor` lets a programme whose own roster sits below
 * `DETECTION_MIN_ROWS` keep its detection signal in the DATA — carrying it is
 * what makes the dashboards honest — on the stated condition that the demo
 * builds "its payoff elsewhere". That escape returns `ok` immediately and never
 * looks at where elsewhere went, so the condition was unenforced prose.
 *
 * Measured, `spark-facilitator/20260908-2215`: the escape was taken with two
 * PDD quotes (~12 facilitators, one per community — correct and unarguable) and
 * the producer wrote the right mitigation down verbatim — *"the narrative's
 * payoff is built on the qualifying-share rule, which holds at any cohort size,
 * rather than on a claim that unaided scanning is impossible."* The authored
 * payoff then clicked `testid:below-target-filter` to hide 10 of 12 rows, which
 * IS the claim it had just promised not to make. All four independent judges
 * capped `use_case_soundness` at 3 on exactly that — *"a checkbox that hides
 * ten rows off a table that already fitted on one screen"* — which pins concept
 * below the 4.0 convergence bar. Three consecutive runs of this opp ended
 * non-converged and no check in ACE was looking at this.
 *
 * The root cause is upstream of the narrative: the dashboard was instantiated
 * from `llo_weekly_review`, whose only interactive affordances are an
 * underperforming-only filter and a coaching-task button, so no control on the
 * page COULD demonstrate the payability rule. `demo-narrative` is told to
 * author the payoff against the interactive dashboard, so it used what existed.
 * Hence the fix is a declaration made at authoring time (`demo-data-setup`
 * step 0 derives the required control from the PDD's verification predicate
 * BEFORE selecting a template) and verified here.
 *
 * Keyed on the ARTIFACT, never on a vocabulary: it asks only whether the
 * payoff scene acts on the control the author DECLARED. A word list is what
 * ace#1841 pruned for precision and ace#2131 then evaded by writing the same
 * demo in plain prose — an identity match cannot be evaded by rephrasing.
 *
 * Silent unless the escape was actually taken, so a demo at or above the floor,
 * or one that never declared a signal, is unaffected.
 */
export interface EscapedPayoffSource extends DeclaredSignalSource {
  /**
   * The on-dashboard control the payoff scene acts on, as a canopy target
   * (`testid:…` / `text:…`). Required once the escape is taken.
   */
  payoff_control?: unknown;
}

export function checkEscapedPayoffIsHonoured(
  source: EscapedPayoffSource | undefined,
  scenes: DddScene[] | undefined,
): SceneReport {
  const findings: SceneFinding[] = [];
  const signal = source?.detectable_signal;

  // Only bites where the promise was made.
  if (!declaresDetection(signal)) return { ok: true, findings };
  if (!programmeScaleEscape(signal)) return { ok: true, findings };

  const declared = typeof source?.payoff_control === 'string' ? source.payoff_control.trim() : '';

  if (declared.length === 0) {
    findings.push({
      kind: 'escaped-payoff-unhonoured',
      scene: '(dataset)',
      detail:
        `this run took the \`below_programme_scale\` escape on its detection floor, which is granted ` +
        `ONLY on the condition that the payoff is built elsewhere — but \`source.payoff_control\` names ` +
        `no control, so there is nothing to build it on and nothing to check. Declare the control the ` +
        `payoff scene acts on (a canopy target, e.g. \`testid:…\`) together with the one-line decision ` +
        `it demonstrates, derived from the PDD's own verification predicate. If the dashboard carries no ` +
        `such control, that is the finding: the template was selected before the demonstration was ` +
        `chosen, and the control has to be authored onto the page rather than borrowed from the template`,
    });
    return { ok: false, findings };
  }

  // Scenes not available yet (QA can run before the narrative exists) — report
  // the declaration as accepted and leave the honouring half to the re-run.
  if (!Array.isArray(scenes) || scenes.length === 0) return { ok: true, findings };

  const acted = scenes.some((scene) =>
    (scene?.actions ?? []).some(
      (a) => typeof a?.target === 'string' && targetsSameControl(a.target, declared),
    ),
  );

  if (!acted) {
    findings.push({
      kind: 'escaped-payoff-unhonoured',
      scene: '(spec)',
      detail:
        `the escape promised the payoff would rest on \`${declared}\`, and no scene ACTS on it — the ` +
        `promise was made at authoring time and dropped at narrative time, which is exactly how ` +
        `spark-facilitator/20260908-2215 shipped a payoff that hid 10 of 12 rows after declaring it ` +
        `would not. Either author the payoff scene against \`${declared}\`, or, if that control does ` +
        `not exist on the dashboard, put it there — do not re-point the declaration at whichever ` +
        `filter the template happened to provide, which re-creates the defect with a passing check`,
    });
  }

  return { ok: findings.length === 0, findings };
}

/**
 * Same control? Compared on the canopy target, prefix-aware, so
 * `testid:below-target-filter` and `below-target-filter` match while
 * `testid:coach-x` and `testid:coach-y` do not. Deliberately an identity
 * comparison and not a substring one: `testid:filter` must not satisfy a
 * declaration of `testid:filter-and-approve`.
 */
function targetsSameControl(actionTarget: string, declared: string): boolean {
  return stripTargetPrefix(actionTarget) === stripTargetPrefix(declared);
}

function stripTargetPrefix(target: string): string {
  const t = target.trim();
  const i = t.indexOf(':');
  if (i === -1) return t.toLowerCase();
  const prefix = t.slice(0, i).toLowerCase();
  // canopy's recorder prefixes, verbatim (targets.py `_PREFIXES`).
  if (['css', 'text', 'testid', 'aria', 'role'].includes(prefix)) {
    return t.slice(i + 1).trim().toLowerCase();
  }
  return t.toLowerCase();
}
