/**
 * A SKILL.md may not print an option string a catalogued decision rejects
 * (dimagi-internal/ace#1994).
 *
 * `lib/decision-vocabularies.ts` anchors nine decision ids to a closed option
 * set, and `checkVocabulary` is enforced at the `decisions_append_rows` write
 * boundary: a row for a catalogued id whose `options` contains anything outside
 * the declared set is rejected, and the atom rejects ATOMICALLY — one stray
 * string costs the whole batch.
 *
 * That constraint was real and invisible. No SKILL.md named the catalogue, and
 * `skills/idea-to-pdd/SKILL.md § Decisions Log Convention` — the canonical
 * authority the sibling producers inherit by reference — told authors the
 * opposite: *"If none of the options fits, the `options` set is wrong — add
 * another option that matches what the AI is trying to say."* For a catalogued
 * id, adding an option is precisely what gets the write rejected. On
 * `poverty-graduation/20260905-0924` Phase 1 a 31-row batch (~14k tokens) was
 * rejected wholesale on five catalogued ids and sent twice.
 *
 * The doc fix alone drifts back the next time a vocabulary entry is added or
 * reworded, so this file is the class-level preventer: whatever a SKILL.md
 * PRINTS as an option for a catalogued id must be a member of that id's
 * vocabulary. Same shape as `decisions-example-currency.test.ts` (schema
 * drift) and `skill-atom-references.test.ts` (atom drift) — code moves, prose
 * doesn't, and the run pays.
 *
 * Two printed shapes are guarded, because those are the two an agent copies:
 *
 *   A. **Worked examples** — an `options: [...]` array inside a fenced block,
 *      paired with the `id:` of the row it belongs to (a YAML fixture or a
 *      `decisions_append_rows` call).
 *   B. **Catalogue tables** — a markdown table row keyed by a catalogued id.
 *      These MUST carry an explicit `**Options:**` annotation listing the
 *      catalogue's values in backticks, so the teaching template teaches the
 *      shape the atom accepts instead of prose the atom rejects.
 *
 * Membership, not equality: `checkVocabulary` deliberately permits a SUBSET
 * (not every archetype applies to every opp). A doc may print fewer values; it
 * may not invent one.
 *
 * An id ABSENT from `DECISION_VOCABULARIES` is unconstrained by design — the
 * bar criterion has to let a skill raise a row nobody anticipated — so this
 * test says nothing at all about those.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECISION_VOCABULARIES } from '../../lib/decision-vocabularies.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

const CATALOGUED = new Set(Object.keys(DECISION_VOCABULARIES));

function skillDocs(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const dir of fs.readdirSync(SKILLS_DIR)) {
    const f = path.join(SKILLS_DIR, dir, 'SKILL.md');
    if (fs.existsSync(f)) {
      out.push({ rel: `skills/${dir}/SKILL.md`, text: fs.readFileSync(f, 'utf8') });
    }
  }
  return out;
}

/** `\`a\`, \`b\`` -> ['a', 'b'] — the doc convention for printing a vocabulary. */
function backticked(s: string): string[] {
  return [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
}

interface Printed {
  rel: string;
  line: number;
  id: string;
  options: string[];
}

/**
 * Shape A — `options:` arrays inside fenced blocks, attributed to the nearest
 * PRECEDING `id:` key. Handles both the YAML fixture form (`id: foo`,
 * `options: [a, b]`) and the JS-ish atom-call form (`id: "foo"`,
 * `options: ["a", "b"]`), which is why the values are unquoted defensively
 * rather than JSON-parsed: the worked examples carry `...` ellipses and
 * trailing prose, so they are not valid JSON and never will be.
 */
function printedInExamples(rel: string, text: string): Printed[] {
  const out: Printed[] = [];
  const lines = text.split('\n');
  let inFence = false;
  let currentId: string | null = null;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      currentId = null;
      return;
    }
    if (!inFence) return;
    const idM = line.match(/^\s*"?id"?\s*:\s*["']?([A-Za-z0-9_-]+)["']?\s*,?\s*$/);
    if (idM) {
      currentId = idM[1];
      return;
    }
    const optM = line.match(/^\s*"?options"?\s*:\s*\[([^\]]*)\]/);
    if (optM && currentId && CATALOGUED.has(currentId)) {
      const options = optM[1]
        .split(',')
        .map((v) => v.trim().replace(/^["']|["']$/g, '').trim())
        .filter(Boolean);
      out.push({ rel, line: i + 1, id: currentId, options });
    }
  });
  return out;
}

/** A markdown table row whose first cell is a backticked catalogued id. */
function catalogueTableRows(
  rel: string,
  text: string,
): { rel: string; line: number; id: string; row: string }[] {
  const out: { rel: string; line: number; id: string; row: string }[] = [];
  text.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t.startsWith('|')) return;
    const cells = t.split('|').slice(1, -1);
    if (cells.length < 2) return;
    const first = cells[0].trim().match(/^`([A-Za-z0-9_-]+)`$/);
    if (!first || !CATALOGUED.has(first[1])) return;
    out.push({ rel, line: i + 1, id: first[1], row: t });
  });
  return out;
}

