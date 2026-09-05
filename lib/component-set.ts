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
// It is the fragility this whole approach exists to avoid, and there is a live
// example: the targeting PDD carried into `poverty-graduation` is named
// "PDD - Targeting Survey (Component 2) — …" and declares NOTHING, because it
// was authored before the convention existed. Matching on the filename would
// silently promote a guess (made by whoever named the file) into the component
// identity every later phase builds on. So an undeclared PDD is reported as
// `undeclared-pdd` and the caller is told the exact line to add. A loud gap
// beats a confident guess — the same rule as § "close the loop to the source
// of truth".
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
  | 'no-components';

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

  return {
    ok: components.length > 0 && findings.every((f) => f.code !== 'no-components'),
    components,
    programLevel,
    supporting,
    undeclared,
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
