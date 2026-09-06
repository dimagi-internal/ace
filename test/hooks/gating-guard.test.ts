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
  //
  // The scratchpad filenames below carry a distinguishing slug because
  // ace#2019 added a second rail over the BASENAME (see the last describe):
  // the scratchpad is shared by every concurrent subagent, so a generic name
  // there is its own defect. This rail is still the one under test — the
  // names only stop the two rails from being conflated.
  it.each([
    [
      'session scratchpad, /private/tmp spelling',
      'gh issue create --title t --body-file /private/tmp/claude-502/-Users-acedimagi-emdash-worktrees-ace/943bfed9-e85c-4fa7-a048-8e8a7530ba36/scratchpad/issue-1819-shared-tmp.md',
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

/**
 * The 2026-09-05 RECURRENCE (ace#1819, reopened).
 *
 * The rail above shipped 2026-09-01 (PR #1902) and the class recurred four
 * days later anyway. PR #1989's published body carries its own correction
 * note: "the first published body was a different session's content."
 *
 * The transcript says exactly how, and it is not a regex-width problem — it
 * is the rail's own failure mode. The agent issued ONE Bash call holding a
 * heredoc write to `/tmp/pr1-body.md` and, 142 lines later, the
 * `gh pr create --body-file /tmp/pr1-body.md` that consumed it. The rail
 * denied the whole call. Denying a compound write-then-publish kills the
 * WRITE and leaves the stale file exactly where it was — so the rail did not
 * prevent the defect, it armed it. The recovery then published the four-day-
 * old file through a path the rail could not see:
 *
 *   SCRATCH=/private/tmp/claude-502/.../scratchpad && cp /tmp/pr1-body.md "$SCRATCH/pr1-body.md" \
 *     && wc -c "$SCRATCH/pr1-body.md" && gh pr create ... --body-file "$SCRATCH/pr1-body.md"
 *
 * `wc -c` printed 4912 — byte-for-byte the stale /tmp/pr1-body.md written on
 * 2026-09-01 by an unrelated session. The `--body-file` argument pointed at
 * the scratchpad, so the rail read it as the CORRECT shape.
 *
 * Hence two changes, both measured below:
 *
 *   1. FAIL TOWARD A WRITTEN FILE. A command that writes a shared-tmp path is
 *      exempt — it authors its own body microseconds before reading it, and
 *      blocking it is what strands a stale file for the next command to
 *      publish. (Prefer the scratchpad; the rail no longer punishes not
 *      preferring it, because the punishment was worse than the crime.)
 *   2. BAN THE LAUNDERING. A shared-tmp path anywhere in a command that also
 *      publishes through --body-file/-F is denied — cp, mv, cat-redirect, or
 *      a variable — unless (1) exempts it. This also retires the old
 *      `[\s\S]{0,300}` distance bound, which a long --title walked straight
 *      past (measured: allowed before this change, denied after).
 *
 * Known accepted cost: the rail matches command TEXT, so a Bash heredoc whose
 * payload quotes one of these invocations (this file, or a doc about the
 * rail) is denied too. Author those with the Write tool — the rail is scoped
 * to Bash.
 */
describe('gating_guard.py — the 2026-09-05 recurrence (ace#1819 reopened)', () => {
  const SCRATCH =
    '/private/tmp/claude-502/-Users-acedimagi-emdash-worktrees-ace-c89535f9/333124ed-9d80-49f3-9c9b-325475d7aab2/scratchpad';
  const SHARED = '/tmp/pr1-body.md';
  // Same shared root, a name no other session invents — so the ace#2019
  // basename rail stays out of this describe's negative controls.
  const SHARED_UNIQUE = '/tmp/pr-body-1819-recurrence.md';

  // POSITIVE CONTROLS — every one of these was ALLOWED by the shipped rail,
  // and every one publishes a file the command did not write.
  it.each([
    [
      'the PR #1989 launder verbatim: cp a stale shared-tmp file into the scratchpad, publish from a variable',
      `SCRATCH=${SCRATCH} && cp ${SHARED} "$SCRATCH/pr1-body.md" && wc -c "$SCRATCH/pr1-body.md" && ` +
        'gh pr create -R dimagi-internal/ace --head feat/avd-pool-bootstrap ' +
        '--title "feat(mobile-bootstrap): --pool N puts a second AVD in the pool (ace#1821)" ' +
        '--body-file "$SCRATCH/pr1-body.md"',
    ],
    [
      'launder via cat redirect',
      `cat /tmp/pr-body.md > ${SCRATCH}/b.md && gh issue create --title t --body-file ${SCRATCH}/b.md`,
    ],
    [
      'launder via mv',
      `mv /tmp/pr2-body.md ${SCRATCH}/b.md && gh pr edit 1989 --body-file ${SCRATCH}/b.md`,
    ],
    [
      'the shared-tmp path held in a shell variable',
      'B=/tmp/pr-body.md && gh pr create --title t --body-file "$B"',
    ],
    [
      'a --title long enough to walk past the old 300-char distance bound',
      'gh pr create -R dimagi-internal/ace --head feat/x ' +
        `--title "feat(mobile-bootstrap): ${'x'.repeat(320)}" --body-file /tmp/pr-body.md`,
    ],
  ])('DENIES %s', (_label, command) => {
    const r = runGuard('Bash', { command });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('scratchpad');
  });

  // NEGATIVE CONTROLS — the rail must fail TOWARD a written file. The first
  // two were DENIED by the shipped rail, and that denial is precisely what
  // left the stale file in place for the launder above to publish.
  //
  // ace#2019 UPDATE: these three now carry a slug in the filename. The
  // fail-toward-a-written-file invariant they encode is unchanged and still
  // under test here; what changed is that a GENERIC basename under a tmp root
  // is independently denied by the ace#2019 rail (last describe), because the
  // scratchpad is shared by concurrent subagents. Spelling these fixtures with
  // `pr1-body.md` would test the other rail by accident, so they name a file
  // no sibling can collide with — which is also what the skill now requires.
  it.each([
    [
      'the compound heredoc-write-then-create the rail used to block (the #1989 shape)',
      `cat > ${SHARED_UNIQUE} <<'EOF'\n## What this fixes\nbody text\nEOF\n` +
        'gh pr create -R dimagi-internal/ace --head feat/x ' +
        '--title "feat(mobile-bootstrap): --pool N puts a second AVD in the pool (ace#1821)" ' +
        `--body-file ${SHARED_UNIQUE} 2>&1 | tail -3`,
    ],
    [
      'the same shape written with tee',
      `echo hi | tee ${SHARED_UNIQUE} >/dev/null && gh pr create --title t --body-file ${SHARED_UNIQUE}`,
    ],
    [
      'a write-then-create wholly inside the scratchpad, at a collision-proof name (the shape we actually want)',
      `cat > ${SCRATCH}/agent-1819/pr-body-1819-recurrence.md <<'EOF'\nbody\nEOF\n` +
        `gh pr create --title t --body-file ${SCRATCH}/agent-1819/pr-body-1819-recurrence.md`,
    ],
    [
      'copying WITHIN the scratchpad then publishing',
      `cp ${SCRATCH}/a.md ${SCRATCH}/b.md && gh pr create --title t --body-file ${SCRATCH}/b.md`,
    ],
    ['a pure write to a shared-tmp path with no gh publish at all', `cat > ${SHARED} <<'EOF'\nbody\nEOF`],
  ])('ALLOWS %s', (_label, command) => {
    const r = runGuard('Bash', { command });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBeNull();
  });

  // Non-inertness: the rail is still doing work, not passing everything.
  it('is not inert — the original ace#1818 shape is still denied', () => {
    const r = runGuard('Bash', { command: 'gh pr create --title t --body-file /tmp/pr-body.md' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('scratchpad');
  });
});

/**
 * ace#2019 — the EXEMPTED path is not safe either: the session scratchpad is
 * shared by every concurrent subagent, so a generic basename collides there.
 *
 * The two rails above both end at the same remediation: "write it to THIS
 * session's scratchpad." That advice is correct about `/tmp` and wrong about
 * isolation. One directory is handed to every subagent of a session and it
 * survives restarts. Measured on this host, 2026-09-06, in a scratchpad a
 * fresh subagent was handed:
 *
 *   $ ls -la <scratchpad> | grep -iE ' (pr|issue|body)[-_]?[0-9]*(body)?[-_]?(body)?\.md$'
 *   -rw-r--r--  8518  Sep 2 14:33  body589.md      -rw-r--r--  12976 Sep 5 13:46  pr1-body.md
 *   -rw-r--r--  5744  Sep 2 14:35  issue587.md     -rw-r--r--   4726 Sep 4 15:24  pr1body.md
 *   -rw-r--r--  11441 Sep 5 09:43  pr-body.md      -rw-r--r--  12847 Sep 5 14:12  pr2-body.md
 *   … ten generic basenames, four sessions, five days, one directory.
 *
 * `pr1-body.md` is the file in the incident: written by the subagent shipping
 * ace#1950 at 13:38 and overwritten by a SIBLING from the same dispatch batch
 * at 13:46. The first agent had already published, so nothing landed wrong —
 * the window was real and the ordering was luck.
 *
 * WHY THIS RAIL CANNOT REPEAT #2011's FAIL-TOWARD-DANGER SHAPE. #2011's
 * measured harm was that denying a compound write-then-publish killed the
 * write, left a stale file readable, and the recovery RELOCATED that stale
 * file to a blessed path — which the path-keyed rail then read as correct.
 * This rail is keyed on the BASENAME, and a basename travels with the file:
 * `cp`/`mv`/`cat`-redirect of a generic file into a unique name still carries
 * the generic name in the command text, so every single-command relocation is
 * denied too (positive control below). A denial here can be satisfied ONLY by
 * choosing a new name, and a new name has no stale predecessor by
 * construction — the safe state is the only reachable one. The residual is
 * the same one #2011 has: a launder split across two Bash calls is invisible
 * to a hook that sees one command at a time.
 *
 * Known accepted cost, inherited: the rail matches command TEXT, so a heredoc
 * whose payload QUOTES one of these invocations is denied along with one that
 * runs it. This file and skills/shipping/SKILL.md were both authored with the
 * `Write` tool for that reason; the rail is Bash-scoped.
 */
describe('gating_guard.py — generic body-file basenames in the shared scratchpad (ace#2019)', () => {
  const SCRATCH =
    '/private/tmp/claude-502/-Users-acedimagi-emdash-worktrees-ace-c89535f9/333124ed-9d80-49f3-9c9b-325475d7aab2/scratchpad';
  const AGENT = `${SCRATCH}/agent-2019`;
  const UNIQUE = `${AGENT}/pr-body-2019-basenames.md`;

  // POSITIVE CONTROLS — every one of these was ALLOWED before this change.
  // The first six are the exact basenames living in that directory today.
  it.each([
    ['pr-body.md, the canonical one', `gh pr create --title t --body-file ${SCRATCH}/pr-body.md`],
    [
      'pr1-body.md, the file actually overwritten on 2026-09-05',
      `gh pr create -R dimagi-internal/ace --title t --body-file ${SCRATCH}/pr1-body.md`,
    ],
    ['pr2body.md, the no-dash sibling spelling', `gh pr create --title t --body-file ${SCRATCH}/pr2body.md`],
    [
      'issue587.md via gh issue create',
      `gh issue create --title t --body-file ${SCRATCH}/issue587.md --label harness`,
    ],
    ['body589.md via gh issue comment -F', `gh issue comment 2019 -F ${SCRATCH}/body589.md`],
    ['issue_body.md, the underscore spelling', `gh issue create --title t --body-file ${SCRATCH}/issue_body.md`],
    [
      'digits alone are not a distinguisher: pr-body-2019.md',
      `gh pr create --title t --body-file ${SCRATCH}/pr-body-2019.md`,
    ],
    [
      'a compound write-then-publish at a generic name — the write is what clobbers a SIBLING',
      `cat > ${SCRATCH}/pr-body.md <<'EOF'\nbody\nEOF\ngh pr create --title t --body-file ${SCRATCH}/pr-body.md`,
    ],
    [
      'RELOCATION: cp a generic scratchpad file to a unique name, then publish it',
      `cp ${SCRATCH}/pr-body.md ${UNIQUE} && gh pr create --title t --body-file ${UNIQUE}`,
    ],
    [
      'relocation via mv',
      `mv ${SCRATCH}/pr1-body.md ${UNIQUE} && gh pr edit 2010 --body-file ${UNIQUE}`,
    ],
    [
      'a --title long enough to walk past any distance bound',
      `gh pr create --head feat/x --title "${'x'.repeat(320)}" --body-file ${SCRATCH}/pr-body.md`,
    ],
  ])('DENIES %s', (_label, command) => {
    const r = runGuard('Bash', { command });
    expect(r.exitCode).toBe(2);
    // Attribution: it is THIS rail firing, not the shared-/tmp rail above.
    expect(r.stderr).toContain('GENERIC basename');
  });

  // NEGATIVE CONTROLS — the contract has to stay cheap to obey, and the rail
  // must not tax surfaces where the shared-directory hazard does not exist.
  it.each([
    ['the contract: an agent-scoped, issue-and-slug name', `gh pr create --title t --body-file ${UNIQUE}`],
    [
      'the contract, written and published in one breath',
      `cat > ${UNIQUE} <<'EOF'\nbody\nEOF\ngh pr create --title t --body-file ${UNIQUE}`,
    ],
    [
      'an issue body at a unique name',
      `gh issue create --title t --body-file ${AGENT}/issue-2019-shared-scratchpad.md --label harness`,
    ],
    ['a scratchpad file that is simply not a generic body name', `gh issue comment 2019 -F ${SCRATCH}/comment.md`],
    ['a repo-relative body file — a worktree checkout is per-agent', 'gh pr create --title t --body-file ./pr-body.md'],
    ['inline --body', 'gh issue create --title t --body "a real inline body" --label harness'],
    ['reading a generic scratchpad file with no gh publish', `cat ${SCRATCH}/pr-body.md`],
    ['gh api -F is --field, not --body-file', `gh api repos/dimagi-internal/ace/issues -F body=@${SCRATCH}/pr-body.md`],
    ['a plain listing', 'gh pr list --state open --limit 30'],
  ])('ALLOWS %s', (_label, command) => {
    const r = runGuard('Bash', { command });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBeNull();
  });

  // Non-inertness, stated as a differential: the ONLY difference between the
  // denied command and the allowed one is the slug in the basename.
  it('is not inert — the same publish flips on the basename alone', () => {
    const generic = runGuard('Bash', { command: `gh pr create --title t --body-file ${SCRATCH}/pr-body.md` });
    const slugged = runGuard('Bash', {
      command: `gh pr create --title t --body-file ${SCRATCH}/pr-body-2019-basenames.md`,
    });
    expect(generic.exitCode).toBe(2);
    expect(generic.stderr).toContain('GENERIC basename');
    expect(slugged.exitCode).toBe(0);
  });
});
