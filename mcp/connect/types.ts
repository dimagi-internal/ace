// Connect domain types. Field names mirror the Connect REST API
// (`/api/programs/`, `/api/opportunities/`, …) introduced in commcare-connect
// PR #1135 (2026-04-30): the automation endpoints that replaced the previous
// HTML-form-driven authoring flow.

export interface Program {
  id: string;                          // UUID (Connect's `program_id`)
  name: string;
  slug?: string;
  description: string;
  delivery_type: number | string;      // slug or int FK; the API accepts either
  budget: number;
  currency: string;                    // ISO 4217 code
  country: string;
  start_date: string;                  // YYYY-MM-DD
  end_date: string;                    // YYYY-MM-DD
  organization_slug?: string;
}

export interface Opportunity {
  id: string;                          // UUID (`opportunity_id`)
  program_id?: string;
  name: string;
  short_description: string;
  description: string;
  organization_slug?: string;          // LLO org executing the opp (`organization` in API)
  managed: boolean;                    // always true for ACE-created opps
  start_date?: string;
  end_date?: string;
  total_budget?: number;
  is_test?: boolean;
  active: boolean;
  currency?: string;
  country?: string;
  // App snapshots — populated by `create_opportunity` / `get_opportunity`.
  // Empty `learn_modules` / `deliver_units` arrays mean the HQ sync hasn't
  // run yet (or was rolled back).
  learn_app?: AppSnapshot;
  deliver_app?: AppSnapshot;
}

export interface AppSnapshot {
  cc_domain: string;                   // HQ project space slug
  cc_app_id: string;                   // bare HQ app id (32-char hex)
  name: string;                        // human app name (resolved by Connect from HQ)
  learn_modules?: LearnModuleSnapshot[];
  deliver_units?: DeliverUnitSnapshot[];
}

export interface LearnModuleSnapshot {
  id: number;
  slug: string;
  name: string;
  description: string;
  time_estimate: number;
}

export interface DeliverUnitSnapshot {
  id: number;
  slug: string;
  name: string;
}

export type ProgramApplicationStatus = 'invited' | 'applied' | 'accepted' | 'declined';

export interface ProgramApplication {
  program_application_id: string;      // UUID
  program: string;                     // program UUID
  organization: string;                // LLO org slug
  status: ProgramApplicationStatus;
}

/**
 * Verification flags as exposed by the legacy
 * `/opportunity/<id>/verification_flags_config/` HTML form. This page is NOT
 * part of PR #1135's automation API — `setVerificationFlags` still goes
 * through the session-cookie HTML POST. v1 surfaces the top-level toggles
 * only; per-deliver-unit checks and per-form-field rules are best-effort.
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
  name: string;
  question_path: string;
  question_value: string;
  deliver_unit_id: number;
  id?: number;
}

export interface PaymentUnit {
  id: number;
  payment_unit_id?: number;             // legacy display id
  name: string;
  description: string;
  /**
   * Per-delivery amount paid to the FLW. Required at create time, but the
   * Connect `payment_unit_table` HTML does NOT display this column — only
   * Total Deliveries and Max Daily are shown. So `listPaymentUnits` cannot
   * round-trip `amount` from the table parse alone; it returns `undefined`
   * for this field. Read-side recovery needs the per-PU edit form (TODO)
   * or a future REST GET endpoint. Producers (REST `createPaymentUnits`,
   * Playwright `postPaymentUnitForm`) preserve `amount` on the returned
   * shape because they have it from the input args.
   */
  amount?: number;
  org_amount?: number;
  max_total?: number;
  max_daily?: number;
  start_date?: string;
  end_date?: string;
  required_deliver_units: number[];     // DU ids (server snake_case)
  optional_deliver_units: number[];
}

export interface DeliverUnit {
  id: number;
  name: string;
  slug?: string;
  app_form_xmlns?: string;
}

export interface Invite {
  id: string;
  program_id: string;
  organization: string;                 // LLO org slug
  status: ProgramApplicationStatus;
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
  slug?: string;
}
