export type Backend = 'REST' | 'PLAYWRIGHT';

export interface CapabilityRoute {
  backend: Backend;
  restTarget: string; // eventual REST endpoint, documentation only
}

/**
 * The 18 atoms exposed by `ace-connect`.
 *
 * History:
 * - 0.8.0 shipped 14 atoms (Programs CRUD, Opportunities CRUD, activate,
 *   invites, invoices). Verification/delivery/payment-unit atoms were
 *   dropped because the concepts didn't appear on the create form.
 * - 0.8.1 added the post-create configuration atoms after probing the live
 *   `/opportunity/<id>/verification_flags_config/`,
 *   `/opportunity/<id>/payment_unit/create`, and
 *   `/opportunity/<id>/deliver_unit_table` endpoints. The activation atom
 *   also moved off the imaginary `/activate/` URL onto the `active` flag
 *   on `/<id>/edit`.
 *
 * When real CCC-301 REST endpoints land, individual entries flip from
 * 'PLAYWRIGHT' to 'REST' one line at a time.
 */
export type Capability =
  // Authoring (10)
  | 'create_program'
  | 'update_program'
  | 'create_opportunity'
  | 'update_opportunity'
  | 'set_verification_flags'
  | 'create_payment_unit'
  | 'activate_opportunity'
  | 'send_llo_invite'
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
  // Authoring
  create_program:           { backend: 'PLAYWRIGHT', restTarget: 'POST /api/programs/' },
  update_program:           { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/programs/{id}/' },
  create_opportunity:       { backend: 'PLAYWRIGHT', restTarget: 'POST /api/opportunities/' },
  update_opportunity:       { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/opportunities/{id}/' },
  set_verification_flags:   { backend: 'PLAYWRIGHT', restTarget: 'PUT /api/opportunities/{id}/verification-flags/' },
  create_payment_unit:      { backend: 'PLAYWRIGHT', restTarget: 'POST /api/opportunities/{id}/payment-units/' },
  activate_opportunity:     { backend: 'PLAYWRIGHT', restTarget: 'POST /api/opportunities/{id}/activate/' },
  send_llo_invite:          { backend: 'PLAYWRIGHT', restTarget: 'POST /api/programs/{id}/invites/' },

  // Observation
  list_programs:            { backend: 'PLAYWRIGHT', restTarget: 'GET /api/programs/' },
  get_program:              { backend: 'PLAYWRIGHT', restTarget: 'GET /api/programs/{id}/' },
  list_delivery_types:      { backend: 'PLAYWRIGHT', restTarget: 'GET /api/delivery-types/' },
  list_opportunities:       { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/' },
  get_opportunity:          { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/' },
  list_deliver_units:       { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/deliver-units/' },
  list_payment_units:       { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/payment-units/' },
  list_invites:             { backend: 'PLAYWRIGHT', restTarget: 'GET /api/programs/{id}/invites/' },
  list_invoices:            { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/invoices/' },
  get_invoice:              { backend: 'PLAYWRIGHT', restTarget: 'GET /api/invoices/{id}/' },
};
