/**
 * dimagi-internal/ace#1303 — every Phase 6 worker-facing artifact named
 * `https://www.openchatstudio.com` + a 36-character chatbot UUID as the CBF's
 * support channel. Those two strings are **embed credentials**, not a
 * destination: the same run's `ocs-setup_widget-handoff.md` records
 * `/chatbots/embed/<public_id>/` live-probing **404**, because OCS serves the
 * bot only as an embedded corner widget with no standalone chat page. Connect
 * has no per-opportunity widget field either (CCC-301), so there is nothing to
 * embed it into.
 *
 * Two independent `-eval` skills flagged it on two artifacts in the same run
 * without coordination — `training-quick-reference-eval` (support line 5/10,
 * "cannot be transcribed mid-visit, and there is no human fallback") and
 * `training-faq-eval` ("the single most important finding… a Phase-6-wide
 * pattern"). `training-flw-guide` reasoned correctly and declined to invent a
 * `/chat/<id>` link, routing to the coordinator instead — three producers, three
 * different answers to the same question, which is what makes this a contract
 * gap rather than three bad lines.
 *
 * Pure string logic over produced markdown, so it is unit-testable rather than
 * device-truth, and it would have caught all three artifacts before the evals.
 */
import { describe, it, expect } from 'vitest';

import {
  checkWorkerFacingSupportChannel,
  formatSupportChannelReport,
} from '../../lib/support-channel-guard.js';

const UUID = '08a81855-7c70-4cac-b349-931f4759736d';

/**
 * The URL that actually shipped on `spark-facilitator/20260828-0703` — a real
 * per-opp OCS chat URL, complete with team slug, chatbot UUID and `/start/`
 * path. Kept verbatim (not templated from UUID) because ace#1850 is precisely a
 * bug about the SHAPE of a real URL: every one of them carries a path, and the
 * old host regex could only match a host with nothing after it.
 */
const REAL_PER_OPP_URL =
  'https://www.openchatstudio.com/a/connect-ace/chatbots/075abf86-b9bb-476f-8b9e-eed1d1f24785/start/';

describe('checkWorkerFacingSupportChannel (#1303)', () => {
  it('flags a bare openchatstudio host with no resolving path', () => {
    const md = `## Getting help\n\nAsk the assistant at https://www.openchatstudio.com (chatbot id ${UUID}).\n`;
    const report = checkWorkerFacingSupportChannel(md);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.kind)).toContain('unresolvable-ocs-host');
  });

  it('flags a bare chatbot UUID a worker is told to transcribe', () => {
    const md = `Support: open the chat widget and enter ${UUID}.\n`;
    const report = checkWorkerFacingSupportChannel(md);
    expect(report.findings.map((f) => f.kind)).toContain('bare-uuid');
  });

  it('flags the known-404 embed path even though it looks like a URL', () => {
    const md = `Get help at https://www.openchatstudio.com/chatbots/embed/${UUID}/\n`;
    const report = checkWorkerFacingSupportChannel(md);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.kind)).toContain('known-404-embed-path');
  });

  it('passes a human channel plus the in-app GRM route', () => {
    const md = [
      '## Getting help',
      '',
      '1. Ask your LLO coordinator (Partner Trainer) — contact details on your onboarding sheet.',
      '2. Use the **Report a problem** menu in the app to raise a grievance (GRM).',
      '',
    ].join('\n');
    const report = checkWorkerFacingSupportChannel(md);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('does not flag an unrelated UUID-shaped id in a non-support context', () => {
    // Precision matters: over-flagging a doc that merely records an opp id
    // would make this the always-fires blocker class (#1026). Only a UUID
    // presented to the READER as something to use trips it.
    const md = `_Generated for opportunity ${UUID} — internal reference only._\n`;
    const report = checkWorkerFacingSupportChannel(md);
    expect(report.ok).toBe(true);
  });

  it('names the artifact line so the fix is one edit away', () => {
    const md = `Line one\nAsk at https://www.openchatstudio.com with id ${UUID}\nLine three\n`;
    const report = checkWorkerFacingSupportChannel(md);
    expect(report.findings[0].line).toBe(2);
    expect(formatSupportChannelReport(report)).toMatch(/line 2/);
  });
});

