import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DELIVER_APP_BANDS,
  DELIVER_APP_BANDS_PRE_1568,
  LEARN_APP_BANDS,
  LEARN_APP_BANDS_PRE_1578,
  auditBands,
  classifyTerminalVerdict,
  exhaustiveVectors,
  partitionVectors,
  weightedOverall,
  severityRank,
} from '../../lib/eval-verdict-bands';

// Class-level preventer for ace#1568: an `-eval` rubric's terminal verdict
// bands must PARTITION the score space — every reachable vector of dimension
// scores maps to exactly one verdict. The bands are prose applied by an LLM
// judge at grade time, so a set that does not partition never throws; the
// judge silently legislates, and two runs with identical scores can disagree
// with nothing to say either is wrong.
//
// The arithmetic is checked here, not by hand, because it is exactly the kind
// of check that gets "confirmed" without being run. The pre-fix band set is
// kept as a live input so the enumerator is proven able to detect the defect
// it was written for — a totality test that can only pass is worthless.

const SKILLS_DIR = join(__dirname, '../../skills');
const DELIVER_RUBRIC = join(SKILLS_DIR, 'pdd-to-deliver-app-eval/SKILL.md');
const LEARN_RUBRIC = join(SKILLS_DIR, 'pdd-to-learn-app-eval/SKILL.md');

// `skills/pdd-to-deliver-app-eval/SKILL.md § 5` dimension weights.
const DELIVER_WEIGHTS = [0.07, 0.06, 0.14, 0.08, 0.1, 0.14, 0.13, 0.12, 0.08, 0.08];
// case_persistence and language_conformance both carry the N/A -> null rule.
const DELIVER_NULLABLE = [7, 9];

// `skills/pdd-to-learn-app-eval/SKILL.md § 5` dimension weights, in the order
// the rubric's verdict YAML declares them: module_count_match,
// module_order_match, assessment_score_wiring, content_topic_coverage,
// archetype_coherence | assessment_gating, instructional_depth,
// assessment_rule_coverage, language_conformance.
const LEARN_WEIGHTS = [0.07, 0.06, 0.12, 0.12, 0.08, 0.22, 0.17, 0.08, 0.08];
// assessment_rule_coverage (no scored assessment) and language_conformance
// (the PDD names no working language) both carry the N/A -> null rule.
const LEARN_NULLABLE = [7, 8];

describe('eval verdict bands — totality and ordering', () => {
  it('the deliver-app cascade covers a full exhaustive sweep of a 4-dimension rubric', () => {
    // 0..10 at 0.5 granularity, 4 dimensions, both blocker states: 194,481 x 2.
    const levels = Array.from({ length: 21 }, (_, i) => i * 0.5);
    const weights = [0.4, 0.3, 0.2, 0.1];
    const audit = auditBands(DELIVER_APP_BANDS, exhaustiveVectors(4, levels, weights));

    expect(audit.vectorsChecked).toBe(21 ** 4 * 2);
    expect(audit.uncovered).toEqual([]);
    expect(audit.misordered).toEqual([]);
  });

  it('the deliver-app cascade covers every equivalence class of the real 10-dimension rubric', () => {
    const audit = auditBands(
      DELIVER_APP_BANDS,
      partitionVectors(DELIVER_WEIGHTS, { nullable: DELIVER_NULLABLE }),
    );

    expect(audit.vectorsChecked).toBeGreaterThan(10_000);
    expect(audit.uncovered).toEqual([]);
    expect(audit.misordered).toEqual([]);
  });

  it('overlapping matches always resolve to the MORE severe verdict', () => {
    // A vector that is both `fail` (a dimension <= 3) and `warn` (a dimension
    // in 4-6) must land on `fail`. Under the pre-fix wording nothing said so.
    const scores = [2, 5, 5, 8, 8, 8, 8, 8, 8, 8];
    const ctx = { scores, overall: weightedOverall(scores, DELIVER_WEIGHTS), blocker: false };
    const matched = DELIVER_APP_BANDS.filter((r) => r.test(ctx)).map((r) => r.verdict);

    expect(matched).toEqual(['fail', 'warn']); // `pass` is a real predicate, not a catch-all
    expect(classifyTerminalVerdict(DELIVER_APP_BANDS, ctx)!.verdict).toBe('fail');
    expect(severityRank('fail')).toBeGreaterThan(severityRank('warn'));
  });

  it('a § 5b hard-gate BLOCKER forces `fail` on an otherwise perfect build', () => {
    const scores = new Array(10).fill(10);
    const ctx = { scores, overall: 10, blocker: true };
    expect(classifyTerminalVerdict(DELIVER_APP_BANDS, ctx)!.verdict).toBe('fail');
  });
});