const docs = skillDocs();
const examples = docs.flatMap(({ rel, text }) => printedInExamples(rel, text));
const tableRows = docs.flatMap(({ rel, text }) => catalogueTableRows(rel, text));

describe('SKILL.md option strings for catalogued decisions stay inside their vocabulary', () => {
  it('the catalogue is non-empty and every entry declares options (guards the guard)', () => {
    expect(CATALOGUED.size).toBeGreaterThan(0);
    for (const [id, vocab] of Object.entries(DECISION_VOCABULARIES)) {
      expect(vocab.options.length, `${id} declares no options`).toBeGreaterThan(0);
    }
  });

  it('finds the printed shapes it is meant to guard (guards the guard)', () => {
    expect(
      examples.length,
      'No worked `options: [...]` example for any catalogued id was found in any ' +
        'SKILL.md. Either the examples moved or this parser stopped matching them — ' +
        'a silently-empty scan is how a drift detector goes green while drifting.',
    ).toBeGreaterThan(0);
    expect(
      tableRows.length,
      'No catalogue-table row keyed by a catalogued id was found in any SKILL.md.',
    ).toBeGreaterThan(0);
  });

  it('every worked example draws its options from the declared vocabulary', () => {
    const offenders: string[] = [];
    for (const { rel, line, id, options } of examples) {
      const allowed = new Set(DECISION_VOCABULARIES[id].options);
      const strays = options.filter((o) => !allowed.has(o));
      if (strays.length) {
        offenders.push(
          `${rel}:${line} \`${id}\` prints [${strays.join(', ')}]; ` +
            `vocabulary is [${DECISION_VOCABULARIES[id].options.join(', ')}]`,
        );
      }
    }
    expect(
      offenders,
      'A documented example the atom rejects is worse than no example: ' +
        '`decisions_append_rows` rejects the WHOLE batch on one stray option ' +
        '(lib/decision-vocabularies.ts § checkVocabulary). Put wording, ' +
        'qualifiers and specifics in `reasoning` or `params` (ace#1994).',
    ).toEqual([]);
  });

  it('every catalogue-table row for a catalogued id prints its vocabulary explicitly', () => {
    const missing: string[] = [];
    const offenders: string[] = [];
    for (const { rel, line, id, row } of tableRows) {
      const marker = row.search(/Options\s*:\*{0,2}/i);
      if (marker === -1) {
        missing.push(`${rel}:${line} \`${id}\``);
        continue;
      }
      // Scope to the cell the marker sits in — the trailing "Map to surface"
      // cell is full of backticked rubric names that are not options.
      const after = row.slice(marker);
      const cellEnd = after.indexOf('|');
      const printed = backticked(cellEnd === -1 ? after : after.slice(0, cellEnd));
      const allowed = new Set(DECISION_VOCABULARIES[id].options);
      const strays = printed.filter((o) => !allowed.has(o));
      if (!printed.length || strays.length) {
        offenders.push(
          `${rel}:${line} \`${id}\` prints [${(strays.length ? strays : ['(none)']).join(', ')}]; ` +
            `vocabulary is [${DECISION_VOCABULARIES[id].options.join(', ')}]`,
        );
      }
    }
    expect(
      missing,
      'A catalogue table row for a catalogued decision must print its closed option ' +
        'set, e.g. `**Options:** \\`A\\` · \\`A+B\\` · \\`A+B+C\\``. Without it the ' +
        'teaching template reads as free text and the producer invents prose options ' +
        'that `decisions_append_rows` rejects atomically (ace#1994).',
    ).toEqual([]);
    expect(
      offenders,
      'The options a table prints must be drawn from `DECISION_VOCABULARIES` verbatim ' +
        '(a subset is fine — a stray is not).',
    ).toEqual([]);
  });
});
