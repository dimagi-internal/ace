//
// Detect a user-facing chatbot answer that names an INTERNAL ARTIFACT — a
// knowledge-base filename, a config path, a run-state key — instead of giving
// the value the file holds.
//
// Why this exists: on `spark-facilitator/20260828-0703` (the first real
// `/ace:qa-deep` run) the per-opp bot routed escalation to a FILENAME in
// **7 of 68 entries** — telling a field supervisor to consult
// `00-program-contacts.md`, which they cannot open. The deep verdict's own
// wording:
//
//   [WARN] Systemic escalation-routing weakness, 7 entries (opp-20, opp-29,
//   opp-42, opp-46, opp-52, opp-57, cg-2): the bot defers the ACE contact to a
//   source file it names as `00-program-contacts.md` instead of stating
//   `ace@dimagi-ai.com`. On opp-20 and opp-34 the expected escalation row was
//   never satisfied at all. A supervisor cannot open a KB filename.
//
// In 2 of those the bot ALSO emitted the wrong domain from recall while
// pointing at the file ("The contact is in `00-program-contacts.md` … if you do
// not have that file to hand, use ace@dimagi.com").
//
// The defect is narrow and is NOT "the file should not exist": the file is
// generated deliberately (ace#1665) and being retrievable is the whole point —
// an address the prompt carries and the corpus does not is reproduced from
// recall, which is what drifted three times on a 73-prompt run. What the setup
// prompt got wrong was telling the bot to quote *from a named file*, which
// invites the model to name the file. `skills/ocs-agent-setup` fixes the
// instruction; this module is the detector on the eval side, because a response
// that names a machine artifact to a user is a defect regardless of which
// rubric dimension notices it.
//
// Deliberately NOT flagged: user-facing document formats (`.pdf`, `.docx`,
// `.pptx`, `.xlsx`) — a facilitator genuinely may have been handed
// "Facilitator Handbook.pdf", so naming it is help, not leakage.
//

import { bandForScore } from './fabrication-clamp.js';
import type { TerminalVerdict } from './eval-verdict-bands.js';

/** Machine-artifact extensions a field user has no way to open. */
export const INTERNAL_ARTIFACT_EXTENSIONS: readonly string[] = [
  'md',
  'markdown',
  'yaml',
  'yml',
  'json',
  'csv',
  'tsv',
  'xml',
  'ts',
  'js',
  'py',
  'sh',
  'sql',
  'env',
  'log',
];

/** A response that names an internal artifact cannot be a `pass`. */
export const INTERNAL_ARTIFACT_LEAK_CEILING = 6.0;

const FILE_RE = new RegExp(
  // optional path prefix, then <name>.<ext> on a token boundary
  `(?:[A-Za-z0-9_./-]*/)?[A-Za-z0-9_-]+\\.(?:${INTERNAL_ARTIFACT_EXTENSIONS.join('|')})\\b`,
  'gi',
);

/**
 * Every internal-artifact name a response mentions, de-duplicated, in order of
 * first appearance. Backticks/quotes around the name are stripped by the
 * tokenizer, so both `` `00-program-contacts.md` `` and a bare mention match.
 */
export function detectInternalArtifactNames(responseText: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of String(responseText ?? '').matchAll(FILE_RE)) {
    const name = m[0];
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export interface LeakEntry {
  ref: string;
  score: number;
  verdict?: TerminalVerdict;
  /** The bot's reply, as captured in the transcript. */
  response_content?: string;
  [k: string]: unknown;
}

export interface InternalArtifactLeak {
  ref: string;
  names: string[];
  scoreBefore: number;
  scoreAfter: number;
  verdictBefore?: TerminalVerdict;
  verdictAfter: TerminalVerdict;
  /** The `auto_surfaced` line to emit. */
  marker: string;
}

export interface InternalArtifactLeakResult {
  entries: LeakEntry[];
  leaks: InternalArtifactLeak[];
}

/**
 * Cap every entry whose response names an internal artifact at
 * `INTERNAL_ARTIFACT_LEAK_CEILING` (warn). An answer that routes a user to a
 * file they cannot open has not answered — whatever else it got right.
 *
 * Run it in the same deterministic post-pass as `applyFabricationClamp`, after
 * the per-entry judgments and before any suite rule or gate.
 */
export function applyInternalArtifactLeakCap(
  entries: LeakEntry[],
): InternalArtifactLeakResult {
  const leaks: InternalArtifactLeak[] = [];
  const out = entries.map((entry) => {
    const names = detectInternalArtifactNames(entry.response_content ?? '');
    if (names.length === 0) return { ...entry };

    const scoreAfter = Math.min(entry.score, INTERNAL_ARTIFACT_LEAK_CEILING);
    const verdictAfter = bandForScore(scoreAfter);
    const marker =
      `[INTERNAL-ARTIFACT-NAMED] ${names.join(', ')} — named to the user instead of ` +
      'giving the value; a field user cannot open a knowledge-base file (ace#1665 follow-up)';
    leaks.push({
      ref: entry.ref,
      names,
      scoreBefore: entry.score,
      scoreAfter,
      ...(entry.verdict !== undefined ? { verdictBefore: entry.verdict } : {}),
      verdictAfter,
      marker,
    });
    return { ...entry, score: scoreAfter, verdict: verdictAfter };
  });
  return { entries: out, leaks };
}

/** Human summary for the eval's stdout + report. */
export function formatInternalArtifactLeakReport(
  result: InternalArtifactLeakResult,
): string {
  if (result.leaks.length === 0) {
    return 'internal-artifact-leak: no response names an internal artifact';
  }
  const lines = [
    `internal-artifact-leak: ${result.leaks.length} response(s) named an internal ` +
      `artifact to the user — capped at <=${INTERNAL_ARTIFACT_LEAK_CEILING}`,
  ];
  for (const l of result.leaks) {
    lines.push(
      `  ${l.ref}: ${l.names.join(', ')} — ${l.scoreBefore} ` +
        `(${l.verdictBefore ?? 'unscored'}) -> ${l.scoreAfter} (${l.verdictAfter})`,
    );
  }
  if (result.leaks.length >= 2) {
    lines.push(
      `  [WARN] systemic: ${result.leaks.length} entries route the user to a file ` +
        'rather than answering — fix the composed system prompt, not the entries ' +
        '(skills/ocs-agent-setup § Step 7)',
    );
  }
  return lines.join('\n');
}
