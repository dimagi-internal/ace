/**
 * Phase-3 Deliver L0 verification-loop integrity (ace#1489).
 *
 * `pdd-to-deliver-app` Step 4 is a chain of bounded-loop checks (4a, 4b, …)
 * that run at LEVEL 0 after the Nova build and before the success summary.
 * They are the only thing standing between a bad build and the next phase.
 *
 * The payability rule for `entity_id` lived in Step 3's Nova brief — architect
 * PROSE — and nothing in Step 4 re-checked that the key the architect actually
 * shipped honoured it. `resolveEntityIdGrain` existed, was tested, and was run
 * by the EVAL side, but the build never called it. So an identity-only key on
 * a form with a non-payable branch left Phase 3 clean and was caught a whole
 * Nova build later by `app-release-qa` Step 2.8's `no-entity-component`
 * BLOCKER, which hard-halts the phase.
 *
 * Note what a looser test would have MISSED: `resolveEntityIdGrain` was named
 * in `skills/_app-component-library.md`, so "is this helper mentioned anywhere
 * on the build surface?" was already true and would have passed. The gap was
 * specifically that it had no Step 4 block. That is what this file asserts.
 *
 * Also pins step-label uniqueness — the file shipped two blocks both labelled
 * `4h.`, which makes "re-run 4h" ambiguous in exactly the recovery path these
 * steps exist to drive.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_SKILL = path.join(REPO_ROOT, 'skills/pdd-to-deliver-app/SKILL.md');

const text = fs.readFileSync(BUILD_SKILL, 'utf8');

/** The `4x.` step blocks, in file order. */
function stepLabels(): string[] {
  return [...text.matchAll(/^(4[a-z])\.\s+\*\*/gm)].map((m) => m[1]);
}

/** Body of one `4x.` block, up to the next step label. */
function stepBody(label: string): string {
  const start = text.search(new RegExp(`^${label}\\.\\s+\\*\\*`, 'm'));
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const next = rest.search(/^(?:4[a-z]|\d+)\.\s+\*\*/m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('pdd-to-deliver-app Step 4 L0 verification loop', () => {
  it('has uniquely-labelled step blocks', () => {
    const labels = stepLabels();
    const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
    expect(
      dupes,
      `Duplicate Step-4 labels: ${dupes.join(', ')}. Two blocks sharing a label make ` +
        '"re-run 4h" ambiguous in the recovery path these steps drive.',
    ).toEqual([]);
    expect(labels.length).toBeGreaterThanOrEqual(9);
  });

  it('runs the payability discriminator through resolveEntityIdGrain (ace#1489)', () => {
    const owning = stepLabels().filter((l) => stepBody(l).includes('resolveEntityIdGrain'));
    expect(
      owning.length,
      'No Step-4 block invokes resolveEntityIdGrain. The payability rule is then ' +
        'architect prose only: an identity-only key on a form with a non-payable ' +
        'branch leaves Phase 3 clean and hard-halts at app-release-qa Step 2.8 one ' +
        'Nova build later (ace#1489). Being named in _app-component-library.md is ' +
        'NOT sufficient — that is the prose this check exists to backstop.',
    ).toBeGreaterThan(0);

    // The three outcomes the helper distinguishes must each be handled — an
    // `unresolvable` that falls through silently is the exact case it exists
    // to stop from passing quietly.
    const body = owning.map(stepBody).join('\n');
    for (const branch of ['deviates', 'unresolvable', 'discloseAs']) {
      expect(body, `Step 4 invokes resolveEntityIdGrain but never handles \`${branch}\``).toContain(
        branch,
      );
    }
  });

  it('imports the helper from lib/entity-id-precedence, not a restated rule', () => {
    const body = stepLabels().map(stepBody).join('\n');
    expect(body).toContain('lib/entity-id-precedence');
  });

  it('names the Phase-4 verification predicate residual when the key is payability-scoped', () => {
    // ace#1434: the scoped key stops a non-payable submission consuming the
    // payable slot, but mints `<identity> - no` as its own countable entity.
    // Without a Phase-4 predicate rejecting it the daily cap decides, and a
    // worker whose first follow-up was a refusal can still be blocked.
    const body = stepLabels().map(stepBody).join('\n');
    expect(body.toLowerCase()).toMatch(/residual/);
    expect(body).toMatch(/1434/);
  });
});
