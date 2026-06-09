import type { ConnectClient } from '../client.js';
import { HttpError } from '../errors.js';

export interface CompositeOptions {
  rest: ConnectClient;
  playwright: ConnectClient;
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
  createProgram = async (a: Parameters<ConnectClient['createProgram']>[0]) =>
    this.tryRestThenPlaywright('createProgram', a);
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
  addOrgMember = (a: Parameters<ConnectClient['addOrgMember']>[0]) =>
    this.opts.playwright.addOrgMember(a);

  // ── Playwright (HTML-driven — reads, edits, verification flags, invoices) ──
  listPrograms = (a: Parameters<ConnectClient['listPrograms']>[0]) => this.opts.playwright.listPrograms(a);
  getProgram = (a: Parameters<ConnectClient['getProgram']>[0]) => this.opts.playwright.getProgram(a);
  updateProgram = (a: Parameters<ConnectClient['updateProgram']>[0]) => this.opts.playwright.updateProgram(a);
  listDeliveryTypes = (a: Parameters<ConnectClient['listDeliveryTypes']>[0]) => this.opts.playwright.listDeliveryTypes(a);
  listOpportunities = (a: Parameters<ConnectClient['listOpportunities']>[0]) => this.opts.playwright.listOpportunities(a);
  getOpportunity = (a: Parameters<ConnectClient['getOpportunity']>[0]) => this.opts.playwright.getOpportunity(a);
  updateOpportunity = (a: Parameters<ConnectClient['updateOpportunity']>[0]) => this.opts.playwright.updateOpportunity(a);
  setVerificationFlags = (a: Parameters<ConnectClient['setVerificationFlags']>[0]) => this.opts.playwright.setVerificationFlags(a);
  listDeliverUnits = (a: Parameters<ConnectClient['listDeliverUnits']>[0]) => this.opts.playwright.listDeliverUnits(a);
  listPaymentUnits = (a: Parameters<ConnectClient['listPaymentUnits']>[0]) => this.opts.playwright.listPaymentUnits(a);
  listInvites = (a: Parameters<ConnectClient['listInvites']>[0]) => this.opts.playwright.listInvites(a);
  listInvoices = (a: Parameters<ConnectClient['listInvoices']>[0]) => this.opts.playwright.listInvoices(a);
  getInvoice = (a: Parameters<ConnectClient['getInvoice']>[0]) => this.opts.playwright.getInvoice(a);

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
