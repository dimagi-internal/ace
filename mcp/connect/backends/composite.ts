import type { ConnectClient } from '../client.js';

export interface CompositeOptions {
  rest: ConnectClient;
  playwright: ConnectClient;
}

/**
 * Routes each ConnectClient method to either REST or Playwright per
 * capability-map.ts. Today every line points at `playwright`; when an atom's
 * REST endpoint ships, flip its dispatch line — this is the only file that
 * changes for that flip.
 */
export class CompositeBackend implements ConnectClient {
  constructor(private opts: CompositeOptions) {}

  // Programs
  listPrograms = (a: Parameters<ConnectClient['listPrograms']>[0]) => this.opts.playwright.listPrograms(a);
  getProgram = (a: Parameters<ConnectClient['getProgram']>[0]) => this.opts.playwright.getProgram(a);
  createProgram = (a: Parameters<ConnectClient['createProgram']>[0]) => this.opts.playwright.createProgram(a);
  updateProgram = (a: Parameters<ConnectClient['updateProgram']>[0]) => this.opts.playwright.updateProgram(a);

  // Lookups
  listDeliveryTypes = (a: Parameters<ConnectClient['listDeliveryTypes']>[0]) => this.opts.playwright.listDeliveryTypes(a);
  registerHqApiKey = (a: Parameters<ConnectClient['registerHqApiKey']>[0]) => this.opts.playwright.registerHqApiKey(a);

  // Opportunities
  listOpportunities = (a: Parameters<ConnectClient['listOpportunities']>[0]) => this.opts.playwright.listOpportunities(a);
  getOpportunity = (a: Parameters<ConnectClient['getOpportunity']>[0]) => this.opts.playwright.getOpportunity(a);
  createOpportunity = (a: Parameters<ConnectClient['createOpportunity']>[0]) => this.opts.playwright.createOpportunity(a);
  updateOpportunity = (a: Parameters<ConnectClient['updateOpportunity']>[0]) => this.opts.playwright.updateOpportunity(a);

  // Per-opp configuration
  setVerificationFlags = (a: Parameters<ConnectClient['setVerificationFlags']>[0]) => this.opts.playwright.setVerificationFlags(a);
  listDeliverUnits = (a: Parameters<ConnectClient['listDeliverUnits']>[0]) => this.opts.playwright.listDeliverUnits(a);
  createPaymentUnit = (a: Parameters<ConnectClient['createPaymentUnit']>[0]) => this.opts.playwright.createPaymentUnit(a);
  listPaymentUnits = (a: Parameters<ConnectClient['listPaymentUnits']>[0]) => this.opts.playwright.listPaymentUnits(a);

  // Lifecycle
  activateOpportunity = (a: Parameters<ConnectClient['activateOpportunity']>[0]) => this.opts.playwright.activateOpportunity(a);

  // Invites
  sendLloInvite = (a: Parameters<ConnectClient['sendLloInvite']>[0]) => this.opts.playwright.sendLloInvite(a);
  sendFlwInvite = (a: Parameters<ConnectClient['sendFlwInvite']>[0]) => this.opts.playwright.sendFlwInvite(a);
  listInvites = (a: Parameters<ConnectClient['listInvites']>[0]) => this.opts.playwright.listInvites(a);

  // Invoices
  listInvoices = (a: Parameters<ConnectClient['listInvoices']>[0]) => this.opts.playwright.listInvoices(a);
  getInvoice = (a: Parameters<ConnectClient['getInvoice']>[0]) => this.opts.playwright.getInvoice(a);
}
