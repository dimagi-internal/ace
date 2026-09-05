//
// What must the programme overview say for a componentized run to be executable?
//
// `component-set.ts` answers "which of these documents is a component". This
// answers the question directly after it, and it is the one that decides
// whether a run can proceed at all:
//
//   "we must have enough information to execute everything downstream from the
//    initial inputs or we can't really proceed anyways meaningfully. So the
//    programme overview doc needs to explain how to use the components."
//                                                     — Jon, 2026-09-05
//
// `run_state.phases.idea-to-design.products.pdd` stays populated in a
// componentized run (17 places read it directly, and many more read "the PDD"
// as a concept). What changes is what it CONTAINS. It is not a restatement of
// the components — that is the flattening this whole effort exists to stop —
// and it is not a bare pointer at them either, because a pointer carries none
// of the information a build needs. It is the layer BETWEEN: which components
// are active, the shared case-and-state model they all key off, how they
// compose, and what each downstream phase should read.
//
// ## Obligations, not errors
//
// The interesting output is not a pass/fail. It is a list of questions the
// overview MUST answer, derived from the component set itself. Measured on
// `poverty-graduation`, 2026-09-05, from the real documents:
//
//   Component 5 (Productive Asset) references Components 6 and 9
//   Component 6 (Consumption Support) references Component 5b
//   Component 4 (Enrollment) references Components 2 and 3
//
// The programme carries 2, 4, 5 and 6 — so 9, 5b and 3 are referenced but not
// present. None of those is a defect: a programme is a SELECTION, and leaving
// monitoring out is a legitimate choice. But each one is a question the build
// cannot answer on its own — what does asset transfer do when the monitoring
// that gates its second round is not in this programme? — and if the overview
// is silent, some later phase invents an answer. Surfacing it as an obligation
// puts the question in front of the author while it is still cheap.
//
// ## Why this reads the BODY, where the classifier reads only the head
//
// A deliberate inversion of `component-set.ts`, which reads four lines
// precisely so a prose cross-reference is never mistaken for an identity.
// Here the cross-references ARE the signal, so the whole body is in scope. The
// two are kept apart for that reason: identity is declared, relationships are
// mentioned, and conflating them is how "Component 5b (cash asset transfer)
// also uses it" would have become a second component.
//

import type { ComponentSet } from './component-set';

export interface CrossReference {
  /** The referring component's declared id. */
  from: string;
  /** The referenced component id, as written in the prose. */
  to: string;
  /** Whether `to` is a component of THIS programme. */
  resolved: boolean;
}

export type ObligationCode =
  | 'declare-selection'        // which components this programme turns on
  | 'declare-case-model'       // the shared state every component keys off
  | 'declare-composition'      // the order/seams between active components
  | 'resolve-absent-reference' // a component leans on one that is not here
  | 'declare-downstream-use';  // what each phase should read

export interface OverviewObligation {
  code: ObligationCode;
  /** Component ids the obligation concerns; empty when programme-wide. */
  components: string[];
  /** The question the overview must answer, in the author's terms. */
  question: string;
}

export interface ProgrammeReadiness {
  /**
   * True when there is something to build. Obligations do NOT clear this —
   * they are work for the overview, not a gate on classification.
   */
  ok: boolean;
  crossReferences: CrossReference[];
  unresolved: CrossReference[];
  obligations: OverviewObligation[];
}

export interface ComponentBody {
  component_id: string;
  /** Full document text. */
  text: string;
}

/**
 * A prose reference: `Component 5b`, `Component 9`.
 *
 * The negative lookahead on `:` is load-bearing — it excludes the document's
 * OWN declaration line (`Component: 4 of the graduation component set`), which
 * would otherwise make every component reference itself.
 */
const PROSE_REF_RE = /\bComponent\s+(\d+[a-z]?)\b/gi;

export function findCrossReferences(
  bodies: ComponentBody[],
  presentIds: Iterable<string>,
): CrossReference[] {
  const present = new Set([...presentIds].map((id) => id.toLowerCase()));
  const out: CrossReference[] = [];
  const seen = new Set<string>();

  for (const body of bodies) {
    const from = body.component_id.toLowerCase();
    for (const m of body.text.matchAll(PROSE_REF_RE)) {
      const to = m[1].toLowerCase();
      if (to === from) continue; // self-reference carries no information
      const key = `${from}->${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from, to, resolved: present.has(to) });
    }
  }

  return out.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/**
 * Derive what the overview must answer, from the set and its cross-references.
 */
export function assessProgrammeReadiness(
  set: ComponentSet,
  bodies: ComponentBody[],
): ProgrammeReadiness {
  const ids = set.components.map((c) => c.component_id!).filter(Boolean);
  const crossReferences = findCrossReferences(bodies, ids);
  const unresolved = crossReferences.filter((r) => !r.resolved);

  const obligations: OverviewObligation[] = [];

  if (ids.length > 0) {
    obligations.push({
      code: 'declare-selection',
      components: ids,
      question: `Which components does this programme turn on? (${ids.length} declared: ${ids.join(', ')})`,
    });
    obligations.push({
      code: 'declare-case-model',
      components: [],
      question:
        'What is the shared case-and-state model every active component reads and writes?',
    });
    obligations.push({
      code: 'declare-composition',
      components: ids,
      question:
        'In what order do the active components run, and what state does each hand the next?',
    });
    obligations.push({
      code: 'declare-downstream-use',
      components: ids,
      question:
        'What should each downstream phase read per component — its forms, its deliver/payment units, its training requirements?',
    });
  }

  // One obligation per referring component, not per reference, so an author
  // answering "what does 5 do without 9" is not asked the same thing twice.
  const byFrom = new Map<string, string[]>();
  for (const r of unresolved) {
    byFrom.set(r.from, [...(byFrom.get(r.from) ?? []), r.to]);
  }
  for (const [from, tos] of [...byFrom].sort()) {
    obligations.push({
      code: 'resolve-absent-reference',
      components: [from, ...tos],
      question:
        `Component ${from} refers to Component${tos.length > 1 ? 's' : ''} ${tos.join(', ')}, ` +
        `which ${tos.length > 1 ? 'are' : 'is'} not in this programme. What does ${from} do ` +
        'without it — is the dependency dropped, stubbed, or does it make the component unbuildable here?',
    });
  }

  return { ok: ids.length > 0, crossReferences, unresolved, obligations };
}
