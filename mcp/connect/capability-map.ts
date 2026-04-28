export type Backend = 'REST' | 'PLAYWRIGHT';

export interface CapabilityRoute {
  backend: Backend;
  restTarget: string; // eventual REST endpoint, documentation only
}

/**
 * The 14 atoms exposed by `ace-connect`.
 *
 * History: the original spec called for 16 atoms including
 * set_verification_rules / set_delivery_units / set_payment_units. Live
 * probing of Connect on 2026-04-28 showed those concepts are NOT present
 * on the program or opportunity create/edit pages — they likely live on a
 * post-creation page or aren't yet built for the org type ace operates in.
 * Dropped from v1; revisit once we find the page.
 */
export type Capability =
  // Authoring (7)
  | 'create_program'
  | 'update_program'
  | 'create_opportunity'
  | 'update_opportunity'
  | 'activate_opportunity'
  | 'send_llo_invite'
  | 'update_program'
  // Observation (7)
  | 'list_programs'
  | 'get_program'
  | 'list_delivery_types'
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
  activate_opportunity:     { backend: 'PLAYWRIGHT', restTarget: 'POST /api/opportunities/{id}/activate/' },
  send_llo_invite:          { backend: 'PLAYWRIGHT', restTarget: 'POST /api/opportunities/{id}/invites/' },

  // Observation — Playwright today (HTML scrapes), REST when available
  list_programs:            { backend: 'PLAYWRIGHT', restTarget: 'GET /api/programs/' },
  get_program:              { backend: 'PLAYWRIGHT', restTarget: 'GET /api/programs/{id}/' },
  list_delivery_types:      { backend: 'PLAYWRIGHT', restTarget: 'GET /api/delivery-types/' },
  list_opportunities:       { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/' },
  get_opportunity:          { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/' },
  list_invites:             { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/invites/' },
  list_invoices:            { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/invoices/' },
  get_invoice:              { backend: 'PLAYWRIGHT', restTarget: 'GET /api/invoices/{id}/' },
};
