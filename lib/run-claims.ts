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

export interface VerdictInput {
  verdict: ClaimVerdict;
  evidence_kind?: EvidenceKind;
  evidence: string;
  would_settle_it?: string;
  phase: string;
  now: string;
}

/**
 * Record one claim's verdict. Every rule that keeps the vocabulary honest
 * lives here rather than in the caller, because the caller is a prompt.
 */
export function recordVerdict(
  set: ClaimSet,
  claimId: string,
  v: VerdictInput,
): { ok: boolean; claimSet: ClaimSet | null; issues: string[] } {
  const idx = set.claims.findIndex((c) => c.id === claimId);
  if (idx === -1) {
    return { ok: false, claimSet: null, issues: [`no claim with id \`${claimId}\` in this set`] };
  }
  const claim = set.claims[idx];
  const issues: string[] = [];

  if (!v.evidence || v.evidence.trim() === '') {
    issues.push(`claim ${claimId}: every verdict needs evidence naming what was observed`);
  }
  // A probe that quietly becomes an opinion is the failure this vocabulary
  // exists to prevent. If the probe could not run, that is NOT REACHED.
  if (claim.check.kind === 'probe' && v.evidence_kind === 'judged') {
    issues.push(
      `claim ${claimId}: declares a probe check, so it cannot be recorded as \`judged\` — ` +
        `if the probe could not run, record NOT REACHED with the reason`,
    );
  }
  if (v.verdict === 'INDETERMINATE' && (!v.would_settle_it || v.would_settle_it.trim() === '')) {
    issues.push(
      `claim ${claimId}: INDETERMINATE must name \`would_settle_it\` — otherwise it is where a ` +
        `claim goes to avoid failing`,
    );
  }
  if (issues.length > 0) return { ok: false, claimSet: null, issues };

  const resolvedKind: EvidenceKind =
    v.evidence_kind ?? (claim.check.kind === 'probe' ? 'probed' : 'judged');

  const claims = [...set.claims];
  claims[idx] = {
    ...claim,
    verdict: v.verdict,
    evidence_kind: resolvedKind,
    evidence: v.evidence,
    ...(v.would_settle_it ? { would_settle_it: v.would_settle_it } : {}),
    checked_at: v.now,
    checked_in_phase: v.phase,
  };
  return { ok: true, claimSet: { ...set, claims }, issues: [] };
}

/** Claims due at this phase that do not yet have a verdict. */
export function claimsDueAt(set: ClaimSet, phase: string): Claim[] {
  return set.claims.filter((c) => c.checkable_at === phase && !c.verdict);
}

/**
 * Closeout: a claim nobody answered is a claim nobody answered.
 *
 * Rendering that as MET, or omitting it, is the exact silence this whole
 * mechanism exists to kill — so it becomes NOT REACHED, which accuses.
 */
export function sweepUnreached(set: ClaimSet, now: string): ClaimSet {
  return {
    ...set,
    claims: set.claims.map((c) =>
      c.verdict
        ? c
        : {
            ...c,
            verdict: 'NOT REACHED' as const,
            evidence_kind: (c.check.kind === 'probe' ? 'probed' : 'judged') as EvidenceKind,
            evidence: `the \`${c.checkable_at}\` checkpoint never ran in this run`,
            checked_at: now,
          },
    ),
  };
}

export interface ClaimSummary {
  total: number;
  met: number;
  unmet: number;
  not_reached: number;
  indeterminate: number;
  /** Claims with no verdict yet — a mid-run state, not a closeout one. */
  unanswered: number;
  all_met: boolean;
  summary: string;
}

export function summarizeClaims(set: ClaimSet): ClaimSummary {
  const count = (v: ClaimVerdict) => set.claims.filter((c) => c.verdict === v).length;
  const met = count('MET');
  const unmet = count('UNMET');
  const notReached = count('NOT REACHED');
  const indeterminate = count('INDETERMINATE');
  const unanswered = set.claims.filter((c) => !c.verdict).length;
  const total = set.claims.length;

  // `all_met` requires that NOTHING is outstanding. A run where every
  // ANSWERED claim passed but a checkpoint never ran has not met its
  // claims — reporting otherwise recreates the silence we are removing.
  const allMet = total > 0 && met === total;

  const parts: string[] = [`${met}/${total} met`];
  if (unmet > 0) parts.push(`${unmet} not met`);
  if (notReached > 0) parts.push(`${notReached} never reached`);
  if (indeterminate > 0) parts.push(`${indeterminate} indeterminate`);
  if (unanswered > 0) parts.push(`${unanswered} still open`);

  return {
    total,
    met,
    unmet,
    not_reached: notReached,
    indeterminate,
    unanswered,
    all_met: allMet,
    summary: parts.join(', '),
  };
}

export interface DueClaim {
  id: string;
  claim: string;
  artifact: string;
  check: { kind: CheckKind; how: string };
  authored_by: AuthoredBy;
  person: string;
  quote?: string;
}

export interface RunClaimsReport {
  phase: string;
  ok: boolean;
  issues: string[];
  due: DueClaim[];
  met: number;
  unmet: number;
  not_reached: number;
  indeterminate: number;
  all_met: boolean;
  summary: string;
}

/**
 * The whole body of the `verify_run_claims` atom.
 *
 * Lives here rather than inline in `mcp/google-drive-server.ts` because the
 * server files `await server.connect(transport)` at top level and therefore
 * cannot be imported by a test — logic left in the atom is logic only a
 * mirrored copy in a test can "cover", which passes whether or not the atom
 * works.
 *
 * `raw` is the already-parsed claims.yaml (or `null` when the file is
 * absent). An ABSENT file is `ok` with nothing due — most opportunities
 * have no claims and that is not a defect. An UNREADABLE one is `ok: false`
 * and reported; it never throws and never halts the run.
 */
export function classifyRunClaims(raw: unknown, phase: string): RunClaimsReport {
  const empty = {
    phase,
    due: [] as DueClaim[],
    met: 0,
    unmet: 0,
    not_reached: 0,
    indeterminate: 0,
    all_met: false,
  };
  if (raw === null || raw === undefined) {
    return { ...empty, ok: true, issues: [], summary: 'no claims recorded for this run' };
  }
  const parsed = parseClaimSet(raw);
  if (!parsed.ok || !parsed.claimSet) {
    return {
      ...empty,
      ok: false,
      issues: parsed.issues,
      summary: 'claims file unreadable — reported, not halted',
    };
  }
  const sum = summarizeClaims(parsed.claimSet);
  return {
    phase,
    ok: true,
    issues: [],
    due: claimsDueAt(parsed.claimSet, phase).map((c) => ({
      id: c.id,
      claim: c.claim,
      artifact: c.artifact,
      check: c.check,
      authored_by: c.authored_by,
      person: c.origin.person,
      ...(c.origin.quote ? { quote: c.origin.quote } : {}),
    })),
    met: sum.met,
    unmet: sum.unmet,
    not_reached: sum.not_reached,
    indeterminate: sum.indeterminate,
    all_met: sum.all_met,
    summary: sum.summary,
  };
}
