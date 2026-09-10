//
// Which of these documents is a COMPONENT, and which component is it?
//
// ACE's design step has always answered one question — "synthesize a PDD from
// whatever the human curated into `inputs/`" — and that is the right question
// when the human brings raw material. It is the wrong question when they bring
// a design that is already N designs.
//
// Measured on `poverty-graduation`, 2026-09-05: the author delivered a
// framework plus one authored PDD per component, each keyed off a shared
// case-and-state model, plus a program-level PDD for Learn. Run through
// synthesis they collapse into one document, and nothing downstream can name a
// component, check that its declared training requirements became its module,
// or turn it off for a particular programme. See
// `docs/superpowers/specs/2026-09-05-multi-component-programmes.md`.
//
// ## The classification rule is the AUTHOR'S, not ACE's
//
// This module invents no convention. It reads the one the documents already
// declare, on the metadata line under the title:
//
//   Program Design Document (PDD): Enrollment
//   Version: 0.1 (draft) · … · Component: 4 of the graduation component set
//
//   Program Design Document (PDD): Learn (Program Training and Certification)
//   Version: 0.4 (draft) · … · Scope: program-level (cross-component)
//
// Those numbers resolve against the framework's own component table (4 =
// Enrollment, 5 = Productive Asset, 5b = Productive Asset (cash), 6 =
// Recurring Consumption Support), so the author's numbering is the identity —
// ACE does not mint its own.
//
// ## Why filename matching is deliberately NOT a fallback
//
// It is the fragility this whole approach exists to avoid, and there was a
// live example: the targeting PDD carried into `poverty-graduation` is named
// "PDD - Targeting Survey (Component 2) — …" and, when this module was
// written, declared NOTHING — it was authored before the convention existed.
// Its author closed the gap with a one-line edit on 2026-09-05 (it now carries
// `· Component: 2 of the graduation component set`), which is precisely the
// outcome an `undeclared-pdd` finding is for: a loud gap that costs its author
// one line. Had ACE matched on the filename instead, the guess would have been
// silently right here and there would have been nothing to close. Matching on
// the filename would
// silently promote a guess (made by whoever named the file) into the component
// identity every later phase builds on. So an undeclared PDD is reported as
// `undeclared-pdd` and the caller is told the exact line to add. A loud gap
// beats a confident guess — the same rule as § "close the loop to the source
// of truth".
//
// ## The framework's component INVENTORY is read the same way
//
// `lib/learn-module-plan.ts` needs the framework's full component list to
// satisfy Learn PDD §6(5) — "every framework component skipped for having no
// PDD" — and for three days it had no producer anywhere in ACE, so the memo
// reported three absent components on a programme missing nine (ace#2056).
//
// The reason it had none is real and is preserved here: PROSE is not parsed,
// for the same reason a filename is not an identity. What the framework
// carries, though, is not prose — it is a TABLE with a `#` column whose cells
// follow the same id grammar as every declaration here (`1` … `12`, `5b`), and
// the author's objection to declaring it twice was exactly right: "Since the
// framework is already in the input set, I want to understand what's actually
// missing before I paste it somewhere else … expect it to change" (2026-09-09,
// ace#2352). Two copies of one list in one document drift.
//
// So the inventory has two sources, in strict precedence:
//
//   1. A DECLARATION on the metadata line, within the first 4 lines:
//        Components: 1, 2, 3, 4, 5, 5b, 6, 7, 8, 9, 10, 11, 12
//      Explicit always wins. It is also the only form a document without a
//      component table can use.
//   2. The framework's own component TABLE — the FIRST table whose header row
//      is `#` then `Component`, reading the `#` column until the first cell
//      that is not an id. Both shapes the author actually produces are read:
//      a Google Doc export (cells arrive as tab-led lines) and a markdown
//      pipe table. The "Components by model" table further down repeats the
//      same ids under the same header, so only the first table is read.
//
// Declared or tabled → the gap list is exact. Neither → `inventory-undeclared`,
// a finding that costs its author one line, and the consumer keeps its loud
// `inventory-unavailable` degrade. A loud gap still beats a confident guess;
// what changed is that the guess-free source the author already maintains is
// finally read.
//
// Pure and content-only: the caller does the Drive reads and hands text in.
//

