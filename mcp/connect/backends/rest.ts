import type { APIRequestContext, APIResponse } from 'playwright';
import type { ConnectClient } from '../client.js';
import type {
  Program,
  Opportunity,
  AppSnapshot,
  ProgramApplication,
  PaymentUnit,
} from '../types.js';
import { HttpError, ConnectValidationError } from '../errors.js';
import type { PlaywrightSession } from '../auth/playwright-session.js';

/**
 * REST backend for the eight write atoms covered by commcare-connect PR
 * #1135's automation API:
 *
 *   POST /api/programs/                                                 → createProgram
 *   POST /api/programs/{program_id}/applications/                       → sendLloInvite
 *   POST /api/programs/{program_id}/applications/{app_id}/accept/       → acceptProgramApplication
 *   POST /api/programs/{program_id}/opportunities/                      → createOpportunity
 *   POST /api/opportunities/{opportunity_id}/payment_units/             → createPaymentUnit(s)
 *   POST /api/opportunities/{opportunity_id}/activate/                  → activateOpportunity
 *   POST /api/opportunities/{opportunity_id}/invite_users/              → sendFlwInvite
 *
 * These endpoints use DRF `IsAuthenticated`, which accepts the same Django
 * sessionid cookie the Playwright OAuth-with-CCHQ flow produces. So this
 * backend reuses the authenticated `APIRequestContext` from
 * `PlaywrightSession.getContext()` and just sends JSON instead of HTML
 * form-encoded data.
 *
 * Auth headers per request:
 *   - `Cookie: sessionid=...; csrftoken=...`  (auto from cookie jar)
 *   - `X-CSRFToken: <csrftoken>`              (DRF SessionAuthentication enforces CSRF)
 *   - `Referer: <baseUrl>/`                   (Django requires Referer for HTTPS CSRF)
 *   - `Content-Type: application/json`
 *
 * Read endpoints + verification flags + edits stay HTML-form-driven through
 * the legacy `playwright.ts` backend; the composite routes accordingly.
 */
export interface RestBackendOptions {
  baseUrl: string;
  /**
   * Initial CSRF token snapshot at backend init. Kept as a fast-path so
   * the first POST per atom doesn't pay a cookie-jar read; refreshed
   * lazily via `session.refreshCsrfToken()` if a 403 CSRF response comes
   * back (Django rotates `csrftoken` on certain server-side state
   * transitions; the static header would otherwise stay stale until
   * process restart).
   */
  csrfToken: string;
  request: APIRequestContext;
  /**
   * Optional session reference. When supplied (the production wiring),
   * `post()` self-heals 403 CSRF failures by refreshing the token from
   * the cookie jar and retrying once. Tests can omit it and the helper
   * falls back to the static `csrfToken`.
   */
  session?: PlaywrightSession;
}

class NotImplementedError extends Error {
  constructor(method: string) {
    super(
      `${method}: not implemented in the REST backend — composite should route this atom to PLAYWRIGHT.`,
    );
  }
}
const stub = (name: string) => () => { throw new NotImplementedError(name); };

export class RestBackend implements ConnectClient {
  /**
   * Latest CSRF token. Initialized from `opts.csrfToken`; rotated on
   * 403-CSRF self-heal so subsequent calls don't pay the cookie-jar
   * read on every invocation.
   */
  private csrf: string;

  /**
   * Latest authenticated request handle. Initialized from
   * `opts.request`; rebuilt on `session.invalidate()` recovery so a
   * full re-auth produces a fresh `APIRequestContext` that subsequent
   * calls actually use (0.13.15 — pre-0.13.15, the constructor-bound
   * `opts.request` went stale after invalidate and the retry kept
   * using the dead context).
   */
  private request: APIRequestContext;

