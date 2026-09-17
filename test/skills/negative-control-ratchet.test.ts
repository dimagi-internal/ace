import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXTRA_SURFACES,
  classifyCoverage,
  extractTestBlocks,
  negativeSignal,
  positiveSignal,
  surfaceKey,
  surfacesIn,
  type CheckSurface,
  type TestBlock,
} from '../../lib/negative-control-coverage';

/**
 * Every structural check must have a test that feeds it a KNOWN-BAD input and
 * asserts it reports FAILURE.
 *
 * ## The failure class
 *
 * A check that reports success while being structurally incapable of
 * reporting failure. It is worse than no check, because it launders
 * confidence — a green gate reads as evidence, and evidence is the one thing
 * it could never produce.
 *
 * Measured over ONE ACE run (`spark-facilitator/20260820-0817`, 2026-08-26/27):
 * 15 issues filed, **10 of them defects in gates, linters or evals** rather
 * than in the product. Three were `blocks-e2e`, and all three lived in the
 * same place:
 *
 *   | Issue | Why the check could not fail                                     |
 *   |-------|------------------------------------------------------------------|
 *   | #1693 | `auditDataset` read an AND of gates as INDEPENDENT, so any       |
 *   |       | multi-gated field violated in both directions at once. Check 9   |
 *   |       | could never pass on a nested-`relevant` form — 12 of 59 derived   |
 *   |       | fields were unsatisfiable by construction.                        |
 *   | #1695 | `scrubOffBranchFields` reported a legitimately-never-asked field  |
 *   |       | as unresolved, so an honest dataset failed a check it could not   |
 *   |       | satisfy.                                                          |
 *   | #1701 | Check 7 THREW on every real payload — labs writes                 |
 *   |       | `snapshot.pipelines` as a dict keyed by alias and the check       |
 *   |       | iterated it as an array. Its `snapshot-missing-pipelines` branch  |
 *   |       | was unreachable besides: a dict has no `.length`, and            |
 *   |       | `undefined === 0` is false.                                       |
 *   | #1679 | `ocs-chatbot-qa`'s wrong-embed-key negative control was           |
 *   |       | documented as 403 and live returns 401 — and a MISSING key was    |
 *   |       | not rejected at all (201). Written from that prose, the control   |
 *   |       | could never fire.                                                 |
 *
 * Phase 7's data gate had never once run to a genuine pass. Nobody knew,
 * because every one of those checks was green on every input it was ever
 * given. Each was found by a human reading a report that looked fine.
 *
 * ## What a negative control is, and is not
 *
 * A **negative control** feeds a check a known-bad input and asserts the check
 * reports FAILURE. It is not "a test that the check runs", and it is not a
 * positive case. Every check also needs at least one **positive control**, or
 * a check hard-wired to fail satisfies the rail while gating nothing — the
 * always-fires class (ace#1026), the same defect wearing the opposite sign.
 *
 * The author contract — including how to derive a bad input without copying
 * the check's own logic — is `skills/README.md § Negative controls`.
 *
 * ## Two ways a check fails to be a check
 *
 * 1. **Not falsifiable** — invoked, but cannot report failure on a bad input.
 *    Every issue in the table above.
 * 2. **Not reachable** — perfectly falsifiable, and nothing calls it.
 *    `lib/choice-label-integrity.ts` exports `checkMarkdownEatenLabels` and
 *    `checkCaseListEnumDrift`, both with real tests, and every reference
 *    outside the module is prose in `skills/_app-component-library.md` saying
 *    "Enforced by:". Nothing executes them (ace#1688/#1689; wiring in flight
 *    with another agent — referenced here, not touched).
 *
 * Same root cause: the invariant lives in prose rather than in a hook. A
 * ledger that can only express (1) mislabels (2) as healthy, so every entry
 * carries a `reason`, and reachability is measured rather than assumed.
 *
 * ## Why a ratchet rather than a hard bar
 *
 * ACE's real coverage is already good — see `BASELINE_NOTE`. The value here is
 * not a sweeping remediation, it is that the good state cannot silently erode.
 * The known-uncovered set is pinned in `LEDGER` and this test blocks only what
 * is NEW. Shrinking `LEDGER` is always allowed and never needs this file
 * rewritten — the assertion is one-directional.
 *
 * Modelled on `test/skills/predictive-guard-citation.test.ts`, deliberately.
 */

const repoRoot = new URL('../..', import.meta.url).pathname;

/** Why a surface sits in the ledger. Every entry names at least one. */
type LedgerReason =
  /** Invoked (or invocable), but no test asserts it reports failure. */
  | 'no-negative-control'
  /** Has a negative control but nothing proves a clean input passes. */
  | 'no-positive-control'
  /** Falsifiable, but nothing outside its own tests ever calls it. */
  | 'no-call-site'
  /**
   * Returns a verdict vocabulary of its own (`{ satisfiable }`, `{ stale }`)
   * rather than `QACheckResult` / `CheckOutcome` / a findings report, so
   * whether a test asserts failure is not decidable syntactically. Tier 2:
   * pinned by name, not asserted. Pay down by adopting a uniform shape.
   */
  | 'bespoke-verdict';

