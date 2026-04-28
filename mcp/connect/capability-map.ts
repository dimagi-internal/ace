export type Backend = 'REST' | 'PLAYWRIGHT';

export interface CapabilityRoute {
  backend: Backend;
  restTarget: string; // eventual REST endpoint, documentation only
}

export type Capability =
  // Authoring (9)
  | 'create_program'
  | 'update_program'
  | 'create_opportunity'
  | 'update_opportunity'
  | 'set_verification_rules'
  | 'set_delivery_units'
  | 'set_payment_units'
  | 'activate_opportunity'
  | 'send_llo_invite'
  // Observation (7)
  | 'list_programs'
  | 'get_program'
  | 'list_opportunities'
  | 'get_opportunity'
  | 'list_invites'
  | 'list_invoices'
  | 'get_invoice';

export const CAPABILITY_MAP: Record<Capability, CapabilityRoute> = {
  // Authoring — Playwright today, REST targets are documentation-only
  create_program:           { backend: 'PLAYWRIGHT', restTarget: 'POST /api/programs/' },
  update_program:           { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/programs/{id}/' },
  create_opportunity:       { backend: 'PLAYWRIGHT', restTarget: 'POST /api/opportunities/' },
  update_opportunity:       { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/opportunities/{id}/' },
  set_verification_rules:   { backend: 'PLAYWRIGHT', restTarget: 'PUT /api/opportunities/{id}/verification/' },
  set_delivery_units:       { backend: 'PLAYWRIGHT', restTarget: 'PUT /api/opportunities/{id}/delivery-units/' },
  set_payment_units:        { backend: 'PLAYWRIGHT', restTarget: 'PUT /api/opportunities/{id}/payment-units/' },
  activate_opportunity:     { backend: 'PLAYWRIGHT', restTarget: 'POST /api/opportunities/{id}/activate/' },
  send_llo_invite:          { backend: 'PLAYWRIGHT', restTarget: 'POST /api/opportunities/{id}/invites/' },

  // Observation — Playwright today (HTML scrapes), REST when available
  list_programs:            { backend: 'PLAYWRIGHT', restTarget: 'GET /api/programs/' },
  get_program:              { backend: 'PLAYWRIGHT', restTarget: 'GET /api/programs/{id}/' },
  list_opportunities:       { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/' },
  get_opportunity:          { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/' },
  list_invites:             { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/invites/' },
  list_invoices:            { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/invoices/' },
  get_invoice:              { backend: 'PLAYWRIGHT', restTarget: 'GET /api/invoices/{id}/' },
};
