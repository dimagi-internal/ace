import type {
  Program,
  Opportunity,
  ProgramApplication,
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
    delivery_type: number | string;     // accepts the slug or the int FK
    budget: number;
    currency: string;                   // ISO 4217 code (e.g. "USD")
    country: string;                    // human country name as Connect renders it (e.g. "United States of America")
    start_date: string;                 // YYYY-MM-DD
    end_date: string;                   // YYYY-MM-DD
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

  // Opportunities
  //
  // `createOpportunity` creates a *managed* opportunity scoped to a program
  // — the only shape ACE needs. The server resolves HQ creds, registers the
  // HQ API key, fetches app names, and syncs learn modules + deliver units
  // synchronously. Returns the opp with `learn_modules` and `deliver_units`
  // already populated, so callers don't need a follow-up `list_deliver_units`
  // before `create_payment_units`.
  listOpportunities(args: { organization_slug: string; program_id?: string; name?: string }): Promise<{ opportunities: Opportunity[] }>;
  getOpportunity(args: { organization_slug: string; opportunity_id: string }): Promise<Opportunity>;
  createOpportunity(args: {
    organization_slug: string;          // PM-side org running the program
    program_id: string;                 // program UUID — required (managed opp)
    name: string;
    short_description: string;          // ≤ 255 chars
    description: string;
    target_organization_slug?: string;  // LLO org slug; optional. When omitted the REST backend sends organization_slug (the PM org) as the holding org — the deployment rejects organization=None (jjackson/ace#700)
    start_date: string;                 // YYYY-MM-DD; must fit inside the program's window
    end_date: string;                   // YYYY-MM-DD
    total_budget: number;               // must fit inside program.budget − Σ(other managed opps)
    is_test?: boolean;                  // defaults true server-side
    /**
     * If `true` (default), call `activateOpportunity` after a successful
     * create and return an opportunity with truly-active server state.
     * The create response's `active: true` is set in the Connect DB but
     * the activation hook hasn't run yet, so downstream endpoints (e.g.
     * `sendFlwInvite`'s `invite_users/`) reject the opp until activate
     * is called. Verified live on `malaria-itn-fgd/20260514-2352`
     * Phase 4: invite endpoint rejected with "Opportunity must be active
     * to invite users" until an explicit activate. Set `false` to opt
     * out (rare — for drafts that intentionally stay inactive).
     */
    auto_activate?: boolean;
    learn_app: {
      hq_server_url: string;            // e.g. https://www.commcarehq.org
      api_key: string;                  // raw 40-char HQ key; server creates HQApiKey if not present
      cc_domain: string;                // HQ project space slug
      cc_app_id: string;                // bare HQ app id
      description: string;              // required (Connect form *)
      passing_score: number;            // 0–100
    };
    deliver_app: {
      hq_server_url: string;
      api_key: string;                  // can be the same as learn_app.api_key
      cc_domain: string;                // HQ project space slug
      cc_app_id: string;                // must differ from learn_app.cc_app_id
    };
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

  /**
   * Create one or more payment units. Connect's automation API takes a list
   * — atomic transaction across all entries — so we expose `createPaymentUnits`
   * (plural). For convenience `createPaymentUnit` (singular) wraps a one-item
   * call; both share the validation rules (no DU id may appear in two PUs in
   * the same request, no DU may already be assigned to another PU, managed
   * opps require `org_amount`).
   */
  createPaymentUnits(args: {
    organization_slug: string;
    opportunity_id: string;
    /**
     * The opportunity's `total_budget` (whole-currency-unit integer — the SAME
     * value passed to `createOpportunity`). When supplied, the backend enforces
     * `total_budget ≥ Σ(max_total × (amount + org_amount))` (i.e.
     * `number_of_users ≥ 1`) over the integers in this request BEFORE POSTing,
     * throwing `OpportunityUnderfundedError` otherwise. Guard-only — never sent
     * to Connect. Omit to skip the guard (back-compat). See jjackson/ace#729.
     */
    total_budget?: number;
    payment_units: Array<{
      name: string;
      description?: string;
      amount: number;                   // FLW pay per unit (non-negative integer)
      org_amount?: number;              // LLO pay per unit; REQUIRED for managed opps
      max_total: number;                // ≥ 1 — total visits per user across the opportunity
      max_daily: number;                // ≥ 1 — visits per user per day
      required_deliver_units?: number[]; // DU ids (Connect-side ints from `list_deliver_units`)
      optional_deliver_units?: number[];
      start_date?: string;              // YYYY-MM-DD; defaults to opportunity dates
      end_date?: string;
    }>;
  }): Promise<{ payment_units: PaymentUnit[] }>;
  createPaymentUnit(args: {
    organization_slug: string;
    opportunity_id: string;
    /** See `createPaymentUnits.total_budget` — enables the funds-≥1-FLW guard. */
    total_budget?: number;
    name: string;
    description?: string;
    amount: number;
    org_amount?: number;
    max_total: number;
    max_daily: number;
    start_date?: string;
    end_date?: string;
    required_deliver_units?: number[];
    optional_deliver_units?: number[];
  }): Promise<PaymentUnit>;
  listPaymentUnits(args: {
    organization_slug: string;
    opportunity_id: string;
  }): Promise<{ payment_units: PaymentUnit[] }>;

  // Lifecycle
  activateOpportunity(args: {
    organization_slug: string;
    opportunity_id: string;
  }): Promise<{ id: number; opportunity_id: string; name: string; active: true }>;

  // Program applications (LLO invite + auto-accept)
  //
  // `sendLloInvite` invites an LLO organization to a Program. Connect emails
  // the LLO admins via `send_program_invite_email`; status is INVITED.
  // `acceptProgramApplication` is the automation shortcut — moves the
  // application from INVITED/APPLIED → ACCEPTED. Required before the LLO
  // can be assigned as a managed opportunity's organization.
  sendLloInvite(args: {
    organization_slug: string;          // PM-side org running the program
    program_id: string;                 // program UUID
    organization: string;               // LLO org slug to invite
  }): Promise<ProgramApplication>;
  acceptProgramApplication(args: {
    organization_slug: string;          // PM-side org (same as program owner)
    program_id: string;
    application_id: string;             // ProgramApplication UUID returned by sendLloInvite
  }): Promise<ProgramApplication>;
  listInvites(args: { organization_slug: string; program_id: string }): Promise<{ invites: Invite[] }>;

  /**
   * Invite one or more FLWs (by phone) to an opportunity. Server validates
   * that the opportunity is active and not ended, queues
   * `add_connect_users.delay(...)`, and returns 202 with `invited_count`.
   *
   * Used by `connect-opp-setup` Step 7 to keep `${ACE_E2E_PHONE}` invited
   * to the latest ACE-created opp; the test user's PersonalID registration
   * depends on at least one Connect invite existing for the phone (Sentry
   * CONNECT-ID-3F).
   */
  sendFlwInvite(args: {
    organization_slug: string;
    opportunity_id: string;             // actual opportunity UUID
    phone_numbers: string[];            // e.g. ['+74260000100']
  }): Promise<{
    opportunity_id: string;
    phone_numbers: string[];
    invited_count: number;
    status: 'queued';
  }>;

  /**
   * Hard-delete unaccepted FLW invites by their integer ids. Invites with
   * `status=accepted` are silently skipped server-side (those represent
   * real workers who've joined; they cannot be deleted via this endpoint).
   * Associated `OpportunityAccess` rows are cascade-deleted.
   *
   * Used by `/ace:sweep connect` to clean up orphan invites tied to
   * deactivated opportunities. POST to the `@csrf_exempt` HTML view at
   * `/a/<org_slug>/opportunity/<opp_id>/delete_invites/`; no REST API
   * equivalent. The `<opp_id>` here is the opportunity's UUID slug
   * (matches `Opportunity.opportunity_id`); `user_invite_ids` are the
   * integer ids returned by `connect_list_invites`.
   *
   * Returns the requested count; the server returns 200 with an `HX-Redirect`
   * header but no body breakdown of how many of the requested ids were
   * actually deleted (e.g. some may have been accepted and skipped).
   * Callers that need a precise count should re-list invites afterwards.
   */
  deleteUnacceptedFlwInvites(args: {
    organization_slug: string;
    opportunity_id: string;             // opportunity UUID slug
    user_invite_ids: number[];          // integer ids from connect_list_invites
  }): Promise<{ requested: number }>;

  /**
   * Invite a human user to a Connect workspace (organization) by email.
   * Connect calls this an "organization membership"; the user gets an
   * email with an accept-invite link and appears in the member table
   * immediately (pending until they accept).
   *
   * POST to the HTML form view `/a/<org_slug>/organization/member`
   * (Django name `organization:add_members`); there is no REST API
   * equivalent. The view is `@org_admin_required`, so the authenticated
   * ACE session user MUST be an admin of the target org, or the POST
   * 403s.
   *
   * Two Connect-side rules the caller can't bypass (enforced by
   * `MembershipForm.clean_email`):
   *   1. The email must belong to an EXISTING Connect user — Connect
   *      does not provision accounts from an invite. Unknown emails are
   *      rejected.
   *   2. The user must NOT already be a member of this org.
   * Both surface as the SAME server message ("User with this email does
   * not exist or is already a member"), and — critically — the view
   * still 302-redirects on validation failure (it does not re-render the
   * error). So this method CANNOT read success off the POST status; it
   * verifies by reading back `/a/<org_slug>/organization/member_table`
   * (which renders `user__email`) and confirming the email is present.
   * On absence it throws a typed ConnectValidationError with the
   * documented reason.
   *
   * `role` is one of Connect's `UserOrganizationMembership.Role` values:
   * `admin` | `member` | `viewer` (default `member`).
   */
  addOrgMember(args: {
    organization_slug: string;
    email: string;
    role?: 'admin' | 'member' | 'viewer';
  }): Promise<{
    organization_slug: string;
    email: string;
    role: 'admin' | 'member' | 'viewer';
    status: 'invited';
  }>;

  // Invoices
  listInvoices(args: { organization_slug: string; opportunity_id: string }): Promise<{ invoices: Invoice[] }>;
  getInvoice(args: { organization_slug: string; invoice_id: string }): Promise<Invoice>;
}