interface LedgerEntry {
  reason: LedgerReason[];
  note: string;
}

/**
 * Known-uncovered check surfaces. This is a DEBT LEDGER, not an approval —
 * every entry is a gate that has never been shown able to fail, or that
 * nothing calls. Lower this list; do not add to it.
 *
 * Entries name the CHECK, not a count, because a bare number is unactionable:
 * "3 uncovered" tells an author nothing about what to write.
 *
 * An entry leaves the ledger by gaining the missing control, gaining a call
 * site, adopting a uniform verdict shape — or by the check being deleted,
 * which for a gate nobody calls and nobody can fail is also progress.
 */
const LEDGER: Record<string, LedgerEntry> = {
  'lib/assessment-coverage-feasibility.ts::checkCoverageFeasibility': {
    reason: ['bespoke-verdict'],
    note:
      'Returns `FeasibilityVerdict { feasible: boolean, maxRatio, ceilingScore, … }`. ' +
      'Hand-verified 2026-08-27: three negative controls (`expect(r.feasible).toBe(false)`) ' +
      'and positive ones. Pay down by returning `CheckOutcome` or renaming `feasible` -> `ok`.',
  },
  'lib/constraint-satisfiability.ts::checkPairSatisfiable': {
    reason: ['bespoke-verdict'],
    note:
      "Returns `PairVerdict { satisfiable: boolean | 'unknown' | 'not-applicable' }` — three-valued, " +
      "so `satisfiable: true` is a pass while a sibling check's `stale: true` is a failure, and no " +
      'syntactic rule tells them apart. Hand-verified: negative control at ' +
      'test/lib/constraint-satisfiability.test.ts (`expect(r.satisfiable).toBe(false)`), plus ' +
      'positive and unknown cases.',
  },
  'lib/eval-verdict-bands.ts::auditBands': {
    reason: ['bespoke-verdict'],
    note:
      'Returns `BandAudit { uncovered, misordered, overlapping }` — three findings arrays under ' +
      'names the rail does not recognise, and `overlapping` is explicitly benign, so non-empty ' +
      'is not uniformly a failure. Hand-verified: negative control "the PRE-fix band set leaves ' +
      'reachable classes uncovered (proves the auditor works)".',
  },
  'lib/golden-staleness.ts::checkGoldenFreshness': {
    reason: ['bespoke-verdict'],
    note:
      'Returns `FreshnessReport { fresh: boolean, stale[], notPassing[], unknown[] }`. The ' +
      'INVERTED-polarity case the two-tier split exists for: `stale: [...]` non-empty is a ' +
      'failure while `fresh: true` is a pass, and a detector that guessed would read its own ' +
      'passing case as a negative control. Hand-verified: three `expect(r.fresh).toBe(false)` ' +
      'controls. Pay down by renaming `fresh` -> `ok`.',
  },
};

/**
 * ── Fixture grounding ─────────────────────────────────────────────────────
 *
 * A check surface whose controls are ALL inline literals typed beside the
 * assertion. The negative control fires, the positive control passes, and the
 * pair proves only that the code does what the code does — because the
 * implementation and its inputs came out of one act of authorship and agree
 * by construction. CI cannot tell that apart from a real test; both are green.
 *
 * The two clauses above ask *can this check fail* and *can it pass*. Neither
 * asks whether the check's SPECIFICATION is right, and a control authored in
 * the same pass agrees with a wrong specification as readily as a right one.
 * `predictive-guard-citation` polices claims about ANOTHER system, so it does
 * not reach this either.
 *
 * Five gates in `poverty-graduation/20260915-1518` were green over broken
 * behaviour for exactly this reason — ace#2422 (a test helper supplied the
 * required contact field on every synthetic row, so "absent" was never an
 * input, and the bot shipped the wrong address past three green obligations),
 * ace#2396 (`selectOpenRows` ranked by a `blocking:` field that 0 of 15 real
 * rows carry; every fixture supplied it), ace#2398 (a table row neither
 * export produces — the ace#1946 check shipped INERT a SECOND time), ace#2429
 * and ace#2426. The mechanism and its limits are in
 * `lib/negative-control-coverage.ts § Fixture grounding`; the short version is
 * that a fixture on disk is not automatically real, but it is reviewable,
 * reusable and diffable, and the cheapest way to satisfy this rail is to go
 * and capture the actual artifact.
 *
 * Measured 2026-09-17: 140 uniform-verdict surfaces, 23 grounded, **117 not**.
 * Failing 117 at once produces a test nobody can land, which is how guards get
 * disabled — so the known set is pinned and only NEW surfaces are blocked.
 * Shrinking this list is always allowed and never needs the file rewritten.
 *
 * Entries leave by gaining one control fed from a captured artifact, or by
 * the check being deleted. Do not add to it.
 */
