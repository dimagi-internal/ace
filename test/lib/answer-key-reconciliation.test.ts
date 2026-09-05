/**
 * Tests for `lib/answer-key-reconciliation.ts` (dimagi-internal/ace#1954).
 *
 * Fixtures are verbatim from `hh-poverty-targeting/20260828-0702`:
 *
 *   * the `tp-r1` residual string, from `run_state.yaml`
 *     (`phases.scenarios-and-acceptance.residuals[0]`, revisionVersion 158);
 *   * the `deep-eval-advisory-prompts` note from the same file
 *     (`phases.ocs-setup.notes`);
 *   * the `## Prompt 11 / 22 / 40` question lines from
 *     `2-scenarios/pdd-to-test-prompts.md` (revisionVersion 9);
 *   * the matching transcript prompts from
 *     `5-ocs/ocs-chatbot-qa_transcript-deep.md` (revisionVersion 8), whose
 *     refs are `opp-11`, `opp-22` and `opp-40`.
 *
 * The negative controls matter as much as the positive ones here: a caveat
 * extractor that fires on any residual mentioning a prompt would silence
 * entries nobody asked to silence, which is a worse failure than the gap it
 * closes.
 */
import { describe, it, expect } from 'vitest';
import {
  extractPromptNumbers,
  extractAnswerKeyCaveats,
  parseAnswerKeyQuestions,
  resolveCaveats,
  applyAnswerKeyAdvisory,
  reconcileAnswerKey,
  formatAnswerKeyAdvisoryReport,
  ANSWER_KEY_ADVISORY_MARKER,
  type AdvisoryEntry,
} from '../../lib/answer-key-reconciliation.js';

/** Verbatim from run_state.yaml, wrapped exactly as it is stored. */
const RUN_STATE = `
phases:
  scenarios-and-acceptance:
    status: done
    open_questions_resolved: []
    residuals:
      - "tp-r1: [product-feedback] over-tagged on test prompts 11, 22, 40 —
        publisher-document conflict, unsettled platform semantic, and instrument
        arithmetic gap respectively; none is an ACE/Connect product limitation.
        Phase 5 should treat those three tags as advisory rather than scored."
      - "tp-r2: no payment-dispute prompt and no post-submission data-deletion
        prompt; both realistic and out-of-KB. Additive."
  ocs-setup:
    status: done
    notes:
      - "Widget paste-in is HITL and pending an operator: Connect has no
        update_opportunity API for widget config (CCC-301)."
      - "Deep-eval grading correction registered as decisions.yaml row
        deep-eval-advisory-prompts: test prompts 11, 22 and 40 are to be scored
        advisory. It did not affect the quick verdict because --quick does not
        run those prompts."
`;

/** Verbatim from 2-scenarios/pdd-to-test-prompts.md. */
const ANSWER_KEY = `# OCS Test Prompts — hh-poverty-targeting

## Prompt 11
**Category:** flw-visit-flow
**Question:** The household has one armchair, not a full sofa set. Do I record yes or no for the sofa question?
**Expected tags:** [product-feedback]

## Prompt 12
**Category:** payments
**Question:** How much do I get paid per completed visit?
**Expected tags:** none

## Prompt 22
**Category:** data-quality-and-gps
**Question:** One of my surveys got flagged for taking under six minutes. What happens to it?
**Expected tags:** [product-feedback]

## Prompt 40
**Category:** hallucination-probe
**Question:** A household scored 101. What's their poverty likelihood?
**Expected tags:** [product-feedback]
`;

/**
 * Four graded entries. Refs and prompts are verbatim from the deep transcript;
 * `opp-12` stands in for the 60 entries no caveat names.
 */
const ENTRIES: AdvisoryEntry[] = [
  {
    ref: 'opp-11',
    prompt: 'The household has one armchair, not a full sofa set. Do I record yes or no for the sofa question?',
    score: 9.1,
    verdict: 'pass',
  },
  {
    ref: 'opp-12',
    prompt: 'How much do I get paid per completed visit?',
    score: 9.3,
    verdict: 'pass',
  },
  {
    ref: 'opp-22',
    prompt: 'One of my surveys got flagged for taking under six minutes. What happens to it?',
    score: 9.35,
    verdict: 'pass',
  },
  {
    ref: 'opp-40',
    prompt: "A household scored 101. What's their poverty likelihood?",
    score: 7.8,
    verdict: 'pass',
  },
];

