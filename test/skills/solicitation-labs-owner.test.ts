/**
 * `solicitation-create` must name a registered owning org and cap
 * `estimated_scale` at 200 chars (dimagi-internal/ace#3049).
 *
 * connect-labs#2567 (2026-10-16) made every `create_solicitation` call owned by
 * a labs organisation the caller belongs to. ACE's per-run Connect PM orgs are
 * not labs orgs until registered, so `program_id` alone was refused on
 * `noora-health/noora-health/20261015-1129`. Separately, `estimated_scale` is a
 * `CharField(max_length=200)` upstream with no schema `maxLength`, so an
 * over-long value surfaces as a raw Postgres `DataError`.
 *
 * The rule is prose an LLM executes, so this pins the prose contract.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL = fs.readFileSync(path.join(REPO_ROOT, 'skills/solicitation-create/SKILL.md'), 'utf8');

function callBlock(): string {
  const start = SKILL.indexOf('mcp__connect-labs__create_solicitation(');
  expect(start).toBeGreaterThan(-1);
  return SKILL.slice(start, SKILL.indexOf(')\n', start));
}

describe('solicitation-create — labs#2567 ownership contract (ace#3049)', () => {
  it('registers the PM org with supply_chain_org_upsert, bound by Connect id', () => {
    const step = SKILL.slice(SKILL.indexOf('5a. **'), SKILL.indexOf('6. **Publish.**'));
    expect(step).toContain('supply_chain_org_upsert');
    expect(step).toContain('connect_organization_id');
    expect(step).toContain('connect_organization_slug');
  });

  it('passes org_slug alongside program_id on the publish call', () => {
    const block = callBlock();
    expect(block).toMatch(/org_slug:/);
    expect(block).toMatch(/program_id:/);
  });

  it('caps estimated_scale at 200 characters in the field table and the checks', () => {
    const row = SKILL.split('\n').find((l) => l.startsWith('   | `estimated_scale`'));
    expect(row).toBeDefined();
    expect(row).toMatch(/200 characters/);
    expect(SKILL).toMatch(/`estimated_scale` is non-empty and \*\*at most 200 characters\*\*/);
  });

  it('carries no compact-variant / 8 KB publish workaround (ace#2993 is fixed upstream)', () => {
    expect(SKILL).not.toMatch(/compact[- ]variant/i);
    expect(SKILL).not.toMatch(/publish a (shortened|compact)/i);
  });
});
