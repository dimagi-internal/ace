# Pre-run Claims / Post-run Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a counterpart decides something between runs, record what must be DIFFERENT in the next run's built artifacts, and report after the run whether each difference actually materialised.

**Architecture:** One new fact store (`claims.yaml`, opp-level while pending, frozen per-run at kickoff), one pure helper module (`lib/run-claims.ts`) holding the schema and every verdict rule, one report-only MCP atom (`verify_run_claims`) added as a fifth check in the existing phase boundary fence, and one reviewer-facing section derived from the frozen file. No new judge and no new gate: each claim declares `checkable_at` and is evaluated by the checkpoint that already runs at that phase.

**Tech Stack:** TypeScript (ESM, `npx tsx`, no build step), `zod` for schema, `yaml` for parsing, `vitest` for tests, MCP server `mcp/google-drive-server.ts`.

**Spec:** `docs/superpowers/specs/2026-09-15-pre-run-claims-post-run-validation-design.md`

## Global Constraints

- **Report-only. Never gates.** The Turn N+2 branch condition in `agents/ace-orchestrator.md § Phase boundary fence` is UNCHANGED. A `verify_run_claims` result containing UNMET entries does not halt the run.
- **Verdict vocabulary is exactly four values:** `MET` | `UNMET` | `NOT REACHED` | `INDETERMINATE`. Written as those exact strings, including the space in `NOT REACHED`.
- **`evidence_kind` is orthogonal to verdict:** `probed` | `judged`.
- **A `probe`-kind check may never record `evidence_kind: judged`.** If the probe could not run, the verdict is `NOT REACHED` with the reason in `evidence`.
- **`INDETERMINATE` requires a non-empty `would_settle_it`.**
- **One claim names exactly one artifact and one checkable property.** A decision with three consequences produces three claims.
- **A frozen claim set is immutable.** No claim may be added, removed, or reworded once `frozen_at` is set.
- **`lib/run-claims.ts` is PURE** — no Drive access, no I/O, no YAML parsing. Callers parse and hand it a JS object, matching `lib/run-state-validator.ts`.
- **Never paraphrase an atom schema inline in a skill** — grep `docs/atom-schemas.md` (CLAUDE.md § Conventions). Regenerate it via `npx tsx scripts/dump-atom-schemas.ts` when the atom lands.
- Run `npx tsc --noEmit` before every push — CI's `clean-install` type-checks and `vitest` does not.

## File Structure

| File | Responsibility |
|---|---|
| `lib/run-claims.ts` (create) | Schema, parse, freeze, verdict recording + every verdict rule, due-at filter, closeout sweep, summary. Pure. |
| `test/lib/run-claims.test.ts` (create) | Unit coverage for all of the above, including the regression control. |
| `mcp/google-drive-server.ts` (modify) | Register `verify_run_claims`; reads `claims.yaml` from Drive, delegates to the pure module, writes verdicts back. |
| `test/mcp/gdrive/verify-run-claims.test.ts` (create) | Atom-level coverage over a fixture claims file. |
| `agents/ace-orchestrator.md` (modify) | Fence gains a fifth, report-only check; kickoff gains the freeze step; closeout gains the sweep. |
| `skills/inbox-triage/SKILL.md` (modify) | Authoring step: a counterpart decision becomes claims in `pending-claims.yaml`. |
| `skills/opp-eval/SKILL.md` (modify) | Aggregate the frozen claim set into the run-level scorecard. |
| `docs/atom-schemas.md` (regenerate) | Generated catalogue; staleness is CI-gated. |

---

### Task 1: The claim schema and parser

**Files:**
- Create: `lib/run-claims.ts`
- Test: `test/lib/run-claims.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `CLAIMS_SCHEMA_VERSION`, types `ClaimVerdict`, `EvidenceKind`, `CheckKind`, `AuthoredBy`, `ClaimOrigin`, `Claim`, `ClaimSet`; function `parseClaimSet(raw: unknown): ParseResult` where `ParseResult = { ok: boolean; claimSet: ClaimSet | null; issues: string[] }`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/lib/run-claims.test.ts
import { describe, it, expect } from 'vitest';
import { parseClaimSet } from '../../lib/run-claims.js';

const VALID = {
  schema_version: 1,
  kind: 'run-claims',
  opp: 'poverty-graduation',
  claims: [
    {
      id: 'cs-deliver-unpaid',
      claim: "The Deliver app's consumption-support distribution visit carries no payment marker.",
      artifact: 'deliver-app',
      checkable_at: 'commcare-setup',
      origin: { kind: 'counterpart-decision', person: 'Sophie Feintuch' },
      authored_by: 'ace',
      check: { kind: 'probe', how: 'Parse the released Deliver CCZ.' },
    },
  ],
};

describe('parseClaimSet', () => {
  it('accepts a well-formed pending claim set', () => {
    const r = parseClaimSet(VALID);
    expect(r.ok).toBe(true);
    expect(r.claimSet?.claims).toHaveLength(1);
    expect(r.issues).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(parseClaimSet('nope').ok).toBe(false);
  });

  it('names the offending claim id in the issue text', () => {
    const bad = { ...VALID, claims: [{ ...VALID.claims[0], checkable_at: '' }] };
    const r = parseClaimSet(bad);
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('cs-deliver-unpaid');
  });

  it('rejects duplicate claim ids', () => {
    const dup = { ...VALID, claims: [VALID.claims[0], VALID.claims[0]] };
    const r = parseClaimSet(dup);
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/duplicate/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/run-claims.test.ts`
Expected: FAIL — cannot resolve `../../lib/run-claims.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/run-claims.ts
/**
 * Pre-run claims / post-run validation — the pure core.
 *
 * Source-of-truth contract:
 *   - `docs/superpowers/specs/2026-09-15-pre-run-claims-post-run-validation-design.md`
 *
 * A CLAIM is a falsifiable statement about what the NEXT run's output must
 * look like, authored because a named person decided something. It is not a
 * decision (ACE weighed nothing) and not feedback routing (`feedback-ledger`
 * answers "did their input reach us"; this answers "did the work implied by
 * it happen").
 *
 * This module is intentionally PURE — no Drive, no I/O, no YAML parsing —
 * the same posture as `lib/run-state-validator.ts`, so the fence can call it
 * on already-read state and tests need no fixtures on disk.
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
  // Written back by the fence.
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
      // Name the claim id rather than its array index — an index is
      // meaningless to anyone reading the fence output.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/run-claims.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/run-claims.ts test/lib/run-claims.test.ts
git commit -m "feat(claims): claim set schema + parser"
```