/** What a document is, as the document itself declares. */
export type ComponentRole =
  | 'component'       // declares `Component: <n> of …`
  | 'program-level'   // declares `Scope: program-level …` (e.g. Learn)
  | 'supporting'      // not PDD-shaped: instruments, research, reviewer notes
  | 'undeclared-pdd'; // PDD-shaped but declares neither — a gap, never a guess

export interface ComponentSetEntry {
  file_id: string;
  /** Drive filename, carried for reporting only — never used to classify. */
  name: string;
  role: ComponentRole;
  /**
   * The author's own component id, verbatim: `"4"`, `"5b"`. A STRING because
   * the framework's table carries `5b` as a component in its own right ("The
   * cash form is Component 5b, not a variant here"), so a numeric id would
   * silently collapse 5 and 5b into one.
   */
  component_id?: string;
  /** Title as declared on the first line, when the doc is PDD-shaped. */
  declared_title?: string;
}

export type ComponentSetFindingCode =
  | 'undeclared-pdd'
  | 'duplicate-component-id'
  | 'no-components'
  | 'inventory-undeclared'
  | 'inventory-conflict';

export interface ComponentSetFinding {
  code: ComponentSetFindingCode;
  /** Filenames the finding is about. */
  where: string[];
  detail: string;
  /** What the author (or ACE) adds to close it. */
  fix: string;
}

export interface ComponentSet {
  /** True when there is at least one component and no blocking finding. */
  ok: boolean;
  components: ComponentSetEntry[];
  programLevel: ComponentSetEntry[];
  supporting: ComponentSetEntry[];
  undeclared: ComponentSetEntry[];
  /**
   * The framework's FULL component inventory, verbatim ids, when a document in
   * the set declares one (`Components: 1, 2, 5b, …`). Sorted and de-duplicated.
   * Absent when nothing declares it, or when two documents declare different
   * inventories — a union of two disagreeing authorities is a guess, and the
   * consumer's loud degrade is the right answer to a guess.
   *
   * This is the SINGLE canonical name for the concept. It travels to
   * `products.framework_component_ids` (`lib/component-products.ts`) and reaches
   * `planLearnModules({ frameworkComponentIds })` unchanged.
   */
  frameworkComponentIds?: string[];
  findings: ComponentSetFinding[];
}

export interface ComponentSetInput {
  file_id: string;
  name: string;
  /** Document text. Only the first few lines are read. */
  text: string;
}

/** A PDD announces itself on line 1. */
const TITLE_RE = /^\s*Program Design Document\s*\(PDD\)\s*:\s*(.+?)\s*$/;

/**
 * `Component: 4 of the graduation component set` — the id may carry a letter
 * suffix (`5b`), which is significant and must not be dropped.
 */
const COMPONENT_RE = /\bComponent:\s*(\d+[a-z]?)\b/i;

/** `Scope: program-level (cross-component)` */
const PROGRAM_LEVEL_RE = /\bScope:\s*program-level\b/i;

/**
 * `Components: 1, 2, 3, 4, 5, 5b, 6, …` — the framework's full inventory.
 *
 * The first token must start with a DIGIT, so the framework's own prose
 * ("Components vs models…", "Components: a menu of what a programme is built
 * from") cannot be mistaken for a declaration. Plural, so it can never collide
 * with `COMPONENT_RE`'s singular `Component: 4` identity line.
 */
const INVENTORY_RE = /\bComponents:\s*(\d+[a-z]?(?:\s*,\s*\d+[a-z]?)*)/i;

/**
 * Read only the head of a document: the title and the metadata line beneath
 * it. Deliberately narrow — `Component:` appears throughout these documents'
 * prose ("see Component 7, open question 2"), and a whole-document scan would
 * classify a cross-reference as an identity.
 */
const HEAD_LINES = 4;

function head(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .slice(0, HEAD_LINES);
}

