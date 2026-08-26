import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Class-level preventer for ace#1559: an `-eval` rubric's PROSE count of its
// own dimensions silently drifts from the weight block it is describing.
//
// The failure is silent by construction. `pdd-to-learn-app-eval` gained
// `assessment_rule_coverage` on 2026-08-13 and `language_conformance` on
// 2026-08-17; the weight block was re-balanced correctly both times (it still
// summed to 1.00) but the "Grade across 8 dimensions" line was never touched.
// A judge follows the PROSE, so it grades 8 of 9 — and the omitted dimension
// is the one that emits the `repairs[]` work order back to the producer skill.
// The weighted mean still computes, the verdict still validates, and the
// auto-fix loop just quietly has nothing to consume.
//
// Two independent invariants, because each catches a different mistake:
//
//   1. WEIGHT SUM — every declared block sums to 1.00. Catches a dimension
//      added without re-balancing.
//   2. PROSE COUNT — where a rubric states its dimension count in prose, that
//      count matches the block. Catches a dimension added without updating
//      the sentence the judge actually reads. This is the ace#1559 defect.
//
// On `null` weights: several rubrics document dimensions that go `null` and
// have their weight redistributed across the rest (e.g. `language_conformance`
// "null + redistribute when PDD names no working language";
// synthetic-workflow-polish-eval's "dimensions 6+7 fall back to `null` and the
// overall_score re-normalizes against the remaining 5"). That is a RUNTIME
// behaviour of one grading pass, not a property of the declared rubric — the
// template block always carries numeric weights summing to 1.00, and the
// redistribution happens against them. So the sum check reads the declared
// weights and does not try to model redistribution.

const SKILLS_DIR = join(__dirname, '..', '..', 'skills');

/** A single `name: { ... weight: N ... }` row inside a `dimensions:` block. */
interface Dimension {
  name: string;
  weight: number | null;
  /** The `# <Axis> axis (N%)` comment group this row falls under, if any. */
  axis: string | null;
}

interface RubricBlock {
  /** 1-based line of the `dimensions:` key that opens the block. */
  line: number;
  dims: Dimension[];
  /** Declared axis groups, in document order: `[['Conformance', 45], ...]`. */
  axes: Array<[string, number]>;
}

const DIMENSIONS_KEY = /^\s*dimensions:\s*$/;
// `field_answerability:  { score: 8.0, weight: 0.08 }` — `score:` is present in
// the verdict-shaped examples and absent in the weights-only ones, so match
// `weight:` anywhere inside the flow mapping rather than at a fixed position.
const DIMENSION_ROW = /^\s*([a-zA-Z0-9_]+):\s*\{[^}]*\bweight:\s*([0-9.]+|null)/;
const AXIS_COMMENT = /^\s*#\s*([A-Za-z]+)\s+axis\s*\((\d+)%\)/;

/**
 * Extract every dimension block from an `-eval` SKILL.md.
 *
 * A file may declare more than one — `ocs-chatbot-eval` carries a 5-dimension
 * `--deep`/`--monitor` rubric and a separate 1-dimension `--quick` smoke
 * rubric — so the invariants are per-block, never per-file.
 */
export function parseRubricBlocks(doc: string): RubricBlock[] {
  const lines = doc.split('\n');
  const blocks: RubricBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!DIMENSIONS_KEY.test(lines[i])) continue;

    const dims: Dimension[] = [];
    const axes: Array<[string, number]> = [];
    let axis: string | null = null;

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];

      const axisMatch = line.match(AXIS_COMMENT);
      if (axisMatch) {
        axis = axisMatch[1];
        axes.push([axisMatch[1], Number(axisMatch[2])]);
        continue;
      }

      const row = line.match(DIMENSION_ROW);
      if (row) {
        dims.push({
          name: row[1],
          weight: row[2] === 'null' ? null : Number(row[2]),
          axis,
        });
        continue;
      }

      // Blank lines and non-axis comments sit between rows; anything else
      // ends the block.
      if (/^\s*(#|$)/.test(line)) continue;
      break;
    }

    if (dims.length) blocks.push({ line: i + 1, dims, axes });
  }

  return blocks;
}

