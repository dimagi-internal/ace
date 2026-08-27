/**
 * Resolve the gog OAuth identity (mailbox account + OAuth client) for ACE.
 *
 * `config/agent.json` is AUTHORITATIVE for `gog_client` — the SHARED fleet client
 * (`canopy`), reused by every agent's mailbox. The per-agent identity is the
 * ACCOUNT (`email` / `--account`), never the client.
 *
 * There are NO env-var fallbacks. `$ACE_GMAIL_ACCOUNT` / `$ACE_GMAIL_CLIENT` were
 * removed here and from `.env.tpl` together: the vault supplied `gmail_client=ace`
 * against agent.json's `canopy`, no `credentials-ace.json` is ever provisioned, and
 * so every call reading the env var failed with "OAuth client credentials missing"
 * and a remedy (`gog login --client ace`) that is an interactive browser OAuth a
 * headless turn cannot run. A fallback that can only ever be staler than the
 * primary is a second source of truth, not resilience.
 *
 * Neither value is a secret — a mailbox address and an OAuth CLIENT NAME are not
 * credentials; the real client_id/secret live in gog's own credentials file that
 * `--client canopy` selects. So identity lives in version control, not a vault.
 *
 * jjackson/ace#1147 / #1338. This helper is what keeps every gog caller (email,
 * Drive reads, doctor probes) resolving one identity.
 */
import fs from 'fs';
import path from 'path';

export interface GogIdentity {
  account: string;
  client: string;
}

export interface ResolveGogIdentityOptions {
  /** Repo (or installed-plugin) root that holds `config/agent.json`. */
  repoRoot: string;
  /** Environment to read the legacy fallbacks from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Returns the account + client to pass to `gog --account <a> --client <c>`.
 *
 * Precedence:
 *   account: config/agent.json `email`      (no fallback — ace#1147)
 *   client:  config/agent.json `gog_client` (no fallback — ace#1147)
 *
 * Throws a typed, actionable error when neither source yields a value.
 */
export function resolveGogIdentity({ repoRoot, env = process.env }: ResolveGogIdentityOptions): GogIdentity {
  let agentConfig: { email?: string; gog_client?: string } = {};
  const configPath = path.join(repoRoot, 'config', 'agent.json');
  try {
    agentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // Missing/unparseable agent.json falls through to the env fallbacks below.
  }

  // agent.json is the ONLY source. The `$ACE_GMAIL_ACCOUNT` /
  // `$ACE_GMAIL_CLIENT` fallbacks were removed in ace#1147's follow-up: a
  // fallback that can only ever supply a STALER value than the primary is not
  // resilience, it is a second source of truth waiting to drift — and it did,
  // to a client with no credentials file. Both are gone from `.env.tpl`, so a
  // fallback here could now only read a residual on one machine and silently
  // diverge from every other. Missing config throws instead.
  const account = agentConfig.email;
  const client = agentConfig.gog_client;

  if (!account || !client) {
    const missing = [!account && 'email', !client && 'gog_client'].filter(Boolean).join(' + ');
    throw new Error(
      `Cannot resolve the gog OAuth identity (missing ${missing}). ` +
        `Set it in ${configPath} — that file is the single source of truth ` +
        `(gog_client is the SHARED fleet client, normally "canopy"; the ` +
        `per-agent identity is \`email\`, applied via --account). ` +
        `There are deliberately no env-var fallbacks (ace#1147).`,
    );
  }

  return { account, client };
}