---

### Task 2: Freeze, and the immutability rule

**Files:**
- Modify: `lib/run-claims.ts`
- Test: `test/lib/run-claims.test.ts`

**Interfaces:**
- Consumes: `ClaimSet`, `parseClaimSet` from Task 1.
- Produces: `freezeClaimSet(set: ClaimSet, opts: { runId: string; now: string }): { ok: boolean; claimSet: ClaimSet | null; issues: string[] }` and `diffFrozenClaims(frozen: ClaimSet, incoming: ClaimSet): string[]` (empty array = no illegal mutation).

- [ ] **Step 1: Write the failing test**

```typescript
// append to test/lib/run-claims.test.ts
import { freezeClaimSet, diffFrozenClaims, parseClaimSet as parse } from '../../lib/run-claims.js';

const pending = () => parse(VALID).claimSet!;

describe('freezeClaimSet', () => {
  it('stamps frozen_at and source_run_id', () => {
    const r = freezeClaimSet(pending(), { runId: '20260908-0510', now: '2026-09-15T10:30:00Z' });
    expect(r.ok).toBe(true);
    expect(r.claimSet?.frozen_at).toBe('2026-09-15T10:30:00Z');
    expect(r.claimSet?.source_run_id).toBe('20260908-0510');
  });

  it('refuses to re-freeze an already-frozen set', () => {
    const once = freezeClaimSet(pending(), { runId: 'r1', now: '2026-09-15T10:30:00Z' }).claimSet!;
    const twice = freezeClaimSet(once, { runId: 'r2', now: '2026-09-15T11:00:00Z' });
    expect(twice.ok).toBe(false);
    expect(twice.issues.join(' ')).toMatch(/already frozen/i);
  });

  it('refuses to freeze an empty claim set', () => {
    const empty = { ...pending(), claims: [] };
    expect(freezeClaimSet(empty, { runId: 'r1', now: 'n' }).ok).toBe(false);
  });
});

describe('diffFrozenClaims', () => {
  const frozen = () =>
    freezeClaimSet(pending(), { runId: 'r1', now: '2026-09-15T10:30:00Z' }).claimSet!;

  it('allows an identical set', () => {
    expect(diffFrozenClaims(frozen(), frozen())).toEqual([]);
  });

  it('rejects an added claim', () => {
    const f = frozen();
    const more = { ...f, claims: [...f.claims, { ...f.claims[0], id: 'sneaky' }] };
    expect(diffFrozenClaims(f, more).join(' ')).toContain('sneaky');
  });

  it('rejects a removed claim', () => {
    const f = frozen();
    expect(diffFrozenClaims(f, { ...f, claims: [] }).join(' ')).toContain('cs-deliver-unpaid');
  });

  it('rejects a reworded claim — the exam cannot change after the run starts', () => {
    const f = frozen();
    const soft = {
      ...f,
      claims: [{ ...f.claims[0], claim: 'The Deliver app mentions payment somewhere.' }],
    };
    expect(diffFrozenClaims(f, soft).join(' ')).toMatch(/reworded|changed/i);
  });

  it('ALLOWS verdict fields to be written — that is the whole point', () => {
    const f = frozen();
    const answered = {
      ...f,
      claims: [{ ...f.claims[0], verdict: 'MET' as const, evidence_kind: 'probed' as const, evidence: 'x' }],
    };
    expect(diffFrozenClaims(f, answered)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/run-claims.test.ts`
Expected: FAIL — `freezeClaimSet` is not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to lib/run-claims.ts

/** Fields the fence legitimately writes after freezing. Everything else is the exam. */
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
      issues: [`claim set is already frozen at ${set.frozen_at} — a later claim belongs to the next run`],
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
 * Verdict fields are expected to change (the fence writes them); the CLAIM
 * itself must not, or the exam gets rewritten once the results are in.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/run-claims.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/run-claims.ts test/lib/run-claims.test.ts
git commit -m "feat(claims): freeze at run start, and reject post-freeze rewording"
```

---

### Task 3: Recording a verdict — where every rule lives

**Files:**
- Modify: `lib/run-claims.ts`
- Test: `test/lib/run-claims.test.ts`

**Interfaces:**
- Consumes: `Claim`, `ClaimSet` from Tasks 1–2.
- Produces: `recordVerdict(set: ClaimSet, claimId: string, v: VerdictInput): { ok: boolean; claimSet: ClaimSet | null; issues: string[] }` where
  `VerdictInput = { verdict: ClaimVerdict; evidence_kind?: EvidenceKind; evidence: string; would_settle_it?: string; phase: string; now: string }`;
  and `claimsDueAt(set: ClaimSet, phase: string): Claim[]`.

- [ ] **Step 1: Write the failing test**

```typescript
// append to test/lib/run-claims.test.ts
import { recordVerdict, claimsDueAt } from '../../lib/run-claims.js';

const frozenSet = () =>
  freezeClaimSet(pending(), { runId: 'r1', now: '2026-09-15T10:30:00Z' }).claimSet!;

