import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * dimagi-internal/ace#2494. The common training-deck modules are included
 * VERBATIM into every deck, so a false line here ships to every FLW audience.
 *
 * - Connect has no per-opportunity chatbot/widget field (CCC-301; every run's
 *   5-ocs/ocs-setup_widget-handoff.md says "There is nothing to paste into
 *   Connect"), and the worker-facing support contract
 *   (skills/_training-template.md § Support channel, ace#1303) routes workers
 *   to a human coordinator, never to the OCS bot.
 * - The opportunity page's button is "Start" (spark-facilitator/20260925-1536,
 *   journey-learn/claim-opp-detail.png; connect-claim-opp.yaml taps btn_start).
 * - The PersonalID start frame's button is "Sign In / Register", not "Sign Up"
 *   (ace#2587, spark-facilitator/20261001-2208 deck slide 6). The authority is
 *   the newest Connect selector map's live-verified nav-drawer-sign-in entry.
 */
const ROOT = join(__dirname, '../../templates/training-deck/_common');
const resources = readFileSync(join(ROOT, 'resources.yaml'), 'utf8');
const platform = readFileSync(join(ROOT, 'platform-setup.yaml'), 'utf8');

describe('common training-deck modules make no false worker-facing claims (ace#2494)', () => {
  it('does not tell workers the chatbot lives in the Connect app', () => {
    expect(resources).not.toMatch(/chatbot[^\n]*in the Connect app/i);
    expect(resources).not.toMatch(/use the chatbot/i);
  });

  it('routes worker help to the human contact', () => {
    expect(resources).toMatch(/\{\{LLO_CONTACT\}\}/);
  });

  it('names the Start button, not a Claim / Start Learning button', () => {
    expect(platform).not.toMatch(/Tap "Claim"/);
    expect(platform).not.toMatch(/"Start Learning"/);
    expect(platform).toMatch(/Tap "Start"/);
  });

  it('captions the PersonalID start frame with the live-verified drawer button text (ace#2587)', () => {
    const selDir = join(__dirname, '../../mcp/mobile/selectors');
    const ver = (f: string) => f.match(/connect-(\d+)\.(\d+)\.(\d+)\.yaml$/)!.slice(1).map(Number);
    const newest = readdirSync(selDir)
      .filter((f) => /^connect-\d+\.\d+\.\d+\.yaml$/.test(f))
      .sort((a, b) => {
        const [x, y] = [ver(a), ver(b)];
        return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
      })
      .pop()!;
    const map = readFileSync(join(selDir, newest), 'utf8');
    const entry = map.split(/\n  nav-drawer-sign-in:\n/)[1]?.split(/\n\n/)[0] ?? '';
    const label = entry.match(/text '([^']+)'/)?.[1];
    expect(label, `${newest} nav-drawer-sign-in should record the live button text`).toBeTruthy();
    const caption = platform.match(/image: "@personal-id-start", caption: "([^"]+)"/)?.[1];
    expect(caption).toBe(`Tap '${label}'`);
    expect(platform).not.toMatch(/Sign Up/);
  });

  it('does not promise an unverified sync indicator', () => {
    expect(platform).not.toMatch(/green check mark/i);
  });
});
