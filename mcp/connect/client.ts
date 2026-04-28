import type {
  Program,
  Opportunity,
  VerificationRule,
  DeliveryUnit,
  PaymentUnit,
  Invite,
  Invoice,
} from './types.js';

export interface ConnectClient {
  // Programs
  listPrograms(args: { name?: string }): Promise<{ programs: Program[] }>;
  getProgram(args: { program_id: number }): Promise<Program>;
  createProgram(args: { name: string; description?: string; organization_id?: number }): Promise<Program>;
  updateProgram(args: { program_id: number; name?: string; description?: string }): Promise<Program>;

  // Opportunities
  listOpportunities(args: { program_id?: number; name?: string }): Promise<{ opportunities: Opportunity[] }>;
  getOpportunity(args: { opportunity_id: number }): Promise<Opportunity>;
  createOpportunity(args: {
    program_id: number;
    name: string;
    description?: string;
    start_date?: string;
    end_date?: string;
    total_budget?: number;
    currency?: string;
  }): Promise<Opportunity>;
  updateOpportunity(args: {
    opportunity_id: number;
    name?: string;
    description?: string;
    start_date?: string;
    end_date?: string;
    total_budget?: number;
  }): Promise<Opportunity>;

  // Configuration sub-objects
  setVerificationRules(args: { opportunity_id: number; rules: VerificationRule[] }): Promise<{ ok: true }>;
  setDeliveryUnits(args: { opportunity_id: number; units: DeliveryUnit[] }): Promise<{ ok: true; units: DeliveryUnit[] }>;
  setPaymentUnits(args: { opportunity_id: number; units: PaymentUnit[] }): Promise<{ ok: true; units: PaymentUnit[] }>;

  // Lifecycle
  activateOpportunity(args: { opportunity_id: number }): Promise<{ ok: true; status: 'active' }>;

  // Invites
  sendLloInvite(args: {
    opportunity_id: number;
    organization_name: string;
    contact_email: string;
  }): Promise<Invite>;
  listInvites(args: { opportunity_id: number }): Promise<{ invites: Invite[] }>;

  // Invoices
  listInvoices(args: { opportunity_id: number }): Promise<{ invoices: Invoice[] }>;
  getInvoice(args: { invoice_id: number }): Promise<Invoice>;
}