describe('recordVerdict', () => {
  it('records MET with probed evidence', () => {
    const r = recordVerdict(frozenSet(), 'cs-deliver-unpaid', {
      verdict: 'MET',
      evidence_kind: 'probed',
      evidence: 'CCZ b3f1c2 — 0 matches for <connect:payment>',
      phase: 'commcare-setup',
      now: '2026-09-15T14:02:11Z',
    });
    expect(r.ok).toBe(true);
    expect(r.claimSet?.claims[0].verdict).toBe('MET');
    expect(r.claimSet?.claims[0].checked_in_phase).toBe('commcare-setup');
  });

  it('REFUSES a probe-kind claim recorded as judged — the degradation this exists to prevent', () => {
    const r = recordVerdict(frozenSet(), 'cs-deliver-unpaid', {
      verdict: 'MET',
      evidence_kind: 'judged',
      evidence: 'looked about right',
      phase: 'commcare-setup',
      now: 'n',
    });
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/probe/i);
  });

  it('REFUSES INDETERMINATE without would_settle_it', () => {
    const r = recordVerdict(frozenSet(), 'cs-deliver-unpaid', {
      verdict: 'INDETERMINATE',
      evidence: 'ambiguous',
      phase: 'commcare-setup',
      now: 'n',
    });
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/would_settle_it/);
  });

  it('accepts INDETERMINATE when it names what would settle it', () => {
    const r = recordVerdict(frozenSet(), 'cs-deliver-unpaid', {
      verdict: 'INDETERMINATE',
      evidence: 'the CCZ has two distribution forms',
      would_settle_it: 'which form the opportunity binds as the payable deliver unit',
      phase: 'commcare-setup',
      now: 'n',
    });
    expect(r.ok).toBe(true);
  });

  it('refuses an unknown claim id rather than silently doing nothing', () => {
    const r = recordVerdict(frozenSet(), 'no-such-claim', {
      verdict: 'MET',
      evidence_kind: 'probed',
      evidence: 'x',
      phase: 'p',
      now: 'n',
    });
    expect(r.ok).toBe(false);
  });

  it('requires non-empty evidence for every verdict', () => {
    const r = recordVerdict(frozenSet(), 'cs-deliver-unpaid', {
      verdict: 'UNMET',
      evidence_kind: 'probed',
      evidence: '',
      phase: 'p',
      now: 'n',
    });
    expect(r.ok).toBe(false);
  });
});

