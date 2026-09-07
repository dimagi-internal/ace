/**
 * Tests for `lib/atom-schema-parser.ts` — the TypeScript-AST extractor behind
 * `docs/atom-schemas.md`.
 *
 * Two defects with one root cause were closed by moving off regexes
 * (dimagi-internal/ace#2192). Each gets a CONTROL here — a fixture source that
 * FAILED under the text-pattern parser and must keep passing:
 *
 *   1. #2192 — a field whose Zod value wraps another `z.` call
 *      (`z.record(z.unknown())`, `z.array(z.string())`, `z.object({…})`,
 *      `z.union([…])`) rendered `**required** | _—_` even when it declared
 *      `.optional()` and `.describe(…)`. The type-arg pattern was `\([^)]*\)`,
 *      which stops at the first `)`, so the modifier chain matched empty.
 *      58 rows in the doc CLAUDE.md tells skill authors to grep were wrong in
 *      the most expensive direction.
 *
 *   2. CLAUDE.md § Gotchas' comment-unaware parser — a line comment carrying a
 *      bare apostrophe (`// Maestro's parser`) between `server.tool(` and the
 *      atom name opened a phantom string, so the atom name failed to parse and
 *      the atom vanished from the catalog entirely.
 *
 * The third block is the correctness oracle the reverted one-level-nesting
 * patch would have failed: no schema field may disappear. It compares the
 * parser's field list against an INDEPENDENT AST walk of each server file, so
 * a parser bug cannot exonerate itself.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parseAtomsFromSource } from '../../lib/atom-schema-parser.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SERVER_FILES = [
  'mcp/google-drive-server.ts',
  'mcp/connect-server.ts',
  'mcp/ocs-server.ts',
  'mcp/mobile-server.ts',
  'mcp/decisions-server.ts',
];

describe('atom-schema-parser: wrapped Zod values (ace#2192)', () => {
  const src = `
import { z } from 'zod';
server.tool(
  'wrapped_atom',
  'Every field here wraps another z. call.',
  {
    patch: z.record(z.unknown()).optional().describe('Nested keys to merge.'),
    tools: z.array(z.string()).optional().describe('Tool slugs to enable.'),
    validateAs: z
      .object({ kind: z.literal('run_state') })
      .optional()
      .describe('Contract guard.'),
    mode: z.union([z.literal('a'), z.literal('b')]).optional().describe('Merge mode.'),
    values: z.array(z.array(z.string())).describe('Row-major cell values.'),
    bare: z.record(z.string(), z.unknown()),
  },
  async () => ({}),
);
`;
  const atom = parseAtomsFromSource(src, 'fixture.ts')[0];
  const byName = Object.fromEntries(atom.fields.map((f) => [f.name, f]));

  it('reads .optional() through a nested z.<type>(...) argument', () => {
    for (const name of ['patch', 'tools', 'validateAs', 'mode']) {
      expect(byName[name], `${name} should be present`).toBeDefined();
      expect(byName[name].optional, `${name} should render optional`).toBe(true);
    }
  });

  it('reads .describe() through a nested z.<type>(...) argument', () => {
    expect(byName.patch.description).toBe('Nested keys to merge.');
    expect(byName.tools.description).toBe('Tool slugs to enable.');
    expect(byName.validateAs.description).toBe('Contract guard.');
    expect(byName.mode.description).toBe('Merge mode.');
    // Described but genuinely required — the fix must not flip everything.
    expect(byName.values.description).toBe('Row-major cell values.');
    expect(byName.values.optional).toBe(false);
  });

  it('still reports a genuinely required, undescribed wrapped field as such', () => {
    expect(byName.bare.optional).toBe(false);
    expect(byName.bare.description).toBe('');
  });

  it('names the OUTER type, and emits no row for a nested field', () => {
    expect(byName.patch.typeHint).toBe('z.record');
    expect(byName.validateAs.typeHint).toBe('z.object');
    // `kind` lives inside validateAs' object literal. The reverted regex patch
    // emitted it IN PLACE OF `validateAs`; a nested key is never a parameter.
    expect(atom.fields.map((f) => f.name)).not.toContain('kind');
    expect(atom.fields.map((f) => f.name)).toEqual([
      'patch', 'tools', 'validateAs', 'mode', 'values', 'bare',
    ]);
  });
});

describe('atom-schema-parser: comments are the scanner’s problem (CLAUDE.md § Gotchas)', () => {
  // A bare apostrophe in a line comment BEFORE the atom name used to open a
  // phantom string: `beta_atom` was dropped, and so was everything after it.
  const src = `
import { z } from 'zod';
server.tool('alpha_atom', 'First.', { a: z.string().describe('an a') }, async () => ({}));

server.tool(
  // Maestro's parser needs this recipe verbatim.
  'beta_atom',
  'Second.',
  {
    // Another apostrophe, this time inside the schema: don't drop me either.
    yaml: z.string().describe('recipe text'),
  },
  async () => ({}),
);

/* A block comment with an apostrophe: the emulator's serial. */
server.tool('gamma_atom', 'Third.', { g: z.string() }, async () => ({}));
`;
  const atoms = parseAtomsFromSource(src, 'fixture.ts');

  it('does not drop an atom preceded by an apostrophe-bearing comment', () => {
    expect(atoms.map((a) => a.name)).toEqual(['alpha_atom', 'beta_atom', 'gamma_atom']);
  });

  it('does not drop the atoms that FOLLOW one', () => {
    expect(atoms).toHaveLength(3);
    expect(atoms[1].fields.map((f) => f.name)).toEqual(['yaml']);
    expect(atoms[1].fields[0].description).toBe('recipe text');
  });
});

describe('atom-schema-parser: prose shapes', () => {
  it('reads a description built by + concatenation', () => {
    const src = `
