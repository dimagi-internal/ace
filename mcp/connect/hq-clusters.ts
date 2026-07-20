/**
 * HQ cluster registry — lets the ace-connect MCP hold live connections to
 * MULTIPLE CommCare HQ servers (US `www`, EU `eu`, India `india`) at the same
 * time, and route each `commcare_*` atom to a chosen server via an explicit
 * `server` argument (default = `ACE_HQ_DEFAULT_SERVER`).
 *
 * This module is PURE config parsing — no I/O, no sessions. The server bootstrap
 * (`connect-server.ts`) turns each `HqClusterConfig` into a live `CommCareBackend`
 * in a registry keyed by server; atoms resolve their backend from that registry.
 *
 * ## Env shape
 * Per-cluster blocks (preferred going forward):
 *   ACE_HQ_US_BASE_URL / ACE_HQ_US_USERNAME / ACE_HQ_US_PASSWORD / ACE_HQ_US_API_KEY / ACE_HQ_US_DOMAIN
 *   ACE_HQ_EU_BASE_URL / ACE_HQ_EU_USERNAME / ... etc.
 *   ACE_HQ_DEFAULT_SERVER=eu
 *
 * Legacy single-cluster block (back-compat — what every existing install has):
 *   ACE_HQ_BASE_URL / ACE_HQ_USERNAME / ACE_HQ_PASSWORD / ACE_HQ_API_KEY / ACE_HQ_DOMAIN
 * These are folded into the cluster inferred from `ACE_HQ_BASE_URL`
 * (`www`→us, `eu`→eu, `india`→india), which also becomes the default server
 * when `ACE_HQ_DEFAULT_SERVER` is unset — so a stock US-only `.env` keeps
 * resolving to exactly one `us` cluster with no behavior change.
 */

export type HqServer = string; // 'us' | 'eu' | 'india' | ...

export interface HqClusterConfig {
  /** Canonical short name, lowercased (e.g. 'us', 'eu'). */
  server: HqServer;
  /** e.g. https://www.commcarehq.org */
  baseUrl: string;
  username?: string;
  password?: string;
  apiKey?: string;
  /** Default home project space (domain) on this cluster, if configured. */
  domain?: string;
}

/** Well-known cluster → base URL, used when a block omits its base URL. */
export const KNOWN_HQ_BASE_URLS: Record<string, string> = {
  us: 'https://www.commcarehq.org',
  eu: 'https://eu.commcarehq.org',
  india: 'https://india.commcarehq.org',
};

/** Infer the cluster short-name from a CommCare HQ base URL. */
export function inferServerFromBaseUrl(baseUrl: string | undefined): HqServer {
  if (!baseUrl) return 'us';
  const h = baseUrl.toLowerCase();
  if (h.includes('eu.commcare')) return 'eu';
  if (h.includes('india.commcare')) return 'india';
  return 'us';
}

export class HqClusterNotConfiguredError extends Error {
  constructor(public readonly server: HqServer, public readonly known: HqServer[]) {
    super(
      `No CommCare HQ cluster configured for server="${server}". ` +
        `Configured servers: [${known.join(', ') || '(none)'}]. ` +
        `Add ACE_HQ_${server.toUpperCase()}_{BASE_URL,USERNAME,API_KEY} to the plugin .env ` +
        `(1Password: item "ACE - CommCareHQ ${server.toUpperCase()}"), or pass a configured server.`,
    );
    this.name = 'HqClusterNotConfiguredError';
  }
}

export interface HqClusterRegistry {
  clusters: Map<HqServer, HqClusterConfig>;
  defaultServer: HqServer;
  /** Resolve a cluster by server (defaults to `defaultServer`). Throws if absent. */
  get(server?: HqServer): HqClusterConfig;
  /** All configured server short-names, in insertion order. */
  servers(): HqServer[];
}

const PER_CLUSTER_KEY = /^ACE_HQ_([A-Z0-9]+)_(BASE_URL|USERNAME|PASSWORD|API_KEY|DOMAIN)$/;

