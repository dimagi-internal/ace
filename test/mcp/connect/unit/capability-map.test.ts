import { describe, it, expect } from 'vitest';
import { CAPABILITY_MAP } from '../../../../mcp/connect/capability-map.js';

describe('connect capability map', () => {
  it('has 16 atoms', () => {
    expect(Object.keys(CAPABILITY_MAP)).toHaveLength(16);
  });

  it('every atom routes to PLAYWRIGHT or REST and has a documented restTarget', () => {
    for (const [name, route] of Object.entries(CAPABILITY_MAP)) {
      expect(['PLAYWRIGHT', 'REST'], `${name} backend`).toContain(route.backend);
      expect(route.restTarget, `${name} restTarget`).toMatch(/^(GET|POST|PATCH|PUT|DELETE) /);
    }
  });

  it('has the nine authoring atoms for the six blocked skills', () => {
    const authoring = [
      'create_program', 'update_program',
      'create_opportunity', 'update_opportunity',
      'set_verification_rules', 'set_delivery_units', 'set_payment_units',
      'activate_opportunity',
      'send_llo_invite',
    ];
    for (const a of authoring) expect(CAPABILITY_MAP).toHaveProperty(a);
  });

  it('has the seven observation atoms', () => {
    const observation = [
      'list_programs', 'get_program',
      'list_opportunities', 'get_opportunity',
      'list_invites',
      'list_invoices', 'get_invoice',
    ];
    for (const o of observation) expect(CAPABILITY_MAP).toHaveProperty(o);
  });
});