/**
 * dimagi-internal/ace#1850 — the guard returned `ok: true` on the exact
 * artifact it exists to block, and did so on the SAME opportunity that created
 * the rule (`spark-facilitator`, run 20260828-0703 vs the precedent run
 * 20260813-2126). Two independent defects, both in `checkWorkerFacingSupportChannel`:
 *
 *   1. `BARE_HOST_RE`'s `(?![\w/])` lookahead required nothing to follow the
 *      host, so the rule could never fire on a real per-opp URL (all of which
 *      have a path). Coverage was inverted — the harmless bare host was caught,
 *      the credential-bearing URL was not.
 *   2. Both the host and UUID rules were gated on `ADDRESSED_TO_READER` matching
 *      the SAME line. A URL on its own line under a `## Support` heading has no
 *      addressing word on its line, so nothing fired.
 *
 * A guard that returns `ok: true` is worse than no guard: it converts "I should
 * check this by hand" into "the checker cleared it." The producing agent ran the
 * guard, got a pass, shipped the URL, and flagged it for a human anyway on prose
 * grounds — the guard actively argued against the correct answer.
 *
 * Case A is THE regression test: it is the case that shipped.
 */
describe('worker-facing OCS host is unconditional and path-agnostic (#1850)', () => {
  it('A. flags a real per-opp URL on its own line under a heading', () => {
    // The most natural way to write a support link in markdown: the addressing
    // word ("Support") is on the HEADING line, the URL is alone on its own.
    const md = `## Support\n\n${REAL_PER_OPP_URL}\n`;
    const report = checkWorkerFacingSupportChannel(md);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.kind)).toContain('unresolvable-ocs-host');
    expect(report.findings[0].line).toBe(3);
  });

  it('B. flags a real per-opp URL on a reader-addressed line', () => {
    // Previously caught, but by the WRONG rule: the host rule could not fire, so
    // this only tripped `bare-uuid` via the UUID embedded in the path. It is now
    // correctly attributed to the host rule, which is the real violation — the
    // UUID rule no longer needs to overlap it.
    const md = `Ask the support bot: ${REAL_PER_OPP_URL}\n`;
    const report = checkWorkerFacingSupportChannel(md);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.kind)).toEqual(['unresolvable-ocs-host']);
  });

  it('C. still flags a bare host on a reader-addressed line (no regression)', () => {
    const md = 'Ask the support bot at https://www.openchatstudio.com\n';
    const report = checkWorkerFacingSupportChannel(md);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.kind)).toEqual(['unresolvable-ocs-host']);
  });

  it('D. still attributes the embed path to known-404-embed-path (no regression)', () => {
    // The embed rule runs first and returns, so widening the host rule does not
    // steal this finding's more specific kind.
    const md =
      'Ask here: https://www.openchatstudio.com/chatbots/embed/075abf86-b9bb-476f-8b9e-eed1d1f24785\n';
    const report = checkWorkerFacingSupportChannel(md);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.kind)).toEqual(['known-404-embed-path']);
  });

  it('does not become the always-fires blocker: a bare provenance UUID still passes', () => {
    // The precision half of the fix (ace#1026). `ADDRESSED_TO_READER` is RETAINED
    // for `bare-uuid`, so a UUID recorded as provenance — no addressing word, no
    // openchatstudio host — is still clean. Widening the host rule must not leak
    // into the UUID rule.
    const md = `_Run provenance: opportunity ${UUID}, generated 2026-08-28._\n`;
    const report = checkWorkerFacingSupportChannel(md);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
