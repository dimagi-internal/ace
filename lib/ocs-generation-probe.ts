/**
 * lib/ocs-generation-probe.ts
 *
 * Pure decision logic behind the `ocs_generation` doctor probe
 * (dimagi-internal/ace#1516). No I/O — the live half lives in
 * `scripts/doctor-ocs-generation.ts`, which feeds this module the error text
 * a failed `sendTestMessage` round-trip produced.
 *
 * WHY THIS EXISTS. Until 0.13.x every OCS check in `bin/ace-doctor` was either
 * an env-presence test or a reachability GET (`ocs_shared_collection_team`
 * proves a collection is *reachable*, never that the model behind it can
 * answer). So a dead / exhausted / revoked team LLM provider stayed invisible
 * until Phase 5's quick gate — several hours and five phases into a run. This
 * class has now cost two sessions: ace#743 (revoked key, 2026-06-09) and
 * bednet-check-2-visit/20260817-1720 (usage cap, 2026-08-19).
 *
 * TWO THINGS THAT ARE NOT GUESSABLE and are the reason the classifier is a
 * module rather than a `grep` in shell:
 *
 *  1. **The generation provider is not the one any env var names.** On
 *     `connect-ace`, `OCS_LLM_PROVIDER_ID=378` is "OpenAI for Embeddings";
 *     generation is provider `377`. Embeddings and generation sit on separate
 *     keys — in the 2026-08-19 incident 378 was healthy (8/8 collection files
 *     indexed) while 377 was capped. `pickGenerationProviderId` therefore
 *     DISCOVERS the id from `ocs_inspect_chatbot`'s pipeline nodes; env is
 *     never the answer.
 *  2. **OCS masks the real provider error.** Unless `debug_mode` is on, a
 *     failed generation surfaces as a generic "intermittent error related to
 *     load" fallback (apps/experiments/task_utils.py). The underlying text
 *     lives on the session's trace page, whose URL `RestBackend`'s
 *     `describeSessionTrace` already appends to the thrown error.
 *     `extractTracePointer` recovers it so the remedy names the real cause.
 */

export type GenerationProbeClass =
  | 'ok'
  | 'provider_capped'
  | 'provider_auth'
  | 'no_session'
  | 'no_channel'
  | 'timeout'
  | 'transport'
  | 'unknown';

export interface GenerationClassification {
  class: GenerationProbeClass;
  summary: string;
}

export interface RemediationContext {
  baseUrl?: string | null;
  teamSlug?: string | null;
  providerId?: number | string | null;
  trace?: string | null;
}

/**
 * Ordered regex table. Every pattern is a VERBATIM string observed in the
 * repo or in a recorded incident — never a plausible-sounding paraphrase.
 * Order matters: the capped-provider message arrives as an HTTP 400 body, so
 * it must be tested before the generic auth patterns, and the OCS wrapper
 * text (`sendTestMessage: OCS generation error`) is only consulted last, as
 * the "we know it failed inside generation but not why" fallback.
 */
const RULES: Array<{ re: RegExp; cls: GenerationProbeClass; summary: string }> = [
  {
    // Observed verbatim 2026-08-19 on the fresh clone (traces 862138, 862146)
    // AND on pristine golden template 11792 (trace 862139) — the ace#743
    // quadrant: identical failure on the control proves PLATFORM, not prompt.
    re: /You have reached your specified API usage limits/i,
    cls: 'provider_capped',
    summary: 'team LLM provider has hit its API usage cap — no OCS-dependent phase can pass',
  },
  {
    // ace#743, 2026-06-09: a revoked team provider key. The trace page said
    // `401 invalid x-api-key`; OCS itself said "intermittent load".
    re: /invalid x-api-key|authentication_error|\binvalid[_ ]api[_ ]key\b|\b401\b/i,
    cls: 'provider_auth',
    summary: 'team LLM provider key rejected (401 / invalid key) — the key is revoked or wrong',
  },
  {
    // mcp/ocs/backends/playwright.ts getChatbotEmbedInfo — a clone that
    // skipped channel creation, or a chatbot with no widget channel at all.
    re: /No EMBEDDED_WIDGET channel found/i,
    cls: 'no_channel',
    summary: 'chatbot has no EMBEDDED_WIDGET channel — the widget path cannot be exercised',
  },
  {
    // mcp/ocs/backends/rest.ts sendTestMessage poll deadline, and the probe's
    // own hard wall-clock cap.
    re: /timed out after \d+s|\bETIMEDOUT\b|probe wall-clock cap/i,
    cls: 'timeout',
    summary: 'generation did not return before the probe deadline',
  },
  {
    // Cookie session dead: OCS bounces to the login form.
    re: /accounts\/login|session expired|not authenticated|sessionid.*missing/i,
    cls: 'no_session',
    summary: 'OCS session cookies are missing or expired — no live probe possible',
  },
  {
    re: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|ECONNRESET|getaddrinfo/i,
    cls: 'transport',
    summary: 'could not reach OCS (network / DNS / TLS)',
  },
];

