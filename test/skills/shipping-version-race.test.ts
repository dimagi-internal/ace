/**
 * The version-collision recovery in `skills/shipping` must disarm auto-merge
 * BEFORE it rebases (ace#1593).
 *
 * The recipe used to read `version-bump.sh --rebase-first && git push
 * --force-with-lease`, with auto-merge left armed throughout. That is a race,
 * and it is one the agent loses: `clean-install` (the only REQUIRED check on
 * main) can go green on the PRE-REBASE head, auto-merge fires, and the
 * subsequent force-push is a no-op against an already-merged branch. The PR
 * lands carrying the OLD version.
 *
 * That matters more than a cosmetic version skip, because the plugin cache is
 * keyed by version (`~/.claude/plugins/cache/ace/ace/<version>/`) and a session
 * re-installs only when the marketplace version differs from the installed one.
 * So a fix that merges without advancing VERSION is on `main` and
 * simultaneously unreachable by `/ace:update` — silently, with every version
 * file reading correct.
 *
 * Measured 2026-08-24, one sweep, ~20 PRs: 4 collided. The 3 that left
 * auto-merge armed (#1595, #1596, #1584) all merged at a version `main`
 * already had and each needed a follow-up bump (#1597, #1598, #1588). The 1
 * that disarmed first (#1601) advanced cleanly.
 *
 * Prose does not fail. This does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL = join(__dirname, '..', '..', 'skills', 'shipping', 'SKILL.md');
const text = readFileSync(SKILL, 'utf8');

/** The version-collision bullet, up to the next top-level bullet. */
function collisionBlock(): string {
  const start = text.search(/^- \*\*Version collision\*\*/m);
  expect(start, 'the version-collision recipe vanished from skills/shipping').toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.search(/^- \*\*/m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('shipping: version-collision recovery (ace#1593)', () => {
  it('disarms auto-merge before rebasing', () => {
    const block = collisionBlock();
    expect(
      block,
      'The collision recipe must disable auto-merge before touching the branch, or the ' +
        'merge races the rebase and the force-push is a no-op. See ace#1593.',
    ).toMatch(/--disable-auto/);
  });

  it('orders disarm BEFORE the rebase and re-arm AFTER the push', () => {
    const block = collisionBlock();
    const disarm = block.indexOf('--disable-auto');
    const rebase = block.indexOf('--rebase-first');
    const push = block.indexOf('--force-with-lease');
    const rearm = block.search(/--auto\s+--merge/);

    expect(disarm, 'no --disable-auto in the collision recipe').toBeGreaterThan(-1);
    expect(rebase, 'no --rebase-first in the collision recipe').toBeGreaterThan(-1);
    expect(push, 'no --force-with-lease in the collision recipe').toBeGreaterThan(-1);
    expect(rearm, 'the recipe never re-arms auto-merge').toBeGreaterThan(-1);

    expect(disarm, 'disarm must come before the rebase').toBeLessThan(rebase);
    expect(rearm, 're-arm must come after the force-push').toBeGreaterThan(push);
  });

  it('tells the agent to verify VERSION actually advanced after the merge', () => {
    // `state: MERGED` is not sufficient — that is precisely how an unreachable
    // fix gets reported as a success.
    expect(
      text,
      'shipping must instruct a post-merge read of origin/main:VERSION; ' +
        'trusting state=MERGED leaves unreachable fixes on main (ace#1593).',
    ).toMatch(/origin\/main:VERSION/);
  });

  it('records that check-version is advisory, so it cannot be relied on here', () => {
    const block = collisionBlock();
    expect(
      block,
      'the recipe must say check-version does not gate this, or a reader will assume CI caught it',
    ).toMatch(/advisory|not required/i);
  });
});
