/**
 * "What changed because you asked" — the reviewer-facing view of a run's
 * claim set.
 *
 * The claim set is the DENOMINATOR: every claim renders whichever way it
 * went, so an unmet one appears as an accusation rather than as an absence.
 * Same completeness property that makes `UNROUTED` work in
 * `skills/feedback-ledger` — a hand-written "what changed" note omits
 * silently; this one accuses.
 *
 * Two renderings carry weight beyond decoration:
 *   - a claim the COUNTERPART set is marked as theirs, so a bar they set
 *     cannot be quietly softened into one ACE set
 *   - a `judged` verdict is qualified, so it reads as weaker than a
 *     `probed` one rather than borrowing its authority
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
