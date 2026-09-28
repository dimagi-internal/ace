/**
 * Probe: can ACE build a lookup-backed select on Nova, end to end?
 *
 * ## Why this exists (dimagi-internal/ace, fixtures adoption 2026-09-01)
 *
 * Nova shipped a full Project-data-table (fixture) authoring surface —
 * `create_lookup_table` and friends. Three ACE files said the opposite
 * (a now-retired claim that no such create atom existed), and
 * `lib/option-register.ts` + `pdd-to-deliver-app § Step 4f` built a
 * CSV-emit-and-HALT workaround on it. This is the media-channel
 * class (`voidcraft-labs/nova-plugin#8`, granted and unnoticed for three
 * months) repeating.
 *
 * But a `tools/list` entry is NOT a capability. Probed live on 2026-09-01:
 * the table half worked and the BINDING half was inert — `set_field_options_source`
 * and `add_fields optionsSource` both refused a `kind: 'lookup'` source with
 * "its Project lookup definitions are unavailable", on a fresh app and a
 * fresh table, every time (`voidcraft-labs/commcare-nova#545`). So the halt
 * stayed and only its stated reason changed.
 *
 * **That block lifted.** `voidcraft-labs/commcare-nova#545` closed COMPLETED
 * on 2026-09-02, and this probe returned `both` on 2026-09-06. The Step 4f
 * partner-register handoff is retired (ace#1886). The file keeps its job in the
 * other direction: it is now the REGRESSION tripwire for a capability ACE
 * depends on, not the adoption tripwire for one it lacks.
 *
 * ## Why the bind is checked by READ-BACK
 *
 * Until 2026-09-06 this probe scored the bind as "the write returned no
 * error". That was never evidence. Observed live the same day: `add_fields`
 * answers a correctly-bound lookup field with `"options": []` and no mention
 * of the source at all, so the write response cannot distinguish a bind that
 * landed from one that did not. The probe now calls `get_field` and checks the
 * `optionsSource` that comes back, via `verifyLookupBind` in
 * `lib/option-register.ts` — the same helper `pdd-to-deliver-app § Step 4f`
 * uses, so the run and the probe agree on what "bound" means.
 *
 * Since ace#2143 that helper also reads the bound TABLE's rows and refuses a
 * value column that repeats a code. The probe passes a live
 * `get_lookup_table_rows` read so Nova's row shape is exercised here, but its
 * verdict keys on `bindLanded` rather than `verified`: a table-content finding
 * is a fact about the throwaway table, not an upstream binding regression.
 *
 * Run it when: a Nova release lands, `probe-nova-contract.ts` reports a new
 * tool count, or a build reports a register bind it could not verify.
 *
 * Usage:
 *   npx tsx scripts/probe-nova-fixtures.ts [--json] [--keep]
 *
 *   --json  machine-readable
 *   --keep  do not delete the throwaway app (for filing an upstream repro)
 *
 * Requires `NOVA_API_KEY`. Creates and deletes a throwaway Nova app in the
 * caller's personal Project; writes nothing to CommCare HQ.
 *
 * Exit codes:
 *   0  BOTH halves work — current expected state since 2026-09-06.
 *   2  create-only — the bind regressed. Step 4f can no longer finish the
 *      register autonomously; treat as an upstream regression.
 *   3  neither — the create atom regressed too.
 *   1  usage / transport / auth error. Says nothing about the capability.
 */
import { NOVA_MCP_URL, resolveNovaApiKey } from './probe-nova-contract.js';
import { novaCall } from '../lib/nova-rpc.js';
import { NovaWork } from '../lib/nova-work.js';
import { verifyLookupBind } from '../lib/option-register.js';

/** What the probe observed. Pure data, so the classifier is unit-testable. */
export interface FixtureProbeResult {
  /** `create_lookup_table` returned a tableId with its rows. */
  readonly canCreateTable: boolean;
  /**
   * A select is PROVABLY bound to that table: the write was accepted AND
   * `get_field` read the lookup source back. Both halves are required — see
   * the header on why the write response alone says nothing.
   */
  readonly canBindSelect: boolean;
  /** The write was accepted. On its own this is NOT a bind; see `canBindSelect`. */
  readonly bindAccepted?: boolean;
  /** Why the read-back did not confirm the bind, when it did not. */
  readonly bindReadBackIssue?: string;
  /** Verbatim refusal from the binding attempt, when there was one. */
  readonly bindError?: string;
}

export type FixtureVerdict = 'both' | 'create-only' | 'none';

/**
 * Pure. Map an observation onto the verdict the exit code reports.
 *
 * Deliberately has no "transient" arm. Nova's refusal *says* "wait for lookup
 * data to reconnect, then retry", and believing that message is what would
 * turn a hard block into a flaky-looking one; it was reproduced across
 * separate apps, tables and minutes. A retry belongs in the caller, not here.
 */
export function classifyFixtureProbe(r: FixtureProbeResult): FixtureVerdict {
  if (!r.canCreateTable) return 'none';
  return r.canBindSelect ? 'both' : 'create-only';
}

