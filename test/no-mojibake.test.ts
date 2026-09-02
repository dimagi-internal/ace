/**
 * Double-encoded UTF-8 ("mojibake") must not enter the repo.
 *
 * ## The failure class
 *
 * A tool reads a UTF-8 file as cp1252/latin1, so an em dash (`E2 80 94`)
 * renders as three characters; that rendering is copied into a new file and
 * written back as UTF-8. On Windows the usual culprits are PowerShell's
 * `Get-Content -Raw` at the ANSI codepage and `Set-Content`/`>` without
 * `-Encoding utf8`.
 *
 * It is quiet and it compounds:
 *
 *  - Operator-facing strings print garbage.
 *  - Agent-facing SKILL.md section references corrupt, so a later agent
 *    cannot resolve them.
 *  - Worst: a test that asserts the corrupted string PINS the corruption, and
 *    fixing the source turns the suite red. The path of least resistance is
 *    then to re-corrupt the source.
 *
 * Caught on 0.13.1133, where three new files carried 68 occurrences between
 * them and one had already become a test's expected value.
 *
 * ## Why detection is a round-trip and not a character-class guess
 *
 * The first version of this rail matched `/[ÂÃ]<something>/` on the DECODED
 * text, reasoning that "every mojibake sequence starts with a byte in C2-C3".
 * That is true of the re-encoded bytes of a **two-byte** source only. A
 * three-byte source — em dash, en dash, arrows, `>=`, curly quotes: by far the
 * most common non-ASCII characters in this repo — decodes with a `U+00E2`
 * lead, and two-byte Greek leads with `U+00CE`. So the rail **missed its own
 * headline example**, and its negative control passed only because that
 * control string happened to be triple-encoded.
 *
 * Guessing a wider class has the same shape of bug. Instead: find candidate
 * runs with the exact UTF-8 lead+continuation pattern, then CONFIRM each by
 * round-tripping it — re-encode as latin1 and strict-decode as UTF-8. If that
 * succeeds and yields something different, the run really was double-encoded.
 * A run of genuine Latin-1 prose fails the strict decode and is left alone.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Candidate runs: a UTF-8 lead byte (`C2`-`F4`) followed by one or more
 * continuation bytes (`80`-`BF`), as CHARACTERS — which is precisely what a
 * latin1 misread of real UTF-8 produces. Deliberately broad; every hit is
 * then confirmed by `isDoubleEncoded`.
 */
const CANDIDATE_RUN = /[Â-ô][-¿]+/g;

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** Does this run re-decode as different, valid UTF-8? Then it was mojibake. */
export function isDoubleEncoded(run: string): boolean {
  try {
    return utf8Strict.decode(Buffer.from(run, 'latin1')) !== run;
  } catch {
    return false; // not valid UTF-8 underneath — genuine Latin-1 text
  }
}

/** Every confirmed mojibake run in a string. */
export function findMojibake(text: string): string[] {
  return (text.match(CANDIDATE_RUN) ?? []).filter(isDoubleEncoded);
}

const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|md|yaml|yml|json|py|sh|txt|html|css)$/;

/** Files that legitimately contain the pattern: this test, and this test only. */
const ALLOWLIST = new Set(['test/no-mojibake.test.ts']);

function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
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
      if (findMojibake(src).length === 0) continue;
      const hits = src
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => findMojibake(line).length > 0)
        .slice(0, 3)
        .map(({ line, n }) => `    ${rel}:${n}  ${line.trim().slice(0, 100)}`);
      offenders.push(`${rel}:\n${hits.join('\n')}`);
    }

    expect(
      offenders.join('\n\n'),
      [
        '',
        'Double-encoded UTF-8 found. A UTF-8 file was read as cp1252/latin1 and written back.',
        'On Windows this is usually PowerShell:',
        '',
        '  - `Get-Content -Raw` decodes as ANSI on Windows PowerShell 5.1',
        '  - `Set-Content`/`Out-File` without `-Encoding utf8` re-encodes as ANSI',
        '  - `-Encoding utf8` in 5.1 also adds a BOM',
        '',
        'Use the Read/Write/Edit tools, or node (`fs.readFileSync(p, "utf8")`), for text files.',
        'To repair: decode the string, re-encode latin1, strict-decode utf8.',
        '',
      ].join('\n'),
    ).toBe('');
  });
});

describe('the detector actually detects', () => {
  /** Simulate the misread that produces mojibake: UTF-8 bytes read as latin1. */
  const corrupt = (s: string) => Buffer.from(s, 'utf8').toString('latin1');

  // These are the characters this repo actually uses. The first rail missed
  // the first six of them, which is the whole reason it is written this way.
  const REAL_CHARS = [
    '—', // em dash — the headline case the first version missed
    '–', // en dash
    '→', // right arrow
    '≥', // greater-or-equal
    '≤', // less-or-equal
    '’', // right single quote
    'Σ', // Greek capital sigma
    '§', // section sign
    '·', // middle dot
    '×', // multiplication sign
    '…', // ellipsis
  ];

  it.each(REAL_CHARS)('flags a singly-encoded %j', (ch) => {
    expect(findMojibake(`prefix ${corrupt(ch)} suffix`).length).toBeGreaterThan(0);
  });

  it.each(REAL_CHARS.slice(0, 4))('flags a doubly-encoded %j', (ch) => {
    expect(findMojibake(corrupt(corrupt(ch))).length).toBeGreaterThan(0);
  });

  it('flags the exact string that motivated this rail', () => {
    // A real line from the first revision of lib/connect-opp-spec.ts.
    expect(findMojibake(`must be YYYY-MM-DD ${corrupt('—')} got "x".`)).not.toEqual([]);
  });

  it('does not flag legitimate accented Latin text', () => {
    for (const ok of [
      'Café', 'Côte d’Ivoire', 'Malmö', 'naïve',
      'Über', 'Español', 'Zürich', 'Ångström',
    ]) {
      expect(findMojibake(ok), ok).toEqual([]);
    }
  });

  it('does not flag correctly-encoded uses of the same characters', () => {
    for (const ok of [
      'a — b', 'see § Clone', 'Σ over units', '2 × 3',
      '20260901-1430 · Opp', '≥1 FLW', 'emoji 🎉', 'CJK 日本語',
      'plain ascii only',
    ]) {
      expect(findMojibake(ok), ok).toEqual([]);
    }
  });

  it('the round-trip confirmation is what rejects Latin-1 lookalikes', () => {
    // "Ã©" is a valid candidate run by shape, and IS mojibake (é).
    expect(isDoubleEncoded('Ã©')).toBe(true);
    // "Âc" is not a candidate at all (c is not a continuation byte).
    expect(findMojibake('Âc')).toEqual([]);
  });
});
