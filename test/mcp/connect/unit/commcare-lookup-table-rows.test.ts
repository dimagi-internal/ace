/**
 * commcare_lookup_table_append_rows / commcare_get_lookup_table_rows —
 * ace#2853. Two HQ behaviours, both observed live on connect-ace-prod
 * 2026-10-13, made appended rows look lost while they were stored:
 *
 *  1. POST /api/v0.5/lookup_table_item/ answers `201` with an EMPTY Location
 *     header and an EMPTY body, so the old atom recovered no id and returned
 *     `{row_ids: []}` as success. The v2 resource (`/api/lookup_table_item/v2/`,
 *     `always_return_data = True`) returns the created row with its id.
 *  2. GET /api/v0.5/lookup_table_item/ has no Meta limit, so a bare GET is
 *     Tastypie's default page of 20 for the WHOLE domain (119 rows there) —
 *     a new table's rows sit beyond `meta.next` and read back as `[]`.
 */
import { describe, it, expect, vi } from 'vitest';
import { CommCareBackend } from '../../../../mcp/connect/backends/commcare.js';

const BASE = 'https://www.commcarehq.org';
const TABLE = 'ec1f9dcbbbd44f50a040f3d36d55ad72';
const OTHER = '574aa1be646744b39211bbd6fcde7f8f';

type Resp = { status: number; body: string; location?: string };
const resp = (r: Resp) => ({
  status: () => r.status,
  text: async () => r.body,
  headers: () => ({ location: r.location ?? '' }),
});

const item = (id: string, table: string, value: string) => ({
  id,
  data_type_id: table,
  fields: { setting_id: { field_list: [{ field_value: value, properties: {} }] } },
  item_attributes: {},
});

/** A domain of `nOther` rows in another table plus `mine` rows in TABLE, served in Tastypie pages. */
function makeBackend(opts: {
  post: (url: string, body: any) => Resp;
  rows: () => any[];
  pageSize?: number;
}) {
  const request = {
    get: vi.fn(async (url: string) => {
      const u = new URL(url);
      const all = opts.rows();
      // Mirror Tastypie: no `limit` → default 20; limit=0 → max (1000).
      const lim = u.searchParams.has('limit') ? Number(u.searchParams.get('limit')) || 1000 : 20;
      const size = Math.min(lim, opts.pageSize ?? lim);
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const objects = all.slice(offset, offset + size);
      const next = offset + size < all.length ? `?limit=${size}&offset=${offset + size}` : null;
      return resp({ status: 200, body: JSON.stringify({ meta: { limit: size, offset, next, total_count: all.length }, objects }) });
    }),
    post: vi.fn(async (url: string, init: { data: string }) => resp(opts.post(url, JSON.parse(init.data)))),
    storageState: vi.fn(async () => ({ cookies: [] })),
  };
  const session = { getContext: async () => ({ request }), invalidate: async () => {} };
  const be = new CommCareBackend({ baseUrl: BASE, session: session as never, hqUsername: 'ace@x', hqApiKey: 'k' });
  return { be, request };
}

const others = Array.from({ length: 25 }, (_, i) => item(`o${i}`.padEnd(32, '0'), OTHER, `x${i}`));

describe('appendLookupTableRows (ace#2853)', () => {
  it('throws on a 2xx that carries no row id — the v0.5 empty-201 shape is not success', async () => {
    const { be } = makeBackend({ post: () => ({ status: 201, body: '', location: '' }), rows: () => others });
    await expect(
      be.appendLookupTableRows({ domain: 'connect-ace-prod', table_id_or_tag: TABLE, rows: [{ setting_id: 'a' }] }),
    ).rejects.toThrow(/no row id/);
  });

  it('POSTs to the v2 resource, returns one id per row, and proves them on a paged read-back', async () => {
    const stored: any[] = [...others];
    let n = 0;
    const { be, request } = makeBackend({
      post: (_url, body) => {
        const id = `r${n++}`.padEnd(32, 'a');
        const row = { ...body, id };
        stored.push(row);
        return { status: 201, body: JSON.stringify({ ...row, resource_uri: '' }) };
      },
      rows: () => stored,
      pageSize: 20,
    });
    const rows = Array.from({ length: 9 }, (_, i) => ({ setting_id: `s${i}`, setting_value: String(i) }));
    const out = await be.appendLookupTableRows({ domain: 'connect-ace-prod', table_id_or_tag: TABLE, rows });
    expect(out.row_ids).toHaveLength(9);
    expect(request.post.mock.calls[0][0]).toBe(`${BASE}/a/connect-ace-prod/api/lookup_table_item/v2/`);
    const sent = JSON.parse(request.post.mock.calls[0][1].data);
    expect(sent).toMatchObject({
      data_type_id: TABLE,
      fields: { setting_id: { field_list: [{ field_value: 's0', properties: {} }] } },
    });
  });

  it('throws, naming the ids already written, when a returned id is absent on read-back', async () => {
    let n = 0;
    const { be } = makeBackend({
      post: (_url, body) => ({ status: 201, body: JSON.stringify({ ...body, id: `g${n++}`.padEnd(32, 'b') }) }),
      rows: () => others, // HQ "accepted" but the table never shows them
    });
    await expect(
      be.appendLookupTableRows({ domain: 'connect-ace-prod', table_id_or_tag: TABLE, rows: [{ setting_id: 'a' }] }),
    ).rejects.toThrow(/absent from table.*do not re-append/s);
  });
});

describe('getLookupTableRows reads every page (ace#2853)', () => {
  it('finds a table whose rows sit beyond the default page of 20', async () => {
    const mine = Array.from({ length: 9 }, (_, i) => item(`m${i}`.padEnd(32, 'c'), TABLE, `s${i}`));
    const { be } = makeBackend({ post: () => ({ status: 500, body: '' }), rows: () => [...others, ...mine], pageSize: 20 });
    const { rows } = await be.getLookupTableRows({ domain: 'connect-ace-prod', table_id_or_tag: TABLE });
    expect(rows.map((r) => r.fields.setting_id)).toEqual(mine.map((_, i) => `s${i}`));
  });
});