function classifyOne(input: ComponentSetInput): ComponentSetEntry {
  const lines = head(input.text);
  const titleMatch = lines.length > 0 ? TITLE_RE.exec(lines[0]) : null;
  const base = { file_id: input.file_id, name: input.name };

  if (!titleMatch) return { ...base, role: 'supporting' };

  const declared_title = titleMatch[1];
  // The metadata line is whatever follows the title within the head.
  const meta = lines.slice(1).join('\n');

  const component = COMPONENT_RE.exec(meta);
  if (component) {
    return {
      ...base,
      role: 'component',
      component_id: component[1].toLowerCase(),
      declared_title,
    };
  }

  if (PROGRAM_LEVEL_RE.test(meta)) {
    return { ...base, role: 'program-level', declared_title };
  }

  return { ...base, role: 'undeclared-pdd', declared_title };
}

/**
 * Every inventory declaration in the set, with the document that made it.
 *
 * Scanned over ALL inputs rather than inside `classifyOne`, because the
 * document that carries the inventory is the FRAMEWORK — which is not
 * PDD-shaped and classifies as `supporting`, so `classifyOne` returns before
 * it ever reads a metadata line.
 */
function declaredInventories(
  inputs: ComponentSetInput[],
): { name: string; ids: string[] }[] {
  const out: { name: string; ids: string[] }[] = [];
  for (const input of inputs) {
    const match = INVENTORY_RE.exec(head(input.text).join('\n'));
    if (!match) continue;
    const ids = [
      ...new Set(match[1].split(',').map((id) => id.trim().toLowerCase()).filter(Boolean)),
    ].sort(compareComponentIds);
    if (ids.length > 0) out.push({ name: input.name, ids });
  }
  return out;
}

/** A component id as every convention here spells it: `4`, `5b`, `12`. */
const ID_CELL_RE = /^\d+[a-z]?$/i;

/**
 * Read the framework's component inventory off its own `#` table (ace#2352).
 *
 * Google Docs exports a table as one cell per line, every cell after the first
 * in a row led by a TAB; a markdown source carries the same table as a pipe
 * table. Both reduce to a flat list of cells, so the reader is one loop:
 * find the header (`#` then `Component`), count the header cells, then take
 * every row's first cell while it is an id. It stops at the first non-id in
 * column 0 — the separator line, the next heading, whatever follows the table.
 *
 * Only the FIRST such table is read. The framework's "Components by model"
 * table repeats the ids under the same header and would only ever re-declare
 * the same list; reading it too would make the doc disagree with itself.
 */
function tableInventory(text: string): string[] | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  // Flatten to cells. A pipe-table line yields its cells; a Docs-export line is
  // one cell (its leading tab is the cell boundary). Blank lines end a table.
  const cells: string[] = [];
  let started = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '');
    const isPipe = /^\s*\|/.test(line);
    const rowCells = isPipe
      ? line.split('|').slice(1, -1).map((c) => c.trim())
      : [line.trim()];
    if (isPipe && rowCells.every((c) => /^:?-+:?$/.test(c))) continue; // markdown rule row
    if (!started) {
      if (rowCells[0] === '#') started = true;
      else continue;
    } else if (rowCells.length === 1 && rowCells[0] === '') {
      break;
    }
    cells.push(...rowCells);
  }
  if (!started || cells.length < 2 || !/^component$/i.test(cells[1])) return undefined;

  // Header width = cells up to the first id cell.
  let width = cells.findIndex((c) => ID_CELL_RE.test(c));
  if (width < 2) return undefined;

  const ids: string[] = [];
  for (let i = width; i < cells.length; i += width) {
    const cell = cells[i];
    if (!ID_CELL_RE.test(cell)) break;
    ids.push(cell.toLowerCase());
  }
  return ids.length > 0 ? [...new Set(ids)].sort(compareComponentIds) : undefined;
}

/**
 * Classify an authored document set into the components ACE can address.
 *
 * Order is preserved within each bucket except `components`, which is sorted
 * by the author's own id so downstream output is stable across runs (Drive
 * listing order is not).
 */
