/**
 * `commcare_create_api_key` — mint an HQ API key restricted to one project
 * space, via HQ's `/account/api_keys/` CRUD form (ApiKeyView, no REST API).
 *
 * Response shapes are HQ's own (corehq/apps/settings/views.py `ApiKeyView`,
 * corehq/apps/hqwebapp/views.py `CRUDPaginatedViewMixin`, read 2026-09-29):
 * create → `{newItem: {itemData, template} | {error} | null, form}`,
 * paginate → `{success, currentPage, total, paginatedList: [{itemData}]}`,
 * and a freshly created key's `itemData.key` is a 1-tuple (JSON list) of
 * `"<key>(Copy this in a secure place. It will not be shown again.)"`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommCareBackend, extractPlaintextApiKey } from '../../../../mcp/connect/backends/commcare.js';
import { hqKeyDir, resolveHqKeyRef, saveHqKey } from '../../../../lib/hq-api-key-store.js';

const KEY = '0123456789abcdef0123456789abcdef01234567';
const COPY_MSG = '(Copy this in a secure place. It will not be shown again.)';

function hqForm(existing: Array<{ id: number; name: string; domain: string }>, createReply?: unknown) {
  const calls: Array<Record<string, string>> = [];
  const request = {
    get: vi.fn(async () => ({ status: () => 200, text: async () => '', headers: () => ({}) })),
    post: vi.fn(async (_url: string, opts: { data: string }) => {
      const fields = Object.fromEntries(new URLSearchParams(opts.data));
      calls.push(fields);
      let body: unknown;
      if (fields.action === 'paginate') {
        body = { success: true, currentPage: 1, total: existing.length, paginatedList: existing.map((e) => ({ itemData: e })) };
      } else if (fields.action === 'delete') {
        body = { deletedItem: { itemData: { name: 'x' } } };
      } else {
        body = createReply ?? {
          newItem: {
            itemData: { id: 77, name: fields.name, domain: fields.domain, key: [`${KEY}${COPY_MSG}`] },
            template: 'new-user-api-key-template',
          },
          form: '<form></form>',
        };
      }
      return { status: () => 200, text: async () => JSON.stringify(body), headers: () => ({}) };
    }),
    storageState: vi.fn(async () => ({ cookies: [{ name: 'csrftoken', value: 'tok', domain: 'www.commcarehq.org' }] })),
  };
  const session = { getContext: async () => ({ request }), invalidate: async () => {} } as never;
  return { backend: new CommCareBackend({ baseUrl: 'https://www.commcarehq.org', session }), calls, request };
}

describe('extractPlaintextApiKey', () => {
  it('reads the 1-tuple HQ returns on create', () => {
    expect(extractPlaintextApiKey({ key: [`${KEY}${COPY_MSG}`] })).toBe(KEY);
  });
  it('prefers full_key when the SSO provider makes keys viewable', () => {
    expect(extractPlaintextApiKey({ key: 'abcd…4567', full_key: KEY })).toBe(KEY);
  });
  it('refuses a redacted key rather than returning garbage', () => {
    expect(() => extractPlaintextApiKey({ key: 'abcd…4567' })).toThrow(/readable key/);
  });
});

describe('CommCareBackend.createApiKey', () => {
  it('creates a key restricted to the domain and returns its plaintext', async () => {
    const { backend, calls } = hqForm([]);
    const r = await backend.createApiKey({ domain: 'connect-ace-spark', name: 'ace-clone-spark' });
    expect(r).toEqual({ id: 77, name: 'ace-clone-spark', domain: 'connect-ace-spark', key: KEY, rotated: false });
    const create = calls.find((c) => c.action === 'create');
    expect(create).toMatchObject({ domain: 'connect-ace-spark', name: 'ace-clone-spark', csrfmiddlewaretoken: 'tok' });
  });

  it('refuses to silently reuse a same-named key it can no longer read', async () => {
    const { backend, calls } = hqForm([{ id: 5, name: 'ace-clone-spark', domain: 'connect-ace-spark' }]);
    await expect(backend.createApiKey({ domain: 'connect-ace-spark', name: 'ace-clone-spark' })).rejects.toThrow(
      /already exists.*replace_existing/,
    );
    expect(calls.some((c) => c.action === 'create' || c.action === 'delete')).toBe(false);
  });

  it('rotates a same-named key when asked', async () => {
    const { backend, calls } = hqForm([{ id: 5, name: 'ace-clone-spark', domain: 'connect-ace-spark' }]);
    const r = await backend.createApiKey({ domain: 'connect-ace-spark', name: 'ace-clone-spark', replace_existing: true });
    expect(r.rotated).toBe(true);
    expect(calls.map((c) => c.action)).toEqual(['paginate', 'delete', 'create']);
    expect(calls[1].itemId).toBe('5');
  });

  it('surfaces a form rejection (e.g. a domain ace@ is not in)', async () => {
    const form = '<ul class="errorlist"><li>Select a valid choice.</li></ul>';
    const { backend } = hqForm([], { newItem: null, form });
    await expect(backend.createApiKey({ domain: 'not-mine', name: 'k' })).rejects.toThrow(/rejected the form/);
  });

  it('surfaces a duplicate-name error from HQ', async () => {
    const { backend } = hqForm([], { newItem: { error: 'Api Key with name "k" already exists.' }, form: '' });
    await expect(backend.createApiKey({ domain: 'd', name: 'k' })).rejects.toThrow(/already exists/);
  });
});

describe('hq-api-key-store', () => {
  let dir: string;
  const env = () => ({ ACE_HQ_KEY_DIR: dir }) as NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hqkeys-')), 'store');
  });
  afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

  it('stores owner-only and resolves the reference', () => {
    const ref = saveHqKey('ace-clone-spark', KEY, env());
    expect(ref).toBe('hq-key:ace-clone-spark');
    expect(resolveHqKeyRef(ref, env())).toBe(KEY);
    const mode = fs.statSync(path.join(hqKeyDir(env()), 'ace-clone-spark.key')).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(fs.statSync(hqKeyDir(env())).mode & 0o777).toBe(0o700);
  });

  it('passes non-references through unchanged', () => {
    expect(resolveHqKeyRef('${ACE_HQ_API_KEY}', env())).toBe('${ACE_HQ_API_KEY}');
    expect(resolveHqKeyRef(KEY, env())).toBe(KEY);
  });

  it('fails loudly for a reference with no stored key', () => {
    expect(() => resolveHqKeyRef('hq-key:missing', env())).toThrow(/no stored HQ key/);
  });

  it('rejects a name that could escape the store directory', () => {
    expect(() => saveHqKey('../evil', KEY, env())).toThrow(/invalid HQ key name/);
    expect(resolveHqKeyRef('hq-key:../evil', env())).toBe('hq-key:../evil');
  });
});
