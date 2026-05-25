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
 * Parsing strategy: regex-extract `server.tool('<name>', '<desc>', {
 * <field>: z.<type>().optional?().describe('<text>'), ... }, ...)` from
 * each `mcp/*-server.ts`. Zod's TypeScript-only static structure means
 * we can't run-time-introspect without booting the full MCP subprocess
 * (auth, networking, etc.), so static extraction is the right tradeoff.
 * Accuracy isn't 100% (nested z.object(), z.record(), unions get
 * approximated) but the result is useful as a navigation aid.
 *
 * Usage:
 *   npx tsx scripts/dump-atom-schemas.ts                 # write docs/atom-schemas.md
 *   npx tsx scripts/dump-atom-schemas.ts --check          # exit non-zero if the file is stale (CI-friendly)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SERVERS: Array<{ file: string; label: string }> = [
  { file: 'mcp/google-drive-server.ts', label: 'ace-gdrive' },
  { file: 'mcp/connect-server.ts',      label: 'ace-connect' },
  { file: 'mcp/ocs-server.ts',          label: 'ace-ocs' },
  { file: 'mcp/mobile-server.ts',       label: 'ace-mobile' },
  { file: 'mcp/decisions-server.ts',    label: 'ace-decisions' },
  { file: 'mcp/connect-labs-server.ts', label: 'connect-labs (proxy)' },
];

interface AtomField {
  name: string;
  typeHint: string;
  optional: boolean;
  description: string;
}

interface AtomEntry {
  name: string;
  description: string;
  fields: AtomField[];
}

/**
 * Find each `server.tool(...)` invocation and return a slice containing
 * the FIRST 3 ARGUMENTS only (name, description, schema). The rest of
 * the call — the async handler body — can contain regex literals,
 * template-string interpolations, and other constructs that confuse a
 * naive paren-balance parser, so we deliberately stop before it.
 *
 * Strategy:
 *   1. Locate `server.tool(` start.
 *   2. Walk forward across the first 3 top-level commas (skipping over
 *      balanced strings + braces / parens / brackets), then walk to the
 *      next top-level closing paren OR newline-followed-by-`async`,
 *      whichever comes first. The slice up to the 3rd argument's end is
 *      sufficient for parameter extraction.
 *   3. The cursor advances to the END of the 3rd-arg region (typically a
 *      `},` followed by the handler). For the next `findToolCall`, we
 *      just need to skip past the handler — using the next
 *      `server.tool(` regex match handles that without balance tracking.
 */
function findToolCall(
  src: string,
  from: number,
): { args: string; nextIndex: number } | null {
  const pattern = /\bserver\.tool\s*\(/g;
  pattern.lastIndex = from;
  const m = pattern.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;

  // Walk forward, tracking top-level (depth==0) commas. The schema is the
  // 3rd top-level arg, so we stop after seeing its closing brace land
  // depth back to 0 + at least 2 commas observed at depth 0.
  let i = start;
  let depth = 0;
  let inString: string | null = null;
  let escape = false;
  let topLevelCommas = 0;
  let schemaEnd = -1;
  while (i < src.length) {
    const c = src[i];
    if (escape) {
      escape = false;
    } else if (inString) {
      if (c === '\\') escape = true;
      else if (c === inString) inString = null;
    } else if (c === '"' || c === "'" || c === '`') {
      inString = c;
    } else if (c === '(' || c === '{' || c === '[') {
      depth++;
    } else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth < 0) {
        // Hit the outer `)` of `server.tool(...)` — we've consumed
        // everything we need.
        schemaEnd = i;
        break;
      }
      // If we just closed the 3rd arg's brace block (depth back to 0,
      // 2 commas already seen), we're done with the schema slice.
      if (depth === 0 && topLevelCommas >= 2 && c === '}') {
        schemaEnd = i + 1;
        break;
      }
    } else if (c === ',' && depth === 0) {
      topLevelCommas++;
      if (topLevelCommas >= 3) {
        // Past the schema arg already — anything further is the handler.
        schemaEnd = i;
        break;
      }
    }
    i++;
  }
  if (schemaEnd < 0) return null;
  return {
    args: src.slice(start, schemaEnd),
    nextIndex: schemaEnd + 1,
  };
}

/**
 * Extract the leading atom name from the args text (first quoted string).
 */
function extractAtomName(args: string): string | null {
  const m = args.match(/^\s*['"]([a-z][a-z0-9_]*)['"]/);
  return m ? m[1] : null;
}

/**
 * Extract the second-arg description string (any quote style, multi-line OK).
 */
function extractDescription(args: string): string {
  // Skip the atom name (first string), then capture the second string literal.
  const lex = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  const first = lex.exec(args);
  if (!first) return '';
  const second = lex.exec(args);
  if (!second) return '';
  return second[2].replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract `<field>: z.<type>().<modifier?>().describe('<text>')` lines
 * from the third argument's brace block.
 */
function extractFields(args: string): AtomField[] {
  // Find the third argument — the schema brace block. It comes after the
  // second string literal.
  const lex = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  lex.exec(args); // atom name
  lex.exec(args); // description
  // Find the next `{` after the description.
  let depth = 0;
  let start = -1;
  let end = -1;
  let inString: string | null = null;
  let escape = false;
  for (let i = lex.lastIndex; i < args.length; i++) {
    const c = args[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === '{') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (start < 0 || end < 0) return [];
  const block = args.slice(start, end);

  // Each field looks like:  fieldName: z.string().optional().describe('text'),
  // We tolerate line breaks and whitespace between segments.
  const fieldRe =
    /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*z\.([a-zA-Z_]+)\s*\([^)]*\)((?:\s*\.(?:optional|nullable|default|describe)\s*\([\s\S]*?\))*)/g;
  const out: AtomField[] = [];
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(block)) !== null) {
    const name = m[1];
    const typeHint = m[2];
    const modifiers = m[3] ?? '';
    const optional = /\.optional\s*\(/.test(modifiers) || /\.nullable\s*\(/.test(modifiers);
    const descMatch = modifiers.match(
      /\.describe\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1\s*\)/,
    );
    const description = descMatch
      ? descMatch[2].replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    out.push({ name, typeHint, optional, description });
  }
  return out;
}

function extractAtomsFromServer(file: string): AtomEntry[] {
  const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8');
  const out: AtomEntry[] = [];
  let cursor = 0;
  while (true) {
    const call = findToolCall(src, cursor);
    if (!call) break;
    cursor = call.nextIndex;
    const name = extractAtomName(call.args);
    if (!name) continue;
    out.push({
      name,
      description: extractDescription(call.args),
      fields: extractFields(call.args),
    });
  }
  return out;
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
        // Trim very long descriptions to ~400 chars for readability;
        // the full description lives in the server source.
        const trimmed =
          atom.description.length > 400
            ? atom.description.slice(0, 400) + '…'
            : atom.description;
        lines.push(trimmed);
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
        const desc = f.description.length > 200
          ? f.description.slice(0, 200) + '…'
          : f.description;
        lines.push(
          `| \`${f.name}\` | \`z.${f.typeHint}\` | ${f.optional ? 'optional' : '**required**'} | ${desc || '_—_'} |`,
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
