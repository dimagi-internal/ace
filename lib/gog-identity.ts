/**
 * Resolve the gog OAuth identity (mailbox account + OAuth client) for ACE.
 *
 * ACCOUNT — `config/agent.json` `email`, the per-agent, never-shared identity
 * (`--account`). It is the only thing that is per-agent.
 *
 * CLIENT — chosen by ONE common function, never typed and never read verbatim.
 * The fleet has two interchangeable Google OAuth clients: `canopy` (Desktop; a
 * laptop's `gog login`) and `canopy-web` (Web; canopy-web's "Connect Google
 * mailbox" button can only mint under it). Same GCP project, same consent
 * screen — a token under either reads and sends the same. Which one THIS
 * machine holds a token under is a per-machine fact, so the rule lives in the
 * canopy plugin (`agent_email.reconcile_client`, exposed as
 * `canopy email client --repo <repo> --json`, canopy ≥ 0.2.572,
 * dimagi-internal/canopy#748): the declared `gog_client` if this machine holds a
 * token under it, else the fleet client it does hold (`canopy`, then
 * `canopy-web`), else the single other client holding the mailbox. Reading
 * `gog_client` verbatim made a mailbox connected from canopy-web unusable here.
 *
 * Only if the canopy CLI cannot be run (absent, or older than the `client`
 * command) do we fall back to the DECLARED `gog_client` (else `canopy`), and we
 * say so on stderr.
 *
 * There are NO env-var fallbacks. `$ACE_GMAIL_ACCOUNT` / `$ACE_GMAIL_CLIENT` were
 * removed here and from `.env.tpl` together: the vault supplied `gmail_client=ace`
 * against agent.json's `canopy`, no `credentials-ace.json` is ever provisioned, and
 * so every call reading the env var failed with "OAuth client credentials missing"
 * and a remedy (`gog login --client ace`) that is an interactive browser OAuth a
 * headless turn cannot run. A fallback that can only ever be staler than the
 * primary is a second source of truth, not resilience. (jjackson/ace#1147 / #1338.)
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface GogIdentity {
  account: string;
  client: string;
}

/** Result of one CLI invocation, the subset of `spawnSync` we read. */
export interface CanopyRunResult {
  status: number | null;
  stdout: string;
  error?: Error;
}

/** Runs `<cmd> <args...>`; injectable so tests never spawn a real canopy. */
export type CanopyRunner = (cmd: string, args: string[]) => CanopyRunResult;

export interface ResolveGogIdentityOptions {
  /** Repo (or installed-plugin) root that holds `config/agent.json`. */
  repoRoot: string;
  /** Environment. Deliberately NOT consulted for identity (ace#1147). */
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the real process spawn (and disables the cache). */
  run?: CanopyRunner;
  /** Where the fallback notice goes. Defaults to stderr. */
  warn?: (msg: string) => void;
}

const defaultRun: CanopyRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', error: r.error };
};

/** canopy's installed-plugin runtime root — same resolution bin/ace-email uses. */
function canopyRuntimeRoot(run: CanopyRunner): string | null {
  try {
    const reg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.claude/plugins/installed_plugins.json'), 'utf8'),
    );
    const install = reg?.plugins?.['canopy@canopy']?.[0]?.installPath;
    if (!install) return null;
    const resolver = path.join(install, 'scripts', 'canopy-runtime.sh');
    if (!fs.existsSync(resolver)) return null;
    const r = run('bash', [resolver]);
    const root = r.stdout.trim();
    return r.status === 0 && root ? root : null;
  } catch {
    return null;
  }
}

function parseClient(r: CanopyRunResult): string | null {
  if (r.error || r.status !== 0) return null;
  try {
    const client = JSON.parse(r.stdout)?.client;
    return typeof client === 'string' && client ? client : null;
  } catch {
    return null;
  }
}

/**
 * Ask canopy which client this machine should use for the agent's mailbox:
 * `canopy` on PATH first, then canopy's installed runtime via `uv run --project`
 * (the fallback bin/ace-email uses). Null when neither can answer.
 */
export function canopyEmailClient(repoRoot: string, run: CanopyRunner = defaultRun): string | null {
  const args = ['email', 'client', '--repo', repoRoot, '--json'];
  const onPath = parseClient(run('canopy', args));
  if (onPath) return onPath;
  const runtime = canopyRuntimeRoot(run);
  if (!runtime) return null;
  return parseClient(run('uv', ['run', '--project', runtime, 'canopy', ...args]));
}

// A process asks once per repo: the MCP server and clone-setup-checklist call
// this per gog command, and a token appearing mid-process is rare enough that a
// short TTL is the right trade against a canopy spawn per call.
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { client: string; at: number }>();

/**
 * Returns the account + client to pass to `gog --account <a> --client <c>`.
 *
 *   account: config/agent.json `email` (no fallback — ace#1147)
 *   client:  `canopy email client --repo <repoRoot> --json` → `.client`;
 *            if canopy cannot be run, config/agent.json `gog_client`, else `canopy`
 *
 * Throws a typed, actionable error when the account is missing.
 */
export function resolveGogIdentity({
  repoRoot,
  run,
  warn = (m) => process.stderr.write(`${m}\n`),
}: ResolveGogIdentityOptions): GogIdentity {
  let agentConfig: { email?: string; gog_client?: string } = {};
  const configPath = path.join(repoRoot, 'config', 'agent.json');
  try {
    agentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // Missing/unparseable agent.json → no account → the throw below.
  }

  // agent.json is the ONLY source of the account; the env is never consulted.
  const account = agentConfig.email;
  if (!account) {
    throw new Error(
      `Cannot resolve the gog OAuth identity (missing email). ` +
        `Set it in ${configPath} — that file is the single source of truth ` +
        `(the per-agent identity is \`email\`, applied via --account; the client ` +
        `is chosen by \`canopy email client\`). ` +
        `There are deliberately no env-var fallbacks (ace#1147).`,
    );
  }

  const hit = run ? undefined : cache.get(repoRoot);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { account, client: hit.client };

  const resolved = canopyEmailClient(repoRoot, run ?? defaultRun);
  if (resolved) {
    if (!run) cache.set(repoRoot, { client: resolved, at: Date.now() });
    return { account, client: resolved };
  }

  const declared = agentConfig.gog_client || 'canopy';
  warn(
    `gog-identity: \`canopy email client\` could not be run (canopy missing or < 0.2.572) — ` +
      `using the declared gog_client "${declared}" from ${configPath}. ` +
      `A mailbox authorized only under the other fleet client will fail; update canopy.`,
  );
  return { account, client: declared };
}
