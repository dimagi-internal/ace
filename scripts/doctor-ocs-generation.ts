/**
 * scripts/doctor-ocs-generation.ts
 *
 * The LIVE half of the `ocs_generation` probe (dimagi-internal/ace#1516).
 * Asks OCS to generate ONE token through the golden template's widget path
 * and reports whether the team's GENERATION provider can actually answer.
 *
 * Backing dispatcher for two surfaces in `bin/ace-doctor`:
 *   --format=yaml   → the `ocs_generation:` block in the --preflight snapshot
 *                     (this is the one that fixes the TIMING: it runs before
 *                     Phase 1, not at Phase 5)
 *   --format=lines  → PASS/WARN lines for the human [Auth liveness] block
 *
 * Why a tsx script rather than a `curl` next to `ocs_shared_collection_team`:
 * the widget round-trip needs `public_id` + `embed_key`, and
 * `getChatbotEmbedInfo` is a Playwright-backed atom that scrapes the chatbot
 * home page and the channel edit-dialog. Re-deriving that handshake in shell
 * is exactly the "don't locally reimplement what the shared engine already
 * provides" trap that produced ace#1338 — so we reuse the real backends.
 *
 * That reuse was HALF DONE until ace#1767. The probe took `CompositeBackend`
 * and `PlaywrightBackend` but hand-rolled the one part that owns AUTH — a bare
 * `chromium.newContext({ storageState })`. Playwright silently DROPS a cookie
 * whose local `expires` stamp has passed, so the context went out anonymous
 * while the server-side session was still perfectly valid; OCS 302'd to
 * `/accounts/login/`, the transport followed it, the scrape ran against the
 * sign-in HTML, and the probe reported `status: fail, class: unknown` blaming
 * `flag_chat_widget`. `fail` HALTS `/ace:run` before Phase 1 (ace#1516), so a
 * healthy provider stopped a multi-hour run and sent the operator at a key
 * that was fine.
 *
 * `PlaywrightSession` already owned both missing halves — an
 * `isAuthenticated()` that probes with `maxRedirects: 0` (its comment says
 * that is load-bearing precisely so the 302→login→200 chain cannot read as
 * authenticated) and credential auto-relogin that re-persists the state. The
 * MCP server has healed itself from this all along; only the probe diverged.
 * So: no hand-rolled context here. Ever.
 *
 * Exit status: ALWAYS 0. A probe that crashes must never take doctor down
 * (same convention as scripts/doctor-drive-layout.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import {
  classifyGenerationFailure,
  extractTracePointer,
  pickGenerationProviderId,
  probeStatusFor,
  remediationFor,
  runGenerationProbeWithRetry,
  type GenerationProbeClass,
} from '../lib/ocs-generation-probe.js';

// ── The hard cap, PER ATTEMPT. rest.ts polls to a 120s deadline, which is far
// too slow for a preflight that runs on every /ace:run; a capped provider
// errors in ~6s.
// Keep this well under 30s — test/scripts/doctor-ocs-generation.test.ts gates
// it, because a preflight that can hang for two minutes gets removed rather
// than fixed.
//
// A `timeout` classification — and ONLY that one — is retried once before the
// probe reports (see lib/ocs-generation-probe.ts § Retry policy, ace#1628), so
// the worst case is two caps (~50s) and only on the already-bad path. Every
// definitive class fails fast and is never retried, so the common case and the
// real-failure case are both unchanged.
const PROBE_TIMEOUT_MS = 25_000;

type Status = 'pass' | 'fail' | 'skip';

interface Result {
  status: Status;
  class: GenerationProbeClass;
  summary: string;
  providerId: number | null;
  trace: string | null;
  detail: string;
  remediation: string;
}

/**
 * Hand-rolled .env read — the same shape scripts/probe-composite-list.ts uses,
 * and deliberately NOT `dotenv.config()`. dotenv/dotenvx writes an "injected
 * env (43) from …" banner to STDOUT, and this script's stdout IS the
 * `ocs_generation:` block that gets spliced into the preflight YAML: one
 * banner line and the orchestrator's snapshot stops parsing. Caught live
 * before merge — the yaml format is machine-facing, so there is no human to
 * notice the extra line.
 */
function loadEnv(): void {
  const dataDir = resolvePluginDataDir(import.meta.url);
  const candidates: string[] = [];
  if (dataDir) candidates.push(path.join(dataDir, '.env'));
  candidates.push(path.join(process.env.HOME || '', '.claude/plugins/data/ace-ace/.env'));
  candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'));
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      const key = m[1];
      if (process.env[key] !== undefined && process.env[key] !== '') continue;
      const value = m[2].trim().replace(/^['"]|['"]$/g, '');
      // Unresolved 1Password refs are "missing", not a literal value.
      if (value.startsWith('op://')) continue;
      process.env[key] = value;
    }
  }
}

