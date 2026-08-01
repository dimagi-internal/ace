/**
 * Contract tests for `scripts/probe-nova-contract.ts` — the durable probe that
 * pins Nova's MCP surface to what ACE actually sends.
 *
 * Two tiers, on purpose:
 *
 *  1. OFFLINE (always runs, no network). Exercises the pure `checkNovaContract`
 *     against `test/fixtures/nova/tools-list-2026-07-31.json` — a capture of the
 *     real post-migration `tools/list` (63 tools, top-level parameter shape only,
 *     descriptions stripped). Also replays the PRE-migration index-addressed
 *     shape to prove the checker actually fires; a green checker that cannot go
 *     red is the failure mode this whole file exists to prevent.
 *
 *  2. LIVE (gated on NOVA_INTEGRATION=1). Hits mcp.commcare.app and asserts zero
 *     violations, so the NEXT upstream addressing change fails in CI rather than
 *     two Nova builds deep into a Phase 3 run (jjackson/ace#1132, #1133).
 *
 * Run the live tier:
 *   NOVA_INTEGRATION=1 npx vitest run test/scripts/nova-contract.test.ts
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkNovaContract,
  fetchNovaToolList,
  resolveNovaApiKey,
  NOVA_CONTRACT,
  UUID_PATTERN,
  FORBIDDEN_ADDRESSING_PARAMS,
  type NovaTool,
} from '../../scripts/probe-nova-contract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'nova', 'tools-list-2026-07-31.json');
const LIVE = process.env.NOVA_INTEGRATION === '1';

function liveShape(): NovaTool[] {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as NovaTool[];
}

/** The pre-2026-07-31 index-addressed shape, as it actually was. */
function preMigrationShape(): NovaTool[] {
  return [
    ...liveShape().filter((t) => !['get_field', 'get_form', 'get_module', 'update_app'].includes(t.name)),
    {
      name: 'get_module',
      required: ['app_id', 'moduleIndex'],
      properties: { app_id: { type: 'string' }, moduleIndex: { type: 'number' } },
    },
    {
      name: 'get_form',
      required: ['app_id', 'moduleIndex', 'formIndex'],
      properties: {
        app_id: { type: 'string' },
        moduleIndex: { type: 'number' },
        formIndex: { type: 'number' },
      },
    },
    {
      name: 'get_field',
      required: ['app_id', 'moduleIndex', 'formIndex', 'fieldId'],
      properties: {
        app_id: { type: 'string' },
        moduleIndex: { type: 'number' },
        formIndex: { type: 'number' },
        fieldId: { type: 'string' },
      },
    },
    {
      name: 'update_app',
      required: ['app_id'],
      properties: { app_id: { type: 'string' }, name: { type: 'string' }, connect_type: { type: 'string' } },
    },
  ];
}

describe('nova contract fixture (offline)', () => {
  it('captures the whole live surface', () => {
    const tools = liveShape();
    expect(tools).toHaveLength(63);
    expect(new Set(tools.map((t) => t.name)).size).toBe(63);
  });

  it('accepts the captured live shape with zero violations', () => {
    expect(checkNovaContract(liveShape())).toEqual([]);
  });

  it('pins every tool ACE sends', () => {
    const names = new Set(liveShape().map((t) => t.name));
    for (const pinned of Object.keys(NOVA_CONTRACT)) {
      expect(names, `${pinned} is pinned but absent from the fixture`).toContain(pinned);
    }
  });

  it('no tool on the live surface accepts an index-addressing param', () => {
    for (const t of liveShape()) {
      for (const p of Object.keys(t.properties ?? {})) {
        expect(FORBIDDEN_ADDRESSING_PARAMS, `${t.name}.${p}`).not.toContain(p);
      }
    }
  });

  it('update_app carries name + app_id only — connect_type is gone (ace#1133)', () => {
    const t = liveShape().find((x) => x.name === 'update_app')!;
    expect(Object.keys(t.properties ?? {}).sort()).toEqual(['app_id', 'name']);
  });

  it('configure_connect is the replacement and takes a participant set (ace#1133)', () => {
    const t = liveShape().find((x) => x.name === 'configure_connect')!;
    expect(t.required).toEqual(expect.arrayContaining(['mode', 'app_id']));
    expect(Object.keys(t.properties ?? {})).toContain('participants');
  });

  it('search_blueprint is the targeted index→uuid resolver (ace#1132)', () => {
    const t = liveShape().find((x) => x.name === 'search_blueprint')!;
    expect([...(t.required ?? [])].sort()).toEqual(['app_id', 'query']);
  });

  it('create_module / create_form accept caller-minted uuids', () => {
    for (const [name, prop] of [
      ['create_module', 'moduleUuid'],
      ['create_form', 'formUuid'],
    ] as const) {
      const t = liveShape().find((x) => x.name === name)!;
      expect(Object.keys(t.properties ?? {}), name).toContain(prop);
    }
  });

  it('uuid params carry the canonical lowercase RFC-UUID regex', () => {
    const t = liveShape().find((x) => x.name === 'get_field')!;
    for (const p of ['moduleUuid', 'formUuid', 'fieldUuid']) {
      expect((t.properties as Record<string, { pattern?: string }>)[p].pattern).toBe(UUID_PATTERN);
    }
  });
});

