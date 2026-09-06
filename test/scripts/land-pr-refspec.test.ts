/**
 * Tests for `scripts/land-pr.sh` — the PR-landing retry loop.
 *
 * The class under test: the script must resolve its push target from the PR
 * (`headRefName` / `headRefOid`), never from local state. git refuses to check
 * out a branch already checked out in another worktree, so landing from a
 * DIFFERENTLY-NAMED local branch is the normal condition whenever a self-heal
 * ships alongside a live `/ace:run` — exactly when this script is wanted.
 *
 * Before the fix (ace#1974) line 83 pushed a bare `HEAD`, which resolves the
 * remote ref from the LOCAL branch name: it created a stray remote branch, left
 * the PR head untouched, exited 0, and let the script re-arm auto-merge on a PR
 * it had not updated.
 *
 * These run against a throwaway local bare repo with a stubbed `gh` — no
 * network, no GitHub. This is shell/git plumbing, so a hermetic integration
 * test is complete evidence; there is no device truth here.
 *
 * ## Why every spawnSync below carries an explicit timeout
 *
 * `spawnSync` blocks the vitest worker synchronously, so vitest's own
 * `testTimeout` cannot interrupt it — the pool waits for the child no matter
 * what the config says. And the child here is `land-pr.sh`, whose poll loop
 * sleeps `POLL_SECONDS` (20s) × `POLLS_PER_ATTEMPT` (15) = **300s per
 * attempt**. So the moment the `gh` stub stops matching what the script asks
 * for, a case that should fail in under a second instead pins a worker for
 * five minutes. That is latent, not active: the stub matches today and the
 * file runs in ~2.3s. It becomes active on the next edit to the stub.
 *
 * `SPAWN_TIMEOUT_MS` is sized against that 300s budget, not against the happy
 * path: 45s is 2.25× the FIRST `sleep 20` (the smallest unit of hang the
 * script can produce), which leaves generous headroom for a saturated box —
 * ace#1912 measured subprocess-heavy files blowing 5s assertions under the
 * 414-file parallel load `clean-install` actually runs — while still catching
 * a real hang at a seventh of the time it would otherwise cost. A timeout
 * longer than the hang it is meant to catch would be decoration.
 *
 * The last case in this file exercises that timeout against a deliberately
 * hung script, so the guard is observed rather than assumed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const LAND_PR = path.join(REPO_ROOT, 'scripts/land-pr.sh');

/** See "Why every spawnSync below carries an explicit timeout" above. */
const SPAWN_TIMEOUT_MS = 45_000;

const PR_BRANCH = 'fix/1966-longitudinal-program-naming';
const LOCAL_BRANCH = 'ship/1967-rebase';

let root: string;

