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
 * the table half works and the BINDING half is inert — `set_field_options_source`
 * and `add_fields optionsSource` both refuse a `kind: 'lookup'` source with
 * "its Project lookup definitions are unavailable", on a fresh app and a
 * fresh table, every time (`voidcraft-labs/commcare-nova#545`). So the halt
 * STAYS and only its stated reason changes. That distinction is the whole point of this file: it is the
 * tripwire that says when the halt may finally be retired.
 *
 * Run it when: a Nova release lands, `probe-nova-contract.ts` reports a new
 * tool count, or anyone proposes automating the partner-register handoff.
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
 *   0  BOTH halves work — the binding landed upstream. Retire the Step 4f
 *      operator handoff and delete `renderRegisterCsv` (see § Adopting below).
 *   2  create-only — current known state. Halt stays; reason is the binding.
 *   3  neither — the create atom regressed. Treat as an upstream regression
 *      (`skills/upstream-regression-triage`).
 *   1  usage / transport / auth error. Says nothing about the capability.
 */
import { NOVA_MCP_URL, resolveNovaApiKey } from './probe-nova-contract.js';

/** What the probe observed. Pure data, so the classifier is unit-testable. */
export interface FixtureProbeResult {
  /** `create_lookup_table` returned a tableId with its rows. */
  readonly canCreateTable: boolean;
  /** A select accepted a `kind: 'lookup'` options source. */
  readonly canBindSelect: boolean;
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
        'ADOPT: the binding works. pdd-to-deliver-app § Step 4f may now create, ' +
        'populate AND bind the partner register autonomously — retire the operator ' +
        'handoff and renderRegisterCsv, and drop the halt to the undeclared-register case.'
      );
    case 'create-only':
      return (
        'HALT STAYS (reason: the binding, not the create atom). ACE may create and ' +
        'populate the table itself; a human still binds the field. Do NOT ship inline ' +
        'placeholders for a declared register.'
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
    return { canCreateTable, canBindSelect: !bindError, bindError, appId, tableId };
  } finally {
    if (!opts.keep) {
      // Order matters, and so does doing this at all: the table lives on the
      // PROJECT, so deleting the app leaves it — and its tag — behind forever.
      if (createdTableId) {
        const removed = await callNovaTool(apiKey, 'remove_lookup_table', {
          app_id: appId,
          tableId: createdTableId,
          expectedTableRevision: createdTableRevision ?? '1',
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
    process.stdout.write(`  bind select to that table   : ${observed.canBindSelect ? 'OK' : 'REFUSED'}\n`);
    if (observed.bindError) {
      process.stdout.write(`    ↳ ${observed.bindError.replace(/\s+/g, ' ').slice(0, 200)}\n`);
    }
    if (keep) process.stdout.write(`  kept app: ${observed.appId}  table: ${observed.tableId}\n`);
    process.stdout.write(`\n${verdict.toUpperCase()} — ${remedy}\n`);
  }

  process.exit(verdict === 'both' ? 0 : verdict === 'create-only' ? 2 : 3);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
