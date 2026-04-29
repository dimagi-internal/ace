import type {
  Program,
  Opportunity,
  Invite,
  Invoice,
  DeliveryType,
  VerificationFlags,
  PaymentUnit,
  DeliverUnit,
} from './types.js';

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

  listDeliveryTypes(args: { organization_slug: string }): Promise<{ delivery_types: DeliveryType[] }>;

  /**
   * Register a CommCare HQ API key with Connect (idempotent) and return the
   * int FK Connect's create-opportunity form expects in its `api_key` field.
   *
   * Background: Connect's `api_key` field on /opportunity/init/ is NOT the
   * raw 40-char HQ key — it's the PK of an `HQApiKey` record on Connect's
   * side. Agents must register the key first via /opportunity/add_api_key/
   * before calling createOpportunity. This atom does that step on its own
   * so callers can verify / debug it without driving the whole opp flow.
   */
  registerHqApiKey(args: {
    organization_slug: string;
    hq_server: string;
    api_key: string;
  }): Promise<{
    organization_slug: string;
    hq_server: string;
    hq_server_id: string;
    api_key_id: string;
    truncated_label: string;
  }>;

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
    end_date?: string;
    is_test?: boolean;
  }): Promise<Opportunity>;

  // Per-opportunity configuration (post-create)
  setVerificationFlags(args: {
    organization_slug: string;
    opportunity_id: string;
    flags: VerificationFlags;
  }): Promise<{ ok: true }>;
  listDeliverUnits(args: {
    organization_slug: string;
    opportunity_id: string;
  }): Promise<{ deliver_units: DeliverUnit[] }>;
  createPaymentUnit(args: {
    organization_slug: string;
    opportunity_id: string;
    name: string;
    description: string;
    amount: number;
    max_total?: number;
    max_daily?: number;
    start_date?: string;
    end_date?: string;
    required_deliver_unit_ids: number[];
    optional_deliver_unit_ids?: number[];
  }): Promise<PaymentUnit>;
  listPaymentUnits(args: {
    organization_slug: string;
    opportunity_id: string;
  }): Promise<{ payment_units: PaymentUnit[] }>;

  // Lifecycle
  activateOpportunity(args: {
    organization_slug: string;
    opportunity_id: string;
  }): Promise<{ ok: true; status: 'active' }>;

  // Invites (program-level — invite an LLO org to a program/its opps)
  sendLloInvite(args: {
    organization_slug: string;
    opportunity_id: string;       // semantically a program_id today; see Notes
    organization_name: string;    // the LLO org's slug
    contact_email: string;
  }): Promise<Invite>;
  listInvites(args: { organization_slug: string; opportunity_id: string }): Promise<{ invites: Invite[] }>;

  // Invoices
  listInvoices(args: { organization_slug: string; opportunity_id: string }): Promise<{ invoices: Invoice[] }>;
  getInvoice(args: { organization_slug: string; invoice_id: string }): Promise<Invoice>;
}
