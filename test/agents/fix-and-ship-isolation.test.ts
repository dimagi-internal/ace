import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A dispatched fix-and-ship subagent must run in its OWN git worktree.
 *
 * ## The failure class (ace#2001)
 *
 * A subagent inherits the dispatcher's working directory. Neither
 * `orchestrator-reference.md § Fix-and-ship subagent template` nor
 * `skills/shipping` said anything about WHERE the edit -> branch -> commit ->
 * PR loop runs, so a dispatched agent ran `git checkout -b`, `git add -A` and
 * `scripts/version-bump.sh` inside the ORCHESTRATOR'S worktree, concurrently
 * with the orchestrator.
 *
 * On poverty-graduation/20260905-0924:
 *
 *   09:31:52  orchestrator  commits its own fix        -> PR #1988
 *   09:48:13  Phase 1 agent checkout: emdash/... -> fix/decision-vocabularies...
 *   09:51:04  Phase 1 agent git add -A + commit        -> PR #1995
 *   10:08:16  orchestrator  commits its NEXT fix, silently onto that branch
 *
 * PRs #1995 and #1999 still carry the same headRefName under unrelated titles.
 * Both merged with correct content — nothing failed, which is why it survived.
 * Across the 09:48->09:51 window either actor's `git add -A` would have swept
 * the other's in-progress edits into its own commit; only a happens-to-be-clean
 * tree prevented it. A separate incident the same day put two agents in one
 * tree that was missing 10 files present on `main`; committing there would have
 * DELETED them from `main`.
 *
 * It scales the wrong way, too: § Self-heal sweep rule 2 says eleven
 * self-healable issues is eleven dispatches. Eleven agents branching and
 * staging in one shared worktree is a guaranteed, and silent, collision.
 *
 * ## Why this is a test and not a paragraph
 *
 * The fix is a FLAG (`isolation: "worktree"`), which the harness enforces —
 * a worktree-isolated agent's unverifiable `git` invocation is refused rather
 * than run. The failure mode is the flag being forgotten at one of the two
 * dispatch sites, or the `--expect-branch` backstop being documented in the
 * skill while absent from the script. Both are cross-file drift, so the four
 * surfaces are asserted AGAINST EACH OTHER rather than each against itself.
 */

const REPO = join(__dirname, '..', '..');

const FLAG = 'isolation: "worktree"';
const BACKSTOP = '--expect-branch';

/** Owns the incident write-up; the dispatch sites cite it by name. */
const ANCHOR_OWNER = 'agents/orchestrator-reference.md';
const DEFAULT_ANCHOR = 'Dispatch it into its OWN worktree';

/** Both places that LAUNCH a fix-and-ship subagent. */
const DISPATCH_SITES = ['agents/orchestrator-reference.md', 'agents/ace-orchestrator.md'] as const;

const SKILL = 'skills/shipping/SKILL.md';
const SCRIPT = 'scripts/version-bump.sh';

const norm = (s: string) => s.replace(/\s+/g, ' ');

export function checkIsolationContract(
  corpus: Record<string, string>,
  ANCHOR = DEFAULT_ANCHOR,
): string[] {
  const v: string[] = [];

  // 1. The anchor section exists and carries the flag verbatim. Paraphrasing
  //    it ("use an isolated worktree") is not copy-pasteable into an Agent
  //    call, which is the only form that actually prevents the incident.
  const owner = norm(corpus[ANCHOR_OWNER] ?? '');
  if (!owner.includes(`### ${ANCHOR}`)) {
    v.push(`${ANCHOR_OWNER}: missing the anchor section "### ${ANCHOR}"`);
  }

  // 2. BOTH dispatch sites mandate the flag. One alone is the bug: the sweep
  //    is what fans out to N, the template is what a one-off dispatch reads.
  for (const f of DISPATCH_SITES) {
    if (!norm(corpus[f] ?? '').includes(FLAG)) {
      v.push(`${f}: a fix-and-ship dispatch site must name ${FLAG} verbatim`);
    }
  }

  // 3. The sweep cites the anchor, so the incident is one hop from the
  //    fan-out rather than re-summarised (and drifting) in two places.
  if (!norm(corpus['agents/ace-orchestrator.md'] ?? '').includes(ANCHOR)) {
    v.push(`agents/ace-orchestrator.md: does not cite "${ANCHOR}" by name`);
  }

  // 4. The skill's ship loop records the branch AND passes it. Recording it
  //    without asserting it is exactly the state the incident was already in.
  const skill = norm(corpus[SKILL] ?? '');
  if (!skill.includes('BRANCH="$(git branch --show-current)"')) {
    v.push(`${SKILL}: the ship loop must RECORD the branch before editing`);
  }
  if (!skill.includes(`bash scripts/version-bump.sh ${BACKSTOP} "$BRANCH"`)) {
    v.push(`${SKILL}: the ship loop must pass ${BACKSTOP} "$BRANCH" to the bump`);
  }
  if (!skill.includes(FLAG)) {
    v.push(`${SKILL}: must name ${FLAG} as the real fix the backstop backs up`);
  }

  // 5. The script actually IMPLEMENTS the flag the skill invokes, refuses
  //    non-zero, and does so BEFORE any git state is touched — the guard is
  //    worthless after `git add -A` has already staged a stranger's edits.
  const script = corpus[SCRIPT] ?? '';
  if (!script.includes(`${BACKSTOP})`)) {
    v.push(`${SCRIPT}: does not implement ${BACKSTOP} that ${SKILL} invokes`);
  }
  if (!/exit 4/.test(script)) {
    v.push(`${SCRIPT}: ${BACKSTOP} must refuse with a distinct non-zero exit`);
  }
  const guard = script.indexOf('REFUSING to bump');
  const firstGitState = script.indexOf('REPO_ROOT="$(git rev-parse --show-toplevel)"');
  if (guard === -1 || firstGitState === -1 || guard > firstGitState) {
    v.push(`${SCRIPT}: the ${BACKSTOP} guard must run BEFORE any repo read or write`);
  }

  return v;
}