/** Run a command, throwing on failure. */
function sh(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stdout}\n${r.stderr}`,
    );
  }
  return r.stdout.trim();
}

const git = (args: string[], cwd: string) => sh('git', args, cwd);

/** Branches present on the bare remote. */
function remoteBranches(): string[] {
  return git(['--git-dir', path.join(root, 'remote.git'), 'for-each-ref',
    '--format=%(refname:short)', 'refs/heads'], root)
    .split('\n').filter(Boolean).sort();
}

const remoteSha = (ref: string) =>
  git(['--git-dir', path.join(root, 'remote.git'), 'rev-parse', ref], root);

/**
 * Build: a bare remote with `main` + the PR branch, and a work checkout sitting
 * on a DIFFERENTLY-NAMED local branch that carries the PR's commits plus one
 * more. The remote-tracking ref for the PR branch is deleted, reproducing a
 * worktree that was branched from `main` and never fetched it.
 */
function setup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'land-pr-'));
  const bare = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  git(['init', '--bare', '-q', bare], root);
  git(['clone', '-q', bare, work], root);
  git(['config', 'user.email', 't@example.com'], work);
  git(['config', 'user.name', 'Test'], work);
  git(['config', 'commit.gpgsign', 'false'], work);

  fs.writeFileSync(path.join(work, 'VERSION'), '0.13.1000\n');
  git(['add', '-A'], work);
  git(['commit', '-qm', 'init'], work);
  git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], work);

  // The PR branch, as it exists on the remote.
  git(['checkout', '-qb', PR_BRANCH], work);
  fs.writeFileSync(path.join(work, 'VERSION'), '0.13.1001\n');
  git(['commit', '-qam', 'pr work'], work);
  git(['push', '-q', 'origin', `HEAD:refs/heads/${PR_BRANCH}`], work);

  // The landing agent's checkout: a different NAME, same work.
  git(['checkout', '-qb', LOCAL_BRANCH], work);
  git(['update-ref', '-d', `refs/remotes/origin/${PR_BRANCH}`], work);
  git(['branch', '-qD', PR_BRANCH], work);

  // Stub `version-bump.sh --rebase-first`: produce the rebased commit.
  const scripts = path.join(work, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(LAND_PR, path.join(scripts, 'land-pr.sh'));
  fs.writeFileSync(
    path.join(scripts, 'version-bump.sh'),
    '#!/usr/bin/env bash\nset -e\necho 0.13.1002 > VERSION\n' +
      'git add VERSION scripts\ngit commit -qm rebased\n' +
      // A successful rebase resolves the collision, so the PR stops being
      // DIRTY. Modelling that is what lets the mergeability-aware stub above
      // still land the DIRTY cases below.
      'echo CLEAN > "$GH_STUB_DIR/mergeable"\n',
    { mode: 0o755 },
  );

  // Stubbed `gh`, driven by files under $GH_STUB_DIR.
  const stub = path.join(root, 'stub');
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(
    path.join(stub, 'gh'),
    `#!/usr/bin/env bash
d="$GH_STUB_DIR"
if [ "$2" = "view" ]; then
  f=""; prev=""
  for a in "$@"; do [ "$prev" = "--json" ] && f="$a"; prev="$a"; done
  case "$f" in
    state) cat "$d/state" ;;
    mergeStateStatus) cat "$d/mergeable" ;;
    headRefName) cat "$d/headRefName" ;;
    headRefOid) cat "$d/headRefOid" ;;
  esac
  exit 0
fi
if [ "$2" = "merge" ]; then
  echo "$*" >> "$d/merge.log"
  case "$*" in
    *--disable-auto*) rm -f "$d/armed" ;;
    *--auto*)
      # Auto-merge ARMS. Real GitHub then merges only once the PR is
      # mergeable -- it does NOT merge a BLOCKED or DIRTY PR on the spot.
      # This stub used to merge unconditionally on any --auto, which is
      # what made the MISSING INITIAL ARM invisible here (ace#2004).
      touch "$d/armed"
      [ "$(cat "$d/mergeable")" = "CLEAN" ] && echo MERGED > "$d/state"
      ;;
  esac
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );

  fs.writeFileSync(path.join(stub, 'state'), 'OPEN\n');
  fs.writeFileSync(path.join(stub, 'mergeable'), 'DIRTY\n');
  fs.writeFileSync(path.join(stub, 'headRefName'), `${PR_BRANCH}\n`);
  fs.writeFileSync(path.join(stub, 'headRefOid'), `${remoteSha(PR_BRANCH)}\n`);
  return { work, stub };
}

