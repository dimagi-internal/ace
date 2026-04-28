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

  // Programs (Playwright today)
  listPrograms = (a: Parameters<ConnectClient['listPrograms']>[0]) => this.opts.playwright.listPrograms(a);
  getProgram = (a: Parameters<ConnectClient['getProgram']>[0]) => this.opts.playwright.getProgram(a);
  createProgram = (a: Parameters<ConnectClient['createProgram']>[0]) => this.opts.playwright.createProgram(a);
  updateProgram = (a: Parameters<ConnectClient['updateProgram']>[0]) => this.opts.playwright.updateProgram(a);

  // Lookups
  listDeliveryTypes = (a: Parameters<ConnectClient['listDeliveryTypes']>[0]) => this.opts.playwright.listDeliveryTypes(a);

  // Opportunities (Playwright today)
  listOpportunities = (a: Parameters<ConnectClient['listOpportunities']>[0]) => this.opts.playwright.listOpportunities(a);
  getOpportunity = (a: Parameters<ConnectClient['getOpportunity']>[0]) => this.opts.playwright.getOpportunity(a);
  createOpportunity = (a: Parameters<ConnectClient['createOpportunity']>[0]) => this.opts.playwright.createOpportunity(a);
  updateOpportunity = (a: Parameters<ConnectClient['updateOpportunity']>[0]) => this.opts.playwright.updateOpportunity(a);

  // Lifecycle (Playwright today)
  activateOpportunity = (a: Parameters<ConnectClient['activateOpportunity']>[0]) => this.opts.playwright.activateOpportunity(a);

  // Invites (Playwright today)
  sendLloInvite = (a: Parameters<ConnectClient['sendLloInvite']>[0]) => this.opts.playwright.sendLloInvite(a);
  listInvites = (a: Parameters<ConnectClient['listInvites']>[0]) => this.opts.playwright.listInvites(a);

  // Invoices (Playwright today)
  listInvoices = (a: Parameters<ConnectClient['listInvoices']>[0]) => this.opts.playwright.listInvoices(a);
  getInvoice = (a: Parameters<ConnectClient['getInvoice']>[0]) => this.opts.playwright.getInvoice(a);
}
