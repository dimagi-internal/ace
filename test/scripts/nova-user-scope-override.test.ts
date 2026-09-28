import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { classifyNovaUserScopeOverride } from '../../scripts/classify-nova-user-scope-override.mjs';

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1629. `bin/ace-doctor`'s `nova_shell_env` probe used to
// blanket-WARN on the EXISTENCE of a user-scope `nova:` MCP entry, calling it
// "stale ... (pre-1.1.0 setup)" and prescribing
// `claude mcp remove nova --scope user`.
//
// Following that remediation deletes the only credential path that works.
// Claude Code 2.1.238 changed what env the interactive-session MCP connect path
// passes to `headersHelper`; Nova's helper is env-var dependent, so it silently
// emits `{}` and sends NO Authorization header (measured on
// spark-facilitator/20260820-0817: 2.1.237 = 32/32 sessions sent a header,
// 2.1.238+ = 0/53). The fix for voidcraft-labs/nova-plugin#52 is a user-scope
// server with a STATIC header, which bypasses the helper — i.e. exactly the
// shape the probe told operators to delete. That run hit the WARN and proceeded
// past it only because a human judged the remediation to be wrong.
//
// The discriminator is therefore the presence of a static Authorization header,
// and this pins both halves: the classification itself, and the doctor actually
// branching on it rather than re-deriving a regex.
// ---------------------------------------------------------------------------

const DOCTOR = readFileSync(fileURLToPath(new URL('../../bin/ace-doctor', import.meta.url)), 'utf8');

/** The real `claude mcp get nova` shape for the #52 workaround, PAT redacted. */
const WORKAROUND = [
  'nova:',
  '  Scope: User config (available in all your projects)',
  '  Status: ✔ Connected',
  '  Type: http',
  '  URL: https://mcp.commcare.app/mcp',
  '  Headers:',
  '    Authorization: Bearer sk-nova-v1-REDACTED',
  '',
  'To remove this server, run: claude mcp remove nova -s user',
].join('\n');

/** The same shape WITHOUT a credential of its own — genuine pre-1.1.0 cruft. */
const STALE = [
  'nova:',
  '  Scope: User config (available in all your projects)',
  '  Status: ✔ Connected',
  '  Type: http',
  '  URL: https://mcp.commcare.app/mcp',
  '',
  'To remove this server, run: claude mcp remove nova -s user',
].join('\n');

describe('classifyNovaUserScopeOverride (ace#1629)', () => {
  it('classifies an entry carrying a static Authorization header as the #52 workaround', () => {
    expect(classifyNovaUserScopeOverride(WORKAROUND)).toBe('workaround');
  });

  it('classifies an entry with no Authorization header as stale', () => {
    expect(classifyNovaUserScopeOverride(STALE)).toBe('stale');
  });

  it('is case-insensitive on the header name', () => {
    // `claude mcp add --header` echoes back whatever the operator typed, and
    // HTTP header names are not case-sensitive on the wire. A case-sensitive
    // match would misfile a working workaround as cruft — the exact direction
    // of error this issue is about.
    expect(classifyNovaUserScopeOverride(WORKAROUND.replace('Authorization:', 'authorization:'))).toBe(
      'workaround',
    );
    expect(classifyNovaUserScopeOverride(WORKAROUND.replace('Authorization:', 'AUTHORIZATION:'))).toBe(
      'workaround',
    );
  });

  it('treats a present-but-empty Authorization header as stale', () => {
    // An empty header authenticates nothing, so it is cruft, not a workaround.
    expect(classifyNovaUserScopeOverride(WORKAROUND.replace(/Bearer sk-nova-v1-REDACTED/, ''))).toBe(
      'stale',
    );
  });

  it('does not match the word Authorization in prose', () => {
    expect(
      classifyNovaUserScopeOverride('nova:\n  Note: no Authorization configured for this server\n'),
    ).toBe('stale');
  });

  it('handles empty / missing input without throwing', () => {
    expect(classifyNovaUserScopeOverride('')).toBe('stale');
    expect(classifyNovaUserScopeOverride(undefined)).toBe('stale');
  });

  it('never echoes any part of its input (the input carries a live PAT)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/classify-nova-user-scope-override.mjs', import.meta.url)),
      'utf8',
    );
    // Exactly one write to stdout, and it emits the classification token.
    const writes = src.split('\n').filter((l) => l.includes('process.stdout.write('));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('classifyNovaUserScopeOverride(buf)');
    expect(src, 'must not log the raw mcp-get output').not.toMatch(/(console\.log|write)\(\s*buf\b/);
  });
});