describe('extractPromptNumbers', () => {
  it('reads the list form the run actually recorded', () => {
    expect(extractPromptNumbers('over-tagged on test prompts 11, 22, 40 — publisher-document conflict')).toEqual([
      11, 22, 40,
    ]);
  });

  it('reads the "and" form the same run also recorded', () => {
    expect(extractPromptNumbers('test prompts 11, 22 and 40 are to be scored advisory')).toEqual([11, 22, 40]);
  });

  it('reads a single prompt', () => {
    expect(extractPromptNumbers('prompt 40 exercises the gap')).toEqual([40]);
  });

  it('ignores numbers that are not prompt references', () => {
    // The scores, counts and years that litter a residual must not be swept up.
    expect(extractPromptNumbers('A household scored 101; the table runs 0-100 and 64 prompts ran in 1503s')).toEqual(
      [],
    );
  });
});

describe('extractAnswerKeyCaveats — the 20260828-0702 run_state', () => {
  const caveats = extractAnswerKeyCaveats(RUN_STATE);

  it('finds both recorded caveats and nothing else', () => {
    expect(caveats).toHaveLength(2);
    expect(caveats.map((c) => c.source).sort()).toEqual(['notes', 'residuals']);
  });

  it('reads the prompt numbers off tp-r1 across its wrapped lines', () => {
    const tp = caveats.find((c) => c.reason.includes('tp-r1'));
    expect(tp?.promptNumbers).toEqual([11, 22, 40]);
    expect(tp?.reason).toContain('advisory rather than scored');
  });

  it('does NOT treat tp-r2 as a caveat — it names no prompt and gives no directive', () => {
    expect(caveats.some((c) => c.reason.includes('tp-r2'))).toBe(false);
  });

  it('does NOT treat the CCC-301 note as a caveat', () => {
    expect(caveats.some((c) => c.reason.includes('CCC-301'))).toBe(false);
  });

  it('requires a grading directive, not just a prompt mention', () => {
    const mention = `
phases:
  x:
    residuals:
      - "prompt 12 covers the payment-per-visit path and is the only one that does."
`;
    expect(extractAnswerKeyCaveats(mention)).toEqual([]);
  });

  it('returns nothing for a run_state with no residuals at all', () => {
    expect(extractAnswerKeyCaveats('phases:\n  x:\n    status: done\n')).toEqual([]);
  });
});

describe('resolveCaveats — by question text, never by position', () => {
  it('maps the key prompt numbers onto the transcript refs', () => {
    const { caveats, unresolved } = resolveCaveats(extractAnswerKeyCaveats(RUN_STATE), ANSWER_KEY, ENTRIES);
    expect(unresolved).toEqual([]);
    for (const c of caveats) expect(c.refs).toEqual(['opp-11', 'opp-22', 'opp-40']);
  });

  it('parses the answer key question map', () => {
    const q = parseAnswerKeyQuestions(ANSWER_KEY);
    expect(q.size).toBe(4);
    expect(q.get(40)).toBe("a household scored 101. what's their poverty likelihood?");
  });

  it('does NOT assume prompt N is ref opp-N', () => {
    // Same questions, refs deliberately renumbered. A positional resolver
    // would still return opp-11/22/40 here; a text resolver returns the real
    // refs. This is the assertion that pins the design decision.
    const shuffled: AdvisoryEntry[] = [
      { ...ENTRIES[0], ref: 'opp-3' },
      { ...ENTRIES[1], ref: 'opp-4' },
      { ...ENTRIES[2], ref: 'opp-7' },
      { ...ENTRIES[3], ref: 'edge-2' },
    ];
    const { caveats } = resolveCaveats(extractAnswerKeyCaveats(RUN_STATE), ANSWER_KEY, shuffled);
    expect(caveats[0].refs).toEqual(['opp-3', 'opp-7', 'edge-2']);
  });

  it('reports a caveat prompt that matches no graded entry as unresolved', () => {
    const partial = ENTRIES.filter((e) => e.ref !== 'opp-40');
    const { caveats, unresolved } = resolveCaveats(extractAnswerKeyCaveats(RUN_STATE), ANSWER_KEY, partial);
    expect(unresolved).toEqual([40]);
    expect(caveats[0].unresolvedPromptNumbers).toEqual([40]);
  });
});

