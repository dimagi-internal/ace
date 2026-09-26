/**
 * Tests for `lib/payable-cap-arithmetic.ts` (dimagi-internal/ace#2148).
 *
 * The controls are REAL released Deliver forms, not hand-written samples:
 *
 * - `spark-facilitator-meeting-record-20260906.xml` — `modules-1/forms-0.xml`
 *   of released build `0cb63a78fd9949b696876ee7a642b685` (HQ app
 *   `2f21ce56991d4245986c11bea0c78118`, domain `connect-ace-prod`,
 *   `spark-facilitator/20260906-2233`), downloaded verbatim with
 *   `commcare_download_ccz`. This is the run in the issue, AFTER the
 *   one-character fix landed: `if(pcts >= 3, 2, pcts)` over a pre-increment
 *   casedb counter.
 * - `spark-facilitator-meeting-record.xml` — build
 *   `b08533bdf26a48a295a362ff204fb88d` (`spark-facilitator/20260828-0703`),
 *   already vendored for `lib/casedb-preload-audit.ts`. Five weeks earlier,
 *   the same opportunity, the OTHER construction: `min(<casedb count> + 1, 3)`.
 *
 * Both are correct and they share no constant. That is the whole reason this
 * module simulates rather than comparing the clamp to the cap.
 *
 * The NEGATIVE control is the shipped DEFECT, reconstructed from the fixed
 * artifact by the single character the fix changed — `2` back to `3`. The
 * defective expression is recorded verbatim in that run's
 * `3-commcare/pdd-to-deliver-app-eval_report`:
 *
 *   capped_index = if(payable_count_this_step >= 3, 3, payable_count_this_step)
 *
 * and the eval's own hand-trace (meeting 4 -> index 3 -> "a NEW entity") is
 * asserted below, index for index.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertChecked, assertUnable } from '../../lib/check-outcome.js';
import {
  canonicalClampExpression,
  capFromPayabilityGuard,
  checkPayableCapArithmetic,
  classifyCounterTiming,
  findClamp,
  firstOvercappedSubmission,
  formatPayableCapReport,
  parseClamp,
  payableCapacity,
  payableKeyIndices,
} from '../../lib/payable-cap-arithmetic.js';

const FIXTURES = join(__dirname, '..', 'fixtures', 'ccz');
/** Released 2026-09-07T13:55Z — pre-increment counter, clamp `(>= 3, 2)`. */
const SHIPPED_FIX = readFileSync(
  join(FIXTURES, 'spark-facilitator-meeting-record-20260906.xml'),
  'utf8',
);
/** Released 2026-08-28 — includes-current counter, `min(… + 1, 3)`. */
const POST_INCREMENT = readFileSync(
  join(FIXTURES, 'spark-facilitator-meeting-record.xml'),
  'utf8',
);

/** The artifact as ace#2148 found it: the clamped value back at the cap. */
const SHIPPED_DEFECT = SHIPPED_FIX.replace(
  'if(/data/payable_count_this_step &gt;= 3, 2, /data/payable_count_this_step)',
  'if(/data/payable_count_this_step &gt;= 3, 3, /data/payable_count_this_step)',
);

/** A minimal form carrying just the binds a case needs. */
function form(binds: Array<[string, string]>): string {
  const rows = binds
    .map(([nodeset, calculate]) => `<bind nodeset="${nodeset}" calculate="${calculate}"/>`)
    .join('\n');
  return `<?xml version="1.0"?><h:html xmlns:h="http://www.w3.org/1999/xhtml"
    xmlns="http://www.w3.org/2002/xforms"><h:head><model>${rows}</model></h:head></h:html>`;
}

/** A casedb read of `prop`, the shape Nova emits. */
const casedb = (prop: string) =>
  `number(instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/${prop})`;

