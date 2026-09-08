import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  MobileError,
  AvdContendedError,
  AvdNotProvisionedError,
} from '../../../mcp/mobile/errors.js';
import {
  serializeMobileToolError,
  installToolErrorGuard,
  type GuardableServer,
  type ToolErrorResult,
} from '../../../mcp/mobile/tool-error.js';

/**
 * dimagi-internal/ace#2223 — a `MobileError`'s authored `remediation` was
 * discarded at the MCP boundary.
 *
 * Every `MobileError` in `mcp/mobile/errors.ts` carries a third constructor
 * argument that is the diagnosis an operator needs, and a Phase 6 halt is
 * exactly where an operator has the least context. On
 * `spark-facilitator/20260907-1120` the halt read, in full:
 *
 *   AVD emulator-5556 never appeared on the adb server within 180s
 *   (last: error: device 'emulator-5556' not found).
 *
 * `waitForDeviceBooted` had already authored the answer — "it registered with
 * a DIFFERENT adb server than this session allocated; check
 * ~/.ace/sessions/<mcp_pid>.lock.json" — and it never reached the caller, so
 * the operator was routed to `/ace:mobile-bootstrap` (re-snapshot a device),
 * which cannot fix AVD contention.
 *
 * THE ISSUE NAMED THE WRONG CALL SITE, AND THAT IS WHY THE FIX IS STRUCTURAL
 * RATHER THAN A ONE-LINE PATCH. The suggested remedy was "add `remediation` to
 * the serialized error object in the tool wrapper" at
 * `mcp/mobile-server.ts:305-320`. That wrapper is `mobile_run_recipe`'s OWN
 * inline catch. `mobile_ensure_avd_running`, the atom that actually failed,
 * had no catch at all: its throw fell through to the MCP SDK's default
 * handler, `McpServer.createToolError(error.message)`
 * (`@modelcontextprotocol/sdk/dist/esm/server/mcp.js`), which serializes the
 * message and NOTHING else. That is the bare string the operator saw, and it
 * is why patching only the named wrapper would have been a no-op for the very
 * failure that motivated the issue. All 18 mobile atoms were registered with a
 * bare callback; the three that did have a catch of their own dropped
 * `remediation` too.
 *
 * So the guard is installed on the SERVER, once, above the first registration
 * — no atom can reach the SDK's message-only fallback, including atoms nobody
 * has written yet — and no hand-rolled catch inside a registration may re-drop
 * the field the guard exists to carry.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVER_REL = 'mcp/mobile-server.ts';

interface ServerSource {
  /** Character offset of the `installToolErrorGuard(server)` call, or -1. */
  guardInstalledAt: number;
  /** Character offset of the first `server.tool('...')` registration, or -1. */
  firstRegistrationAt: number;
  registeredNames: string[];
  /** Registrations whose own catch returns a hand-built envelope. */
  unroutedCatches: string[];
  /** Registration functions used that the guard does not interpose on. */
  unguardedRegistrarMethods: string[];
}

/**
 * Statically parse `mcp/mobile-server.ts`. It calls `main()` at module scope,
 * so importing it would connect a stdio transport — the same reason
 * `test/mcp/registration-coverage.test.ts` parses rather than imports.
 */
