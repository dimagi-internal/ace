//
// Detect a chatbot answer that gives a CANONICAL CONTACT'S LOCAL-PART on the
// WRONG DOMAIN — `ace@dimagi.com` where the knowledge base holds
// `ace@dimagi-ai.com`.
//
// Why this is its own detector and not a case of `fabrication-clamp`:
//
// The ace#1142 rule already says a contact address not verbatim in the KB is a
// fabricated operational specific, and on `spark-facilitator/20260828-0703` it
// did fire — but only because the judge chose to emit the marker. That is the
// exact fragility ace#1890 removed for fabrications and ace#1891 removed for
// filename leaks: a rule the model has to remember. This module makes the
// narrow, highest-frequency case arithmetic.
//
// Why the case is worth singling out: a NEAR MISS is both more likely and more
// dangerous than an arbitrary invented address. `ace@dimagi.com` is a real,
// resolvable domain that is not ours; a supervisor who mails it does not get a
// bounce that tells them they were misinformed, they get silence. And because
// the local-part is right, the address survives every eyeball check a human
// would plausibly apply to it.
//
// The measurement that earned this (ace#1935, 2026-09-04). Second `--deep` run
// of `spark-facilitator/20260828-0703`, 68 prompts, chatbot published v4:
//
//     37  ace@dimagi-ai.com
//      2  ace@dimagi.com        <- opp-37, opp-56
//
// Both clamped to fail, and they were the ONLY two Fails in the suite — the
// sole reason the gate did not clear at an overall of 8.5.
//
// The important part is what was ALREADY true when that happened, because it
// rules out the obvious fixes:
//
//   * `00-program-contacts.md` was indexed in the bot's collection (571). The
//     corpus had the right value. So this is not ace#1665's "the address lives
//     only in the system prompt" — that fix shipped and is verified present.
//   * The published prompt said, verbatim: "Quote them verbatim from there.
//     ... never supply an address from general knowledge or vary the spelling
//     of one." So the instruction is not missing, and it is not vague. It is
//     correct, specific, and obeyed 95% of the time.
//
// A retrieval instruction does not bind. The model intermittently emits the
// address it knows rather than the one it fetched, and no amount of further
// prompt wording addresses an instruction that is already right. So the
// preventer has to sit after generation, which is here.
//
// Scope note: this detector answers "is this a canonical contact on the wrong
// domain", NOT "is this address in the KB". An address whose local-part matches
// nothing canonical is out of scope and stays with `applyFabricationClamp`,
// which is the correct owner for a wholly invented value.
//

import { bandForScore } from './fabrication-clamp.js';
import type { JudgedEntry } from './fabrication-clamp.js';
import type { TerminalVerdict } from './eval-verdict-bands.js';

/** Marker emitted on an entry that drifted a canonical contact's domain. */
export const CONTACT_DRIFT_MARKER = '[CONTACT-DOMAIN-DRIFT]';

/**
 * A drifted contact is a fabricated operational specific, so it carries the
 * same ceiling as `applyFabricationClamp` — a reader would act on it and
 * cannot falsify it.
 */
export const CONTACT_DRIFT_CEILING = 3.0;

/** RFC-ish enough: we only need to find addresses inside prose. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export interface ContactDrift {
  ref: string;
  /** The address as written in the response. */
  found: string;
  /** The canonical address it should have been. */
  expected: string;
  scoreBefore: number;
  scoreAfter: number;
  verdictBefore?: TerminalVerdict;
  verdictAfter: TerminalVerdict;
}

export interface ContactDriftResult {
  /** Entries with the clamp applied — new objects; inputs are untouched. */
  entries: JudgedEntry[];
  /** Every drift found, in entry order. */
  drifts: ContactDrift[];
}

/** An entry paired with the response text to scan. */
export interface ScannableEntry extends JudgedEntry {
  /** The bot's answer. Absent means nothing to scan, not an error. */
  response_content?: string;
}

function splitAddress(addr: string): { local: string; domain: string } {
  const at = addr.lastIndexOf('@');
  return {
    local: addr.slice(0, at).toLowerCase(),
    domain: addr.slice(at + 1).toLowerCase(),
  };
}

/**
 * Find canonical contacts reproduced on the wrong domain.
 *
 * A hit requires the local-part to match a canonical contact exactly while the
 * domain differs. That asymmetry is the whole point: it is what separates a
 * near miss from an unrelated third-party address, which is legitimate to
 * mention (`use the Reserve Bank of Malawi`) and must not be flagged.
 *
 * @param responseText   the bot's answer
 * @param canonical      every contact address the KB actually holds
 */
