/**
 * lib/nova-header-readiness.ts
 *
 * Pure decision logic behind the `nova_header_readiness` doctor probe.
 * No I/O — `bin/ace-doctor` gathers the four facts and feeds them here.
 *
 * WHY THIS EXISTS. The question that matters is *"will the Nova MCP receive an
 * `Authorization` header?"* — and until now every ACE probe answered a
 * DIFFERENT question and then reported the answer to this one.
 *
 * `nova_shell_env` tested `[ -n "${NOVA_API_KEY:-}" ]` and passed with the text
 * "Nova plugin headersHelper will authenticate". But `bin/ace-doctor` runs
 * under a shell initialised from the user's rc files (`~/.zshenv` sources
 * `~/.ace/env.sh`), so the doctor's OWN env always has the key — regardless of
 * whether the *Claude Code process* does. It measured itself and reported a
 * conclusion about somebody else. Same class as the `gog_auth` false PASS in
 * ace#1338: a check that cannot observe the thing it claims to verify.
 *
 * THE MECHANISM IT HAS TO CATCH (voidcraft-labs/nova-plugin#52, ace#1629).
 * Nova's `.mcp.json` authenticates through an env-var-dependent helper:
 *
 *     if [ -n "$NOVA_API_KEY" ]; then printf '{"Authorization":"Bearer %s"}' "$NOVA_API_KEY"; else printf '{}'; fi
 *
 * Claude Code 2.1.238 changed what env the interactive-session MCP connect path
 * passes to `headersHelper` (measured in ace#1629: 2.1.237 = 32/32 sessions
 * sent a header; 2.1.238+ = 0/53). When the key is absent from that env the
 * helper emits `{}` — no header — and Claude Code silently falls back to OAuth,
 * whose token lacks `nova.hq.read`. Every Nova read then answers about the
 * wrong principal, or refuses with `scope_missing`.
 *
 * WHY THE LOOP IS SO EXPENSIVE. `Clear authentication` is the documented
 * remedy, and in this state it is a **no-op by construction**: it removes the
 * OAuth token, but with no key in the process env the helper still returns
 * `{}`, so the session re-prompts OAuth and re-caches `plugin:nova:nova` in
 * `~/.claude/mcp-needs-auth-cache.json`. The operator restarts and lands in the
 * same state. Measured 2026-08-28 on `acedimagi`: many restarts, no progress,
 * while a direct `curl` with the very same PAT returned
 * `get_hq_connection -> configured:true`.
 *
 * TWO DESIGN RULES worth stating, because both were violated by the probe this
 * replaces:
 *
 *  1. **No version gate.** It would be easy to test `claudeVersion >= 2.1.238`.
 *     Don't. That encodes a premise about somebody else's code that has already
 *     moved three times, and it rots silently. Measure the CONSEQUENCE — is a
 *     header going to be sent — and the check stays correct whatever upstream
 *     does next.
 *
 *  2. **An unreadable env is `skip`, never `pass`.** `ps -Eww` can be refused
 *     (SIP, another user's process), and "I saw no NOVA_API_KEY" is then
 *     indistinguishable from "I saw nothing at all". The caller passes an
 *     independent count of env-looking tokens as a CONTROL; zero means the read
 *     failed. Without it this probe would reproduce the exact false-negative it
 *     exists to eliminate.
 */

/** How the Nova MCP would obtain its `Authorization` header, if at all. */
export type NovaHeaderStatus = 'pass' | 'fail' | 'skip';

export type NovaHeaderReason =
  /** A user-scope `nova` entry carries a literal `Authorization` header. */
  | 'static-header-override'
  /**
   * An override exists but its Bearer token is NOT the currently-configured
   * PAT — i.e. the key was rotated and the override still pins the old one.
   * This is the failure mode the override itself introduces: it is static, so
   * it does not follow a rotation, and it wins over everything else. Nova then
   * authenticates as a stale credential while every ACE key check reports
   * green, because `.env`, `~/.ace/env.sh` and 1Password all agree with each
   * other and none of them is what the connection is using.
   */
  | 'static-header-stale'
  /** `NOVA_API_KEY` is present in the Claude Code process env. */
  | 'key-in-claude-env'
  /** `ps -Eww` returned nothing usable — cannot conclude either way. */
  | 'env-unreadable'
  /** No PAT configured anywhere; `nova_env` already reports this. */
  | 'no-key-configured'
  /** Proven: the helper will emit `{}` and no header will be sent. */
  | 'helper-will-emit-empty';

export interface NovaHeaderInput {
  /**
   * Env-var names visible in the CLAUDE CODE process (not the doctor's own
   * shell). Pass `null` when the read was refused.
   */
  claudeEnvNames: string[] | null;
  /**
   * CONTROL: how many `KEY=` tokens the same read produced. Zero means the env
   * was not actually readable, even if `claudeEnvNames` is `[]`.
   */
  claudeEnvTokenCount: number;
  /**
   * The user-scope `nova` MCP entry's headers, if such an entry exists.
   * `null` when there is no user-scope override at all.
   */
  userScopeNovaHeaders: Record<string, string> | null;
  /** Whether a PAT is configured in ACE's `.env` / `~/.ace/env.sh`. */
  keyConfigured: boolean;
  /**
   * Whether the override's Bearer token equals the configured PAT.
   * `null` when the comparison is not possible (no override, or no configured
   * key to compare against) — never guess, and never treat `null` as `true`.
   */
  staticHeaderMatchesConfiguredKey?: boolean | null;
}

