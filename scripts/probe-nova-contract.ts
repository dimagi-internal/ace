/**
 * Probe: pin Nova's live MCP contract to what ACE actually sends.
 *
 * Why this exists (jjackson/ace#1132, #1133). On 2026-07-31 ~15:45Z Nova's
 * remote MCP server was redeployed mid-run and migrated its ENTIRE surface
 * from index-based addressing (`moduleIndex` / `formIndex` / `fieldId`) to
 * uuid-based addressing (`moduleUuid` / `formUuid` / `fieldUuid`), and
 * dropped `connect_type` from `update_app`. ACE had NO probe pinning Nova's
 * contract, so the change surfaced as an `MCP error -32602` two Nova builds
 * deep into Phase 3 of `spark-facilitator/20260731-0656` — after ~25 minutes
 * of wall-clock and two architect dispatches.
 *
 * This is the "close the loop to the source of truth" rule applied to Nova:
 * the upstream `tools/list` response IS the contract, so assert against it
 * rather than against a paraphrase in a skill.
 *
 * Two layers, deliberately split:
 *
 *   - `checkNovaContract()` is PURE. It takes an already-fetched tool list
 *     and returns typed violations. Unit-tested offline against a captured
 *     fixture of the live contract, so `npm test` stays green with no
 *     network (see test/scripts/nova-contract.test.ts).
 *   - `fetchNovaToolList()` hits the live server. Gated behind an env flag
 *     everywhere it is used.
 *
 * Second migration (2026-09-27, voidcraft-labs/commcare-nova#693): every
 * mutation moved into private work (`work_id` + `request_id`, then
 * `save_work`) and `create_app` was removed. This probe is what reported it
 * first — 19 violations on the first run after the deploy.
 *
 * Run:
 *   npx tsx scripts/probe-nova-contract.ts
 *
 * Requires `NOVA_API_KEY` (the `sk-nova-v1-…` bearer) in the process env or
 * in the installed plugin-data `.env`. Exit code 0 = contract holds, 1 =
 * drift (every violation printed with the tool and parameter that moved).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadPluginEnv } from '../lib/load-plugin-env.js';

// ace#1964 — a script reached from a Bash tool call inherits NONE of ACE's
// secrets, so it has to load `<plugin-data>/.env` itself. Module top, before
// any credential read: ESM runs this body top-down, so "before main()" is
// already too late for a read at module level.
// `NOVA_MCP_URL` below is read at module level, which is why the call sits
// here and not inside `main()`.
const PLUGIN_ENV = loadPluginEnv(import.meta.url);

export const NOVA_MCP_URL = process.env.NOVA_MCP_URL ?? 'https://mcp.commcare.app/mcp';

/**
 * Canonical lowercase RFC-UUID pattern Nova regex-validated uuid params against
 * from 2026-07-31 until 2026-09-27. #693 dropped it: an address now accepts a
 * stable id OR an unambiguous name, so no entry pins it any more. The
 * `uuidProps` mechanism stays for the next time a format IS the contract.
 */
export const UUID_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

/**
 * Addressing params that were REMOVED in the 2026-07-31 migration. If any of
 * these ever reappears on any tool, the addressing model moved again and every
 * ACE skill that names uuids is suspect. This is the single highest-value
 * assertion in the file — it is what would have caught #1132 at second 0.
 */
export const FORBIDDEN_ADDRESSING_PARAMS = [
  'moduleIndex',
  'formIndex',
  'fieldIndex',
  'columnIndex',
  'fieldId',
];

export interface NovaTool {
  name: string;
  /** Present on a raw `tools/list` payload; the captured fixture is pre-flattened. */
  inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
  required?: string[];
  properties?: Record<string, unknown>;
}

export interface ToolExpectation {
  /** Exact `required` set ACE relies on (order-insensitive). */
  required: string[];
  /** Params that must exist as properties, required or not. */
  mustHaveProps?: string[];
  /** Params that must NOT exist at all. */
  forbiddenProps?: string[];
  /** Params that must carry the canonical uuid regex. */
  uuidProps?: string[];
  /** Why ACE depends on this shape — printed with any violation. */
  why: string;
}

/**
 * Tools that no longer exist and must not come back unnoticed. `create_app`
 * was removed on 2026-09-27 (voidcraft-labs/commcare-nova#693): a new app is
 * now `begin_work({new_app})` and only exists after its first `save_work`.
 * If it reappears, the authoring model moved again.
 */
export const RETIRED_TOOLS = ['create_app'];

/** The two envelope params every staged Nova mutation takes since #693. */
const WORK = ['work_id', 'request_id'];

