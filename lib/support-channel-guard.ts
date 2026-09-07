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
  | 'bare-uuid'
  | 'unverified-in-app-control';

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

/**
 * An in-app GRIEVANCE route the worker is told to use — which ACE-built apps
 * do not have (dimagi-internal/ace#2106).
 *
 * ## Why this is the same defect as the OCS host, not a new one
 *
 * #1303 caught artifacts pointing a worker at a destination that does not
 * resolve. This is the same failure with a different pointer: an app MENU
 * that is not on the menu. The consequence is worse, because there is no
 * error page — the worker opens the app, finds six unrelated entries, and
 * stops escalating.
 *
 * ## The reproducer (this is an existence claim, so it needs one)
 *
 *   - The released Deliver CCZ of `hh-poverty-targeting` (HQ app
 *     `ce668763ad6c4b48ac5f4cd4502f3f8c`, domain `connect-ace-prod`) greps
 *     ZERO for `grievance|GRM|complaint|report a problem|report an issue`
 *     across `suite.xml`, `modules-0/forms-0.xml` and both
 *     `app_strings.txt`. Its whole menu is one module and one form.
 *   - `templates/pdd-template.md` and both shipped example PDDs grep zero
 *     for the same terms — there is no PDD section that would designate one,
 *     so the claim's own justification ("the PDD already designates it") was
 *     unsatisfiable on every opportunity.
 *   - On `bednet-check-2-visit/20260902-1555` a live `uiautomator` dump of
 *     the Deliver home under Connect APK 2.64.0 returned `['Update App',
 *     'Saved Forms', 'Change Language', 'About CommCare', 'Advanced',
 *     'Settings']` — no grievance route.
 *
 * ## Why it is not gated on ADDRESSED_TO_READER
 *
 * Same reason as the host rule (ace#1850): the conventional markdown layout
 * puts the addressing verb on the previous line ("## Where to get help" then
 * the bullet). The rule instead requires the phrasing to be INSTRUCTIONAL —
 * a menu/option/route the worker is pointed at — so a document that merely
 * discusses grievance handling in prose does not trip it.
 *
 * If an opportunity ever DOES build a grievance form, the finding is the
 * prompt to prove it from that run's CCZ or ui-dump rather than to assume it.
 */
const IN_APP_GRIEVANCE_RE =
  /\b(?:GRM|grievance|complaint|report[- ]a[- ]problem|report[- ]an[- ]issue)\b[^.\n]{0,60}?\b(?:menu|option|button|tab|screen|route|item)\b|\b(?:menu|option|button|tab|screen|route|item)\b[^.\n]{0,60}?\b(?:GRM|grievance|complaint)\b/i;

/**
 * How far back to look for a negator. 48 characters covers the corrected
 * phrasing this rule must NOT fire on, measured on the repaired
 * `training-flw-guide.md` of `bednet-check-2-visit/20260902-1555`:
 *
 *   "There is no help button and no complaint menu inside these apps"
 *                                    ^-- match starts here; "no" is 3 back,
 *                                        "There is no" is 31 back
 */
const NEGATION_LOOKBACK = 48;

/**
 * Telling a worker the control does NOT exist is the CORRECT output — it is
 * literally what this rule wants produced — so it must not be flagged. A rule
 * that fires on its own remedy is the always-fires-blocker class (ace#1026)
 * and trains producers to ignore every finding it emits.
 */
const NEGATED_RE = /\b(?:no|not|never|without|none|nothing|isn'?t|aren'?t|does\s*n[o']?t|do\s*n[o']?t|cannot|can'?t)\b/i;

/**
 * Is this an INSTRUCTION to use an in-app grievance control, rather than a
 * statement that there isn't one? Exported so the boundary is testable on its
 * own, both ways round.
 */
export function claimsInAppGrievanceControl(text: string): string | null {
  const m = IN_APP_GRIEVANCE_RE.exec(text);
  if (!m) return null;
  const from = Math.max(0, (m.index ?? 0) - NEGATION_LOOKBACK);
  if (NEGATED_RE.test(text.slice(from, (m.index ?? 0) + m[0].length))) return null;
  return m[0];
}

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
      return;
    }

    // ace#2106. Not gated on `addressed` — same layout reason as the host rule.
    const control = claimsInAppGrievanceControl(text);
    if (control) {
      findings.push({ kind: 'unverified-in-app-control', line, match: control, text: text.trim() });
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
    'can open, and a 36-character id cannot be transcribed mid-visit. An in-app grievance menu',
    'is the same failure without an error page: ACE-built apps carry only the modules and forms',
    'the PDD specifies, so the worker finds nothing and stops escalating (ace#2106).',
    ...report.findings.map((f) => `  line ${f.line} [${f.kind}]: ${f.match}\n    ${f.text}`),
    'Fix: name a HUMAN channel — the LLO coordinator / Partner Trainer — as a labelled',
    'fill-in the LLO completes at onboarding (name + phone). Name an IN-APP route only if',
    "this run's own evidence shows one (a commcare_download_ccz grep of app_strings.txt, or",
    'a Phase 6 ui-dump); otherwise omit it. Embed credentials belong ONLY in the LLO-facing',
    'artifacts, whose recipient is the person doing the embedding (dimagi-internal/ace#1303).',
  ].join('\n');
}