function applyField(c: HqClusterConfig, field: string, value: string): void {
  switch (field) {
    case 'BASE_URL': c.baseUrl = value; break;
    case 'USERNAME': c.username = value; break;
    case 'PASSWORD': c.password = value; break;
    case 'API_KEY': c.apiKey = value; break;
    case 'DOMAIN': c.domain = value; break;
  }
}

/**
 * Build the cluster registry from an env bag. Pure — deterministic given `env`.
 */
export function buildHqClusterRegistry(
  env: Record<string, string | undefined>,
): HqClusterRegistry {
  const clusters = new Map<HqServer, HqClusterConfig>();
  const ensure = (server: HqServer): HqClusterConfig => {
    const s = server.toLowerCase();
    let c = clusters.get(s);
    if (!c) { c = { server: s, baseUrl: KNOWN_HQ_BASE_URLS[s] ?? '' }; clusters.set(s, c); }
    return c;
  };

  // 1. Per-cluster blocks (ACE_HQ_<SERVER>_<FIELD>).
  for (const [k, v] of Object.entries(env)) {
    if (v == null || v === '') continue;
    const m = PER_CLUSTER_KEY.exec(k);
    if (!m) continue;
    // 'DEFAULT' is not a cluster (ACE_HQ_DEFAULT_SERVER is handled below and
    // does not match this regex anyway); guard defensively.
    if (m[1] === 'DEFAULT') continue;
    applyField(ensure(m[1].toLowerCase()), m[2], v);
  }

  // 2. Legacy bare ACE_HQ_* → folded into the inferred cluster (fills only
  //    fields a per-cluster block didn't already set, so explicit blocks win).
  const bare = {
    BASE_URL: env.ACE_HQ_BASE_URL,
    USERNAME: env.ACE_HQ_USERNAME,
    PASSWORD: env.ACE_HQ_PASSWORD,
    API_KEY: env.ACE_HQ_API_KEY,
    DOMAIN: env.ACE_HQ_DOMAIN,
  };
  const hasBare = Object.values(bare).some((x) => x != null && x !== '');
  let bareServer: HqServer | undefined;
  if (hasBare) {
    bareServer = inferServerFromBaseUrl(bare.BASE_URL);
    const c = ensure(bareServer);
    for (const [field, value] of Object.entries(bare)) {
      if (value == null || value === '') continue;
      // explicit per-cluster block wins: only fill if unset
      const cur = ({ BASE_URL: c.baseUrl, USERNAME: c.username, PASSWORD: c.password, API_KEY: c.apiKey, DOMAIN: c.domain } as Record<string, string | undefined>)[field];
      // baseUrl always has a KNOWN default; treat a KNOWN-default baseUrl as "unset" so bare can override it
      const isDefaulted = field === 'BASE_URL' && cur === KNOWN_HQ_BASE_URLS[bareServer];
      if (cur == null || cur === '' || isDefaulted) applyField(c, field, value);
    }
  }

  // 3. Default server: explicit ACE_HQ_DEFAULT_SERVER, else the bare-inferred
  //    cluster, else the first configured cluster, else 'us'.
  const explicitDefault = env.ACE_HQ_DEFAULT_SERVER?.trim().toLowerCase();
  const firstServer = clusters.keys().next().value as HqServer | undefined;
  const defaultServer = (explicitDefault && explicitDefault.length ? explicitDefault : undefined)
    ?? bareServer
    ?? firstServer
    ?? 'us';

  // Guarantee the default cluster exists (so a bare-less, block-less env still
  // yields a usable US cluster with the known default base URL).
  if (!clusters.has(defaultServer)) ensure(defaultServer);

  return {
    clusters,
    defaultServer,
    servers: () => [...clusters.keys()],
    get(server?: HqServer): HqClusterConfig {
      const key = (server ?? defaultServer).toLowerCase();
      const c = clusters.get(key);
      if (!c) throw new HqClusterNotConfiguredError(key, [...clusters.keys()]);
      return c;
    },
  };
}