/**
 * The contract ACE actually depends on. Every entry here is sent by a skill,
 * an agent procedure, a script, or the eval rubrics. Verified live 2026-09-28
 * against `POST https://mcp.commcare.app/mcp` `tools/list` (127 tools) —
 * captured in `test/fixtures/nova/tools-list-2026-09-28.json`.
 *
 * Since voidcraft-labs/commcare-nova#693 (2026-09-27) every app MUTATION is
 * staged in private work: it requires `work_id` + `request_id`, takes no
 * `app_id`, and changes nothing until `save_work`. Reads take EXACTLY ONE of
 * `app_id` (saved state) or `work_id` (the candidate), which Nova expresses as
 * a union — so their `required` no longer lists either. The 2026-07-31 uuid
 * regex on address params is gone too: an address now accepts a stable id OR
 * an unambiguous name. See `playbook/integrations/nova-integration.md § The
 * private-work authoring contract`.
 *
 * Keep this list to what ACE SENDS. It is not a mirror of Nova's surface —
 * a tool ACE never calls does not belong here, because pinning it would make
 * CI red for an upstream change that costs ACE nothing.
 */
export const NOVA_CONTRACT: Record<string, ToolExpectation> = {
  // ---- the private-work lifecycle (new 2026-09-27) ----
  begin_work: {
    required: ['request_id'],
    mustHaveProps: ['app_id', 'new_app'],
    why: 'Every ACE edit of a Nova app opens private work first (lib/nova-work.ts). `new_app` replaces create_app.',
  },
  get_work: {
    required: ['work_id'],
    why: 'Reads the candidate revision that save_work/discard_work must echo, plus `stale` and `pending_changes`.',
  },
  save_work: {
    required: ['work_id', 'request_id', 'expected_revision'],
    why: 'The ONLY call that changes a saved app. A stale or refused save answers saved:false WITHOUT isError, so lib/nova-work.ts checks `saved === true`.',
  },
  discard_work: {
    required: ['work_id', 'request_id', 'expected_revision'],
    why: 'Abandons a stale or refused candidate so a retry restarts from current saved state.',
  },
  list_work: {
    required: [],
    mustHaveProps: ['app_id'],
    why: 'Finds retained work on an app before opening a second concurrent candidate.',
  },

  // ---- reads (exactly one of app_id | work_id) ----
  get_app: {
    required: ['app_id'],
    why: 'The one-call whole-app resolver for SAVED state. Returns Connect type, per-form [Connect enabled], and every module/form/field id.',
  },
  get_module: {
    required: ['moduleUuid'],
    mustHaveProps: ['app_id', 'work_id'],
    why: 'app-connect-coverage and pdd-to-deliver-app read case-list config per module.',
  },
  get_form: {
    required: ['formUuid'],
    mustHaveProps: ['app_id', 'work_id', 'moduleUuid'],
    why: 'pdd-to-learn-app §4a/§4c, app-connect-coverage §3, and both -eval rubrics read forms.',
  },
  get_field: {
    required: ['fieldUuid'],
    mustHaveProps: ['app_id', 'work_id', 'formUuid', 'moduleUuid'],
    why: 'Read-back that settles whether a write landed (verifyLookupBind, marker repair). Read with app_id AFTER save_work — a work_id read shows the unsaved candidate.',
  },
  search_blueprint: {
    required: ['query'],
    mustHaveProps: ['app_id', 'work_id'],
    why: 'Targeted semantic-name → id resolver; the fallback wherever a skill held a field id rather than a uuid.',
  },
  get_lookup_tables: {
    required: [],
    mustHaveProps: ['app_id', 'work_id'],
    why: 'pdd-to-deliver-app Step 4f and the fixtures probe read table + column ids and tableRevision.',
  },
  list_apps: {
    required: [],
    why: 'Step 0 preflight + operator debugging.',
  },
  get_hq_connection: {
    required: [],
    why: 'commcare-setup Step 0b probes the HQ binding with this.',
  },

  // ---- staged mutations (work_id + request_id, never app_id) ----
  create_module: {
    required: ['name', ...WORK],
    mustHaveProps: ['moduleUuid', 'case_type'],
    forbiddenProps: ['app_id', 'forms'],
    why: 'Focused creation: one module per call, no nested forms. Returns the minted moduleUuid.',
  },
  create_form: {
    required: ['moduleUuid', 'name', 'type', ...WORK],
    mustHaveProps: ['formUuid'],
    forbiddenProps: ['app_id', 'fields'],
    why: 'Focused creation: an EMPTY form; questions go in through add_fields.',
  },
  add_fields: {
    required: ['formUuid', 'fields', ...WORK],
    forbiddenProps: ['app_id'],
    why: 'pdd-to-learn-app §4c adds the conditional result_fail label; Step 4f adds lookup-bound selects.',
  },
  edit_field: {
    required: ['fieldUuid', 'updates', ...WORK],
    forbiddenProps: ['app_id'],
    why: 'pdd-to-learn-app §4c adds a `relevant` condition; Step 4f converts text → select.',
  },
  remove_field: {
    required: ['fieldUuid', ...WORK],
    why: 'Fixtures probe teardown drops the bind before remove_lookup_table.',
  },
  update_form: {
    required: ['formUuid', ...WORK],
    mustHaveProps: ['connect'],
    forbiddenProps: ['app_id'],
    why: 'The per-form ADDITIVE Connect refinement path. Only valid on an already-participating form; enable / mode-switch / participant-set changes must go through configure_connect.',
  },
  update_module: {
    required: ['moduleUuid', ...WORK],
    forbiddenProps: ['app_id'],
    why: 'Module rename / case-type / display-condition edits.',
  },
  update_app: {
    required: ['name', ...WORK],
    forbiddenProps: ['connect_type', 'app_id'],
    why: 'App display name ONLY. `connect_type` was removed 2026-07-31 (#1133) — configure_connect replaced it.',
  },
  configure_connect: {
    required: ['mode', ...WORK],
    mustHaveProps: ['participants'],
    forbiddenProps: ['app_id'],
    why: 'The atomic app-level Connect setter. REPLACE-ALL: every form absent from participants[] has its Connect block CLEARED.',
  },
  set_field_options_source: {
    required: ['fieldUuid', 'source', ...WORK],
    why: 'pdd-to-deliver-app Step 4f binds an existing select to a partner register.',
  },
  attach_field_media: {
    required: ['attachments', ...WORK],
    why: 'app-media-coverage attaches label/hint images.',
  },
  attach_option_media: {
    required: ['attachments', ...WORK],
    why: 'app-media-coverage attaches picture-choice option images.',
  },
  set_menu_media: {
    required: ['items', ...WORK],
    why: 'app-media-coverage sets module + form menu icons.',
  },
  set_app_logo: {
    required: ['logo', ...WORK],
    why: 'app-media-coverage sets the app logo.',
  },
  update_translations: {
    required: ['language', 'updates', ...WORK],
    why: 'The per-language channel — translate LAST, then save_work.',
  },

  // ---- Project data: takes work_id for authority, but COMMITS IMMEDIATELY ----
  create_lookup_table: {
    required: ['name', 'tag', 'columns', ...WORK],
    why: 'Step 4f builds a partner register (bind adopted after voidcraft-labs/commcare-nova#545). Written to the PROJECT at call time — not staged, not undone by discard_work.',
  },
  remove_lookup_table: {
    required: ['tableId', 'expectedTableRevision', ...WORK],
    why: 'Fixtures probe teardown. Refuses `referenced` (as data, not isError) until the unbind is SAVED.',
  },

  // ---- saved-app consumers (app_id; never see pending work) ----
  upload_app_to_hq: {
    required: ['app_id'],
    mustHaveProps: ['domain'],
    why: 'app-deploy passes ACE_HQ_DOMAIN explicitly. Uploads the SAVED app only — unsaved work is silently excluded.',
  },
  compile_app: {
    required: ['app_id', 'format'],
    why: 'CCZ / HQ-JSON export used by app-release-qa.',
  },
  delete_app: {
    required: ['app_id'],
    why: 'Probe teardown. Soft delete; the app still pins lookup tables for the ~30-day restore window.',
  },
};

