/**
 * lib/static-header-drift.ts
 *
 * Does a user-scope MCP entry in `~/.claude.json` pin an `Authorization`
 * header that is NO LONGER the credential ACE is configured with?
 * (dimagi-internal/ace#2159)
 *
 * ## The failure this generalizes
 *
 * `lib/nova-header-readiness.ts` already carries this check — for `nova`, by
 * hand, as one branch of a classifier that is otherwise entirely about nova's
 * env-var-dependent `headersHelper`. Its own comment states the stakes:
 *
 *   > a stale one is worse than none: nova binds an old PAT while `.env`,
 *   > `~/.ace` and 1Password all agree with each other and report green.
 *
 * The same thing then happened to `connect_labs`, where no equivalent check
 * existed. Measured on the `bednet-2-visit` preflight halt, 2026-09-07
 * (ace#2159): the user-scope `connect_labs` entry pinned a rotated token
 * (prefix `-XymInn…`) while `.env` and the plugin's own `headersHelper` both
 * carried the current one (prefix `fw4n2b3…`). Same endpoint, same payload:
 *
 *   stale override token  → HTTP 401
 *   current `.env` token  → HTTP 200
 *
 * Zero connect-labs atoms bound into the session, so Phase 7 (synthetic) and
 * Phase 8 (solicitation) could not run — `blocks-e2e` — and **nothing named
 * it**. `bin/ace-doctor`'s labs probes (`connect_labs_env`,
 * `connect_labs_mcp_reachable`, `connect_labs_connect_oauth`) all read
 * `LABS_MCP_TOKEN` out of `.env` and curl labs with it directly, so they were
 * green on a credential the session was not using. That is the `nova_shell_env`
 * / `gog_auth` class again (ace#1338): a check that measures one thing and
 * reports the answer to another.
 *
 * ## Why a static header is the dangerous form
 *
 * It does not follow a rotation. Every other path ACE has — the plugin's
 * `headersHelper` (`scripts/labs-auth-headers.mjs`), `~/.ace/env.sh`, 1Password
 * — re-reads its source, so rotating and re-running `/ace:setup --force-env`
 * fixes them all at once. A literal header in `~/.claude.json` is a copy taken
 * at one moment in time, and Claude Code binds it at connection time for the
 * life of the MCP subprocess (`CLAUDE.md § MCP changes need a full Claude
 * restart`). Nothing on disk disagrees with anything else, and the only signal
 * is the session-start notice, which is not in any artifact a run reads.
 *
 * ## Design rules, both inherited from the nova classifier
 *
 * 1. **Never guess a match.** When the comparison is not possible — no
 *    override, no configured key, a server ACE knows nothing about — the
 *    answer is `null`/`skip`, NEVER `true`/`pass`. A probe that reports "fine"
 *    when it could not look is the defect, not the check.
 * 2. **Heal only what this probe owns.** `nova` is registered here so the walk
 *    is complete and a drifted nova entry is still NAMED, but its heal belongs
 *    to `nova_header_readiness`, which re-points it as part of a larger
 *    verdict. Two probes writing `~/.claude.json` in one doctor run is how you
 *    get contradictory output about the same entry.
 *
 * Pure by design — all I/O lives in `scripts/doctor-static-header-drift.ts`.
 * Same split as `lib/env-freshness.ts` and `lib/plugin-cache-freshness.ts`.
 */

/** A user-scope MCP entry ACE knows the authoritative credential for. */
export interface StaticHeaderServerSpec {
  /** Key under `mcpServers` in `~/.claude.json`. */
  server: string;
  /** The `.env` variable that is authoritative for this server's bearer. */
  envKey: string;
  /**
   * The probe that owns the HEAL for this entry, when it is not this one.
   * Present means: report the drift, do not write the file.
   */
  healOwner?: string;
  /** What the entry is for, printed in the remediation. */
  note?: string;
}

/**
 * The registry. Deliberately explicit rather than derived: a bearer token in
 * an entry ACE did not configure has no `.env` key to compare against, and
 * inventing a mapping would manufacture false drift.
 */
export const STATIC_HEADER_SERVERS: StaticHeaderServerSpec[] = [
  {
    server: 'connect_labs',
    envKey: 'LABS_MCP_TOKEN',
    note: 'labs.connect.dimagi.com/mcp/ — Phases 7 (synthetic) and 8 (solicitation)',
  },
  {
    server: 'nova',
    envKey: 'NOVA_API_KEY',
    healOwner: 'nova_header_readiness',
    note: 'mcp.commcare.app/mcp — the voidcraft-labs/nova-plugin#52 static-header workaround',
  },
];