describe('checkNovaContract detects the drift it was written for', () => {
  it('flags the pre-migration index-addressed surface', () => {
    const v = checkNovaContract(preMigrationShape());
    expect(v.length).toBeGreaterThan(0);

    // The generalizing assertion: index addressing anywhere is a violation.
    const idx = v.filter((x) => x.kind === 'index_addressing_returned');
    expect(idx.map((x) => x.tool).sort()).toEqual(['get_field', 'get_field', 'get_field', 'get_form', 'get_form', 'get_module']);

    // And the exact call that broke mid-run in #1132.
    expect(v.some((x) => x.tool === 'get_field' && x.kind === 'required_drift')).toBe(true);
    // And the removed-then-restored parameter from #1133.
    expect(v.some((x) => x.tool === 'update_app' && x.kind === 'prop_forbidden')).toBe(true);
  });

  it('flags a removed tool', () => {
    const v = checkNovaContract(liveShape().filter((t) => t.name !== 'configure_connect'));
    expect(v).toContainEqual(
      expect.objectContaining({ kind: 'tool_missing', tool: 'configure_connect' })
    );
  });

  it('flags a dropped property ACE depends on', () => {
    const tools = liveShape();
    const uf = tools.find((t) => t.name === 'update_form')!;
    delete (uf.properties as Record<string, unknown>).connect;
    expect(checkNovaContract(tools)).toContainEqual(
      expect.objectContaining({ kind: 'prop_missing', tool: 'update_form' })
    );
  });

  it('flags a uuid format change', () => {
    const tools = liveShape();
    const gf = tools.find((t) => t.name === 'get_form')!;
    (gf.properties as Record<string, { pattern?: string }>).formUuid.pattern = '^[A-Z0-9]+$';
    expect(checkNovaContract(tools)).toContainEqual(
      expect.objectContaining({ kind: 'uuid_pattern_drift', tool: 'get_form' })
    );
  });

  it('every violation names why ACE depends on the shape', () => {
    for (const v of checkNovaContract(preMigrationShape())) {
      if (v.kind === 'index_addressing_returned') continue; // global rule, no per-tool why
      expect(v.why, `${v.tool}/${v.kind}`).toBeTruthy();
    }
  });
});

describe.skipIf(!LIVE)('nova live contract (NOVA_INTEGRATION=1)', () => {
  it('still accepts exactly what ACE sends', async () => {
    const key = resolveNovaApiKey();
    expect(key, 'NOVA_API_KEY not resolvable — run /ace:setup --force-env').toBeTruthy();
    const tools = await fetchNovaToolList(key!);
    const violations = checkNovaContract(tools);
    expect(
      violations,
      `Nova drifted:\n${violations.map((v) => `  [${v.kind}] ${v.tool}: ${v.detail}`).join('\n')}`
    ).toEqual([]);
  }, 30_000);

  it('the captured fixture still matches the live surface', async () => {
    const key = resolveNovaApiKey();
    const live = await fetchNovaToolList(key!);
    expect(live.map((t) => t.name).sort()).toEqual(liveShape().map((t) => t.name).sort());
  }, 30_000);
});
