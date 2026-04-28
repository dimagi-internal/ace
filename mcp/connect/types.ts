// Connect domain types. Field names mirror what live Connect templates use
// (snake_case at the HTTP boundary). Confirmed via live probes 2026-04-28
// against /a/ai-demo-space/program/init/ and /opportunity/init/.

export interface Program {
  id: string;             // UUID — Connect routes use UUIDs (e.g. /program/067a73b8-.../)
  name: string;
  description: string;
  delivery_type: number;  // FK id (e.g. 1 = "Infant Vaccine Promotion", 3 = "Nutrition")
  budget: number;
  currency: string;       // ISO 4217 (e.g. "USD")
  country: string;        // ISO 3166-1 alpha-3 (e.g. "USA", "AFG")
  start_date: string;     // YYYY-MM-DD
  end_date: string;       // YYYY-MM-DD
  organization_slug?: string;  // The /a/<slug>/ org this program belongs to
}

export interface Opportunity {
  id: string;             // UUID
  program_id?: string;    // UUID; may be null for standalone opps
  name: string;
  short_description: string;  // ≤50 chars (mobile-app display)
  description: string;
  currency: string;
  country: string;
  hq_server: string;          // CommCare HQ server identifier (server FK)
  api_key: string;            // HQ API key used to read app metadata
  learn_app_domain: string;   // HQ project space for the Learn app
  learn_app: string;          // Learn app id on HQ
  learn_app_description?: string;
  learn_app_passing_score: number;  // 0-100
  deliver_app_domain: string;
  deliver_app: string;
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  organization_slug?: string;
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

/**
 * A "delivery type" is a Connect-managed enum. We surface the lookup so callers
 * can map a human-readable name (e.g. "Nutrition") to the int FK the form
 * expects. Populated by listing the program-init form and parsing the
 * <select name="delivery_type"> options.
 */
export interface DeliveryType {
  id: number;
  name: string;
}
