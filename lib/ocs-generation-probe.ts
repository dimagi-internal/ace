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

// ── Retry policy ─────────────────────────────────────────────────────────────

/**
 * How many round-trips the live probe may spend before it reports (ace#1628).
 * Two: one retry, and only for the one transient class.
 */
export const MAX_PROBE_ATTEMPTS = 2;

/**
 * `timeout` is the ONE class that is transient BY CONSTRUCTION: it carries no
 * information about the provider at all, only "nothing came back inside the
 * 25s wall-clock cap", which a cold provider, a slow model, or momentary OCS
 * load all produce. `scripts/doctor-ocs-generation.ts` maps every non-`ok`
 * class to `status: fail`, and `agents/ace-orchestrator.md § Pre-flight
 * Checklist` halts a whole `/ace:run` on `fail` — so one slow first probe used
 * to block a multi-hour run against a provider that was healthy the whole
 * time. Observed on bednet-check-2-visit/20260825-1310: preflight reported
 * `class: timeout` on provider 377, and two immediate re-runs of the same
 * script both returned `pass`.
 *
 * Every other failing class is DEFINITIVE and fails fast — a capped provider
 * errors in ~6s, an auth rejection likewise — so retrying them would only
 * double the latency of a real failure. Hence: retry `timeout`, nothing else.
 *
 * Keeping the decision here (rather than emitting `warn` and teaching the
 * orchestrator which classes halt) keeps the halt/no-halt class table in ONE
 * file.
 */
export function shouldRetryGenerationProbe(
  cls: GenerationProbeClass,
  attemptsSoFar: number,
): boolean {
  if (attemptsSoFar >= MAX_PROBE_ATTEMPTS) return false;
  return cls === 'timeout';
}

/** The verdict `bin/ace-doctor` reports for a probe outcome. */
export type GenerationProbeStatus = 'pass' | 'fail' | 'skip';

/**
 * Map a probe class to the verdict the preflight reports — the HALT/no-halt
 * decision, kept in this file alongside the retry table for the same reason
 * (one place owns the class semantics).
 *
 * `fail` HALTS `/ace:run` before Phase 1 (ace#1516). `skip` explicitly does
 * not: "A `skip` is not a halt; it means the check could not run"
 * (`agents/ace-orchestrator.md` § Pre-flight Step 1).
 *
 * `no_session` is therefore `skip`, not `fail` (ace#1767). A dead or
 * undelivered cookie is evidence about the PROBE, not about OCS generation —
 * the script's own top-level catch already says exactly that ("the probe
 * failed, which is not evidence that OCS did") and then the failure path
 * contradicted it. The cost of getting this backwards is the most expensive
 * shape there is: a false `fail` stops runs that should proceed, and its
 * remediation sends the operator at an LLM provider key that is healthy.
 *
 * Every other non-ok class IS evidence about OCS, and still halts.
 */
export function probeStatusFor(cls: GenerationProbeClass): GenerationProbeStatus {
  if (cls === 'ok') return 'pass';
  if (cls === 'no_session') return 'skip';
  return 'fail';
}

/**
 * Drive a probe round-trip under {@link shouldRetryGenerationProbe}. Pure
 * control flow — the caller supplies the I/O — so the retry behaviour is
 * unit-testable without a live OCS.
 */
export async function runGenerationProbeWithRetry<T extends { class: GenerationProbeClass }>(
  attempt: (attemptNumber: number) => Promise<T>,
): Promise<T> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const result = await attempt(attempts);
    if (!shouldRetryGenerationProbe(result.class, attempts)) return result;
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