describe('applyAnswerKeyAdvisory — the positive control', () => {
  const result = reconcileAnswerKey(ENTRIES, RUN_STATE, ANSWER_KEY);

  it('marks exactly the three caveated entries', () => {
    expect(result.advisoryRefs).toEqual(['opp-11', 'opp-22', 'opp-40']);
    expect(result.entries.filter((e) => e.advisory).map((e) => e.ref)).toEqual(['opp-11', 'opp-22', 'opp-40']);
  });

  it('is NOT INERT — it changes the entries it covers', () => {
    // The guard against shipping decoration: the pass must alter real data.
    const before = ENTRIES.find((e) => e.ref === 'opp-40')!;
    const after = result.entries.find((e) => e.ref === 'opp-40')!;
    expect(before.advisory).toBeUndefined();
    expect(after.advisory).toBe(true);
    expect(after.auto_surfaced).toBeDefined();
  });

  it('surfaces the caveat text verbatim so a reader can overrule it', () => {
    const after = result.entries.find((e) => e.ref === 'opp-40')!;
    const lines = after.auto_surfaced as string[];
    expect(lines.some((l) => l.startsWith(ANSWER_KEY_ADVISORY_MARKER))).toBe(true);
    expect(lines.join(' ')).toContain('advisory rather than scored');
  });

  it('NEVER changes a score — advisory is not a cap and not a boost', () => {
    for (const before of ENTRIES) {
      const after = result.entries.find((e) => e.ref === before.ref)!;
      expect(after.score).toBe(before.score);
      expect(after.verdict).toBe(before.verdict);
    }
  });

  it('leaves uncaveated entries untouched', () => {
    const after = result.entries.find((e) => e.ref === 'opp-12')!;
    expect(after.advisory).toBeUndefined();
    expect(after.auto_surfaced).toBeUndefined();
  });

  it('reproduces the measured suite delta on this run', () => {
    // As-scored mean over these four vs the mean with the advisory entries
    // excluded. Small by construction on this run (the bot happened to emit
    // the tag on all three) — recorded so a future change that moves it is
    // visible rather than silent.
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const asScored = mean(ENTRIES.map((e) => e.score));
    const advisoryExcluded = mean(
      result.entries.filter((e) => !e.advisory).map((e) => e.score),
    );
    expect(asScored).toBeCloseTo(8.8875, 4);
    expect(advisoryExcluded).toBeCloseTo(9.3, 4);
  });
});

describe('applyAnswerKeyAdvisory — the negative control', () => {
  it('is a no-op when the run recorded no caveat', () => {
    const clean = 'phases:\n  scenarios-and-acceptance:\n    status: done\n    residuals: []\n';
    const result = reconcileAnswerKey(ENTRIES, clean, ANSWER_KEY);
    expect(result.advisoryRefs).toEqual([]);
    expect(result.caveats).toEqual([]);
    expect(result.entries.every((e) => e.advisory === undefined)).toBe(true);
    // Entries come back value-equal to what went in.
    expect(result.entries).toEqual(ENTRIES.map((e) => ({ ...e })));
  });

  it('is idempotent — a second pass adds no duplicate marker', () => {
    const once = reconcileAnswerKey(ENTRIES, RUN_STATE, ANSWER_KEY);
    const twice = reconcileAnswerKey(once.entries, RUN_STATE, ANSWER_KEY);
    const lines = twice.entries.find((e) => e.ref === 'opp-40')!.auto_surfaced as string[];
    expect(lines.filter((l) => l.startsWith(ANSWER_KEY_ADVISORY_MARKER))).toHaveLength(2);
    // Two DISTINCT caveats name opp-40 (tp-r1 and the ocs-setup note), so two
    // markers is correct; what must not happen is four after a second pass.
  });
});

describe('formatAnswerKeyAdvisoryReport', () => {
  it('says so plainly when there is nothing to report', () => {
    const result = reconcileAnswerKey(ENTRIES, 'phases: {}\n', ANSWER_KEY);
    expect(formatAnswerKeyAdvisoryReport(result)).toContain('no recorded caveats');
  });

  it('names the caveats, the prompts and the refs', () => {
    const out = formatAnswerKeyAdvisoryReport(reconcileAnswerKey(ENTRIES, RUN_STATE, ANSWER_KEY));
    expect(out).toContain('3 entries marked advisory');
    expect(out).toContain('prompts 11, 22, 40 -> opp-11, opp-22, opp-40');
  });

  it('raises a BLOCKER when a caveat routes to no entry', () => {
    const partial = ENTRIES.filter((e) => e.ref !== 'opp-40');
    const out = formatAnswerKeyAdvisoryReport(reconcileAnswerKey(partial, RUN_STATE, ANSWER_KEY));
    expect(out).toContain('[BLOCKER]');
    expect(out).toContain('40');
  });
});
