/**
 * Probe: can ACE build a case-sourced attendance checklist on Nova, end to end?
 *
 * ## Why this exists (voidcraft-labs/commcare-nova#728, adopted 2026-10-08)
 *
 * group-payment-test/20261007-1700 needed attendance as a tick-list of a
 * group's members. Nova then offered choice sources of only two kinds (inline,
 * Project data table), so ACE shipped one yes/no screen per member and filed
 * commcare-nova#728. Nova PR #730 added `kind: 'cases'` and closed it the next
 * day. Nothing on ACE's side fails when a granted ask ships, so without a probe
 * the one-screen-per-member workaround would simply keep getting built.
 *
 * This probe is the REGRESSION tripwire for the adopted recipe in
 * `lib/case-choice-attendance.ts`. It builds the recipe on a throwaway app,
 * then checks three things, each by READ-BACK rather than by the write's own
 * response (`skills/nova-capability-adoption § Step 2`):
 *
 *   1. the saved checklist field reads back `optionsSource.kind === 'cases'`;
 *   2. Preview offers exactly the selected group's OPEN members — not another
 *      group's member, not a closed one;
 *   3. after tick-three-then-untick-one, the roster still has every member and
 *      the unticked one reads `attended = 'no'` — the deselection safety the
 *      stable roster exists for.
 *
 * Usage:
 *   npx tsx scripts/probe-nova-case-choices.ts [--json] [--keep]
 *
 * Requires `NOVA_API_KEY`. Creates and deletes a throwaway Nova app in the
 * caller's personal Project (everything it creates is app-scoped); writes
 * nothing to CommCare HQ.
 *
 * Exit codes:
 *   0  works — expected state since 2026-10-08.
 *   2  the case source binds but its choices or the roster are wrong — treat as
 *      an upstream regression; the yes/no-per-member fallback must come back.
 *   3  the case source does not bind at all.
 *   1  usage / transport / auth error. Says nothing about the capability.
 */
import { NOVA_MCP_URL, resolveNovaApiKey } from './probe-nova-contract.js';
import { novaCall } from '../lib/nova-rpc.js';
import { NovaWork } from '../lib/nova-work.js';
import {
  attendanceRootFields,
  attendanceRosterFields,
  attendanceUpdateOperation,
  type AttendanceChecklistSpec,
} from '../lib/case-choice-attendance.js';

/** What the probe observed. Pure data, so the classifier is unit-testable. */
export interface CaseChoiceProbeResult {
  /** The saved field read back a `kind: 'cases'` source. */
  readonly bound: boolean;
  /** Choice values Preview offered, in order. */
  readonly offered: readonly string[];
  /** The values that SHOULD be offered (the group's open members). */
  readonly expected: readonly string[];
  /** Roster row → `attended` after the deselection, e.g. `{m1:'yes', m2:'no'}`. */
  readonly rosterAttended: Readonly<Record<string, string>>;
  /** The member ticked and then unticked. */
  readonly deselected: string;
  readonly error?: string;
}

export type CaseChoiceVerdict = 'works' | 'wrong-behaviour' | 'not-bound';

/** Pure. Map an observation onto the verdict the exit code reports. */
export function classifyCaseChoiceProbe(r: CaseChoiceProbeResult): CaseChoiceVerdict {
  if (!r.bound) return 'not-bound';
  const sameSet = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');
  const scoped = sameSet(r.offered, r.expected);
  const rosterComplete = sameSet(Object.keys(r.rosterAttended), r.expected);
  const deselectSafe =
    r.rosterAttended[r.deselected] === 'no' &&
    r.expected.filter((id) => id !== r.deselected).every((id) => r.rosterAttended[id] === 'yes');
  return scoped && rosterComplete && deselectSafe ? 'works' : 'wrong-behaviour';
}

