/**
 * Pre-run claims / post-run validation — the pure core.
 *
 * Source-of-truth contract:
 *   - `docs/superpowers/specs/2026-09-15-pre-run-claims-post-run-validation-design.md`
 *
 * A CLAIM is a falsifiable statement about what the NEXT run's output must
 * look like, authored because a named person decided something between runs.
 *
 * It is deliberately none of the things ACE already has:
 *   - not a DECISION (`decisions.yaml`) — ACE weighed nothing, and writing
 *     it there would fabricate a deliberation that never happened
 *   - not FEEDBACK ROUTING (`feedback-ledger`) — that answers "did their
 *     input reach us"; this answers "did the work implied by it happen"
 *   - not ARTIFACT PRESENCE (`verify_phase_artifacts`) — a file can be
 *     present, well-shaped, and identical to last run's
 *
 * This module is intentionally PURE — no Drive, no I/O, no YAML parsing —
 * the same posture as `lib/run-state-validator.ts`, so the phase boundary
 * fence can call it on already-read state and tests need no fixtures.
 */

import { z } from 'zod';

export const CLAIMS_SCHEMA_VERSION = 1;

/** What happened. Orthogonal to HOW we know (see `EvidenceKind`). */
export type ClaimVerdict = 'MET' | 'UNMET' | 'NOT REACHED' | 'INDETERMINATE';
/** How we know. A `probe`-kind check may never record `judged`. */
export type EvidenceKind = 'probed' | 'judged';
export type CheckKind = 'probe' | 'judged';
export type AuthoredBy = 'ace' | 'counterpart';

const VERDICTS = ['MET', 'UNMET', 'NOT REACHED', 'INDETERMINATE'] as const;

const OriginSchema = z.object({
  kind: z.string().min(1),
  person: z.string().min(1),
  thread_id: z.string().optional(),
  message_id: z.string().optional(),
  quote: z.string().optional(),
});

const ClaimSchema = z.object({
  id: z.string().min(1),
  claim: z.string().min(1),
  artifact: z.string().min(1),
  checkable_at: z.string().min(1),
  origin: OriginSchema,
  authored_by: z.enum(['ace', 'counterpart']),
  decision_ref: z.string().optional(),
  check: z.object({
    kind: z.enum(['probe', 'judged']),
    how: z.string().min(1),
  }),
  // Written back by the fence as the run proceeds.
  verdict: z.enum(VERDICTS).optional(),
  evidence_kind: z.enum(['probed', 'judged']).optional(),
  evidence: z.string().optional(),
  would_settle_it: z.string().optional(),
  checked_at: z.string().optional(),
  checked_in_phase: z.string().optional(),
});

const ClaimSetSchema = z.object({
  schema_version: z.number(),
  kind: z.literal('run-claims'),
  opp: z.string().min(1),
  frozen_at: z.string().optional(),
  source_run_id: z.string().optional(),
  claims: z.array(ClaimSchema),
});

export type ClaimOrigin = z.infer<typeof OriginSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type ClaimSet = z.infer<typeof ClaimSetSchema>;

export interface ParseResult {
  ok: boolean;
  claimSet: ClaimSet | null;
  issues: string[];
}

export function parseClaimSet(raw: unknown): ParseResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, claimSet: null, issues: ['claim set is not an object'] };
  }
  const parsed = ClaimSetSchema.safeParse(raw);
  if (!parsed.success) {
    const claims = (raw as { claims?: unknown }).claims;
    const issues = parsed.error.issues.map((i) => {
      const path = i.path.join('.');
      // Name the claim ID rather than its array index — an index is
      // meaningless to whoever reads this in the fence output.
      const m = /^claims\.(\d+)/.exec(path);
      if (m && Array.isArray(claims)) {
        const c = claims[Number(m[1])] as { id?: unknown } | undefined;
        const id = typeof c?.id === 'string' && c.id ? c.id : `#${m[1]}`;
        return `claim ${id}: ${path.replace(/^claims\.\d+\.?/, '') || 'shape'} — ${i.message}`;
      }
      return `${path || 'root'} — ${i.message}`;
    });
    return { ok: false, claimSet: null, issues };
  }
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const c of parsed.data.claims) {
    if (seen.has(c.id)) dups.push(c.id);
    seen.add(c.id);
  }
  if (dups.length > 0) {
    return {
      ok: false,
      claimSet: null,
      issues: [`duplicate claim id(s): ${[...new Set(dups)].join(', ')}`],
    };
  }
  return { ok: true, claimSet: parsed.data, issues: [] };
}

/**
 * Fields the fence legitimately writes after freezing.
 * Everything else in a claim IS the exam, and cannot move.
 */
const VERDICT_FIELDS = new Set([
  'verdict',
  'evidence_kind',
  'evidence',
  'would_settle_it',
  'checked_at',
  'checked_in_phase',
]);

export function freezeClaimSet(
  set: ClaimSet,
  opts: { runId: string; now: string },
): { ok: boolean; claimSet: ClaimSet | null; issues: string[] } {
  if (set.frozen_at) {
    return {
      ok: false,
      claimSet: null,
      issues: [
        `claim set is already frozen at ${set.frozen_at} — a claim authored later belongs to the NEXT run`,
      ],
    };
  }
  if (set.claims.length === 0) {
    return { ok: false, claimSet: null, issues: ['refusing to freeze an empty claim set'] };
  }
  return {
    ok: true,
    claimSet: { ...set, frozen_at: opts.now, source_run_id: opts.runId },
    issues: [],
  };
}

/**
 * Illegal mutations of a frozen set. Empty array = legal.
 *
 * Verdict fields are EXPECTED to change — the fence writes them as the run
 * proceeds. The claim itself must not, or the exam gets rewritten once the
 * results start arriving, which is exactly how a bar gets quietly lowered.
 */
export function diffFrozenClaims(frozen: ClaimSet, incoming: ClaimSet): string[] {
  const issues: string[] = [];
  const byId = new Map(frozen.claims.map((c) => [c.id, c]));
  const incomingIds = new Set(incoming.claims.map((c) => c.id));

  for (const c of incoming.claims) {
    if (!byId.has(c.id)) issues.push(`claim ${c.id} was ADDED after the set was frozen`);
  }
  for (const c of frozen.claims) {
    if (!incomingIds.has(c.id)) issues.push(`claim ${c.id} was REMOVED after the set was frozen`);
  }
  for (const c of incoming.claims) {
    const before = byId.get(c.id);
    if (!before) continue;
    for (const key of Object.keys({ ...before, ...c })) {
      if (VERDICT_FIELDS.has(key)) continue;
      const a = JSON.stringify((before as Record<string, unknown>)[key]);
      const b = JSON.stringify((c as Record<string, unknown>)[key]);
      if (a !== b) issues.push(`claim ${c.id}: \`${key}\` was reworded after the set was frozen`);
    }
  }
  return issues;
}
