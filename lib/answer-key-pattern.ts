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

export interface AnswerKeyPatternInput {
  /** Correct option value per item, in form order: ['c','a','d', …]. */
  key: string[];
  /** The gate, as a percentage 0-100. */
  passMark: number;
  /**
   * Longest period to test. 6 covers every cycle a human or a model plausibly
   * falls into; beyond that a "pattern" is not one a guesser would spot.
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

export interface AnswerKeyPatternResult {
  ok: boolean;
  /** The best periodic guess available, whether or not it passes. */
  best: AnswerKeyPatternFinding | null;
  /** Longest run of one repeated letter (a different, cruder tell). */
  longestConstantRun: number;
  detail?: string;
  fix?: string;
}

const DEFAULT_MAX_PERIOD = 6;

/**
 * True when NO fixed periodic guess reaches the pass mark.
 *
 * Deliberately not a "looks random enough" judgement — it asks the only
 * question that matters operationally: can somebody clear the gate without
 * reading it? A key may be visibly patterned and still pass here if the
 * pattern does not reach the mark, and that is the right call: the gate is
 * what is being protected, not the aesthetics of the key.
 */
export function checkAnswerKeyPattern(
  input: AnswerKeyPatternInput,
): AnswerKeyPatternResult {
  const { key, passMark } = input;
  const maxPeriod = input.maxPeriod ?? DEFAULT_MAX_PERIOD;
  const n = key.length;

  const longestConstantRun = longestRun(key);
  if (n === 0) return { ok: true, best: null, longestConstantRun: 0 };

  let best: AnswerKeyPatternFinding | null = null;

  for (let period = 1; period <= Math.min(maxPeriod, n); period++) {
    // Every phase alignment: the cycle a guesser latches onto need not start
    // at item 1 — on the reproducer it was visible only from item 5.
    for (let phase = 0; phase < period; phase++) {
      const cycle = key.slice(phase, phase + period);
      if (cycle.length < period) continue;
      let hits = 0;
      for (let i = 0; i < n; i++) {
        if (key[i] === cycle[(i - phase % period + period * n) % period]) hits++;
      }
      const percent = (hits * 100) / n;
      if (!best || percent > best.percent) best = { cycle, phase, hits, percent };
    }
  }

  if (!best || best.percent < passMark) {
    return { ok: true, best, longestConstantRun };
  }

  const shown = best.cycle.join(', ');
  return {
    ok: false,
    best,
    longestConstantRun,
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
