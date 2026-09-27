/**
 * dimagi-internal/ace#2521 — a worker_review_url built with `owning_program_id`
 * renders "Workflow definition <id> not found under opportunity <n>" when a DDD
 * scene opens it cold. `owning_program_id` is a labs data-access hint, not one
 * of `labs.context.CONTEXT_PARAMS`, so it scopes nothing. Repro URLs are the
 * verbatim pair from spark-facilitator/20260926-1413.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import { checkWorkerReviewUrlScope } from '../../../skills/demo-data-setup-qa/checks';

// Observed URLs, captured from the run (see the fixture's _source).
const {
  broken_owning_program_id: BROKEN,
  working_program_id: WORKING,
  programme_par_url: PROGRAMME,
} = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/cascade/spark-facilitator-worker-review-urls.json'), 'utf8'),
) as Record<string, string>;

describe('checkWorkerReviewUrlScope (ace#2521)', () => {
  it('accepts a worker review URL carrying &program_id=', () => {
    const r = checkWorkerReviewUrlScope({ primary_par_url: PROGRAMME, worker_review_url: WORKING });
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('1 worker_review_url');
  });

  it('accepts every per-worker variant key', () => {
    const r = checkWorkerReviewUrlScope({ worker_review_url: WORKING, cbf_b03_worker_review_url: WORKING });
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('2 worker_review_url');
  });

  it('fails the owning_program_id form and names why', () => {
    const r = checkWorkerReviewUrlScope({ worker_review_url: BROKEN });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('MUST carry &program_id=');
    expect(r.detail).toContain('owning_program_id is a data hint');
  });

  it('fails a per-worker key with no scope at all', () => {
    const r = checkWorkerReviewUrlScope({
      cbf_a07_worker_review_url: WORKING.replace('&program_id=10085', ''),
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('cbf_a07_worker_review_url');
  });

  it('fails a URL that is not a run deep-link', () => {
    const r = checkWorkerReviewUrlScope({
      worker_review_url: WORKING.replace('/run/?run_id=6441&', '/?'),
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('not a run deep-link');
  });

  it('passes vacuously (and says so) when there is no worker review', () => {
    const r = checkWorkerReviewUrlScope({ primary_par_url: PROGRAMME });
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('0 worker_review_url');
  });
});