export type ViolationKind =
  | 'tool_missing'
  | 'required_drift'
  | 'prop_missing'
  | 'prop_forbidden'
  | 'uuid_pattern_drift'
  | 'index_addressing_returned'
  | 'retired_tool_returned';

export interface Violation {
  kind: ViolationKind;
  tool: string;
  detail: string;
  why?: string;
}

function shapeOf(t: NovaTool): { required: string[]; properties: Record<string, unknown> } {
  const s = t.inputSchema ?? t;
  return {
    required: (s.required as string[] | undefined) ?? [],
    properties: (s.properties as Record<string, unknown> | undefined) ?? {},
  };
}

/**
 * Pure contract check. Returns [] when the live surface still accepts exactly
 * what ACE sends.
 */
export function checkNovaContract(tools: NovaTool[]): Violation[] {
  const violations: Violation[] = [];
  const byName = new Map(tools.map((t) => [t.name, t]));

  // 1. Global invariant: the addressing model is uuid-based. No tool ANYWHERE
  //    may take an index/semantic-id addressing param. This is the assertion
  //    that generalizes — it fires on a migration in either direction.
  for (const t of tools) {
    const { properties } = shapeOf(t);
    for (const p of Object.keys(properties)) {
      if (FORBIDDEN_ADDRESSING_PARAMS.includes(p)) {
        violations.push({
          kind: 'index_addressing_returned',
          tool: t.name,
          detail: `accepts addressing param \`${p}\` — Nova's addressing model changed. Every ACE skill that passes uuids must be re-checked.`,
        });
      }
    }
  }

  // 1b. Retired tools. A tool ACE's docs teach as GONE must stay gone, or the
  //     authoring model moved again (create_app, voidcraft-labs/commcare-nova#693).
  for (const r of RETIRED_TOOLS) {
    if (byName.has(r)) {
      violations.push({
        kind: 'retired_tool_returned',
        tool: r,
        detail: 'is back in tools/list — the private-work authoring model may have changed; re-read commcare-nova before trusting lib/nova-work.ts',
      });
    }
  }

  // 2. Per-tool expectations for the calls ACE actually makes.
  for (const [name, exp] of Object.entries(NOVA_CONTRACT)) {
    const tool = byName.get(name);
    if (!tool) {
      violations.push({
        kind: 'tool_missing',
        tool: name,
        detail: 'not present in tools/list',
        why: exp.why,
      });
      continue;
    }
    const { required, properties } = shapeOf(tool);

    const gotReq = [...required].sort();
    const wantReq = [...exp.required].sort();
    if (gotReq.join(',') !== wantReq.join(',')) {
      violations.push({
        kind: 'required_drift',
        tool: name,
        detail: `required is [${gotReq.join(', ')}], ACE sends for [${wantReq.join(', ')}]`,
        why: exp.why,
      });
    }

    for (const p of exp.mustHaveProps ?? []) {
      if (!(p in properties)) {
        violations.push({
          kind: 'prop_missing',
          tool: name,
          detail: `property \`${p}\` is gone`,
          why: exp.why,
        });
      }
    }

    for (const p of exp.forbiddenProps ?? []) {
      if (p in properties) {
        violations.push({
          kind: 'prop_forbidden',
          tool: name,
          detail: `property \`${p}\` is back`,
          why: exp.why,
        });
      }
    }

    for (const p of exp.uuidProps ?? []) {
      const prop = properties[p] as { pattern?: string } | undefined;
      if (!prop) {
        violations.push({
          kind: 'prop_missing',
          tool: name,
          detail: `uuid property \`${p}\` is gone`,
          why: exp.why,
        });
      } else if (prop.pattern !== UUID_PATTERN) {
        violations.push({
          kind: 'uuid_pattern_drift',
          tool: name,
          detail: `\`${p}\` pattern is ${prop.pattern ?? '(none)'}, expected the canonical lowercase RFC-UUID regex`,
          why: exp.why,
        });
      }
    }
  }

  return violations;
}

