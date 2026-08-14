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