describe('the two REAL released builds — both correct, no shared constant', () => {
  it('the 2026-09-06 build: a pre-increment counter clamped at cap - 1 pays exactly 3', () => {
    const report = checkPayableCapArithmetic(SHIPPED_FIX);
    assertChecked(report);
    expect(report.node).toBe('/data/capped_index');
    expect(report.timing).toBe('pre-increment');
    expect(report.clamp).toMatchObject({ threshold: 3, clampedValue: 2 });
    // The cap is read off the app's own guard: `payable_count_this_step < 3`.
    expect(report.capSource).toBe('is_payable');
    expect(report.cap).toBe(3);
    expect(report.capacity).toBe(3);
    expect(report.indices.slice(0, 5)).toEqual([0, 1, 2, 2, 2]);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('the 2026-08-28 build: an includes-current counter clamped AT the cap also pays exactly 3', () => {
    // No `is_payable` node on this build — the payability discriminator is
    // `meeting_type`, in the key — so the cap comes from the PDD (§ 4.6 R3,
    // § 12.1: three paid meetings per FCAP step, total_cap_per_flw 21 = 7 x 3).
    const report = checkPayableCapArithmetic(POST_INCREMENT, { declaredCap: 3 });
    assertChecked(report);
    expect(report.node).toBe('/data/meeting_summary/meeting_index');
    expect(report.timing).toBe('includes-current');
    expect(report.clamp).toMatchObject({ threshold: 3, clampedValue: 3 });
    expect(report.capSource).toBe('declared');
    expect(report.capacity).toBe(3);
    expect(report.indices.slice(0, 5)).toEqual([1, 2, 3, 3, 3]);
    expect(report.ok).toBe(true);
  });

  it('the two builds agree on the cap while sharing no clamp constant', () => {
    const fixed = checkPayableCapArithmetic(SHIPPED_FIX);
    const older = checkPayableCapArithmetic(POST_INCREMENT, { declaredCap: 3 });
    assertChecked(fixed);
    assertChecked(older);
    expect(fixed.capacity).toBe(older.capacity);
    expect(fixed.clamp?.clampedValue).not.toBe(older.clamp?.clampedValue);
    expect(fixed.indices[0]).not.toBe(older.indices[0]);
  });
});

describe('the ace#2148 defect — NEGATIVE control, the artifact as it shipped', () => {
  const report = checkPayableCapArithmetic(SHIPPED_DEFECT);

  it('is a different artifact from the fixed one', () => {
    expect(SHIPPED_DEFECT).not.toBe(SHIPPED_FIX);
  });

  it('reports FAILURE: a cap of 3 that admits 4 payable keys', () => {
    assertChecked(report);
    expect(report.ok).toBe(false);
    expect(report.capacity).toBe(4);
    expect(report.cap).toBe(3);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe('payable-cap-off-by-one');
  });

  it('reproduces the eval report\'s hand-trace index for index', () => {
    assertChecked(report);
    // meeting 1 -> 0, 2 -> 1, 3 -> 2, 4 -> 3 (a key that never existed), 5 -> 3.
    expect(report.indices.slice(0, 5)).toEqual([0, 1, 2, 3, 3]);
  });

  it('names the FOURTH meeting as the one that mints a key Connect will pay', () => {
    assertChecked(report);
    expect(report.findings[0].firstOvercapped).toBe(4);
    expect(report.findings[0].detail).toContain('Submission #4');
  });

  it('proposes a remedy that actually admits the cap', () => {
    assertChecked(report);
    const remedy = report.findings[0].remedy;
    const reparsed = parseClamp(remedy);
    expect(reparsed).not.toBeNull();
    expect(payableCapacity(reparsed!, 'pre-increment')).toBe(3);
  });

  it('is caught WITHOUT a declared cap — the app contradicts its own is_payable', () => {
    // The guard on this build is correct (`pcts < 3`) and the key is not, so
    // the disagreement is decidable from the form alone. That matters: the
    // PDD cap is not plumbed into app-release-qa on every archetype.
    assertChecked(report);
    expect(report.capSource).toBe('is_payable');
  });

  it('renders as a failure, never as a clean line', () => {
    const rendered = formatPayableCapReport(report);
    expect(rendered).toContain('does NOT enforce the declared cap');
    expect(rendered).not.toContain('clean');
  });
});

describe('the boundary, enumerated', () => {
  // Pre-increment: the counter is the number of payable events ALREADY on the
  // entity, so the k-th submission reads k - 1.
  const preCorrect = { threshold: 3, clampedValue: 2 }; // cap 3
  const preBuggy = { threshold: 3, clampedValue: 3 }; // the defect

  it('index 0 — the first submission on a fresh entity', () => {
    expect(payableKeyIndices(preCorrect, 'pre-increment', 1)).toEqual([0]);
    expect(payableKeyIndices(preBuggy, 'pre-increment', 1)).toEqual([0]);
  });

  it('the last valid index is cap - 1 under pre-increment, and cap under includes-current', () => {
    expect(payableKeyIndices(preCorrect, 'pre-increment', 3).at(-1)).toBe(2);
    expect(payableKeyIndices({ threshold: 3, clampedValue: 3 }, 'includes-current', 3).at(-1)).toBe(3);
  });

  it('the clamp value itself is first reached AT the cap, not after it', () => {
    const indices = payableKeyIndices(preCorrect, 'pre-increment', 5);
    expect(indices.indexOf(preCorrect.clampedValue)).toBe(2); // the 3rd submission
  });

  it('one past the cap COLLIDES when correct, and mints a fresh key when off by one', () => {
    expect(payableKeyIndices(preCorrect, 'pre-increment', 4)).toEqual([0, 1, 2, 2]);
    expect(payableKeyIndices(preBuggy, 'pre-increment', 4)).toEqual([0, 1, 2, 3]);
    expect(firstOvercappedSubmission(preCorrect, 'pre-increment', 3)).toBeNull();
    expect(firstOvercappedSubmission(preBuggy, 'pre-increment', 3)).toBe(4);
  });

  it('every further submission past the cap collides too — the overshoot is exactly one', () => {
    expect(payableCapacity(preBuggy, 'pre-increment')).toBe(4);
    expect(new Set(payableKeyIndices(preBuggy, 'pre-increment', 40)).size).toBe(4);
  });

  it('a cap of 1 is a constant index, not a degenerate clamp', () => {
    expect(payableCapacity({ threshold: 1, clampedValue: 0 }, 'pre-increment')).toBe(1);
    expect(payableKeyIndices({ threshold: 1, clampedValue: 0 }, 'pre-increment', 4)).toEqual([0, 0, 0, 0]);
    expect(payableCapacity({ threshold: 1, clampedValue: 1 }, 'includes-current')).toBe(1);
  });

  it('the canonical expression round-trips to its cap for both timings, 1..6', () => {
    for (let cap = 1; cap <= 6; cap++) {
      for (const timing of ['pre-increment', 'includes-current'] as const) {
        const parsed = parseClamp(canonicalClampExpression('/data/n', cap, timing));
        expect(parsed, `cap ${cap} ${timing}`).not.toBeNull();
        expect(payableCapacity(parsed!, timing), `cap ${cap} ${timing}`).toBe(cap);
      }
    }
  });

  it('clamping AT the cap under pre-increment is the off-by-one, for every cap', () => {
    for (let cap = 1; cap <= 6; cap++) {
      expect(payableCapacity({ threshold: cap, clampedValue: cap }, 'pre-increment')).toBe(cap + 1);
    }
  });

  it('a cap of 0 is reported as not expressible, never as a pass', () => {
    const xml = form([
      ['/data/n', casedb('paid_count')],
      ['/data/idx', 'if(/data/n >= 3, 2, /data/n)'],
      ['/data/deliver/entity_id', "concat('e', '-', /data/idx)"],
    ]);
    const report = checkPayableCapArithmetic(xml, { declaredCap: 0 });
    assertChecked(report);
    expect(report.ok).toBe(false);
    expect(report.findings[0].kind).toBe('payable-cap-not-expressible');
  });
});

describe('a key with nothing to check — reported unable, never clean', () => {
  it('no entity_id bind at all', () => {
    const report = checkPayableCapArithmetic(form([['/data/n', '1']]));
    assertUnable(report);
    expect(report.reason).toContain('entity_id');
  });

  it('an EMPTY key — concat() with no components', () => {
    const report = checkPayableCapArithmetic(form([['/data/deliver/entity_id', 'concat()']]));
    assertUnable(report);
    expect(report.reason).toContain('no components');
  });

  it('a SINGLE-component key with no clamp says the cap is not enforced at all', () => {
    const report = checkPayableCapArithmetic(
      form([['/data/deliver/entity_id', 'concat(/data/household_id)']]),
      { declaredCap: 3 },
    );
    assertUnable(report);
    expect(report.reason).toContain('no clamped counter');
    expect(report.reason).toContain('the cap is not enforced at all');
  });

  it('an entity_id that indirects to a node with no bind is unable', () => {
    const report = checkPayableCapArithmetic(form([['/data/deliver/entity_id', '/data/entity_key']]));
    assertUnable(report);
    expect(report.reason).toContain('entity_id');
  });

  it('a clamp over a counter that never reaches casedb is undecidable, not assumed', () => {
    const xml = form([
      ['/data/n', 'count(/data/repeat/item)'],
      ['/data/idx', 'min(/data/n, 3)'],
      ['/data/deliver/entity_id', "concat('e', '-', /data/idx)"],
    ]);
    const report = checkPayableCapArithmetic(xml, { declaredCap: 3 });
    assertUnable(report);
    expect(report.reason).toContain('casedb');
  });

  it('a clamp with no cap from either source is unable, not a pass', () => {
    const xml = form([
      ['/data/n', casedb('paid_count')],
      ['/data/idx', 'min(/data/n, 3)'],
      ['/data/deliver/entity_id', "concat('e', '-', /data/idx)"],
    ]);
    const report = checkPayableCapArithmetic(xml);
    assertUnable(report);
    expect(report.reason).toContain('no per-entity cap');
  });

  it('formatUnable output is loud, not green', () => {
    const report = checkPayableCapArithmetic(form([['/data/n', '1']]));
    const rendered = formatPayableCapReport(report);
    expect(rendered).toContain('UNABLE TO CHECK');
    expect(rendered).not.toContain('PASS');
  });
});

describe('clamp spellings', () => {
  it('min(), both argument orders', () => {
    expect(parseClamp('min(/data/n, 3)')).toMatchObject({ threshold: 3, clampedValue: 3, counter: '/data/n' });
    expect(parseClamp('min(3, /data/n)')).toMatchObject({ threshold: 3, clampedValue: 3, counter: '/data/n' });
  });

  it('if() with >= and with > normalise to the same clamp', () => {
    const ge = parseClamp('if(/data/n >= 3, 3, /data/n)');
    const gt = parseClamp('if(/data/n > 2, 3, /data/n)');
    expect(ge).toMatchObject({ threshold: 3, clampedValue: 3 });
    expect(gt).toMatchObject({ threshold: 3, clampedValue: 3 });
    expect(payableCapacity(ge!, 'pre-increment')).toBe(payableCapacity(gt!, 'pre-increment'));
  });

  it('if() with the literal on the left', () => {
    expect(parseClamp('if(3 <= /data/n, 2, /data/n)')).toMatchObject({ threshold: 3, clampedValue: 2 });
  });

  it('if() written inside out — the counter in the THEN branch', () => {
    expect(parseClamp('if(/data/n < 3, /data/n, 2)')).toMatchObject({ threshold: 3, clampedValue: 2 });
  });

  it('rejects expressions that are not clamps', () => {
    expect(parseClamp("if(/data/a = 'yes', 1, 0)")).toBeNull();
    expect(parseClamp('min(/data/a, /data/b)')).toBeNull();
    expect(parseClamp('concat(/data/a, /data/b)')).toBeNull();
    // A different node in the else branch is not a clamp of the counter.
    expect(parseClamp('if(/data/n >= 3, 3, /data/m)')).toBeNull();
  });

  it('finds a clamp nested inside branch logic — the shape Nova actually emits', () => {
    // Verbatim from the 2026-08-28 released build: the clamp sits three
    // if()s deep, inside the payable, same-step branch.
    const m = /nodeset="\/data\/meeting_summary\/meeting_index"[^>]*calculate="([^"]*)"/.exec(
      POST_INCREMENT,
    );
    expect(m, 'the vendored build should still carry a meeting_index calculate').not.toBeNull();
    const calc = m![1].replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    // Top-level it is an `if(step = '', '', …)` — not a clamp.
    expect(parseClamp(calc)).toBeNull();
    expect(findClamp(calc)).toMatchObject({ threshold: 3, clampedValue: 3 });
    const nested = findClamp("if(/data/s = '', '', if(/data/p = 1, min(/data/n + 1, 3), 1))");
    expect(nested).toMatchObject({ threshold: 3, clampedValue: 3 });
  });
});