server.tool('cat_atom',
  'Rows are capped at ' + SNIPPET_CHARS + ' chars by default.',
  { a: z.string() },
  async () => ({}));
`;
    const atom = parseAtomsFromSource(src, 'fixture.ts')[0];
    expect(atom.description).toContain('Rows are capped at');
    expect(atom.description).toContain('chars by default.');
    // ...and the schema is still located, despite the description not being a
    // plain string literal.
    expect(atom.fields.map((f) => f.name)).toEqual(['a']);
  });

  it('reads a description written as a template with a substitution', () => {
    const src = `
server.tool('tpl_atom', 'T.', {
  yaml: z.string().describe(\`Allowed keys: \${[...KEYS].join(', ')}. Nothing else.\`),
}, async () => ({}));
`;
    const atom = parseAtomsFromSource(src, 'fixture.ts')[0];
    expect(atom.fields[0].description).toContain('Allowed keys:');
    expect(atom.fields[0].description).toContain('Nothing else.');
  });

  it('attributes a nested field’s .describe() to that field, not its parent', () => {
    const src = `
server.tool('nest_atom', 'N.', {
  learn_app: HqAppZ.extend({ description: z.string().describe('CHILD prose') }),
  deliver_app: HqAppZ.describe('PARENT prose'),
}, async () => ({}));
`;
    const atom = parseAtomsFromSource(src, 'fixture.ts')[0];
    const byName = Object.fromEntries(atom.fields.map((f) => [f.name, f]));
    expect(atom.fields.map((f) => f.name)).toEqual(['learn_app', 'deliver_app']);
    expect(byName.learn_app.description).not.toContain('CHILD prose');
    expect(byName.deliver_app.description).toBe('PARENT prose');
  });

  it('resolves a field declared by a shared const identifier', () => {
    const src = `
const HQ_SERVER_FIELD = z.string().optional().describe('Which HQ cluster (us or eu).');
server.tool('const_atom', 'C.', { server: HQ_SERVER_FIELD, domain: z.string() }, async () => ({}));
`;
    const atom = parseAtomsFromSource(src, 'fixture.ts')[0];
    const f = atom.fields.find((x) => x.name === 'server')!;
    expect(f.typeHint).toBe('z.string');
    expect(f.optional).toBe(true);
    expect(f.description).toBe('Which HQ cluster (us or eu).');
  });
});

// ---------------------------------------------------------------------------
// Correctness oracle. The one-level-nesting regex patch tried while shipping
// #2184 fixed ~30 rows and DROPPED 15 fields — the silently-short-table
// failure ace#1278 calls out as worse than a blank description, and it was
// caught only by eye. This is that check, mechanised.
//
// The expected set is computed by a SEPARATE, deliberately trivial AST walk:
// the top-level property keys of each `server.tool(...)` schema object
// literal. If the parser and this walk disagree, the walk wins and this fails.
// ---------------------------------------------------------------------------
describe('atom-schema-parser: no schema field may disappear (#1278, #2192)', () => {
  /** atom name -> ordered top-level property keys, via an independent walk. */
  function topLevelSchemaKeys(src: string, file: string): Map<string, string[]> {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const out = new Map<string, string[]>();
    const walk = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'tool' &&
        n.expression.expression.getText(sf) === 'server' &&
        n.arguments[0] &&
        ts.isStringLiteral(n.arguments[0])
      ) {
        const name = (n.arguments[0] as ts.StringLiteral).text;
        const obj = n.arguments.find((a) => ts.isObjectLiteralExpression(a)) as
          | ts.ObjectLiteralExpression
          | undefined;
        const keys: string[] = [];
        for (const p of obj?.properties ?? []) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) keys.push(p.name.text);
          else if (ts.isShorthandPropertyAssignment(p)) keys.push(p.name.text);
        }
        out.set(name, keys);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    return out;
  }

  for (const file of SERVER_FILES) {
    it(`${file}: every schema field renders exactly one row, and no others`, () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8');
      const expected = topLevelSchemaKeys(src, file);
      const actual = new Map(
        parseAtomsFromSource(src, file).map((a) => [a.name, a.fields.map((f) => f.name)]),
      );

      const problems: string[] = [];
      for (const [atom, keys] of expected) {
        const got = actual.get(atom);
        if (!got) {
          problems.push(`${atom}: atom missing from the catalog entirely`);
          continue;
        }
        for (const k of keys) {
          if (!got.includes(k)) problems.push(`${atom}.${k}: DROPPED (schema declares it)`);
        }
        for (const k of got) {
          if (!keys.includes(k)) {
            problems.push(`${atom}.${k}: SPURIOUS (not a top-level schema key)`);
          }
        }
      }
      expect(
        problems,
        `docs/atom-schemas.md would misreport these parameters:\n  ${problems.join('\n  ')}`,
      ).toEqual([]);
    });
  }

  it('every registered atom in every server file appears in the catalog', () => {
    for (const file of SERVER_FILES) {
      const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8');
      // A deliberately dumb count of registration sites — it cannot be fooled
      // by a phantom string, because it never tracks string state at all.
      const registrations = (src.match(/\bserver\.tool\s*\(/g) ?? []).length;
      const parsed = parseAtomsFromSource(src, file).length;
      expect(parsed, `${file}: parsed ${parsed} atoms from ${registrations} registrations`).toBe(
        registrations,
      );
    }
  });
});
