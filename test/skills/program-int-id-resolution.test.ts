/**
 * The Connect program's integer id (`connect_int_id`) must be resolved through
 * labs, and registered in the opp's tenancy whenever it is (ace#3213).
 *
 * Connect never returns the integer to ACE: `ProgramResponseSerializer` has no
 * `id`, the HTML create form answers with a fragment, every program page keys
 * on the UUID, and only the OAuth `export` API emits it. Labs holds that token
 * but caches the org tree for an hour, so `labs_context` misses a fresh
 * program (connect-fi/20261018-1440: four empty lookups over 20 minutes). The
 * skills used to tell the agent to read `int_id` off the create response, so
 * `ace-bind --add-program` never ran. This pins the prose contract.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');
const PROGRAM_SETUP = read('skills/connect-program-setup/SKILL.md');
const SOLICITATION = read('skills/solicitation-create/SKILL.md');

describe('connect-program-setup resolves connect_int_id via labs (ace#3213)', () => {
  const step6a = PROGRAM_SETUP.slice(
    PROGRAM_SETUP.indexOf('6a. **'),
    PROGRAM_SETUP.indexOf('7. **Register the program'),
  );

  it('no longer tells the agent to capture int_id from the create response', () => {
    expect(PROGRAM_SETUP).not.toMatch(/Capture `connect_int_id` from the `connect_create_program` response/);
    expect(PROGRAM_SETUP).not.toMatch(/from the create response's `int_id`/);
  });

  it('has a Step 6a that resolves through labs_context with an exact name match', () => {
    expect(step6a.length).toBeGreaterThan(200);
    expect(step6a).toContain('labs_context');
    expect(step6a).toMatch(/equals the Connect program name exactly/);
    expect(step6a).toMatch(/never pick by "newest id"/);
  });

  it('names the hour-long labs cache and the retry + residual', () => {
    expect(step6a).toContain('_ORG_DATA_CACHE_TTL = 3600');
    expect(step6a).toMatch(/END of Phase 4/);
    expect(step6a).toContain('--add-program');
  });
});

describe('solicitation-create registers the program when it resolves the id (ace#3213)', () => {
  const step5 = SOLICITATION.slice(
    SOLICITATION.indexOf('5. **Resolve the labs program_id (integer).**'),
    SOLICITATION.indexOf('5a. **'),
  );

  it('runs ace-bind --add-program after a lookup, before program-scoped writes', () => {
    expect(step5).toContain('"$CLAUDE_PLUGIN_ROOT/bin/ace-bind" --add-program <connect_int_id>');
    expect(step5).toMatch(/BEFORE any\s+program-scoped labs write/);
  });

  it('rules out the labs cache before halting on a missing program', () => {
    expect(step5).toContain('_ORG_DATA_CACHE_TTL = 3600');
  });
});