export function detectContactDomainDrift(
  responseText: string,
  canonical: readonly string[],
): { found: string; expected: string }[] {
  if (!responseText) return [];

  // Group canonical addresses by local-part; one local-part can legitimately
  // exist on several domains, in which case none of them is a drift.
  const byLocal = new Map<string, Set<string>>();
  const canonicalSet = new Set<string>();
  for (const c of canonical) {
    if (!c || !c.includes('@')) continue;
    const { local, domain } = splitAddress(c);
    canonicalSet.add(`${local}@${domain}`);
    if (!byLocal.has(local)) byLocal.set(local, new Set());
    byLocal.get(local)!.add(domain);
  }

  const hits: { found: string; expected: string }[] = [];
  const seen = new Set<string>();

  for (const raw of responseText.match(EMAIL_RE) ?? []) {
    const { local, domain } = splitAddress(raw);
    const normalized = `${local}@${domain}`;

    // Exactly right — the overwhelmingly common case.
    if (canonicalSet.has(normalized)) continue;

    const domains = byLocal.get(local);
    if (!domains || domains.size === 0) continue; // unrelated address
    if (domains.has(domain)) continue; // defensive; covered above

    if (seen.has(normalized)) continue;
    seen.add(normalized);

    // Deterministic pick when a local-part maps to several canonical domains.
    const expected = `${local}@${[...domains].sort()[0]}`;
    hits.push({ found: raw, expected });
  }

  return hits;
}

/**
 * Clamp every entry that reproduced a canonical contact on the wrong domain.
 *
 * Run it in the same pass as `applyFabricationClamp` and
 * `applyInternalArtifactLeakCap` — after the per-entry judgments are collected
 * and BEFORE any suite verdict, cap or gate, since the `--deep` gate reads
 * "zero Fail verdicts".
 *
 * Idempotent: an entry already clamped to <= the ceiling keeps its score and
 * is not double-marked, so running this after `applyFabricationClamp` caught
 * the same entry costs nothing.
 */
export function applyContactDomainDriftClamp(
  entries: ScannableEntry[],
  canonical: readonly string[],
): ContactDriftResult {
  const drifts: ContactDrift[] = [];

  const out = entries.map((entry) => {
    const hits = detectContactDomainDrift(entry.response_content ?? '', canonical);
    if (hits.length === 0) return { ...entry };

    const scoreAfter = Math.min(entry.score, CONTACT_DRIFT_CEILING);
    const verdictAfter = bandForScore(scoreAfter);

    for (const hit of hits) {
      drifts.push({
        ref: entry.ref,
        found: hit.found,
        expected: hit.expected,
        scoreBefore: entry.score,
        scoreAfter,
        verdictBefore: entry.verdict,
        verdictAfter,
      });
    }

    const existing = entry.auto_surfaced;
    const lines = existing === undefined ? [] : Array.isArray(existing) ? [...existing] : [existing];
    for (const hit of hits) {
      const marker = `${CONTACT_DRIFT_MARKER} ${hit.found} (knowledge base holds ${hit.expected})`;
      if (!lines.some((l) => String(l).includes(hit.found) && String(l).includes(CONTACT_DRIFT_MARKER))) {
        lines.push(marker);
      }
    }

    return { ...entry, score: scoreAfter, verdict: verdictAfter, auto_surfaced: lines };
  });

  return { entries: out, drifts };
}

/** Auditable report of every clamp, in the spirit of `overall_score_pre_cap`. */
export function formatContactDomainDriftReport(result: ContactDriftResult): string {
  if (result.drifts.length === 0) {
    return 'Contact-domain drift: none — every contact given matched the knowledge base.';
  }

  const lines = [
    `Contact-domain drift: ${result.drifts.length} clamped to <= ${CONTACT_DRIFT_CEILING.toFixed(1)}`,
  ];
  for (const d of result.drifts) {
    lines.push(
      `  ${d.ref}: ${d.found} -> should be ${d.expected} ` +
        `(${d.scoreBefore.toFixed(1)} ${d.verdictBefore ?? '?'} -> ${d.scoreAfter.toFixed(1)} ${d.verdictAfter})`,
    );
  }

  const refs = [...new Set(result.drifts.map((d) => d.ref))];
  if (refs.length >= 2) {
    lines.push(
      `  [WARN] the same class in ${refs.length} entries (${refs.join(', ')}) — ` +
        'systemic, not noise. The producer-side instruction is already correct ' +
        '(ace#1935); a further prompt edit is not the fix.',
    );
  }

  return lines.join('\n');
}