describe('eval verdict bands — the ace#1568 regression witness', () => {
  it('the PRE-fix band set leaves reachable classes uncovered (proves the auditor works)', () => {
    const audit = auditBands(
      DELIVER_APP_BANDS_PRE_1568,
      partitionVectors(DELIVER_WEIGHTS, { nullable: DELIVER_NULLABLE }),
    );

    expect(audit.uncovered.length).toBeGreaterThan(0);

    // Class 1 — the reported case: exactly ONE dimension in 4-6, none <= 3.
    const oneMid = audit.uncovered.find(
      (g) =>
        g.scores.filter((s) => s >= 4 && s <= 6).length === 1 &&
        g.scores.every((s) => s > 3) &&
        g.overall >= 7.5,
    );
    expect(oneMid, 'exactly-one-dimension-in-4-6 should be uncovered pre-fix').toBeDefined();

    // Class 2 — NOT in the issue, found by enumeration: every dimension >= 7
    // but the weighted mean under 7.5 (reachable at all dimensions == 7.0).
    const lowOverall = audit.uncovered.find(
      (g) => g.scores.every((s) => s >= 7) && g.overall < 7.5,
    );
    expect(lowOverall, 'all-dims->=7-but-overall-<7.5 should be uncovered pre-fix').toBeDefined();
  });

  it('a 4-6 RANGE trigger would still leave the fractional band homeless', () => {
    // The repair sketched on the issue widened rule 2 to "any dimension in
    // 4-6". Dimension scores are fractional (every rubric anchor is stated at
    // the half-point), so that still strands 3 < s < 4 and 6 < s < 7. Shipped
    // rule 2 says "< 7" instead. This test is why.
    const rangeTrigger = [
      DELIVER_APP_BANDS_PRE_1568[0],
      {
        verdict: 'warn' as const,
        label: 'any scored dimension in 4-6, or overall < 7.5',
        test: ({ scores, overall }: { scores: number[]; overall: number }) =>
          scores.some((s) => s >= 4 && s <= 6) || overall < 7.5,
      },
      DELIVER_APP_BANDS[2],
    ];

    for (const stranded of [3.5, 6.5]) {
      const scores = DELIVER_WEIGHTS.map((_, i) => (i === 9 ? stranded : 9.5));
      const ctx = { scores, overall: weightedOverall(scores, DELIVER_WEIGHTS), blocker: false };
      expect(ctx.overall).toBeGreaterThan(7.5);
      expect(rangeTrigger.filter((r) => r.test(ctx)), `score ${stranded}`).toEqual([]);
      expect(classifyTerminalVerdict(DELIVER_APP_BANDS, ctx)!.verdict).toBe('warn');
    }
  });

  it('the live case (spark-facilitator/20260820-0817) matched no pre-fix rule and now resolves to `warn`', () => {
    // language_conformance 5.0 (index 9), every other dimension 8.6.
    const scores = DELIVER_WEIGHTS.map((_, i) => (i === 9 ? 5.0 : 8.6));
    const overall = weightedOverall(scores, DELIVER_WEIGHTS);
    const ctx = { scores, overall, blocker: false };

    expect(overall).toBeGreaterThan(7.5);
    expect(DELIVER_APP_BANDS_PRE_1568.filter((r) => r.test(ctx))).toEqual([]);
    expect(classifyTerminalVerdict(DELIVER_APP_BANDS, ctx)!.verdict).toBe('warn');
  });

  it('every outcome the pre-fix bands DID produce is preserved', () => {
    let compared = 0;
    for (const v of partitionVectors(DELIVER_WEIGHTS, { nullable: DELIVER_NULLABLE })) {
      const old = DELIVER_APP_BANDS_PRE_1568.filter((r) => r.test(v)).map((r) => r.verdict);
      if (old.length === 0) continue; // the gap — nothing to preserve
      // The pre-fix set had no stated precedence; the defensible reading is
      // the most severe rule that fired. The cascade must agree with it.
      const expected = old.reduce((a, b) => (severityRank(b) > severityRank(a) ? b : a));
      expect(classifyTerminalVerdict(DELIVER_APP_BANDS, v)!.verdict).toBe(expected);
      compared++;
    }
    expect(compared).toBeGreaterThan(10_000);
  });
});

