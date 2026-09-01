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

/**
 * Search-before-create rail (issue-filing audit 2026-08-18).
 *
 * CLAUDE.md has mandated a duplicate search before `gh issue create` since
 * the #858/#860 double-filing. It kept being violated the SAME way, and the
 * violations diagnosed themselves in their own close comments:
 *
 *   ace#1141 — "I ran the mandatory duplicate search and the `gh issue create`
 *               in the same shell invocation, so the create executed before I
 *               could read the search results."
 *   ace#1052 — "I ran the required pre-filing search, it returned #1039, and I
 *               created this anyway instead of gating on the result."
 *
 * Chained in one Bash call the search cannot gate anything — the create has
 * already run. That is mechanical, so it gets a rail rather than more prose:
 * the block forces the search into its own call, whose results then land in
 * context before the create decision. Deny-only, so the agent self-corrects
 * and keeps going (CLAUDE.md § hooks are rails, not gates).
 */
describe('gating_guard.py — search-before-create rail (issue-filing audit 2026-08-18)', () => {
  it.each([
    ['&& chain', 'gh issue list --search "resolveEntityIdGrain" --state open && gh issue create --title x --body y'],
    ['; chain', 'gh issue list --search "foo" --state open; gh issue create -t a -b b --label harness'],
    ['newline chain', 'gh issue search "bar"\ngh issue create --title t --body b'],
    ['reverse order', 'gh issue create --title t --body b && gh issue list --search "t"'],
  ])('DENIES search chained with create in one invocation: %s', (_label, command) => {
    const r = runGuard('Bash', { command });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('ONE Bash invocation');
  });

  // The rail must not tax the correct workflow: search, read, then decide.
  it.each([
    ['search alone (the gating call)', 'gh issue list --search "resolveEntityIdGrain" --state open'],
    ['create alone (after reading hits)', 'gh issue create --title "x" --body "y" --label harness'],
    ['a plain backlog listing', 'gh issue list --state open --limit 30 --json number,title'],
    ['commenting on the match instead', 'gh issue comment 1022 --body "adding my repro"'],
    ['gh pr, not gh issue', 'gh pr list --search "issue create"'],
    ['reading one issue', 'gh issue view 1489 --json body'],
  ])('ALLOWS %s', (_label, command) => {
    const r = runGuard('Bash', { command });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBeNull();
  });
});

/**
 * Shared-/tmp `--body-file` rail (ace#1819).
 *
 * While filing ace#1818, a heredoc write to `/tmp/issue_body.md` and the
 * `gh issue create` that consumed it ran in ONE Bash call. The write was
 * denied by the sandbox, so the body was never written — but the path
 * ALREADY EXISTED, holding a stale file left by an unrelated session on a
 * DIFFERENT macOS account (`/private/tmp/claude-501/...-jjackson-...`). gh
 * read that file and published it. ace#1818 shipped with the right title and
 * 3,876 characters of a foreign session's content, including another
 * operator's absolute worktree path, into a dimagi-internal tracker.
 *
 * Two properties make it worth a rail rather than a shrug:
 *
 *   1. It is SILENT. The write failed loudly; the create succeeded. Nothing
 *      correlates the two, so the transcript reads as success.
 *   2. It is a cross-session content-LEAK vector, and the precondition is
 *      real and permanent on this host: two macOS accounts run ACE
 *      concurrently (measured in ace#1821 — nine live `ace-mobile` MCPs on
 *      one account, one on the other). Any file at a predictable shared-tmp
 *      path, from any concurrent session, can be published this way.
 *
 * The generic form: **any `--body-file` argument pointing at a shared,
 * predictable, non-session-scoped path can silently publish content the
 * agent did not write.**
 *
 * The rail is scoped as narrowly as the defect: only `gh issue|pr` +
 * create/comment/edit, only the `--body-file`/`-F` argument, and only when
 * the path sits under the SHARED tmp root. Every session already gets a
 * private scratchpad at `/private/tmp/claude-<uid>/<project>/<session-uuid>/`,
 * which the rail must never touch — a rail that taxed legitimate scratchpad
 * use would be worse than the defect (CLAUDE.md: rails stay NARROW).
 */
describe('gating_guard.py — shared-/tmp --body-file rail (ace#1819)', () => {
  it.each([
    // The exact ace#1818 defect.
    ['the ace#1818 defect verbatim', 'gh issue create --title "x" --body-file /tmp/issue_body.md --label harness'],
    ['/private/tmp spelling (same directory on macOS)', 'gh pr create --title x --body-file /private/tmp/pr_body.md'],
    ['-F short form', 'gh issue comment 1818 -F /tmp/body.md'],
    ['--body-file= equals form', 'gh issue create --body-file=/tmp/x.md --label harness'],
    ['flags before the body-file', 'gh issue create -R dimagi-internal/ace --title t --body-file /tmp/b.md'],
    ['line continuation', 'gh issue edit 1818 \\\n  --body-file /tmp/b.md'],
    ['quoted path', 'gh issue create --title t --body-file "/tmp/issue body.md"'],
    ['a nested but still shared tmp path', 'gh issue create --title t --body-file /tmp/ace/body.md'],
    ['gh pr comment', 'gh pr comment 1773 -F /private/tmp/note.md'],
  ])('DENIES a --body-file at a shared tmp path: %s', (_label, command) => {
    const r = runGuard('Bash', { command });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('scratchpad');
  });

  // The rail must cost the correct workflow nothing. The session scratchpad
  // is the documented place for exactly this file, and it lives UNDER /tmp —
  // so the discriminator is the `claude-<uid>/` segment, not the tmp prefix.
  it.each([
    [
      'session scratchpad, /private/tmp spelling',
      'gh issue create --title t --body-file /private/tmp/claude-502/-Users-acedimagi-emdash-worktrees-ace/943bfed9-e85c-4fa7-a048-8e8a7530ba36/scratchpad/body.md',
    ],
    [
      'session scratchpad, /tmp spelling',
      'gh issue comment 1776 -F /tmp/claude-502/-Users-acedimagi-emdash-worktrees-ace/943bfed9/scratchpad/comment.md',
    ],
    ['inline --body', 'gh issue create --title t --body "a real inline body" --label harness'],
    ['a repo-relative file', 'gh issue create --title t --body-file ./pr-body.md'],
    ['a home-directory file', 'gh pr create --title t --body-file ~/notes/pr-body.md'],
    ['reading a tmp file with no gh publish', 'cat /tmp/issue_body.md'],
    ['a plain listing', 'gh issue list --state open --limit 30'],
    ['viewing an issue', 'gh issue view 1819 --json body'],
    ['gh api is out of scope — -F there means --field', 'gh api repos/dimagi-internal/ace/issues -F body=@/tmp/x.md'],
  ])('ALLOWS %s', (_label, command) => {
    const r = runGuard('Bash', { command });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBeNull();
  });
});
