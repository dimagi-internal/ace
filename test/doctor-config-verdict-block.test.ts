/**
 * Config / vault drift must be reported as ONE verdict block, not narrated.
 *
 * ## The failure class
 *
 * ACE's config surfaces can disagree about a key — its Canopy vault on
 * canopy-web (authoritative for WHICH keys exist and their values; it replaced
 * the older vault + template pair, which were two surfaces of their own)
 * and the installed `${CLAUDE_PLUGIN_DATA}/.env` (what this machine actually
 * has). `bin/ace-doctor` already detects the drift (`env_drift`). What it did
 * NOT constrain was how the finding is PRESENTED.
 *
 * On 2026-08-26/27 a drift diagnosis was delivered as a running commentary — a
 * hypothesis, then a revision, then another — and Jonathan had to ask:
 *
 *   "is the tpl wrong or agent-ace in 1pass, I'm still confused, and lets
 *    update everything to be ideal, what do you recommend?"
 *
 * Which surface is authoritative IS the question; answering it is the
 * deliverable. So the contract is a single block with four named fields, and it
 * governs an ad-hoc diagnosis in conversation just as much as a `/ace:doctor`
 * run — the ad-hoc path is where it actually failed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const DOC = new URL('../commands/doctor.md', import.meta.url);
const src = () => readFileSync(DOC, 'utf-8');

describe('/ace:doctor config-drift presentation contract', () => {
  it('mandates a single CONFIG VERDICT block', () => {
    expect(src()).toMatch(/CONFIG VERDICT/);
    expect(src()).toMatch(/ONE verdict block/i);
  });

  it('names all four required fields', () => {
    const body = src();
    for (const field of ['Source of truth:', 'What drifted:', 'Recommendation:', 'Needs a human:']) {
      expect(body, `CONFIG VERDICT block is missing the "${field}" field`).toContain(field);
    }
  });

  it('binds the contract to ad-hoc diagnoses, not just the scripted run', () => {
    // The correction that produced this rule came from a conversational
    // diagnosis where /ace:doctor was never run. A contract scoped to the
    // command alone would not have caught it.
    expect(src()).toMatch(/ad hoc in\s+conversation/i);
  });

  it('names the disagreeing surfaces so the verdict cannot hand the question back', () => {
    const body = src();
    expect(body).toMatch(/Canopy\s+vault/);
    expect(body).toMatch(/CLAUDE_PLUGIN_DATA/);
    expect(body).not.toMatch(/\.env\.tpl/);
  });

  it('carries the two footguns a recommendation must not get wrong', () => {
    const body = src();
    // A hand-rewritten .env drops local-only keys; only bin/ace-setup preserves them.
    expect(body).toMatch(/--force-env/);
    expect(body).toMatch(/local-only/i);
    // An MCP subprocess spawned before an .env write holds the old values (ace#880).
    expect(body).toMatch(/restart/i);
  });

  it('forbids shipping a wrong verdict followed by a correction', () => {
    expect(src()).toMatch(/do\s*\n?\s*not ship the wrong verdict/i);
  });
});
