/**
 * lib/nova-scope-probe.ts
 *
 * Pure decision logic behind the `nova_scopes` doctor probe (ace#174 — the
 * oldest open issue in the repo, filed 2026-05-08).
 *
 * WHAT IT ANSWERS, AND WHAT IT DOES NOT. `nova_auth` POSTs `initialize` and
 * reports PASS on any 2xx. That proves the transport accepted the bearer; it
 * proves nothing about the per-tool scopes ACE's Phase 3 actually spends its
 * budget on. The motivating miss (`turmeric/20260508-1951`) halted at
 * `app-deploy` with `error_type: scope_missing, required_scope: nova.hq.read`
 * on `get_hq_connection`, with `nova_auth` green the whole time — after Phase 1
 * and the first step of Phase 3 had already run.
 *
 * So this classifier reads the answer to a real `tools/call get_hq_connection`
 * and reports what the KEY can do. `get_hq_connection` is the cheapest call
 * that exercises `nova.hq.read`, and its `configured` flag doubles as the
 * answer to "is an HQ key actually bound in Nova's settings" — the second way
 * `upload_app_to_hq` fails late.
 *
 * ── The observed response shapes (measured 2026-09-06, not predicted) ──────
 *
 * Nova answers `tools/call` as an SSE frame even for a plain JSON request, and
 * the tool's own payload is a JSON STRING inside `result.content[0].text`:
 *
 *   $ curl -s -X POST https://mcp.commcare.app/mcp -H "Authorization: Bearer $NOVA_API_KEY" \
 *       -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
 *       -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
 *            "params":{"name":"get_hq_connection","arguments":{}}}'
 *   event: message
 *   data: {"result":{"content":[{"type":"text","text":"{\"configured\":true,\"server\":\"production\",
 *          \"server_url\":\"https://www.commcarehq.org\",\"available_domains\":[{\"name\":\"connect-ace-prod\",…}]}"}]},
 *          "jsonrpc":"2.0","id":1}
 *
 * A bad bearer is a plain-JSON 401, NOT an SSE frame:
 *
 *   HTTP 401  {"jsonrpc":"2.0","error":{"code":-32000,"message":"no token payload"},"id":null}
 *
 * An unknown tool comes back as a JSON-RPC error inside an SSE frame:
 *
 *   event: message
 *   data: {"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Tool no_such_tool_xyz not found"}}
 *
 * The `scope_missing` shape is quoted from the two places ACE has recorded it
 * live — `turmeric/20260508-1951`'s halt and `bednet-check-2-visit/20260823-2210`
 * session A, both transcribed in ace#174 — rather than invented here: the tool
 * answers with `error_type: scope_missing` and `required_scope: nova.hq.read`.
 * Both a JSON-RPC error and a tool-payload carrying those keys are accepted,
 * because ACE has only ever seen the string, never the envelope.
 *
 * ── The rule this probe must NOT break (ace#174, comment 3) ───────────────
 *
 * A green `nova_scopes` does NOT mean Nova is usable in THIS session. Doctor is
 * a subprocess calling the MCP endpoint with `$NOVA_API_KEY` directly; the
 * credential Claude Code's own MCP connection bound is a different question,
 * and answering it is `nova_header_readiness`'s job. That was measured: on
 * `bednet-check-2-visit/20260823-2210` the exact curl this probe makes returned
 * `configured:true` while the in-session connection was unusable. Every verdict
 * therefore carries an explicit `scope` line, the same way
 * `nova_needs_auth_cache` does.
 *
 * No I/O here — `scripts/doctor-nova-scopes.ts` makes the call and feeds the
 * result in.
 */

export type NovaScopeStatus = 'pass' | 'warn' | 'fail' | 'skip';

export type NovaScopeReason =
  | 'hq-read-granted'
  | 'no-hq-key-bound'
  | 'scope-missing'
  | 'auth-failed'
  | 'unreachable'
  | 'unexpected-response'
  | 'no-key-configured';

