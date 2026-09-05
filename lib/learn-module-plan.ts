//
// Which Learn modules get BUILT, which get SHOWN, and what is missing.
//
// Stage 2 of the multi-component spec. The Learn PDD for a componentized
// programme specifies one Learn app holding a shared foundations module plus a
// training module per component, with a given model showing foundations plus
// only its active components and hiding the rest.
//
// ## Built and shown are DIFFERENT SETS, and conflating them is the bug
//
// From the Learn PDD, §6(1) and §6(2) as two separate outputs:
//
//   "(1) the shared foundations module plus a training module for every
//    component that has a PDD, all present in the one Learn app (components
//    without a PDD get no module); (2) the gating that shows an FLW the
//    foundations module and only the modules for their model's active
//    components"
//
// So BUILT ⊇ SHOWN. A module exists in the app for every component that has a
// PDD; a model then hides the ones it does not run. Collapsing the two — the
// obvious simplification, since for the FIRST programme they are equal — is
// how the second programme silently loses the gating and ships every module to
// every worker. They are separate fields here for that reason.
//
// ## The gap list needs an inventory ACE does not reliably have
//
// §6(5) requires the build memo to name "every framework component skipped for
// having no PDD". That needs the framework's full component inventory, and the
// framework document does not declare one machine-readably — its component
// table is prose formatting, and parsing it is precisely the fragility the
// component classifier refuses elsewhere (see `component-set.ts`, on why a
// filename is not evidence).
//
// So the inventory is an OPTIONAL input:
//   - supplied  → gaps are enumerated exactly, as the PDD asks.
//   - absent    → one `inventory-unavailable` gap naming what cannot be listed
//                 and the one-line fix, plus whatever absent components other
//                 components explicitly reference (evidence ACE does have,
//                 from `programme-overview.ts`).
//
// Degrading loudly beats guessing at a component list, and beats silently
// reporting "no gaps" for a programme that is missing nine modules.
//

export interface PlannedComponent {
  component_id: string;
  title: string;
  pdd_file_id: string;
}

export interface LearnModule {
  component_id: string;
  title: string;
  pdd_file_id: string;
  /** Always true here — a module is planned because the component HAS a PDD. */
  built: true;
  /** Whether this model turns the component on. Built-but-hidden is legitimate. */
  shown: boolean;
}

export type LearnGapCode =
  | 'framework-component-without-pdd'
  | 'referenced-component-absent'
  | 'inventory-unavailable';

export interface LearnGap {
  code: LearnGapCode;
  /** Component ids, where known. */
  components: string[];
  detail: string;
}

export interface LearnModulePlan {
  /** Foundations is always present; its objectives are fixed by the Learn PDD. */
  foundations: boolean;
  modules: LearnModule[];
  gaps: LearnGap[];
  /**
   * What the shared question bank is scoped to: foundations plus the ACTIVE
   * components — never the built-but-hidden ones. "An FLW is tested on what
   * they will actually deliver, not on hidden modules."
   */
  questionBankScope: { foundations: true; components: string[] };
  /** Lines the build memo must carry (Learn PDD §6(5)). */
  buildMemoNotes: string[];
}

export interface LearnPlanInput {
  /** Components that HAVE a PDD — from `products.components[]`. */
  components: PlannedComponent[];
  /**
   * The model's active selection. Omit for the first-programme default: every
   * component with a PDD is on. Ids not present as components are ignored —
   * a model cannot activate what was never built.
   */
  activeComponentIds?: string[];
  /** The framework's full component inventory, when it is available. */
  frameworkComponentIds?: string[];
  /** From `products.unresolved_references` — absent components others rely on. */
  referencedAbsentIds?: string[];
}

export function planLearnModules(input: LearnPlanInput): LearnModulePlan {
  const built = [...input.components].sort((a, b) =>
    a.component_id.localeCompare(b.component_id, undefined, { numeric: true }),
  );
  const builtIds = new Set(built.map((c) => c.component_id));

  const active = input.activeComponentIds
    ? new Set(input.activeComponentIds.filter((id) => builtIds.has(id)))
    : new Set(builtIds); // default: everything with a PDD is on

  const modules: LearnModule[] = built.map((c) => ({
    component_id: c.component_id,
    title: c.title,
    pdd_file_id: c.pdd_file_id,
    built: true,
    shown: active.has(c.component_id),
  }));

  const gaps: LearnGap[] = [];
  const notes: string[] = [];

  if (input.frameworkComponentIds && input.frameworkComponentIds.length > 0) {
    const missing = input.frameworkComponentIds.filter((id) => !builtIds.has(id));
    if (missing.length > 0) {
      gaps.push({
        code: 'framework-component-without-pdd',
        components: missing,
        detail:
          `${missing.length} framework component(s) have no PDD, so no module is built for them: ` +
          `${missing.join(', ')}. A module is added when that component's PDD arrives.`,
      });
      notes.push(
        `Skipped for having no PDD: ${missing.join(', ')} (${missing.length} of ${input.frameworkComponentIds.length} framework components).`,
      );
    }
  } else {
    gaps.push({
      code: 'inventory-unavailable',
      components: [],
      detail:
        'The framework\'s full component inventory was not supplied, so the build memo cannot ' +
        'list every component skipped for having no PDD (Learn PDD §6(5)). Only components ' +
        'another component explicitly references are known to be absent.',
    });
    notes.push(
      'Framework inventory unavailable — the skipped-component list below is evidence-based, not exhaustive.',
    );
  }

  const referencedAbsent = (input.referencedAbsentIds ?? []).filter((id) => !builtIds.has(id));
  if (referencedAbsent.length > 0) {
    const unique = [...new Set(referencedAbsent)].sort();
    gaps.push({
      code: 'referenced-component-absent',
      components: unique,
      detail:
        `Other components in this programme reference ${unique.join(', ')}, which ${unique.length > 1 ? 'have' : 'has'} ` +
        'no PDD here. No module is built; the overview must say what the referring component does without it.',
    });
    notes.push(`Referenced but absent: ${unique.join(', ')}.`);
  }

  const hidden = modules.filter((m) => !m.shown);
  if (hidden.length > 0) {
    notes.push(
      `Built but hidden for this model: ${hidden.map((m) => m.component_id).join(', ')} — ` +
      'present in the app, gated off, and excluded from the question bank.',
    );
  }

  return {
    foundations: true,
    modules,
    gaps,
    questionBankScope: { foundations: true, components: [...active].sort() },
    buildMemoNotes: notes,
  };
}