const GROUNDING_BASELINE: ReadonlySet<string> = new Set([
  'lib/answer-key-pattern.ts::checkAnswerKeyPattern',
  'lib/assessment-retry-leak.ts::checkAssessmentRetryLeak',
  'lib/build-phase-decisions.ts::checkBuildPhaseDecisions',
  'lib/ccz-language-tables.ts::auditCczLanguageTables',
  'lib/ccz-min-version.ts::checkCczMinVersion',
  'lib/choice-label-integrity.ts::checkCaseListEnumDrift',
  'lib/choice-label-integrity.ts::checkMarkdownEatenLabels',
  'lib/consent-branch.ts::checkConsentBranchCompleteness',
  'lib/constraint-locality.ts::checkRelevanceReachability',
  'lib/dashboard-bindings.ts::checkDashboardBindings',
  'lib/dashboard-column-invariants.ts::checkColumnInvariants',
  'lib/date-default-validate.ts::checkDateDefaultValidate',
  'lib/ddd-scene-actions.ts::checkDetectionCohortFloor',
  'lib/ddd-scene-actions.ts::checkEscapedPayoffIsHonoured',
  'lib/decision-vocabularies.ts::checkVocabulary',
  'lib/decisions-archetype-consistency.ts::checkArchetypeConsistency',
  'lib/deck-module-labels.ts::checkDeckModuleLabels',
  'lib/demo-arc-ladder.ts::checkArcLadder',
  'lib/demo-scene-variety.ts::checkSceneVariety',
  'lib/derived-chain-guard.ts::checkDerivedChainGuards',
  'lib/entity-id-grain.ts::checkEntityIdGrain',
  'lib/gap-copy-check.ts::checkGapCopy',
  'lib/generator-determinism.ts::checkGeneratorDeterminism',
  'lib/labs-run-state-reset.ts::checkRenderResetRegistered',
  'lib/pass-label-scope.ts::checkPassLabelScope',
  'lib/pipeline-field-extraction.ts::checkPipelineFieldsExtract',
  'lib/program-locale.ts::checkProgramLocale',
  'lib/program-reconcile.ts::checkNameArchetype',
  'lib/recipe-state-contract.ts::checkChainContinuity',
  'lib/run-surface-audit.ts::auditArchetypeContradiction',
  'lib/run-surface-audit.ts::auditAssistantAccess',
  'lib/run-surface-audit.ts::auditBuildMemo',
  'lib/run-surface-audit.ts::auditBuildMemoParity',
  'lib/run-surface-audit.ts::auditBuildStatusParity',
  'lib/run-surface-audit.ts::auditCompleteness',
  'lib/run-surface-audit.ts::auditConfidentiality',
  'lib/run-surface-audit.ts::auditContract',
  'lib/run-surface-audit.ts::auditDecisionRows',
  'lib/run-surface-audit.ts::auditDeepQaParity',
  'lib/run-surface-audit.ts::auditDocFidelity',
  'lib/run-surface-audit.ts::auditGuideScreenshots',
  'lib/run-surface-audit.ts::auditLinks',
  'lib/run-surface-audit.ts::auditRender',
  'lib/run-surface-audit.ts::auditReviewerMembership',
  'lib/run-surface-audit.ts::auditSyntheticLabelling',
  'lib/run-surface-audit.ts::auditUnresolvedMemberGates',
  'lib/run-surface-audit.ts::auditWalkthroughParity',
  'lib/scoring-arithmetic.ts::checkScoringArithmetic',
  'lib/screen-shape.ts::checkScreenShape',
  'lib/standing-fabrication-domains.ts::auditComposedPrompt',
  'lib/starter-module.ts::auditReleasedModules',
  'lib/support-channel-guard.ts::checkWorkerFacingSupportChannel',
  'lib/tailwind-utility-resolution.ts::classifyUtilities',
  'lib/taught-vs-collectable.ts::checkTaughtStepsCollectable',
  'lib/time-estimate-check.ts::checkLearnModuleTimeEstimates',
  'lib/transition-criteria.ts::checkTransitionCriteria',
  'lib/verdict-manifest-agreement.ts::checkVerdictManifestAgreement',
  'lib/version-uniqueness.ts::checkVersionAdvances',
  'lib/version-uniqueness.ts::checkVersionUnclaimed',
  'skills/demo-data-setup-qa/checks.ts::checkCrossDashboardConsistency',
  'skills/demo-data-setup-qa/checks.ts::checkDatasetObeysPddConstraints',
  'skills/demo-data-setup-qa/checks.ts::checkInteractiveRunsLive',
  'skills/demo-data-setup-qa/checks.ts::checkParUrlPayloadPopulated',
  'skills/demo-data-setup-qa/checks.ts::checkParUrlScope',
  'skills/idea-to-pdd-qa/checks.ts::checkArchetypeDeclared',
  'skills/idea-to-pdd-qa/checks.ts::checkEntityStateTaxonomyForLongitudinal',
  'skills/idea-to-pdd-qa/checks.ts::checkEvidenceModelLayered',
  'skills/idea-to-pdd-qa/checks.ts::checkLaunchParametersPresent',
  'skills/idea-to-pdd-qa/checks.ts::checkPddIsNativeGoogleDoc',
  'skills/idea-to-pdd-qa/checks.ts::checkProgramParametersCoherent',
  'skills/idea-to-pdd-qa/checks.ts::checkReviewerCommentTableIfReferenced',
  'skills/idea-to-pdd-qa/checks.ts::checkStressTestAppendixPresent',
  'skills/idea-to-pdd-qa/checks.ts::checkSuccessMetricsTablePopulated',
  'skills/pdd-to-test-prompts-qa/checks.ts::checkAdversarialCoverage',
  'skills/pdd-to-test-prompts-qa/checks.ts::checkAdversarialShareMinimum',
  'skills/pdd-to-test-prompts-qa/checks.ts::checkEachPromptHasRequiredFields',
  'skills/pdd-to-test-prompts-qa/checks.ts::checkEscalationPromptPresent',
  'skills/pdd-to-test-prompts-qa/checks.ts::checkHeaderWithTotalCount',
  'skills/pdd-to-test-prompts-qa/checks.ts::checkProductFeedbackPromptPresent',
  'skills/pdd-to-test-prompts-qa/checks.ts::checkPromptCountInRange',
  'skills/pdd-to-test-prompts-qa/checks.ts::checkTrainingGapPromptPresent',
  'skills/pdd-to-work-order-qa/checks.ts::checkAcceptanceDefined',
  'skills/pdd-to-work-order-qa/checks.ts::checkAdvanceContingentWhenCapUnresolved',
  'skills/pdd-to-work-order-qa/checks.ts::checkDeclaredCapReachesContract',
  'skills/pdd-to-work-order-qa/checks.ts::checkPaymentModelsReconciled',
  'skills/pdd-to-work-order-qa/checks.ts::checkRenderedFromTemplate',
  'skills/solicitation-review-qa/checks.ts::checkAllResponsesScored',
  'skills/solicitation-review-qa/checks.ts::checkAwardeeNamed',
  'skills/solicitation-review-qa/checks.ts::checkAwardeeReasoningSubstantive',
  'skills/solicitation-review-qa/checks.ts::checkCriteriaCoverageTablePopulated',
  'skills/solicitation-review-qa/checks.ts::checkNoAwardActionYet',
  'skills/solicitation-review-qa/checks.ts::checkRecommendationSectionPresent',
  'skills/solicitation-review-qa/checks.ts::checkScoringTableWellFormed',
  'skills/solicitation-review-qa/checks.ts::checkTieBreakResolved',
  'skills/synthetic-narrative-plan-qa/checks.ts::checkAnomaliesTraceable',
  'skills/synthetic-narrative-plan-qa/checks.ts::checkBeneficiaryCohortsWellFormed',
  'skills/synthetic-narrative-plan-qa/checks.ts::checkCoachingArcsMatchPersonas',
  'skills/synthetic-narrative-plan-qa/checks.ts::checkFlwPersonasWellFormed',
  'skills/synthetic-narrative-plan-qa/checks.ts::checkKpiFieldPathsResolvable',
  'skills/synthetic-narrative-plan-qa/checks.ts::checkManifestYamlParses',
  'skills/synthetic-narrative-plan-qa/checks.ts::checkRandomSeedPresent',
  'skills/synthetic-narrative-plan-qa/checks.ts::checkRequiredKeysPresent',
  'skills/synthetic-narrative-plan-qa/checks.ts::checkTimelineDatesConsistent',
  'skills/synthetic-walkthrough-spec-qa/checks.ts::checkAiQualityAssertionsFalsifiable',
  'skills/synthetic-walkthrough-spec-qa/checks.ts::checkPersonaPainPointsDocumented',
  'skills/synthetic-walkthrough-spec-qa/checks.ts::checkRequiredTopLevelKeys',
  'skills/synthetic-walkthrough-spec-qa/checks.ts::checkScenePersonasResolvable',
  'skills/synthetic-walkthrough-spec-qa/checks.ts::checkSceneTitlesUnique',
  'skills/synthetic-walkthrough-spec-qa/checks.ts::checkScenesArrayWellFormed',
  'skills/synthetic-walkthrough-spec-qa/checks.ts::checkSpecYamlParses',
  'skills/verdict-yaml-qa/checks.ts::checkDimensionWeightsSumToOne',
  'skills/verdict-yaml-qa/checks.ts::checkGateDispositionConsistent',
  'skills/verdict-yaml-qa/checks.ts::checkLiveStateVerifiedConsistency',
  'skills/verdict-yaml-qa/checks.ts::checkOverallScoreConsistentWithDimensions',
  'skills/verdict-yaml-qa/checks.ts::checkSchemaValidates',
  'skills/verdict-yaml-qa/checks.ts::checkVerdictTierMatchesScore',
  'skills/verdict-yaml-qa/checks.ts::checkYamlParses',
]);