export interface NovaScopeVerdict {
  status: NovaScopeStatus;
  reason: NovaScopeReason;
  /** One line, safe to print next to `nova_scopes:`. Never contains the key. */
  summary: string;
  /** What to do about it. Empty on `pass`. */
  remediation: string;
  /** What this probe can and cannot conclude — printed on EVERY verdict. */
  scope: string;
  /** Whether Nova reports an HQ API key bound in its settings. */
  configured: boolean | null;
  /** HQ project spaces Nova can see with this key. Empty when unknown. */
  domains: string[];
  /** The scope Nova named as missing, when it named one. */
  requiredScope: string | null;
}

/** Printed on every verdict — see the header's "rule this probe must NOT break". */
export const NOVA_SCOPES_SCOPE_LINE =
  'the CONFIGURED NOVA_API_KEY called from a doctor subprocess; says nothing about ' +
  'which credential this Claude Code session bound (see nova_header_readiness, ace#174)';

/**
 * Pull the tool's own payload out of whatever Nova wrapped it in. Returns the
 * decoded object, the JSON-RPC error object, or null when neither is present.
 *
 * Deliberately tolerant of BOTH the SSE framing and a bare JSON body: the 401
 * arrives unframed, and a probe that only understood SSE would report the
 * auth failure as `unexpected-response`.
 */
function extractPayload(body: string): { tool: unknown; rpcError: unknown } {
  const candidates: string[] = [];
  for (const line of (body ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('data:')) candidates.push(t.slice(5).trim());
    else if (t.startsWith('{')) candidates.push(t);
  }
  let tool: unknown = null;
  let rpcError: unknown = null;
  for (const c of candidates) {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(c) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (frame.error && !rpcError) rpcError = frame.error;
    const result = frame.result as { content?: Array<{ text?: string }> } | undefined;
    const text = result?.content?.[0]?.text;
    if (typeof text === 'string' && tool == null) {
      try {
        tool = JSON.parse(text);
      } catch {
        // A tool that answered with prose rather than JSON. Keep the string so
        // the scope_missing scan below can still see it.
        tool = { raw: text };
      }
    }
  }
  return { tool, rpcError };
}