export function classifyComponentSet(inputs: ComponentSetInput[]): ComponentSet {
  const entries = inputs.map(classifyOne);

  const components = entries
    .filter((e) => e.role === 'component')
    .sort((a, b) => compareComponentIds(a.component_id!, b.component_id!));
  const programLevel = entries.filter((e) => e.role === 'program-level');
  const supporting = entries.filter((e) => e.role === 'supporting');
  const undeclared = entries.filter((e) => e.role === 'undeclared-pdd');

  const findings: ComponentSetFinding[] = [];

  for (const e of undeclared) {
    findings.push({
      code: 'undeclared-pdd',
      where: [e.name],
      detail:
        `"${e.declared_title}" is a PDD but declares neither a component id nor ` +
        'program-level scope, so ACE cannot tell which component it specifies. ' +
        'Its filename is not evidence — naming a file is not authoring a declaration.',
      fix:
        'Add to the metadata line under the title, matching the set\'s existing ' +
        'convention: `· Component: <n> of the graduation component set` — or ' +
        '`· Scope: program-level (cross-component)` if it spans components.',
    });
  }

  const byId = new Map<string, string[]>();
  for (const c of components) {
    byId.set(c.component_id!, [...(byId.get(c.component_id!) ?? []), c.name]);
  }
  for (const [id, names] of byId) {
    if (names.length > 1) {
      findings.push({
        code: 'duplicate-component-id',
        where: names,
        detail: `${names.length} documents both declare Component ${id}.`,
        fix: 'Give each component a distinct id, or merge the documents.',
      });
    }
  }

  if (components.length === 0) {
    findings.push({
      code: 'no-components',
      where: [],
      detail: 'No document declares a component id, so there is nothing to build per-component.',
      fix: 'Declare `Component: <n> …` on at least one PDD, or run the single-PDD path.',
    });
  }

  // The inventory only means anything on the componentized path; on the
  // single-PDD path there is no framework and nothing to be missing from it.
  let frameworkComponentIds: string[] | undefined;
  if (components.length > 0) {
    // Explicit declarations win outright; the framework's own table is the
    // guess-free fallback that spares the author a second copy of the list.
    let declarations = declaredInventories(inputs);
    if (declarations.length === 0) {
      declarations = inputs.flatMap((input) => {
        const ids = tableInventory(input.text);
        return ids ? [{ name: `${input.name} (component table)`, ids }] : [];
      });
    }
    const distinct = [...new Set(declarations.map((d) => d.ids.join(',')))];

    if (distinct.length === 1) {
      frameworkComponentIds = declarations[0].ids;
    } else if (distinct.length > 1) {
      findings.push({
        code: 'inventory-conflict',
        where: declarations.map((d) => d.name),
        detail:
          `${declarations.length} documents declare a component inventory and they disagree: ` +
          `${declarations.map((d) => `${d.name} → ${d.ids.join(', ')}`).join('; ')}. ` +
          'No inventory is carried, so the Learn build memo degrades to the evidence-based ' +
          'gap list rather than picking one authority or unioning two.',
        fix: 'Leave the inventory declared on exactly one document — the framework — and remove the others.',
      });
    } else {
      findings.push({
        code: 'inventory-undeclared',
        where: [],
        detail:
          'No document declares the framework\'s full component inventory, so the Learn build ' +
          'memo cannot name every component skipped for having no PDD (Learn PDD §6(5)) — it can ' +
          'only name the ones another component happens to reference. No document carries a ' +
          'readable component table either (a `#` / `Component` header with one id per row).',
        fix:
          'Either give the framework document a component table headed `#` / `Component`, or add ' +
          'to its metadata line, within its first 4 lines: `· Components: 1, 2, 3, 4, 5, 5b, 6, …` ' +
          '— every component in the set, including the ones this programme does not carry.',
      });
    }
  }

  return {
    ok: components.length > 0 && findings.every((f) => f.code !== 'no-components'),
    components,
    programLevel,
    supporting,
    undeclared,
    ...(frameworkComponentIds ? { frameworkComponentIds } : {}),
    findings,
  };
}

/** `5` sorts before `5b`, and both before `6`. */
export function compareComponentIds(a: string, b: string): number {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  if (na !== nb) return na - nb;
  return a.localeCompare(b);
}
