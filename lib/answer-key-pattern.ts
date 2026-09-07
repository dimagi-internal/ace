//
// Can this assessment be passed by answering a PATTERN, without reading it?
//
// Measured on poverty-graduation/20260905-1345: a 32-item certification quiz
// whose answer key ran `c a d b` then `(a d c b)` seven times without
// deviation. Answering that cycle cold scores 29/32 = 90% against an 80% gate,
// so the Learn gate certified a worker who had read nothing and unlocked
// Deliver work that pays per verified visit (ace#2061).
//
// ## Why the existing guards could not see it
//
// The letter distribution was PERFECT — 8 each of a/b/c/d. That is what a
// well-designed key looks like, and it defeats every frequency check. The
// defect lives in the SEQUENCE, and nothing inspected the sequence.
//
// It is also a different mechanism from every prior assessment-quality issue.
// ace#981, ace#1014, ace#1187 and ace#1042 are all about SEMANTIC guessability
// — whether the correct answer can be inferred from the wording. Those fixes
// leave this one untouched: on the reproducer every item had plausible
// distractors and tested a real taught rule. The items were fine. The key
// was not.
//
// A cycle is WORSE than randomness, not better. Randomising each item's
// correct position independently gives a cold guesser 1/k per item; rotating
// through the letters gives them everything the moment they notice.
//
// Pure and deterministic: the caller extracts the key from the built blueprint
// (each `qN_score` calculate compares against a literal, and that literal IS
// the answer key — CommCare has no correct-option primitive) and hands it in.
//
// ## A period the key cannot repeat is not a pattern (ace#2179)
//
// The first version of this check tested every period up to `min(maxPeriod,
// n)`, and that made it UNSATISFIABLE for short banks. At `period === n` the
// "cycle" is `key.slice(0, n)` — the key itself — so `hits === n` and
// `percent === 100` for EVERY possible key. `DEFAULT_MAX_PERIOD` is 6, so
// every bank of 6 or fewer items failed by construction, content irrelevant.
// Live on `bednet-check-2-visit/20260907-1126`: a 3-item non-gating pre-test
// keyed `b,c,a` reported `ok: false` at 100%, reading identically to the real
// ace#2061 defect.
//
// The degeneracy does not stop at `period === n`, which is why the bound is
// not `n - 1`. At `period === n - 1` the first `n - 1` items match the cycle
// by construction and item `n - 1` folds back onto `key[0]`, so the floor is
// `(n - 1) / n` — 85.7% on a 7-item bank, which clears an 80% gate on its own.
// Measured before this fix: `d,a,b,c,a,c,b` at an 80 gate failed at exactly
// 85.7% on period 6. Nothing about that key is exploitable; the arithmetic
// was.
//
// The bound that actually corresponds to the claim is **the cycle must fit in
// the key at least twice**: `period <= floor(n / 2)`. Below that bound a
// guesser can genuinely NOTICE the repetition mid-bank and ride it, which is
// the whole threat model; above it, "the cycle" is a transcription of the key
// and demonstrates nothing about predictability. It also puts a ceiling on the
// tautological floor: at `period <= n / 2` at most 50% of the items can match
// by construction, so any finding that clears a realistic gate (60–100%) is
// carried by real repetition and not by the shape of the loop.
//
// Detection is unweakened. Every real instance is short-period: the ace#2061
// reproducer is period 4 in 32 items, an all-one-letter key is period 1, an
// alternation is period 2.
//
// ## Short banks report `unable`, not `ok`
//
// A bank of 0 or 1 items has no period to test at all — `floor(n / 2) < 1`.
// Returning `ok: true` there would be the ace#1634 class verbatim: a check
// that looked at nothing rendering as a pass. It returns `unable(reason)`
// instead, so a caller has to say out loud that it is treating an unexamined
// bank as fine. Everything from 2 items up IS checked — period 1 on a 3-item
// key is a real question (`a,a,a` clears any gate cold, and still fails here).
//

import { type CheckOutcome, checked, unable } from './check-outcome.js';

export interface AnswerKeyPatternInput {
  /** Correct option value per item, in form order: ['c','a','d', …]. */
  key: string[];
  /** The gate, as a percentage 0-100. */
  passMark: number;
  /**
   * Longest period to test. 6 covers every cycle a human or a model plausibly
   * falls into; beyond that a "pattern" is not one a guesser would spot. The
   * effective bound is `min(maxPeriod, floor(key.length / 2))` — see the
   * ace#2179 note above for why the second term is not `key.length`.
   */
  maxPeriod?: number;
}