function textOf(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * Classify one `tools/call get_hq_connection` response.
 *
 * `httpStatus` is null when the request never completed (DNS, timeout, proxy).
 * `keyConfigured: false` short-circuits to `skip` — same pattern as the
 * existing `nova_auth` probe, which is silent when there is no key to test.
 */
export function classifyNovaScopeProbe(args: {
  keyConfigured: boolean;
  httpStatus: number | null;
  body: string;
  /** `ACE_HQ_DOMAIN`, when configured — checked against `available_domains`. */
  expectedDomain?: string;
}): NovaScopeVerdict {
  const { keyConfigured, httpStatus, body, expectedDomain } = args;
  const base = { scope: NOVA_SCOPES_SCOPE_LINE, configured: null, domains: [], requiredScope: null };

  if (!keyConfigured) {
    return {
      ...base,
      status: 'skip',
      reason: 'no-key-configured',
      summary: 'skipped — NOVA_API_KEY not set',
      remediation:
        'mint at https://commcare.app/settings as the ACE Gmail identity, save to 1Password item ' +
        '"ACE - Nova" / field `api_key`, then /ace:setup --force-env',
    };
  }

  if (httpStatus == null) {
    return {
      ...base,
      status: 'warn',
      reason: 'unreachable',
      summary: 'could not reach https://mcp.commcare.app/mcp (network/DNS/timeout)',
      remediation: 'check VPN/proxy; the net_nova_mcp and nova_auth probes should also flag this',
    };
  }

  const { tool, rpcError } = extractPayload(body);
  const haystack = `${textOf(tool)} ${textOf(rpcError)}`;

  // Scope refusal first: Nova can answer 200 with a scope error in the tool
  // payload, so branching on the HTTP status alone would miss the entire
  // failure mode this probe exists for.
  if (/scope_missing/.test(haystack)) {
    const m = haystack.match(/required_scope\\?"?\s*[:=]\s*\\?"?([a-z0-9_.]+)/i);
    const required = m ? m[1] : 'nova.hq.read';
    return {
      ...base,
      status: 'fail',
      reason: 'scope-missing',
      requiredScope: required,
      summary: `NOVA_API_KEY is accepted but lacks ${required} — get_hq_connection refused`,
      remediation:
        `grant HQ Read AND HQ Write at https://commcare.app/settings → API tokens (Phase 3 needs ` +
        `both: ${required} for get_hq_connection, HQ Write for upload_app_to_hq), then ` +
        `/ace:setup --force-env and RESTART Claude Code. If the key demonstrably HAS the scope ` +
        `(this probe is a curl, not the session), you are on OAuth rather than the PAT — read ` +
        `nova_header_readiness, which outranks this line`,
    };
  }

  if (httpStatus === 401 || httpStatus === 403 || /no token payload|invalid token|unauthor/i.test(haystack)) {
    return {
      ...base,
      status: 'fail',
      reason: 'auth-failed',
      summary: `bearer rejected (HTTP ${httpStatus}) — NOVA_API_KEY invalid or revoked`,
      remediation:
        'rotate at https://commcare.app/settings, update 1Password item "ACE - Nova" / field ' +
        '`api_key`, then /ace:setup --force-env. nova_auth above reports the same fact',
    };
  }

  const payload = (tool ?? {}) as { configured?: unknown; available_domains?: unknown };
  if (payload.configured === true) {
    const domains = Array.isArray(payload.available_domains)
      ? (payload.available_domains as Array<{ name?: unknown }>)
          .map((d) => (typeof d === 'string' ? d : String(d?.name ?? '')))
          .filter(Boolean)
      : [];
    const domainNote = domains.length ? `${domains.length} HQ domain(s) visible` : 'no domains listed';
    if (expectedDomain && domains.length && !domains.includes(expectedDomain)) {
      return {
        ...base,
        status: 'warn',
        reason: 'hq-read-granted',
        configured: true,
        domains,
        summary:
          `HQ Read granted (${domainNote}) but ACE_HQ_DOMAIN "${expectedDomain}" is NOT among them`,
        remediation:
          `Nova cannot upload to a project space it cannot see, so app-deploy will fail late. ` +
          `Either add the Nova identity to "${expectedDomain}" on CommCare HQ, or correct ` +
          `ACE_HQ_DOMAIN (visible: ${domains.join(', ')}) in 1Password and re-run /ace:setup --force-env`,
      };
    }
    return {
      ...base,
      status: 'pass',
      reason: 'hq-read-granted',
      configured: true,
      domains,
      summary:
        `HQ Read scope granted; an HQ key is bound in Nova (${domainNote}` +
        (expectedDomain && domains.includes(expectedDomain) ? `, incl. ${expectedDomain}` : '') +
        ')',
      remediation: '',
    };
  }

  if (payload.configured === false) {
    return {
      ...base,
      status: 'warn',
      reason: 'no-hq-key-bound',
      configured: false,
      summary: 'HQ Read scope granted, but NO HQ API key is bound in Nova settings',
      remediation:
        'paste a CommCare HQ API key at https://commcare.app/settings before /ace:run — ' +
        'Phase 3 app-deploy (upload_app_to_hq) has nothing to upload through until it is there',
    };
  }

  return {
    ...base,
    status: 'warn',
    reason: 'unexpected-response',
    summary:
      `unexpected response from get_hq_connection (HTTP ${httpStatus})` +
      (rpcError ? `: ${textOf(rpcError).slice(0, 160)}` : ''),
    remediation:
      'investigate Nova MCP health — curl the endpoint directly (the call is in ' +
      'lib/nova-scope-probe.ts) and compare against playbook/integrations/nova-integration.md',
  };
}
