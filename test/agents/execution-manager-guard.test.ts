/**
 * The Phase 9 guard and its single simulated-mode carve-out
 * (spec 2026-10-18 § G; plan PR10; commissioned by ace#3152).
 *
 * Phase 9 is the first phase that contacts a real LLO, and it is not live:
 * `agents/execution-manager.md` halts before any step. The optional labs
 * track adds exactly one exception — a simulated block that contacts no one.
 * Two things must stay true as that file is edited:
 *
 *   1. Real mode still halts, with the same message, and the carve-out is
 *      gated on ALL of `mode: simulated`, an `optional_steps` block, and a
 *      synthetic winner, so no single stray field turns real Phase 9 on.
 *   2. The simulated block never names a real-LLO action: no Connect program
 *      invite, no ACE email send, no `llo-onboarding` / `llo-uat` /
 *      `llo-launch`. A name in the block is how a later edit would start
 *      calling it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = fs.readFileSync(path.join(__dirname, '../../agents/execution-manager.md'), 'utf-8');

function section(md: string, heading: string): string {
  const start = md.indexOf(`\n${heading}\n`);
  if (start === -1) return '';
  const rest = md.slice(start + heading.length + 2);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

const SIMULATED = section(SRC, '## Simulated mode');
const BODY = SRC.replace(/^---\n[\s\S]*?\n---\n/, '');
const GUARD = BODY.slice(0, BODY.indexOf('\n## '));

describe('execution-manager guard', () => {
  it('real mode still halts before any step with the existing message', () => {
    expect(GUARD).toMatch(/NOT YET LIVE — do not run/);
    expect(GUARD).toMatch(/halt immediately before any step/);
    expect(GUARD).toContain('Phase 9 (execution-management) is not yet live; aborting before any');
  });

  it('the carve-out needs mode: simulated AND an optional_steps block AND a synthetic winner', () => {
    expect(GUARD).toMatch(/mode: simulated/);
    expect(GUARD).toMatch(/optional_steps/);
    expect(GUARD).toMatch(/synthetic_winner/);
    expect(GUARD).toMatch(/Any one of the[\s>]+three missing means real mode: halt/);
  });

  it('has a simulated block', () => {
    expect(SIMULATED.length).toBeGreaterThan(200);
  });

  it.each([
    ['connect_send_llo_invite', /connect_send_llo_invite/],
    ['bin/ace-email', /bin\/ace-email/],
    ['llo-onboarding', /llo-onboarding/],
    ['llo-uat', /llo-uat/],
    ['llo-launch', /llo-launch/],
    ['connect_create_opportunity', /connect_create_opportunity/],
    ['connect_activate_opportunity', /connect_activate_opportunity/],
  ])('the simulated block never names %s', (_name, re) => {
    expect(SIMULATED).not.toMatch(re);
  });

  it('the simulated block dispatches only the optional-track skills', () => {
    const dispatched = [...SIMULATED.matchAll(/^### S\d: `([a-z-]+)`/gm)].map((m) => m[1]);
    expect(dispatched).toEqual(['supply-chain-setup', 'supply-chain-procure', 'supply-chain-fulfil', 'simulated-execution']);
  });

  it('negative control: the section reader finds a planted forbidden name', () => {
    const planted = SRC.replace('### S1: `supply-chain-setup`', '### S1: `supply-chain-setup` then llo-onboarding');
    expect(section(planted, '## Simulated mode')).toMatch(/llo-onboarding/);
  });
});
