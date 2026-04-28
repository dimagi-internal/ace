// Connect domain types. snake_case at the HTTP boundary (matches eventual REST);
// camelCase for TS-internal helpers. Field names mirror what we observe on the
// Connect server templates and what CCC-301 is expected to expose.

export interface Program {
  id: number;
  name: string;
  description?: string;
  organization_id?: number;
}

export interface Opportunity {
  id: number;
  program_id: number;
  name: string;
  description?: string;
  start_date?: string;
  end_date?: string;
  total_budget?: number;
  currency?: string;
  status: 'draft' | 'active' | 'completed' | 'cancelled';
}

export interface VerificationRule {
  rule_type: 'gps_accuracy' | 'photo_required' | 'duplicate_check' | 'form_field_required';
  config: Record<string, unknown>;
}

export interface DeliveryUnit {
  id?: number;
  name: string;
  app_form_xmlns?: string;
  max_per_day?: number;
  max_total?: number;
}

export interface PaymentUnit {
  id?: number;
  name: string;
  amount: number;
  delivery_unit_ids: number[];
  required_count?: number;
}

export interface Invite {
  id: number;
  opportunity_id: number;
  organization_name: string;
  organization_id?: number;
  contact_email: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  sent_at?: string;
}

export interface Invoice {
  id: number;
  opportunity_id: number;
  organization_name: string;
  amount: number;
  currency: string;
  status: 'draft' | 'pending' | 'paid' | 'cancelled';
  period_start?: string;
  period_end?: string;
  created_at?: string;
}
