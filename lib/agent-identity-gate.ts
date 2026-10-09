/**
 * Session-identity gate for the MCP servers that act AS ACE (canopy#850).
 *
 * ace-gdrive and ace-decisions sign in with ACE's Google service-account key;
 * ace-ocs and ace-connect sign in with ACE's own OCS / CommCare HQ / Connect
 * logins. Identity used to come from whichever plugin happened to be loaded,
 * so ANY session that loaded the ACE plugin — an Ada turn, a human in another
 * repo — acted as ACE. On 2026-10-09 an Ada session read a doc through
 * ace-gdrive and got "not found" because it was signed in as the wrong account.
 *
 * Identity now comes from the session. Before a gated server acts, it asks the
 * canopy broker:
 *
 *     canopy cred check --agent ace
 *
 * Exit 0 → this session may act as ACE. Anything else refuses:
 *   3 refused (stderr = one actionable paragraph), 4 undetermined, 1/2 error,
 *   and a missing `canopy` CLI. There is NO fallback to the bundled key.
 * Contract: canopy docs/architecture/session-identity.md.
 *
 * The check runs lazily on the FIRST tool call, so server startup never blocks
 * on it. An allow is cached for the life of the process (one process per
 * session); a refusal is not, so fixing access (`op signin`) takes effect on
 * the next call without restarting. A tool call that fails drops the cached
 * allow, so the next call re-checks — the "re-check on failure" rule.
 *
 * ace-mobile is deliberately NOT gated: it drives a local emulator, its only
 * identity is the E2E test FLW (a fixture persona, not ACE's account), and its
 * cloud backend authenticates with the caller's own ace-web PAT.
 */
import { execFile } from 'node:child_process';

/** The agent whose credentials these servers carry. */
export const ACE_AGENT = 'ace';

/** What a Drive-backed server tells a refused session to use instead. */
export const DRIVE_REFUSAL_HINT = 'Use your own Drive path: gog as your own account / canopy gdoc.';

/** What a server holding ACE's own platform logins (OCS, HQ, Connect) says instead. */
export function platformRefusalHint(platform: string): string {
  return (
    `This server acts with ACE's own ${platform} login. To get the work done as ACE, ` +
    `dispatch it to ACE (\`canopy agent dispatch\`); otherwise use your own ${platform} account.`
  );
}

export interface CredResult {
  /** Process exit code; null when the process could not run or was killed. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be spawned (ENOENT: no `canopy` on PATH) or timed out. */
  error?: NodeJS.ErrnoException;
}

/** Runs `canopy <args>`. Injectable so tests never touch the real CLI. */
export type CredRunner = (args: string[]) => Promise<CredResult>;

/** Long enough for a 1Password desktop-app unlock prompt; still a real bound. */
const CHECK_TIMEOUT_MS = 120_000;

export const defaultCredRunner: CredRunner = (args) =>
  new Promise((resolve) => {
    execFile(
      'canopy',
      args,
      { encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
        // execFile reports a non-zero exit as an Error whose `code` is the number.
        if (e && typeof e.code === 'number') {
          resolve({ status: e.code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          return;
        }
        resolve({
          status: e ? null : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ...(e ? { error: e } : {}),
        });
      },
    );
  });

export type Verdict = { allowed: true } | { allowed: false; message: string };

/** Map one `canopy cred check` run onto allow/refuse. Every non-zero outcome refuses. */
export function interpretCheck(agent: string, r: CredResult): Verdict {
  if (r.error) {
    const why =
      r.error.code === 'ENOENT'
        ? 'the `canopy` CLI is not installed or not on PATH'
        : `\`canopy cred check\` could not run (${r.error.message})`;
    return {
      allowed: false,
      message:
        `Refusing to act as agent '${agent}': ${why}, so this session's identity cannot be ` +
        `confirmed. Install canopy (see /canopy:setup) and re-check with ` +
        `\`canopy cred check --agent ${agent}\`.`,
    };
  }
  if (r.status === 0) return { allowed: true };
  const stderr = r.stderr.trim();
  if (r.status === 3 && stderr) return { allowed: false, message: stderr };
  const label =
    r.status === 3
      ? 'refused'
      : r.status === 4
        ? 'undetermined (treated as refused)'
        : `error (exit ${r.status})`;
  return {
    allowed: false,
    message:
      `Refusing to act as agent '${agent}': \`canopy cred check --agent ${agent}\` ${label}` +
      (stderr ? `: ${stderr}` : '.'),
  };
}

export interface IdentityGate {
  /** null when allowed; otherwise the refusal text a tool call returns. */
  ensure(): Promise<string | null>;
  /** Drop a cached allow so the next call re-checks. */
  invalidate(): void;
}

export interface IdentityGateOptions {
  agent?: string;
  run?: CredRunner;
  /** Appended to every refusal: where the session should go instead. */
  hint: string;
}

export function createIdentityGate(opts: IdentityGateOptions): IdentityGate {
  const agent = opts.agent ?? ACE_AGENT;
  const run = opts.run ?? defaultCredRunner;
  let allowed = false;
  let inflight: Promise<string | null> | null = null;
  return {
    async ensure() {
      if (allowed) return null;
      // Parallel first calls share one check rather than spawning N.
      inflight ??= (async () => {
        try {
          const verdict = interpretCheck(agent, await run(['cred', 'check', '--agent', agent]));
          if (verdict.allowed) {
            allowed = true;
            return null;
          }
          return `${verdict.message}\n\n${opts.hint}`;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    invalidate() {
      allowed = false;
    },
  };
}

type AnyFn = (...args: unknown[]) => unknown;
interface GateableServer {
  tool?: AnyFn;
  registerTool?: AnyFn;
}

function isErrorResult(r: unknown): boolean {
  return !!r && typeof r === 'object' && (r as { isError?: unknown }).isError === true;
}

/**
 * Gate every tool registered AFTER this call. Install it BEFORE any other
 * registration wrapper (e.g. the Drive tenancy guard), so it is the outermost
 * layer and a refused session never reaches code that uses the credentials.
 */
export function installIdentityGate(server: GateableServer, gate: IdentityGate): void {
  for (const method of ['tool', 'registerTool'] as const) {
    const original = server[method];
    if (typeof original !== 'function') continue;
    const bound = original.bind(server) as AnyFn;
    server[method] = ((...regArgs: unknown[]) => {
      const last = regArgs[regArgs.length - 1];
      if (typeof last === 'function') {
        const handler = last as AnyFn;
        regArgs[regArgs.length - 1] = async (...callArgs: unknown[]) => {
          const refusal = await gate.ensure();
          if (refusal) {
            return { isError: true, content: [{ type: 'text', text: refusal }] };
          }
          try {
            const out = await handler(...callArgs);
            if (isErrorResult(out)) gate.invalidate();
            return out;
          } catch (err) {
            gate.invalidate();
            throw err;
          }
        };
      }
      return bound(...regArgs);
    }) as AnyFn;
  }
}
