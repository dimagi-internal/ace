import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  VerdictDispositionSchema,
  PerItemVerdictSchema,
  SeveritySchema,
  ModeSchema,
} from '../../lib/verdict-schema.js';

// Class-level preventer for the drift fixed in 0.10.7: rubric SKILL.md files
// referenced verdict/severity literals (e.g. `incomplete`) for months before
// the schema enum accepted them. This test fails loudly if a rubric's YAML
// example uses a value the schema does not allow.
//
// Scope: the canonical schema fields only (verdict, severity under
// auto_surfaced, disposition under gate, mode). Custom rubric fields like
// opp-eval's `recommendations[].severity` are out of scope — they aren't part
// of the verdict shape.

const VERDICT_VALUES = new Set<string>(VerdictDispositionSchema.options);
const PER_ITEM_VERDICT_VALUES = new Set<string>(PerItemVerdictSchema.options);
const SEVERITY_VALUES = new Set<string>(SeveritySchema.options);
const MODE_VALUES = new Set<string>(ModeSchema.options);
const DISPOSITION_VALUES = new Set<string>(['approve', 'reject', 'iterate']);

interface Violation {
  file: string;
  block: number;
  line: number;
  field: string;
  parent: string | null;
  value: string;
  expected: string[];
}

function extractYamlBlocks(source: string): { startLine: number; body: string }[] {
  const lines = source.split('\n');
  const blocks: { startLine: number; body: string }[] = [];
  let inBlock = false;
  let blockStart = 0;
  let buf: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock && /^\s*```ya?ml\s*$/.test(line)) {
      inBlock = true;
      blockStart = i + 1;
      buf = [];
      continue;
    }
    if (inBlock && /^\s*```\s*$/.test(line)) {
      blocks.push({ startLine: blockStart, body: buf.join('\n') });
      inBlock = false;
      continue;
    }
    if (inBlock) buf.push(line);
  }
  return blocks;
}

function isPlaceholder(value: string): boolean {
  // Templated values like `<ISO timestamp>`, `${VAR}`, `X.X`, `null`, numeric
  if (!value) return true;
  if (/[<>${}]/.test(value)) return true;
  if (value === 'null') return true;
  if (/^[0-9]+(\.[0-9]+)?$/.test(value)) return true;
  // Range docs like `0.0-10.0`
  if (/^[0-9]+\.[0-9]+\s*-\s*[0-9]+\.[0-9]+$/.test(value)) return true;
  return false;
}