function readServerSource(): ServerSource {
  const src = fs.readFileSync(path.join(REPO_ROOT, SERVER_REL), 'utf-8');
  const sf = ts.createSourceFile(SERVER_REL, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const out: ServerSource = {
    guardInstalledAt: -1,
    firstRegistrationAt: -1,
    registeredNames: [],
    unroutedCatches: [],
    unguardedRegistrarMethods: [],
  };

  // Registration methods `installToolErrorGuard` actually interposes on.
  const GUARDED_REGISTRARS = new Set(['tool', 'registerTool']);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      if (ts.isIdentifier(callee) && callee.text === 'installToolErrorGuard') {
        if (out.guardInstalledAt === -1) out.guardInstalledAt = node.getStart(sf);
      }

      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.expression.getText(sf).replace(/\s+/g, '') === 'server'
      ) {
        const method = callee.name.text;
        const first = node.arguments[0];
        if (first && ts.isStringLiteral(first) && /^mobile_[a-z0-9_]+$/.test(first.text)) {
          if (!GUARDED_REGISTRARS.has(method)) out.unguardedRegistrarMethods.push(method);
          if (out.firstRegistrationAt === -1) out.firstRegistrationAt = node.getStart(sf);
          out.registeredNames.push(first.text);

          // A registration is allowed its own catch — `mobile_run_recipe` has
          // one and must (ace#1822: a dispatch that captured unrepeatable
          // frames may not report as if it captured none). What it may not do
          // is hand-build the error envelope, because that is exactly how the
          // field got dropped in the first place. A catch that RETURNS
          // something must return `serializeMobileToolError(...)`; a catch
          // that only swallows (`catch {}`, cleanup) returns nothing and is
          // fine.
          const scanCatches = (n: ts.Node): void => {
            if (ts.isCatchClause(n)) {
              const body = n.block.getText(sf);
              const returnsSomething = /\breturn\s+[^;\s]/.test(body);
              if (returnsSomething && !body.includes('serializeMobileToolError')) {
                out.unroutedCatches.push(first.text);
              }
            }
            ts.forEachChild(n, scanCatches);
          };
          const handler = node.arguments[node.arguments.length - 1];
          if (handler) scanCatches(handler);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('ace#2223 — mcp/mobile-server.ts must not let any atom reach the SDK’s message-only fallback', () => {
  it('finds the mobile atom registrations at all (guards the parser itself)', () => {
    const s = readServerSource();
    expect(s.registeredNames.length).toBeGreaterThanOrEqual(18);
    expect(s.registeredNames).toContain('mobile_ensure_avd_running');
    expect(s.registeredNames).toContain('mobile_run_recipe');
  });

  it('installs the error guard BEFORE the first registration — including mobile_ensure_avd_running, the atom that actually failed', () => {
    const s = readServerSource();
    expect(
      s.guardInstalledAt,
      'mcp/mobile-server.ts never calls installToolErrorGuard(server): a thrown MobileError ' +
        'reaches McpServer.createToolError(), which serializes only `error.message` and ' +
        'discards the authored remediation',
    ).toBeGreaterThan(-1);
    expect(
      s.guardInstalledAt,
      'installToolErrorGuard(server) is called AFTER a registration — the guard only wraps ' +
        'callbacks passed after it is installed, so the atoms above it are still unguarded',
    ).toBeLessThan(s.firstRegistrationAt);
    // mobile_ensure_avd_running is the FIRST registration in the file, so the
    // ordering assertion above is precisely the assertion that it is covered.
    expect(s.registeredNames[0]).toBe('mobile_ensure_avd_running');
  });

  it('registers every atom through a method the guard interposes on', () => {
    const s = readServerSource();
    expect(
      s.unguardedRegistrarMethods,
      `registration methods installToolErrorGuard does not wrap: ${s.unguardedRegistrarMethods.join(', ')}`,
    ).toEqual([]);
  });

  it('lets no registration hand-build an error envelope that re-drops remediation', () => {
    const s = readServerSource();
    expect(
      s.unroutedCatches,
      'these atoms catch and return their own error object instead of ' +
        `serializeMobileToolError(): ${s.unroutedCatches.join(', ')}`,
    ).toEqual([]);
  });
});

describe('serializeMobileToolError — the serialization boundary itself', () => {
  it('carries the remediation of the exact error that halted spark-facilitator/20260907-1120', () => {
    // Verbatim from `waitForDeviceBooted`'s not-seen branch
    // (mcp/mobile/backends/maestro.ts): this is the throw the operator met.
    const thrown = new MobileError(
      'AVD_BOOT_TIMEOUT',
      "AVD emulator-5556 never appeared on the adb server within 180s (last: error: device 'emulator-5556' not found).",
      'The emulator process may have died on launch, or it registered with a DIFFERENT adb ' +
        "server than this session allocated. Check `~/.ace/sessions/<mcp_pid>.lock.json` for " +
        "this session's adb_port, then `ANDROID_ADB_SERVER_PORT=<that> adb devices`.",
    );

    const result = serializeMobileToolError(thrown);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);

    expect(payload.status).toBe('error');
    expect(payload.code).toBe('AVD_BOOT_TIMEOUT');
    // The message is passed through untouched — this fix ADDS, it never edits.
    expect(payload.message).toBe(thrown.message);
    // The whole point.
    expect(payload.remediation).toBe(thrown.remediation);
    expect(payload.remediation).toMatch(/DIFFERENT adb server/);
    expect(payload.remediation).toMatch(/sessions\/<mcp_pid>\.lock\.json/);
  });

  it('carries diagnostics too, and the remediation of a typed subclass', () => {
    const thrown = new AvdContendedError('ACE_Pixel_API_34', 'pid 4711 holds it', {
      holder_pid: 4711,
    });
    const payload = JSON.parse(serializeMobileToolError(thrown).content[0].text);

    expect(payload.code).toBe('AVD_CONTENDED');
    expect(payload.remediation).toMatch(/Boot a different AVD/);
    expect(payload.diagnostics).toEqual({ holder_pid: 4711 });
  });

  it('omits remediation rather than emitting null when the throw authored none', () => {
    // A plain Error, or a MobileError constructed without one. The absence has
    // to read as "no remedy was written", not as "one was written and lost".
    for (const e of [new MobileError('X', 'boom'), new Error('boom'), 'boom']) {
      const payload = JSON.parse(serializeMobileToolError(e).content[0].text);
      expect(payload.message).toBe('boom');
      expect('remediation' in payload).toBe(false);
    }
  });

  it('keeps mobile_run_recipe’s partial-result extras alongside the remediation (ace#1822 + ace#2223)', () => {
    // The one registration with a legitimate hand-written envelope: both
    // invariants have to hold in the same object, or fixing one regresses the
    // other.
    const thrown = new MobileError('MAESTRO_ERROR', 'step 12 failed', 'Re-run the leg.');
    const payload = JSON.parse(
      serializeMobileToolError(thrown, {
        screenshotsDir: '/tmp/run/journey-learn',
        screenshots: [{ path: '/tmp/run/journey-learn/frame-0.png' }],
        note: 'The dispatch THREW.',
      }).content[0].text,
    );

    expect(payload.remediation).toBe('Re-run the leg.');
    expect(payload.screenshotsDir).toBe('/tmp/run/journey-learn');
    expect(payload.screenshots).toHaveLength(1);
    expect(payload.note).toMatch(/THREW/);
  });
});

describe('installToolErrorGuard — what the SDK would otherwise flatten', () => {
  /** Minimal stand-in for McpServer: records what each registration was
   *  handed, so the test can invoke the callback the SDK would have invoked. */
  function stubServer() {
    const registered = new Map<string, (...a: never[]) => Promise<unknown>>();
    const srv = {
      tool: (name: string, _schema: unknown, cb: (...a: never[]) => Promise<unknown>) => {
        registered.set(name, cb);
      },
    };
    return { srv: srv as unknown as GuardableServer, registered };
  }

  it('turns a thrown MobileError into an isError result carrying its remediation', async () => {
    const { srv, registered } = stubServer();
    installToolErrorGuard(srv);

    // Registered exactly as mcp/mobile-server.ts registers it — a bare
    // callback, no per-site wrapping. Pre-fix this throw reached the SDK.
    (srv as unknown as { tool: (...a: unknown[]) => void }).tool(
      'mobile_ensure_avd_running',
      {},
      async () => {
        throw new AvdNotProvisionedError('ACE_Pixel_API_34', "Could not open '…/cache.img'");
      },
    );

    const cb = registered.get('mobile_ensure_avd_running')!;
    const result = (await cb()) as ToolErrorResult;

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.code).toBe('AVD_NOT_PROVISIONED');
    expect(payload.remediation).toMatch(/Re-provision the AVD/);
    // This subclass's remedy exists to warn OFF two wrong leads. Losing it is
    // the same failure the issue reports, one class over.
    expect(payload.remediation).toMatch(/Do NOT reinstall the app/);
  });

  it('passes a successful result through untouched, arguments included', async () => {
    const { srv, registered } = stubServer();
    installToolErrorGuard(srv);
    (srv as unknown as { tool: (...a: unknown[]) => void }).tool(
      'mobile_diagnose',
      {},
      async (args: { a: number }) => ({
        content: [{ type: 'text', text: String(args.a + 1) }],
      }),
    );

    const cb = registered.get('mobile_diagnose')! as (a: { a: number }) => Promise<unknown>;
    await expect(cb({ a: 4 })).resolves.toEqual({ content: [{ type: 'text', text: '5' }] });
  });

  it('does not intercept a handler that returns its own isError result', async () => {
    const { srv, registered } = stubServer();
    installToolErrorGuard(srv);
    (srv as unknown as { tool: (...a: unknown[]) => void }).tool(
      'mobile_resolve_selectors',
      {},
      async () => ({ content: [{ type: 'text', text: '{"ok":false}' }], isError: true }),
    );

    const r = (await registered.get('mobile_resolve_selectors')!()) as ToolErrorResult;
    expect(r.content[0].text).toBe('{"ok":false}');
  });

  it('survives a round trip through the REAL McpServer — the boundary the operator actually met', async () => {
    // The stub above proves the wrapper's logic; this proves the SDK accepts
    // it. Without the guard, this exact call answers with a bare
    // `content[0].text` equal to the message and nothing else — that string,
    // verbatim, is what `spark-facilitator/20260907-1120` reported. In-memory
    // transport: no subprocess, no adb, no device.
    const server = new McpServer({ name: 'ace-mobile-test', version: '0.0.0' });
    installToolErrorGuard(server as unknown as GuardableServer);

    server.tool(
      'mobile_ensure_avd_running',
      { avdName: z.string().default('ACE_Pixel_API_34') },
      async ({ avdName }) => {
        throw new MobileError(
          'AVD_BOOT_TIMEOUT',
          `AVD ${avdName} never appeared on the adb server within 180s.`,
          'It registered with a DIFFERENT adb server than this session allocated. ' +
            'Check `~/.ace/sessions/<mcp_pid>.lock.json`.',
        );
      },
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      // Interposing on the registration must not disturb the tool's schema —
      // the zod default below is applied, which is only true if the SDK still
      // sees a normal registration.
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(['mobile_ensure_avd_running']);

      const res = (await client.callTool({
        name: 'mobile_ensure_avd_running',
        arguments: {},
      })) as { isError?: boolean; content: { text: string }[] };

      expect(res.isError).toBe(true);
      // Asserted before parsing so the pre-fix failure reads as what it is.
      // Remove the guard install above and this is the line that goes red,
      // with `text` equal to the bare message — the operator's whole halt.
      expect(
        res.content[0].text.trimStart().startsWith('{'),
        'the tool result is a bare message, not a serialized envelope — the SDK’s ' +
          `createToolError() fallback is in play. text was: ${res.content[0].text}`,
      ).toBe(true);
      const payload = JSON.parse(res.content[0].text);
      expect(payload.message).toBe(
        'AVD ACE_Pixel_API_34 never appeared on the adb server within 180s.',
      );
      expect(payload.code).toBe('AVD_BOOT_TIMEOUT');
      expect(payload.remediation).toMatch(/DIFFERENT adb server/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('wraps the LAST argument, so the (name, description, schema, cb) form is covered too', async () => {
    const seen: unknown[][] = [];
    const srv = {
      tool: (...args: unknown[]) => {
        seen.push(args);
      },
    } as unknown as GuardableServer;
    installToolErrorGuard(srv);

    (srv as unknown as { tool: (...a: unknown[]) => void }).tool(
      'mobile_future_atom',
      'a description',
      {},
      async () => {
        throw new MobileError('FUTURE', 'boom', 'do the thing');
      },
    );

    // Name/description/schema are passed through untouched; only the callback
    // is replaced.
    expect(seen[0].slice(0, 3)).toEqual(['mobile_future_atom', 'a description', {}]);
    const cb = seen[0][3] as () => Promise<ToolErrorResult>;
    const payload = JSON.parse((await cb()).content[0].text);
    expect(payload.remediation).toBe('do the thing');
  });
});