/** The OCS wrapper text — present on every generation failure, so it can only
 *  ever mean "unknown" once every inner rule above has missed. */
const OCS_WRAPPER = /sendTestMessage: OCS generation error/i;

export function classifyGenerationFailure(errText: string): GenerationClassification {
  const text = (errText ?? '').toString();
  if (!text.trim()) {
    return { class: 'unknown', summary: 'generation failed with no error text' };
  }
  for (const rule of RULES) {
    if (rule.re.test(text)) return { class: rule.cls, summary: rule.summary };
  }
  if (OCS_WRAPPER.test(text)) {
    return {
      class: 'unknown',
      summary: 'OCS reported a generation error with no recognised provider cause',
    };
  }
  return { class: 'unknown', summary: 'generation failed for an unrecognised reason' };
}

/**
 * Recover the trace URL from the `[session …; underlying trace: <url> …]`
 * suffix that `RestBackend.describeSessionTrace` appends. Returns null when
 * the suffix is absent (enrichment is best-effort and returns '' on failure).
 */
export function extractTracePointer(errText: string): string | null {
  const m = /underlying trace:\s*(\S+)/i.exec((errText ?? '').toString());
  if (!m) return null;
  // Strip trailing punctuation the surrounding prose can glue on.
  return m[1].replace(/[),.;\]]+$/, '') || null;
}

export function remediationFor(cls: GenerationProbeClass, ctx: RemediationContext = {}): string {
  const base = (ctx.baseUrl ?? '').toString().replace(/\/+$/, '');
  const team = (ctx.teamSlug ?? '').toString();
  const pid = ctx.providerId == null || ctx.providerId === '' ? null : String(ctx.providerId);
  const providerUrl =
    base && team && pid ? `${base}/a/${team}/service_providers/llm/${pid}/` : null;
  const traceHint = ctx.trace ? ` Underlying provider error: ${ctx.trace} (team login).` : '';

  switch (cls) {
    case 'ok':
      return '';
    case 'provider_capped':
      return (
        `the team's GENERATION provider is capped (this is NOT the embeddings provider ` +
        `OCS_LLM_PROVIDER_ID names). Raise the limit or swap the key on ` +
        `${providerUrl ?? '<ocs>/a/<team>/service_providers/llm/<pk>/'}; the key itself lives in ` +
        `1Password vault Agent-Ace. Then re-run /ace:run — no Claude restart needed.` +
        traceHint
      );
    case 'provider_auth':
      return (
        `the team's GENERATION provider key is rejected (revoked/rotated). Replace it at ` +
        `${providerUrl ?? '<ocs>/a/<team>/service_providers/llm/<pk>/'} from the 1Password vault ` +
        `Agent-Ace item, then re-run /ace:run — no Claude restart needed.` +
        traceHint
      );
    case 'no_channel':
      return (
        `golden template ${team ? `on team ${team} ` : ''}has no EMBEDDED_WIDGET channel — ` +
        `re-run /ace:ocs-bootstrap-template to rebuild it.`
      );
    case 'no_session':
      return '/ace:ocs-login (or set OCS_USERNAME/OCS_PASSWORD in .env for headless auto-login)';
    case 'timeout':
      return (
        `OCS accepted the message but produced nothing in time. Check the provider at ` +
        `${providerUrl ?? '<ocs>/a/<team>/service_providers/llm/<pk>/'} and OCS status before ` +
        `starting a run.` + traceHint
      );
    case 'transport':
      return `verify ${base || '$OCS_BASE_URL'} is reachable from this network (VPN/proxy/DNS)`;
    case 'unknown':
    default:
      return (
        `open the session trace to read the real provider error — OCS masks it behind an ` +
        `"intermittent load" fallback unless debug_mode is on (ace#743).` + traceHint
      );
  }
}

// ── Generation-provider discovery ────────────────────────────────────────────

interface NodeLike {
  type?: unknown;
  llm?: unknown;
}

interface InspectLike {
  pipeline?: { nodes?: unknown } | null;
}

function coerceProviderId(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * First `pipeline.nodes[].llm.provider_id` on a node whose `type` contains
 * "LLM" (e.g. `LLMResponseWithPrompt`). Returns null when the shape doesn't
 * carry one.
 *
 * This is the load-bearing half of the probe's remedy line: env's
 * `OCS_LLM_PROVIDER_ID` is the EMBEDDINGS provider, so naming it in a
 * generation failure sends the operator to the wrong `/service_providers/llm/`
 * page — the exact wrong turn ace#1516's triage recorded.
 */
export function pickGenerationProviderId(inspect: unknown): number | null {
  const nodes = (inspect as InspectLike | null | undefined)?.pipeline?.nodes;
  if (!Array.isArray(nodes)) return null;
  for (const raw of nodes as NodeLike[]) {
    const type = typeof raw?.type === 'string' ? raw.type : '';
    if (!/llm/i.test(type)) continue;
    const llm = raw?.llm as Record<string, unknown> | null | undefined;
    if (!llm || typeof llm !== 'object') continue;
    const pid = coerceProviderId(llm.provider_id);
    if (pid != null) return pid;
  }
  return null;
}