/**
 * Recorded so a future reader can tell erosion from the starting point.
 *
 * Measured 2026-08-27 at ACE 0.13.10xx, by this file's own scanner over 5,024
 * `it` blocks in 362 test files.
 *
 * The brief that commissioned this rail estimated coverage from a filename
 * glob over `test/skills/` and concluded that of nine `checks.ts` modules only
 * `idea-to-pdd-qa` had any test. That was wrong at both levels: all nine have
 * a `checks.test.ts`, and all 62 check functions they export already had a
 * negative control. A ratchet set from a wrong baseline is set at the wrong
 * notch, which is why this string exists and why the assertion below only
 * checks that SOMEONE measured.
 */
const BASELINE_NOTE = [
  '2026-08-27: 100 check surfaces enumerated (62 in skills/<name>/checks.ts, 38 in lib/).',
  '  Tier 1 (uniform verdict): 96 — ALL have both a negative and a positive control',
  '  after this change seeded 3 (auditDecisionRows had no test of any kind;',
  '  auditLinks and checkDateDefaultValidate had no non-vacuous positive control).',
  '  Before seeding: 94/96 negative, 92/96 positive.',
  '  Tier 2 (bespoke verdict): 4 — pinned in LEDGER, each hand-verified as covered.',
].join('\n');

