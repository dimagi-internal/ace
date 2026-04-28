import type {
  Program,
  Opportunity,
  Invite,
  Invoice,
  DeliveryType,
} from './types.js';

/**
 * The contract every Connect backend implements. Method signatures are sized
 * to the live Connect data model (see types.ts) — when CCC-301 ships and we
 * gain a real REST API, the existing CompositeBackend dispatches re-route to
 * a `RestBackend` impl with no signature changes for callers.
 */
export interface ConnectClient {
  // Programs (CRUD)
  listPrograms(args: { organization_slug: string; name?: string }): Promise<{ programs: Program[] }>;
  getProgram(args: { organization_slug: string; program_id: string }): Promise<Program>;
  createProgram(args: {
    organization_slug: string;
    name: string;
    description: string;
    delivery_type: number;
    budget: number;
    currency: string;
    country: string;
    start_date: string;
    end_date: string;
  }): Promise<Program>;
  updateProgram(args: {
    organization_slug: string;
    program_id: string;
    name?: string;
    description?: string;
    budget?: number;
    start_date?: string;
    end_date?: string;
  }): Promise<Program>;

  // Lookups (read-only) — the Connect program-init form's <select> options
  listDeliveryTypes(args: { organization_slug: string }): Promise<{ delivery_types: DeliveryType[] }>;

  // Opportunities (CRUD)
  listOpportunities(args: { organization_slug: string; program_id?: string; name?: string }): Promise<{ opportunities: Opportunity[] }>;
  getOpportunity(args: { organization_slug: string; opportunity_id: string }): Promise<Opportunity>;
  createOpportunity(args: {
    organization_slug: string;
    program_id?: string;
    name: string;
    short_description: string;
    description: string;
    currency: string;
    country: string;
    hq_server: string;
    api_key: string;
    learn_app_domain: string;
    learn_app: string;
    learn_app_description?: string;
    learn_app_passing_score: number;
    deliver_app_domain: string;
    deliver_app: string;
  }): Promise<Opportunity>;
  updateOpportunity(args: {
    organization_slug: string;
    opportunity_id: string;
    name?: string;
    short_description?: string;
    description?: string;
  }): Promise<Opportunity>;

  // Lifecycle
  activateOpportunity(args: { organization_slug: string; opportunity_id: string }): Promise<{ ok: true; status: 'active' }>;

  // Invites
  sendLloInvite(args: {
    organization_slug: string;
    opportunity_id: string;
    organization_name: string;
    contact_email: string;
  }): Promise<Invite>;
  listInvites(args: { organization_slug: string; opportunity_id: string }): Promise<{ invites: Invite[] }>;

  // Invoices
  listInvoices(args: { organization_slug: string; opportunity_id: string }): Promise<{ invoices: Invoice[] }>;
  getInvoice(args: { organization_slug: string; invoice_id: string }): Promise<Invoice>;
}
