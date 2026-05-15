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
  /**
   * GPS radius (in meters) for the catchment-area / location-based
   * verification check. Surfaced through the form's `location` numeric
   * input on `/opportunity/<id>/verification_flags_config/`. Default 10m
   * (the form's pre-filled value); typical PDD specs are 100-500m.
   *
   * 0.13.240: renamed from `location: boolean` (which was misleading —
   * the form field has always been a number, never a boolean). Added
   * to fix the malaria-itn-fgd `gps-verification-radius` Decisions Log
   * row not being settable through the atom.
   */
  gps_radius_meters?: number;
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
  /**
   * **HTML-scraped path (`listPaymentUnits`):** display index from
   * the `payment_unit_table` page (1, 2, 3...) — *not* the server
   * integer ID. The server integer ID is not rendered in the
   * listing. The `payment_unit_uuid` field (below) is the only stable
   * identifier scrapable from the table (extracted from the row's
   * `payment_unit/<UUID>/edit` href; verified live 2026-05-06).
   *
   * **REST path:** server integer ID.
   *
   * Issue tracking: jjackson/ace#106 finding 5.
   */
  id: number;
  payment_unit_id?: number;             // legacy display id
  /**
   * UUID extracted from the row's edit link in the `payment_unit_table`
   * HTML (e.g. `aece2d58-bc28-41c0-ba77-5b4155652202`). Populated only
   * by the HTML-scrape path (`listPaymentUnits`). Useful for
   * downstream lookups against `/payment_unit/<uuid>/edit/` and as a
   * stable cross-run identifier when the integer server ID isn't
   * available. Undefined on the REST path.
   */
  payment_unit_uuid?: string;
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
  /**
   * **Unreliable on the HTML-scraped path (`listPaymentUnits`).** The
   * `payment_unit_table` page renders Total/Daily as a combined cell
   * that the scraper has historically mislabeled; verified live
   * 2026-05-15 against `malaria-itn-fgd/20260514-2352` Phase 4 where
   * `max_total=120, max_daily=30` was returned for a PU created with
   * `max_total=10, max_daily=2`. **Use the create-response equality
   * check** (compare `createPaymentUnit` return value against the input
   * args) rather than `listPaymentUnits` read-back to verify these
   * fields. REST path returns server values verbatim and IS reliable.
   * Issue tracking: jjackson/ace#106 finding 5 / turmeric-20260503-0835.
   */
  max_total?: number;
  /** **Unreliable on the HTML-scraped path.** See `max_total` JSDoc. */
  max_daily?: number;
  start_date?: string;
  end_date?: string;
  /**
   * **Unreliable on the HTML-scraped path (`listPaymentUnits`).** The
   * `payment_unit_table` page does not surface the deliver-unit list
   * — `listPaymentUnits` returns `[]` regardless of the actual
   * required_deliver_units configured. Use the create-response equality
   * check on `createPaymentUnit` (or the per-PU edit form via the
   * `payment_unit_uuid` link) to round-trip this field. REST path
   * returns server values verbatim and IS reliable.
   */
  required_deliver_units: number[];     // DU ids (server snake_case)
  optional_deliver_units: number[];
}

export interface DeliverUnit {
  /**
   * **HTML-scraped path (`listDeliverUnits`):** display index from
   * the `deliver_unit_table` page (1, 2, 3...) — *not* the server
   * integer ID. Connect's HTML for this listing does not expose the
   * server ID anywhere on the page (verified live 2026-05-06 against
   * leep-paint-collection opp `f14d8c5d-…` — no data-* attrs, no
   * hrefs, no hidden inputs).
   *
   * **REST path:** server integer ID (when this type is populated by
   * a future REST endpoint).
   *
   * For passing into `payment_unit.required_deliver_units`, prefer
   * `server_id` (which `listDeliverUnits` populates by reading the
   * create-payment-unit form's checkbox values). Issue tracking:
   * jjackson/ace#106 finding 5 (server-side fix needed to expose IDs
   * in the listing directly).
   */
  id: number;
  /**
   * Server-side primary key suitable for
   * `payment_unit.required_deliver_units` and `optional_deliver_units`.
   *
   * **HTML-scraped path:** populated opportunistically by
   * `listDeliverUnits` via a second fetch of the create-payment-unit
   * form (where Connect renders the PK as the `value` attribute on
   * each deliver-unit checkbox). When the second fetch fails (auth, 5xx,
   * sync-deliver-units precondition not satisfied), the field stays
   * `undefined` and callers fall back to the `id`+name mapping that
   * `createPaymentUnit` does internally.
   *
   * **REST path:** identical to `id` (REST returns the server PK as
   * the canonical identifier).
   *
   * Added 0.13.126. Before this, callers had to recover the server PK
   * from the create-time response of `connect_create_payment_unit` —
   * a chicken-and-egg gap that produced ad-hoc form-scrape probes per
   * Phase 4 run (see jjackson/ace#106 finding 5).
   */
  server_id?: number;
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
