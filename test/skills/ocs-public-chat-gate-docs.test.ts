/**
 * ACE's OCS public-chat-URL docs must not cite the deleted allowlist gate
 * (dimagi-internal/ace#1812).
 *
 * For months, five ACE surfaces explained the anonymous chat URL
 * (`/a/<team>/chatbots/<public_id>/start/`) as gated on
 * `experiment_version.is_public`, defined as `len(participant_allowlist) == 0`.
 * OCS deleted that mechanism in #4275 (ADR-0057, merged 2026-08-26):
 *
 *   $ gh search code --repo dimagi/open-chat-studio "is_public"
 *   (empty — while the same search for "participant_allowlist" returns 4 files,
 *    so the empty result is a real absence, not an unindexed repo)
 *
 * `start_session_public` now calls `resolve_published_or_working` and checks the
 * team's WEB channel instead (#4230). Nothing failed when the docs went stale —
 * the removed gate only ever LOOSENED access — which is exactly why it survived
 * three months: a doc that describes a gate that no longer exists produces no
 * symptom until someone triages an outage against it.
 *
 * WHY A TEST AND NOT JUST A FIX: closing an issue deletes its memory. The next
 * author to describe this URL has no signal that `is_public` is retired
 * vocabulary, and the phrase reads plausibly. This test is the memory.
 *
 * SCOPE — deliberately narrow, in two directions:
 *
 *  1. OCS FILES ONLY. `is_public` is ALSO a live, correct field on connect-labs
 *     solicitations (`skills/solicitation-create`, `solicitation-monitor`,
 *     `solicitation-review`, `agents/solicitation-management.md`). A repo-wide
 *     ban would be wrong and would fail on healthy docs, so the scan is an
 *     explicit file list.
 *
 *  2. CHANGE LOGS EXCLUDED. A `## Change Log` row is a dated record of what was
 *     believed on that date. This repo's house style supersedes such rows with
 *     new "Correction:" rows rather than rewriting history, so scanning them
 *     would force us to falsify the archive to get green.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every ACE surface that describes the OCS public chat URL or the v2 inspect
 * payload. If a new one is written, add it here.
 */
const OCS_SURFACES = [
  'lib/ocs-public-chat-url.ts',
  'test/lib/ocs-public-chat-url.test.ts',
  'test/mcp/ocs/fixtures/chatbot-inspect.json',
  'skills/ocs-agent-setup/SKILL.md',
  'skills/ocs-chatbot-qa/SKILL.md',
  'skills/ocs-widget-handoff-eval/SKILL.md',
  'playbook/integrations/ocs-integration.md',
];

/** Symbols OCS deleted in #4275. Naming one as a live mechanism is the defect. */
const RETIRED_SYMBOLS = ['participant_allowlist', 'is_public'];

/** Drop `## Change Log` / `## Change log` onward — dated history, not guidance. */
function liveGuidance(text: string): string {
  const cut = text.search(/^##+\s+change\s*log\b/im);
  return cut === -1 ? text : text.slice(0, cut);
}

describe('OCS public-chat-URL docs vs upstream #4275 (ace#1812)', () => {
  it('every scanned surface exists (a renamed file must not silently drop its guard)', () => {
    for (const rel of OCS_SURFACES) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} is missing`).toBe(true);
    }
  });

  it('no OCS surface cites the deleted is_public / participant_allowlist gate', () => {
    const offenders: string[] = [];
    for (const rel of OCS_SURFACES) {
      const text = liveGuidance(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      text.split('\n').forEach((line, i) => {
        for (const sym of RETIRED_SYMBOLS) {
          if (line.includes(sym)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      'OCS removed `is_public` and the participant allowlist in #4275 (ADR-0057).\n' +
        'The public chat URL now resolves published-OR-WORKING and is gated on the\n' +
        "team's WEB channel being enabled (#4230). Describe that gate instead:\n\n" +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('the surfaces that explain the gate name the WEB-channel gate that replaced it', () => {
    // Without this, "fixing" the issue by deleting the stale sentence would pass
    // the ban above while leaving the live failure mode undocumented.
    for (const rel of ['lib/ocs-public-chat-url.ts', 'skills/ocs-agent-setup/SKILL.md']) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(text, `${rel} must document the team WEB-channel gate`).toMatch(
        /web channel/i,
      );
      expect(text, `${rel} must cite the upstream PR that added it`).toContain('#4230');
    }
  });
});
