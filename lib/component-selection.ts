//
// Which components does THIS programme turn on?
//
// The component set is a library shared across programmes; an opp is one
// programme selecting from it:
//
//   "we are going to have several opps that re-use as possible but will be
//    turning on and off different components depending on that specific pov
//    grad program."                                    — Jon, 2026-09-05
//
// This is the minimum that makes that real, and deliberately no more. From the
// same steer: build "a default plus a recorded selection ... until a second
// programme exists to disagree with it". So there is no variant matrix here, no
// per-component overrides and no selection UI — those are Stage 3, and building
// them now would be designing against one example.
//
// ## Why a default is not the same as no selection
//
// The first programme does not have to declare anything: every component with a
// PDD is on, which is well-defined and needs nothing from the author. But
// `defaulted: true` is carried in the result rather than being invisible,
// because the day a SECOND programme wants a different mix, "this opp never
// declared a selection" and "this opp declared all of them" are different
// facts, and a run that cannot tell them apart will quietly give the second
// programme the first one's shape.
//
// ## A declared id with no component is LOUD
//
// Selecting a component this library does not carry is not a no-op to skip
// past. It means the programme intends something the build cannot deliver —
// most likely a component whose PDD has not been written yet — and silently
// dropping it produces an app that is missing a module nobody asked about.
//

export interface SelectionInput {
  /** Component ids available in the library, i.e. those that HAVE a PDD. */
  availableIds: string[];
  /**
   * What this programme declares it turns on. Omit (or empty) for the
   * first-programme default: everything available.
   */
  declaredIds?: string[];
}

export type SelectionFindingCode =
  | 'no-selection-declared'
  | 'selects-unavailable-component'
  | 'selects-nothing';

export interface SelectionFinding {
  code: SelectionFindingCode;
  components: string[];
  detail: string;
  fix: string;
}

export interface ResolvedSelection {
  /** The components this programme turns on, sorted. */
  activeIds: string[];
  /** Available but deliberately off — built, then gated out of this model. */
  inactiveIds: string[];
  /** True when nothing was declared and the default was applied. */
  defaulted: boolean;
  findings: SelectionFinding[];
}

export function resolveSelection(input: SelectionInput): ResolvedSelection {
  const available = [...new Set(input.availableIds)];
  const declared = input.declaredIds ? [...new Set(input.declaredIds)] : undefined;
  const findings: SelectionFinding[] = [];

  if (!declared || declared.length === 0) {
    return {
      activeIds: [...available].sort(),
      inactiveIds: [],
      defaulted: true,
      findings: [
        {
          code: 'no-selection-declared',
          components: [],
          detail:
            'This programme declares no component selection, so every component with a PDD is ' +
            'on. Correct for a first programme; ambiguous once a second one wants a different mix.',
          fix:
            'Declare the selection on the opp when it matters — until then the default is ' +
            'intentional, not missing.',
        },
      ],
    };
  }

  const unavailable = declared.filter((id) => !available.includes(id));
  if (unavailable.length > 0) {
    findings.push({
      code: 'selects-unavailable-component',
      components: unavailable,
      detail:
        `This programme turns on ${unavailable.join(', ')}, which the component library does not ` +
        'carry — most likely a component whose PDD has not been written yet. No module can be ' +
        'built for it, and dropping it silently would produce an app missing a module nobody asks about.',
      fix:
        'Either add that component\'s PDD to the library, or remove it from this programme\'s selection.',
    });
  }

  const activeIds = declared.filter((id) => available.includes(id)).sort();

  if (activeIds.length === 0) {
    findings.push({
      code: 'selects-nothing',
      components: [],
      detail:
        'No declared component is available, so this programme would build foundations and nothing else.',
      fix: 'Check the selection against the library\'s component ids.',
    });
  }

  return {
    activeIds,
    inactiveIds: available.filter((id) => !activeIds.includes(id)).sort(),
    defaulted: false,
    findings,
  };
}
