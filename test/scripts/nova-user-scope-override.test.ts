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
    expect(DOCTOR).toContain('nova-plugin#52 workaround, NOT stale cruft');
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