describe('counter timing', () => {
  const binds = new Map<string, string>([
    ['/data/pre', casedb('paid_count')],
    ['/data/post', `${casedb('paid_count')} + 1`],
    ['/data/indirect', '/data/pre'],
    ['/data/local', 'count(/data/repeat/item)'],
  ]);

  it('a bare casedb read is pre-increment', () => {
    expect(classifyCounterTiming('/data/pre', binds)).toBe('pre-increment');
  });

  it('a casedb read plus one already counts this submission', () => {
    expect(classifyCounterTiming('/data/post', binds)).toBe('includes-current');
    expect(classifyCounterTiming(`${casedb('paid_count')} + 1`, binds)).toBe('includes-current');
  });

  it('follows one node of indirection', () => {
    expect(classifyCounterTiming('/data/indirect', binds)).toBe('pre-increment');
  });

  it('a `+ 1` in an UNRELATED node of the chain does not flip the timing', () => {
    // The 2026-09-06 build resolves through `/data/sel_step_num`, which does
    // arithmetic of its own. Reading the chain as one blob misclassifies it,
    // and a misclassified timing is an off-by-one in the other direction.
    const withSibling = new Map(binds);
    withSibling.set('/data/step_num', 'number(/data/raw) + 1');
    withSibling.set('/data/pre2', `if(/data/step_num = 1, ${casedb('paid_count')}, 0)`);
    expect(classifyCounterTiming('/data/pre2', withSibling)).toBe('pre-increment');
  });

  it('a counter that never reaches casedb is undecidable', () => {
    expect(classifyCounterTiming('/data/local', binds)).toBeNull();
  });

  it('classifies the two real builds', () => {
    const fixBinds = new Map<string, string>([
      ['/data/payable_count_this_step', /nodeset="\/data\/payable_count_this_step"[^>]*calculate="([^"]*)"/
        .exec(SHIPPED_FIX)![1].replace(/&gt;/g, '>').replace(/&lt;/g, '<')],
    ]);
    expect(classifyCounterTiming('/data/payable_count_this_step', fixBinds)).toBe('pre-increment');
  });
});

