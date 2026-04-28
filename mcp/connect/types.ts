// Connect domain types. Field names mirror what live Connect templates use
// (snake_case at the HTTP boundary). Confirmed via live probes 2026-04-28
// against /a/<org>/program/init/, /opportunity/init/, and the per-opportunity
// config endpoints (verification_flags_config, payment_unit/create,
// deliver_unit_table, user_invite).

export interface Program {
  id: string;
  name: string;
  description: string;
  delivery_type: number;
  budget: number;
  currency: string;
  country: string;
  start_date: string;
  end_date: string;
  organization_slug?: string;
}

export interface Opportunity {
  id: string;
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
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  organization_slug?: string;
}

/**
 * Verification flags as exposed by /opportunity/<id>/verification_flags_config/.
 * Each top-level toggle, plus optional formset rows for per-deliver-unit checks
 * and per-form-field rules. v1 surfaces the top-level toggles only — caller can
 * pass `deliver_unit_checks` / `form_field_rules` arrays for advanced cases but
 * the formset serialization is best-effort and will fall back to leaving prior
 * values if the array shape doesn't match Connect's expectations.
 */
export interface VerificationFlags {
  duplicate?: boolean;
  gps?: boolean;
  catchment_areas?: boolean;
  location?: boolean;
  form_submission_start?: string;        // HH:MM:SS
  form_submission_end?: string;          // HH:MM:SS
  deliver_unit_checks?: DeliverUnitCheck[];
  form_field_rules?: FormFieldRule[];
}

export interface DeliverUnitCheck {
  deliver_unit_id: number;
  check_attachments: boolean;
  duration_seconds?: number;
  id?: number;  // existing row PK; omit for new
}

export interface FormFieldRule {
  name: string;            // human-readable rule name
  question_path: string;   // CommCare question path (e.g. /data/photo_taken)
  question_value: string;  // expected value (e.g. "yes")
  deliver_unit_id: number; // FK
  id?: number;
}

export interface PaymentUnit {
  id: number;
  name: string;
  description: string;
  amount: number;
  max_total?: number;
  max_daily?: number;
  start_date?: string;
  end_date?: string;
  required_deliver_unit_ids: number[];
  optional_deliver_unit_ids: number[];
  parent_payment_unit_id?: number;  // for sub-units
}

export interface DeliverUnit {
  id: number;
  name: string;
  slug?: string;
  app_form_xmlns?: string;
}

export interface Invite {
  id: string;
  opportunity_id: string;
  organization_name: string;
  contact_email: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  sent_at?: string;
}

export interface Invoice {
  id: string;
  opportunity_id: string;
  organization_name: string;
  amount: number;
  currency: string;
  status: 'draft' | 'pending' | 'paid' | 'cancelled';
  period_start?: string;
  period_end?: string;
  created_at?: string;
}

export interface DeliveryType {
  id: number;
  name: string;
}
