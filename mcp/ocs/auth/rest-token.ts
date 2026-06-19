export function loadRestToken(): string {
  return process.env.OCS_API_TOKEN ?? '';
}

export function loadBaseUrl(): string {
  return process.env.OCS_BASE_URL ?? 'https://www.openchatstudio.com';
}

export function loadDefaultTeamSlug(): string {
  return process.env.OCS_TEAM_SLUG ?? '';
}

/**
 * Build a `team_slug → token` registry from environment.
 *
 * Pattern: every `OCS_API_TOKEN_<KEY>` env var becomes a registry entry under
 * a slug derived from `<KEY>`. Slug recovery is best-effort — we treat the
 * suffix as the canonical-case slug, plus an uppercase alias, so both the
 * REST API's returned `slug` (e.g. `Vaccine_Coach`) and a caller passing
 * `VACCINE_COACH` resolve to the same token. If both forms differ, both keys
 * are populated.
 *
 * The default token (`OCS_API_TOKEN`) is NOT included here — `resolveToken()`
 * short-circuits to `opts.token` when the requested slug matches
 * `opts.defaultTeamSlug`. We exclude it to avoid the false positive of a
 * second key colliding with the default name.
 *
 * Returns an empty Map when no `OCS_API_TOKEN_*` env vars are set (which is
 * the existing single-tenant case — no behaviour change).
 */
export function loadTokensByTeam(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const out = new Map<string, string>();
  const prefix = 'OCS_API_TOKEN_';
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(prefix)) continue;
    if (!value) continue;
    const suffix = name.slice(prefix.length); // e.g. "VACCINE_COACH"
    if (!suffix) continue;
    out.set(suffix, value);
    // The OCS slug field returned by /api/v2/me/.team.slug preserves case
    // (e.g. "Vaccine_Coach"). We populate both the uppercase env-name form
    // and a best-effort title-cased form so callers passing either resolve.
    // The title-case heuristic upper-cases the first char of each underscore-
    // separated segment ("VACCINE_COACH" → "Vaccine_Coach"). Imperfect for
    // teams whose actual slug has mixed-case beyond the first letter, but
    // those callers can pass the env-name form to be explicit.
    const titled = suffix
      .toLowerCase()
      .split('_')
      .map((seg) => (seg.length ? seg[0].toUpperCase() + seg.slice(1) : seg))
      .join('_');
    if (titled !== suffix) out.set(titled, value);
  }
  return out;
}