/**
 * Canonical prose statements of "how many dimensions this rubric has".
 *
 * Deliberately a closed set of forms rather than every `\d+ dimensions` match.
 * Bare matching produces false positives on prose that counts a SUBSET —
 * synthetic-workflow-polish-eval's "re-normalizes against the remaining 5
 * dimensions" describes 5 of its 7 surviving a capture failure, and
 * solicitation-review-eval's "the soft 0.6 dimensions" is a weight, not a
 * count. A rubric whose count is phrased outside this set is SKIPPED, not
 * failed: a missed check costs nothing, a false failure costs a real fix.
 */
const PROSE_COUNT_FORMS: RegExp[] = [
  /\bgrade across (\d+) dimensions/gi,
  /\bscore across (\d+) dimensions/gi,
  /\bscore (\d+) dimensions\b/gi,
  /\((\d+) dimensions[,)]/g,
];

/** `5 conformance (45%) + 4 fitness (55%)` — the axis split claim. */
const PROSE_AXIS_CLAIM = /(\d+) ([a-z]+) \((\d+)%\) \+ (\d+) ([a-z]+) \((\d+)%\)/i;

/**
 * Strip the Change Log before scanning prose.
 *
 * Change Log rows record HISTORICAL counts on purpose ("Initial version. 5
 * dimensions: ...", "5 → 9 dimensions"). Those are provenance, and holding
 * them to the current block would force authors to rewrite history.
 */
