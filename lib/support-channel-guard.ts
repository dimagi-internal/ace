//
// Does a WORKER-FACING training artifact name a support channel a field worker
// can actually reach?
//
// Why this exists: dimagi-internal/ace#1303. Every Phase 6 worker-facing
// artifact on spark-facilitator/20260813-2126 told the CBF to get help at
// `https://www.openchatstudio.com` plus a 36-character chatbot UUID. Those are
// **embed credentials**, not a destination — the same run's
// `ocs-setup_widget-handoff.md` records `/chatbots/embed/<public_id>/`
// live-probing 404, because OCS serves the bot only as an embedded corner
// widget with no standalone chat page, and Connect has no per-opportunity
// widget field to embed it into (CCC-301). So Phase 5 correctly produces
// credentials and Phase 6 has nothing to turn them into.
//
// Two independent `-eval` skills flagged it on two artifacts in the same run
// without coordination, and a third producer (`training-flw-guide`) reasoned
// its way to a different answer. Three producers, three answers to one
// question — a contract gap, not three bad lines. Hence a shared check plus a
// shared contract in `skills/_training-template.md`.
//
// Scope: worker-facing artifacts only. Credentials are CORRECT in the
// LLO-facing ones (`training-llo-guide`, `training-onboarding-email`), whose
// recipient is the person doing the embedding.
//

export type SupportChannelFindingKind =
  | 'unresolvable-ocs-host'
  | 'known-404-embed-path'
  | 'bare-uuid';

export interface SupportChannelFinding {
  kind: SupportChannelFindingKind;
  /** 1-indexed line in the artifact. */
  line: number;
  /** The offending text. */
  match: string;
  text: string;
}

export interface SupportChannelReport {
  ok: boolean;
  findings: SupportChannelFinding[];
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/**
 * Is this line telling the READER to use the thing, rather than merely
 * recording it? Precision guard: an artifact that carries an opp id as a
 * provenance footer is fine, and flagging it would make this the
 * always-fires-blocker class (ace#1026) that trains producers to ignore it.
 */
const ADDRESSED_TO_READER =
  /\b(ask|help|support|contact|chat|assistant|question|reach|use|open|enter|visit|go to|type)\b/i;

/** The embed path ace#1303 live-probed as a 404 — looks like a URL, is not one. */
const EMBED_404_RE = /openchatstudio\.com\/chatbots\/embed\/[0-9a-f-]{36}/i;

/**
 * The OCS host, wherever it appears and whatever follows it.
 *
 * This rule is deliberately UNCONDITIONAL and PATH-AGNOSTIC (ace#1850). It used
 * to read `openchatstudio\.com(?![\w/])\/?` — a negative lookahead requiring
 * that NOTHING follow the host — and to additionally require
 * `ADDRESSED_TO_READER` on the same line. Both halves inverted the coverage:
 *
 *   - Every real per-opp URL has a path (`/a/<team>/chatbots/<uuid>/start/`), so
 *     the lookahead meant the rule could only ever fire on a bare host carrying
 *     no credentials — the harmless form — and never on the credential-bearing
 *     form it exists to stop.
 *   - A markdown support link is conventionally a heading plus the bare URL on
 *     its own line, which puts the addressing word on the PREVIOUS line. So the
 *     most common layout matched nothing at all and the guard returned
 *     `ok: true` on the exact artifact it was built to block.
 *
 * `skills/_training-template.md § Support channel` states the contract with no
 * addressing condition: presence of the host in a worker-facing artifact IS the
 * violation. The scheme is optional because a schemeless `openchatstudio.com/...`
 * is the same disclosure.
 *
 * `ADDRESSED_TO_READER` is retained for `bare-uuid` ONLY, where the ace#1026
 * precision concern is real — see that rule below.
 */
const OCS_HOST_RE = /(?:https?:\/\/)?(?:www\.)?openchatstudio\.com(?:\/\S*)?/i;

export function checkWorkerFacingSupportChannel(markdown: string): SupportChannelReport {
  const findings: SupportChannelFinding[] = [];
  const lines = markdown.split('\n');

  lines.forEach((text, i) => {
    const line = i + 1;
    /** Consumed by the `bare-uuid` rule ONLY — see ADDRESSED_TO_READER. */
    const addressed = ADDRESSED_TO_READER.test(text);

    const embed = EMBED_404_RE.exec(text);
    if (embed) {
      findings.push({ kind: 'known-404-embed-path', line, match: embed[0], text: text.trim() });
      return; // one finding per line is enough to send the author back to it
    }

    // Unconditional: NOT gated on `addressed` (ace#1850).
    const host = OCS_HOST_RE.exec(text);
    if (host) {
      findings.push({ kind: 'unresolvable-ocs-host', line, match: host[0], text: text.trim() });
      return;
    }

    const uuid = UUID_RE.exec(text);
    if (uuid && addressed) {
      findings.push({ kind: 'bare-uuid', line, match: uuid[0], text: text.trim() });
    }
  });

  return { ok: findings.length === 0, findings };
}

export function formatSupportChannelReport(report: SupportChannelReport): string {
  if (report.ok) {
    return 'support-channel: reachable — no OCS embed credentials presented to the worker';
  }
  return [
    `support-channel: ${report.findings.length} unreachable pointer(s) in a WORKER-FACING artifact —`,
    'OCS serves the bot only as an embedded corner widget (no standalone chat page; the',
    '`/chatbots/embed/<public_id>/` path live-probes 404), and Connect has no per-opportunity',
    'widget field to embed it into (CCC-301). A host + UUID is not a destination a field worker',
    'can open, and a 36-character id cannot be transcribed mid-visit.',
    ...report.findings.map((f) => `  line ${f.line} [${f.kind}]: ${f.match}\n    ${f.text}`),
    'Fix: name a HUMAN channel (the LLO coordinator / Partner Trainer) plus the app\'s own',
    'in-app grievance route (GRM menu). Embed credentials belong ONLY in the LLO-facing',
    'artifacts, whose recipient is the person doing the embedding (dimagi-internal/ace#1303).',
  ].join('\n');
}