describe('the cap read off the app\'s own guard', () => {
  it('reads `counter < N` under a pre-increment counter as a cap of N', () => {
    expect(capFromPayabilityGuard(SHIPPED_FIX, '/data/payable_count_this_step', 'pre-increment')).toBe(3);
  });

  it('shifts by one when the counter already counts this submission', () => {
    expect(capFromPayabilityGuard(SHIPPED_FIX, '/data/payable_count_this_step', 'includes-current')).toBe(2);
  });

  it('ignores a guard over a DIFFERENT counter', () => {
    expect(capFromPayabilityGuard(SHIPPED_FIX, '/data/some_other_counter', 'pre-increment')).toBeNull();
  });
});

describe('ace#2480 — the `+ 1` in the clamp, the casedb read one hop down', () => {
  // `spark-facilitator/20260925-1536`, Nova app
  // `ef133601-bd0e-4691-ba11-8339440fd8c5`, Community Meeting Record. The
  // counter the clamp reads is `stored_index + 1`: the `+ 1` sits in the
  // clamp's OWN counter expression and the casedb read lives in a separate
  // hidden node. No single resolved part holds both, which the old
  // co-occurrence rule read as `pre-increment` — a false off-by-one whose
  // remedy (`>= 3, 2`) would have paid 2 keys per step against a cap of 3.
  const read = (prop: string) =>
    `instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/${prop}`;
  const storedIndex = `if(${read('step_meeting_index')} = '', 0, number(${read('step_meeting_index')}))`;
  const shape = (clampExpr: string) =>
    form([
      ['/data/stored_index', storedIndex],
      [
        '/data/capped_index',
        `if(/data/meeting_kind = 'community_meeting', ${clampExpr}, /data/stored_index)`,
      ],
      [
        '/data/entity_key',
        "concat(/data/case_id, '-', /data/pilot_fcap_step, '-', /data/capped_index, '-', /data/meeting_kind)",
      ],
      ['/data/new_index', '/data/stored_index + 1'],
      ['/data/deliver/entity_id', '/data/entity_key'],
    ]).replace(/>= 3/g, '&gt;= 3');

  for (const clampExpr of [
    'if(/data/stored_index + 1 >= 3, 3, /data/stored_index + 1)',
    'min(/data/stored_index + 1, 3)',
  ]) {
    it(`${clampExpr} admits exactly 3 payable keys per step — no off-by-one`, () => {
      const report = checkPayableCapArithmetic(shape(clampExpr), { declaredCap: 3 });
      assertChecked(report);
      expect(report.node).toBe('/data/capped_index');
      expect(report.timing).toBe('includes-current');
      // The hand trace: stored 0,1,2,3,4 -> capped 1,2,3,3,3.
      expect(report.indices.slice(0, 5)).toEqual([1, 2, 3, 3, 3]);
      expect(report.capacity).toBe(3);
      expect(report.findings.map((f) => f.kind)).not.toContain('payable-cap-off-by-one');
      expect(report.ok).toBe(true);
    });
  }

  it('the filed remedy would UNDER-pay — it is the finding now, not the fix', () => {
    const report = checkPayableCapArithmetic(
      shape('if(/data/stored_index + 1 >= 3, 2, /data/stored_index + 1)'),
      { declaredCap: 3 },
    );
    assertChecked(report);
    expect(report.capacity).toBe(2);
    expect(report.ok).toBe(false);
    expect(report.findings[0].firstOvercapped).toBeNull();
  });

  it('the same two-node shape WITHOUT the + 1 is still the ace#2148 off-by-one', () => {
    const report = checkPayableCapArithmetic(
      shape('if(/data/stored_index >= 3, 3, /data/stored_index)'),
      { declaredCap: 3 },
    );
    assertChecked(report);
    expect(report.timing).toBe('pre-increment');
    expect(report.capacity).toBe(4);
    expect(report.findings[0].kind).toBe('payable-cap-off-by-one');
  });

  it('classifies the counter by evaluating its offset across hops', () => {
    const binds = new Map<string, string>([
      ['/data/stored_index', storedIndex],
      ['/data/next', '/data/stored_index + 1'],
    ]);
    expect(classifyCounterTiming('/data/stored_index', binds)).toBe('pre-increment');
    expect(classifyCounterTiming('/data/stored_index + 1', binds)).toBe('includes-current');
    expect(classifyCounterTiming('/data/next', binds)).toBe('includes-current');
    expect(classifyCounterTiming('number(/data/stored_index) + 1', binds)).toBe('includes-current');
    // Two increments is not a timing ACE can key on — undecidable, not guessed.
    expect(classifyCounterTiming('/data/next + 1', binds)).toBeNull();
  });
});