// ── Enumeration ────────────────────────────────────────────────────────────

function walk(dir: string, match: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match(full)) out.push(full);
  }
  return out;
}

/**
 * The enumerated surface: every `check*` / `audit*` exported from a
 * `skills/<name>/checks.ts` or from `lib/`, plus `EXTRA_SURFACES`.
 *
 * Enumerated from the repo rather than from a hand-maintained registry, which
 * is the failure mode one level up: a list goes stale silently and the ratchet
 * then guards a subset nobody notices shrinking.
 *
 * OUT OF SCOPE, deliberately: `-eval` skills. They are LLM-as-judge rubrics in
 * markdown with no deterministic input→verdict function to feed a bad input
 * to; forcing them into this harness would produce a test of the prompt's
 * wording. The boundary is stated in `skills/README.md § Negative controls`.
 */
function collectSurfaces(): CheckSurface[] {
  const surfaces: CheckSurface[] = [];
  const extraByFile = new Map<string, string[]>();
  for (const e of EXTRA_SURFACES) {
    extraByFile.set(e.file, [...(extraByFile.get(e.file) ?? []), e.fn]);
  }
  const files = [
    ...walk(join(repoRoot, 'skills'), (p) => p.endsWith('/checks.ts')),
    ...walk(join(repoRoot, 'lib'), (p) => p.endsWith('.ts') && !p.endsWith('.test.ts')),
  ];
  for (const f of files) {
    const rel = f.slice(repoRoot.length);
    surfaces.push(...surfacesIn(rel, readFileSync(f, 'utf8'), extraByFile.get(rel) ?? []));
  }
  return surfaces;
}

/**
 * Every `.test.ts` in the repo — `test/` AND `lib/`, because a dozen lib
 * modules keep their suite beside the source (`lib/constraint-locality.test.ts`).
 * Walking only `test/` called all of those checks untested.
 */
function collectTestCorpus(): { blocks: TestBlock[]; sources: Map<string, string> } {
  const sources = new Map<string, string>();
  const blocks: TestBlock[] = [];
  const testFiles = [
    ...walk(join(repoRoot, 'test'), (p) => p.endsWith('.test.ts')),
    ...walk(join(repoRoot, 'lib'), (p) => p.endsWith('.test.ts')),
  ];
  for (const f of testFiles) {
    const rel = f.slice(repoRoot.length);
    const src = readFileSync(f, 'utf8');
    sources.set(rel, src);
    blocks.push(...extractTestBlocks(rel, src));
  }
  return { blocks, sources };
}

/**
 * Where the surface is referenced outside its own module — the reachability
 * dimension.
 *
 * A check nothing invokes is a different defect from a check that cannot
 * fail, and the report says which, because the fixes differ: one needs a bad
 * input, the other needs a caller.
 *
 * **This measures REFERENCE, not proven invocation, and the gap is real.**
 * Most ACE checks are invoked by an agent following a `SKILL.md` step rather
 * than by a TypeScript call — `auditDataset` has zero `.ts` callers and is run
 * on every Phase 7 dataset — so markdown has to count, or the dimension reads
 * every skill-invoked gate as dead. The cost of counting it is the opposite
 * error: a doc line that merely SAYS `Enforced by: checkX` reads as a call
 * site while nothing executes. `lib/choice-label-integrity.ts` is exactly
 * that case today (ace#1688/#1689 — referenced here, not touched; another
 * agent owns the wiring). So an empty result is strong evidence of a dead
 * check; a non-empty one is weak evidence of a live one, and the ledger note
 * says which was actually verified.
 */
const REFERENCE_SOURCES: [string, string][] = ['lib', 'skills', 'mcp', 'scripts', 'agents', 'playbook', 'commands']
  .flatMap((dir) => {
    try {
      return walk(
        join(repoRoot, dir),
        (p) => (p.endsWith('.ts') && !p.endsWith('.test.ts')) || p.endsWith('.md'),
      );
    } catch {
      return [];
    }
  })
  .map((f) => [f.slice(repoRoot.length), readFileSync(f, 'utf8')]);

