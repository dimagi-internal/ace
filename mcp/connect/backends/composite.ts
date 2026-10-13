import type { ConnectClient } from '../client.js';
import { HttpError } from '../errors.js';

export interface CompositeOptions {
  rest: ConnectClient;
  playwright: ConnectClient;
}

/**
 * Is this `delivery_type` the int FK rather than a slug?
 *
 * `connect_create_program`'s Zod union puts `z.string()` first, so the wire
 * value `"19"` arrives as a STRING while `19` arrives as a number. Both mean
 * the same `<option value>` and both are rejected by REST, so both route to
 * the form. See `CompositeBackend.createProgram`.
 */
export function isDeliveryTypeIntFk(v: number | string | undefined | null): boolean {
  if (typeof v === 'number') return Number.isInteger(v);
  // Anything that is not recognisably an int FK keeps the pre-existing
  // REST-first route — the routing decision must never be the thing that
  // throws.
  return typeof v === 'string' && /^\d+$/.test(v.trim());
}

/**
 * Routes each ConnectClient method to either REST or Playwright per
 * `capability-map.ts`.
 *
 * Fallback wiring (REST → Playwright on 404):
 *   The eight write atoms below have REST endpoints from commcare-connect
 *   PR #1135 (`POST /api/programs/`, `/api/opportunities/`, etc.). Those
 *   endpoints are MERGED but not yet DEPLOYED to connect.dimagi.com prod
 *   (verified 2026-05-01). When the deploy lands, REST starts answering
 *   2xx and the fallback never fires. Until then, REST 404s and we fall
 *   over to the HTML-form fallback in playwright.ts. No flag flip — the
 *   fallback transparently becomes dead code the moment Connect ships
 *   the API.
 *
 *   Only HTTP 404 triggers the fallback. Other failures (4xx validation,
 *   5xx server errors, auth) propagate so the caller sees the real error.
 *
 *   `createOpportunity` is the one fallback that throws unconditionally
 *   — Connect's HTML managed-opp wizard is multi-step + HTMX-driven and
 *   would need ~600 lines of new scrape code; the throw documents the
 *   limitation rather than silently returning a half-created opp. Once
 *   PR #1135 deploys the throw becomes unreachable.
 */
export class CompositeBackend implements ConnectClient {
  constructor(private opts: CompositeOptions) {}

  // ── REST with Playwright fallback (commcare-connect PR #1135) ────

  /**
   * `delivery_type` decides the backend, because the two backends key on
   * different things and only one of them can take an int.
   *
   * Connect's create serializer resolves `delivery_type` by SLUG, so the int
   * FK — the value `connect_list_delivery_types` reports as `id`, straight off
   * the form's `<option value>` — comes back from REST as
   * `validation_error: delivery_type: Object with slug=<n> does not exist.`
   * Observed twice, three months apart and both verbatim: `14` on
   * hh-poverty-targeting/20260702-1456 (jjackson/ace#835) and `19` on
   * turmeric-market-study-ghana/20261012-1749 (dimagi-internal/ace#2865).
   * The HTML form is the path that WANTS the int, and it took `19` on the
   * first attempt in that same run.
   *
   * ace#835's fix was to make the list atom emit `slug: slugify(label)` so a
   * caller always had a string to send. That is a guess about a value Connect
   * owns; it held for 18 delivery types and left the 19th with no working
   * input on either backend. ace#2865 removed the guess, which leaves the int
   * as the only honest handle — so route it to the backend that accepts it
   * instead of spending a guaranteed 400.
   *
   * A real string slug still goes REST-first with the usual 404 fallback.
   * Note what is deliberately NOT done here: the 404-only fallback is not
   * widened to cover a `delivery_type` 400. A wrong slug that fell through to
   * the form would be re-resolved by LABEL and could quietly create the
   * programme under a DIFFERENT delivery type — and `delivery_type` is
   * create-time-only, so that is unrepairable. A declared slug that Connect
   * rejects must surface.
   */
  createProgram = async (a: Parameters<ConnectClient['createProgram']>[0]) =>
    isDeliveryTypeIntFk(a.delivery_type)
      ? this.opts.playwright.createProgram(a)
      : this.tryRestThenPlaywright('createProgram', a);
  createOpportunity = async (a: Parameters<ConnectClient['createOpportunity']>[0]) =>
    this.tryRestThenPlaywright('createOpportunity', a);
  createPaymentUnit = async (a: Parameters<ConnectClient['createPaymentUnit']>[0]) =>
    this.tryRestThenPlaywright('createPaymentUnit', a);
  createPaymentUnits = async (a: Parameters<ConnectClient['createPaymentUnits']>[0]) =>
    this.tryRestThenPlaywright('createPaymentUnits', a);
  activateOpportunity = async (a: Parameters<ConnectClient['activateOpportunity']>[0]) =>
    this.tryRestThenPlaywright('activateOpportunity', a);
  sendLloInvite = async (a: Parameters<ConnectClient['sendLloInvite']>[0]) =>
    this.tryRestThenPlaywright('sendLloInvite', a);
  acceptProgramApplication = async (a: Parameters<ConnectClient['acceptProgramApplication']>[0]) =>
    this.tryRestThenPlaywright('acceptProgramApplication', a);
  sendFlwInvite = async (a: Parameters<ConnectClient['sendFlwInvite']>[0]) =>
    this.tryRestThenPlaywright('sendFlwInvite', a);
  deleteUnacceptedFlwInvites = (a: Parameters<ConnectClient['deleteUnacceptedFlwInvites']>[0]) =>
    this.opts.playwright.deleteUnacceptedFlwInvites(a);
  listFlwInvites = (a: Parameters<ConnectClient['listFlwInvites']>[0]) =>
    this.opts.playwright.listFlwInvites(a);
  addOrgMember = (a: Parameters<ConnectClient['addOrgMember']>[0]) =>
    this.opts.playwright.addOrgMember(a);
  removeOrgMember = (a: Parameters<ConnectClient['removeOrgMember']>[0]) =>
    this.opts.playwright.removeOrgMember(a);

