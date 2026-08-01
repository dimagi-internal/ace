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

export const NOVA_MCP_URL = process.env.NOVA_MCP_URL ?? 'https://mcp.commcare.app/mcp';

/** Canonical lowercase RFC-UUID pattern Nova regex-validates uuid params against. */
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
 * The contract ACE actually depends on. Every entry here is sent by a skill,
 * an agent procedure, or the eval rubrics. Verified live 2026-07-31 against
 * `POST https://mcp.commcare.app/mcp` `tools/list` (63 tools).
 *
 * Keep this list to what ACE SENDS. It is not a mirror of Nova's surface —
 * a tool ACE never calls does not belong here, because pinning it would make
 * CI red for an upstream change that costs ACE nothing.
 */
export const NOVA_CONTRACT: Record<string, ToolExpectation> = {
  get_app: {
    required: ['app_id'],
    why: 'The one-call whole-app resolver. Returns Connect type, per-form [Connect enabled], and EVERY module/form/field uuid — the index→uuid entry point for every skill.',
  },
  get_module: {
    required: ['moduleUuid', 'app_id'],
    uuidProps: ['moduleUuid'],
    why: 'app-connect-coverage and pdd-to-deliver-app read case-list config per module.',
  },
  get_form: {
    required: ['moduleUuid', 'formUuid', 'app_id'],
    uuidProps: ['moduleUuid', 'formUuid'],
    why: 'pdd-to-learn-app §4a/§4c, app-connect-coverage §3, and both -eval rubrics read forms. The assessment_discrimination blind-probe harness depends on this returning stems + options + qN_score atomically.',
  },
  get_field: {
    required: ['moduleUuid', 'formUuid', 'fieldUuid', 'app_id'],
    uuidProps: ['moduleUuid', 'formUuid', 'fieldUuid'],
    why: 'Targeted field read during marker repair. This is the exact call that broke mid-run in #1132.',
  },
  add_fields: {
    required: ['moduleUuid', 'formUuid', 'fields', 'app_id'],
    uuidProps: ['moduleUuid', 'formUuid'],
    why: 'pdd-to-learn-app §4c adds the conditional result_fail label.',
  },
  edit_field: {
    required: ['moduleUuid', 'formUuid', 'fieldUuid', 'updates', 'app_id'],
    uuidProps: ['moduleUuid', 'formUuid', 'fieldUuid'],
    why: 'pdd-to-learn-app §4c adds a `relevant` condition to an existing pass label.',
  },
  update_form: {
    required: ['moduleUuid', 'formUuid', 'app_id'],
    mustHaveProps: ['connect'],
    uuidProps: ['moduleUuid', 'formUuid'],
    why: 'The per-form ADDITIVE Connect refinement path. Only valid on an already-participating form; enable / mode-switch / participant-set changes must go through configure_connect.',
  },
  update_module: {
    required: ['moduleUuid', 'app_id'],
    uuidProps: ['moduleUuid'],
    why: 'Module rename / case-type / display-condition edits.',
  },
  update_app: {
    required: ['name', 'app_id'],
    forbiddenProps: ['connect_type'],
    why: 'App display name ONLY. `connect_type` was removed 2026-07-31 (#1133) — configure_connect replaced it. If connect_type reappears here, the §4b/§4e heal text needs revisiting.',
  },
  configure_connect: {
    required: ['mode', 'app_id'],
    mustHaveProps: ['participants'],
    why: 'The atomic app-level Connect setter that replaced update_app({connect_type}). REPLACE-ALL: every form absent from participants[] has its Connect block CLEARED.',
  },
  search_blueprint: {
    required: ['query', 'app_id'],
    why: 'Targeted semantic-name → uuid resolver; the fallback wherever a skill held a field id rather than a uuid.',
  },
  list_apps: {
    required: [],
    why: 'Step 0 preflight + operator debugging.',
  },
  get_hq_connection: {
    required: [],
    why: 'commcare-setup Step 0b probes the HQ binding with this.',
  },
  upload_app_to_hq: {
    required: ['app_id'],
    mustHaveProps: ['domain'],
    why: 'app-deploy passes ACE_HQ_DOMAIN explicitly so a multi-space HQ key cannot upload to an unintended space.',
  },
  compile_app: {
    required: ['app_id', 'format'],
    why: 'CCZ / HQ-JSON export used by app-release-qa.',
  },
  create_module: {
    required: ['name', 'app_id'],
    mustHaveProps: ['moduleUuid'],
    why: 'Accepts a CALLER-SUPPLIED moduleUuid — this is how a build can mint and persist uuids instead of re-deriving them later.',
  },
  create_form: {
    required: ['moduleUuid', 'name', 'type', 'fields', 'app_id'],
    mustHaveProps: ['formUuid'],
    uuidProps: ['moduleUuid'],
    why: 'Accepts a CALLER-SUPPLIED formUuid, same reason as create_module.',
  },
};

export type ViolationKind =
  | 'tool_missing'
  | 'required_drift'
  | 'prop_missing'
  | 'prop_forbidden'
  | 'uuid_pattern_drift'
  | 'index_addressing_returned';

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
      'NOVA_API_KEY not found (process env or plugin-data .env). Run /ace:setup --force-env.'
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
