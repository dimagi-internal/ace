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

  it('mentions gog raw-send in prose WITHOUT an ACE identity token passes', () => {
    // Prose that names the command but carries no adjacent ACE identity
    // (no `--client ace`, no ace@ address, no $ACE_GMAIL_* var) is not a
    // send and stays allowed. NOTE (security audit 2026-07-31): prose that
    // embeds a full ACE-identity invocation IS now conservatively blocked
    // — see the bypass-matrix suite below. A blocked prose mention costs one
    // self-correction; a walked-around send is an unlogged outbound email.
    const r = runGuard('Bash', {
      command: 'git commit -m "docs: explain why raw gog gmail send is blocked"',
    });
    expect(r.exitCode).toBe(0);
  });
});

describe('gating_guard.py — deny-rail bypass matrix (security audit 2026-07-31)', () => {
  // Before this audit the send rail anchored `gog` to the command start and
  // required a literal `ace`/`ace@dimagi-ai.com` token, so a command prefix
  // or the repo's own `--client $ACE_GMAIL_CLIENT` idiom walked straight
  // around it. Each row below was a live ALLOW (bypass) pre-fix.
  const SEND_BYPASSES: Array<[string, string]> = [
    ['env-var assignment prefix', 'FOO=1 gog gmail send --client ace --to x@y'],
    ['absolute path', '/usr/bin/gog gmail send --client ace --to x@y'],
    ['relative path', './gog gmail send --client ace --to x@y'],
    ['command builtin', 'command gog gmail send --client ace --to x@y'],
    ['env wrapper', 'env gog gmail send --client ace --to x@y'],
    ['timeout wrapper', 'timeout 60 gog gmail send --account ace@dimagi-ai.com --to x@y'],
    ['bash -c subshell', "bash -c 'gog gmail send --client ace --to x@y'"],
    ['quote-split token', "g''og gmail send --client ace --to x@y"],
    ['env-var identity (quoted)', 'gog gmail send -a "$ACE_GMAIL_ACCOUNT" --client "$ACE_GMAIL_CLIENT" --to x@y'],
    ['env-var identity (bare)', 'gog gmail send -a $ACE_GMAIL_ACCOUNT --client $ACE_GMAIL_CLIENT --to x@y'],
    ['env-var identity (braced)', 'gog gmail send --client ${ACE_GMAIL_CLIENT} --to x@y'],
    ['uppercase client value', 'gog gmail send --client ACE --to x@y'],
    ['cd-then-env chain', 'cd /tmp && env gog gmail send --account ace@dimagi-ai.com --to x@y'],
  ];
  it.each(SEND_BYPASSES)('DENIES gog send bypass: %s', (_label, command) => {
    const r = runGuard('Bash', { command });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('bin/ace-email');
  });

  it('still ALLOWS a genuine non-ACE-identity send (personal mail is not ours to gate)', () => {
    const r = runGuard('Bash', {
      command: 'env gog gmail send --account jjackson@dimagi.com --client jj --to x@y',
    });
    expect(r.exitCode).toBe(0);
  });

  it('DENIES canopy email send --account via line-continuation', () => {
    const r = runGuard('Bash', {
      command: 'canopy email send --to x@y \\\n  --account ace@dimagi-ai.com',
    });
    expect(r.exitCode).toBe(2);
  });

  it.each([
    ['--out-file long form', 'op inject -i .env.tpl --out-file $CLAUDE_PLUGIN_DATA/.env'],
    ['redirect form', 'op inject -i .env.tpl > $CLAUDE_PLUGIN_DATA/.env'],
    ['plugins/data path', 'op inject -i .env.tpl -o ~/.claude/plugins/data/ace/.env'],
  ])('DENIES op inject plugin-data clobber: %s', (_label, command) => {
    const r = runGuard('Bash', { command });
    expect(r.exitCode).toBe(2);
  });

  it('still ALLOWS op inject to a dev-worktree ./.env', () => {
    const r = runGuard('Bash', { command: 'op inject -i .env.tpl -o ./.env' });
    expect(r.exitCode).toBe(0);
  });
});
