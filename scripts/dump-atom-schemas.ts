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
 * Given `src` and an index `i` that points at a `/` which is NOT inside a
 * string, return the index of the FIRST character AFTER the construct it opens:
 * a line comment (`// …`), a block comment (`/* … *\/`), or a regex literal
 * (`/…/flags`). In the constrained context of a `server.tool(...)` first-3-args
 * region (a Zod schema object literal + leading string args), a bare `/` is
 * always one of these three — division never appears — so we always consume
 * rather than risk a brace-depth desync from regex quantifier braces (`{4}`,
 * `{2}`) or comment text. This is the root-cause fix for jjackson/ace#757: the
 * naive walkers below tracked only string delimiters, so `.regex(/^\d{4}-\d{2}-\d{2}$/)`
 * leaked its `{n}` quantifier braces into the depth counter and the schema's
 * own closing `}` was consumed balancing a phantom brace — overrunning the slice
 * into the handler and emitting `_no parameters_` for ~29 rich-schema atoms.
 */
function skipSlashConstruct(src: string, i: number): number {
  const next = src[i + 1];
  if (next === '/') {
    let j = i + 2;
    while (j < src.length && src[j] !== '\n') j++;
    return j; // at the newline (or EOF); the caller's loop handles it normally
  }
  if (next === '*') {
    let j = i + 2;
    while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
    return Math.min(j + 2, src.length); // past the closing */
  }
  // Regex literal: scan to the matching unescaped `/`, honoring `[...]` classes
  // (a `/` inside a character class does not terminate the literal), then skip
  // any trailing flags.
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { j++; break; }
    else if (c === '\n') break; // unterminated — bail (shouldn't happen in practice)
    j++;
  }
  while (j < src.length && /[a-z]/i.test(src[j])) j++; // flags (g, i, m, s, u, y)
  return j;
}

/**
 * Find each `server.tool(...)` invocation and return a slice spanning the atom
 * NAME plus the Zod SCHEMA object — i.e. up to and including the FIRST top-level
 * `{...}` block after `server.tool(`. That schema object is the 2nd arg in the
 * `server.tool(name, schema, handler)` form and the 3rd in the
 * `server.tool(name, description, schema, handler)` form; stopping at the first
 * top-level `{}` handles BOTH without counting commas (the old comma-counting
 * over-read on the no-description form, leaking the next atom's fields —
 * jjackson/ace#757). The handler body that follows is never entered.
 *
 * Slash/string/comment-aware so a regex literal's quantifier braces (`{4}`) or
 * a comment's text inside the schema don't desync the brace-depth counter.
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

  let i = start;
  let braceDepth = 0;
  let braceStart = -1;
  let inString: string | null = null;
  let escape = false;
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
    } else if (c === '/') {
      // Regex literal or comment — skip wholesale so quantifier braces ({4})
      // and comment text don't desync the brace-depth tracker (#757).
      i = skipSlashConstruct(src, i);
      continue;
    } else if (c === '{') {
      if (braceStart < 0) braceStart = i;
      braceDepth++;
    } else if (c === '}') {
      braceDepth--;
      if (braceDepth === 0 && braceStart >= 0) {
        // Closed the schema object — slice ends here.
        schemaEnd = i + 1;
        break;
      }
    } else if (c === ')' && braceStart < 0) {
      // Closed `server.tool(...)` before any `{` appeared — the atom has no
      // inline object schema (handler-only, or a variable schema we can't
      // statically read). Return the name region so the atom is still listed.
      schemaEnd = i;
      break;
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
 * Skip whitespace, commas, and comments starting at `i`; return the index of
 * the next significant character (or args.length).
 */
function skipInsignificant(args: string, i: number): number {
  while (i < args.length) {
    const c = args[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '/' && (args[i + 1] === '/' || args[i + 1] === '*')) { i = skipSlashConstruct(args, i); continue; }
    break;
  }
  return i;
}

/**
 * Extract the atom DESCRIPTION string — but only when the call uses the
 * `server.tool(name, description, schema, handler)` form. Many atoms use the
 * shorter `server.tool(name, schema, handler)` form (no description string,
 * schema is the 2nd arg); for those the description is empty and the FIRST
 * field's `.describe()` must NOT be mistaken for it (the connect_create_opportunity
 * mis-read — jjackson/ace#757). We disambiguate by the first significant token
 * after the atom name: a quote ⇒ description present; a `{` ⇒ schema-first, no
 * description.
 */
function extractDescription(args: string): string {
  const nameLex = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  if (!nameLex.exec(args)) return '';
  const i = skipInsignificant(args, nameLex.lastIndex);
  if (i >= args.length) return '';
  const q = args[i];
  if (q !== '"' && q !== "'" && q !== '`') return ''; // schema-first form ⇒ no description
  const descLex = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  descLex.lastIndex = i;
  const m = descLex.exec(args);
  if (!m || m.index !== i) return '';
  return m[2].replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract `<field>: z.<type>().<modifier?>().describe('<text>')` lines from the
 * schema brace block — the FIRST top-level `{...}` after the atom name. This
 * works for BOTH `server.tool(name, schema, handler)` and
 * `server.tool(name, description, schema, handler)`: a leading description
 * string (when present) is skipped by the in-string handling before we reach
 * the schema's `{`. Earlier code skipped exactly TWO string literals then
 * looked for `{`, which mis-located the schema on the no-description form
 * (the connect_create_opportunity `_no parameters_` mis-read — jjackson/ace#757).
 */
function extractFields(args: string): AtomField[] {
  const nameLex = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  if (!nameLex.exec(args)) return []; // no atom name string
  // Walk from just past the atom name to the first top-level `{...}` block,
  // string/regex/comment-aware so quantifier braces and comment text don't
  // desync depth.
  let depth = 0;
  let start = -1;
  let end = -1;
  let inString: string | null = null;
  let escape = false;
  for (let i = nameLex.lastIndex; i < args.length; i++) {
    const c = args[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === '/') {
      // Regex literal or comment — skip wholesale (#757). `-1` offsets the
      // for-loop's own `i++` so we resume exactly at the construct's end.
      i = skipSlashConstruct(args, i) - 1;
      continue;
    }
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
  // We tolerate line breaks and whitespace between segments. The type capture
  // allows a dotted prefix (`z.coerce.number`), and the modifier chain accepts
  // the common Zod refinement methods so a trailing `.describe()` is still
  // captured when it follows `.regex()` / `.int()` / `.min()` etc. (#757).
  // `z\s*\.\s*` tolerates the multi-line fluent style (`z\n  .string()`); the
  // type capture allows a dotted prefix (`coerce.number`); the modifier chain
  // accepts the common Zod refinement methods so a trailing `.describe()` is
  // still captured when it follows `.regex()` / `.record()` / `.int()` etc. (#757).
  const fieldRe =
    /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*z\s*\.\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\([^)]*\)((?:\s*\.\s*(?:optional|nullable|nullish|default|describe|regex|int|min|max|url|email|uuid|positive|nonnegative|nonempty|length|gte|lte|gt|lt|startsWith|endsWith|trim|toLowerCase|toUpperCase|array|catch|refine|transform|pipe|brand|record)\s*\([\s\S]*?\))*)/g;
  const out: AtomField[] = [];
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(block)) !== null) {
    const name = m[1];
    const typeHint = m[2];
    const modifiers = m[3] ?? '';
    const optional =
      /\.optional\s*\(/.test(modifiers) ||
      /\.nullable\s*\(/.test(modifiers) ||
      /\.nullish\s*\(/.test(modifiers) ||
      /\.default\s*\(/.test(modifiers);
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