/** The remedy each verdict implies, phrased so a report can print it verbatim. */
export function remedyFor(v: FixtureVerdict): string {
  switch (v) {
    case 'both':
      return (
        'EXPECTED (since 2026-09-06): the binding works and reads back. ' +
        'pdd-to-deliver-app § Step 4f creates, populates AND binds the partner register ' +
        'autonomously; the halt is scoped to the undeclared-register case.'
      );
    case 'create-only':
      return (
        'REGRESSION: the bind no longer lands. Step 4f cannot finish a declared register ' +
        'autonomously, so it must HALT with the bind named as the remaining step rather than ' +
        'ship inline placeholders. Run skills/upstream-regression-triage against ' +
        'voidcraft-labs/commcare-nova; the prior occurrence is commcare-nova#545.'
      );
    case 'none':
      return (
        'REGRESSION: create_lookup_table no longer works. Run ' +
        'skills/upstream-regression-triage against voidcraft-labs/commcare-nova.'
      );
  }
}

/**
 * Live end-to-end probe. Builds a throwaway app in private work, a table with
 * rows, and a select bound to it; saves; reads the bind back from the SAVED
 * app. Deletes everything unless `keep`.
 *
 * Since voidcraft-labs/commcare-nova#693 (2026-09-27) there is no `create_app`
 * and no starter module: the app is `begin_work({new_app})`, it only exists
 * after the first `save_work`, and a save needs a complete, valid candidate —
 * so the module, form and bound field go in before the first save.
 */