describe('bin/ace-doctor wires the classification (ace#1629)', () => {
  it('does not prescribe removal unconditionally on a user-scope nova entry', () => {
    // The regression this closes: ONE `warn` under the `nova:` detection, whose
    // fix line said `claude mcp remove nova --scope user`. Assert the removal
    // advice is reachable only from the `stale` branch.
    const block = DOCTOR.slice(DOCTOR.indexOf("grep -qE '^nova:[[:space:]]'"));
    const probe = block.slice(0, block.indexOf('\nfi\n') + 4);
    expect(probe, 'the nova override probe must branch on a classification').toContain(
      'NOVA_OVERRIDE_CLASS',
    );
    expect(probe).toContain('classify-nova-user-scope-override.mjs');
    const removalLines = probe.split('\n').filter((l) => l.includes('claude mcp remove nova'));
    for (const line of removalLines) {
      expect(
        line,
        `"claude mcp remove nova" appears outside the stale/unclassified branches: ${line.trim()}`,
      ).toMatch(/stale|Do not remove it|MUST BE LEFT ALONE/);
    }
  });

  it('has a workaround branch that tells the operator to LEAVE the entry alone', () => {
    expect(DOCTOR).toMatch(/workaround\)/);
    expect(DOCTOR).toContain('voidcraft-labs/nova-plugin#52 workaround, NOT stale cruft');
    expect(DOCTOR).toMatch(/DOCUMENTED API-key path/);
  });

  it('does not fall back to the removal prescription when classification fails', () => {
    // If node is missing or `claude mcp get`'s shape changes, an unclassified
    // entry must NOT inherit the destructive advice — that is the whole defect.
    expect(DOCTOR).toContain('could not be classified');
    expect(DOCTOR).toContain('Do not remove it on the strength of this warning');
  });

  it('pipes the PAT-bearing output on stdin, never through argv', () => {
    // argv is visible in `ps`. The probe must pipe, not pass the header value
    // as an argument, and must not stash it in a shell variable.
    expect(DOCTOR).toMatch(/claude mcp get nova 2>\/dev\/null\s*\\?\s*\n?\s*\| node/);
    expect(
      DOCTOR,
      'the raw `claude mcp get nova` output must not be captured into a shell variable',
    ).not.toMatch(/^\s*NOVA_[A-Z_]*="\$\(claude mcp get nova 2>\/dev\/null\)"/m);
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#2529. Nova plugin v2 (voidcraft-labs/nova-plugin#64)
// removed the headersHelper: the key reaches Nova only through the user-scope
// `nova` entry /ace:setup installs, and the bundled `plugin:nova:nova`
// connection is OAuth-only. On the first v2 setup, `nova_shell_env` WARNed that
// NOVA_API_KEY was missing from Claude's env and `nova_needs_auth_cache` FAILed
// on a needs-auth mark for the plugin connection — both while
// `nova_header_readiness` PASSed. Both probes must now defer to that verdict.
// ---------------------------------------------------------------------------
describe('bin/ace-doctor keys nova_shell_env + nova_needs_auth_cache on nova_header_readiness (ace#2529)', () => {
  it('computes the readiness verdict BEFORE either dependent probe, on the full-doctor surface', () => {
    const verdict = DOCTOR.indexOf('NOVA_HDR_READY=0');
    expect(verdict).toBeGreaterThan(-1);
    expect(verdict).toBeLessThan(DOCTOR.indexOf('pass "nova_shell_env:'));
    expect(verdict).toBeLessThan(DOCTOR.indexOf('NOVA_NEEDS_AUTH_CACHE="$HOME/.claude/mcp-needs-auth-cache.json"'));
    expect(DOCTOR).toContain(`grep -q '^PASS nova_header_readiness' && NOVA_HDR_READY=1`);
  });

  it('computes the readiness verdict BEFORE the cache block on the preflight surface', () => {
    const yaml = DOCTOR.indexOf('PF_NOVA_HDR_YAML="$(cd "$ROOT" && node "$TSX_CLI" scripts/doctor-nova-header.ts --format=yaml');
    const status = DOCTOR.indexOf('PF_NOVA_HDR_STATUS="$(');
    const cache = DOCTOR.indexOf('PF_NOVA_CACHE_FILE="$HOME/.claude/mcp-needs-auth-cache.json"');
    expect(yaml).toBeGreaterThan(-1);
    expect(status).toBeGreaterThan(yaml);
    expect(cache).toBeGreaterThan(status);
  });

  it('nova_shell_env PASSes on a missing session key when readiness PASSes', () => {
    const branch = DOCTOR.indexOf('if [ "$NOVA_HDR_READY" = "1" ] && [ -z "${NOVA_API_KEY:-}" ]; then');
    expect(branch).toBeGreaterThan(-1);
    const next = DOCTOR.slice(branch, DOCTOR.indexOf('\nelif', branch));
    expect(next).toMatch(/^\s*pass "nova_shell_env: not required/m);
  });

  it('a needs-auth mark on plugin:nova:nova is neither a FAIL nor cleared when readiness PASSes', () => {
    // Full doctor: the readiness branch comes before the key-present fail branch.
    const ready = DOCTOR.indexOf('elif [ "$NOVA_CACHE_HAS_NOVA" = "1" ] && [ "$NOVA_HDR_READY" = "1" ]; then');
    const failing = DOCTOR.indexOf('elif [ "$NOVA_CACHE_HAS_NOVA" = "1" ]; then');
    expect(ready).toBeGreaterThan(-1);
    expect(failing).toBeGreaterThan(ready);
    const body = DOCTOR.slice(ready, failing);
    expect(body).toMatch(/pass "nova_needs_auth_cache:/);
    expect(body).not.toMatch(/\bfail "|clear-nova-needs-auth-cache/);

    // Preflight: same precedence, and the supersession is visible in the YAML.
    const pfReady = DOCTOR.indexOf('if [ "$PF_NOVA_HDR_STATUS" = "pass" ]; then');
    const pfFail = DOCTOR.indexOf('elif [ "$PF_NOVA_KEY_PRESENT" = "true" ]; then');
    expect(pfReady).toBeGreaterThan(-1);
    expect(pfFail).toBeGreaterThan(pfReady);
    const pfBody = DOCTOR.slice(pfReady, pfFail);
    expect(pfBody).toContain('PF_NOVA_CACHE_SUPERSEDED=true');
    expect(pfBody).not.toMatch(/PF_NOVA_CACHE_STATUS=fail|clear-nova-needs-auth-cache/);
    expect(DOCTOR).toContain('superseded_by_user_scope_entry: ${PF_NOVA_CACHE_SUPERSEDED}');
  });

  it('remediation text describes the v2 mechanism, not the retired headersHelper env story', () => {
    // The pre-v2 explanation told operators the key was lost from the env a
    // headersHelper reads. v2 has no helper; the fix is the user-scope entry.
    expect(DOCTOR).not.toMatch(/drops NOVA_API_KEY\s+from the env headersHelper sees/);
    expect(DOCTOR).not.toContain("stopped passing its process env to nova's env-dependent headersHelper");
    expect(DOCTOR).toContain('voidcraft-labs/nova-plugin#64');
  });
});
