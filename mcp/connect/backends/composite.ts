import type { ConnectClient } from '../client.js';

export interface CompositeOptions {
  rest: ConnectClient;
  playwright: ConnectClient;
}

/**
 * Routes each ConnectClient method to either REST or Playwright per
 * `capability-map.ts`. The dispatch lines below are the source of truth for
 * which backend handles each atom; if a row says `playwright` but the atom
 * has shipped a REST endpoint, flip the line — this is the only file that
 * changes for that flip.
 */
export class CompositeBackend implements ConnectClient {
  constructor(private opts: CompositeOptions) {}

  // ── REST (commcare-connect PR #1135 automation API) ──────────────
  createProgram = (a: Parameters<ConnectClient['createProgram']>[0]) => this.opts.rest.createProgram(a);
  createOpportunity = (a: Parameters<ConnectClient['createOpportunity']>[0]) => this.opts.rest.createOpportunity(a);
  createPaymentUnit = (a: Parameters<ConnectClient['createPaymentUnit']>[0]) => this.opts.rest.createPaymentUnit(a);
  createPaymentUnits = (a: Parameters<ConnectClient['createPaymentUnits']>[0]) => this.opts.rest.createPaymentUnits(a);
  activateOpportunity = (a: Parameters<ConnectClient['activateOpportunity']>[0]) => this.opts.rest.activateOpportunity(a);
  sendLloInvite = (a: Parameters<ConnectClient['sendLloInvite']>[0]) => this.opts.rest.sendLloInvite(a);
  acceptProgramApplication = (a: Parameters<ConnectClient['acceptProgramApplication']>[0]) => this.opts.rest.acceptProgramApplication(a);
  sendFlwInvite = (a: Parameters<ConnectClient['sendFlwInvite']>[0]) => this.opts.rest.sendFlwInvite(a);

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
}