export type StaticHeaderDriftReason =
  /** The pinned bearer is NOT the configured key. Proven stale. */
  | 'drifted'
  /** The pinned bearer equals the configured key. */
  | 'matches'
  /** No user-scope entry, or it carries no `Authorization` header. */
  | 'no-override'
  /** An override exists but ACE has no key to compare it against. */
  | 'no-configured-key'
  /** An override exists on a server not in the registry — nothing to compare. */
  | 'not-registered';

export interface StaticHeaderDriftVerdict {
  server: string;
  envKey: string | null;
  status: 'pass' | 'fail' | 'skip';
  reason: StaticHeaderDriftReason;
  /** One-line human summary, safe to print verbatim. Never contains the token. */
  summary: string;
  /**
   * `true`/`false` only when the comparison actually happened. `null` when it
   * could not — and `null` must never be read as `true`.
   */
  matches: boolean | null;
  /** True only when drift is PROVEN, a key exists to install, and this probe owns the heal. */
  autoHealable: boolean;
  /** Set when another probe owns the heal for this entry. */
  healOwner?: string;
}

/** Case-insensitive read of the bearer token out of a headers object. */
export function staticAuthBearer(headers: Record<string, string> | null | undefined): string {
  if (!headers) return '';
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'authorization') continue;
    if (typeof value !== 'string') continue;
    return value.replace(/^Bearer\s+/i, '').trim();
  }
  return '';
}

/** Does this entry carry a non-empty `Authorization` header? */
export function hasStaticAuthHeader(headers: Record<string, string> | null | undefined): boolean {
  return staticAuthBearer(headers) !== '';
}

/**
 * Does the pinned bearer equal the configured key?
 *
 * Returns `null` when the question cannot be answered — no override, or no
 * configured key. The nova classifier's contract, kept verbatim: *never guess,
 * and never treat `null` as `true`.*
 */
export function staticHeaderMatchesConfiguredKey(
  headers: Record<string, string> | null | undefined,
  configuredKey: string | null | undefined,
): boolean | null {
  const pinned = staticAuthBearer(headers);
  const key = (configuredKey ?? '').trim();
  if (!pinned || !key) return null;
  return pinned === key;
}

export interface StaticHeaderDriftInput {
  /** Key under `mcpServers`, e.g. `connect_labs`. */
  serverName: string;
  /** That entry's headers, or `null` when there is no user-scope entry. */
  headers: Record<string, string> | null;
  /** The value ACE has configured for this server, from `.env`. Empty when absent. */
  configuredKey: string;
  /** Registry row, when the server is one ACE knows. */
  spec?: StaticHeaderServerSpec | null;
}

/**
 * Classify ONE user-scope entry.
 *
 * Mirrors `classifyNovaHeaderReadiness`'s drift branch, generalized: the nova
 * classifier's other states (`env-unreadable`, `helper-will-emit-empty`) are
 * properties of nova's env-dependent helper and do not generalize, so they stay
 * where they are.
 */
export function classifyStaticHeaderDrift(input: StaticHeaderDriftInput): StaticHeaderDriftVerdict {
  const { serverName, headers, configuredKey } = input;
  const spec = input.spec ?? STATIC_HEADER_SERVERS.find((s) => s.server === serverName) ?? null;
  const envKey = spec?.envKey ?? null;
  const base = { server: serverName, envKey, healOwner: spec?.healOwner };

  if (!hasStaticAuthHeader(headers)) {
    return {
      ...base,
      status: 'skip',
      reason: 'no-override',
      matches: null,
      autoHealable: false,
      summary:
        `no user-scope ${serverName} entry with a static Authorization header — ` +
        'nothing is pinned, so nothing can go stale',
    };
  }

  if (!spec) {
    return {
      ...base,
      status: 'skip',
      reason: 'not-registered',
      matches: null,
      autoHealable: false,
      summary:
        `the user-scope ${serverName} entry pins a static Authorization header, but ACE has no ` +
        'configured credential for that server — cannot tell whether it is current',
    };
  }

  const matches = staticHeaderMatchesConfiguredKey(headers, configuredKey);

  if (matches === null) {
    return {
      ...base,
      status: 'skip',
      reason: 'no-configured-key',
      matches: null,
      autoHealable: false,
      summary:
        `the user-scope ${serverName} entry pins a static Authorization header, but ${spec.envKey} ` +
        'is not set in ACE .env — cannot compare, and an unanswerable question is never a pass',
    };
  }

  if (matches) {
    return {
      ...base,
      status: 'pass',
      reason: 'matches',
      matches: true,
      autoHealable: false,
      summary:
        `the user-scope ${serverName} entry pins the CURRENT ${spec.envKey} — ` +
        'the session will authenticate with the configured credential',
    };
  }

  return {
    ...base,
    status: 'fail',
    reason: 'drifted',
    matches: false,
    autoHealable: configuredKey.trim() !== '' && !spec.healOwner,
    summary:
      `the user-scope ${serverName} entry pins a Bearer token that is NOT the currently-configured ` +
      `${spec.envKey} — the credential was rotated and the override still carries the old one. ` +
      'A static header is bound at connection time and does not follow a rotation, so every ' +
      'credential on disk reads green while the live connection is rejected',
  };
}

