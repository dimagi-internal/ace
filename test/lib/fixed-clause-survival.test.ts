/**
 * dimagi-internal/ace#2365 — the componentized idea-to-pdd branch composed
 * component PDDs into one overview that silently picked between two conflicting
 * [FIXED] clauses and dropped a [FIXED] threshold (Targeting § 6's 200m).
 *
 * Every input is a captured artifact under `test/fixtures/fixed-clause-survival/`,
 * the Google Docs plain-text export (`drive_read_file`) read 2026-10-16:
 *
 *   - `pdd-targeting-survey.txt`      — PDD Targeting Survey (Component 2),
 *     Drive 1u-QzTn1G82n5U5J5txjUFjoNOnlQzGEnmU3B57AcYNs, revision 116
 *   - `pdd-productive-asset.txt`      — PDD Productive Asset (In-kind) (Component 5),
 *     Drive 1SBEd4ic-1BIxAbhgaKWR-M-04QEeceCUCshm2ynPHhQ, revision 31
 *   - `pdd-consumption-support.txt`   — PDD Consumption Support (Component 6),
 *     Drive 1K7b9fM3wgaIGggGBV1iTcwOLrDVSsdsRIxG8fLBzeDI, revision 37
 *   - `composed-overview-20260908-0510.txt` — the composed overview of
 *     `poverty-graduation/20260908-0510`, Drive
 *     1vHPTI10DyUPUJhyRoRytUtLs2qQih2zxQvFCp6V50rU, revision 133. Its reviewer
 *     comments export as footnotes; footnote `[ad]` quotes the 200m figure, which
 *     is why a threshold quoted only in a comment must not count as carried.
 *
 * Measured on these fixtures before this module: the overview's body carries
 * "GPS present, not spoofed, plausible travel speed between consecutive
 * visits" and no 200m; the only "200m" in the export is the `[ad]` footnote.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkFixedClauseSurvival,
  extractFixedClauses,
  quantitiesIn,
} from '../../lib/fixed-clause-survival';

const FIX = join(__dirname, '..', 'fixtures', 'fixed-clause-survival');
const TARGETING = readFileSync(join(FIX, 'pdd-targeting-survey.txt'), 'utf8');
const ASSET = readFileSync(join(FIX, 'pdd-productive-asset.txt'), 'utf8');
const CONSUMPTION = readFileSync(join(FIX, 'pdd-consumption-support.txt'), 'utf8');
const COMPOSED = readFileSync(join(FIX, 'composed-overview-20260908-0510.txt'), 'utf8');

const C2 = { component: '2', text: TARGETING, citeAs: ['C2', 'Targeting', 'Targeting Survey', 'PDD Targeting Survey'] };
const C5 = { component: '5', text: ASSET, citeAs: ['C5', 'Productive Asset', 'PDD Productive Asset'] };
const C6 = { component: '6', text: CONSUMPTION, citeAs: ['C6', 'Consumption Support', 'PDD Consumption Support'] };

describe('extractFixedClauses — real component PDD exports', () => {
  it('reads Targeting § 6\'s GPS bullet as a [FIXED] clause carrying 200m, and skips the § 0 legend', () => {
    const clauses = extractFixedClauses('2', TARGETING);
    const gps = clauses.find((c) => c.section === '6' && c.text.startsWith('GPS:'));
    expect(gps?.quantities).toEqual(['200m']);
    expect(clauses.some((c) => c.text.startsWith('— a hard constraint'))).toBe(false);
  });

  it('canonicalises a threshold however it is written', () => {
    expect(quantitiesIn('> 200m, < 15m, 200 metres, 6 minutes')).toEqual(['200m', '15m', '6min']);
  });
});

describe('checkFixedClauseSurvival (ace#2365)', () => {
  it('NEGATIVE — the composed overview restates Targeting § 6 GPS without its 200m threshold', () => {
    const r = checkFixedClauseSurvival({ components: [C2], composed: COMPOSED });
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: 'quantity-dropped', droppedQuantities: ['200m'] });
    expect(r.findings[0].clauses[0]).toMatch(/^2 §6 /);
  });

  it('NEGATIVE — Productive Asset § 8 and Consumption Support § 8 disagree on what delivered-and-verified gates', () => {
    const r = checkFixedClauseSurvival({ components: [C5, C6], composed: COMPOSED });
    expect(r.ok).toBe(false);
    const conflicts = r.findings.filter((f) => f.kind === 'possible-conflict');
    expect(conflicts.map((f) => f.clauses.join(' vs '))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^5 §8 #\d+ vs 6 §8 #\d+$/)]),
    );
    expect(conflicts.every((f) => f.stateTerm === 'delivered-and-verified')).toBe(true);
  });

  it('POSITIVE — once the overview carries the 200m threshold, Targeting\'s [FIXED] clauses all survive', () => {
    const repaired = COMPOSED.replace(
      'GPS present, not spoofed, plausible travel speed between consecutive visits',
      'GPS present, not spoofed, not > 200m from the FLW\'s other visits at an impossible travel speed between consecutive visits',
    );
    const r = checkFixedClauseSurvival({ components: [C2], composed: repaired });
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('a threshold quoted only in a reviewer-comment footnote does not count as carried', () => {
    expect(COMPOSED).toMatch(/^\[ad\].*200m/m);
    const r = checkFixedClauseSurvival({ components: [C2], composed: COMPOSED });
    expect(r.findings.map((f) => f.kind)).toEqual(['quantity-dropped']);
  });

  it('a clause the overview never touches is uncarried, not a finding — the component PDD stays the authority', () => {
    const r = checkFixedClauseSurvival({ components: [C2], composed: 'Programme overview.\n' });
    expect(r.clauses.every((c) => c.survival === 'uncarried')).toBe(true);
    expect(r.findings).toEqual([]);
  });
});
