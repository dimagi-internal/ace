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
 * Three renderings carry weight beyond decoration:
 *   - a claim the COUNTERPART set is marked as theirs, so a bar they set
 *     cannot be quietly softened into one ACE set
 *   - a `judged` verdict is qualified, so it reads as weaker than a
 *     `probed` one rather than borrowing its authority
 *   - the supporting line is the claim's `says` — the sentence written for
 *     the person who asked. `evidence` is the AUDIT record and reaches an
 *     `internal` surface only.
 *
 * ## Audience
 *
 * `audience` defaults to `'counterpart'`, and that default is the point.
 * Before it existed this module emitted `evidence` verbatim to everyone,
 * and on the first live run (`poverty-graduation/20260915-1518`) that was
 * ~3,900 words of Drive file ids, `commcare_download_ccz(domain=…)` atom
 * signatures, internal field names and scraped-field reliability caveats
 * for eight claims — the class `skills/agent-turn-review` § F bans from
 * counterpart comms (ace#2386). The reply that shipped was hand-rewritten
 * instead, which is the compliance-by-diligence this renderer exists to
 * replace. So a caller that wants the audit record has to ASK for it, and
 * a new consumer cannot leak by forgetting (ace#2420).
 */

import type { Claim, ClaimSet } from './run-claims.js';
import { summarizeClaims } from './run-claims.js';

const MARK: Record<string, string> = {
  MET: '✅ met',
  UNMET: '❌ not met',
  'NOT REACHED': '⚠️ never reached',
  INDETERMINATE: '❓ indeterminate',
};

/**
 * Who is reading.
 *
 * - `counterpart` — the person who asked. The run's public ace-web page,
 *   a reply, anything that leaves ACE. `says` only.
 * - `internal` — `opp-eval`, the members' workbench, a fence transcript.
 *   `says` where it exists, and the audit `evidence` underneath it.
 */
export type ClaimAudience = 'counterpart' | 'internal';

export interface RenderClaimsOptions {
  audience?: ClaimAudience;
}

function renderClaim(c: Claim, audience: ClaimAudience): string {
  const mark = MARK[c.verdict ?? ''] ?? '⏳ still open';
  const qualifier = c.evidence_kind === 'judged' ? ' _(judged, not probed)_' : '';
  const mine = c.authored_by === 'counterpart' ? ' — **you asked for this one**' : '';
  const lines = [`- **${mark}**${qualifier} ${c.claim}${mine}`];
  const says = (c.says ?? '').trim();
  if (says) lines.push(`  - ${says}`);
  // The audit record, and ONLY on an internal surface. A claim with no
  // `says` therefore renders to a counterpart as the verdict alone —
  // which is honest, and still carries the completeness property. It
  // does NOT fall back to `evidence`, ever.
  if (audience === 'internal' && c.evidence) lines.push(`  - ${c.evidence}`);
  if (c.would_settle_it) lines.push(`  - would settle it: ${c.would_settle_it}`);
  return lines.join('\n');
}

export function renderClaimsSection(set: ClaimSet, opts: RenderClaimsOptions = {}): string {
  const audience: ClaimAudience = opts.audience ?? 'counterpart';
  const sum = summarizeClaims(set);
  const byPerson = new Map<string, Claim[]>();
  for (const c of set.claims) {
    const k = c.origin.person;
    byPerson.set(k, [...(byPerson.get(k) ?? []), c]);
  }
  const out: string[] = [`${sum.summary} — what changed because you asked:`, ''];
  for (const [person, claims] of byPerson) {
    if (byPerson.size > 1) out.push(`**${person}**`, '');
    for (const c of claims) out.push(renderClaim(c, audience));
    out.push('');
  }
  return out.join('\n').trimEnd();
}
