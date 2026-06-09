export type Backend = 'REST' | 'PLAYWRIGHT';

export interface CapabilityRoute {
  backend: Backend;
  restTarget: string;
}

/**
 * The 20 atoms exposed by `ace-connect`.
 *
 * History:
 * - 0.8.0 shipped 14 atoms (Programs CRUD, Opportunities CRUD, activate,
 *   invites, invoices). Verification/delivery/payment-unit atoms were
 *   dropped because the concepts didn't appear on the create form.
 * - 0.8.1 added the post-create configuration atoms after probing live
 *   `/opportunity/<id>/verification_flags_config/`,
 *   `/opportunity/<id>/payment_unit/create`, and
 *   `/opportunity/<id>/deliver_unit_table` endpoints. Activation moved off
 *   the imaginary `/activate/` URL onto the `active` flag on `/<id>/edit`.
 * - 0.10.15 added `register_hq_api_key` so agents could register / look up
 *   the Connect-side int FK for an HQ API key without driving the whole
 *   create-opportunity flow.
 * - 0.10.47 (this version) adopts commcare-connect PR #1135's automation
 *   API (`/api/programs/...`, `/api/opportunities/...`) for the seven
 *   write atoms it shipped. `register_hq_api_key` and `finalize_opportunity`
 *   are removed — `create_opportunity` now takes raw HQ creds and dates +
 *   total_budget upfront, so neither atom has a job. `accept_program_application`
 *   is added as the new automation shortcut for ACE-driven dogfood runs.
 *
 * - 0.13.x added `add_org_member` — invite a human user to a Connect
 *   workspace (organization) by email. Playwright HTML-form POST to
 *   `/a/<org>/organization/member`; no REST equivalent. Requires the ACE
 *   session user to be an org admin and the invitee to already have a
 *   Connect account (Connect's `MembershipForm.clean_email` rejects
 *   unknown emails). Verified by read-back of `/organization/member_table`.
 *
 * `REST` = JSON to the new automation API endpoints, mediated by the
 * authenticated session cookie + CSRF token. There is no token auth path
 * yet; the session is still established via OAuth-with-CommCareHQ.
 */
export type Capability =
  // Authoring (10)
  | 'create_program'
  | 'update_program'
  | 'create_opportunity'
  | 'update_opportunity'
  | 'set_verification_flags'
  | 'create_payment_unit'
  | 'create_payment_units'
  | 'activate_opportunity'
  | 'send_llo_invite'
  | 'accept_program_application'
  | 'send_flw_invite'
  | 'delete_unaccepted_flw_invites'
  | 'add_org_member'
  // Observation (10)
  | 'list_programs'
  | 'get_program'
  | 'list_delivery_types'
  | 'list_opportunities'
  | 'get_opportunity'
  | 'list_deliver_units'
  | 'list_payment_units'
  | 'list_invites'
  | 'list_invoices'
  | 'get_invoice';

export const CAPABILITY_MAP: Record<Capability, CapabilityRoute> = {
  // Authoring — REST since 0.10.47 (PR #1135 automation API)
  create_program:               { backend: 'REST',       restTarget: 'POST /api/programs/' },
  update_program:               { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/programs/{id}/ (not yet shipped)' },
  create_opportunity:           { backend: 'REST',       restTarget: 'POST /api/programs/{program_id}/opportunities/' },
  update_opportunity:           { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/opportunities/{id}/ (not yet shipped)' },
  set_verification_flags:       { backend: 'PLAYWRIGHT', restTarget: 'PUT /api/opportunities/{id}/verification-flags/ (not yet shipped)' },
  create_payment_unit:          { backend: 'REST',       restTarget: 'POST /api/opportunities/{id}/payment_units/' },
  create_payment_units:         { backend: 'REST',       restTarget: 'POST /api/opportunities/{id}/payment_units/' },
  activate_opportunity:         { backend: 'REST',       restTarget: 'POST /api/opportunities/{id}/activate/' },
  send_llo_invite:              { backend: 'REST',       restTarget: 'POST /api/programs/{program_id}/applications/' },
  accept_program_application:   { backend: 'REST',       restTarget: 'POST /api/programs/{program_id}/applications/{application_id}/accept/' },
  send_flw_invite:              { backend: 'REST',       restTarget: 'POST /api/opportunities/{id}/invite_users/' },
  delete_unaccepted_flw_invites: { backend: 'PLAYWRIGHT', restTarget: 'DELETE /api/opportunities/{id}/invites/ (not yet shipped)' },
  add_org_member:               { backend: 'PLAYWRIGHT', restTarget: 'POST /a/{org}/organization/member (HTML form; no REST equiv)' },

  // Observation — still HTML-scrape; PR #1135 didn't ship reads
  list_programs:                { backend: 'PLAYWRIGHT', restTarget: 'GET /api/programs/ (not yet shipped)' },
  get_program:                  { backend: 'PLAYWRIGHT', restTarget: 'GET /api/programs/{id}/ (not yet shipped)' },
  list_delivery_types:          { backend: 'PLAYWRIGHT', restTarget: 'GET /api/delivery-types/ (not yet shipped)' },
  list_opportunities:           { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/ (not yet shipped)' },
  get_opportunity:              { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/ (not yet shipped)' },
  list_deliver_units:           { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/deliver-units/ (not yet shipped)' },
  list_payment_units:           { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/payment-units/ (not yet shipped)' },
  list_invites:                 { backend: 'PLAYWRIGHT', restTarget: 'GET /api/programs/{id}/applications/ (not yet shipped)' },
  list_invoices:                { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/invoices/ (not yet shipped)' },
  get_invoice:                  { backend: 'PLAYWRIGHT', restTarget: 'GET /api/invoices/{id}/ (not yet shipped)' },
};