function yamlEscape(s: string): string {
  return (s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ').trim();
}

function emit(result: Result, format: string): void {
  if (format === 'yaml') {
    console.log('ocs_generation:');
    console.log(`  status: ${result.status}`);
    console.log(`  class: ${result.class}`);
    console.log(`  provider_id: ${result.providerId ?? 'null'}`);
    console.log(`  trace: "${yamlEscape(result.trace ?? '')}"`);
    console.log(`  detail: "${yamlEscape(result.detail)}"`);
    console.log(`  remediation: "${yamlEscape(result.remediation)}"`);
    return;
  }
  // lines — printed verbatim by bin/ace-doctor, so it must match the
  // pass()/warn() output shape exactly (the end-of-run summary greps ^PASS/^WARN).
  const pid = result.providerId != null ? ` (generation provider ${result.providerId})` : '';
  if (result.status === 'pass') {
    console.log(`PASS ocs_generation: OCS generated a live response${pid}`);
    return;
  }
  if (result.status === 'skip') {
    // SKIP is not a doctor verb; the [Auth liveness] block already WARNs about
    // the missing precondition (ocs_auth), so stay quiet rather than
    // double-reporting it. Print an INFO so the operator can see we looked.
    console.log(`INFO ocs_generation: skipped — ${result.summary}`);
    return;
  }
  // Runtime-health checks are WARN, not FAIL, in the human block (see
  // bin/ace-doctor's standing convention); the PREFLIGHT yaml is where this
  // reports `fail`, because that is what the orchestrator halts on.
  console.log(`WARN ocs_generation: ${result.summary}${pid}`);
  if (result.detail) console.log(`  detail: ${result.detail}`);
  if (result.remediation) console.log(`  fix: ${result.remediation}`);
}

function skip(summary: string): Result {
  return {
    status: 'skip',
    class: 'no_session',
    summary,
    providerId: null,
    trace: null,
    detail: '',
    remediation: remediationFor('no_session'),
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: timed out after ${Math.round(ms / 1000)}s (probe wall-clock cap)`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probe(): Promise<Result> {
  const baseUrl = (process.env.OCS_BASE_URL || '').replace(/\/+$/, '');
  const team = process.env.OCS_TEAM_SLUG || '';
  const gtid = process.env.OCS_GOLDEN_TEMPLATE_ID || '';
  const token = process.env.OCS_API_TOKEN || '';

  if (!baseUrl || !team) return skip('OCS_BASE_URL or OCS_TEAM_SLUG not set in .env');
  if (!gtid) return skip('OCS_GOLDEN_TEMPLATE_ID not set in .env');
  if (!token) return skip('OCS_API_TOKEN not set in .env');

  const { defaultStateDir } = await import('../mcp/lib/playwright-session.js');
  const { PlaywrightSession } = await import('../mcp/ocs/auth/playwright-session.js');

  const username = process.env.OCS_USERNAME;
  const password = process.env.OCS_PASSWORD;
  const sessionFile = path.join(defaultStateDir(), `ocs-session-${team}.json`);
  // Guard BEFORE launching chromium — a missing session is already reported by
  // ocs_auth, and paying a browser launch to re-report it is pure latency on
  // every /ace:run preflight.
  //
  // Only when there is nothing to recover WITH, though: with credentials set,
  // PlaywrightSession logs in and writes the state, which is a heal rather
  // than a wasted launch. Skipping there would decline to fix the very thing
  // the operator is about to be told to fix by hand.
  if (!fs.existsSync(sessionFile) && !(username && password)) {
    return skip(`${sessionFile} missing and OCS_USERNAME/OCS_PASSWORD unset — no live probe possible`);
  }

  const session = new PlaywrightSession({ baseUrl, teamSlug: team, username, password });
  try {
    let ctx;
    try {
      // Redirect-aware auth check + credential auto-relogin + re-persist. An
      // expired-looking saved state heals here instead of going out anonymous.
      ctx = await session.getContext();
    } catch (e) {
      // The session could not be established. That is not evidence that OCS
      // generation is broken — it is evidence the probe could not run, which
      // is what `skip` means. Reporting `fail` here halts the run (ace#1767).
      return skip(`OCS session could not be established: ${String((e as Error)?.message ?? e)}`);
    }
    const cookies = await ctx.cookies();
    const csrf = session.getCsrfToken();

    const { CompositeBackend } = await import('../mcp/ocs/backends/composite.js');
    const { RestBackend } = await import('../mcp/ocs/backends/rest.js');
    const { PlaywrightBackend } = await import('../mcp/ocs/backends/playwright.js');

    const rest = new RestBackend({ baseUrl, token });
    const playwright = new PlaywrightBackend({
      teamSlug: team,
      baseUrl,
      csrfToken: csrf,
      request: async (method: string, urlPath: string, body?: unknown) => {
        const res = await ctx.request.fetch(`${baseUrl}${urlPath}`, {
          method,
          headers: {
            'X-CSRFToken': csrf,
            Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
          },
          data: body as never,
        });
        return {
          ok: res.ok(),
          status: res.status(),
          headers: Object.fromEntries(Object.entries(res.headers())),
          // Same field the ace-ocs MCP shim supplies: without it a followed
          // 302 to /accounts/login/ is indistinguishable from the real page.
          url: res.url(),
          text: async () => res.text(),
          json: async () => res.json(),
        };
      },
    });
    const composite = new CompositeBackend({ rest, playwright });

    // One full round-trip. Retried once — and only on a `timeout`
    // classification — by runGenerationProbeWithRetry below. The embed-info
    // handshake is inside the attempt because it is timed out on the same cap:
    // if IT is what timed out, `publicId` is empty and the retry has to redo it.
    // The browser context is reused across attempts, so a retry pays for the
    // round-trip, not another chromium launch.
    const roundTrip = async (): Promise<Result> => {
      let publicId = '';
      let embedKey = '';
      try {
        const info = await withTimeout(
          composite.getChatbotEmbedInfo({ experiment_id: Number(gtid) }),
          PROBE_TIMEOUT_MS,
          'getChatbotEmbedInfo',
        );
        publicId = info.public_id;
        embedKey = info.embed_key;
      } catch (e) {
        return await failure(composite, String((e as Error)?.message ?? e), baseUrl, team, publicId);
      }

      try {
        await withTimeout(
          composite.sendTestMessage({ public_id: publicId, embed_key: embedKey, message: 'ping' }),
          PROBE_TIMEOUT_MS,
          'sendTestMessage',
        );
      } catch (e) {
        return await failure(composite, String((e as Error)?.message ?? e), baseUrl, team, publicId);
      }

      // Success path: resolve the provider id for the record, best-effort.
      const providerId = await resolveProviderId(composite, publicId);
      return {
        status: 'pass',
        class: 'ok',
        summary: 'OCS generated a live response',
        providerId,
        trace: null,
        detail: '',
        remediation: '',
      };
    };

    return await runGenerationProbeWithRetry(roundTrip);
  } finally {
    await session.close().catch(() => {});
  }
}

/** Never let the diagnostic enrichment throw the probe. */
async function resolveProviderId(composite: unknown, publicId: string): Promise<number | null> {
  if (!publicId) return null;
  try {
    const inspect = await withTimeout(
      (composite as { inspectChatbot: (a: { public_id: string }) => Promise<unknown> }).inspectChatbot({
        public_id: publicId,
      }),
      10_000,
      'inspectChatbot',
    );
    return pickGenerationProviderId(inspect);
  } catch {
    return null;
  }
}

async function failure(
  composite: unknown,
  message: string,
  baseUrl: string,
  team: string,
  publicId: string,
): Promise<Result> {
  const { class: cls, summary } = classifyGenerationFailure(message);
  const trace = extractTracePointer(message);
  const providerId = await resolveProviderId(composite, publicId);
  return {
    // The halt/no-halt decision lives in lib/ocs-generation-probe.ts so it is
    // unit-testable without a live OCS. `no_session` reports `skip`, not
    // `fail` — the second, independent guard on ace#1767: even if a future
    // auth path regresses past PlaywrightSession, a dead cookie cannot halt a
    // run that should proceed.
    status: probeStatusFor(cls),
    class: cls,
    summary,
    providerId,
    trace,
    detail: message,
    remediation: remediationFor(cls, { baseUrl, teamSlug: team, providerId, trace }),
  };
}

async function main(): Promise<void> {
  const formatArg = process.argv.find((a) => a.startsWith('--format='));
  const format = formatArg ? formatArg.split('=')[1] : 'lines';
  loadEnv();
  let result: Result;
  try {
    result = await probe();
  } catch (e) {
    // Any unforeseen throw (playwright missing, storageState corrupt, …) is
    // reported as a skip rather than a fail: the probe failed, which is not
    // evidence that OCS did.
    result = skip(`probe could not run: ${String((e as Error)?.message ?? e)}`);
  }
  emit(result, format);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
