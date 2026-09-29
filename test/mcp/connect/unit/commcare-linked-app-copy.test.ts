/**
 * commcare_linked_app_copy — new-app id recovery (ace#2551).
 *
 * The atom used to find the copy by re-listing the downstream domain through
 * HQ's REST API. A project space without an API-enabled plan answers that with
 * 401 "Your current subscription does not have access to this feature", and
 * every space clone-to-new-workspace creates is one — so on the first Spark
 * clone (2026-09-29, connect-ace-spark) it reported failure after each
 * SUCCESSFUL copy. HQ's copy_app redirect already names the new app
 * (`_copy_app_helper` → `back_to_main(app_copy.domain, app_copy._id)`), so the
 * id comes from there. A failed LINKED copy also 302s — to the SOURCE app's
 * settings — so the domain and id are checked, not just the URL shape.
 */
import { describe, it, expect, vi } from 'vitest';
import { CommCareBackend, newAppIdFromCopyRedirect } from '../../../../mcp/connect/backends/commcare.js';

const SRC = '696ecd4baa49479cbcfb4ec2585aa99b';
const NEW = 'e8d1bb1f559b43d8a57c3148793c78dc';
const SUBSCRIPTION_401 = '{"error": "Your current subscription does not have access to this feature"}';

function backend(postLocation: string, listStatus = 401, listBody = SUBSCRIPTION_401) {
  const calls: string[] = [];
  const request = {
    get: vi.fn(async (url: string) => {
      calls.push(`GET ${url}`);
      return { status: () => listStatus, text: async () => listBody, headers: () => ({}) };
    }),
    post: vi.fn(async (url: string) => {
      calls.push(`POST ${url}`);
      return { status: () => 302, text: async () => '', headers: () => ({ location: postLocation }) };
    }),
    storageState: vi.fn(async () => ({ cookies: [{ name: 'csrftoken', value: 'c', domain: 'www.commcarehq.org' }] })),
  };
  const session = { getContext: async () => ({ request }), invalidate: async () => {} };
  return { calls, be: new CommCareBackend({ baseUrl: 'https://www.commcarehq.org', session: session as never }) };
}

const ARGS = {
  upstream_domain: 'connect-ace-prod',
  upstream_app_id: SRC,
  downstream_domain: 'connect-ace-spark',
  name: 'Spark Facilitator Learn app',
  linked: false,
};

describe('newAppIdFromCopyRedirect', () => {
  it('takes the id from a redirect into the downstream domain', () => {
    expect(newAppIdFromCopyRedirect(`/a/connect-ace-spark/apps/view/${NEW}/`, 'connect-ace-spark', SRC)).toBe(NEW);
    expect(newAppIdFromCopyRedirect(`https://www.commcarehq.org/a/connect-ace-spark/apps/view/${NEW}/?x=1`, 'connect-ace-spark', SRC)).toBe(NEW);
  });
  it('rejects the failed-linked-copy redirect to the SOURCE app settings', () => {
    expect(newAppIdFromCopyRedirect(`/a/connect-ace-prod/apps/view/${SRC}/settings/`, 'connect-ace-spark', SRC)).toBeNull();
  });
  it('rejects the source id even under the downstream domain, and non-app redirects', () => {
    expect(newAppIdFromCopyRedirect(`/a/connect-ace-spark/apps/view/${SRC}/`, 'connect-ace-spark', SRC)).toBeNull();
    expect(newAppIdFromCopyRedirect('/a/connect-ace-spark/dashboard/', 'connect-ace-spark', SRC)).toBeNull();
  });
});

describe('CommCareBackend.createLinkedAppCopy', () => {
  it('returns the redirect id without touching the REST API (works on a free-plan space)', async () => {
    const { be, calls } = backend(`/a/connect-ace-spark/apps/view/${NEW}/`);
    await expect(be.createLinkedAppCopy(ARGS)).resolves.toEqual({ id: NEW, name: ARGS.name });
    expect(calls).toEqual(['POST https://www.commcarehq.org/a/connect-ace-prod/apps/copy_app/']);
  });

  it('falls back to the re-list when the redirect is not a copy into the downstream domain', async () => {
    const { be, calls } = backend(`/a/connect-ace-prod/apps/view/${SRC}/settings/`, 200,
      JSON.stringify({ objects: [{ id: NEW, name: ARGS.name }] }));
    await expect(be.createLinkedAppCopy(ARGS)).resolves.toEqual({ id: NEW, name: ARGS.name });
    expect(calls[1]).toBe('GET https://www.commcarehq.org/a/connect-ace-spark/api/v0.4/application/');
  });
});

describe('CommCareBackend.listApps on a space without API access', () => {
  it('says the 401 is "no API in plan OR no such space", not "not found"', async () => {
    const { be } = backend('');
    await expect(be.listApps({ domain: 'connect-ace-spark' })).rejects.toThrow(/HQ_API_NOT_IN_PLAN[\s\S]*does not exist/);
  });
});
