/**
 * Phase 6 must refresh the OCS knowledge base after writing the training docs.
 *
 * ## The defect this guards
 *
 * `lib/artifact-manifest.ts` declares `ocs-agent-setup` a consumer of four
 * documents Phase 6 produces — the LLO guide, the FLW guide, the FAQ, and the
 * quick-reference card. `ocs-agent-setup` runs in Phase 5. Phase 5 runs before
 * Phase 6. So on a fresh `/ace:run`, the chatbot's RAG collection is indexed
 * before those four files exist.
 *
 * That backward edge was noticed on 2026-05-15 and resolved by making the reads
 * *tolerant of missing files* — which fixed the crash and left the actual
 * problem: nothing re-indexed once Phase 6 wrote them. Until 0.13.1021, **every
 * opportunity's chatbot shipped without the training material its users ask
 * about** — the bot an LLO supervisor talks to, missing exactly the four
 * documents their questions are about.
 *
 * It survived because every check was green. The tolerant read passes. The
 * collection indexes cleanly. The Phase 5 `--quick` gate asks three *universal*
 * Connect questions (claim opp, sync data, get paid) that need none of those
 * documents to answer. Nothing in any artifact ACE writes says the collection is
 * short four files.
 *
 * ## Why the guard is here and not in the frontmatter
 *
 * The natural place to record "Phase 6 runs this" is `qa-and-training.md`'s
 * `skills:` list — but that list declares which producers a phase OWNS, and
 * `ocs-agent-setup` is owned by Phase 5. Listing it in both makes it owned
 * twice, which `test/agents/coherence.test.ts` rejects, correctly. Phase 6
 * invokes it; it does not produce it. So the invocation is asserted directly.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

/** The Workflow section only — never the frontmatter notes or the History table. */
function workflow(doc: string): string {
  const start = doc.indexOf('## Workflow');
  const end = doc.indexOf('## Verdict-gate rule');
  if (start < 0 || end < 0 || end <= start) return '';
  return doc.slice(start, end);
}

describe('OCS knowledge base is refreshed after Phase 6 writes the training docs', () => {
  const phase6 = readFileSync(join(ROOT, 'agents/qa-and-training.md'), 'utf8');
  const ocsSkill = readFileSync(join(ROOT, 'skills/ocs-agent-setup/SKILL.md'), 'utf8');

  it('Phase 6 invokes ocs-agent-setup --reindex', () => {
    // Scoped to Workflow: the frontmatter carries a NOTE mentioning
    // `ocs-agent-setup --reindex` (explaining why it is not in `skills:`), and an
    // unscoped match is satisfied by that comment alone. Deleting the real
    // invocation then left this assertion green — found by negative-testing it.
    expect(
      /ocs-agent-setup\s+--reindex/.test(workflow(phase6)),
      'agents/qa-and-training.md must invoke `ocs-agent-setup --reindex`. Without it the\n' +
        "per-opp chatbot's RAG collection never sees the four training documents this\n" +
        'phase produces, and the failure is silent — see this file’s header.',
    ).toBe(true);
  });

  it('runs it as the last step, after the training docs exist', () => {
    // Re-indexing before the docs are written is the bug, not the fix.
    //
    // Scoped to the Workflow section on purpose: an unscoped search finds the
    // frontmatter note explaining why this skill is not in the `skills:` list,
    // which sits at the top of the file and would make the ordering assertion
    // pass or fail for reasons unrelated to the actual step order. (Caught by
    // this test failing on its own first run — `expected 1233 to be > 37216`.)
    const wf = workflow(phase6);
    expect(wf.length, 'Workflow section not found — did the headings move?').toBeGreaterThan(500);

    const reindexAt = wf.search(/ocs-agent-setup\s+--reindex/);
    expect(reindexAt, '--reindex must be invoked inside the Workflow section').toBeGreaterThan(-1);
    const lastDoc = Math.max(
      wf.lastIndexOf('training-onboarding-email'),
      wf.lastIndexOf('training-quick-reference'),
      wf.lastIndexOf('training-faq'),
    );
    expect(
      reindexAt,
      'the --reindex invocation must come after the training-doc producers in the workflow',
    ).toBeGreaterThan(lastDoc);
  });

  it('ocs-agent-setup implements the --reindex mode', () => {
    expect(/`--reindex`/.test(ocsSkill), 'skills/ocs-agent-setup must document --reindex').toBe(
      true,
    );
    expect(
      /--reindex.*flag set/s.test(ocsSkill),
      'Step 0 must branch on the --reindex flag, or the mode is documentation only',
    ).toBe(true);
  });

  it('still declares the training docs as RAG inputs', () => {
    // If this stops being true the reindex is pointless; fail loudly rather than
    // leave a step that re-uploads a set no longer containing the guides.
    expect(/6-qa-and-training/.test(ocsSkill)).toBe(true);
  });
});