/** Read NOVA_API_KEY from the process env, falling back to the installed plugin-data `.env`. */
export function resolveNovaApiKey(): string | null {
  if (process.env.NOVA_API_KEY) return process.env.NOVA_API_KEY;
  const candidates = [
    process.env.CLAUDE_PLUGIN_DATA ? path.join(process.env.CLAUDE_PLUGIN_DATA, '.env') : null,
    path.join(os.homedir(), '.claude', 'plugins', 'data', 'ace-ace', '.env'),
  ].filter((p): p is string => !!p);
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, 'utf8').match(/^NOVA_API_KEY=(.*)$/m);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/**
 * Fetch the live `tools/list`. Nova speaks the streamable-HTTP MCP transport
 * and answers with an SSE frame, so the JSON lives on a `data: ` line.
 */
export async function fetchNovaToolList(apiKey: string): Promise<NovaTool[]> {
  const res = await fetch(NOVA_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  if (!res.ok) throw new Error(`Nova tools/list → HTTP ${res.status} ${res.statusText}`);
  const body = await res.text();
  const line = body.split('\n').find((l) => l.startsWith('data: '));
  const payload = JSON.parse(line ? line.slice(6) : body);
  if (payload.error) throw new Error(`Nova tools/list error: ${JSON.stringify(payload.error)}`);
  const tools = payload?.result?.tools;
  if (!Array.isArray(tools)) throw new Error('Nova tools/list returned no tools array');
  return tools as NovaTool[];
}

async function main(): Promise<void> {
  const key = resolveNovaApiKey();
  if (!key) {
    console.error(
      `NOVA_API_KEY not found (process env or ${PLUGIN_ENV.path}). ` +
        'Run /ace:setup --force-env.'
    );
    process.exit(2);
  }
  const tools = await fetchNovaToolList(key);
  const violations = checkNovaContract(tools);
  console.log(`Nova ${NOVA_MCP_URL} — ${tools.length} tools, ${Object.keys(NOVA_CONTRACT).length} pinned by ACE`);

  if (violations.length === 0) {
    console.log('OK — Nova still accepts exactly what ACE sends.');
    return;
  }
  console.error(`\nDRIFT — ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  [${v.kind}] ${v.tool}: ${v.detail}`);
    if (v.why) console.error(`      ACE depends on this because: ${v.why}`);
  }
  console.error(
    '\nFix the SKILLS, not this file, unless ACE genuinely intends to send the new shape.'
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  });
}
