/**
 * The ONE builder for a Phase 7 worker-review deep link (dimagi-internal/ace#2521).
 *
 * A worker review is a PROGRAM-owned labs workflow. Opened cold — a DDD scene
 * `url:`, a link in a summary — it needs `program_id` on the URL, because
 * that is one of labs' page-scope params (`labs.context.CONTEXT_PARAMS`:
 * `organization_id`, `program_id`, `opportunity_id`). The programme report's
 * own "Review →" links carry `owning_program_id` instead, which is only a
 * data-access hint: with no scope param, labs appends the session's last
 * `opportunity_id` and renders "Workflow definition <id> not found under
 * opportunity <n>".
 *
 * Twice now the URL was hand-assembled by copying those "Review →" links:
 * spark-facilitator/20260926-1413 (ace#2521, which added the QA check) and
 * then spark-facilitator/20260926-1800, whose `7-synthetic/realized.json`
 * carried THREE `*worker_review_url`s with `owning_program_id` and no
 * `program_id` — after § C7's prose already said not to. Prose did not hold,
 * so the URL now has exactly one constructor, and § C7 calls it
 * (`scripts/worker-review-url.ts`). `checkWorkerReviewUrlScope`
 * (`skills/demo-data-setup-qa/checks.ts`) remains the gate on the output.
 *
 * Pure.
 */

export const LABS_BASE_URL = 'https://labs.connect.dimagi.com';

export interface WorkerReviewUrlInput {
  /** The companion worker-review workflow definition id. */
  reviewWorkflowId: number;
  /** The worker-review run id (`cascade.worker_review.run_id`). */
  reviewRunId: number;
  /** The cascade's program id — the page-scope param. */
  programId: number;
  /** The worker's opportunity (the partner opp the worker delivers on). */
  opportunityId: number;
  /** The worker's username, e.g. `cbf_a07`. */
  username: string;
  /** The programme-report run the review drills down from (latest saved run). */
  sourceRunId?: number;
  /** Labs origin; defaults to production labs. */
  baseUrl?: string;
}

function positiveInt(name: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new Error(`buildWorkerReviewUrl: ${name} must be a positive integer, got ${JSON.stringify(v)}`);
  }
  return v;
}

/**
 * `/labs/workflow/<review>/run/?run_id=<run>&program_id=<program>&flw=<opp>::<user>&source_run=<latest>`
 *
 * Never emits `owning_program_id`.
 */
export function buildWorkerReviewUrl(input: WorkerReviewUrlInput): string {
  const review = positiveInt('reviewWorkflowId', input.reviewWorkflowId);
  const run = positiveInt('reviewRunId', input.reviewRunId);
  const program = positiveInt('programId', input.programId);
  const opp = positiveInt('opportunityId', input.opportunityId);
  const user = (input.username ?? '').trim();
  if (!user) throw new Error('buildWorkerReviewUrl: username is required');
  const base = (input.baseUrl ?? LABS_BASE_URL).replace(/\/+$/, '');
  const q = new URLSearchParams();
  q.set('run_id', String(run));
  q.set('program_id', String(program));
  q.set('flw', `${opp}::${user}`);
  if (input.sourceRunId !== undefined) q.set('source_run', String(positiveInt('sourceRunId', input.sourceRunId)));
  return `${base}/labs/workflow/${review}/run/?${q.toString()}`;
}

/**
 * Rebuild an existing worker-review URL through `buildWorkerReviewUrl` — the
 * repair path for a `realized.json` already written with `owning_program_id`.
 * `program_id` is taken from the URL's `program_id`, else its
 * `owning_program_id`, else `programId`. Throws when the URL is not a
 * worker-review run deep link with a `flw=<opp>::<user>` it can carry over.
 */
export function rescopeWorkerReviewUrl(raw: string, programId?: number): string {
  const url = new URL(raw);
  const m = /^\/labs\/workflow\/(\d+)\/run\/$/.exec(url.pathname);
  if (!m) throw new Error(`rescopeWorkerReviewUrl: not a workflow run link: ${raw}`);
  const p = url.searchParams;
  const flw = /^(\d+)::(.+)$/.exec(p.get('flw') ?? '');
  if (!flw) throw new Error(`rescopeWorkerReviewUrl: no flw=<opp>::<user> on ${raw}`);
  const program = Number(p.get('program_id') ?? p.get('owning_program_id') ?? programId);
  const source = p.get('source_run');
  return buildWorkerReviewUrl({
    reviewWorkflowId: Number(m[1]),
    reviewRunId: Number(p.get('run_id')),
    programId: program,
    opportunityId: Number(flw[1]),
    username: flw[2],
    sourceRunId: source ? Number(source) : undefined,
    baseUrl: url.origin,
  });
}

/** A worker carrier for § C7: the realized.json key prefix and who it is. */
export interface WorkerCarrier {
  /** `''` for the plain `worker_review_url`, else e.g. `standout_worker`. */
  keyPrefix: string;
  opportunityId: number;
  username: string;
}

/**
 * Every `*worker_review_url` entry for realized.json, from the cascade block
 * § C7 writes to run_state (`products.synthetic.cascade`).
 */
export function workerReviewUrls(
  cascade: {
    program_id: number;
    worker_review: { workflow_id: number; run_id?: number };
    programme_report?: { run_id?: number };
  },
  carriers: readonly WorkerCarrier[],
  baseUrl?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of carriers) {
    const key = c.keyPrefix ? `${c.keyPrefix}_review_url` : 'worker_review_url';
    if (!/(^|_)worker_review_url$/.test(key)) {
      throw new Error(`workerReviewUrls: key prefix ${JSON.stringify(c.keyPrefix)} must end in "worker" (got ${key})`);
    }
    out[key] = buildWorkerReviewUrl({
      reviewWorkflowId: cascade.worker_review.workflow_id,
      reviewRunId: cascade.worker_review.run_id as number,
      programId: cascade.program_id,
      opportunityId: c.opportunityId,
      username: c.username,
      sourceRunId: cascade.programme_report?.run_id,
      baseUrl,
    });
  }
  return out;
}