export function remedyFor(v: CaseChoiceVerdict): string {
  switch (v) {
    case 'works':
      return (
        'EXPECTED (since 2026-10-08): build attendance as ONE case-sourced checklist with a stable ' +
        'roster (_app-component-library § case-choice-attendance).'
      );
    case 'wrong-behaviour':
      return (
        'REGRESSION: the case source binds, but its choices are mis-scoped or the roster is not ' +
        'deselection-safe. Do not ship the checklist; fall back to one yes/no question per roster ' +
        'member and run skills/upstream-regression-triage against voidcraft-labs/commcare-nova ' +
        '(prior art: commcare-nova#728 / PR #730).'
      );
    case 'not-bound':
      return (
        "REGRESSION: a kind:'cases' choice source no longer binds. Fall back to one yes/no question " +
        'per roster member and run skills/upstream-regression-triage (commcare-nova#728).'
      );
  }
}

const SPEC: AttendanceChecklistSpec = {
  memberCaseType: 'member',
  writes: { last_attended: '#form/session_date' },
};

/** Test records: g1 has three open members and one closed; g2 has one member. */
const SCENARIO = {
  records: [
    { id: 'g1', caseType: 'group', name: 'Group One' },
    { id: 'g2', caseType: 'group', name: 'Group Two' },
    { id: 'm1', caseType: 'member', name: 'Amina', parentId: 'g1' },
    { id: 'm2', caseType: 'member', name: 'Bilal', parentId: 'g1' },
    { id: 'm3', caseType: 'member', name: 'Chidi', parentId: 'g1' },
    { id: 'm4', caseType: 'member', name: 'Dee (other group)', parentId: 'g2' },
    { id: 'm5', caseType: 'member', name: 'Eve (closed)', parentId: 'g1', closedOn: '2026-10-01T00:00:00Z' },
  ],
};
const EXPECTED = ['m1', 'm2', 'm3'];
const DESELECTED = 'm2';