describe('eval verdict bands — prose/code drift guard', () => {
  const rubric = readFileSync(DELIVER_RUBRIC, 'utf8');

  it('the SKILL.md cascade states the same three rules, in the same order', () => {
    const block = rubric.match(
      /\*\*Terminal verdict bands — an ORDERED cascade[\s\S]*?suite verdict\s+`pass`\./,
    );
    expect(block, 'SKILL.md must carry the ordered-cascade band block').not.toBeNull();
    const text = block![0];

    // Order: fail, then warn, then pass — first match wins.
    const order = [...text.matchAll(/suite verdict\s+`(fail|warn|pass)`/g)].map((m) => m[1]);
    expect(order).toEqual(['fail', 'warn', 'pass']);

    // Rule 1 triggers, rule 2 triggers (both halves), rule 3 catch-all.
    expect(text).toMatch(/Any scored dimension ≤3, \*\*or\*\* any § 5b hard-gate `\[BLOCKER\]`/);
    expect(text).toMatch(/Any scored dimension \*\*< 7\*\*, \*\*or\*\* overall < 7\.5/);
    expect(text).toMatch(/Otherwise — every scored dimension ≥ 7 \*\*and\*\* overall ≥ 7\.5/);
  });

  it('the leaky pre-fix wording is gone from the rubric', () => {
    // The exact string the gap was made of. It survives only inside the
    // changelog row and the "do not read it as" warning, both of which name
    // it as the OLD wording; neither may state it as a live band rule.
    const liveRule = /^\s*-\s*2\+ dimensions in 4–6 range → suite verdict `warn`\./m;
    expect(rubric).not.toMatch(liveRule);
  });
});

// ---------------------------------------------------------------------------
// ace#1578 — `pdd-to-learn-app-eval` stated ONLY the `fail` trigger: no `pass`
// band and no `warn` band at all, so the whole non-fail half of the score space
// was homeless. Same class as ace#1568 and strictly larger. The repair mirrors
// the sibling cascade exactly (operator decision, Jon), so the audit is the
// same exhaustive one, run over the LEARN rubric's own 9-dimension weight set.
// ---------------------------------------------------------------------------

