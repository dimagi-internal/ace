/**
 * No tracked file may contain an unresolved merge-conflict marker.
 *
 * ## Why this is a test and not a habit
 *
 * This class has shipped to `main` twice, both on 2026-08-26:
 *
 *  - **#1714** merged with unresolved markers in `CHANGELOG.md`. Nothing caught
 *    it. Every later branch inherited them on rebase.
 *  - Then I committed and pushed markers into `package.json` while fixing that,
 *    because I checked one file for markers and not the others. `vitest` could
 *    not parse `package.json`, so the suite exited 1 with no summary — which
 *    reads like noise rather than failure, and cost two more commands before it
 *    was chased.
 *
 * Neither was caught by CI, because `clean-install` only breaks when markers
 * land in a file the build actually parses. Markers in Markdown are invisible to
 * it, and Markdown is where they are most likely — `CHANGELOG.md` conflicts on
 * essentially every concurrent PR in this repo.
 *
 * The repo already knows the discipline: `skills/shipping` says to run
 * `grep -c '<<<<<<<' <file>` (expect 0) before committing. That is prose, and it
 * relies on remembering to run it on *every* conflicted file rather than the one
 * you hand-edited. This is the enforcement.
 *
 * ## And it is only half of it
 *
 * This test cannot run when the markers land in a file the SUITE needs —
 * `package.json`, `vitest.config.ts`, `tsconfig.json`. That is not academic: it
 * is incident #2 above verbatim. So the same check also exists as
 * `scripts/check-conflict-markers.sh`, wired into `clean-install.yml` BEFORE
 * `npm ci` and needing nothing but git and grep. Keep both, and keep them
 * agreeing — if you change the marker set or the scoping here, change it there.
 *
 * ## Scope
 *
 * Tracked files only, and the markers must be at the start of a line in the
 * canonical `git` form. That avoids flagging prose that discusses conflict
 * markers — including this file's own header and the shipping skill's
 * instructions, both of which name them inline on purpose.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Canonical git conflict markers, anchored to line start. */
const MARKERS = [/^<<<<<<< /, /^>>>>>>> /, /^\|\|\|\|\|\|\| /];

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .split('\0')
    .filter(Boolean);
}

describe('no unresolved conflict markers', () => {
  const files = trackedFiles();

  it('found tracked files to scan', () => {
    // An empty list would pass the real assertion while scanning nothing.
    expect(files.length, 'git ls-files returned nothing — scanner is broken').toBeGreaterThan(100);
  });

  it('no tracked file carries a conflict marker', () => {
    const offenders: string[] = [];

    for (const rel of files) {
      const abs = path.join(REPO_ROOT, rel);
      let text: string;
      try {
        const buf = fs.readFileSync(abs);
        // Skip binaries — a NUL in the first 8KB is the usual heuristic.
        if (buf.subarray(0, 8192).includes(0)) continue;
        text = buf.toString('utf8');
      } catch {
        continue; // deleted-but-tracked, symlink, permissions
      }
      if (!text.includes('<<<<<<<') && !text.includes('>>>>>>>')) continue;

      text.split('\n').forEach((line, i) => {
        if (MARKERS.some((re) => re.test(line))) {
          offenders.push(`  ${rel}:${i + 1}  ${line.slice(0, 80)}`);
        }
      });
    }

    expect(
      offenders,
      'Unresolved merge-conflict markers in tracked files. A rebase or merge was\n' +
        'committed without resolving every conflicted file — check ALL of them, not\n' +
        'just the one you hand-edited (skills/shipping § Step 2).\n\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});

describe('the standalone guard exists and is wired', () => {
  // The vitest half cannot fire when markers break the suite's own inputs —
  // which is exactly what happened on 2026-08-26 with package.json. If the
  // shell half is deleted or unwired, this file's coverage silently halves.
  it('scripts/check-conflict-markers.sh is present and executable', () => {
    const p = path.join(REPO_ROOT, 'scripts/check-conflict-markers.sh');
    expect(fs.existsSync(p), 'the shell half of this guard is missing').toBe(true);
    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(p).mode & 0o111, 'must be executable').toBeGreaterThan(0);
  });

  it('CI runs it before npm ci', () => {
    const wf = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/clean-install.yml'), 'utf8');
    const guardAt = wf.indexOf('npm run check:conflicts');
    const npmCiAt = wf.indexOf('run: npm ci');
    expect(guardAt, 'clean-install.yml must run `npm run check:conflicts`').toBeGreaterThan(-1);
    expect(npmCiAt, '`npm ci` step not found — did the workflow change shape?').toBeGreaterThan(-1);
    expect(
      guardAt,
      'the marker guard must run BEFORE `npm ci`. After it, markers in\n' +
        'package.json fail the job as a JSON parse error instead of naming the\n' +
        'file and line — which is the failure mode that cost two commands on\n' +
        '2026-08-26.',
    ).toBeLessThan(npmCiAt);
  });

  it('package.json exposes it as a script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts?.['check:conflicts'], 'npm run check:conflicts must exist').toBeTruthy();
  });
});