  // ── Playwright (HTML-driven — reads, edits, verification flags, invoices) ──
  listPrograms = (a: Parameters<ConnectClient['listPrograms']>[0]) => this.opts.playwright.listPrograms(a);
  getProgram = (a: Parameters<ConnectClient['getProgram']>[0]) => this.opts.playwright.getProgram(a);
  updateProgram = (a: Parameters<ConnectClient['updateProgram']>[0]) => this.opts.playwright.updateProgram(a);
  listDeliveryTypes = (a: Parameters<ConnectClient['listDeliveryTypes']>[0]) => this.opts.playwright.listDeliveryTypes(a);
  listOpportunities = (a: Parameters<ConnectClient['listOpportunities']>[0]) => this.opts.playwright.listOpportunities(a);
  getOpportunity = (a: Parameters<ConnectClient['getOpportunity']>[0]) => this.opts.playwright.getOpportunity(a);
  updateOpportunity = (a: Parameters<ConnectClient['updateOpportunity']>[0]) => this.opts.playwright.updateOpportunity(a);
  setLearnPassingScore = (a: Parameters<ConnectClient['setLearnPassingScore']>[0]) => this.opts.playwright.setLearnPassingScore(a);
  getLearnPassingScore = (a: Parameters<ConnectClient['getLearnPassingScore']>[0]) => this.opts.playwright.getLearnPassingScore(a);
  setVerificationFlags = (a: Parameters<ConnectClient['setVerificationFlags']>[0]) => this.opts.playwright.setVerificationFlags(a);
  listDeliverUnits = (a: Parameters<ConnectClient['listDeliverUnits']>[0]) => this.opts.playwright.listDeliverUnits(a);
  listPaymentUnits = (a: Parameters<ConnectClient['listPaymentUnits']>[0]) => this.opts.playwright.listPaymentUnits(a);
  listInvites = (a: Parameters<ConnectClient['listInvites']>[0]) => this.opts.playwright.listInvites(a);
  listInvoices = (a: Parameters<ConnectClient['listInvoices']>[0]) => this.opts.playwright.listInvoices(a);
  getInvoice = (a: Parameters<ConnectClient['getInvoice']>[0]) => this.opts.playwright.getInvoice(a);
  getLearnProgress = (a: Parameters<ConnectClient['getLearnProgress']>[0]) => this.opts.playwright.getLearnProgress(a);
  getDeliverProgress = (a: Parameters<ConnectClient['getDeliverProgress']>[0]) => this.opts.playwright.getDeliverProgress(a);

  /**
   * Try REST; on `HttpError(status=404)` fall back to Playwright. Any
   * other error (validation, auth, 5xx) propagates so the caller sees
   * the real failure. Typed via the method name so TypeScript checks
   * arg / return shape on both branches.
   */
  private async tryRestThenPlaywright<K extends keyof ConnectClient>(
    method: K,
    args: Parameters<ConnectClient[K]>[0],
  ): Promise<Awaited<ReturnType<ConnectClient[K]>>> {
    try {
      // Cast through `unknown` because TS can't narrow that
      // `Parameters<ConnectClient[K]>[0]` is assignable to the specific
      // method's first arg even with `K extends keyof ConnectClient`.
      const fn = this.opts.rest[method] as (
        a: Parameters<ConnectClient[K]>[0],
      ) => ReturnType<ConnectClient[K]>;
      return (await fn.call(this.opts.rest, args)) as Awaited<ReturnType<ConnectClient[K]>>;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        const fn = this.opts.playwright[method] as (
          a: Parameters<ConnectClient[K]>[0],
        ) => ReturnType<ConnectClient[K]>;
        return (await fn.call(this.opts.playwright, args)) as Awaited<ReturnType<ConnectClient[K]>>;
      }
      throw err;
    }
  }
}