const FILES = [ANCHOR_OWNER, 'agents/ace-orchestrator.md', SKILL, SCRIPT];
function liveCorpus(): Record<string, string> {
  return Object.fromEntries(FILES.map((f) => [f, readFileSync(join(REPO, f), 'utf8')]));
}

describe('fix-and-ship worktree isolation (ace#2001)', () => {
  it('the four live surfaces satisfy it', () => {
    expect(checkIsolationContract(liveCorpus())).toEqual([]);
  });

  /**
   * CONTROL 1 — mutation, per file. Neuter each surface and count. Pinned
   * exactly, so a later refactor that silently drops a check is visible
   * rather than merely still-green.
   */
  it('control: neutering any ONE surface fails, and only that surface', () => {
    const counts: Record<string, number> = {};
    for (const f of FILES) {
      const violations = checkIsolationContract({ ...liveCorpus(), [f]: '# gutted\n' });
      counts[f] = violations.length;
      expect(violations.length, `${f} is not load-bearing`).toBeGreaterThan(0);
      expect(violations.every((x) => x.startsWith(f))).toBe(true);
    }
    expect(counts).toEqual({
      'agents/orchestrator-reference.md': 2, // anchor heading + the flag
      'agents/ace-orchestrator.md': 2, // the flag + the anchor citation
      'skills/shipping/SKILL.md': 3, // record + pass + name the flag
      'scripts/version-bump.sh': 3, // implements + exit 4 + ordering
    });
  });

  /**
   * CONTROL 2 — the two dispatch sites are independently required. Documenting
   * the flag in the template while the SWEEP forgets it is the realistic
   * regression: the sweep is the site that fans out to eleven.
   */
  it('control: the flag in the template alone does not cover the sweep', () => {
    const live = liveCorpus();
    const corpus = {
      ...live,
      'agents/ace-orchestrator.md': live['agents/ace-orchestrator.md']
        .split(FLAG)
        .join('an isolated worktree'),
    };
    expect(checkIsolationContract(corpus)).toEqual([
      `agents/ace-orchestrator.md: a fix-and-ship dispatch site must name ${FLAG} verbatim`,
    ]);
  });

  /**
   * CONTROL 3 — the doc/script cross-assertion. The skill invoking a flag the
   * script does not implement is a silent no-op with an exit 0, which is the
   * worst possible shape for a guard. Removing the flag from the script alone
   * must fail even though every document still reads perfectly.
   */
  it('control: dropping the flag from the script alone fails, with the docs untouched', () => {
    const live = liveCorpus();
    const corpus = {
      ...live,
      [SCRIPT]: live[SCRIPT]
        .split(`${BACKSTOP})`)
        .join('--no-such-flag)')
        .split('REFUSING to bump')
        .join('proceeding'),
    };
    const violations = checkIsolationContract(corpus);
    expect(violations).toEqual([
      `${SCRIPT}: does not implement ${BACKSTOP} that ${SKILL} invokes`,
      `${SCRIPT}: the ${BACKSTOP} guard must run BEFORE any repo read or write`,
    ]);
  });

  /**
   * CONTROL 4 — ordering. A guard that fires after `git add -A` has staged a
   * stranger's edits has already lost. Move it after the first repo read and
   * the ordering assertion must bite; the flag and exit code are untouched.
   */
  it('control: moving the guard after the first repo read fails on ordering alone', () => {
    const live = liveCorpus();
    const src = live[SCRIPT];
    const start = src.indexOf('if [ -n "$EXPECT_BRANCH" ]; then');
    const end = src.indexOf('REPO_ROOT="$(git rev-parse --show-toplevel)"');
    expect(start, 'guard block not found — this control no longer bites').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    const moved = src.slice(0, start) + src.slice(end).replace(
      'VERSION_FILE="$REPO_ROOT/VERSION"',
      `VERSION_FILE="$REPO_ROOT/VERSION"\n${block}`,
    );
    expect(checkIsolationContract({ ...live, [SCRIPT]: moved })).toEqual([
      `${SCRIPT}: the ${BACKSTOP} guard must run BEFORE any repo read or write`,
    ]);
  });

  /**
   * CONTROL 5 — mutual assertion on the anchor name. Rename the heading (and
   * the checker's expectation with it) and the citer breaks while the owner
   * stays consistent; rename everywhere and it passes again. This is what
   * separates "each file mentions worktrees" from "the files agree".
   */
  it('control: renaming the anchor breaks the citer, and renaming both restores it', () => {
    const renamed = 'Dispatch it somewhere else';
    const live = liveCorpus();
    const onlyOwner = { ...live, [ANCHOR_OWNER]: norm(live[ANCHOR_OWNER]).split(DEFAULT_ANCHOR).join(renamed) };
    expect(checkIsolationContract(onlyOwner, renamed)).toEqual([
      `agents/ace-orchestrator.md: does not cite "${renamed}" by name`,
    ]);
    const all = Object.fromEntries(
      Object.entries(live).map(([f, t]) => [f, norm(t).split(DEFAULT_ANCHOR).join(renamed)]),
    );
    // norm() flattens the shell script too, so re-supply it verbatim — this
    // control is about the two agent docs, not the script's layout.
    all[SCRIPT] = live[SCRIPT];
    expect(checkIsolationContract(all, renamed)).toEqual([]);
  });
});