export async function probeNovaFixtures(
  apiKey: string,
  opts: { keep?: boolean } = {},
): Promise<FixtureProbeResult & { appId?: string; tableId?: string }> {
  const call = (name: string, args: Record<string, unknown>) => novaCall(name, args, { apiKey });
  const work = await NovaWork.begin(
    { newApp: { name: `ACE fixtures probe ${new Date().toISOString()}` } },
    { call },
  );
  let appId: string | undefined;
  let moduleUuid: string | undefined;
  let formUuid: string | undefined;
  let createdTableId: string | undefined;
  let createdFieldUuid: string | undefined;

  try {
    moduleUuid = (await work.stage('create_module', { name: 'Probe', case_type: null })).moduleUuid as string;
    formUuid = (await work.stage('create_form', { moduleUuid, name: 'Probe form', type: 'survey' }))
      .formUuid as string;

    // Tags are unique per PROJECT and the table OUTLIVES the app, so a fixed
    // tag makes the second run fail with `tag_taken` — which reads exactly
    // like a regression. Unique per run, and removed in the finally below.
    // Project data is NOT staged: this commits now, whatever happens to the work.
    let table: any;
    try {
      table = await work.stage('create_lookup_table', {
        name: 'ACE fixture probe',
        tag: `ace_fixture_probe_${Date.now().toString(36)}`,
        columns: [
          { key: 'v', wireName: 'value', label: 'Value', dataType: 'text' },
          { key: 'l', wireName: 'label', label: 'Label', dataType: 'text' },
        ],
        rows: [
          { cells: [{ columnKey: 'v', value: 'x' }, { columnKey: 'l', value: 'X' }] },
          { cells: [{ columnKey: 'v', value: 'y' }, { columnKey: 'l', value: 'Y' }] },
        ],
      });
    } catch (e) {
      return { canCreateTable: false, canBindSelect: false, bindError: `create failed: ${(e as Error).message}` };
    }

    const tableId: string | undefined = table?.tableId;
    createdTableId = tableId;
    const canCreateTable = Boolean(tableId) && Array.isArray(table?.rows) && table.rows.length === 2;
    if (!canCreateTable) {
      return { canCreateTable: false, canBindSelect: false, tableId };
    }

    const [valueColumnId, labelColumnId] = table.columns.map((c: any) => c.columnId);
    const requested = {
      tableId: tableId as string,
      valueColumnId: valueColumnId as string,
      labelColumnId: labelColumnId as string,
    };
    let bindError: string | undefined;
    try {
      const bound = await work.stage('add_fields', {
        moduleUuid,
        formUuid,
        fields: [
          // A second, unbound field. `save_work` refuses a candidate whose form
          // has no fields ("CommCare can't build"), so without it the teardown's
          // remove_field can never be saved, the bind is never dropped, and the
          // table leaks (observed 2026-09-28 — two tables pinned for 30 days).
          { kind: 'text', id: 'probe_note', label: 'Note' },
          {
            kind: 'single_select',
            id: 'probe_pick',
            label: 'Pick',
            optionsSource: { kind: 'lookup', tableId, valueColumnId, labelColumnId },
          },
        ],
      });
      createdFieldUuid = (bound as any)?.fields?.find((f: any) => f.id === 'probe_pick')?.uuid;
      // The first save CREATES the app. Until it succeeds nothing is bound.
      appId = (await work.save() as { appId?: string }).appId;
    } catch (e) {
      bindError = (e as Error).message;
    }
    const bindAccepted = !bindError && Boolean(appId);

    // The write says nothing useful — a correctly bound field comes back with
    // `options: []`. Read the source back FROM THE SAVED APP (app_id, not
    // work_id: a work read would show the candidate even if the save failed).
    let readBack: any = null;
    if (bindAccepted && createdFieldUuid) {
      const got: any = await call('get_field', {
        app_id: appId,
        moduleUuid,
        formUuid,
        fieldUuid: createdFieldUuid,
      }).catch(() => null);
      readBack = got?.field?.optionsSource ?? null;
    }

    // Read the table's rows back too (ace#2143): `verifyLookupBind` requires
    // them, and reading them live exercises Nova's row shape in the tripwire.
    const rowsRead = appId
      ? await call('get_lookup_table_rows', { app_id: appId, tableId }).catch(() => null)
      : null;
    const check = verifyLookupBind({ requested, readBack, rows: rowsRead as any });

    return {
      canCreateTable,
      // Keyed on `bindLanded`, NOT `verified`: a duplicate-value or
      // unreadable-rows finding is a fact about the throwaway table, not an
      // upstream binding regression. `bindReadBackIssue` still carries it.
      canBindSelect: bindAccepted && check.bindLanded,
      bindAccepted,
      bindReadBackIssue: check.verified ? undefined : check.message,
      bindError,
      appId,
      tableId,
    };
  } finally {
    if (!opts.keep) {
      // Order matters, and it is not the obvious order. The table lives on the
      // PROJECT, so deleting the app leaves it — and its tag — behind. The
      // bound field is a reference, and `remove_lookup_table` refuses
      // `referenced` while any app holds one — INCLUDING a soft-deleted app for
      // its ~30-day restore window, and including an unbind that is only
      // STAGED (observed 2026-09-28: the refusal named the app until the
      // remove_field was SAVED). So: remove_field → save_work →
      // re-read the table revision → remove_lookup_table → delete_app.
      // Measured 2026-09-06: getting this wrong leaked three Project tables.
      const warn = (what: string, e: unknown) =>
        process.stderr.write(
          `probe-nova-fixtures: WARNING — ${what} (${String((e as Error)?.message ?? e).slice(0, 200)}). ` +
            'Clean it up by hand or the next run may report a false regression.\n',
        );
      if (appId && createdFieldUuid) {
        try {
          await work.stage('remove_field', { moduleUuid, formUuid, fieldUuid: createdFieldUuid });
          await work.save();
        } catch (e) {
          warn(`could not unbind field ${createdFieldUuid}`, e);
        }
      } else {
        await work.discard().catch(() => undefined);
      }
      if (createdTableId) {
        try {
          const listed: any = appId
            ? await call('get_lookup_tables', { app_id: appId })
            : await call('get_lookup_tables', { work_id: work.workId });
          const live = (listed?.tables ?? []).find((t: any) => t.id === createdTableId);
          await work.stage('remove_lookup_table', {
            tableId: createdTableId,
            expectedTableRevision: live?.tableRevision,
          });
        } catch (e) {
          warn(`could not remove table ${createdTableId}`, e);
        }
      }
      if (appId) await call('delete_app', { app_id: appId }).catch((e) => warn(`could not delete app ${appId}`, e));
    }
  }
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const keep = process.argv.includes('--keep');

  const apiKey = resolveNovaApiKey();
  if (!apiKey) {
    process.stderr.write(
      'probe-nova-fixtures: NOVA_API_KEY not found (process env or plugin-data .env). ' +
        'Run /ace:setup --force-env.\n',
    );
    process.exit(1);
  }

  let observed: Awaited<ReturnType<typeof probeNovaFixtures>>;
  try {
    observed = await probeNovaFixtures(apiKey, { keep });
  } catch (err) {
    process.stderr.write(`probe-nova-fixtures: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const verdict = classifyFixtureProbe(observed);
  const remedy = remedyFor(verdict);

  if (json) {
    process.stdout.write(`${JSON.stringify({ ...observed, verdict, remedy }, null, 2)}\n`);
  } else {
    process.stdout.write(`Nova ${NOVA_MCP_URL} — fixtures probe\n`);
    process.stdout.write(`  create_lookup_table (+rows) : ${observed.canCreateTable ? 'OK' : 'FAILED'}\n`);
    process.stdout.write(
      `  bind select to that table   : ${
        observed.canBindSelect ? 'OK (verified by get_field read-back)' : 'NOT PROVEN'
      }\n`,
    );
    if (observed.bindError) {
      process.stdout.write(`    ↳ refused: ${observed.bindError.replace(/\s+/g, ' ').slice(0, 200)}\n`);
    }
    // The dangerous middle state: the write was accepted and the field is not
    // actually bound. Say so loudly — this is the shape a silent defect takes.
    if (observed.bindAccepted && !observed.canBindSelect && observed.bindReadBackIssue) {
      process.stdout.write(
        `    ↳ write ACCEPTED but read-back did not confirm: ${observed.bindReadBackIssue}\n`,
      );
    }
    if (keep) process.stdout.write(`  kept app: ${observed.appId}  table: ${observed.tableId}\n`);
    process.stdout.write(`\n${verdict.toUpperCase()} — ${remedy}\n`);
  }

  process.exit(verdict === 'both' ? 0 : verdict === 'create-only' ? 2 : 3);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