/** Live end-to-end probe. Deletes the app unless `keep`. */
export async function probeNovaCaseChoices(
  apiKey: string,
  opts: { keep?: boolean } = {},
): Promise<CaseChoiceProbeResult & { appId?: string }> {
  const call = (name: string, args: Record<string, unknown>) => novaCall(name, args, { apiKey });
  const work = await NovaWork.begin(
    { newApp: { name: `ACE case-choices probe ${new Date().toISOString()}` } },
    { call },
  );
  let appId: string | undefined;
  const blank = { offered: [], expected: EXPECTED, rosterAttended: {}, deselected: DESELECTED };
  try {
    const groups = (await work.stage('create_module', { name: 'Groups', case_type: 'group' })).moduleUuid as string;
    const reg = (await work.stage('create_form', { moduleUuid: groups, name: 'Register group', type: 'registration' }))
      .formUuid as string;
    await work.stage('add_fields', {
      moduleUuid: groups,
      formUuid: reg,
      fields: [{ kind: 'text', id: 'group_name', label: 'Group name', required: 'true()' }],
    });
    await work.stage('update_form', { moduleUuid: groups, formUuid: reg, recordName: '#form/group_name' });
    const addMember = (await work.stage('create_form', { moduleUuid: groups, name: 'Add member', type: 'followup' }))
      .formUuid as string;
    await work.stage('add_fields', {
      moduleUuid: groups,
      formUuid: addMember,
      fields: [
        { kind: 'text', id: 'member_name', label: 'Member name', required: 'true()' },
        { kind: 'hidden', id: 'member_record_name', calculate: '#form/member_name', caseWrite: { caseType: 'member', property: 'case_name' } },
      ],
    });
    // The checklist's ancestor walk is refused without a declared parent.
    await work.stage('set_case_type_parent', { caseType: 'member', parentType: 'group', relationship: 'child' });

    const session = (await work.stage('create_form', { moduleUuid: groups, name: 'Session', type: 'followup' }))
      .formUuid as string;
    const root: any = await work.stage('add_fields', {
      moduleUuid: groups,
      formUuid: session,
      fields: [{ kind: 'date', id: 'session_date', label: 'Session date', required: 'true()' }, ...attendanceRootFields(SPEC)],
    });
    const rosterUuid = root?.fields?.find((f: any) => f.id === 'roster')?.uuid as string;
    await work.stage('add_fields', {
      moduleUuid: groups,
      formUuid: session,
      parentUuid: rosterUuid,
      fields: attendanceRosterFields(SPEC),
    });
    await work.stage('add_case_operations', {
      moduleUuid: groups,
      formUuid: session,
      operations: [attendanceUpdateOperation(SPEC, rosterUuid)],
    });
    // CommCare requires a module for every case type a form creates.
    await work.stage('create_module', {
      name: 'Members',
      case_type: 'member',
      case_list_only: true,
      parentCaseModuleUuid: groups,
    });
    appId = ((await work.save()) as { appId?: string }).appId;

    // 1. Read the source back from the SAVED app.
    const form: any = await call('get_form', { app_id: appId, moduleUuid: groups, formUuid: session });
    const checklist = form?.form?.fields?.find((f: any) => f.id === 'present');
    const bound = checklist?.optionsSource?.kind === 'cases';

    // 2 + 3. Tick all three, then untick one, and read Preview's state.
    const ev: any = await call('evaluate_form', {
      app_id: appId,
      moduleUuid: groups,
      formUuid: session,
      caseIds: ['g1'],
      scenario: SCENARIO,
      answers: [
        { path: 'session_date', value: '2026-10-08' },
        { path: 'present', value: EXPECTED.join(' ') },
        { path: 'present', value: EXPECTED.filter((id) => id !== DESELECTED).join(' ') },
      ],
    });
    const fields: any[] = ev?.fields ?? [];
    const offered = (fields.find((f) => f.path === 'present')?.choices ?? []).map((c: any) => String(c.value));
    const rosterAttended: Record<string, string> = {};
    for (const f of fields) {
      const m = /^roster\[(\d+)\]\/member_id$/.exec(f.path);
      if (!m) continue;
      const attended = fields.find((g) => g.path === `roster[${m[1]}]/attended`);
      rosterAttended[String(f.value)] = String(attended?.value ?? '');
    }
    return { bound, offered, expected: EXPECTED, rosterAttended, deselected: DESELECTED, appId };
  } catch (e) {
    return { ...blank, bound: false, error: (e as Error).message, appId };
  } finally {
    if (!opts.keep) {
      if (appId) {
        await call('delete_app', { app_id: appId }).catch((e) =>
          process.stderr.write(`probe-nova-case-choices: WARNING — could not delete app ${appId}: ${String(e)}\n`),
        );
      } else {
        await work.discard().catch(() => undefined);
      }
    }
  }
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const keep = process.argv.includes('--keep');
  const apiKey = resolveNovaApiKey();
  if (!apiKey) {
    process.stderr.write('probe-nova-case-choices: NOVA_API_KEY not found. Run /ace:setup --force-env.\n');
    process.exit(1);
  }
  let observed: Awaited<ReturnType<typeof probeNovaCaseChoices>>;
  try {
    observed = await probeNovaCaseChoices(apiKey, { keep });
  } catch (err) {
    process.stderr.write(`probe-nova-case-choices: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const verdict = classifyCaseChoiceProbe(observed);
  const remedy = remedyFor(verdict);
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...observed, verdict, remedy }, null, 2)}\n`);
  } else {
    process.stdout.write(`Nova ${NOVA_MCP_URL} — case-choices probe\n`);
    process.stdout.write(`  kind:'cases' source reads back : ${observed.bound ? 'OK' : 'NO'}\n`);
    process.stdout.write(`  offered ${JSON.stringify(observed.offered)} (expected ${JSON.stringify(observed.expected)})\n`);
    process.stdout.write(`  roster after unticking ${observed.deselected}: ${JSON.stringify(observed.rosterAttended)}\n`);
    if (observed.error) process.stdout.write(`    ↳ ${observed.error.replace(/\s+/g, ' ').slice(0, 300)}\n`);
    if (keep) process.stdout.write(`  kept app: ${observed.appId}\n`);
    process.stdout.write(`\n${verdict.toUpperCase()} — ${remedy}\n`);
  }
  process.exit(verdict === 'works' ? 0 : verdict === 'wrong-behaviour' ? 2 : 3);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