export interface AnswerKeyPatternFinding {
  /** The repeating unit that scores best, e.g. ['a','d','c','b']. */
  cycle: string[];
  /** 0-based item index the cycle is aligned to. */
  phase: number;
  hits: number;
  /** Percentage a cold guesser following `cycle` would score. */
  percent: number;
}

/** Payload carried alongside the findings on the `checked` branch. */
export interface AnswerKeyPatternExtras {
  /** The best periodic guess available, whether or not it passes. */
  best: AnswerKeyPatternFinding | null;
  /** Longest run of one repeated letter (a different, cruder tell). */
  longestConstantRun: number;
  /** The largest period this bank could carry, i.e. `floor(n / 2)`. */
  maxTestablePeriod: number;
  detail?: string;
  fix?: string;
}

export type AnswerKeyPatternResult = CheckOutcome<
  AnswerKeyPatternFinding,
  AnswerKeyPatternExtras
>;

const DEFAULT_MAX_PERIOD = 6;

/**
 * `ok` is true when NO fixed periodic guess reaches the pass mark.
 *
 * Deliberately not a "looks random enough" judgement — it asks the only
 * question that matters operationally: can somebody clear the gate without
 * reading it? A key may be visibly patterned and still pass here if the
 * pattern does not reach the mark, and that is the right call: the gate is
 * what is being protected, not the aesthetics of the key.
 *
 * Returns `unable` for a bank too short to carry any period (0 or 1 items).
 * `unable` is NOT a pass — narrow on `.status` before reading `.ok`.
 */
export function checkAnswerKeyPattern(
  input: AnswerKeyPatternInput,
): AnswerKeyPatternResult {
  const { key, passMark } = input;
  const maxPeriod = input.maxPeriod ?? DEFAULT_MAX_PERIOD;
  const n = key.length;

  // A cycle has to fit in the key TWICE to be a cycle rather than a copy of
  // the key. Below 2 items there is no such period, so there is nothing to
  // check — and nothing to pass.
  const maxTestablePeriod = Math.min(maxPeriod, Math.floor(n / 2));
  if (maxTestablePeriod < 1) {
    return unable(
      `the answer key has ${n} item${n === 1 ? '' : 's'}; a periodic guess needs a cycle ` +
        'that fits at least twice, so there is no testable period below 2 items. The bank ' +
        'was NOT examined for pattern-guessability — if a gate depends on it, the bank is ' +
        'too short to be a gate.',
    );
  }

  const longestConstantRun = longestRun(key);
  let best: AnswerKeyPatternFinding | null = null;

  for (let period = 1; period <= maxTestablePeriod; period++) {
    // Every phase alignment: the cycle a guesser latches onto need not start
    // at item 1 — on the reproducer it was visible only from item 5.
    // `phase < period <= n / 2` guarantees `phase + period <= n`, so every
    // slice below is a full-length cycle.
    for (let phase = 0; phase < period; phase++) {
      const cycle = key.slice(phase, phase + period);
      let hits = 0;
      for (let i = 0; i < n; i++) {
        if (key[i] === cycle[(((i - phase) % period) + period) % period]) hits++;
      }
      const percent = (hits * 100) / n;
      if (!best || percent > best.percent) best = { cycle, phase, hits, percent };
    }
  }

  if (!best || best.percent < passMark) {
    return { ...checked(true, []), best, longestConstantRun, maxTestablePeriod };
  }

  const shown = best.cycle.join(', ');
  return {
    ...checked(false, [best]),
    best,
    longestConstantRun,
    maxTestablePeriod,
    detail:
      `the answer key is periodic: answering the repeating pattern (${shown}) with no ` +
      `reading scores ${best.hits}/${n} = ${best.percent.toFixed(1)}%, which clears the ` +
      `${passMark}% gate. A balanced letter distribution does not prevent this — the ` +
      `defect is the SEQUENCE, not the frequencies.`,
    fix:
      'Re-key the affected items so the correct option position is chosen independently ' +
      'per item rather than rotated through the letters. Move the correct option TEXT to ' +
      'a different position and update that item\'s score calculate to match — do not ' +
      'simply point the calculate at a different letter, which would make a wrong answer ' +
      'correct.',
  };
}

function longestRun(key: string[]): number {
  let best = 0;
  let run = 0;
  for (let i = 0; i < key.length; i++) {
    run = i > 0 && key[i] === key[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}