function referenceSites(surface: CheckSurface): string[] {
  const ref = new RegExp(`\\b${surface.fn}\\b`, 'g');
  const sites: string[] = [];
  for (const [rel, src] of REFERENCE_SOURCES) {
    const hits = (src.match(ref) ?? []).length;
    // Its own module counts only for references BEYOND the declaration — an
    // internal caller is a real call site (`auditRunSurface` fans out to
    // `auditDecisionRows`), and reporting that check as gating nothing would
    // be a false claim of exactly the kind this rail exists to stop.
    const floor = rel === surface.file ? 1 : 0;
    if (hits > floor) sites.push(rel);
  }
  return sites;
}

const surfaces = collectSurfaces();
const { blocks, sources } = collectTestCorpus();
const rows = classifyCoverage(surfaces, blocks, sources);
const uniform = rows.filter((r) => r.surface.shape !== 'bespoke');
const bespoke = rows.filter((r) => r.surface.shape === 'bespoke');

function describeGap(row: (typeof rows)[number]): string {
  const sites = referenceSites(row.surface);
  const shape =
    row.exercised.length === 0
      ? 'no test exercises it at all'
      : `${row.exercised.length} test(s) exercise it, none assert a FAILURE`;
  const reach = sites.length === 0 ? ' — and nothing outside its own module even mentions it (no-call-site)' : '';
  return `${surfaceKey(row.surface)} [${row.surface.shape}] — ${shape}${reach}`;
}

