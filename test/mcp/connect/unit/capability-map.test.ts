import { describe, it, expect } from 'vitest';
import { CAPABILITY_MAP } from '../../../../mcp/connect/capability-map.js';

describe('connect capability map', () => {
  it('has 20 atoms', () => {
    expect(Object.keys(CAPABILITY_MAP)).toHaveLength(20);
  });

  it('every atom routes to PLAYWRIGHT or REST and has a documented restTarget', () => {
    for (const [name, route] of Object.entries(CAPABILITY_MAP)) {
      expect(['PLAYWRIGHT', 'REST'], `${name} backend`).toContain(route.backend);
      expect(route.restTarget, `${name} restTarget`).toMatch(/^(GET|POST|PATCH|PUT|DELETE) /);
    }
  });

  it('has the ten authoring atoms', () => {
    const authoring = [
      'create_program', 'update_program',
      'create_opportunity', 'update_opportunity',
      'register_hq_api_key',
      'set_verification_flags',
      'create_payment_unit',
      'activate_opportunity',
      'send_llo_invite',
      'send_flw_invite',
    ];
    for (const a of authoring) expect(CAPABILITY_MAP).toHaveProperty(a);
  });

  it('has the ten observation atoms', () => {
    const observation = [
      'list_programs', 'get_program',
      'list_delivery_types',
      'list_opportunities', 'get_opportunity',
      'list_deliver_units',
      'list_payment_units',
      'list_invites',
      'list_invoices', 'get_invoice',
    ];
    for (const o of observation) expect(CAPABILITY_MAP).toHaveProperty(o);
  });
});
