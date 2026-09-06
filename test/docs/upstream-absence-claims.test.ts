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
  /**
   * Matches the way a file spells this primitive when discussing it. Distinct
   * from `primitive`, which is the fully-qualified upstream name — a doc writes
   * `relevance_groups`, not `BeneficiaryCohort.relevance_groups`.
   *
   * A RegExp rather than a substring because near-namesakes exist and mean
   * different things: `commcare_create_lookup_table` is ACE's CommCare **HQ**
   * atom, nothing to do with Nova's `create_lookup_table`. Anchor accordingly.
   */
  readonly mentions: RegExp;
  /**
   * Paths where `mentions` matches a NAMESAKE in another system, not this
   * primitive. Exempt from the citation check only — the absence-claim scan
   * still covers them, because a false claim is a false claim wherever it sits.
   */
  readonly namesakePaths?: RegExp;
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
    mentions: /\brelevance_groups\b/,
  },
  {
    primitive: 'create_lookup_table',
    declaredAt: "Nova MCP tools/list at https://mcp.commcare.app/mcp (110 tools)",
    upstreamRef: 'voidcraft-labs/commcare-nova#545',
    shipped: '2026-09-01 create atom; 2026-09-06 the BIND (commcare-nova#545 closed COMPLETED 2026-09-02)',
    absenceClaims: [
      /\bno\s+MCP\s+atom\s+that\s+creates\s+a\s+lookup\s+table/i,
      /\bno\s+lookup[-\s]table\s+create\s+atom/i,
      /Nova\s+ha[sd]\s+no\s+(MCP\s+)?atom[^.]{0,40}lookup\s+table/i,
      // The SECOND retired claim (ace#1886). Stage one of this adoption
      // (2026-09-01) correctly found the create atom live and the BINDING
      // inert, and wrote that inertness into five files. commcare-nova#545
      // closed COMPLETED 2026-09-02 and the bind was read back live on
      // 2026-09-06, so those sentences are now false in the same way the
      // "no create atom" ones were — and they are worse, because
      // `_app-component-library` used the block to rank INLINE options above
      // a real register, which is the ace#1621 invented-vocabulary defect.
      //
      // PRESENT TENSE ONLY, deliberately. The corrected files describe this
      // history at length ("the bind WAS refused until 2026-09-02"), and a
      // guard that cannot tell an assertion from a citation of one fires on
      // its own fix — the trap `skills/nova-capability-adoption § Step 5`
      // names. Tense is the discriminator: "is refused" asserts, "was
      // refused" recounts.
      /\bbinding\s+a\s+select[^.]{0,60}\bis\s+refused/i,
      /\bcannot\s+bind\s+a\s+select\s+to\s+it\b/i,
      /\bwhat\s+is\s+(?:still\s+)?not\s+autonomous\s+is\s+\*{0,2}binding/i,
      /\bthe\s+binding\s+half\s+is\s+inert\b/i,
      /\ba\s+lookup[-\s]backed\s+select\s+is\s+not\s+buildable\b/i,
    ],
    mustCite: /commcare-nova#545/i,
    mentions: /(?<![a-z_])create_lookup_table\b/,
    // The Connect Interviews docs use the bare name for CommCare **HQ**'s
    // lookup-table atom family (`commcare_create_lookup_table`), which is a
    // different system and predates Nova's. They owe no Nova citation.
    namesakePaths: /^docs\/connect-interviews\//,
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
        const mentions = trackedFiles().filter(
          (f) =>
            !entry.namesakePaths?.test(f) &&
            entry.mentions.test(readFileSync(path.join(repoRoot, f), 'utf-8')),
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