describe('every structural check has a negative control', () => {
  it('no check surface is added without a test that makes it FAIL', () => {
    const offenders = uniform
      .filter((r) => r.negative.length === 0)
      .filter((r) => !LEDGER[surfaceKey(r.surface)]?.reason.includes('no-negative-control'))
      .map(describeGap);

    expect(
      offenders.join('\n  '),
      'A check was added or changed with no test proving it can report failure.\n\n' +
        'Feed it the input it exists to reject and assert it says so. Derive that input from ' +
        'the DEFECT the check is for, or from the contract it claims to enforce — never by ' +
        'reading the implementation back, which only proves the code does what the code does.\n\n' +
        "ACE shipped four of these in one run (ace#1693/#1695/#1701/#1679); Phase 7's data " +
        'gate had never once run to a genuine pass. See skills/README.md § Negative controls.\n',
    ).toBe('');
  });

  it('every check also has a POSITIVE control, so it cannot be always-failing', () => {
    // A negative control alone is satisfied by `return { pass: false }`. That
    // is the always-fires class (ace#1026) — and ace#1693 was exactly it in
    // the field, costing Phase 7 its entire data gate for weeks.
    const offenders = uniform
      .filter((r) => r.positive.length === 0)
      .filter((r) => !LEDGER[surfaceKey(r.surface)]?.reason.includes('no-positive-control'))
      .map((r) => `${surfaceKey(r.surface)} — ${r.exercised.length} test(s), none assert a CLEAN input passes`);

    expect(
      offenders.join('\n  '),
      'A check has no positive control. Cover a legitimately-clean input too — especially ' +
        'where the check is a subset or threshold relation, where the over-tight version ' +
        'produces false positives that get "fixed" by loosening until the check is vacuous ' +
        'again.\n',
    ).toBe('');
  });

  it('no NEW check is proved only by inline literals it was authored beside', () => {
    // Fixture grounding. A control the author typed next to the assertion
    // shares every assumption the implementation makes, so the pair agrees by
    // construction and reports green either way. At least ONE control per
    // check must reach it from a captured artifact — a file under
    // `test/fixtures/`, or any other path read off disk, including the repo's
    // own `skills/*.md`.
    //
    // The 117 surfaces that fail this today are pinned; only NEW ones fail.
    const offenders = uniform
      .filter((r) => r.negative.length + r.positive.length > 0)
      .filter((r) => r.grounded.length === 0)
      .filter((r) => !GROUNDING_BASELINE.has(surfaceKey(r.surface)))
      .map(
        (r) =>
          `${surfaceKey(r.surface)} — ${r.negative.length + r.positive.length} control(s), ` +
          'every input an inline literal',
      );

    expect(
      offenders.join('\n  '),
      'A check is proved only against inputs written in the same pass as the check.\n\n' +
        'Capture the artifact it actually runs on — the real export, the real row, the real ' +
        'YAML — commit it under test/fixtures/ (or the suite-local fixtures/ dir) with a line ' +
        'saying where it came from, and feed the check THAT. A literal you type beside the ' +
        'assertion inherits the same misreading the implementation has, in both directions.\n\n' +
        'Five gates shipped green over broken behaviour in one run this way: ace#2422 ' +
        '(required field supplied by the helper on every synthetic row), ace#2396 (ranked by a ' +
        'field 0 of 15 real rows carry), ace#2398, ace#2429, ace#2426.\n\n' +
        'If a captured artifact genuinely does not exist for this input — a check over a shape ' +
        'no system has emitted yet — add the key to GROUNDING_BASELINE and say so there.\n',
    ).toBe('');
  });

  it('the grounding baseline is a debt to pay down, not a floor to fill', () => {
    // Same one-directional contract as LEDGER: a surface that gained a
    // captured control must leave the list, so the ratchet cannot silently
    // re-open and the debt cannot be traded between checks.
    const byKey = new Map(rows.map((r) => [surfaceKey(r.surface), r]));
    const stale: string[] = [];
    for (const key of GROUNDING_BASELINE) {
      const row = byKey.get(key);
      if (!row) {
        stale.push(`${key}: no longer exists — delete it from GROUNDING_BASELINE`);
      } else if (row.grounded.length > 0) {
        stale.push(
          `${key}: now has ${row.grounded.length} control(s) fed from a captured artifact — ` +
            'drop it from GROUNDING_BASELINE to lock the gain in',
        );
      }
    }
    expect(stale.join('\n'), 'These improved — update GROUNDING_BASELINE.').toBe('');
  });

  it('no NEW check invents its own verdict vocabulary (tier 2)', () => {
    // Whether a test asserts failure is only decidable if the verdict field
    // and its polarity are known. `{ stale: true }` is a FAILURE and
    // `{ satisfiable: true }` is a pass; no syntactic rule recovers that. So
    // bespoke-verdict checks are pinned rather than judged, and a new check
    // is asked to return QACheckResult / CheckOutcome / a findings report —
    // which is independently what makes its failure state legible to a caller
    // (lib/check-outcome.ts makes that argument at length).
    const offenders = bespoke
      .filter((r) => !LEDGER[surfaceKey(r.surface)]?.reason.includes('bespoke-verdict'))
      .map((r) => `${surfaceKey(r.surface)} — returns ${r.surface.returnType || '(unannotated)'}`);

    expect(
      offenders.join('\n  '),
      'A check returns a verdict shape this rail cannot read. Return `QACheckResult` ' +
        '(skills QA), `CheckOutcome<F>` (lib/check-outcome.ts), or a report interface with a ' +
        '`violations` / `findings` array — or add it to LEDGER with reason `bespoke-verdict` ' +
        'and say why a uniform shape does not fit.\n',
    ).toBe('');
  });

  it('the ledger is a debt to pay down, not a floor to fill', () => {
    // A surface that improved must leave the ledger, so the ratchet cannot
    // silently re-open. This is what makes the debt actually shrink instead
    // of being traded between checks.
    const byKey = new Map(rows.map((r) => [surfaceKey(r.surface), r]));
    const stale: string[] = [];
    for (const [key, entry] of Object.entries(LEDGER)) {
      const row = byKey.get(key);
      if (!row) {
        stale.push(`${key}: no longer exists — delete its LEDGER entry`);
        continue;
      }
      const fixed: LedgerReason[] = [];
      if (entry.reason.includes('no-negative-control') && row.negative.length > 0) fixed.push('no-negative-control');
      if (entry.reason.includes('no-positive-control') && row.positive.length > 0) fixed.push('no-positive-control');
      if (entry.reason.includes('bespoke-verdict') && row.surface.shape !== 'bespoke') fixed.push('bespoke-verdict');
      if (entry.reason.includes('no-call-site') && referenceSites(row.surface).length > 0) fixed.push('no-call-site');
      if (fixed.length > 0) stale.push(`${key}: resolved ${fixed.join(', ')} — drop from its LEDGER reason list`);
    }
    expect(stale.join('\n'), 'These improved — update LEDGER to lock the gain in.').toBe('');
  });

  it('records the baseline, so erosion is distinguishable from the starting point', () => {
    // Not an assertion about quality — an assertion that the number was
    // measured and written down. The brief that commissioned this rail
    // carried a coverage estimate from a filename glob that was wrong by an
    // order of magnitude, and a wrong baseline is how a ratchet gets set at
    // the wrong notch.
    expect(BASELINE_NOTE).not.toBe('');
  });
});