export interface StaticHeaderDriftEntry {
  serverName: string;
  headers: Record<string, string> | null;
  configuredKey: string;
}

export interface StaticHeaderDriftResult {
  verdict: 'pass' | 'fail' | 'skip';
  /** Every entry that was judged, in input order. */
  verdicts: StaticHeaderDriftVerdict[];
  /** The `fail` subset, for convenience at the call site. */
  drifted: StaticHeaderDriftVerdict[];
  reason: string;
}

/**
 * Walk EVERY user-scope entry carrying a static `Authorization` header.
 *
 * The walk is the point. A per-server hand-written branch is what left
 * `connect_labs` uncovered for as long as it took someone to rotate the token
 * (ace#2159), and the next server ACE pins a header for would start uncovered
 * too. `configJsonEntries` is whatever `~/.claude.json` actually holds — the
 * registry only decides what each one is compared AGAINST.
 */
export function classifyAllStaticHeaderDrift(input: {
  entries: StaticHeaderDriftEntry[];
  /** `null` when `~/.claude.json` could not be read — never a pass. */
  configReadable?: boolean;
}): StaticHeaderDriftResult {
  if (input.configReadable === false) {
    return {
      verdict: 'skip',
      verdicts: [],
      drifted: [],
      reason:
        '~/.claude.json could not be read — cannot tell what any MCP entry pins, and ' +
        '"I saw no override" is indistinguishable from "I saw nothing at all"',
    };
  }

  const verdicts = (input.entries ?? []).map((e) =>
    classifyStaticHeaderDrift({
      serverName: e.serverName,
      headers: e.headers,
      configuredKey: e.configuredKey,
    }),
  );

  const drifted = verdicts.filter((v) => v.status === 'fail');
  if (drifted.length > 0) {
    const detail = drifted.map((d) => `${d.server} (vs ${d.envKey})`).join(', ');
    return {
      verdict: 'fail',
      verdicts,
      drifted,
      reason:
        `${drifted.length} user-scope MCP entr${drifted.length === 1 ? 'y pins' : 'ies pin'} a ` +
        `STALE static Authorization header: ${detail}. Those servers will authenticate with a ` +
        'rotated credential — every .env / 1Password check reads green because none of them is ' +
        'what the connection is using.',
    };
  }

  const passed = verdicts.filter((v) => v.status === 'pass');
  if (passed.length > 0) {
    return {
      verdict: 'pass',
      verdicts,
      drifted: [],
      reason: `${passed.length} user-scope static Authorization header(s) match the configured credential`,
    };
  }

  return {
    verdict: 'skip',
    verdicts,
    drifted: [],
    reason:
      'no user-scope MCP entry carries a static Authorization header that ACE has a ' +
      'configured credential to compare against — nothing to judge',
  };
}

/** The remedy for one verdict. Empty when there is nothing to do. */
export function remediationForStaticHeaderDrift(
  verdict: StaticHeaderDriftVerdict,
  opts: { autoHealed?: boolean } = {},
): string {
  switch (verdict.reason) {
    case 'matches':
    case 'no-override':
      return '';
    case 'not-registered':
      return (
        `inspect it yourself: claude mcp get ${verdict.server}  — if it pins a credential ACE ` +
        'rotates, add it to STATIC_HEADER_SERVERS in lib/static-header-drift.ts so this probe ' +
        'can judge it'
      );
    case 'no-configured-key':
      return `run /ace:setup --force-env so ${verdict.envKey} is present, then re-run /ace:doctor`;
    case 'drifted':
      if (verdict.healOwner) {
        return `read the ${verdict.healOwner} block — it owns the heal for this entry and re-points it automatically`;
      }
      return opts.autoHealed
        ? 'the override has been RE-POINTED at the current credential automatically. Cmd-Q + reopen ' +
            'Claude Code so the MCP subprocess rebinds — /ace:update and /reload-plugins do NOT ' +
            'respawn MCP subprocesses, and the header is bound at connection time.'
        : `re-point the override at the current ${verdict.envKey}, then Cmd-Q + reopen Claude Code: ` +
            `claude mcp add --transport http --scope user ${verdict.server} <url> ` +
            "--header 'Authorization: Bearer <CURRENT-TOKEN>'  (adding it again overwrites the entry). " +
            'Removing the entry outright also works when a plugin headersHelper already serves this ' +
            'server — but that is a config choice, so this probe re-points rather than deletes.';
  }
}