function parseCandidates(rawValue: string): string[] {
  // Strip trailing comment
  const beforeComment = rawValue.replace(/\s+#.*$/, '').trim();
  if (!beforeComment) return [];
  // Split pipe-syntax docs (`pass | warn | fail`)
  return beforeComment
    .split('|')
    .map((s) => s.trim())
    .map((s) => s.replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0);
}

function checkBlock(file: string, blockIndex: number, blockStartLine: number, body: string): Violation[] {
  const violations: Violation[] = [];
  const lines = body.split('\n');
  // Indent stack: each entry is { indent, key } where `key` opened a nested block
  const stack: { indent: number; key: string }[] = [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const leading = line.match(/^(\s*)/)![1];
    const indent = leading.length;

    // Pop stack entries at >= current indent
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    // Match `key: value` or `- key: value` (list-item key)
    const m = line.match(/^\s*(?:-\s+)?([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const valuePart = m[2];

    const parent = stack.length ? stack[stack.length - 1].key : null;

    // If value is empty (or a comment), this key opens a nested block — push.
    const trimmedValue = valuePart.replace(/\s+#.*$/, '').trim();
    if (!trimmedValue) {
      stack.push({ indent, key });
      continue;
    }

    // Inline brace-objects like `{ score: 9, weight: 0.4 }` aren't nested
    // blocks for our purposes — leaf line, don't push.

    // Check the four canonical schema fields
    let validSet: Set<string> | null = null;
    let context = '';
    if (key === 'verdict') {
      // Top-level verdict accepts the broader set; per_item.verdict is restricted.
      // Determine which by walking parent context.
      const inPerItem = stack.some((s) => s.key === 'per_item');
      if (inPerItem) {
        validSet = PER_ITEM_VERDICT_VALUES;
        context = 'per_item.verdict';
      } else {
        validSet = VERDICT_VALUES;
        context = 'verdict';
      }
    } else if (key === 'severity') {
      // Only the canonical `auto_surfaced[].severity` is in scope. Custom
      // fields (e.g. opp-eval's `recommendations[].severity`) are out of scope.
      if (parent !== 'auto_surfaced') continue;
      validSet = SEVERITY_VALUES;
      context = 'auto_surfaced.severity';
    } else if (key === 'disposition') {
      if (parent !== 'gate') continue;
      validSet = DISPOSITION_VALUES;
      context = 'gate.disposition';
    } else if (key === 'mode') {
      validSet = MODE_VALUES;
      context = 'mode';
    } else {
      continue;
    }

    const candidates = parseCandidates(trimmedValue);
    for (const c of candidates) {
      if (isPlaceholder(c)) continue;
      if (!validSet.has(c)) {
        violations.push({
          file,
          block: blockIndex + 1,
          line: blockStartLine + li + 1,
          field: context,
          parent,
          value: c,
          expected: [...validSet].sort(),
        });
      }
    }
  }
  return violations;
}

function listEvalSkills(skillsDir: string): string[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith('-eval'))
    .map((d) => d.name)
    .sort();
}

describe('eval skill YAML / schema drift preventer', () => {
  const skillsDir = join(process.cwd(), 'skills');
  const evalSkills = listEvalSkills(skillsDir);

  it('discovers at least the known eval skills', () => {
    // Sanity: if this falls below the known set, the discovery walk is broken.
    expect(evalSkills.length).toBeGreaterThanOrEqual(8);
    expect(evalSkills).toContain('connect-program-setup-eval');
    expect(evalSkills).toContain('opp-eval');
  });

  // Synthetic negative tests: prove the walker catches the drift classes
  // that 0.10.7 had to clean up. If these regress, the per-skill checks
  // below could pass vacuously.
  describe('detection — synthetic drift fixtures', () => {
    it('flags an unknown top-level verdict literal', () => {
      const block = [
        'verdict: bogus',
        'mode: deep',
      ].join('\n');
      const v = checkBlock('synthetic.md', 0, 0, block);
      expect(v.map((x) => x.value)).toContain('bogus');
    });

    it('flags an unknown auto_surfaced severity literal', () => {
      const block = [
        'auto_surfaced:',
        '  - severity: CRITICAL',
        '    message: "x"',
      ].join('\n');
      const v = checkBlock('synthetic.md', 0, 0, block);
      expect(v.map((x) => `${x.field}=${x.value}`)).toContain('auto_surfaced.severity=CRITICAL');
    });

    it('flags incomplete/partial inside per_item.verdict (per-item enum is narrower)', () => {
      const block = [
        'per_item:',
        '  - ref: "x"',
        '    verdict: incomplete',
      ].join('\n');
      const v = checkBlock('synthetic.md', 0, 0, block);
      expect(v.map((x) => `${x.field}=${x.value}`)).toContain('per_item.verdict=incomplete');
    });

    it('skips severity under non-canonical parents (e.g. recommendations)', () => {
      // Mirrors opp-eval/SKILL.md's `recommendations[].severity: warn` shape —
      // custom field, out of scope for this preventer.
      const block = [
        'recommendations:',
        '  - for: x',
        '    severity: warn',
      ].join('\n');
      const v = checkBlock('synthetic.md', 0, 0, block);
      expect(v).toEqual([]);
    });

    it('handles pipe-syntax doc lines (verdict: pass | warn | fail | incomplete)', () => {
      const block = ['verdict: pass | warn | fail | incomplete'].join('\n');
      const v = checkBlock('synthetic.md', 0, 0, block);
      expect(v).toEqual([]);
    });

    it('flags drift inside a pipe-syntax doc line', () => {
      const block = ['verdict: pass | maybe | fail'].join('\n');
      const v = checkBlock('synthetic.md', 0, 0, block);
      expect(v.map((x) => x.value)).toEqual(['maybe']);
    });
  });

  for (const skill of evalSkills) {
    it(`${skill}/SKILL.md verdict/severity/disposition/mode literals match schema enums`, () => {
      const path = join(skillsDir, skill, 'SKILL.md');
      const source = readFileSync(path, 'utf8');
      const blocks = extractYamlBlocks(source);
      const violations: Violation[] = [];
      for (let i = 0; i < blocks.length; i++) {
        violations.push(
          ...checkBlock(`skills/${skill}/SKILL.md`, i, blocks[i].startLine, blocks[i].body),
        );
      }
      if (violations.length > 0) {
        const pretty = violations
          .map(
            (v) =>
              `  ${v.file}:${v.line} (${v.field}, parent=${v.parent ?? '<root>'}): ` +
              `"${v.value}" not in [${v.expected.join(', ')}]`,
          )
          .join('\n');
        throw new Error(
          `Found ${violations.length} schema-drift literal(s) in ${skill}/SKILL.md:\n${pretty}\n\n` +
            `Either fix the rubric YAML to use a schema-allowed value, or extend ` +
            `the corresponding enum in lib/verdict-schema.ts (and bump SCHEMA_VERSION).`,
        );
      }
      expect(violations).toEqual([]);
    });
  }
});