export function stripChangeLog(doc: string): string {
  const idx = doc.search(/^## Change Log\s*$/m);
  return idx === -1 ? doc : doc.slice(0, idx);
}

/** Normalize wrapping so a claim split across lines still matches. */
function flatten(doc: string): string {
  return doc.replace(/\s+/g, ' ');
}

export function parseProseCounts(doc: string): Array<{ count: number; raw: string }> {
  const body = flatten(stripChangeLog(doc));
  const found: Array<{ count: number; raw: string }> = [];

  for (const form of PROSE_COUNT_FORMS) {
    for (const m of body.matchAll(form)) {
      found.push({ count: Number(m[1]), raw: m[0] });
    }
  }

  return found;
}

export function parseAxisClaim(
  doc: string,
): { groups: Array<{ count: number; name: string; pct: number }>; raw: string } | null {
  const m = flatten(stripChangeLog(doc)).match(PROSE_AXIS_CLAIM);
  if (!m) return null;
  return {
    raw: m[0],
    groups: [
      { count: Number(m[1]), name: m[2].toLowerCase(), pct: Number(m[3]) },
      { count: Number(m[4]), name: m[5].toLowerCase(), pct: Number(m[6]) },
    ],
  };
}

function evalSkills(): Array<{ slug: string; doc: string }> {
  return readdirSync(SKILLS_DIR)
    .filter((d) => d.endsWith('-eval'))
    .map((slug) => ({ slug, path: join(SKILLS_DIR, slug, 'SKILL.md') }))
    .filter(({ path }) => existsSync(path))
    .map(({ slug, path }) => ({ slug, doc: readFileSync(path, 'utf8') }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

describe('eval rubric dimension integrity', () => {
  const skills = evalSkills();

  it('finds the eval skills to check', () => {
    expect(skills.length).toBeGreaterThan(20);
    // Guard the parser itself: if a refactor changes the block shape, this is
    // what stops the whole suite from silently degrading to zero coverage.
    const withBlocks = skills.filter((s) => parseRubricBlocks(s.doc).length > 0);
    expect(withBlocks.length).toBeGreaterThan(20);
  });

  it('every declared weight block sums to 1.00', () => {
    const offenders: string[] = [];

    for (const { slug, doc } of skills) {
      for (const block of parseRubricBlocks(doc)) {
        const sum = block.dims.reduce((a, d) => a + (d.weight ?? 0), 0);
        if (Math.abs(sum - 1) > 0.005) {
          offenders.push(
            `${slug} (SKILL.md:${block.line}): ${block.dims.length} dimensions sum to ${sum.toFixed(4)}, expected 1.00`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every prose dimension count matches a declared block', () => {
    const offenders: string[] = [];

    for (const { slug, doc } of skills) {
      const blocks = parseRubricBlocks(doc);
      if (!blocks.length) continue; // no rubric to contradict

      const declared = blocks.map((b) => b.dims.length);

      for (const { count, raw } of parseProseCounts(doc)) {
        // A file may declare several rubrics (per-mode); the prose need only
        // match one of them.
        if (declared.includes(count)) continue;
        offenders.push(
          `${slug}: prose says "${raw.trim()}" but the declared block(s) have [${declared.join(', ')}] dimensions`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every prose axis split matches the declared axis groups', () => {
    const offenders: string[] = [];

    for (const { slug, doc } of skills) {
      const claim = parseAxisClaim(doc);
      if (!claim) continue;

      const block = parseRubricBlocks(doc).find((b) => b.axes.length >= 2);
      if (!block) continue; // claim with no axis-annotated block to check against

      for (const group of claim.groups) {
        const rows = block.dims.filter((d) => d.axis?.toLowerCase() === group.name);
        if (!rows.length) continue; // axis named in prose but not annotated

        const pct = Math.round(rows.reduce((a, d) => a + (d.weight ?? 0), 0) * 100);

        if (rows.length !== group.count) {
          offenders.push(
            `${slug}: prose says "${claim.raw}" — ${group.count} ${group.name} dimensions, but ${rows.length} are annotated \`# ${group.name} axis\``,
          );
        }
        if (pct !== group.pct) {
          offenders.push(
            `${slug}: prose says ${group.name} is ${group.pct}% but the annotated rows sum to ${pct}%`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('parser behaviour', () => {
  it('reads weights out of both the weights-only and verdict-shaped forms', () => {
    const doc = [
      'dimensions:',
      '  alpha: { weight: 0.4 }',
      '  beta:  { score: 8.0, weight: 0.6 }   # trailing comment',
    ].join('\n');
    const [block] = parseRubricBlocks(doc);
    expect(block.dims.map((d) => [d.name, d.weight])).toEqual([
      ['alpha', 0.4],
      ['beta', 0.6],
    ]);
  });

  it('keeps per-mode rubrics as separate blocks', () => {
    const doc = [
      'dimensions:',
      '  a: { weight: 0.5 }',
      '  b: { weight: 0.5 }',
      '',
      'prose in between',
      '',
      'dimensions:',
      '  only: { weight: 1.0 }',
    ].join('\n');
    expect(parseRubricBlocks(doc).map((b) => b.dims.length)).toEqual([2, 1]);
  });

  it('tags rows with the axis comment that precedes them', () => {
    const doc = [
      'dimensions:',
      '  # Conformance axis (45%) — matches the PDD skeleton',
      '  a: { weight: 0.45 }',
      '  # Fitness axis (55%) — graded vs expert bar',
      '  b: { weight: 0.55 }',
    ].join('\n');
    const [block] = parseRubricBlocks(doc);
    expect(block.dims.map((d) => d.axis)).toEqual(['Conformance', 'Fitness']);
    expect(block.axes).toEqual([
      ['Conformance', 45],
      ['Fitness', 55],
    ]);
  });

  it('matches a count claim that wraps across lines', () => {
    const doc = '5. **Grade across 9 dimensions** — 5 conformance (45%) + 4 fitness\n   (55%).';
    expect(parseProseCounts(doc).map((p) => p.count)).toEqual([9]);
    expect(parseAxisClaim(doc)?.groups.map((g) => [g.name, g.count, g.pct])).toEqual([
      ['conformance', 5, 45],
      ['fitness', 4, 55],
    ]);
  });

  it('ignores historical counts in the Change Log', () => {
    const doc = [
      '**Grade across 9 dimensions**',
      '',
      '## Change Log',
      '',
      '| 2026-04-28 | Initial version. Grade across 5 dimensions. |',
    ].join('\n');
    expect(parseProseCounts(doc).map((p) => p.count)).toEqual([9]);
  });

  it('does not read a SUBSET count as a rubric count', () => {
    // synthetic-workflow-polish-eval's redistribution prose, and
    // solicitation-review-eval's soft-weight prose. Neither states how many
    // dimensions the rubric has.
    const doc = [
      'dimensions 6+7 fall back to `null` and the overall_score',
      're-normalizes against the remaining 5 dimensions.',
      'The soft 0.6 dimensions must never carry a pass.',
    ].join('\n');
    expect(parseProseCounts(doc)).toEqual([]);
  });
});
