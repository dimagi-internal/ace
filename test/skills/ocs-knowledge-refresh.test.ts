/**
 * Phase 6 must populate the OCS knowledge base after writing the training docs.
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
 * ## The fix, and why the shape changed twice
 *
 * First pass (0.13.1022) added `ocs-agent-setup --reindex`, invoked by Phase 6 —
 * a corrective second pass over a step Phase 5 owned. That worked, but left the
 * cycle in the graph and left Phase 5 still reading `6-qa-and-training/*`
 * tolerantly, which is the pattern that caused the defect.
 *
 * Second pass (0.13.1028) split `ocs-agent-setup` at its real dependency seam
 * instead. Creating and publishing the bot needs Phase 1/3/4; populating its
 * knowledge base needs Phase 6. Those are two jobs, and bundling them is what
 * made the ordering unsatisfiable. Now Phase 5 consumes nothing from Phase 6 —
 * the failure is not expressible there — and Phase 6 OWNS `ocs-knowledge-refresh`,
 * so it claims it in frontmatter like any other producer.
 *
 * The general lesson, recorded because it generalises: when a cycle exists only
 * because one node bundles two jobs with different inputs, prefer splitting the
 * node over cutting the loop. Cutting leaves a corrective pass; splitting leaves
 * a plain DAG.
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

/** `ocs-knowledge-refresh`'s Step 0 only — the preconditions + re-run branch. */
function step0(doc: string): string {
  const start = doc.indexOf('### Step 0:');
  const end = doc.indexOf('### Step 1:');
  if (start < 0 || end < 0 || end <= start) return '';
  return doc.slice(start, end);
}

describe('OCS knowledge base is refreshed after Phase 6 writes the training docs', () => {
  const phase6 = readFileSync(join(ROOT, 'agents/qa-and-training.md'), 'utf8');
  const refresh  = readFileSync(join(ROOT, 'skills/ocs-knowledge-refresh/SKILL.md'), 'utf8');
  const phase5   = readFileSync(join(ROOT, 'skills/ocs-agent-setup/SKILL.md'), 'utf8');

  it('Phase 6 invokes ocs-knowledge-refresh', () => {
    // Scoped to Workflow. When this was written the frontmatter carried a NOTE
    // mentioning `ocs-agent-setup --reindex`, and an unscoped match was satisfied
    // by that comment alone — deleting the real invocation left the assertion
    // green, found by negative-testing it. 0.13.1028 put the skill in `skills:`
    // and dropped the note, so the frontmatter now names it legitimately: the
    // scoping is still what makes this assertion mean "invoked", not "mentioned".
    expect(
      /ocs-knowledge-refresh/.test(workflow(phase6)),
      'agents/qa-and-training.md must invoke `ocs-knowledge-refresh`. Without it the\n' +
        "per-opp chatbot's RAG collection never sees the four training documents this\n" +
        'phase produces, and the failure is silent — see this file’s header.',
    ).toBe(true);
  });

  it('runs it as the last step, after the training docs exist', () => {
    // Re-indexing before the docs are written is the bug, not the fix.
    //
    // Scoped to the Workflow section on purpose: an unscoped search finds the
    // `skills:` frontmatter row at the top of the file, which would make the
    // ordering assertion pass or fail for reasons unrelated to the actual step
    // order. (Caught by this test failing on its own first run — `expected 1233
    // to be > 37216`.)
    const wf = workflow(phase6);
    expect(wf.length, 'Workflow section not found — did the headings move?').toBeGreaterThan(500);

    const reindexAt = wf.search(/ocs-knowledge-refresh/);
    expect(reindexAt, 'ocs-knowledge-refresh must be invoked inside the Workflow section').toBeGreaterThan(-1);
    const lastDoc = Math.max(
      wf.lastIndexOf('training-onboarding-email'),
      wf.lastIndexOf('training-quick-reference'),
      wf.lastIndexOf('training-faq'),
    );
    expect(
      reindexAt,
      'the refresh must come after the training-doc producers in the workflow',
    ).toBeGreaterThan(lastDoc);
  });

  it('ocs-knowledge-refresh names the training docs as its RAG inputs', () => {
    for (const doc of ['training-llo-guide', 'training-flw-guide', 'training-faq',
                       'training-quick-reference']) {
      expect(refresh.includes(doc), `ocs-knowledge-refresh must consume ${doc}`).toBe(true);
    }
    expect(
      /ocs_upload_collection_files/.test(refresh) && /ocs_wait_for_collection_indexing/.test(refresh),
      'the refresh must actually upload and wait for indexing, not just describe it',
    ).toBe(true);
  });

  it('Phase 5 no longer reads Phase 6 artifacts', () => {
    // The split is the fix. If Phase 5 starts consuming 6-qa-and-training again,
    // the cycle is back and so is the tolerant read that hid the defect.
    // The History table is exempt — it records that this used to be true.
    const body = phase5.slice(0, phase5.indexOf('| 2026-'));
    const offenders = body
      .split('\n')
      .map((l, i) => [l, i + 1] as const)
      .filter(([l]) => /runs\/<run-id>\/6-qa-and-training|6-qa-and-training\/\*/.test(l))
      .filter(([l]) => !/does \*\*not\*\*|used to|no longer|before Phase 6 has run/.test(l));
    expect(
      offenders.map(([l, n]) => `  ocs-agent-setup:${n}  ${l.trim().slice(0, 100)}`),
      'Phase 5 must not consume Phase 6 artifacts — that is the cycle this split removed.',
    ).toEqual([]);
  });

  it('short-circuits on a re-run instead of appending duplicates', () => {
    // ocs_upload_collection_files APPENDS. Phase 6 is retried, /ace:step is a
    // supported manual entry, /ace:iterate targets 3+4+6, and a fork replays the
    // tail — so "runs twice" is the normal case, not the edge case. Without a
    // short-circuit the second pass leaves two copies of every training document
    // in the index and spends the 5-10 minute wait again.
    expect(
      /last_reindexed_at/.test(step0(refresh)),
      'Step 0 must read `last_reindexed_at` BEFORE uploading — it is the only\n' +
        'record of whether this collection already has the documents.',
    ).toBe(true);
    expect(
      /append/i.test(refresh),
      'the skill must say that upload APPENDS — that is the whole reason a re-run\n' +
        'is not free, and the reason the branch below exists',
    ).toBe(true);
    // Three outcomes, not two: absent, current, and stale-because-a-doc-moved.
    // Collapsing the third into "already done" is how a corrected training doc
    // never reaches the bot.
    for (const branch of ['already-current', 'NEWER']) {
      expect(
        refresh.includes(branch),
        `Step 0 must handle the '${branch}' case: a document edited after the last\n` +
          'refresh means the collection is stale, and appending on top of the old\n' +
          'copies is worse than not refreshing at all.',
      ).toBe(true);
    }
  });
});
