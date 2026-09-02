/**
 * Double-encoded UTF-8 ("mojibake") must not enter the repo.
 *
 * ## The failure class
 *
 * A tool reads a UTF-8 file as cp1252/latin1, so an em dash (`E2 80 94`)
 * renders as `â€”`; that rendering is then copied into a new file and written
 * back as UTF-8, producing `C3 A2 E2 82 AC E2 80 9D`. On Windows the usual
 * culprits are PowerShell's `Get-Content -Raw` at the ANSI codepage and
 * `Set-Content`/`>` without `-Encoding utf8`.
 *
 * It is quiet and it compounds:
 *
 *  - Operator-facing strings print garbage (`must be YYYY-MM-DD â€” got …`).
 *  - Agent-facing SKILL.md section references corrupt (`see Â§ Clone`), so a
 *    later agent cannot resolve them.
 *  - Worst: a test that asserts the corrupted string PINS the corruption, and
 *    fixing the source turns the suite red. The path of least resistance is
 *    then to re-corrupt the source.
 *
 * Caught on 0.13.1133, where three new files carried 68 occurrences between
 * them and one had already become a test's expected value. Per CLAUDE.md
 * § Conventions this is a class, not an instance, so it gets a rail rather
 * than a cleanup.
 *
 * ## Why the pattern is what it is
 *
 * Every mojibake sequence starts with a byte in `C2`-`C3` (the UTF-8 lead for
 * U+0080-U+00FF, which is what a latin1 misread produces) followed by another
 * multi-byte lead. Matching on the decoded string rather than raw bytes keeps
 * the check readable and avoids flagging legitimate accented Latin text, which
 * is a single `C3 xx` with an ASCII byte after it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The signature: a `Â`/`Ã` (U+00C2/U+00C3) immediately followed by another
 * character above the ASCII range. Real prose in these files never does this;
 * a double-encoded sequence always does.
 */
const MOJIBAKE = /[ÂÃ][-ÿ -⃿℀-⇿]/;

const TEXT_EXT = /\.(ts|tsx|js|mjs|md|yaml|yml|json)$/;

/** Files that legitimately contain the pattern: this test, and this test only. */
const ALLOWLIST = new Set(['test/no-mojibake.test.ts']);

function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '' && TEXT_EXT.test(s) && !ALLOWLIST.has(s));
}

describe('no double-encoded UTF-8 in tracked text files', () => {
  it('finds files to check (guards against a silently-empty scan)', () => {
    // Without this, a broken `git ls-files` would make the rail below pass on
    // zero files and look like a healthy repo.
    expect(trackedTextFiles().length).toBeGreaterThan(500);
  });

  it('no tracked file carries a mojibake sequence', () => {
    const offenders: string[] = [];
    for (const rel of trackedTextFiles()) {
      let src: string;
      try {
        src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      } catch {
        continue; // deleted or unreadable in this working tree
      }
      if (!MOJIBAKE.test(src)) continue;
      const lines = src.split('\n');
      const hits = lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => MOJIBAKE.test(line))
        .slice(0, 3)
        .map(({ line, n }) => `    ${rel}:${n}  ${line.trim().slice(0, 100)}`);
      offenders.push(`${rel}:\n${hits.join('\n')}`);
    }

    expect(
      offenders.join('\n\n'),
      [
        '',
        'Double-encoded UTF-8 found. A UTF-8 file was read as cp1252/latin1 and written back,',
        'so an em dash became "â€”". On Windows this is usually PowerShell:',
        '',
        '  - `Get-Content -Raw` decodes as ANSI on Windows PowerShell 5.1',
        '  - `Set-Content`/`Out-File` without `-Encoding utf8` re-encodes as ANSI',
        '  - `-Encoding utf8` in 5.1 also adds a BOM',
        '',
        'Use the Read/Write/Edit tools, or node (`fs.readFileSync(p, "utf8")`), for text files.',
        'To repair: decode the string, re-encode latin1, decode utf8.',
        '',
      ].join('\n'),
    ).toBe('');
  });

  it('the detector fires on a known-bad sequence (negative control)', () => {
    // Without this, a regex that matched nothing would pass the rail above.
    const corrupted = 'must be YYYY-MM-DD Ã¢â‚¬” got "x".';
    const clean = 'must be YYYY-MM-DD — got "x".';
    expect(MOJIBAKE.test(corrupted), 'must flag a double-encoded em dash').toBe(true);
    expect(MOJIBAKE.test(clean), 'must not flag a real em dash').toBe(false);
  });

  it('does not flag legitimate accented Latin text', () => {
    for (const ok of ['Café', 'Côte d’Ivoire', 'Malmö', 'naïve', 'Über', 'Español']) {
      expect(MOJIBAKE.test(ok), ok).toBe(false);
    }
  });
});
