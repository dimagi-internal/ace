/**
 * The Connect organizations this ACE instance acts in — resolved in ONE place.
 *
 * ACE runs Connect on a program-manager / network-manager model (CLAUDE.md
 * § Phases): the PM org creates the program and ACE's own build/QA
 * opportunity; an NM org accepts the program invite and is the org an LLO's
 * opportunity is created under. Which orgs those are is a property of the
 * INSTANCE, not of ACE — another deployment will use its own. Until
 * 2026-09-26 every skill named the PM org as a literal, so there was no way
 * for an instance to say "use mine".
 *
 * Configuration (both optional, read from the installed `.env`):
 *
 *   ACE_CONNECT_PM_ORG   PM org slug. Unset → the legacy default below, so an
 *                        install that has never set it keeps working exactly
 *                        as before.
 *   ACE_CONNECT_NM_ORG   NM org slug. Unset → `null` (not configured). Nothing
 *                        reads it yet; the PM→NM flow change that consumes it
 *                        is a separate follow-up.
 *
 * Neither key is declared in `.env.tpl` (they are documented there COMMENTED),
 * so `bin/ace-setup --force-env` treats them as local-only keys and preserves
 * them across every re-inject — the per-instance value survives re-setup and
 * 1Password never overrides it. See `playbook/integrations/connect-api.md
 * § Which Connect orgs ACE acts in`.
 *
 * What this does NOT govern: an existing opp's program. `opp.yaml.connect.program`
 * records the program's own org (its URL is `/a/<org>/program/...`), and that
 * recorded org stays authoritative for reuse — changing ACE_CONNECT_PM_ORG must
 * never orphan a program an opp already owns.
 *
 * *Enforced:* `test/lib/connect-orgs.test.ts` (resolution),
 * `test/skills/no-hardcoded-connect-org.test.ts` (this file is the only place
 * the legacy slug may appear as a live value).
 */

/** The PM org every ACE install used before orgs were configurable. */
export const LEGACY_DEFAULT_PM_ORG = 'ai-demo-space';

export const PM_ORG_ENV = 'ACE_CONNECT_PM_ORG';
export const NM_ORG_ENV = 'ACE_CONNECT_NM_ORG';

export interface ConnectOrgs {
  /** Slug of the program-manager org (always set — legacy default when unconfigured). */
  pm_org: string;
  /** Slug of the network-manager org, or null when this instance has not configured one. */
  nm_org: string | null;
  source: {
    pm_org: 'env' | 'legacy-default';
    nm_org: 'env' | 'unset';
  };
}

export class ConnectOrgConfigError extends Error {
  constructor(
    readonly key: string,
    readonly value: string,
    reason: string,
  ) {
    super(`${key}=${JSON.stringify(value)} is not a usable Connect org slug: ${reason}`);
    this.name = 'ConnectOrgConfigError';
  }
}

// A Connect org slug is the `<org>` path segment of `/a/<org>/...`. We only
// refuse what could never be that segment (a pasted URL, a path, whitespace,
// quotes) — we do not guess at Connect's own slug rules beyond that.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function read(env: Record<string, string | undefined>, key: string): string | null {
  const raw = env[key];
  if (raw === undefined) return null;
  const v = raw.trim().replace(/^['"]|['"]$/g, '');
  if (v === '') return null;
  // An unresolved 1Password reference is "not configured", not a slug.
  if (v.startsWith('op://')) return null;
  if (!SLUG.test(v)) {
    throw new ConnectOrgConfigError(
      key,
      v,
      v.includes('/') ? 'use the slug from the URL path (the part after /a/), not a URL or path' : 'expected letters, digits, "-" or "_"',
    );
  }
  return v;
}

/**
 * Resolve the configured Connect orgs from an environment map. Pure: pass
 * `process.env`, or a map built from the installed `.env` file.
 *
 * Throws `ConnectOrgConfigError` on a value that cannot be an org slug — a
 * misconfiguration fails loud here rather than as a 404 three phases later.
 */
export function resolveConnectOrgs(env: Record<string, string | undefined>): ConnectOrgs {
  const pm = read(env, PM_ORG_ENV);
  const nm = read(env, NM_ORG_ENV);
  return {
    pm_org: pm ?? LEGACY_DEFAULT_PM_ORG,
    nm_org: nm,
    source: {
      pm_org: pm ? 'env' : 'legacy-default',
      nm_org: nm ? 'env' : 'unset',
    },
  };
}

/** Render the resolution as the `connect_orgs:` block `bin/ace-doctor --preflight` emits. */
export function renderConnectOrgsYaml(env: Record<string, string | undefined>): string {
  try {
    const o = resolveConnectOrgs(env);
    const note =
      o.nm_org === null
        ? 'nm_org unset — not yet consumed; the PM→NM flow change that reads it is a follow-up'
        : 'nm_org configured — not yet consumed; the PM→NM flow change that reads it is a follow-up';
    return [
      'connect_orgs:',
      '  status: ok',
      `  pm_org: "${o.pm_org}"`,
      `  nm_org: ${o.nm_org === null ? 'null' : `"${o.nm_org}"`}`,
      '  source:',
      `    pm_org: ${o.source.pm_org}`,
      `    nm_org: ${o.source.nm_org}`,
      `  note: "${note}"`,
    ].join('\n');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return [
      'connect_orgs:',
      '  status: fail',
      '  pm_org: null',
      '  nm_org: null',
      `  remediation: ${JSON.stringify(`${msg} — fix it in the installed .env (local-only key; /ace:setup --force-env preserves it)`)}`,
    ].join('\n');
  }
}
