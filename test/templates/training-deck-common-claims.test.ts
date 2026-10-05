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

/**
 * dimagi-internal/ace#2658. No LLO contact exists at Phase 6 (Phase 9 is first
 * LLO contact), so the generator's documented fallback IS the common path. The
 * template labelled the line "Your LLO Manager:" and the fallback was "your LLO
 * manager", so every pre-Phase-9 deck printed "Your LLO Manager: your LLO
 * manager" (spark-facilitator/20261004-1706 deck slide 50), and the generate
 * prompts said to leave a literal {{LLO_CONTACT}} instead.
 */
describe('the help contact renders as a real instruction on a pre-Phase-9 deck (ace#2658)', () => {
  const skill = readFileSync(join(__dirname, '../../skills/training-deck-generate/SKILL.md'), 'utf8');
  const prompts = ['connect-training-atomic', 'connect-training-fgd'].map((t) =>
    readFileSync(join(__dirname, `../../templates/training-deck/${t}/generate.prompt.md`), 'utf8'),
  );
  const fallback = skill.match(/`\{\{LLO_CONTACT\}\}` with the coordinator's name[\s\S]*?otherwise with\s+"([^"]+)"/)?.[1];

  it('documents one fallback value, shared by SKILL and both prompts', () => {
    expect(fallback).toBeTruthy();
    for (const p of prompts) expect(p).toContain(`otherwise with "${fallback}"`);
  });

  it('never tells the generator to leave the placeholder', () => {
    for (const p of prompts) expect(p).not.toMatch(/leave the placeholder\./);
  });

  it('substituting the fallback yields no tautology, no LLO jargon and no leftover token', () => {
    const rendered = resources.replaceAll('{{LLO_CONTACT}}', fallback!);
    const line = rendered.split('\n').find((l) => l.includes(fallback!))!;
    const [label, value] = line.replace(/^\s*-\s*/, '').split(/:\s*/, 2);
    expect(value.toLowerCase()).not.toContain(label.toLowerCase().replace(/^your\s+/, ''));
    const visible = rendered.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(visible).not.toMatch(/\bLLO\b/);
    expect(rendered).not.toContain('{{LLO_CONTACT}}');
  });
});
