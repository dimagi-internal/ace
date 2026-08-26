/**
 * Decisions-row doc-drift detector (ace#1485).
 *
 * `skills/pdd-to-work-order/SKILL.md` documented the **v3** decision-row shape
 * — a closed key enumeration with no `evidence_basis`, and a worked
 * `decisions_append_rows` example built to match it. The live schema had been
 * v4 since 2026-05-29, where `DecisionRowStrictSchema` makes `evidence_basis`
 * mandatory and rejects the row at the MCP boundary before any Drive write. So
 * the skill's own example was rejected verbatim: a producer that copied the
 * documented shape could not write a single row, and it failed at the atom
 * rather than at review.
 *
 * Nothing caught it. `test/lib/decisions-schema.test.ts` covers the schema;
 * nothing checked that what the SKILLS TELL AUTHORS TO WRITE still satisfies
 * it. That gap is this file. It is the same shape as
 * `test/skill-atom-references.test.ts` (skills drifting from atom signatures)
 * — code moves, prose doesn't, and the run pays.
 *
 * Two assertions, both deliberately structural rather than a full parse: the
 * examples are JS-ish object literals with `...` ellipses, not JSON, and a
 * brittle parser here would be its own maintenance burden.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECISIONS_SCHEMA_VERSION } from '../../lib/decisions-schema.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

function skillDocs(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const dir of fs.readdirSync(SKILLS_DIR)) {
    const f = path.join(SKILLS_DIR, dir, 'SKILL.md');
    if (fs.existsSync(f)) out.push({ rel: `skills/${dir}/SKILL.md`, text: fs.readFileSync(f, 'utf8') });
  }
  return out;
}

/** Fenced blocks that call `decisions_append_rows` with a literal `rows:` array. */
function appendRowsExamples(text: string): string[] {
  return [...text.matchAll(/```[\w-]*\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((b) => b.includes('decisions_append_rows') && /\brows\s*:/.test(b));
}

describe('decisions_append_rows examples in SKILL.md stay current with the schema', () => {
  const docs = skillDocs();

  it('finds the examples it is meant to guard (guards the guard)', () => {
    const withExamples = docs.filter((d) => appendRowsExamples(d.text).length > 0);
    expect(withExamples.length).toBeGreaterThan(0);
  });

  it('every worked example declares evidence_basis on each row', () => {
    const offenders: string[] = [];
    for (const { rel, text } of docs) {
      for (const block of appendRowsExamples(text)) {
        // One row per `id:` key inside the rows array. `evidence_basis` has
        // been REQUIRED on every new row since schema v4 — a row without it is
        // rejected by DecisionRowStrictSchema at the atom boundary.
        const rowCount = (block.match(/^\s*id\s*:/gm) ?? []).length;
        const basisCount = (block.match(/evidence_basis/g) ?? []).length;
        if (rowCount > 0 && basisCount < rowCount) {
          offenders.push(`${rel}: ${rowCount} example row(s), ${basisCount} evidence_basis`);
        }
      }
    }
    expect(
      offenders,
      'A documented example the atom rejects is worse than no example — it fails at ' +
        'the MCP boundary mid-run. Add `evidence_basis: "stated" | "inferred" | "conflicting"` ' +
        'to each row (ace#1485).',
    ).toEqual([]);
  });

  it('no SKILL.md cites a superseded decisions-schema version', () => {
    const offenders: string[] = [];
    for (const { rel, text } of docs) {
      for (const m of text.matchAll(/decisions-schema\.ts`?\s+v(\d+)/g)) {
        if (Number(m[1]) !== DECISIONS_SCHEMA_VERSION) {
          offenders.push(`${rel}: cites v${m[1]}, live schema is v${DECISIONS_SCHEMA_VERSION}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
