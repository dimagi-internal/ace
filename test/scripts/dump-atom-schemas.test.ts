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
});
