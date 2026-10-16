/**
 * commcare_update_user_field must not echo HQ's system keys back (ace#3035).
 *
 * Live probe, connect-ace-prod 2026-10-16, Connect-provisioned worker
 * b08e461501104546946019bca674c920:
 *   PUT {user_data: <full echo incl. commcare_profile: "">} -> 500
 *   PUT {user_data: <echo minus commcare_profile>}         -> 200
 *   PUT {user_data: {kgrad_role: "FLW"}}                   -> 200, GET still shows every other key
 * So a SET sends only the one field, a CLEAR strips `commcare_*` keys, and
 * both re-GET and throw unless the field reads back as intended.
 */
import { describe, it, expect, vi } from 'vitest';
import { CommCareBackend, stripHqSystemUserData } from '../../../../mcp/connect/backends/commcare.js';

const ECHOED = {
  commcare_location_id: 'loc1',
  commcare_location_ids: 'loc1',
  commcare_primary_case_sharing_id: 'loc1',
  commcare_profile: '',
  commcare_project: 'connect-ace-prod',
  team: 'north',
};

/** GET returns `before` until the PUT lands, then `after`. */
function backend(before: Record<string, unknown>, after: Record<string, unknown>, putStatus = 200) {
  let put = false;
  const user = (ud: Record<string, unknown>) => JSON.stringify({ id: 'u1', username: 'w1', user_data: ud });
  const request = {
    get: vi.fn(async () => ({ status: () => 200, text: async () => user(put ? after : before), headers: () => ({}) })),
    fetch: vi.fn(async () => {
      put = true;
      return { status: () => putStatus, text: async () => 'Sorry, this request could not be processed', headers: () => ({}) };
    }),
    storageState: vi.fn(async () => ({ cookies: [] })),
  };
  const session = { getContext: async () => ({ request }), invalidate: async () => {} };
  const be = new CommCareBackend({
    baseUrl: 'https://www.commcarehq.org',
    session: session as never,
    hqUsername: 'ace@dimagi-ai.com',
    hqApiKey: 'k',
  } as never);
  const putBody = () => JSON.parse((request.fetch.mock.calls[0] as unknown as [string, { data: string }])[1].data);
  return { be, request, putBody };
}

describe('stripHqSystemUserData', () => {
  it('drops every commcare_* key and keeps custom fields', () => {
    expect(stripHqSystemUserData(ECHOED)).toEqual({ team: 'north' });
  });
});

describe('CommCareBackend.updateUserField', () => {
  it('SET PUTs only the one field: no commcare_profile echo', async () => {
    const { be, putBody } = backend(ECHOED, { ...ECHOED, kgrad_role: 'FLW' });
    await expect(
      be.updateUserField({ domain: 'connect-ace-prod', user_id: 'u1', field_slug: 'kgrad_role', value: 'FLW' }),
    ).resolves.toEqual({ user_id: 'u1', field_slug: 'kgrad_role', value: 'FLW' });
    expect(putBody()).toEqual({ user_data: { kgrad_role: 'FLW' } });
    expect(JSON.stringify(putBody())).not.toContain('commcare_profile');
  });

  it('CLEAR strips commcare_* system keys and the field from the echo', async () => {
    const { be, putBody } = backend({ ...ECHOED, kgrad_role: 'FLW' }, ECHOED);
    await be.updateUserField({ domain: 'connect-ace-prod', user_id: 'u1', field_slug: 'kgrad_role', value: null });
    expect(putBody()).toEqual({ user_data: { team: 'north' } });
  });

  it('throws when a SET does not read back', async () => {
    const { be } = backend(ECHOED, ECHOED);
    await expect(
      be.updateUserField({ domain: 'connect-ace-prod', user_id: 'u1', field_slug: 'kgrad_role', value: 'FLW' }),
    ).rejects.toThrow(/read-back disagrees.*kgrad_role="FLW".*\(absent\)/);
  });

  it('throws when a CLEAR does not land (HQ merged the omission away)', async () => {
    const stuck = { ...ECHOED, kgrad_role: 'FLW' };
    const { be } = backend(stuck, stuck);
    await expect(
      be.updateUserField({ domain: 'connect-ace-prod', user_id: 'u1', field_slug: 'kgrad_role', value: null }),
    ).rejects.toThrow(/read-back disagrees.*\(cleared\)/);
  });

  it('still surfaces a non-2xx PUT', async () => {
    const { be } = backend(ECHOED, ECHOED, 500);
    await expect(
      be.updateUserField({ domain: 'connect-ace-prod', user_id: 'u1', field_slug: 'kgrad_role', value: 'FLW' }),
    ).rejects.toThrow(/returned 500/);
  });
});
