/**
 * The attendance checklist: ONE multi-select whose choices are a group's own
 * member cases, plus the hidden roster that applies each member's update.
 *
 * ## Why this exists (voidcraft-labs/commcare-nova#728, adopted 2026-10-08)
 *
 * Until 2026-10-08 a Nova choice field could only take its options from an
 * inline list or a Project data table, so group-payment-test/20261007-1700
 * built attendance as a `query_bound` repeat asking "Was <member> at this
 * session?" yes/no — one screen per member, ~30 screens for a savings group.
 * Nova PR #730 added a third choice source, `kind: 'cases'`, closing #728.
 *
 * This module is the ONE place ACE spells the recipe, so the build skill
 * (`_app-component-library § case-choice-attendance`) and its tripwire
 * (`scripts/probe-nova-case-choices.ts`) cannot drift on what "the ideal
 * attendance form" means. Every shape below was observed live on 2026-10-08,
 * not inferred — see `playbook/integrations/nova-integration.md § The case
 * choices channel`.
 *
 * ## The two halves, and why the second is not optional
 *
 * 1. The CHECKLIST — a `multi_select` with
 *    `optionsSource: {kind: 'cases', caseType, labelProperty, filter}`. The
 *    answer is a space-separated list of exact case ids.
 * 2. The ROSTER — an unlabelled `query_bound` repeat over the same members,
 *    captured ONCE when the form opens, with a hidden `attended` per row and a
 *    case UPDATE conditioned on it.
 *
 * Driving the update repeat from the CHECKLIST instead (`count-selected` /
 * `selected-at` over the answer) is the obvious design, and it is the one ACE
 * itself proposed in commcare-nova#728. It is wrong: a repeat keeps rows it
 * already created when its count shrinks, so a worker who ticks a member,
 * goes Back and unticks them still submits that member's update. Nova's own
 * guidance says so ("A repeat driven by the changing selection retains rows
 * after deselection and is not a safe attendance program"), and the live
 * Preview run confirmed the stable roster keeps all rows and flips the
 * deselected member to `attended = 'no'`.
 */

/** Inputs a PDD supplies. Defaults match the common group → member shape. */
export interface AttendanceChecklistSpec {
  /** Case type of the people being ticked, e.g. `member`. Must declare a parent. */
  readonly memberCaseType: string;
  /** Id of the checklist question. */
  readonly checklistId?: string;
  readonly checklistLabel?: string;
  /** Property shown as each choice's label. Nova's default is `case_name`. */
  readonly labelProperty?: string;
  /** Id of the hidden roster repeat. */
  readonly rosterId?: string;
  /** Member properties to write for each person ticked, as `{property: valueExpression}`. */
  readonly writes?: Readonly<Record<string, string>>;
  /** Id of the case operation. */
  readonly operationId?: string;
}

/**
 * Candidate filter: open members whose parent is the form's selected case.
 *
 * `#row` is the CANDIDATE record and `#case` is the form's selected record.
 * The `ancestor('parent')` walk is refused at write time unless the member
 * type has a declared parent ("Ancestor walk failed: case type 'member' has no
 * parent_type") — call `set_case_type_parent` first. Omitting a status clause
 * offers CLOSED records still on the device, so it is always stated.
 */
export const CHILDREN_OF_SELECTED_CASE_FILTER =
  "#row/status = 'open' and exists(ancestor('parent'), #row/case_id = #case/case_id)";

/** The same set as an id list, for the roster's `ids_query`. */
export function rosterIdsQuery(memberCaseType: string): string {
  return (
    `instance('casedb')/casedb/case[@case_type = '${memberCaseType}'][@status = 'open']` +
    `[index/parent = #case/case_id]/@case_id`
  );
}

/** `add_fields` entries for the form root: the checklist and the roster container. */
export function attendanceRootFields(spec: AttendanceChecklistSpec): Record<string, unknown>[] {
  const checklistId = spec.checklistId ?? 'present';
  return [
    {
      kind: 'multi_select',
      id: checklistId,
      label: spec.checklistLabel ?? 'Who attended?',
      required: 'true()',
      optionsSource: {
        kind: 'cases',
        caseType: spec.memberCaseType,
        labelProperty: spec.labelProperty ?? 'case_name',
        filter: CHILDREN_OF_SELECTED_CASE_FILTER,
      },
    },
    {
      // Unlabelled: it has no worker-facing content, so it renders nothing.
      kind: 'repeat',
      id: spec.rosterId ?? 'roster',
      repeat: { mode: 'query_bound', ids_query: rosterIdsQuery(spec.memberCaseType) },
    },
  ];
}

/** `add_fields` entries for INSIDE the roster (pass the roster's uuid as `parentUuid`). */
export function attendanceRosterFields(spec: AttendanceChecklistSpec): Record<string, unknown>[] {
  const checklistId = spec.checklistId ?? 'present';
  const rosterId = spec.rosterId ?? 'roster';
  return [
    { kind: 'hidden', id: 'member_id', calculate: 'current()/../@id' },
    {
      kind: 'hidden',
      id: 'attended',
      // selected() is fine HERE (a form expression). It is refused in a case
      // operation's condition ("selected() is available in form expressions,
      // but not record expressions"), which is why this hidden answer exists.
      calculate: `if(selected(#form/${checklistId}, #form/${rosterId}/member_id), 'yes', 'no')`,
    },
  ];
}

/** The `add_case_operations` operation: update each roster member the FINAL checklist ticks. */
export function attendanceUpdateOperation(
  spec: AttendanceChecklistSpec,
  rosterUuid: string,
): Record<string, unknown> {
  const rosterId = spec.rosterId ?? 'roster';
  return {
    operation: {
      id: spec.operationId ?? 'mark_attended',
      action: 'update',
      caseType: spec.memberCaseType,
      target: { kind: 'expression', expr: `#form/${rosterId}/member_id` },
      forEach: { repeat: rosterUuid },
      condition: `#form/${rosterId}/attended = 'yes'`,
      writes: Object.entries(spec.writes ?? {}).map(([property, value]) => ({ property, value })),
    },
  };
}
