import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * dimagi-internal/ace#1833 — the silent half of upstream drift.
 *
 * ACE integrates with five systems it does not own. `upstream-regression-triage`
 * covers the loud failure (*what worked now fails*) and `probe-upstream-asks.ts`
 * covers the granted ask — but only for upstream **issues ACE cites**. A doc that
 * asserts a capability is ABSENT cites nothing, so when upstream SHIPS that
 * capability nothing fails, nothing is flagged, and the claim just quietly rots.
 *
 * That is exactly what happened here: three ACE files told readers the labs
 * synthetic manifest had "no conditional / relevant / branch primitive" for
 * three days after `connect-labs#1331` added
 * `BeneficiaryCohort.relevance_groups` (merged 2026-08-27). One of them is an
 * auto-fix hint an agent reads under failure.
 *
 * This is the ratchet. Each entry names an upstream primitive that DOES exist,
 * the patterns that assert it does not, and the reference the corrected text
 * must carry. Adding a future one is one row.
 *
 * Note what this does NOT do: it never asserts a primitive is USABLE. A
 * primitive can exist and still be inert on ACE's path — `relevance_groups` is,
 * for orphan-written paths on a labs-only opp — and saying so precisely is the
 * point. The banned thing is claiming it does not exist.
 */

interface UpstreamPrimitive {
  /** The upstream symbol, as it is spelled upstream. */
  readonly primitive: string;
  /** Where it lives upstream. */
  readonly declaredAt: string;
  /** The merged upstream change that added it, and when. */
  readonly upstreamRef: string;
  readonly shipped: string;
  /**
   * Patterns that assert the primitive does not exist. Matched against
   * comment-stripped, whitespace-collapsed file text.
   */
  readonly absenceClaims: readonly RegExp[];
  /** Every corrected site must cite this, so a deletion cannot pass for a fix. */
  readonly mustCite: RegExp;
}

const REGISTRY: readonly UpstreamPrimitive[] = [
  {
    primitive: 'BeneficiaryCohort.relevance_groups',
    declaredAt: 'connect_labs/labs/synthetic/generator/fixtures/manifest.py:300',
    upstreamRef: 'dimagi-internal/connect-labs#1331',
    shipped: '2026-08-27',
    absenceClaims: [
      /\b(has|have|carries|carry|with)\s+no\s+(conditional|relevant|relevance|branch)[^.]{0,80}primitive/i,
      /\bno\s+conditional\s*\/\s*relevant\s*\/\s*branch\s+primitive/i,
      /\bno\s+conditional\s*\/\s*relevant\s+primitive/i,
    ],
    mustCite: /connect-labs#1331/i,
  },
];

/** Files ACE ships as prose or code that a reader or an agent may believe. */
function trackedFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', 'skills', 'lib', 'agents', 'docs', 'playbook', 'test', 'commands', 'scripts', 'templates'],
    { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
  );
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => /\.(md|ts|tsx|yaml|yml)$/.test(f))
    // This file quotes the banned patterns as source; it is the registry, not a claim.
    .filter((f) => f !== SELF);
}

const repoRoot = path.resolve(__dirname, '..', '..');
const SELF = 'test/docs/upstream-absence-claims.test.ts';

/** Strip comment leaders and collapse whitespace, so a claim wrapped across
 *  `//`, ` * `, or a markdown line break still matches as one sentence. */
function normalize(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(\/\/+|\*+|#+|>|\|)\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

describe('upstream capabilities ACE must not claim are absent (ace#1833)', () => {
  for (const entry of REGISTRY) {
    describe(entry.primitive, () => {
      it(`is not claimed absent anywhere in the repo (shipped ${entry.shipped}, ${entry.upstreamRef})`, () => {
        const offenders: string[] = [];

        for (const file of trackedFiles()) {
          const normalized = normalize(readFileSync(path.join(repoRoot, file), 'utf-8'));
          for (const claim of entry.absenceClaims) {
            const hit = normalized.match(claim);
            if (hit) offenders.push(`${file}: "${hit[0].trim()}"`);
          }
        }

        expect(
          offenders,
          `${entry.primitive} exists upstream at ${entry.declaredAt} (${entry.upstreamRef}, merged ` +
            `${entry.shipped}), but these files still assert it does not. Correct the REASON; do not ` +
            `soften the remedy the text prescribes — a primitive that exists can still be inert on ` +
            `ACE's path, and saying which is the fix:\n  ${offenders.join('\n  ')}`,
        ).toEqual([]);
      });

      it('is cited by the sites that discuss it, so a deletion cannot pass for a correction', () => {
        const mentions = trackedFiles().filter((f) =>
          readFileSync(path.join(repoRoot, f), 'utf-8').includes('relevance_groups'),
        );

        expect(mentions.length, `no ACE file mentions ${entry.primitive} — the correction is missing`).toBeGreaterThan(0);

        const uncited = mentions.filter((f) => !entry.mustCite.test(readFileSync(path.join(repoRoot, f), 'utf-8')));

        expect(
          uncited,
          `these files name ${entry.primitive} without citing ${entry.upstreamRef}, so a reader cannot ` +
            `date the claim:\n  ${uncited.join('\n  ')}`,
        ).toEqual([]);
      });
    });
  }
});