describe('the detector actually fires (negative controls for the ratchet itself)', () => {
  // Without these, a signal regex that matched nothing would pass every
  // assertion above and report a perfectly healthy repo. That is the exact
  // failure class this file exists to stop, so it must not be the file's own.

  it('reads a real negative control as negative and a real positive one as positive', () => {
    const neg = negativeSignal('pass')!;
    const pos = positiveSignal('pass')!;
    const negative = `{ const r = checkThing(BAD); expect(r.pass).toBe(false); }`;
    const positive = `{ const r = checkThing(CLEAN); expect(r.pass).toBe(true); }`;
    expect(neg.test(negative)).toBe(true);
    expect(pos.test(negative)).toBe(false);
    expect(pos.test(positive)).toBe(true);
    expect(neg.test(positive)).toBe(false);
  });

  it('does not read a merely-running test as a control', () => {
    // The distinction the whole convention rests on: exercising a check is
    // not the same as proving it can fail.
    const body = `{ const r = checkThing(input); expect(r.detail).toBeTruthy(); }`;
    expect(negativeSignal('pass')!.test(body)).toBe(false);
    expect(positiveSignal('pass')!.test(body)).toBe(false);
  });

  it('reads the findings-collection forms this repo actually writes', () => {
    // Verbatim shapes from test/lib/dataset-constraints.test.ts and
    // test/lib/dashboard-bindings.test.ts. If the detector missed these it
    // would manufacture a ledger of phantom debt, which is how a ratchet gets
    // deleted rather than paid down.
    const neg = negativeSignal('findings')!;
    const pos = positiveSignal('findings')!;
    expect(neg.test(`{ expect(r.violations.map((v) => v.kind)).toContain('cross-field'); }`)).toBe(true);
    expect(neg.test(`{ expect(report.findings).toHaveLength(3); }`)).toBe(true);
    expect(pos.test(`{ expect(report.findings).toHaveLength(0); }`)).toBe(true);
    // …and the collection assertion is anchored on the collection, so an
    // unrelated toContain cannot mark a block covered.
    expect(neg.test(`{ expect(r.detail).toContain('meeting_photo'); }`)).toBe(false);
  });

  it('refuses to judge a bespoke verdict rather than guessing at its polarity', () => {
    // `{ stale: true }` is a FAILURE and `{ satisfiable: true }` is a pass.
    // A detector that guessed would report `checkGoldenFreshness` covered by
    // its own passing case — laundered confidence, one level up.
    expect(negativeSignal('bespoke')).toBeNull();
    expect(positiveSignal('bespoke')).toBeNull();
  });

  it('sees a concise arrow body, a hoisted call, and a local helper', () => {
    // All three cost the first cut of this scanner a false "uncovered" on
    // checkPaymentUnitMatchesEntityGrain, which hoists `const r = check(...)`
    // to describe scope, opens with `it('fails', () => expect(r.pass).toBe(false))`,
    // and routes seven more controls through a local `check` helper.
    const src = [
      `describe('grain', () => {`,
      `  const r = checkThing(BAD);`,
      `  it('fails', () => expect(r.pass).toBe(false));`,
      `});`,
      `describe('helper', () => {`,
      `  const probe = (a: string) => checkThing(a);`,
      `  it('also fails', () => { expect(probe('bad').pass).toBe(false); });`,
      `});`,
      `describe('unrelated', () => {`,
      `  it('is not attributed', () => { expect(1).toBe(1); });`,
      `});`,
    ].join('\n');
    const found = extractTestBlocks('t.test.ts', src);
    expect(found.map((b) => b.title)).toEqual(['fails', 'also fails', 'is not attributed']);
    const cov = classifyCoverage(
      [{ file: 'x.ts', fn: 'checkThing', shape: 'pass', returnType: 'QACheckResult' }],
      found,
      new Map([['t.test.ts', src]]),
    );
    expect(cov[0].exercised.map((b) => b.title)).toEqual(['fails', 'also fails']);
    expect(cov[0].negative).toHaveLength(2);
  });

  it('does not let one sibling block cover every check in the file', () => {
    // The describe prologue is the shared setup and nothing else. Including
    // sibling `it` bodies would make a single control in a multi-check file
    // mark all of them covered — precisely the over-reporting that recreates
    // the failure class.
    const src = [
      `describe('two checks', () => {`,
      `  it('a fails', () => { expect(checkA(BAD).pass).toBe(false); });`,
      `  it('b runs', () => { expect(checkB(X).detail).toBeTruthy(); });`,
      `});`,
    ].join('\n');
    const found = extractTestBlocks('t.test.ts', src);
    const cov = classifyCoverage(
      [{ file: 'x.ts', fn: 'checkB', shape: 'pass', returnType: 'QACheckResult' }],
      found,
      new Map([['t.test.ts', src]]),
    );
    expect(cov[0].negative).toHaveLength(0);
  });

  it('is not fooled by a brace or paren inside a test title', () => {
    // ACE's titles routinely carry both — 'still demands a multi-gated field
    // when EVERY gate holds (#1693)'. Masking literals before bracket
    // matching is what makes the block boundaries exact.
    const src = `it('handles ) and } and (#1693)', () => { expect(checkThing(B).pass).toBe(false); });\nit('next', () => {});`;
    const found = extractTestBlocks('t.test.ts', src);
    expect(found.map((b) => b.title)).toEqual(['handles ) and } and (#1693)', 'next']);
    expect(negativeSignal('pass')!.test(found[0].body)).toBe(true);
  });

  it('enumerates surfaces from the repo rather than a list that can go stale', () => {
    const keys = rows.map((r) => surfaceKey(r.surface));
    expect(keys).toContain('lib/dataset-constraints.ts::auditDataset');
    expect(keys).toContain('skills/demo-data-setup-qa/checks.ts::checkParUrlScope');
    expect(rows.length).toBeGreaterThan(50);
  });

  it('measures reachability, so a check nothing calls is distinguishable', () => {
    // The second failure mode. auditDataset is wired into
    // skills/demo-data-setup-qa/checks.ts; a check with no production call
    // site returns an empty list, and the ledger can say so.
    const audit = rows.find((r) => surfaceKey(r.surface) === 'lib/dataset-constraints.ts::auditDataset')!;
    expect(referenceSites(audit.surface).length).toBeGreaterThan(0);
  });
});