export interface NovaHeaderVerdict {
  status: NovaHeaderStatus;
  reason: NovaHeaderReason;
  /** One-line human summary, safe to print verbatim. */
  summary: string;
  /**
   * True only when the condition is PROVEN and a key exists to install — i.e.
   * the caller may auto-install the static-header override. Never true on a
   * `skip`, because a skip means we could not observe the state.
   */
  autoHealable: boolean;
}

/** Case-insensitive lookup for a non-empty `Authorization` header. */
export function hasStaticAuthHeader(headers: Record<string, string> | null): boolean {
  if (!headers) return false;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'authorization') continue;
    if (typeof value === 'string' && value.trim() !== '') return true;
  }
  return false;
}

/**
 * Decide whether the Nova MCP will get an `Authorization` header.
 *
 * Order matters. The static-header override is checked FIRST because it makes
 * the process env irrelevant — that entry is precisely the nova-plugin#52
 * workaround, and a machine carrying it is healthy even though the helper would
 * still emit `{}` if it ran.
 */
export function classifyNovaHeaderReadiness(input: NovaHeaderInput): NovaHeaderVerdict {
  if (hasStaticAuthHeader(input.userScopeNovaHeaders)) {
    // Drift check BEFORE declaring victory. A static header does not follow a
    // key rotation, and it outranks every other credential path — so a stale
    // one is worse than none: nova binds an old PAT while `.env`, `~/.ace` and
    // 1Password all agree with each other and report green.
    if (input.staticHeaderMatchesConfiguredKey === false) {
      return {
        status: 'fail',
        reason: 'static-header-stale',
        summary:
          'the user-scope nova override pins a Bearer token that is NOT the currently-configured ' +
          'NOVA_API_KEY — the key was rotated and the override still carries the old one',
        autoHealable: true,
      };
    }
    return {
      status: 'pass',
      reason: 'static-header-override',
      summary:
        'user-scope nova entry carries a static Authorization header ' +
        '(voidcraft-labs/nova-plugin#52 workaround active) — the headersHelper is bypassed',
      autoHealable: false,
    };
  }

  // CONTROL before conclusion: an unreadable env must never look like a clean one.
  if (input.claudeEnvNames === null || input.claudeEnvTokenCount === 0) {
    return {
      status: 'skip',
      reason: 'env-unreadable',
      summary:
        "could not read the Claude Code process env (ps -Eww returned no environment) — " +
        'cannot tell whether the headersHelper will authenticate',
      autoHealable: false,
    };
  }

  if (input.claudeEnvNames.includes('NOVA_API_KEY')) {
    return {
      status: 'pass',
      reason: 'key-in-claude-env',
      summary:
        'NOVA_API_KEY is present in the Claude Code process env — the headersHelper will emit a Bearer header',
      autoHealable: false,
    };
  }

  if (!input.keyConfigured) {
    return {
      status: 'skip',
      reason: 'no-key-configured',
      summary: 'no NOVA_API_KEY configured in ACE .env — see nova_env',
      autoHealable: false,
    };
  }

  return {
    status: 'fail',
    reason: 'helper-will-emit-empty',
    summary:
      "NOVA_API_KEY is absent from the Claude Code process env and no static-header override exists — " +
      "nova's headersHelper will emit {} and Claude Code will fall back to OAuth (which lacks nova.hq.read)",
    autoHealable: true,
  };
}

/**
 * The remedy string for a verdict. Deliberately NOT "Clear authentication":
 * in the `helper-will-emit-empty` state that instruction is a no-op and is the
 * documented cause of the restart loop.
 */
export function remediationFor(verdict: NovaHeaderVerdict, opts: { autoInstalled?: boolean } = {}): string {
  switch (verdict.reason) {
    case 'static-header-override':
    case 'key-in-claude-env':
      return '';
    case 'static-header-stale':
      return opts.autoInstalled
        ? 'the override has been RE-POINTED at the current NOVA_API_KEY automatically. Cmd-Q + reopen ' +
            'Claude Code so the MCP subprocess rebinds.'
        : 're-point the override at the current key, then Cmd-Q + reopen Claude Code: ' +
            "claude mcp add --transport http --scope user nova https://mcp.commcare.app/mcp " +
            "--header 'Authorization: Bearer <CURRENT-PAT>'  (adding it again overwrites the entry)";
    case 'env-unreadable':
      return (
        'Re-run the doctor from a normal interactive session. If it persists, install the ' +
        'static-header override anyway — it is harmless when the env is already correct: ' +
        "claude mcp add --transport http --scope user nova https://mcp.commcare.app/mcp --header 'Authorization: Bearer <PAT>'"
      );
    case 'no-key-configured':
      return 'run /ace:setup --force-env (writes ~/.ace/env.sh and the ACE .env)';
    case 'helper-will-emit-empty':
      return opts.autoInstalled
        ? 'the static-header override has been INSTALLED automatically (voidcraft-labs/nova-plugin#52 / ' +
            'dimagi-internal/ace#1629). MCP subprocesses only rebind on a full restart: Cmd-Q + reopen ' +
            'Claude Code, then re-run your command. Do NOT visit /mcp — neither Authenticate nor Clear ' +
            'authentication helps here, and Authenticate mints an OAuth token that lacks nova.hq.read. ' +
            'If /ace:doctor later calls this override stale, LEAVE IT (ace#1629).'
        : "install the static-header override, then Cmd-Q + reopen Claude Code: " +
            "claude mcp add --transport http --scope user nova https://mcp.commcare.app/mcp " +
            "--header 'Authorization: Bearer <PAT>'  — do NOT use /mcp Clear authentication, which is a " +
            'no-op in this state (it removes the OAuth token but leaves no credential to fall back to, ' +
            'so the session re-prompts OAuth and the loop repeats).';
  }
}
