/**
 * Tests for `scripts/dump-atom-schemas.ts` — the atom-schema catalog
 * regenerator from PR-P.
 *
 * Two invariants:
 *
 * 1. The script's output for the current source tree matches the
 *    committed `docs/atom-schemas.md`. If an atom is added, renamed, or
 *    has a parameter changed in any MCP server file, the catalog must
 *    be regenerated and committed. PR review surfaces the doc diff as
 *    the same kind of artifact you'd otherwise notice manually.
 *
 * 2. Every MCP server file the script knows about extracts at least one
 *    atom (sanity check for the regex coverage). Prevents a silent
 *    regression where a parser bug drops everything.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

describe('dump-atom-schemas', () => {
  it('docs/atom-schemas.md is in sync with the current MCP server files', () => {
    const result = spawnSync(
      'npx',
      ['tsx', 'scripts/dump-atom-schemas.ts', '--check'],
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    );
    if (result.status !== 0) {
      throw new Error(
        `dump-atom-schemas --check failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}\n\n` +
          `Run: npx tsx scripts/dump-atom-schemas.ts\nand commit the updated docs/atom-schemas.md.`,
      );
    }
    expect(result.status).toBe(0);
  });

  it('every known MCP server file contributes at least one atom to the catalog', () => {
    const md = fs.readFileSync(
      path.join(REPO_ROOT, 'docs/atom-schemas.md'),
      'utf-8',
    );
    // Each per-server section header looks like:
    //   ## ace-gdrive
    //   Source: `mcp/<file>` — N atoms
    const sourceLines = md.match(/^Source: `[^`]+` — (\d+) atoms$/gm) ?? [];
    expect(sourceLines.length).toBeGreaterThanOrEqual(4);
    // Each file (except the proxy) should have at least one atom.
    const counts = sourceLines.map((line) => {
      const m = line.match(/— (\d+) atoms$/);
      return m ? parseInt(m[1], 10) : 0;
    });
    // At least 4 of the 5 server files should have N > 0 (connect-labs
    // is a stdio proxy and has 0 native registrations).
    const nonZero = counts.filter((n) => n > 0).length;
    expect(nonZero).toBeGreaterThanOrEqual(4);
  });

  // Regression floor for jjackson/ace#757: before the parser fix, ~29 atoms
  // rendered `_no parameters_` because the brace-walker mis-counted regex
  // quantifier braces and mis-located the schema on the no-description
  // server.tool form — defeating the grep-the-schema convention. The vast
  // majority of atoms take parameters; only a couple (mobile_list_avds,
  // mobile_diagnose) are genuinely arg-less. Assert the count stays low so the
  // class can't silently regress.
  it('almost no atoms render `_no parameters_` (regression floor for #757)', () => {
    const md = fs.readFileSync(
      path.join(REPO_ROOT, 'docs/atom-schemas.md'),
      'utf-8',
    );
    const noParamCount = (md.match(/^_no parameters_$/gm) ?? []).length;
    expect(noParamCount).toBeLessThanOrEqual(5);
  });

  // A rich-schema atom with regex-validated fields (the #757 reproducer) must
  // list its fields, not collapse to `_no parameters_`.
  it('connect_create_opportunity lists its regex/date fields (#757 reproducer)', () => {
    const md = fs.readFileSync(
      path.join(REPO_ROOT, 'docs/atom-schemas.md'),
      'utf-8',
    );
    const start = md.indexOf('### `connect_create_opportunity`');
    expect(start).toBeGreaterThanOrEqual(0);
    const section = md.slice(start, md.indexOf('### `', start + 1));
    expect(section).not.toMatch(/_no parameters_/);
    expect(section).toMatch(/\|\s*`start_date`\s*\|/);
    expect(section).toMatch(/\|\s*`total_budget`\s*\|/);
  });
});