  constructor(private opts: RestBackendOptions) {
    this.csrf = opts.csrfToken;
    this.request = opts.request;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private headers(referer?: string): Record<string, string> {
    return {
      'X-CSRFToken': this.csrf,
      Referer: referer ?? `${this.opts.baseUrl}/`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /**
   * Detect a Django CSRF rejection. Django returns 403 with
   * `Forbidden (CSRF token from the 'X-Csrftoken' HTTP header incorrect.)`
   * (or similar phrasing) in the body. Status 403 alone is ambiguous
   * (could be a permission denial), so we match on the body shape too.
   */
  private static isCsrfFailure(status: number, bodyText: string): boolean {
    if (status !== 403) return false;
    return /CSRF/i.test(bodyText);
  }

  /**
   * Refresh CSRF from the live cookie jar. Used by the 403-CSRF retry
   * path. No-op falls back to the cached token if no session is wired
   * (test paths).
   */
  private async refreshCsrf(): Promise<void> {
    if (!this.opts.session) return;
    try {
      this.csrf = await this.opts.session.refreshCsrfToken();
    } catch {
      // If the cookie went missing entirely, leave the cached value
      // alone — the retry will fail predictably and the caller surfaces
      // the original error.
    }
  }

  /**
   * Bottom-out recovery: drop the entire session (cached
   * BrowserContext + on-disk state file) and rebuild via fresh
   * `hqOAuthLogin`. After this, the cookie jar has fresh sessionid
   * AND fresh both-domain csrftokens, so a stale-server-side-session
   * recovers transparently. Updates this backend's own `request` and
   * `csrf` fields so subsequent calls use the new context, not the
   * dead one bound at constructor time.
   */
  private async reauth(): Promise<void> {
    if (!this.opts.session) return;
    await this.opts.session.invalidate();
    const ctx = await this.opts.session.getContext();
    this.request = ctx.request;
    this.csrf = this.opts.session.getCsrfToken();
  }

  private async post<T>(
    path: string,
    body: unknown,
    opts: { timeout_ms?: number } = {},
  ): Promise<{ status: number; data: T | undefined; raw: APIResponse }> {
    // Playwright's APIRequestContext defaults to a 30s per-request timeout.
    // Some Connect endpoints (managed-opp create syncs HQ apps + deliver
    // units server-side, takes 30-90s under load; verified live on
    // malaria-itn-fgd/20260514-2352 Phase 4 where the first attempt timed
    // out at 30s and produced an orphan opp consuming program budget).
    // Callers pass `timeout_ms` per-endpoint to opt into longer waits.
    const requestOpts = {
      data: body,
      headers: this.headers(),
      maxRedirects: 0,
      ...(opts.timeout_ms != null ? { timeout: opts.timeout_ms } : {}),
    };
    let res = await this.request.post(path, requestOpts);

    // Two-stage 403-CSRF self-heal:
    //
    //   1. Refresh `csrftoken` from the cookie jar (cheap; fixes the
    //      common case where the client-side cookie went stale or
    //      was rotated server-side and Playwright synced the new
    //      value via Set-Cookie).
    //   2. If retry STILL gets 403 CSRF, the underlying server-side
    //      session is stale (sessionid expired/rotated upstream).
    //      Drop the session entirely and re-auth via hqOAuthLogin.
    //      The third attempt sends a guaranteed-fresh token from a
    //      guaranteed-fresh session.
    //
    // Three total attempts (initial + cookie-refresh + full re-auth).
    // Closes the loop on every CSRF-shaped failure mode the
    // turmeric-20260505-1024 run surfaced across 0.13.8 → 0.13.14.
    if (res.status() === 403 && this.opts.session) {
      const bodyText = await res.text();
      if (RestBackend.isCsrfFailure(res.status(), bodyText)) {
        await this.refreshCsrf();
        res = await this.request.post(path, requestOpts);

        // Stage 2: still 403 CSRF after cookie refresh? The session
        // itself is stale. Bottom out at a full re-auth.
        if (res.status() === 403) {
          const retryBody = await res.text();
          if (RestBackend.isCsrfFailure(res.status(), retryBody)) {
            await this.reauth();
            res = await this.request.post(path, requestOpts);
          }
        }
      }
    }

    const status = res.status();
    const contentType = res.headers()['content-type'] ?? '';
    let data: T | undefined;
    if (contentType.includes('application/json')) {
      try { data = (await res.json()) as T; } catch { /* fall through */ }
    }
    return { status, data, raw: res };
  }

  /**
   * Translate a 4xx/5xx response into a typed error. DRF returns JSON for
   * validation failures keyed by field name (`{ "name": ["This field..."] }`)
   * with `non_field_errors` for cross-field errors.
   */
  private async raiseForStatus(res: APIResponse, path: string, contextLabel: string): Promise<never> {
    const status = res.status();
    const contentType = res.headers()['content-type'] ?? '';
    let bodyText = '';
    try { bodyText = await res.text(); } catch { /* swallow */ }
    if (status >= 400 && status < 500 && contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(bodyText) as Record<string, unknown>;
        const fields: Record<string, string[]> = {};
        const flat: string[] = [];
        for (const [key, val] of Object.entries(parsed)) {
          if (Array.isArray(val)) {
            const msgs = val.map((v) => typeof v === 'string' ? v : JSON.stringify(v));
            fields[key] = msgs;
            flat.push(...msgs.map((m) => (key === 'non_field_errors' ? m : `${key}: ${m}`)));
          } else if (typeof val === 'string') {
            fields[key] = [val];
            flat.push(`${key}: ${val}`);
          }
        }
        if (flat.length > 0) throw new ConnectValidationError(flat, fields);
      } catch (err) {
        if (err instanceof ConnectValidationError) throw err;
        // fall through to HttpError below
      }
    }
    throw new HttpError(status, `${contextLabel} ${path}`, bodyText, contentType);
  }

  // ── Programs ─────────────────────────────────────────────────────

  createProgram: ConnectClient['createProgram'] = async (args) => {
    const path = '/api/programs/';
    const body = {
      organization: args.organization_slug,
      name: args.name,
      description: args.description,
      delivery_type: args.delivery_type,
      budget: args.budget,
      currency: args.currency,
      country: args.country,
      start_date: args.start_date,
      end_date: args.end_date,
    };
    const { status, data, raw } = await this.post<{
      id?: number;
      program_id: string;
      name: string;
      slug?: string;
      description: string;
      organization: string;
      delivery_type: string;
      budget: number;
      currency: string;
      country: string;
      start_date: string;
      end_date: string;
    }>(path, body);
    if (status !== 201 || !data) await this.raiseForStatus(raw, path, 'POST');
    return programFromResponse(data!, args.organization_slug);
  };

  // ── Opportunities ────────────────────────────────────────────────

  createOpportunity: ConnectClient['createOpportunity'] = async (args) => {
    const path = `/api/programs/${encodeURIComponent(args.program_id)}/opportunities/`;
    const body = {
      name: args.name,
      description: args.description,
      short_description: args.short_description,
      // The live deployment REJECTS organization=None with
      // "organization: This field is required" (HTTP 400) — observed on
      // malaria-rdt/20260604-1604 Phase 4 (jjackson/ace#700). Pre-award there
      // is no LLO, so default the holding org to the PM org running the program
      // (organization_slug) rather than sending null. Phase 9 reassigns to the
      // awarded LLO. When target_organization_slug IS supplied (post-award),
      // it wins.
      organization: args.target_organization_slug ?? args.organization_slug,
      start_date: args.start_date,
      end_date: args.end_date,
      total_budget: args.total_budget,
      ...(args.is_test !== undefined ? { is_test: args.is_test } : {}),
      learn_app: { ...args.learn_app },
      deliver_app: { ...args.deliver_app },
    };
    // Managed-opp create syncs HQ learn-app + deliver-app server-side and
    // can take 30-90s under load. Default Playwright timeout (30s) was
    // hit on `malaria-itn-fgd/20260514-2352` Phase 4 and produced an
    // orphan opp consuming program budget. 120s timeout absorbs the
    // realistic upper bound; transient overruns past that are a server
    // health issue, not a client config issue.
    const { status, data, raw } = await this.post<ManagedOpportunityResponse>(path, body, {
      timeout_ms: 120_000,
    });
    if (status !== 201 || !data) await this.raiseForStatus(raw, path, 'POST');
    const opp = opportunityFromResponse(data!, args.organization_slug);

    // Activate ONLY when the caller explicitly opts in (default false,
    // jjackson/ace#584). Activation requires at least one PaymentUnit,
    // which does not exist at create time in the documented
    // create → create_payment_unit → activate flow. `auto_activate: true`
    // before the PU exists fails transactionally ("At least one payment
    // unit must exist before activating") and rolls back the ENTIRE
    // create, leaving an orphan inactive opp and no opportunity_id. The
    // skill creates the PU then calls `connect_activate_opportunity`
    // (idempotent) — downstream endpoints (sendFlwInvite's
    // `/invite_users/`) still require active. Pass true only when PU(s)
    // already exist or a one-step activate is genuinely intended.
    if (args.auto_activate === true) {
      await this.activateOpportunity({
        organization_slug: args.organization_slug,
        opportunity_id: opp.id,
      });
      // Reflect the now-truly-active state on the returned object.
      return { ...opp, active: true as const };
    }
    return opp;
  };

  // ── Payment units (atomic-list endpoint) ─────────────────────────

  createPaymentUnits: ConnectClient['createPaymentUnits'] = async (args) => {
    const path = `/api/opportunities/${encodeURIComponent(args.opportunity_id)}/payment_units/`;
    const body = {
      payment_units: args.payment_units.map((pu) => ({
        name: pu.name,
        description: pu.description ?? '',
        amount: pu.amount,
        ...(pu.org_amount !== undefined ? { org_amount: pu.org_amount } : {}),
        max_total: pu.max_total,
        max_daily: pu.max_daily,
        required_deliver_units: pu.required_deliver_units ?? [],
        optional_deliver_units: pu.optional_deliver_units ?? [],
        ...(pu.start_date ? { start_date: pu.start_date } : {}),
        ...(pu.end_date ? { end_date: pu.end_date } : {}),
      })),
    };
    const { status, data, raw } = await this.post<{ payment_units: ApiPaymentUnit[] }>(path, body);
    if (status !== 201 || !data) await this.raiseForStatus(raw, path, 'POST');
    return { payment_units: data!.payment_units.map(paymentUnitFromResponse) };
  };

  createPaymentUnit: ConnectClient['createPaymentUnit'] = async (args) => {
    const result = await this.createPaymentUnits({
      organization_slug: args.organization_slug,
      opportunity_id: args.opportunity_id,
      payment_units: [
        {
          name: args.name,
          description: args.description,
          amount: args.amount,
          org_amount: args.org_amount,
          max_total: args.max_total,
          max_daily: args.max_daily,
          start_date: args.start_date,
          end_date: args.end_date,
          required_deliver_units: args.required_deliver_units,
          optional_deliver_units: args.optional_deliver_units,
        },
      ],
    });
    return result.payment_units[0];
  };

  // ── Lifecycle ─────────────────────────────────────────────────────

  activateOpportunity: ConnectClient['activateOpportunity'] = async ({ opportunity_id }) => {
    const path = `/api/opportunities/${encodeURIComponent(opportunity_id)}/activate/`;
    const { status, data, raw } = await this.post<{
      id: number;
      opportunity_id: string;
      name: string;
      active: boolean;
    }>(path, {});
    if (status !== 200 || !data) await this.raiseForStatus(raw, path, 'POST');
    return {
      id: data!.id,
      opportunity_id: data!.opportunity_id,
      name: data!.name,
      active: true as const,
    };
  };

  // ── Program applications (LLO invite + accept) ───────────────────

  sendLloInvite: ConnectClient['sendLloInvite'] = async (args) => {
    const path = `/api/programs/${encodeURIComponent(args.program_id)}/applications/`;
    const { status, data, raw } = await this.post<ApiProgramApplication>(path, {
      organization: args.organization,
    });
    if (status !== 201 || !data) await this.raiseForStatus(raw, path, 'POST');
    return programApplicationFromResponse(data!);
  };

  acceptProgramApplication: ConnectClient['acceptProgramApplication'] = async (args) => {
    const path = `/api/programs/${encodeURIComponent(args.program_id)}/applications/${encodeURIComponent(args.application_id)}/accept/`;
    const { status, data, raw } = await this.post<ApiProgramApplication>(path, {});
    if (status !== 200 || !data) await this.raiseForStatus(raw, path, 'POST');
    return programApplicationFromResponse(data!);
  };

  // ── FLW invites ──────────────────────────────────────────────────

  sendFlwInvite: ConnectClient['sendFlwInvite'] = async (args) => {
    const path = `/api/opportunities/${encodeURIComponent(args.opportunity_id)}/invite_users/`;
    const { status, data, raw } = await this.post<{ invited_count: number; message: string }>(
      path,
      { phone_numbers: args.phone_numbers },
    );
    if (status !== 202 || !data) await this.raiseForStatus(raw, path, 'POST');
    return {
      opportunity_id: args.opportunity_id,
      phone_numbers: args.phone_numbers,
      invited_count: data!.invited_count,
      status: 'queued' as const,
    };
  };

  // ── Stubs (Playwright-driven; never invoked in composite) ────────

  listPrograms = stub('listPrograms') as ConnectClient['listPrograms'];
  getProgram = stub('getProgram') as ConnectClient['getProgram'];
  updateProgram = stub('updateProgram') as ConnectClient['updateProgram'];
  listDeliveryTypes = stub('listDeliveryTypes') as ConnectClient['listDeliveryTypes'];
  listOpportunities = stub('listOpportunities') as ConnectClient['listOpportunities'];
  getOpportunity = stub('getOpportunity') as ConnectClient['getOpportunity'];
  updateOpportunity = stub('updateOpportunity') as ConnectClient['updateOpportunity'];
  setVerificationFlags = stub('setVerificationFlags') as ConnectClient['setVerificationFlags'];
  deleteUnacceptedFlwInvites = stub('deleteUnacceptedFlwInvites') as ConnectClient['deleteUnacceptedFlwInvites'];
  listDeliverUnits = stub('listDeliverUnits') as ConnectClient['listDeliverUnits'];
  listPaymentUnits = stub('listPaymentUnits') as ConnectClient['listPaymentUnits'];
  listInvites = stub('listInvites') as ConnectClient['listInvites'];
  listInvoices = stub('listInvoices') as ConnectClient['listInvoices'];
  getInvoice = stub('getInvoice') as ConnectClient['getInvoice'];
}

// ── Response shapers ───────────────────────────────────────────────

interface ManagedOpportunityResponse {
  id: number;
  opportunity_id: string;
  name: string;
  description: string;
  short_description: string;
  organization: string;
  managed: boolean;
  program_id: string;
  start_date: string;
  end_date: string;
  total_budget: number;
  is_test: boolean;
  learn_app: {
    cc_domain: string;
    cc_app_id: string;
    name: string;
    learn_modules?: Array<{
      id: number;
      slug: string;
      name: string;
      description: string;
      time_estimate: number;
    }>;
  };
  deliver_app: {
    cc_domain: string;
    cc_app_id: string;
    name: string;
    deliver_units?: Array<{ id: number; slug: string; name: string }>;
  };
  currency: string;
  country: string;
  active: boolean;
}

interface ApiPaymentUnit {
  id: number;
  payment_unit_id?: number;
  name: string;
  description: string;
  amount: number;
  org_amount: number;
  max_total: number;
  max_daily: number;
  required_deliver_units: number[];
  optional_deliver_units: number[];
  start_date: string | null;
  end_date: string | null;
}

interface ApiProgramApplication {
  program_application_id: string;
  program: string;
  organization: string;
  status: string;
}

function programFromResponse(
  p: {
    id?: number;
    program_id: string;
    name: string;
    slug?: string;
    description: string;
    organization: string;
    delivery_type: string;
    budget: number;
    currency: string;
    country: string;
    start_date: string;
    end_date: string;
  },
  organization_slug: string,
): Program {
  return {
    id: p.program_id,
    int_id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    delivery_type: p.delivery_type,
    budget: p.budget,
    currency: p.currency,
    country: p.country,
    start_date: p.start_date,
    end_date: p.end_date,
    organization_slug,
  };
}

function opportunityFromResponse(
  o: ManagedOpportunityResponse,
  pmOrgSlug: string,
): Opportunity {
  void pmOrgSlug;
  return {
    id: o.opportunity_id,
    int_id: o.id,
    program_id: o.program_id,
    name: o.name,
    short_description: o.short_description,
    description: o.description,
    organization_slug: o.organization,
    managed: o.managed,
    start_date: o.start_date,
    end_date: o.end_date,
    total_budget: o.total_budget,
    is_test: o.is_test,
    active: o.active,
    currency: o.currency,
    country: o.country,
    learn_app: appFromResponse(o.learn_app),
    deliver_app: appFromResponse(o.deliver_app),
  };
}

function appFromResponse(
  app:
    | {
        cc_domain: string;
        cc_app_id: string;
        name: string;
        learn_modules?: Array<{ id: number; slug: string; name: string; description: string; time_estimate: number }>;
      }
    | {
        cc_domain: string;
        cc_app_id: string;
        name: string;
        deliver_units?: Array<{ id: number; slug: string; name: string }>;
      },
): AppSnapshot {
  const out: AppSnapshot = {
    cc_domain: app.cc_domain,
    cc_app_id: app.cc_app_id,
    name: app.name,
  };
  if ('learn_modules' in app && app.learn_modules) out.learn_modules = app.learn_modules;
  if ('deliver_units' in app && app.deliver_units) out.deliver_units = app.deliver_units;
  return out;
}

function paymentUnitFromResponse(p: ApiPaymentUnit): PaymentUnit {
  return {
    id: p.id,
    payment_unit_id: p.payment_unit_id,
    name: p.name,
    description: p.description,
    amount: p.amount,
    org_amount: p.org_amount,
    max_total: p.max_total,
    max_daily: p.max_daily,
    required_deliver_units: p.required_deliver_units,
    optional_deliver_units: p.optional_deliver_units,
    start_date: p.start_date ?? undefined,
    end_date: p.end_date ?? undefined,
  };
}

function programApplicationFromResponse(p: ApiProgramApplication): ProgramApplication {
  const status = (['invited', 'applied', 'accepted', 'declined'] as const).includes(
    p.status as 'invited' | 'applied' | 'accepted' | 'declined',
  )
    ? (p.status as ProgramApplication['status'])
    : 'invited';
  return {
    program_application_id: p.program_application_id,
    program: p.program,
    organization: p.organization,
    status,
  };
}