describe('eval verdict bands — learn-app totality and ordering (ace#1578)', () => {
  it('reuses the shared cascade rather than hand-rolling a second copy', () => {
    expect(LEARN_APP_BANDS.map((r) => [r.verdict, r.label])).toEqual(
      DELIVER_APP_BANDS.map((r) => [r.verdict, r.label]),
    );
    // Mirrored, not aliased: each rubric owns its array so one may later diverge.
    expect(LEARN_APP_BANDS).not.toBe(DELIVER_APP_BANDS);
  });

  it('the learn-app cascade covers a full exhaustive sweep of a 4-dimension rubric', () => {
    const levels = Array.from({ length: 21 }, (_, i) => i * 0.5);
    const weights = [0.4, 0.3, 0.2, 0.1];
    const audit = auditBands(LEARN_APP_BANDS, exhaustiveVectors(4, levels, weights));

    expect(audit.vectorsChecked).toBe(21 ** 4 * 2);
    expect(audit.uncovered).toEqual([]);
    expect(audit.misordered).toEqual([]);
  });

  it('the learn-app cascade covers every equivalence class of the real 9-dimension rubric', () => {
    const audit = auditBands(
      LEARN_APP_BANDS,
      partitionVectors(LEARN_WEIGHTS, { nullable: LEARN_NULLABLE }),
    );

    expect(audit.vectorsChecked).toBeGreaterThan(10_000);
    expect(audit.uncovered).toEqual([]);
    expect(audit.misordered).toEqual([]);
  });

  it('the § 5 weights audited here are the ones the rubric declares', () => {
    // Guards the sweep against silently drifting off the real rubric.
    const rubric = readFileSync(LEARN_RUBRIC, 'utf8');
    const declared = [...rubric.matchAll(/^\s+\w+:\s+\{ weight: ([\d.]+) \}/gm)].map((m) =>
      Number(m[1]),
    );
    expect(declared).toEqual(LEARN_WEIGHTS);
    expect(declared.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('overlapping matches always resolve to the MORE severe verdict', () => {
    const scores = [2, 5, 5, 8, 8, 8, 8, 8, 8];
    const ctx = { scores, overall: weightedOverall(scores, LEARN_WEIGHTS), blocker: false };
    const matched = LEARN_APP_BANDS.filter((r) => r.test(ctx)).map((r) => r.verdict);

    expect(matched).toEqual(['fail', 'warn']);
    expect(classifyTerminalVerdict(LEARN_APP_BANDS, ctx)!.verdict).toBe('fail');
  });

  it('every existing learn hard-gate still forces `fail` under the cascade', () => {
    // § 5b `naming_convention` / `form_navigation` / `single_gating_assessment`
    // surface a [BLOCKER] on an otherwise perfect build.
    expect(
      classifyTerminalVerdict(LEARN_APP_BANDS, {
        scores: new Array(9).fill(10),
        overall: 10,
        blocker: true,
      })!.verdict,
    ).toBe('fail');

    // The dimension-level hard-gates each drive their own dimension to <= 3:
    // language_conformance (8), assessment_gating (5), instructional_depth (6).
    for (const dim of [8, 5, 6]) {
      const scores = LEARN_WEIGHTS.map((_, i) => (i === dim ? 3.0 : 9.5));
      const ctx = { scores, overall: weightedOverall(scores, LEARN_WEIGHTS), blocker: false };
      expect(ctx.overall).toBeGreaterThan(7.5);
      expect(classifyTerminalVerdict(LEARN_APP_BANDS, ctx)!.verdict, `dim ${dim}`).toBe('fail');
    }
  });

  it('the N/A redistribution does not open a hole (both nullable dims dropped)', () => {
    // language_conformance and assessment_rule_coverage both N/A: 7 scored dims,
    // each exactly 7.0 -> overall 7.0 < 7.5. That is the class ace#1568's
    // enumeration found and neither rubric's prose ever named.
    const liveWeights = LEARN_WEIGHTS.filter((_, i) => !LEARN_NULLABLE.includes(i));
    const scores = new Array(liveWeights.length).fill(7);
    const overall = weightedOverall(scores, liveWeights);
    expect(overall).toBeLessThan(7.5);
    expect(
      classifyTerminalVerdict(LEARN_APP_BANDS, { scores, overall, blocker: false })!.verdict,
    ).toBe('warn');
  });
});

describe('eval verdict bands — the ace#1578 regression witness', () => {
  it('the PRE-fix learn bands leave the ENTIRE non-fail half uncovered', () => {
    const audit = auditBands(
      LEARN_APP_BANDS_PRE_1578,
      partitionVectors(LEARN_WEIGHTS, { nullable: LEARN_NULLABLE }),
    );

    expect(audit.uncovered.length).toBeGreaterThan(0);

    // A flawless build had no band to land on — the defining symptom.
    const flawless = audit.uncovered.find(
      (g) => g.scores.every((s) => s >= 9) && g.overall >= 7.5 && !g.blocker,
    );
    expect(flawless, 'an all-high build should be uncovered pre-fix').toBeDefined();

    // So did a plainly-warning build: a dimension in 4-6, nothing failing.
    const oneMid = audit.uncovered.find(
      (g) => g.scores.some((s) => s >= 4 && s <= 6) && g.scores.every((s) => s > 3),
    );
    expect(oneMid, 'a dimension-in-4-6 build should be uncovered pre-fix').toBeDefined();

    // EVERY uncovered vector is non-failing: the gap is exactly the half of the
    // space the rubric never banded, not a hole inside the `fail` region.
    expect(audit.uncovered.every((g) => !g.blocker && g.scores.every((s) => s > 3))).toBe(true);
  });

  it('every outcome the pre-fix learn band DID produce is preserved', () => {
    let compared = 0;
    for (const v of partitionVectors(LEARN_WEIGHTS, { nullable: LEARN_NULLABLE })) {
      const old = LEARN_APP_BANDS_PRE_1578.filter((r) => r.test(v)).map((r) => r.verdict);
      if (old.length === 0) continue; // the gap — nothing to preserve
      const expected = old.reduce((a, b) => (severityRank(b) > severityRank(a) ? b : a));
      expect(classifyTerminalVerdict(LEARN_APP_BANDS, v)!.verdict).toBe(expected);
      compared++;
    }
    expect(compared).toBeGreaterThan(1_000);
  });

  it('a 4-6 RANGE trigger would still leave the fractional band homeless here too', () => {
    const rangeTrigger = [
      LEARN_APP_BANDS_PRE_1578[0],
      {
        verdict: 'warn' as const,
        label: 'any scored dimension in 4-6, or overall < 7.5',
        test: ({ scores, overall }: { scores: number[]; overall: number }) =>
          scores.some((s) => s >= 4 && s <= 6) || overall < 7.5,
      },
      LEARN_APP_BANDS[2],
    ];

    for (const stranded of [3.5, 6.5]) {
      const scores = LEARN_WEIGHTS.map((_, i) => (i === 8 ? stranded : 9.5));
      const ctx = { scores, overall: weightedOverall(scores, LEARN_WEIGHTS), blocker: false };
      expect(ctx.overall).toBeGreaterThan(7.5);
      expect(rangeTrigger.filter((r) => r.test(ctx)), `score ${stranded}`).toEqual([]);
      expect(classifyTerminalVerdict(LEARN_APP_BANDS, ctx)!.verdict).toBe('warn');
    }
  });
});

describe('eval verdict bands — learn prose/code drift guard', () => {
  const rubric = readFileSync(LEARN_RUBRIC, 'utf8');

  it('the SKILL.md cascade states the same three rules, in the same order', () => {
    const block = rubric.match(
      /\*\*Terminal verdict bands — an ORDERED cascade[\s\S]*?suite verdict\s+`pass`\./,
    );
    expect(block, 'SKILL.md must carry the ordered-cascade band block').not.toBeNull();
    const text = block![0];

    const order = [...text.matchAll(/suite verdict\s+`(fail|warn|pass)`/g)].map((m) => m[1]);
    expect(order).toEqual(['fail', 'warn', 'pass']);

    expect(text).toMatch(/Any scored dimension ≤3, \*\*or\*\* any § 5b hard-gate `\[BLOCKER\]`/);
    expect(text).toMatch(/Any scored dimension \*\*< 7\*\*, \*\*or\*\* overall < 7\.5/);
    expect(text).toMatch(/Otherwise — every scored dimension ≥ 7 \*\*and\*\* overall ≥ 7\.5/);
  });

  it('the learn-specific hard gates are still named as `fail` triggers', () => {
    const body = rubric.split(/\|\s*Date\s*\|\s*Change\s*\|/)[0];
    for (const gate of ['`naming_convention`', '`form_navigation`', '`single_gating_assessment`']) {
      expect(body, gate).toContain(gate);
    }
    // § 5b blockers still force `fail`.
    expect(body).toMatch(/`\[BLOCKER\]` →\s*\n?\s*`fail`/);
    // The language_conformance hard-fail anchors.
    expect(body).toMatch(/\*\*≤3 → suite `fail`\*\*/);
    // And the pre-existing deduction bullet is untouched.
    expect(body).toMatch(/Any single dimension ≤3 → suite verdict `fail`/);
  });
});

describe('eval verdict bands — the leaky shape must not spread', () => {
  // Ratchet, not a sweep: the band STRUCTURE is not shared across the `-eval`
  // family (the partnership-* rubrics band on overall score alone; the
  // connect-*/app-release/llo-uat rubrics carry exhaustive `Verdict tiers`
  // blocks), so there is nothing to generalize an enumeration over. What CAN
  // generalize is the ban on the shape that produced the gap: a `warn` band
  // gated on a COUNT of mid-range dimensions leaves the count-minus-one case
  // homeless unless something else catches it.
  const evalSkills = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith('-eval'))
    .map((d) => d.name);

  it('finds the -eval skills to check', () => {
    expect(evalSkills.length).toBeGreaterThan(10);
  });

  it.each(evalSkills)('%s does not gate `warn` on a count of mid-range dimensions', (skill) => {
    const src = readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
    // Strip the changelog: a historical row may quote the retired wording.
    const body = src.split(/\|\s*Date\s*\|\s*Change\s*\|/)[0];
    const offenders = body
      .split('\n')
      .filter((l) => /\d\+\s*(scored\s+)?dimensions?\s+in\s+4[–-]6/i.test(l))
      .filter((l) => /`warn`/.test(l))
      // The ace#1568 rubric names it only to forbid that reading.
      .filter((l) => !/do not|pre-ace#1568|its pre-/i.test(l));
    expect(offenders, `${skill}: ${offenders.join(' | ')}`).toEqual([]);
  });
});
