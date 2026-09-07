/**
 * ace#174 — the probe must actually be WIRED, on both surfaces.
 *
 * This test exists because of a specific, documented failure on this very
 * issue: its acceptance criteria were once marked met while `bin/ace-doctor`
 * contained no `nova_scopes` probe at all (issue comment, 2026-08). A pure
 * classifier with no caller is the same defect as an atom with no caller —
 * this week's most-repeated one (PR #2055, `auditComposedPrompt`,
 * `ACE_SELECTOR_MAP`, `frameworkComponentIds`).
 *
 * `test/lib/nova-scope-probe.test.ts` proves the logic. This proves it runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../..');
const doctor = readFileSync(join(REPO_ROOT, 'bin/ace-doctor'), 'utf8');

describe('nova_scopes is wired into bin/ace-doctor (ace#174)', () => {
  it('the backing script exists', () => {
    expect(existsSync(join(REPO_ROOT, 'scripts/doctor-nova-scopes.ts'))).toBe(true);
  });

  it('runs in the human [Auth liveness] block, in --format=lines', () => {
    expect(doctor).toMatch(/doctor-nova-scopes\.ts --format=lines/);
  });

  it('runs in --preflight, in --format=yaml', () => {
    // ace#174 comment 2: preflight is what /ace:run gates on before Phase 1,
    // and that is where the whole saving is. A probe only in the full doctor
    // run catches a partially-scoped key when someone happens to type
    // /ace:doctor — which is not when the ~25-minute Nova build starts.
    expect(doctor).toMatch(/doctor-nova-scopes\.ts --format=yaml/);
    expect(doctor).toMatch(/\$\{PF_NOVA_SCOPES_YAML\}/);
  });

  it('runs AFTER nova_auth, so a bad bearer is reported by the probe that owns it', () => {
    const authAt = doctor.indexOf('nova_auth: ace-nova authed');
    const scopesAt = doctor.indexOf('doctor-nova-scopes.ts --format=lines');
    expect(authAt).toBeGreaterThan(-1);
    expect(scopesAt).toBeGreaterThan(authAt);
  });

  it('has a preflight fallback block, so a missing script cannot break the YAML parse', () => {
    // Same contract nova_header_readiness keeps: the preflight snapshot is
    // parsed by the orchestrator, and an absent block is a parse failure
    // rather than a skipped check.
    const at = doctor.indexOf('PF_NOVA_SCOPES_YAML="nova_scopes:');
    expect(at, 'no fallback block for PF_NOVA_SCOPES_YAML').toBeGreaterThan(-1);
  });
});

describe('the probe stays inside doctor’s charter', () => {
  const script = readFileSync(join(REPO_ROOT, 'scripts/doctor-nova-scopes.ts'), 'utf8');

  it('makes exactly ONE Nova call, and it is a read', () => {
    // "setup health, not artifact correctness" (feedback_doctor_scope). A
    // probe that started building or uploading anything would be grading
    // artifacts; get_hq_connection reads a connection setting and nothing else.
    const calls = [...script.matchAll(/name:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(calls).toEqual(['get_hq_connection']);
    expect(script).not.toMatch(/upload_app_to_hq|create_app|compile_app/);
  });

  it('never takes doctor down', () => {
    expect(script).toMatch(/process\.exit\(0\)/);
    expect(script).toMatch(/catch \{/);
  });

  it('emits the exact PASS/WARN/FAIL prefixes the summary counts', () => {
    // bin/ace-doctor tees stdout and counts `^FAIL ` / `^WARN ` / `^PASS `
    // lines for its verdict table (there is no mark_fail helper any more — the
    // grep IS the convention). The script prints its own lines verbatim, so a
    // label that did not match would silently drop out of the summary.
    expect(script).toMatch(/'PASS'/);
    expect(script).toMatch(/v\.status\.toUpperCase\(\)/);
    expect(doctor).toMatch(/_DOCTOR_FAIL=\$\(grep -c '\^FAIL '/);
  });
});
