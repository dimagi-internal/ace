#!/usr/bin/env npx tsx
/**
 * Regenerates `docs/atom-schemas.md` — a human-readable catalog of every
 * registered MCP atom, its description, and its Zod-declared parameters.
 *
 * Why: skills paraphrase atom names + parameter semantics inline. When
 * the atom schema drifts (parameter renamed, type changed, semantics
 * inverted — the 0.9.4 `connect-opp-setup` `location` field case is the
 * canonical example), the skill prose can be hours-out-of-date before
 * anyone notices.
 *
 * The catalog acts as the single source of truth skill authors can
 * grep, and PR review surfaces atom-schema diffs as doc diffs to the
 * report. PR-K (test/skill-atom-references.test.ts) catches the
 * rename / remove half of the drift class deterministically; this
 * report is the semantic-drift backstop.
 *
 * Parsing strategy: the TypeScript compiler API. `lib/atom-schema-parser.ts`
 * walks each `mcp/*-server.ts` as a syntax tree and reads the `server.tool(...)`
 * call expressions plus the TOP-LEVEL properties of their Zod schema object
 * literals. Zod's structure is static-only, so we can't runtime-introspect
 * without booting the full MCP subprocess (auth, networking); static
 * extraction is the right tradeoff, but it has to be a real parse — see that
 * file's header for the two defects (#2192 wrapped-Zod rows, and the
 * comment-unaware atom drop) that regexes could not stop re-creating.
 *
 * This file is the RENDERER only. Parsing lives in lib/ so it is unit-testable
 * against fixture sources without touching the filesystem.
 *
 * Usage:
 *   npx tsx scripts/dump-atom-schemas.ts                 # write docs/atom-schemas.md
 *   npx tsx scripts/dump-atom-schemas.ts --check          # exit non-zero if the file is stale (CI-friendly)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAtomsFromSource, type AtomEntry } from '../lib/atom-schema-parser.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SERVERS: Array<{ file: string; label: string }> = [
  { file: 'mcp/google-drive-server.ts', label: 'ace-gdrive' },
  { file: 'mcp/connect-server.ts',      label: 'ace-connect' },
  { file: 'mcp/ocs-server.ts',          label: 'ace-ocs' },
  { file: 'mcp/mobile-server.ts',       label: 'ace-mobile' },
  { file: 'mcp/decisions-server.ts',    label: 'ace-decisions' },
];

function extractAtomsFromServer(file: string): AtomEntry[] {
  const abs = path.join(REPO_ROOT, file);
  return parseAtomsFromSource(fs.readFileSync(abs, 'utf-8'), file);
}

function renderMarkdown(): string {
  const lines: string[] = [];
  lines.push('# ACE MCP Atom Schemas');
  lines.push('');
  lines.push(
    'Auto-generated catalog of every registered atom across the five MCP servers. **Do not hand-edit.** Regenerate with:',
  );
  lines.push('');
  lines.push('```bash');
  lines.push('npx tsx scripts/dump-atom-schemas.ts');
  lines.push('```');
  lines.push('');
  lines.push(
    'Purpose: single source of truth skill authors can grep against. PR review surfaces atom-schema diffs as diffs to this file. See PR-P for full rationale.',
  );
  lines.push('');
  lines.push(
    'For the deterministic atom-rename / remove drift check, see `test/skill-atom-references.test.ts` (PR-K).',
  );
  lines.push('');
  for (const server of SERVERS) {
    let atoms: AtomEntry[];
    try {
      atoms = extractAtomsFromServer(server.file);
    } catch (e: any) {
      lines.push(`## ${server.label}`);
      lines.push('');
      lines.push(`_extraction failed: ${e.message}_`);
      lines.push('');
      continue;
    }
    lines.push(`## ${server.label}`);
    lines.push('');
    lines.push(`Source: \`${server.file}\` — ${atoms.length} atoms`);
    lines.push('');
    for (const atom of atoms) {
      lines.push(`### \`${atom.name}\``);
      lines.push('');
      if (atom.description) {
        // NOT truncated (ace#1278). These descriptions are load-bearing
        // contracts, not blurbs — the operative half of
        // `connect_set_verification_flags`' (which flags are refused, the
        // 25-char name cap, the MINUTES unit) sat past the old 400-char cut,
        // in a doc CLAUDE.md mandates grepping INSTEAD of reading the source.
        lines.push(atom.description);
        lines.push('');
      }
      if (atom.fields.length === 0) {
        lines.push('_no parameters_');
        lines.push('');
        continue;
      }
      lines.push('| Field | Type | Required | Description |');
      lines.push('|-------|------|----------|-------------|');
      for (const f of atom.fields) {
        // Field descriptions carry the same contract weight as the atom's
        // (ace#1278) — and a table cell cannot contain a newline, so the only
        // reshaping needed is escaping pipes.
        const desc = f.description.replace(/\|/g, '\\|');
        lines.push(
          `| \`${f.name}\` | \`${f.typeHint}\` | ${f.optional ? 'optional' : '**required**'} | ${desc || '_—_'} |`,
        );
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const outPath = path.join(REPO_ROOT, 'docs/atom-schemas.md');
  const md = renderMarkdown();
  if (check) {
    if (!fs.existsSync(outPath)) {
      console.error(
        'docs/atom-schemas.md is missing. Run: npx tsx scripts/dump-atom-schemas.ts',
      );
      process.exit(1);
    }
    const onDisk = fs.readFileSync(outPath, 'utf-8');
    if (onDisk !== md) {
      console.error(
        'docs/atom-schemas.md is out of date with the live atom registrations.\nRegenerate with: npx tsx scripts/dump-atom-schemas.ts',
      );
      process.exit(1);
    }
    console.log('docs/atom-schemas.md is up to date.');
    return;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md);
  console.log(`Wrote ${outPath} (${md.length} chars)`);
}

main();