describe('claimsDueAt', () => {
  it('returns only claims whose checkable_at matches', () => {
    expect(claimsDueAt(frozenSet(), 'commcare-setup')).toHaveLength(1);
    expect(claimsDueAt(frozenSet(), 'connect-setup')).toHaveLength(0);
  });

  it('does not re-return a claim that already has a verdict', () => {
    const answered = recordVerdict(frozenSet(), 'cs-deliver-unpaid', {
      verdict: 'MET',
      evidence_kind: 'probed',
      evidence: 'x',
      phase: 'commcare-setup',
      now: 'n',
    }).claimSet!;
    expect(claimsDueAt(answered, 'commcare-setup')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/run-claims.test.ts`
Expected: FAIL — `recordVerdict` is not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to lib/run-claims.ts

export interface VerdictInput {
  verdict: ClaimVerdict;
  evidence_kind?: EvidenceKind;
  evidence: string;
  would_settle_it?: string;
  phase: string;
  now: string;
}

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/run-claims.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/run-claims.ts test/lib/run-claims.test.ts
git commit -m "feat(claims): verdict recording with the probe/judged and INDETERMINATE rules"
```

---

### Task 4: The closeout sweep and the summary — where silence becomes an accusation

**Files:**
- Modify: `lib/run-claims.ts`
- Test: `test/lib/run-claims.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `sweepUnreached(set: ClaimSet, now: string): ClaimSet` and
  `summarizeClaims(set: ClaimSet): ClaimSummary` where
  `ClaimSummary = { total: number; met: number; unmet: number; not_reached: number; indeterminate: number; unanswered: number; all_met: boolean; summary: string }`.

- [ ] **Step 1: Write the failing test**

```typescript
// append to test/lib/run-claims.test.ts
import { sweepUnreached, summarizeClaims } from '../../lib/run-claims.js';

const THREE = {
  ...VALID,
  claims: [
    { ...VALID.claims[0], id: 'a', checkable_at: 'commcare-setup' },
    { ...VALID.claims[0], id: 'b', checkable_at: 'connect-setup' },
    { ...VALID.claims[0], id: 'c', checkable_at: 'ocs-setup' },
  ],
};
const three = () =>
  freezeClaimSet(parse(THREE).claimSet!, { runId: 'r1', now: 't0' }).claimSet!;

describe('sweepUnreached', () => {
  it('marks every unanswered claim NOT REACHED at closeout', () => {
    const swept = sweepUnreached(three(), '2026-09-15T20:00:00Z');
    expect(swept.claims.every((c) => c.verdict === 'NOT REACHED')).toBe(true);
    expect(swept.claims[0].evidence).toMatch(/never ran|not reached/i);
  });

  it('does not overwrite a verdict already recorded', () => {
    const one = recordVerdict(three(), 'a', {
      verdict: 'MET', evidence_kind: 'probed', evidence: 'x', phase: 'commcare-setup', now: 't1',
    }).claimSet!;
    const swept = sweepUnreached(one, 't9');
    expect(swept.claims.find((c) => c.id === 'a')?.verdict).toBe('MET');
    expect(swept.claims.find((c) => c.id === 'b')?.verdict).toBe('NOT REACHED');
  });
});

describe('summarizeClaims', () => {
  it('REGRESSION CONTROL: every answered claim MET but one never reached is NOT fully met', () => {
    let s = three();
    for (const id of ['a', 'b']) {
      s = recordVerdict(s, id, {
        verdict: 'MET', evidence_kind: 'probed', evidence: 'x', phase: 'p', now: 't',
      }).claimSet!;
    }
    const swept = sweepUnreached(s, 't9');
    const sum = summarizeClaims(swept);
    expect(sum.met).toBe(2);
    expect(sum.not_reached).toBe(1);
    expect(sum.all_met).toBe(false);
    expect(sum.summary).toMatch(/1 never reached/i);
  });

  it('a partial run reports verdicts for the phases it did reach', () => {
    const s = recordVerdict(three(), 'a', {
      verdict: 'UNMET', evidence_kind: 'probed', evidence: 'still marked paid', phase: 'commcare-setup', now: 't1',
    }).claimSet!;
    const sum = summarizeClaims(s);
    expect(sum.unmet).toBe(1);
    expect(sum.unanswered).toBe(2);
    expect(sum.all_met).toBe(false);
  });

  it('all met and all answered is all_met', () => {
    let s = three();
    for (const id of ['a', 'b', 'c']) {
      s = recordVerdict(s, id, {
        verdict: 'MET', evidence_kind: 'probed', evidence: 'x', phase: 'p', now: 't',
      }).claimSet!;
    }
    expect(summarizeClaims(s).all_met).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/run-claims.test.ts`
Expected: FAIL — `sweepUnreached` is not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to lib/run-claims.ts

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

  // `all_met` requires that nothing is outstanding. A run where every
  // ANSWERED claim passed but a checkpoint never ran has not met its claims.
  const allMet = total > 0 && met === total;

  const parts: string[] = [`${met}/${total} met`];
  if (unmet > 0) parts.push(`${unmet} not met`);
  if (notReached > 0) parts.push(`${notReached} never reached`);
  if (indeterminate > 0) parts.push(`${indeterminate} indeterminate`);
  if (unanswered > 0) parts.push(`${unanswered} still open`);

  return {
    total, met, unmet, not_reached: notReached, indeterminate, unanswered,
    all_met: allMet,
    summary: parts.join(', '),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/run-claims.test.ts && npx tsc --noEmit`
Expected: PASS, and tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/run-claims.ts test/lib/run-claims.test.ts
git commit -m "feat(claims): closeout sweep to NOT REACHED + summary with the all_met control"
```

---

### Task 5: The `verify_run_claims` atom

**Files:**
- Modify: `mcp/google-drive-server.ts` (register next to `verify_phase_products`, around line 3668)
- Test: `test/mcp/gdrive/verify-run-claims.test.ts`

**Interfaces:**
- Consumes: `parseClaimSet`, `claimsDueAt`, `summarizeClaims` from `lib/run-claims.ts`.
- Produces: MCP tool `verify_run_claims({ fileId, phase })` returning
  `{ phase, ok, due, unanswered_here, met, unmet, not_reached, indeterminate, summary, issues }`.

**Note:** this task registers the atom as a READ-ONLY reporter. It reports which claims are due and their current verdicts; the orchestrator records verdicts via the existing `update_yaml_file` atom, which already has `deep` merge and the array-replacement semantics documented in CLAUDE.md. Do not add a write path here — a second writer to the same file is the lost-update footgun that CLAUDE.md § `update_yaml_file` already names.

- [ ] **Step 1: Write the failing test**

```typescript
// test/mcp/gdrive/verify-run-claims.test.ts
import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import { parseClaimSet, claimsDueAt, summarizeClaims } from '../../../lib/run-claims.js';

// The atom is a thin wrapper: read -> parse -> classify. This test pins the
// classification the wrapper returns, which is the part with logic in it.
function classify(text: string, phase: string) {
  const parsed = text.trim() ? YAML.parse(text) : null;
  const r = parseClaimSet(parsed);
  if (!r.ok || !r.claimSet) {
    return { phase, ok: false, issues: r.issues, due: 0, summary: 'claims file unreadable' };
  }
  const due = claimsDueAt(r.claimSet, phase);
  const sum = summarizeClaims(r.claimSet);
  return { phase, ok: true, issues: [], due: due.length, summary: sum.summary };
}

const FIXTURE = `
schema_version: 1
kind: run-claims
opp: poverty-graduation
frozen_at: '2026-09-15T10:30:00Z'
source_run_id: '20260908-0510'
claims:
  - id: cs-deliver-unpaid
    claim: The Deliver app's distribution visit carries no payment marker.
    artifact: deliver-app
    checkable_at: commcare-setup
    origin: {kind: counterpart-decision, person: Sophie Feintuch}
    authored_by: ace
    check: {kind: probe, how: Parse the released Deliver CCZ.}
  - id: cs-connect-no-pu
    claim: The Connect opportunity has no payment unit for consumption support.
    artifact: connect-opportunity
    checkable_at: connect-setup
    origin: {kind: counterpart-decision, person: Sophie Feintuch}
    authored_by: ace
    check: {kind: probe, how: List payment units.}
`;

describe('verify_run_claims classification', () => {
  it('reports only the claims due at this phase', () => {
    expect(classify(FIXTURE, 'commcare-setup').due).toBe(1);
    expect(classify(FIXTURE, 'connect-setup').due).toBe(1);
    expect(classify(FIXTURE, 'ocs-setup').due).toBe(0);
  });

  it('reports a run-level summary, not just this phase', () => {
    expect(classify(FIXTURE, 'commcare-setup').summary).toMatch(/0\/2 met/);
  });

  it('an unreadable claims file reports ok:false rather than throwing', () => {
    const r = classify('claims: "not a list"', 'commcare-setup');
    expect(r.ok).toBe(false);
  });

  it('an empty claims file is ok with nothing due — an opp with no claims is normal', () => {
    const r = classify('', 'commcare-setup');
    expect(r.ok).toBe(false); // null parses as "not an object" — the atom reports, never throws
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mcp/gdrive/verify-run-claims.test.ts`
Expected: FAIL — cannot resolve `lib/run-claims.js` exports used here if Tasks 1–4 are incomplete; otherwise PASS on the helper and FAIL only once the atom is wired (see Step 3).

- [ ] **Step 3: Register the atom**

Add the import alongside the other lib imports at the top of `mcp/google-drive-server.ts`:

```typescript
import { parseClaimSet, claimsDueAt, summarizeClaims } from '../lib/run-claims.js';
```

Then register immediately after the `verify_phase_products` block:

```typescript
server.tool(
  'verify_run_claims',
  "Boundary-fence REPORT (never a gate) on the run's frozen claim set — the statements about what this run's OUTPUT must look like, authored because a named counterpart decided something between runs. Reads `claims.yaml` from Drive, and returns which claims are due at this phase plus the run-level tally. `due` counts claims whose `checkable_at` is this phase and which have no verdict yet; the orchestrator evaluates those against the artifacts the phase just produced and writes verdicts back with `update_yaml_file` (this atom never writes). UNMET NEVER HALTS THE RUN — what a counterpart is owed is a diff, and a halt produces no diff (design: docs/superpowers/specs/2026-09-15-pre-run-claims-post-run-validation-design.md). Verdicts are `MET` | `UNMET` | `NOT REACHED` | `INDETERMINATE`, with `evidence_kind` (`probed` | `judged`) as an orthogonal qualifier: a claim declaring a `probe` check may never be recorded as `judged` — if the probe could not run that is `NOT REACHED`. This is the claim-level companion to `verify_phase_artifacts` (Drive files) and `verify_phase_products` (typed handoff); those answer whether ACE's bookkeeping is complete, this answers whether the change a human asked for actually happened. Implementation: `lib/run-claims.ts`.",
  {
    fileId: z.string().describe("The Google Drive fileId of the run's claims.yaml."),
    phase: z
      .string()
      .describe('The phase whose due claims to report (e.g. "commcare-setup"). Run-state phase name, as classify_phase_writeback takes.'),
  },
  async ({ fileId, phase }) => {
    try {
      const read = await handleReadFile({ fileId }, drive);
      const text = read.content ?? '';
      const parsed = text.trim() ? YAML.parse(text) : null;
      const r = parseClaimSet(parsed);
      if (!r.ok || !r.claimSet) {
        return result({
          phase,
          ok: false,
          issues: r.issues,
          due: [],
          summary: 'claims file unreadable — the fence reports this, it does not halt',
        });
      }
      const due = claimsDueAt(r.claimSet, phase);
      const sum = summarizeClaims(r.claimSet);
      return result({
        phase,
        ok: true,
        issues: [],
        due: due.map((c) => ({
          id: c.id,
          claim: c.claim,
          artifact: c.artifact,
          check: c.check,
          authored_by: c.authored_by,
          person: c.origin.person,
        })),
        met: sum.met,
        unmet: sum.unmet,
        not_reached: sum.not_reached,
        indeterminate: sum.indeterminate,
        all_met: sum.all_met,
        summary: sum.summary,
      });
    } catch (e: any) {
      return error(e.message);
    }
  },
);
```

- [ ] **Step 4: Run tests + regenerate the atom catalogue**

Run:
```bash
npx vitest run test/mcp/gdrive/verify-run-claims.test.ts
npx tsx scripts/dump-atom-schemas.ts
npx vitest run test/scripts/dump-atom-schemas.test.ts test/mcp/registration-coverage.test.ts
npx tsc --noEmit
```
Expected: all PASS. `docs/atom-schemas.md` now contains `verify_run_claims`.

- [ ] **Step 5: Commit**

```bash
git add mcp/google-drive-server.ts test/mcp/gdrive/verify-run-claims.test.ts docs/atom-schemas.md
git commit -m "feat(claims): verify_run_claims atom — report-only fence check"
```

---

### Task 6: Wire the fence, the freeze, and the closeout sweep

**Files:**
- Modify: `agents/ace-orchestrator.md` (§ Phase boundary fence, around lines 1797–1850; plus run kickoff and closeout)
- Test: `test/agents/run-claims-fence.test.ts` (create)

**Interfaces:**
- Consumes: the `verify_run_claims` atom from Task 5.
- Produces: no code interface — this task makes the mechanism actually run.

**The load-bearing constraint:** the Turn N+2 branch condition MUST NOT change. Add the check as item 6 in the Turn N+1 parallel batch, and add its narration to Turn N+2 without adding it to the branch.

- [ ] **Step 1: Write the failing test**

```typescript
// test/agents/run-claims-fence.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = readFileSync(join(process.cwd(), 'agents/ace-orchestrator.md'), 'utf8');

describe('claims are wired into the fence as a REPORT, not a gate', () => {
  it('the fence batch calls verify_run_claims', () => {
    expect(ORCH).toMatch(/verify_run_claims\(/);
  });

  it('the run freezes its claim set at kickoff', () => {
    expect(ORCH).toMatch(/claims\.yaml/);
    expect(ORCH.toLowerCase()).toMatch(/freez/);
  });

  it('closeout sweeps unanswered claims to NOT REACHED', () => {
    expect(ORCH).toMatch(/NOT REACHED/);
  });

  it('REGRESSION CONTROL: claims never appear in the Turn N+2 branch condition', () => {
    // The branch is what decides whether the run proceeds. A claims result
    // must never be able to stop it (design § 2: report loud, never halt).
    const branch = ORCH.slice(
      ORCH.indexOf('Turn N+2:  Branch on classify_phase_writeback'),
      ORCH.indexOf('Turn N+3'),
    );
    expect(branch.length).toBeGreaterThan(200); // the slice actually found the block
    expect(branch).not.toMatch(/verify_run_claims|claims\.ok|claim.*halt/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/run-claims-fence.test.ts`
Expected: FAIL — the orchestrator does not mention `verify_run_claims`.

- [ ] **Step 3: Edit `agents/ace-orchestrator.md`**

In the Turn N+1 parallel batch, renumber the existing optional `TaskUpdate` item and insert before `Skill(decisions-render)`:

```
             6. verify_run_claims(fileId=<claims.yaml>, phase=<phase>)
                — REPORT ONLY. Never gates; see the branch below, which
                  does not mention it. Returns {phase, ok, due[], met,
                  unmet, not_reached, indeterminate, all_met, summary}.
                — `due[]` is the claims a counterpart's decision says this
                  phase's OUTPUT must satisfy, not yet answered. For each:
                  check it against the artifacts this phase just produced,
                  then write the verdict back with ONE update_yaml_file
                  call (merge: 'deep'; `claims` is an ARRAY, so resend the
                  WHOLE list — every mode replaces an array wholesale, and
                  a partial patch silently drops the rest. Build the full
                  intended array and pass it via localFilePath rather than
                  inline; see CLAUDE.md § update_yaml_file).
                — verdict is MET | UNMET | NOT REACHED | INDETERMINATE.
                  `evidence` is REQUIRED and names what you observed.
                  A claim declaring `check.kind: probe` may NOT be recorded
                  `evidence_kind: judged` — if the probe could not run, that
                  is NOT REACHED with the reason. INDETERMINATE requires
                  `would_settle_it`.
                — UNMET does NOT halt. Narrate it, keep going. What the
                  counterpart is owed is a diff, and a halt produces none.
                — absent claims.yaml → skip silently; most opps have none.
```

In Turn N+2, after the existing branch conditions, add (as narration, NOT a condition):

```
           Independently of the branch above, echo verify_run_claims.summary
           verbatim in the one-line phase summary when a claims file exists
           (e.g. "claims: 2/5 met, 1 not met"). It never changes the branch.
```

At run kickoff (the run-init step that creates the run folder), add:

```
- **Freeze the claim set.** If `ACE/<opp>/pending-claims.yaml` exists, copy it to
  `runs/<run-id>/claims.yaml`, stamp `frozen_at` (now) and `source_run_id` (this run id),
  and TRASH the pending file — a claim authored after this moment belongs to the NEXT run.
  The exam cannot be rewritten once the results start arriving.
```

At closeout (Phase 10), add:

```
- **Sweep unanswered claims.** Every claim in `runs/<run-id>/claims.yaml` still without a
  verdict becomes `NOT REACHED`, with `evidence` naming the checkpoint that never ran.
  NOT REACHED accuses; it never passes. A run closing with NOT REACHED claims is reporting
  a real gap, and the reviewer-facing section says so.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/agents/run-claims-fence.test.ts && npx vitest run test/lib/agent-depth.test.ts`
Expected: PASS both (the depth ratchet must still hold — no new `Agent(...)` target was added).

- [ ] **Step 5: Commit**

```bash
git add agents/ace-orchestrator.md test/agents/run-claims-fence.test.ts
git commit -m "feat(claims): wire verify_run_claims into the fence as a report, freeze at kickoff, sweep at closeout"
```

---

### Task 7: Authoring claims at turn time

**Files:**
- Modify: `skills/inbox-triage/SKILL.md`
- Test: `test/skills/claims-authoring.test.ts` (create)

**Interfaces:**
- Consumes: the `pending-claims.yaml` shape from Task 1.
- Produces: the write-side convention the whole mechanism depends on.

- [ ] **Step 1: Write the failing test**

```typescript
// test/skills/claims-authoring.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL = readFileSync(join(process.cwd(), 'skills/inbox-triage/SKILL.md'), 'utf8');

describe('inbox-triage authors claims for an act-tier decision', () => {
  it('names the pending claims file', () => {
    expect(SKILL).toMatch(/pending-claims\.yaml/);
  });

  it('states the one-claim-per-artifact granularity rule', () => {
    expect(SKILL).toMatch(/one claim per artifact/i);
  });

  it("requires the counterpart's own acceptance criteria to be carried verbatim", () => {
    expect(SKILL).toMatch(/verbatim/i);
    expect(SKILL).toMatch(/authored_by/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/skills/claims-authoring.test.ts`
Expected: FAIL — `pending-claims.yaml` not found in the skill.

- [ ] **Step 3: Add the authoring step to `skills/inbox-triage/SKILL.md`**

Add a step after the thread is routed to an opp/run and before the reply is drafted:

```markdown
### Step N — Author claims for anything the counterpart DECIDED

A decision that changes what the next run must BUILD gets recorded as claims in
`ACE/<opp>/pending-claims.yaml` (shape: `lib/run-claims.ts`; design:
`docs/superpowers/specs/2026-09-15-pre-run-claims-post-run-validation-design.md`).

**Why:** routing their words into a store is not the same as the work happening. A decision
can be recorded correctly, bind correctly, and still never reach the artifact they read —
silently, because every existing gate passes. Claims are what make that omission visible.

**One claim per ARTIFACT that must change — never one per decision.** "Make the Deliver app,
the Connect opportunity and the support assistant agree that consumption support is unpaid"
is ONE decision and THREE claims, each with its own `checkable_at`, because the three
artifacts are produced in three different phases. As a single claim it is unverifiable at any
checkpoint and it fails as a lump, telling the reader nothing about which surface is wrong.

**Carry their own acceptance criteria VERBATIM.** When the counterpart states what they want
to see ("I want to see the memo, whether Targeting v1.1 compiles as Component 2, and whether
my comments land"), each becomes a claim with `authored_by: counterpart` and their words in
`origin.quote`. Claims ACE drafts are `authored_by: ace`. They render distinctly, so a bar
the counterpart set cannot be quietly softened into one ACE set.

Each claim states ONE checkable property of ONE artifact, names `checkable_at` (the first
phase whose output can settle it), and declares `check.kind`: `probe` where a mechanical
check exists, `judged` where it does not. Do not claim a probe you cannot write.

**Do NOT write claims into `decisions.yaml`.** A claim is not a decision — ACE weighed
nothing. Writing it there fabricates deliberation that never happened (Jon, 2026-07-27:
*"not everything can be constituted as a decision"*).

Claims are authored here and frozen when the next run starts. A claim authored after a run
is under way belongs to the run after it.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/skills/claims-authoring.test.ts && npx vitest run test/skill-atom-references.test.ts`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add skills/inbox-triage/SKILL.md test/skills/claims-authoring.test.ts
git commit -m "feat(claims): author claims at turn time from an act-tier decision"
```

---

### Task 8: The reviewer-facing section

**Files:**
- Modify: `skills/opp-eval/SKILL.md`
- Create: `lib/render-claims.ts`
- Test: `test/lib/render-claims.test.ts`

**Interfaces:**
- Consumes: `ClaimSet`, `summarizeClaims` from `lib/run-claims.ts`.
- Produces: `renderClaimsSection(set: ClaimSet): string` — markdown for the reply and for the run page payload.

**Scope note:** this task lands the ACE-side rendering (the reply section, and the data the run page reads). The ace-web page section is a sibling-repo change and gets its own plan once this has run once for real.

- [ ] **Step 1: Write the failing test**

```typescript
// test/lib/render-claims.test.ts
import { describe, it, expect } from 'vitest';
import { renderClaimsSection } from '../../lib/render-claims.js';
import type { ClaimSet } from '../../lib/run-claims.js';

const SET: ClaimSet = {
  schema_version: 1,
  kind: 'run-claims',
  opp: 'poverty-graduation',
  frozen_at: 't0',
  source_run_id: '20260908-0510',
  claims: [
    {
      id: 'a', claim: 'The Deliver app marks the distribution visit unpaid.',
      artifact: 'deliver-app', checkable_at: 'commcare-setup',
      origin: { kind: 'counterpart-decision', person: 'Sophie Feintuch' },
      authored_by: 'ace', check: { kind: 'probe', how: 'x' },
      verdict: 'MET', evidence_kind: 'probed', evidence: 'CCZ b3f1c2, 0 matches',
    },
    {
      id: 'b', claim: 'Targeting v1.1 compiles as Component 2.',
      artifact: 'composed-pdd', checkable_at: 'idea-to-design',
      origin: { kind: 'counterpart-decision', person: 'Sophie Feintuch', quote: 'whether Targeting v1.1 compiles as Component 2' },
      authored_by: 'counterpart', check: { kind: 'judged', how: 'read the composed PDD' },
      verdict: 'UNMET', evidence_kind: 'judged', evidence: 'composed PDD has no Component 2 section',
    },
    {
      id: 'c', claim: 'The support assistant says consumption support is unpaid.',
      artifact: 'ocs-chatbot', checkable_at: 'ocs-setup',
      origin: { kind: 'counterpart-decision', person: 'Sophie Feintuch' },
      authored_by: 'ace', check: { kind: 'probe', how: 'y' },
      verdict: 'NOT REACHED', evidence_kind: 'probed', evidence: 'the `ocs-setup` checkpoint never ran in this run',
    },
  ],
};

describe('renderClaimsSection', () => {
  it('renders every claim, whichever way it went', () => {
    const md = renderClaimsSection(SET);
    expect(md).toContain('The Deliver app marks the distribution visit unpaid.');
    expect(md).toContain('Targeting v1.1 compiles as Component 2.');
    expect(md).toContain('The support assistant says consumption support is unpaid.');
  });

  it('marks a claim the counterpart set as theirs', () => {
    expect(renderClaimsSection(SET)).toMatch(/you asked for this|your criterion/i);
  });

  it('qualifies a judged verdict so it reads as weaker than a probed one', () => {
    expect(renderClaimsSection(SET)).toMatch(/judged/i);
  });

  it('REGRESSION CONTROL: does not present the run as fully delivered when one claim never ran', () => {
    const md = renderClaimsSection(SET);
    expect(md).not.toMatch(/all .* met|everything you asked/i);
    expect(md).toMatch(/never reached/i);
  });

  it('leads with the tally so a reader knows the shape before the detail', () => {
    expect(renderClaimsSection(SET).split('\n')[0]).toMatch(/1\/3 met/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/render-claims.test.ts`
Expected: FAIL — cannot resolve `lib/render-claims.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/render-claims.ts
/**
 * "What changed because you asked" — the reviewer-facing view of a run's
 * claim set.
 *
 * The claim set is the DENOMINATOR: every claim renders whichever way it
 * went, so an unmet one appears as an accusation rather than as an absence.
 * Same completeness property that makes `UNROUTED` work in feedback-ledger.
 */

import type { Claim, ClaimSet } from './run-claims.js';
import { summarizeClaims } from './run-claims.js';

const MARK: Record<string, string> = {
  MET: '✅ met',
  UNMET: '❌ not met',
  'NOT REACHED': '⚠️ never reached',
  INDETERMINATE: '❓ indeterminate',
};

function renderClaim(c: Claim): string {
  const mark = MARK[c.verdict ?? ''] ?? '⏳ still open';
  const qualifier = c.evidence_kind === 'judged' ? ' _(judged, not probed)_' : '';
  const mine = c.authored_by === 'counterpart' ? ' — **you asked for this one**' : '';
  const lines = [`- **${mark}**${qualifier} ${c.claim}${mine}`];
  if (c.evidence) lines.push(`  - ${c.evidence}`);
  if (c.would_settle_it) lines.push(`  - would settle it: ${c.would_settle_it}`);
  return lines.join('\n');
}

export function renderClaimsSection(set: ClaimSet): string {
  const sum = summarizeClaims(set);
  const byPerson = new Map<string, Claim[]>();
  for (const c of set.claims) {
    const k = c.origin.person;
    byPerson.set(k, [...(byPerson.get(k) ?? []), c]);
  }
  const out: string[] = [`${sum.summary} — what changed because you asked:`, ''];
  for (const [person, claims] of byPerson) {
    if (byPerson.size > 1) out.push(`**${person}**`, '');
    for (const c of claims) out.push(renderClaim(c));
    out.push('');
  }
  return out.join('\n').trimEnd();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/render-claims.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Add the aggregation note to `skills/opp-eval/SKILL.md`**

```markdown
### Claims

If the run folder holds `claims.yaml`, roll its tally into the scorecard via
`summarizeClaims` (`lib/run-claims.ts`) and render the section with
`renderClaimsSection` (`lib/render-claims.ts`).

`all_met` is TRUE only when every claim is `MET`. A run where every ANSWERED claim passed but
a checkpoint never ran has NOT met its claims — reporting otherwise recreates the silence the
mechanism exists to remove.
```

- [ ] **Step 6: Commit**

```bash
git add lib/render-claims.ts test/lib/render-claims.test.ts skills/opp-eval/SKILL.md
git commit -m "feat(claims): render the 'what changed because you asked' section"
```

---

### Task 9: Author Sophie's claims and ship

**Files:**
- Create: `ACE/poverty-graduation/pending-claims.yaml` (in Drive, not the repo)
- Modify: nothing in the repo

**Interfaces:**
- Consumes: everything above.

This is the first real application, and the point at which the design gets tested against a real message rather than a fixture.

- [ ] **Step 1: Full suite + typecheck**

```bash
npm test && npx tsc --noEmit
```
Expected: all green.

- [ ] **Step 2: Bump, PR, auto-merge**

```bash
bash scripts/version-bump.sh
git add -A && git commit -m "chore: version bump"
git push -u origin <branch>
gh pr create --title "feat(claims): pre-run claims / post-run validation" --body-file <staged body>
gh pr merge <n> --auto --merge
```

Wait for the merge per `skills/shipping` — never a hand-rolled foreground `sleep`.

- [ ] **Step 3: `/ace:update`, then author the claims**

From Sophie's 2026-09-14 message, write `ACE/poverty-graduation/pending-claims.yaml`. At minimum:

| id | claim | artifact | checkable_at | authored_by |
|---|---|---|---|---|
| `cs-deliver-unpaid` | The Deliver app's consumption-support distribution visit carries no payment marker | deliver-app | commcare-setup | ace |
| `cs-connect-no-pu` | The Connect opportunity has no payment unit for consumption support | connect-opportunity | connect-setup | ace |
| `cs-assistant-unpaid` | The support assistant tells workers consumption support is unpaid | ocs-chatbot | ocs-setup | ace |
| `build-memo-present` | The run page leads with the build memo | run-summary | closeout | counterpart |
| `targeting-v11-component-2` | Targeting v1.1 compiles as Component 2 | composed-pdd | idea-to-design | counterpart |
| `comments-land` | Sophie's nine Targeting PDD comments are read as inputs to this run | composed-pdd | idea-to-design | counterpart |
| `learn-bank-limitation` | The build memo names the fixed assessment bank as a limitation, not as settled | build-memo | commcare-setup | ace |
| `payment-rate-per-component` | The solicitation prices each payable activity separately rather than one band | solicitation | solicitation-management | ace |

The last four carry `origin.quote` with her words verbatim.

- [ ] **Step 4: Run it**

`/ace:run poverty-graduation` — the kickoff freezes the set; each fence reports; closeout sweeps.

- [ ] **Step 5: Improve from what the run shows**

Per Jon, 2026-09-15: *"lets implement it and then lets improve it if we find issues applying it to sophie."* Expected findings worth watching for:

- a claim whose `checkable_at` is wrong, surfacing as `NOT REACHED` on a completed run
- a `probe` claim with no probe actually writable, which should have been `judged`
- claims ACE drafted that are softer than the decision they came from — the risk §1 of the spec accepts, and the reason the section marks her own claims distinctly

---

## Self-Review

**Spec coverage.** Every section maps to a task: §1 authoring → Task 7; §2 report-not-halt → Task 6 (with the branch-condition regression control); §3 freeze → Task 2 + Task 6; §4 checkable_at / no new judge → Tasks 3, 5, 6; §5 granularity → Task 7; claim record → Task 1; verdict vocabulary → Tasks 3, 4; fence → Tasks 5, 6; rendering → Task 8; testing → carried inside each task; residuals → no task, they are deliberately unbuilt.

**Placeholder scan.** No TBD/TODO. Every code step carries real code. Task 9's Drive file is data, not code, and its content is specified as a table rather than left as "author the claims".

**Type consistency.** `ClaimSet`, `Claim`, `ClaimVerdict`, `EvidenceKind` defined in Task 1 and used unchanged in 2–8. `freezeClaimSet` / `recordVerdict` / `sweepUnreached` / `summarizeClaims` / `claimsDueAt` / `renderClaimsSection` keep the same signatures where they cross tasks. `summarizeClaims` returns `not_reached` (snake) while the verdict string is `NOT REACHED` (space) — deliberate, and the atom in Task 5 maps between them explicitly.

**One gap accepted knowingly:** the ace-web run-page section is out of scope (sibling repo, its own plan). Task 8 lands the ACE-side payload and the reply section, which is what the first real run needs.
