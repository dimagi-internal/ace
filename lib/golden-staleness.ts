/**
 * Has the golden `/ace:iterate` is seeding from decayed under a rubric that
 * changed after it was recorded?
 *
 * Why this exists (dimagi-internal/ace#1031): the golden-prefix rule validated
 * only that the seeded phases were RECORDED as good at the time the golden ran
 * — frozen `status`/`verdict` fields. Nothing re-checked the seeded artifacts
 * against the CURRENT rubrics. So when a rubric tightens after the golden was
 * minted, the loop's own judge (which requires `pdd-to-learn-app-eval == pass`)
 * fails DETERMINISTICALLY on every iteration, and `pass_rate` is pinned at 0
 * forever while measuring nothing about the phases actually being targeted.
 *
 * It is self-inflicted, and it is the cousin of the frozen-`plugin_version`
 * streak bug PR #956 removed, one layer up: the loop exists to keep running
 * while ACE improves, and **tightening an eval rubric IS an improvement**. So
 * the improvement loop silently bricks the measurement loop.
 *
 * Live: `/ace:iterate bednet-spot-check --golden 20260706-0649`. The golden
 * satisfies the documented rule — phases 1 and 2 both `done`/`pass`, its own
 * run_state recording `pdd-to-learn-app-eval` as pass/7.7 on 2026-07-06.
 * Re-running Phase 3 against the same seeded PDD weeks later: overall 6.76,
 * `fail`, `assessment_discrimination` 2.0 with the hard-gate fired.
 *
 * `--new-golden` already validates against today's rubrics (§ steps 2 and 2b).
 * The hole this closes is the INHERITED golden — `--golden <id>` and the
 * `golden_run_id` resume path — which still read only the frozen fields.
 *
 * ## Why a date comparison rather than re-running the evals
 *
 * Re-running every eval on every loop start is the expensive answer to a
 * cheap question. A rubric revision that postdates the verdict is a *proof
 * that the verdict is unproven*, which is all the loop needs to decide whether
 * to re-validate. It cannot produce a false PASS: an unknown timestamp and an
 * unknown rubric date are handled asymmetrically — an unknown verdict
 * timestamp is never fresh, because the whole failure mode is a stale
 * judgement reading as a current one.
 */

export interface GoldenVerdict {
  /** The `-eval` skill that produced it. */
  skill: string;
  /** ISO timestamp the verdict was written. Absent = cannot be judged. */
  recordedAt?: string;
  verdict: string;
}

export interface FreshnessInput {
  goldenRunId: string;
  verdicts: GoldenVerdict[];
  /** `-eval` skill → its newest change-log date, or null when unreadable. */
  rubricRevisions: Record<string, string | null>;
}

export interface StaleVerdict {
  skill: string;
  recordedAt: string;
  rubricRevisedAt: string;
}

export interface FreshnessReport {
  fresh: boolean;
  stale: StaleVerdict[];
  notPassing: GoldenVerdict[];
  unknown: GoldenVerdict[];
  detail: string;
}

const PASSING = new Set(['pass', 'proceed', 'proceed-with-warn']);

/**
 * The newest date in a skill's change-log table.
 *
 * Order-independent: change logs in this repo are not consistently
 * newest-first, and reading row 1 would silently pick an ancient date on half
 * of them.
 */
export function latestRubricRevision(skillMarkdown: string): string | null {
  const dates = [...skillMarkdown.matchAll(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|/gm)].map((m) => m[1]);
  if (!dates.length) return null;
  return dates.sort().at(-1)!;
}

export function checkGoldenFreshness(input: FreshnessInput): FreshnessReport {
  const stale: StaleVerdict[] = [];
  const notPassing: GoldenVerdict[] = [];
  const unknown: GoldenVerdict[] = [];

  for (const v of input.verdicts) {
    if (!PASSING.has(v.verdict)) {
      notPassing.push(v);
      continue;
    }
    const rubricRevisedAt = input.rubricRevisions[v.skill];
    // An unreadable rubric date is not evidence of decay — skip it rather than
    // manufacture a failure.
    if (!rubricRevisedAt) continue;
    if (!v.recordedAt) {
      unknown.push(v);
      continue;
    }
    // Compare on date only: verdicts carry a full ISO timestamp, change logs a
    // date. A verdict written the same day the rubric changed is treated as
    // current — same-day churn is the loop's normal state at ~9 bumps/day.
    if (v.recordedAt.slice(0, 10) < rubricRevisedAt) {
      stale.push({ skill: v.skill, recordedAt: v.recordedAt, rubricRevisedAt });
    }
  }

  const fresh = stale.length === 0 && notPassing.length === 0 && unknown.length === 0;
  if (fresh) {
    return {
      fresh,
      stale,
      notPassing,
      unknown,
      detail: input.verdicts.length
        ? `golden ${input.goldenRunId}: every seeded eval verdict postdates its rubric's latest revision`
        : `golden ${input.goldenRunId}: no eval verdicts recorded, so there is nothing to compare — this is a vacuous pass, not evidence`,
    };
  }

  const lines = [`golden ${input.goldenRunId} must not be seeded from as-is:`];
  for (const s of stale) {
    lines.push(
      `  ${s.skill} passed on ${s.recordedAt.slice(0, 10)} but its rubric was revised ${s.rubricRevisedAt} — ` +
        'the frozen verdict records a PAST judgement and the loop re-grades against the current one',
    );
  }
  for (const v of notPassing) lines.push(`  ${v.skill} recorded \`${v.verdict}\`, not a pass`);
  for (const v of unknown) lines.push(`  ${v.skill} has no recorded timestamp, so its freshness cannot be judged`);
  lines.push(
    'Re-validate the golden against TODAY\'s rubrics (§ --new-golden steps 2 + 2b) or mint a new one. ' +
      'Seeding anyway pins pass_rate at 0 for every iteration while measuring nothing about the targeted phases.',
  );
  return { fresh, stale, notPassing, unknown, detail: lines.join('\n') };
}
