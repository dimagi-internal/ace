/**
 * Resolve the gog OAuth identity (mailbox account + OAuth client) for ACE.
 *
 * `config/agent.json` is AUTHORITATIVE for `gog_client` — the SHARED fleet client
 * (`canopy`), reused by every agent's mailbox. The per-agent identity is the
 * ACCOUNT (`email` / `--account`), never the client.
 *
 * The `$ACE_GMAIL_CLIENT` env var is a legacy fallback ONLY. It resolves to `ace`
 * from 1Password on machines whose vault entry predates the fleet client split,
 * and no `credentials-ace.json` is ever provisioned — so every gog call fails with
 * "OAuth client credentials missing" and prints a remedy (`gog login --client ace`)
 * that is an interactive browser OAuth a headless turn cannot run.
 *
 * jjackson/ace#1147 cleared the env residual for the EMAIL path; this helper is
 * what keeps every OTHER gog caller (Drive reads, etc.) from re-deriving the bug.
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
 *   account: config/agent.json `email`  →  $ACE_GMAIL_ACCOUNT
 *   client:  config/agent.json `gog_client`  →  $ACE_GMAIL_CLIENT
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

  const account = agentConfig.email || env.ACE_GMAIL_ACCOUNT;
  const client = agentConfig.gog_client || env.ACE_GMAIL_CLIENT;

  if (!account || !client) {
    const missing = [!account && 'account', !client && 'client'].filter(Boolean).join(' + ');
    throw new Error(
      `Cannot resolve the gog OAuth identity (${missing}). ` +
        `Expected \`email\` and \`gog_client\` in ${configPath} ` +
        `(gog_client is the SHARED fleet client, normally "canopy"). ` +
        `Legacy fallbacks $ACE_GMAIL_ACCOUNT / $ACE_GMAIL_CLIENT are also unset.`,
    );
  }

  return { account, client };
}
