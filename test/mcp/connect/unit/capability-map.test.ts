import { describe, it, expect } from 'vitest';
import { CAPABILITY_MAP } from '../../../../mcp/connect/capability-map.js';

describe('connect capability map', () => {
  it('every restTarget starts with HTTP method + space (documents the canonical REST URL)', () => {
    // Backend types are enforced by TS (Backend = 'PLAYWRIGHT' | 'REST'); the
    // restTarget string format is not, so we check it here.
    for (const [name, route] of Object.entries(CAPABILITY_MAP)) {
      expect(route.restTarget, `${name} restTarget`).toMatch(/^(GET|POST|PATCH|PUT|DELETE) /);
    }
  });

  it('has the eleven authoring atoms', () => {
    const authoring = [
      'create_program', 'update_program',
      'create_opportunity', 'update_opportunity',
      'set_verification_flags',
      'create_payment_unit', 'create_payment_units',
      'activate_opportunity',
      'send_llo_invite', 'accept_program_application',
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

  it('routes the seven PR #1135 automation-API atoms to REST', () => {
    const restAtoms = [
      'create_program',
      'create_opportunity',
      'create_payment_unit',
      'create_payment_units',
      'activate_opportunity',
      'send_llo_invite',
      'accept_program_application',
      'send_flw_invite',
    ];
    for (const a of restAtoms) {
      const route = CAPABILITY_MAP[a as keyof typeof CAPABILITY_MAP];
      expect(route?.backend, `${a} should be REST`).toBe('REST');
    }
  });
});
