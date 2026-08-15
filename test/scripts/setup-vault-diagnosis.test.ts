/**
 * ace#986 — `op inject` is all-or-nothing and every ref in `.env.tpl` lives in
 * one vault, so a vault-LEVEL lockout surfaced as a cryptic line about
 * whichever ref op happened to hit first. It read as "a bad field" and cost
 * days; the deployed ace-web runner then ran with an empty env for weeks.
 *
 * Also corrects a claim that was in three places and is empirically false.
 * Measured here against op 2.32.1:
 *
 *   output file pre-exists, 1 bad ref  -> rc=1, file left COMPLETELY INTACT
 *   output file absent,     1 bad ref  -> rc=1, file NOT CREATED
 *
 * `op inject` fails BEFORE writing. That is why a provisioned workstation kept
 * working on its previous .env while a fresh container got nothing — the exact
 * asymmetry that made this ambiguous for weeks.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');
const setup = readFileSync(join(REPO, 'bin/ace-setup'), 'utf8');
const doctor = readFileSync(join(REPO, 'bin/ace-doctor'), 'utf8');
const tpl = readFileSync(join(REPO, '.env.tpl'), 'utf8');

describe('the vault-reachability preflight (ace#986)', () => {
  it('probes the vault before running the all-or-nothing inject', () => {
    const probeAt = setup.indexOf('op vault get "$OP_VAULT"');
    const injectAt = setup.indexOf('op inject -i "$INJECT_TPL"');
    expect(probeAt).toBeGreaterThan(-1);
    expect(probeAt).toBeLessThan(injectAt);
  });

  it('names it an ACCESS problem, not a bad field', () => {
    expect(setup).toMatch(/ACCESS problem, not a bad field/);
  });

  it('says a 1Password admin must grant it — the action, not the symptom', () => {
    expect(setup).toMatch(/admin must grant this principal/);
  });

  it('calls out that the runner uses its own service account', () => {
    // The original report was a human dev account; the blocking case is the
    // deployed runner's SA, and confusing the two cost a round trip.
    expect(setup).toMatch(/service\s*\n?\s*#?\s*account, not your user/);
  });

  it('skips the inject once the vault is unreadable', () => {
    expect(setup).toMatch(/skipping op inject/);
  });

  it('still distinguishes a per-ITEM failure when the vault IS readable', () => {
    expect(setup).toMatch(/missing ITEM or FIELD rather than an access problem/);
  });
});

describe('no green line after a failed inject', () => {
  it('guards the all-resolved pass on the inject having succeeded', () => {
    // `$ENV_OUT` carries no op:// refs after a failed inject simply because op
    // never wrote it. Absence of unresolved refs is not evidence of success.
    const idx = setup.indexOf('pass "env: all 1Password references resolved"');
    expect(idx).toBeGreaterThan(-1);
    const before = setup.slice(Math.max(0, idx - 600), idx);
    expect(before).toMatch(/SKIP_INJECT/);
    expect(before).toMatch(/INJECT_RC/);
  });
});

describe('the EMPTY-.env claim is corrected everywhere it appeared', () => {
  it.each([
    ['.env.tpl', tpl],
    ['bin/ace-doctor', doctor],
  ])('%s no longer says op inject writes an empty .env', (_name, text) => {
    expect(text).not.toMatch(/writes an EMPTY \.env for every consumer/);
  });

  it('.env.tpl states the measured behaviour instead', () => {
    expect(tpl).toMatch(/BEFORE writing/);
    expect(tpl).toMatch(/2\.32\.1/);
  });

  it('doctor explains why a workstation survived and a container did not', () => {
    // This asymmetry IS the triage lesson — without it the next reader
    // repeats the "it works here" confusion.
    expect(doctor).toMatch(/fresh machine or container/i);
  });
});
