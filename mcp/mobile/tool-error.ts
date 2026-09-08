/**
 * Error serialization at the ace-mobile MCP boundary (dimagi-internal/ace#2223).
 *
 * Every `MobileError` in `./errors.ts` is constructed with a `remediation`
 * string that IS the diagnosis — `AvdContendedError` names the contention,
 * `AvdNotProvisionedError` names the re-provision and warns off the two wrong
 * leads, `waitForDeviceBooted`'s `AVD_BOOT_TIMEOUT` names the different-adb-
 * server case and the exact lock file to read. None of it reached the caller.
 *
 * The mechanism is the MCP SDK's default: a tool callback that THROWS is
 * caught by `McpServer`, which returns
 * `createToolError(error instanceof Error ? error.message : String(error))` —
 * a single text block carrying the message and nothing else. `code`,
 * `remediation` and `diagnostics` are all dropped, silently, with no error of
 * their own. Only three of the mobile server's eighteen atoms had a catch of
 * their own, and `mobile_ensure_avd_running` — the one that halted
 * `spark-facilitator/20260907-1120` Phase 6 — was not among them.
 *
 * `installToolErrorGuard` therefore interposes on the SERVER's registration
 * function rather than on any one wrapper: the invariant is that no atom can
 * reach the SDK's message-only fallback, and it holds for atoms nobody has
 * written yet. `test/mcp/mobile/tool-error-remediation.test.ts` fails if the
 * guard is not installed before the first registration.
 *
 * The message is passed through UNTOUCHED. This adds fields; it never edits
 * or replaces what the throw site said.
 */

/** The MCP `CallToolResult` shape this module emits. Structurally typed so it
 *  satisfies the SDK's callback return type without importing its internals. */
export interface ToolErrorResult {
  // The SDK's `CallToolResult` carries an open index signature; without a
  // matching one here, returning this straight out of a handler fails to
  // typecheck against `server.tool`'s callback type.
  [k: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError: true;
}

/**
 * Serialize any thrown value into an MCP error result, preserving the fields
 * a `MobileError` authored.
 *
 * `extras` is merged last so a caller with richer knowledge of its own failure
 * (`mobile_run_recipe` returns the screenshots a dead dispatch did capture —
 * ace#1822) can add to, and where it genuinely knows better override, the
 * generic envelope.
 */
export function serializeMobileToolError(
  e: unknown,
  extras?: Record<string, unknown>,
): ToolErrorResult {
  const err = e as {
    code?: unknown;
    remediation?: unknown;
    diagnostics?: unknown;
  } | null;

  const payload: Record<string, unknown> = {
    status: 'error',
    message: e instanceof Error ? e.message : String(e),
  };
  if (typeof err?.code === 'string') payload.code = err.code;
  // The whole point of the issue. Present on every MobileError subclass that
  // authored one; absent (rather than `undefined`) when the throw carried none,
  // so a caller can distinguish "no remedy was written" from "one was written
  // and lost".
  if (typeof err?.remediation === 'string' && err.remediation.length > 0) {
    payload.remediation = err.remediation;
  }
  if (err?.diagnostics && typeof err.diagnostics === 'object') {
    payload.diagnostics = err.diagnostics;
  }
  if (extras) Object.assign(payload, extras);

  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

/**
 * Wrap an MCP tool callback so a thrown `MobileError` is serialized with its
 * remediation instead of being flattened to a bare message by the SDK.
 *
 * A handler that already returns its own `isError` result is untouched — this
 * only intercepts the THROW path.
 */
type AnyToolCallback = (...args: any[]) => unknown;

export function guardToolHandler<H extends AnyToolCallback>(handler: H): H {
  return (async (...args: Parameters<H>) => {
    try {
      return await handler(...args);
    } catch (e) {
      return serializeMobileToolError(e);
    }
  }) as unknown as H;
}

/** The subset of `McpServer` this guard needs. Structural on purpose: the test
 *  installs it on a stub, and nothing here depends on the SDK's internals. */
export interface GuardableServer {
  tool: AnyToolCallback;
  registerTool?: AnyToolCallback;
}

/**
 * Install the guard ONCE, on the server, so EVERY registration is covered —
 * including ones written later by someone who never read this file.
 *
 * Wrapping each callback at its own `server.tool(...)` call site was the first
 * shape of this fix and it is the wrong one twice over. It is per-site
 * discipline, so atom nineteen is born unguarded unless its author remembers;
 * and it breaks the SDK's contextual typing — `server.tool`'s overloads are
 * what give a handler's destructured `{ avdName }` its type and its
 * `content[].type` the literal `'text'`, and an intervening generic call
 * erases both. Interposing on the registration function keeps every call site
 * byte-identical (which also keeps `lib/atom-schema-parser.ts` and
 * `test/mcp/registration-coverage.test.ts`, both of which key on the literal
 * `server.tool(` shape, working unchanged) while making coverage total rather
 * than remembered.
 *
 * MUST be called before the first registration; the guard only wraps callbacks
 * passed after it is installed. `test/mcp/mobile/tool-error-remediation.test.ts`
 * asserts that ordering against the source.
 */
export function installToolErrorGuard(server: GuardableServer): void {
  for (const method of ['tool', 'registerTool'] as const) {
    const original = server[method];
    if (typeof original !== 'function') continue;
    const bound = original.bind(server) as AnyToolCallback;
    // The callback is always the LAST argument, in every registration form the
    // SDK accepts — (name, schema, cb) and (name, description, schema, cb) alike.
    server[method] = ((...args: unknown[]) => {
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        args[args.length - 1] = guardToolHandler(last as AnyToolCallback);
      }
      return bound(...args);
    }) as AnyToolCallback;
  }
}
