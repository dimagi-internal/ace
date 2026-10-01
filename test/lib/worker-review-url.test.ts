/**
 * `lib/worker-review-url.ts` — the one builder for a Phase 7 worker-review link
 * (ace#2521, recurrence on spark-facilitator/20260926-1800).
 *
 * Fixtures are captured, not authored:
 *   - `cascade/spark-facilitator-20260926-1800-realized.json` — that run's
 *     `7-synthetic/realized.json`, verbatim (BOM stripped). All three
 *     `*worker_review_url`s carry `owning_program_id` and no `program_id`.
 *   - `build-memo/spark-facilitator-20260926-1800/run_state.yaml` — the same
 *     run's run_state (OCS embed key redacted), whose
 *     `products.synthetic.cascade` the builder reads.
 *   - `cascade/spark-facilitator-worker-review-urls.json` — the live-verified
 *     broken/working pair from 20260926-1413.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { buildWorkerReviewUrl, rescopeWorkerReviewUrl, workerReviewUrls } from '../../lib/worker-review-url';
import { checkWorkerReviewUrlScope } from '../../skills/demo-data-setup-qa/checks';

const FIX = join(__dirname, '../fixtures');
const REALIZED = JSON.parse(
  readFileSync(join(FIX, 'cascade/spark-facilitator-20260926-1800-realized.json'), 'utf8'),
) as Record<string, string>;
const PAIR = JSON.parse(
  readFileSync(join(FIX, 'cascade/spark-facilitator-worker-review-urls.json'), 'utf8'),
) as Record<string, string>;
const RUN_STATE = parseYaml(
  readFileSync(join(FIX, 'build-memo/spark-facilitator-20260926-1800/run_state.yaml'), 'utf8'),
) as any;
const CASCADE = RUN_STATE.phases['synthetic-data-and-workflows'].products.synthetic.cascade;

describe('the captured realized.json is the defect (ace#2521 recurrence)', () => {
  it('fails checkWorkerReviewUrlScope as written by the run', () => {
    const r = checkWorkerReviewUrlScope(REALIZED);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('owning_program_id is a data hint');
  });
});

describe('rescopeWorkerReviewUrl', () => {
  it('turns the live-verified broken URL into the live-verified working one, byte for byte', () => {
    expect(rescopeWorkerReviewUrl(PAIR.broken_owning_program_id)).toBe(PAIR.working_program_id);
  });

  it('repairs every *worker_review_url in the captured realized.json so the QA check passes', () => {
    const fixed: Record<string, string> = { ...REALIZED };
    for (const k of Object.keys(fixed)) {
      if (/(^|_)worker_review_url$/.test(k)) fixed[k] = rescopeWorkerReviewUrl(fixed[k]);
    }
    const r = checkWorkerReviewUrlScope(fixed);
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('3 worker_review_url');
    for (const k of ['worker_review_url', 'standout_worker_review_url', 'data_quality_worker_review_url']) {
      expect(fixed[k]).toContain('program_id=10082');
      expect(fixed[k]).not.toContain('owning_program_id');
    }
  });

  it('refuses a URL it cannot carry the worker over from', () => {
    expect(() => rescopeWorkerReviewUrl(REALIZED.primary_par_url)).toThrow(/flw/);
  });
});

describe('buildWorkerReviewUrl / workerReviewUrls from the run_state cascade', () => {
  it('builds the same three links § C7 needs, all passing the gate', () => {
    const urls = workerReviewUrls(CASCADE, [
      { keyPrefix: '', opportunityId: 10084, username: 'cbf_c11' },
      { keyPrefix: 'standout_worker', opportunityId: 10083, username: 'cbf_b03' },
      { keyPrefix: 'data_quality_worker', opportunityId: 10082, username: 'cbf_a07' },
    ]);
    expect(Object.keys(urls).sort()).toEqual(
      ['data_quality_worker_review_url', 'standout_worker_review_url', 'worker_review_url'],
    );
    expect(urls.worker_review_url).toBe(
      'https://labs.connect.dimagi.com/labs/workflow/6373/run/?run_id=6375&program_id=10082&flw=10084%3A%3Acbf_c11&source_run=6394',
    );
    // what the run wrote, rebuilt, is what the builder produces from run_state
    expect(urls.worker_review_url).toBe(rescopeWorkerReviewUrl(REALIZED.worker_review_url));
    expect(checkWorkerReviewUrlScope({ ...REALIZED, ...urls }).pass).toBe(true);
  });

  it('never emits owning_program_id and rejects a missing scope id', () => {
    const url = buildWorkerReviewUrl({
      reviewWorkflowId: CASCADE.worker_review.workflow_id,
      reviewRunId: CASCADE.worker_review.run_id,
      programId: CASCADE.program_id,
      opportunityId: 10082,
      username: 'cbf_a07',
    });
    expect(url).not.toContain('owning_program_id');
    expect(() =>
      buildWorkerReviewUrl({
        reviewWorkflowId: CASCADE.worker_review.workflow_id,
        reviewRunId: CASCADE.worker_review.run_id,
        programId: undefined as unknown as number,
        opportunityId: 10082,
        username: 'cbf_a07',
      }),
    ).toThrow(/programId/);
  });

  it('refuses a key prefix that would not be read as a worker review', () => {
    expect(() => workerReviewUrls(CASCADE, [{ keyPrefix: 'standout', opportunityId: 1, username: 'x' }])).toThrow();
  });
});

describe('every documented writer of a worker review URL goes through the builder', () => {
  const c7 = readFileSync(join(__dirname, '../../skills/demo-data-setup/SKILL.md'), 'utf8');
  it('demo-data-setup § C7 invokes scripts/worker-review-url.ts', () => {
    const start = c7.indexOf('**C7. Handoff.**');
    expect(start).toBeGreaterThan(0);
    expect(c7.slice(start, start + 6000)).toContain('scripts/worker-review-url.ts');
  });
});
