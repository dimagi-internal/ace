//
// What Phase 1 WRITES for a componentized programme.
//
// `component-set.ts` decides which documents are components. `programme-overview.ts`
// decides what the overview must answer. This turns both into the exact
// `run_state.phases.idea-to-design.products` object Phase 1 hands downstream,
// so the shape is pinned in one testable place rather than described in prose
// across a 1,500-line SKILL.md and drifting.
//
// ## `products.pdd` stays populated. That is the whole point.
//
// 17 places read `products.pdd` directly and many more read "the PDD" as a
// concept, so a componentized run does NOT null it — the decision recorded in
// `docs/superpowers/specs/2026-09-05-multi-component-programmes.md`. It points
// at the programme OVERVIEW: which components are on, the shared
// case-and-state model, how they compose, what each phase should read. Not a
// restatement of the components (that is the flattening this exists to stop),
// and not a bare pointer either:
//
//   "we must have enough information to execute everything downstream from the
//    initial inputs or we can't really proceed anyways meaningfully."
//                                                     — Jon, 2026-09-05
//
// ## Two modes, and the guard between them
//
// `synthesized` is every opp ACE has ever run: one PDD, authored by Phase 1
// from raw material. `componentized` is the new path. The mode is DERIVED from
// whether the documents declare components, never configured — so an existing
// opp cannot accidentally take the new path, and this one cannot silently
// degrade to the old one. `buildComponentProducts` refuses to emit
// `componentized` with zero components, because that combination is exactly a
// misclassification wearing the new mode's name.
//

import type { ComponentSet } from './component-set';
import type { ProgrammeReadiness, OverviewObligation } from './programme-overview';

export type DesignMode = 'synthesized' | 'componentized';

export interface ComponentProduct {
  /** The author's own id, verbatim (`"4"`, `"5b"`). */
  component_id: string;
  /** Declared title from the PDD's first line. */
  title: string;
  /** Drive fileId of the component's own PDD — downstream reads THIS, not the overview. */
  pdd_file_id: string;
}

export interface ProgramLevelProduct {
  title: string;
  file_id: string;
}

export interface ComponentDesignProducts {
  /** Derived, never configured. */
  mode: DesignMode;
  /** Sorted by the author's component id. */
  components: ComponentProduct[];
  /** Cross-component PDDs (Learn). Not components; not synthesized away either. */
  program_level: ProgramLevelProduct[];
  /**
   * What the overview must answer. Carried in `products` on purpose: a later
   * phase that finds the overview thin can say WHICH question it is missing,
   * instead of failing with "the PDD is inadequate".
   */
  overview_obligations: OverviewObligation[];
  /** `from` leans on `to`, which this programme does not carry. */
  unresolved_references: { from: string; to: string }[];
}

export class ComponentProductsError extends Error {}

/**
 * Build the Phase 1 products handoff for a componentized run.
 *
 * Throws rather than returning a degraded object: a caller that has classified
 * zero components should be taking the `synthesized` path, and silently
 * handing downstream an empty `components[]` under `mode: 'componentized'`
 * would produce a run that looks componentized and builds nothing.
 */
export function buildComponentProducts(
  set: ComponentSet,
  readiness: ProgrammeReadiness,
): ComponentDesignProducts {
  const components: ComponentProduct[] = set.components.map((c) => {
    if (!c.component_id) {
      throw new ComponentProductsError(
        `component "${c.name}" reached products with no component_id — classifyComponentSet should have made it undeclared-pdd`,
      );
    }
    return {
      component_id: c.component_id,
      title: c.declared_title ?? c.name,
      pdd_file_id: c.file_id,
    };
  });

  if (components.length === 0) {
    throw new ComponentProductsError(
      'no components declared — this run belongs on the synthesized path, not the componentized one',
    );
  }

  return {
    mode: 'componentized',
    components,
    program_level: set.programLevel.map((p) => ({
      title: p.declared_title ?? p.name,
      file_id: p.file_id,
    })),
    overview_obligations: readiness.obligations,
    unresolved_references: readiness.unresolved.map(({ from, to }) => ({ from, to })),
  };
}

/**
 * Which path a document set belongs on. Derived from the documents; the ONLY
 * thing that puts a run on the componentized path.
 */
export function designModeFor(set: ComponentSet): DesignMode {
  return set.components.length > 0 ? 'componentized' : 'synthesized';
}