function runLandPr(work: string, stub: string, timeoutMs = SPAWN_TIMEOUT_MS) {
  return spawnSync('bash', ['scripts/land-pr.sh', '1967', '1'], {
    cwd: work,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${stub}:${process.env.PATH}`,
      GH_STUB_DIR: stub,
      ACE_REPO: 'dimagi-internal/ace',
    },
    timeout: timeoutMs,
  });
}

beforeEach(() => { setup(); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('land-pr.sh push target', () => {
  it('pushes to the PR head branch, not the local branch name', () => {
    const work = path.join(root, 'work');
    const stub = path.join(root, 'stub');
    const before = remoteSha(PR_BRANCH);

    const r = runLandPr(work, stub);
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);

    // The bug: a bare `HEAD` refspec creates a branch named after the LOCAL
    // branch and leaves the PR head where it was.
    expect(remoteBranches()).not.toContain(LOCAL_BRANCH);
    expect(remoteBranches()).toEqual([PR_BRANCH, 'main']);
    expect(remoteSha(PR_BRANCH)).not.toBe(before);
    expect(remoteSha(PR_BRANCH)).toBe(
      git(['rev-parse', 'HEAD'], work),
    );
  });

  it('re-arms auto-merge only after the PR head actually moved', () => {
    const work = path.join(root, 'work');
    const stub = path.join(root, 'stub');
    runLandPr(work, stub);
    const log = fs.readFileSync(path.join(stub, 'merge.log'), 'utf-8');
    expect(log).toMatch(/--disable-auto/);
    expect(log).toMatch(/--auto/);
    // The re-armed head must be the rebased commit, never the pre-rebase one.
    expect(remoteSha(PR_BRANCH)).toBe(git(['rev-parse', 'HEAD'], work));
  });

  it('keeps the lease live: a third-party push to the PR head is not clobbered', () => {
    const work = path.join(root, 'work');
    const stub = path.join(root, 'stub');

    // Someone pushes to the PR branch after the script read headRefOid.
    const other = path.join(root, 'other');
    git(['clone', '-q', path.join(root, 'remote.git'), other], root);
    git(['config', 'user.email', 'o@example.com'], other);
    git(['config', 'user.name', 'Other'], other);
    git(['checkout', '-q', PR_BRANCH], other);
    fs.writeFileSync(path.join(other, 'VERSION'), '0.13.1099\n');
    git(['commit', '-qam', 'third party'], other);
    git(['push', '-q', 'origin', `HEAD:refs/heads/${PR_BRANCH}`], other);
    const theirs = remoteSha(PR_BRANCH);

    const r = runLandPr(work, stub);
    expect(r.status).toBe(2);
    expect(remoteSha(PR_BRANCH)).toBe(theirs);
    expect(remoteBranches()).not.toContain(LOCAL_BRANCH);
  });

  it('refuses to land from a checkout that does not carry the PR commits', () => {
    const work = path.join(root, 'work');
    const stub = path.join(root, 'stub');
    git(['checkout', '-qb', 'unrelated', 'origin/main'], work);
    const before = remoteSha(PR_BRANCH);

    const r = runLandPr(work, stub);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/refusing to land/);
    expect(remoteSha(PR_BRANCH)).toBe(before);
    expect(remoteBranches()).toEqual([PR_BRANCH, 'main']);
    // It must bail BEFORE disarming auto-merge — nothing was touched.
    expect(fs.existsSync(path.join(stub, 'merge.log'))).toBe(false);
  });

  //
  // ace#2004 — the arm, on the path where nothing else arms.
  //
  // The script's only `--auto --merge` used to live inside `if [ "$m" = "DIRTY" ]`,
  // so a PR that was CLEAN on the first read fell straight through to a poll
  // loop having armed nothing, and waited `MAX × POLLS_PER_ATTEMPT` for a merge
  // no one would perform. Measured on poverty-graduation/20260905-0924: #1988
  // (DIRTY) and #1999 (BLOCKED→DIRTY) both landed because the DIRTY branch armed
  // as a side effect; #2003, the one that was CLEAN, hung for >10 minutes against
  // a repo whose create→merge is ~70s, and merged seconds after a manual arm.
  //
  // Note the shape: the failure is INVERSELY correlated with contention. A busy
  // `main` hides it, and the quiet run is the one that hangs.
  //
  describe('the initial arm (ace#2004)', () => {
    it('arms auto-merge when the PR is CLEAN on first read', () => {
      const work = path.join(root, 'work');
      const stub = path.join(root, 'stub');
      fs.writeFileSync(path.join(stub, 'mergeable'), 'CLEAN\n');
      const before = remoteSha(PR_BRANCH);

      const r = runLandPr(work, stub);

      expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
      expect(r.stdout).toMatch(/MERGED/);

      const log = fs.readFileSync(path.join(stub, 'merge.log'), 'utf-8');
      expect(log).toMatch(/--auto/);
      // Nothing to disarm and nothing to rebase: a CLEAN PR must not be
      // force-pushed on its way to being armed.
      expect(log).not.toMatch(/--disable-auto/);
      expect(remoteSha(PR_BRANCH)).toBe(before);
    });

    it('arms a BLOCKED PR too — checks pending is not a reason to wait unarmed', () => {
      // The #1999 shape. Auto-merge exists precisely to hold until checks pass,
      // so BLOCKED is when arming matters most.
      const work = path.join(root, 'work');
      const stub = path.join(root, 'stub');
      fs.writeFileSync(path.join(stub, 'mergeable'), 'BLOCKED\n');

      runLandPr(work, stub, 3_000);

      const log = fs.readFileSync(path.join(stub, 'merge.log'), 'utf-8');
      expect(log).toMatch(/--auto/);
      expect(fs.existsSync(path.join(stub, 'armed'))).toBe(true);
    });

    it('arms only AFTER the ancestry guard — never a PR this checkout does not own', () => {
      // Why the one-line fix in the issue was not the fix. Hoisting a bare arm
      // above the loop would arm before the wrong-worktree guard runs, so
      // pointing the script at the wrong worktree would merge a stranger's PR
      // instead of refusing. The guard had to be hoisted with it.
      const work = path.join(root, 'work');
      const stub = path.join(root, 'stub');
      fs.writeFileSync(path.join(stub, 'mergeable'), 'CLEAN\n');
      git(['checkout', '-qb', 'unrelated', 'origin/main'], work);

      const r = runLandPr(work, stub);

      expect(r.status).toBe(2);
      expect(r.stdout).toMatch(/refusing to land/);
      // The whole point: no arm, no disarm, no merge call of any kind.
      expect(fs.existsSync(path.join(stub, 'merge.log'))).toBe(false);
      expect(fs.existsSync(path.join(stub, 'armed'))).toBe(false);
    });
  });

  // The guard on this file's own guard. Every case above passes whether or not
  // `timeout` is honoured, because none of them hangs — so on its own the
  // option is an unverified claim about the harness. This case makes the
  // script hang on purpose and asserts the kill.
  it('honours the spawn timeout: a hung land-pr.sh is killed, not waited out', () => {
    const work = path.join(root, 'work');
    const stub = path.join(root, 'stub');

    // BLOCKED skips the rebase branch and drops the script into its poll loop,
    // where it sleeps 20s × 15 = 300s before returning. Nothing in vitest can
    // interrupt that — `spawnSync` holds the worker.
    //
    // This case used to use CLEAN, which worked only because the script armed
    // nothing on that path. Now that it does (ace#2004), a CLEAN PR merges and
    // exits instead of hanging — so the hang has to be induced by a state
    // auto-merge legitimately waits in, which is exactly what BLOCKED is.
    fs.writeFileSync(path.join(stub, 'mergeable'), 'BLOCKED\n');

    const t0 = Date.now();
    const r = runLandPr(work, stub, 3_000);
    const elapsed = Date.now() - t0;

    // Reached the poll loop — i.e. it really was sleeping, not failing early
    // for some unrelated reason.
    expect(r.stdout).toMatch(/state=OPEN mergeable=BLOCKED/);
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe('ETIMEDOUT');
    expect(r.signal).toBe('SIGTERM');
    // Aborted mid-sleep: it did not even ride out ONE 20s poll interval, let
    // alone the 300s the script would otherwise have taken.
    expect(elapsed).toBeLessThan(20_000);
  });
});
