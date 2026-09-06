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

let rpcId = 0;

/** One `tools/call` against Nova's streamable-HTTP MCP endpoint. */
async function callNovaTool(apiKey: string, name: string, args: unknown): Promise<any> {
  const res = await fetch(NOVA_MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) throw new Error(`${name} → HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  // The transport may frame the reply as SSE; take the first data line if so.
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  const payload = JSON.parse(dataLine ? dataLine.slice(6) : text);
  if (payload.error) throw new Error(`${name}: ${JSON.stringify(payload.error)}`);
  const block = payload.result?.content?.[0];
  if (block?.type === 'text') {
    try {
      return JSON.parse(block.text);
    } catch {
      return block.text;
    }
  }
  return payload.result;
}

/**
 * Live end-to-end probe. Creates a throwaway app, a table with rows, and
 * attempts to bind a select to it. Deletes the app unless `keep`.
 */
export async function probeNovaFixtures(
  apiKey: string,
  opts: { keep?: boolean } = {},
): Promise<FixtureProbeResult & { appId?: string; tableId?: string }> {
  const app = await callNovaTool(apiKey, 'create_app', {
    app_name: `ACE fixtures probe ${new Date().toISOString()}`,
  });
  const appId: string = app.app_id;
  const { module_uuid: moduleUuid, form_uuid: formUuid } = app.starter;
  let createdTableId: string | undefined;
  let createdTableRevision: string | undefined;
  let createdFieldUuid: string | undefined;

  try {
    // Tags are unique per PROJECT and the table OUTLIVES the app, so a fixed
    // tag makes the second run fail with `tag_taken` — which reads exactly
    // like a regression. Unique per run, and removed in the finally below.
    const table = await callNovaTool(apiKey, 'create_lookup_table', {
      app_id: appId,
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

    const tableId: string | undefined = table?.tableId;
    createdTableId = tableId;
    // Read the revision back; do not assume '1'. A guessed revision makes the
    // cleanup below fail silently and leak a Project-scoped tag forever.
    createdTableRevision = table?.revisions?.tableRevision;
    const canCreateTable = Boolean(tableId) && Array.isArray(table?.rows) && table.rows.length === 2;
    if (!canCreateTable) {
      return {
        canCreateTable: false,
        canBindSelect: false,
        bindError: table?.error ? `create failed: ${table.error}` : undefined,
        appId,
        tableId,
      };
    }

    const [valueColumnId, labelColumnId] = table.columns.map((c: any) => c.columnId);
    // `canCreateTable` above required a truthy tableId and returned early
    // otherwise; TS cannot narrow across that return, so re-bind here.
    const requested = {
      tableId: tableId as string,
      valueColumnId: valueColumnId as string,
      labelColumnId: labelColumnId as string,
    };
    const bound = await callNovaTool(apiKey, 'add_fields', {
      app_id: appId,
      moduleUuid,
      formUuid,
      fields: [
        {
          kind: 'single_select',
          id: 'probe_pick',
          parentUuid: null,
          label: { parts: [{ kind: 'text', text: 'Pick' }] },
          optionsSource: { kind: 'lookup', tableId, valueColumnId, labelColumnId },
        },
      ],
    });

    const bindError: string | undefined = bound?.error;
    const bindAccepted = !bindError;
    createdFieldUuid = bound?.fields?.[0]?.uuid;

    // The write says nothing useful — a correctly bound field comes back with
    // `options: []`. Read the source back or claim nothing.
    let readBack: any = null;
    if (bindAccepted && createdFieldUuid) {
      const got = await callNovaTool(apiKey, 'get_field', {
        app_id: appId,
        moduleUuid,
        formUuid,
        fieldUuid: createdFieldUuid,
      }).catch(() => null);
      readBack = got?.field?.optionsSource ?? null;
    }
    const check = verifyLookupBind({ requested, readBack });

    return {
      canCreateTable,
      canBindSelect: bindAccepted && check.verified,
      bindAccepted,
      bindReadBackIssue: check.verified ? undefined : check.message,
      bindError,
      appId,
      tableId,
    };
  } finally {
    if (!opts.keep) {
      // Order matters, and it is not the obvious order. The table lives on the
      // PROJECT, so deleting the app leaves it — and its tag — behind forever.
      // But now that binding WORKS, the bound field is itself a reference, and
      // `remove_lookup_table` refuses while any app holds one. Worse, a
      // soft-deleted app still counts: `delete_app` returns
      // `recoverable_until` ~30 days out, and removing the table afterwards
      // fails `referenced` with `blockingApps:[{deleted:true}]` — from ANY
      // app_id, while scoping the call to the deleted app's own id fails
      // `not_found`. So there is no ordering of (delete app, remove table)
      // that works once a field is bound; the reference must be dropped first.
      // Measured 2026-09-06: this leaked three Project-scoped tables before it
      // was understood, and they are stuck until the soft-deleted apps expire.
      if (createdFieldUuid) {
        await callNovaTool(apiKey, 'remove_field', {
          app_id: appId,
          moduleUuid,
          formUuid,
          fieldUuid: createdFieldUuid,
        }).catch(() => undefined);
      }
      if (createdTableId) {
        // Removing the field bumps the table revision, so the one returned by
        // `create_lookup_table` is stale by now and `expectedTableRevision`
        // would be rejected. Re-read it rather than assuming.
        const listed = await callNovaTool(apiKey, 'get_lookup_tables', { app_id: appId }).catch(
          () => null,
        );
        const live = (listed?.tables ?? []).find((t: any) => t.id === createdTableId);
        const removed = await callNovaTool(apiKey, 'remove_lookup_table', {
          app_id: appId,
          tableId: createdTableId,
          expectedTableRevision: live?.tableRevision ?? createdTableRevision ?? '1',
        }).catch((e: Error) => ({ error: e.message }));
        // Never swallow this. A silent leak means the NEXT run fails with
        // `tag_taken`, which reads exactly like an upstream regression.
        if (removed?.error) {
          process.stderr.write(
            `probe-nova-fixtures: WARNING — could not remove table ${createdTableId} ` +
              `(${String(removed.error).slice(0, 160)}). Remove it by hand or the tag stays taken.\n`,
          );
        }
      }
      await callNovaTool(apiKey, 'delete_app', { app_id: appId }).catch(() => undefined);
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
