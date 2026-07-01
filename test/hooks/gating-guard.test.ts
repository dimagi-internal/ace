/**
 * Gating-guard preventer suite.
 *
 * hooks/gating_guard.py enforces ACE's deny rails at the tool-call boundary:
 * raw `gog gmail send|reply` under the ACE identity is hard-blocked (exit 2)
 * with a message pointing at bin/ace-email, so the agent self-corrects and
 * keeps going. There are deliberately NO approve/ask rules — interactive
 * permission prompts stall autonomous runs; ACE governs outbound moments
 * procedurally (pause points, review posture, solicitation-review's HITL
 * checkpoint). See config/gating.json's _doc.
 *
 * These tests spawn the real hook with real PreToolUse JSON so a regex edit
 * in config/gating.json (or a guard refactor) can't silently turn "blocked"
 * into "allowed" — or "allowed" into a run-stalling prompt.
 *
 * The guard is stdlib-only python3 by design (it runs under whatever python3
 * is on PATH in an installed plugin); the tests spawn `python3` the same way.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(REPO_ROOT, 'hooks', 'gating_guard.py');

interface GuardResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  decision: string | null;
}

function runGuard(toolName: string, toolInput: Record<string, unknown>): GuardResult {
  const r = spawnSync('python3', [GUARD], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
  });
  let decision: string | null = null;
  if (r.stdout.trim()) {
    try {
      decision = JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision ?? null;
    } catch {
      decision = null;
    }
  }
  return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, decision };
}

describe('gating_guard.py', () => {
  it('DENIES raw gog gmail send under the ACE account', () => {
    const r = runGuard('Bash', {
      command: 'gog gmail send --account ace@dimagi-ai.com --to x@y.com --subject hi --body yo',
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('bin/ace-email');
  });

  it('DENIES raw gog gmail reply under the ACE client', () => {
    const r = runGuard('Bash', { command: 'gog gmail reply --client ace 18c abc --body ok' });
    expect(r.exitCode).toBe(2);
  });

  it('allows raw gog gmail send under a NON-ACE identity (operator mail is not ours to gate)', () => {
    const r = runGuard('Bash', {
      command: 'gog gmail send --account jjackson@dimagi.com --client jj --to x@y.com',
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBeNull();
  });

  it('allows gog gmail search/read (reads are free)', () => {
    const r = runGuard('Bash', {
      command: 'gog gmail search "in:inbox is:unread" --account ace@dimagi-ai.com --client ace --json',
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBeNull();
  });

  it('does NOT prompt on bin/ace-email — sends are governed procedurally, not by modal asks', () => {
    const r = runGuard('Bash', {
      command: 'bin/ace-email --to llo@example.org --subject "Onboarding" --body-file /tmp/b.txt',
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBeNull();
  });

  it('does NOT prompt on outbound MCP atoms (pause points govern those, not hooks)', () => {
    for (const name of [
      'mcp__plugin_ace_ace-connect__connect_send_llo_invite',
      'mcp__connect_labs__award_response',
    ]) {
      const r = runGuard(name, { anything: true });
      expect(r.exitCode, name).toBe(0);
      expect(r.decision, name).toBeNull();
    }
  });

  it('allows ordinary Bash', () => {
    const r = runGuard('Bash', { command: 'ls -la && git status' });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBeNull();
  });

  it('never blocks on malformed hook input (fail-open by design)', () => {
    const r = spawnSync('python3', [GUARD], { input: 'not json', encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  it('mentions gog raw-send in prose without tripping the deny (command-boundary anchoring)', () => {
    const r = runGuard('Bash', {
      command: 'git commit -m "docs: explain why gog gmail send --client ace is blocked"',
    });
    expect(r.exitCode).toBe(0);
  });
});
