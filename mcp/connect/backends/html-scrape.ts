/**
 * HTML-scrape helpers for the Connect Playwright backend.
 *
 * Each helper is a pure function with a unit test against a fixture in
 * test/fixtures/connect-html/. When Connect changes a template upstream,
 * the corresponding regex test fails first — integration tests don't have to.
 *
 * All regex anchors below are confirmed against fixtures captured 2026-04-28
 * from /a/ai-demo-space/program/ (and friends).
 */

import type { DeliveryType, Program, Opportunity, Invite, DeliverUnit, PaymentUnit } from '../types.js';

/**
 * Extract Connect's CSRF token from a rendered HTML page.
 *
 * Connect runs Django with `CSRF_USE_SESSIONS=True` (no `Set-Cookie:
 * csrftoken=...` header), so the token must come from the body. Two
 * shapes have shipped, in order of recency:
 *
 *   1. **`hx-headers` on `<body>`** (current, verified 2026-05-06): every
 *      HTMX request inherits a `X-CSRFToken` header from a body-level
 *      attribute. Connect's templates moved here at some point between
 *      0.13.24 (when this function shipped) and 0.13.30. This is the
 *      canonical path now: any authed page renders `<body
 *      hx-headers='{"X-CSRFToken": "..."}'>` and the token is good for
 *      every form on that page and for the `X-CSRFToken` header that
 *      ACE's REST backend sends.
 *
 *   2. **`<input type="hidden" name="csrfmiddlewaretoken">`** (legacy):
 *      Django's `{% csrf_token %}` template tag's default rendering.
 *      Some fixture-era pages still match this; kept as a fallback so
 *      pre-template-migration fixtures continue to verify.
 *
 * Returns the first match, hx-headers preferred. Surfaced 2026-05-06
 * via `csrfmiddlewaretoken not found in Connect HTML after auth` on a
 * clean machine — the 0.13.24 single-pattern match didn't see the new
 * shape.
 */
export function extractFormCsrfToken(html: string): string | undefined {
  // Pattern 1 (current): hx-headers='{"X-CSRFToken": "<value>"}' on <body>.
  // Tolerant of either outer quote style; Connect uses single-quote outer
  // + double-quote JSON keys, but template authors could flip these.
  const hxMatch = html.match(/hx-headers\s*=\s*['"][^'"]*"X-CSRFToken"\s*:\s*"([^"]+)"/);
  if (hxMatch) return hxMatch[1];
  // Pattern 2 (legacy): csrfmiddlewaretoken hidden input.
  const formMatch = html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/);
  return formMatch?.[1];
}

/** Extract a UUID from a redirect Location like `/a/<org>/program/<uuid>/...`. */
export function extractUuidFromPath(loc: string, segment: string): string | undefined {
  const m = loc.match(new RegExp(`/${segment}/([a-f0-9-]{36})(?:/|$)`));
  return m?.[1];
}

/**
 * Parse Connect's `<select name="delivery_type">` options into a typed list.
 * Skips the placeholder option (value="").
 */
export function parseDeliveryTypeOptions(html: string): DeliveryType[] {
  const selectMatch = html.match(/<select[^>]*name="delivery_type"[^>]*>([\s\S]*?)<\/select>/);
  if (!selectMatch) return [];
  const out: DeliveryType[] = [];
  for (const m of selectMatch[1].matchAll(/<option\s+value="(\d+)"[^>]*>\s*([^<]+?)\s*<\/option>/g)) {
    const id = Number(m[1]);
    const name = m[2].replace(/\s+/g, ' ').trim();
    if (Number.isFinite(id) && name && name !== '---------') out.push({ id, name });
  }
  return out;
}

/**
 * Parse Connect's program list page into Program records. Each row is a card:
 *
 *   <p class="card_title">NAME</p>
 *   <p class="card_description ...">DESCRIPTION</p>
 *   <button hx-get="/a/<org>/program/<uuid>/edit" ...>
 *
 * We anchor on the edit-button URL for the UUID (it always exists for
 * admin-side rows), then walk back to find the card_title in the same card
 * container. The pure-string approach: scan card containers, then within
 * each one extract uuid + name + description.
 */
export function parseProgramsList(html: string): Program[] {
  const out: Program[] = [];
  // Match each program card. The row container has `x-data="{showOpp: ...}"`
  // and contains card_title, card_description, and an edit button URL.
  const cardRegex = /<div[^>]*x-data="{showOpp[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*x-data="{showOpp|<\/div>\s*<\/div>\s*<\/div>)/g;
  for (const card of html.matchAll(cardRegex)) {
    const body = card[1];
    const titleMatch = body.match(/<p class="card_title"[^>]*>([\s\S]*?)<\/p>/);
    const descMatch = body.match(/<p class="card_description[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const uuidMatch = body.match(/\/program\/([a-f0-9-]{36})\/edit/);
    if (titleMatch && uuidMatch) {
      out.push({
        id: uuidMatch[1],
        name: titleMatch[1].replace(/<[^>]+>/g, '').trim(),
        description: descMatch?.[1].replace(/<[^>]+>/g, '').trim() ?? '',
        // Fields not displayed on the list view default to empty/zero — the caller
        // can hydrate via getProgram() if needed.
        delivery_type: 0,
        budget: 0,
        currency: '',
        country: '',
        start_date: '',
        end_date: '',
      });
    }
  }
  return out;
}

/**
 * Parse Connect's opportunity list page. Each row contains an anchor:
 *   <a href=/a/<org>/opportunity/<uuid>/ class="flex flex-col ...">
 *     <p class="text-sm text-slate-900">NAME</p>
 *     <p class="text-xs text-slate-400">SUBTITLE</p>
 *   </a>
 * (Confirmed live 2026-04-28 against march-demo's opportunity list.)
 */
export function parseOpportunitiesList(html: string): Pick<Opportunity, 'id' | 'name' | 'short_description'>[] {
  const out: Pick<Opportunity, 'id' | 'name' | 'short_description'>[] = [];
  // Match anchors that wrap the title block. The anchor's class is "flex flex-col items-start"
  const anchorRegex = /<a\s+href=["']?\/a\/[^/]+\/opportunity\/([a-f0-9-]{36})\/?["']?[^>]*class="[^"]*flex flex-col[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(anchorRegex)) {
    const id = m[1];
    const inner = m[2];
    const ps = [...inner.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((p) => p[1].replace(/<[^>]+>/g, '').trim());
    if (ps[0]) {
      out.push({
        id,
        name: ps[0],
        short_description: ps[1] ?? '',
      });
    }
  }
  // Dedupe by id (the same opp may appear in nav + list)
  const seen = new Set<string>();
  return out.filter((o) => seen.has(o.id) ? false : (seen.add(o.id), true));
}

/**
 * Parse Connect's per-program invites list (legacy HTML table; the REST
 * `GET /api/programs/{id}/applications/` endpoint hasn't shipped yet).
 *
 * The row carries the program-application UUID in `data-invite-id` /
 * `data-membership-id`, the LLO org slug in a `data-org` cell, and a
 * status badge. Status values map to `ProgramApplicationStatus`.
 */
export function parseInvitesList(html: string, programId: string): Invite[] {
  const out: Invite[] = [];
  const rowRegex = /<tr[^>]*data-(?:invite|membership)-id="([a-f0-9-]{36})"[^>]*>([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(rowRegex)) {
    const id = m[1];
    const row = m[2];
    const orgMatch = row.match(/<td[^>]*data-org[^>]*>([\s\S]*?)<\/td>|class="org-name"[^>]*>([\s\S]*?)</);
    const statusMatch = row.match(/data-status="([^"]+)"|class="badge[^"]*"[^>]*>([\s\S]*?)</);
    const rawStatus = (statusMatch?.[1] ?? statusMatch?.[2] ?? 'invited')
      .replace(/<[^>]+>/g, '')
      .trim()
      .toLowerCase();
    const status = (['invited', 'applied', 'accepted', 'declined'] as const).includes(
      rawStatus as 'invited' | 'applied' | 'accepted' | 'declined',
    )
      ? (rawStatus as Invite['status'])
      : 'invited';
    out.push({
      id,
      program_id: programId,
      organization: (orgMatch?.[1] ?? orgMatch?.[2] ?? '').replace(/<[^>]+>/g, '').trim(),
      status,
    });
  }
  return out;
}

/**
 * Extract the prefilled values of every named field in a Django form. Handles
 * <input value="..."> (any attribute order), <textarea>...</textarea>, and
 * <select> with a `selected` <option>. Skips inputs without a name.
 *
 * Returns a flat name→value map. For multi-value fields (checkboxes, multi-
 * select) the last value wins; we don't have any of those today so it doesn't
 * matter.
 */
export function extractFormFieldValues(html: string): Record<string, string> {
  const out: Record<string, string> = {};

  // <input> — name and value can appear in either order
  for (const m of html.matchAll(/<input\b([^>]*)>/g)) {
    const attrs = m[1];
    const name = attrs.match(/\bname="([^"]+)"/)?.[1];
    const value = attrs.match(/\bvalue="([^"]*)"/)?.[1] ?? '';
    if (name) out[name] = value;
  }

  // <textarea>...content...</textarea>
  for (const m of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const name = m[1].match(/\bname="([^"]+)"/)?.[1];
    if (name) out[name] = m[2].trim();
  }

  // <select>: find its name and the value of its `selected` <option>
  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = m[1].match(/\bname="([^"]+)"/)?.[1];
    if (!name) continue;
    const sel = m[2].match(/<option\s+value="([^"]*)"[^>]*\sselected\b/);
    out[name] = sel?.[1] ?? '';
  }

  return out;
}

/**
 * Parse Connect's deliver_unit_table HTML into typed rows.
 *
 * The page renders a plain `<table>` whose `<tr>` rows have whitespace-padded
 * `<td>` cells in this order: display index, slug, name. Confirmed live
 * 2026-04-28 against march-demo opp dea88661-… and re-verified 2026-05-06
 * against leep-paint-collection opp f14d8c5d-… (fixture
 * `deliver_unit_table-live-2026-05-06.html`).
 *
 * **`id` is the display index (1, 2, 3…), not the server integer ID.**
 * The HTML page does not render server IDs anywhere — no data-* attrs,
 * no hrefs in row cells, no hidden inputs. Skills that need the
 * server integer for `payment_unit.required_deliver_units` MUST use
 * the value returned by `connect_create_payment_unit` at create time,
 * not values from this listing. Tracked at jjackson/ace#106 finding 5
 * (server-side fix needed in commcare-connect to expose IDs).
 */
export function parseDeliverUnitTable(html: string): DeliverUnit[] {
  const out: DeliverUnit[] = [];
  // Anchor on rows inside <tbody> with `class="even"` or `class="odd"` (Connect convention).
  const rowRegex = /<tr class="(?:even|odd)"[^>]*>([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(rowRegex)) {
    const cells = [...m[1].matchAll(/<td\s*[^>]*>([\s\S]*?)<\/td>/g)]
      .map((c) => c[1].replace(/<[^>]+>/g, '').trim());
    if (cells.length >= 3) {
      const id = Number(cells[0]);
      if (Number.isFinite(id)) out.push({ id, slug: cells[1], name: cells[2] });
    }
  }
  return out;
}

/**
 * Parse the deliver-unit checkbox map out of the create-payment-unit form
 * HTML (`/a/<org>/opportunity/<uuid>/payment_unit/create`).
 *
 * Connect's create-PU form renders one `<input type="checkbox"
 * name="required_deliver_units" value="<server_pk>">` per available
 * deliver unit, plus a parallel set with `name="optional_deliver_units"`.
 * The checkbox `value` attribute carries the **server-side primary key**
 * (e.g. `5379`) — the one Connect's Postgres uses and the one that
 * `payment_unit.required_deliver_units` accepts. Connect's
 * `/deliver_unit_table/` listing exposes only a per-opp display index
 * (1, 2, 3…), so this form is the only HTML route from which the server
 * PK is observable. The label text immediately following each checkbox
 * (or wrapping the input via `<label>…<input>…name…</label>`) carries
 * the deliver-unit name, which makes a name-based join back to
 * `parseDeliverUnitTable` results possible.
 *
 * Returns a `Map<labelText, server_pk_string>`. The same PK appears in
 * both `required_deliver_units` and `optional_deliver_units` checkbox
 * groups — first-seen wins so the map dedupes correctly.
 *
 * **Issue tracking:** jjackson/ace#106 finding 5. Until commcare-connect
 * ships server PKs in `/deliver_unit_table/` directly (a server-side
 * change), this form-scrape is the bridge. When that lands, this helper
 * stays for back-compat and `parseDeliverUnitTable` gains the same
 * field.
 *
 * Verified 2026-05-06 against the
 * `opportunity-dea88661-…-payment_unit-create.html` fixture: 4 DUs, PKs
 * 3339/3340/3341/3342, names "Optional Delivery", "Optional Delivery 2",
 * "Optional Delivery 3", "optional delivery unit 4".
 */
export function parseDeliverUnitFormCheckboxes(html: string): Map<string, string> {
  const out = new Map<string, string>();
  // Pattern A (current Connect template): label wraps the input;
  // `<label>…<input name="required_deliver_units" value="3339">…name…</label>`.
  for (const m of html.matchAll(
    /<input[^>]*name="(?:required|optional)_deliver_units"[^>]*value="(\d+)"[^>]*>([\s\S]*?)<\/label>/g,
  )) {
    const value = m[1];
    const labelText = m[2].replace(/<[^>]+>/g, '').trim();
    if (labelText && !out.has(labelText)) out.set(labelText, value);
  }
  // Pattern B (legacy / alternate template): label sits BEFORE the input
  // or input + bare text; capture text up to the next tag.
  if (out.size === 0) {
    for (const m of html.matchAll(
      /<input[^>]*name="(?:required|optional)_deliver_units"[^>]*value="(\d+)"[^>]*>\s*([^<]+)/g,
    )) {
      const value = m[1];
      const labelText = m[2].trim();
      if (labelText && !out.has(labelText)) out.set(labelText, value);
    }
  }
  return out;
}

/**
 * Thrown when Connect's `payment_unit_table` HTML has data rows but its
 * `<thead>` cannot be mapped to the columns `parsePaymentUnitTable` needs
 * (or has no `<thead>` at all). Carries the exact missing column labels
 * plus the header labels actually seen, so the failure names the drift
 * instead of shipping silently mis-mapped fields.
 *
 * Deliberately NOT a silent fixed-index fallback: fixed-index reads are
 * the twice-shipped bug class (pre-0.13.2 `cells[4] → amount`; the
 * 2026-07 recurrence, dimagi-internal/ace#822, where Connect inserted two
 * pay columns and `cells[4]/cells[5]` started reading worker/org pay as
 * max_total/max_daily).
 */
export class PaymentUnitTableSchemaError extends Error {
  constructor(
    public readonly missing_columns: string[],
    public readonly seen_headers: string[],
  ) {
    super(
      `payment_unit_table header row is missing expected column(s): ` +
        `${missing_columns.map((c) => `"${c}"`).join(', ')}. ` +
        `Headers seen: [${seen_headers.map((h) => `"${h}"`).join(', ')}]. ` +
        `Refusing to parse by fixed cell index — that is the field-shift bug class ` +
        `(pre-0.13.2 turmeric runs; dimagi-internal/ace#822). ` +
        `Update the header map in parsePaymentUnitTable (mcp/connect/backends/html-scrape.ts) ` +
        `against the live payment_unit_table HTML.`,
    );
    this.name = 'PaymentUnitTableSchemaError';
  }
}

/** Normalize a header/table-cell label for matching: strip tags, collapse whitespace, lowercase. */
function normalizeHeaderLabel(raw: string): string {
  return raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The columns `parsePaymentUnitTable` knows how to read, keyed by output
 * field. `match` runs against normalized (lowercased, whitespace-collapsed)
 * `<th>` text; matchers tolerate minor label drift (substring/equality on
 * the load-bearing words) but never guess positions.
 */
const PAYMENT_UNIT_COLUMNS: Record<
  'id' | 'name' | 'start_date' | 'end_date' | 'amount' | 'org_amount' | 'max_total' | 'max_daily',
  { label: string; required: boolean; match: (h: string) => boolean }
> = {
  id: { label: '#', required: true, match: (h) => h === '#' || h === 'id' },
  name: {
    label: 'Payment Unit Name',
    required: true,
    match: (h) => h === 'payment unit name' || h === 'name' || h.includes('payment unit name'),
  },
  start_date: { label: 'Start date', required: true, match: (h) => h.includes('start date') },
  end_date: { label: 'End date', required: true, match: (h) => h.includes('end date') },
  // New columns shipped by Connect between 2026-05-05 and 2026-07-02
  // (dimagi-internal/ace#822). Optional so the pre-existing 7-column
  // layout keeps parsing exactly as before (amount/org_amount undefined).
  amount: { label: 'Worker pay per delivery', required: false, match: (h) => h.includes('worker pay') },
  org_amount: { label: 'Org pay per delivery', required: false, match: (h) => h.includes('org pay') },
  max_total: {
    label: 'Total Deliveries',
    required: true,
    match: (h) => h.includes('total deliveries') || h === 'max total' || h.includes('total delivery'),
  },
  max_daily: { label: 'Max daily', required: true, match: (h) => h.includes('max daily') },
};

/** Parse a numeric table cell, tolerating currency symbols / thousands separators. */
function parseNumericCell(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw.replace(/[$€£,]/g, '').trim();
  if (cleaned === '') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a date table cell; Connect renders "—" (em-dash) for unset dates. */
function parseDateCell(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v || v === '—' || v === '-') return undefined;
  return v;
}

/**
 * Parse Connect's payment_unit_table HTML.
 *
 * **Columns are resolved by `<thead>` header LABEL, never by fixed cell
 * index.** Connect has reshaped this table at least once (2026-07,
 * dimagi-internal/ace#822: two new pay columns inserted mid-table), and a
 * fixed-index read silently shifts every field to its right. Both shipped
 * layouts are supported:
 *
 *   OLD (live 2026-05-05, `payment_unit_table-live-2026-05-05.html`):
 *     # | Payment Unit Name | Start date | End date | Total Deliveries |
 *     Max daily | Delivery Units
 *
 *   NEW (live, confirmed 2026-07-02, dimagi-internal/ace#822; fixture
 *   `payment_unit_table-live-2026-05-06.html` already carries it):
 *     # | Payment Unit Name | Start date | End date |
 *     Worker pay per delivery | Org pay per delivery | Total Deliveries |
 *     Max daily | Delivery Units
 *
 * On the NEW layout `amount` (worker pay) and `org_amount` are populated;
 * on the OLD layout they stay `undefined` (the table didn't render them).
 * `description` and the `required_deliver_units` / `optional_deliver_units`
 * server IDs are still not parseable from this listing: the Delivery Units
 * cell renders only a count plus DU display NAMES in an Alpine.js detail
 * template — no server integer IDs — so those fields stay `''`/`[]` and
 * callers needing them must read the per-PU edit form
 * (`/payment_unit/<uuid>/edit`) or the REST endpoint once shipped.
 *
 * Failure mode: if the page has data rows but the header row is absent or
 * missing a required column, throw {@link PaymentUnitTableSchemaError}
 * naming the missing header(s). NEVER silently fall back to fixed indices.
 *
 * Bug history (the reason this comment is so explicit):
 *
 *   Pre-0.13.2 the code read `cells[4] → amount`, `cells[5] → max_total`
 *   by fixed index. That was WRONG for the then-live layout and blocked
 *   turmeric-20260429-2330, turmeric-20260503-0835, and
 *   turmeric-20260504-2304 at Phase 4 verify-after-create. The 0.13.2 fix
 *   corrected the indices but kept them FIXED — so when Connect inserted
 *   the two pay columns, `cells[4] → max_total` started reading worker
 *   pay and `cells[5] → max_daily` read org pay (a PU with
 *   max_total=10/max_daily=10/amount=1/org_amount=0 came back as
 *   max_total=1/max_daily=0), re-breaking Phase 4 verify-after-create
 *   with a false BLOCKER (dimagi-internal/ace#822). Header-name mapping
 *   is the class-level preventer.
 */
export function parsePaymentUnitTable(html: string): PaymentUnit[] {
  const rowRegex = /<tr class="(?:even|odd)"[^>]*>([\s\S]*?)<\/tr>/g;
  const rows = [...html.matchAll(rowRegex)];
  if (rows.length === 0) return [];

  // Resolve column positions from the <thead> header labels.
  const theadMatch = html.match(/<thead[^>]*>([\s\S]*?)<\/thead>/);
  const headers = theadMatch
    ? [...theadMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((h) => normalizeHeaderLabel(h[1]))
    : [];
  const col: Partial<Record<keyof typeof PAYMENT_UNIT_COLUMNS, number>> = {};
  const missing: string[] = [];
  for (const [field, spec] of Object.entries(PAYMENT_UNIT_COLUMNS) as Array<
    [keyof typeof PAYMENT_UNIT_COLUMNS, (typeof PAYMENT_UNIT_COLUMNS)[keyof typeof PAYMENT_UNIT_COLUMNS]]
  >) {
    const idx = headers.findIndex(spec.match);
    if (idx >= 0) col[field] = idx;
    else if (spec.required) missing.push(spec.label);
  }
  if (missing.length > 0) {
    throw new PaymentUnitTableSchemaError(missing, headers);
  }

  const out: PaymentUnit[] = [];
  for (const m of rows) {
    const rowHtml = m[1];
    const cells = [...rowHtml.matchAll(/<td\s*[^>]*>([\s\S]*?)<\/td>/g)]
      .map((c) => c[1].replace(/<[^>]+>/g, '').trim());
    const id = Number(cells[col.id!]);
    if (!Number.isFinite(id)) continue;
    // Extract the payment-unit UUID from the edit link, when present.
    // Live HTML on 2026-05-06 (leep-paint-collection) has each row
    // containing `<a href="…/payment_unit/<UUID>/edit">…`. This is the
    // only stable identifier scrapable from this listing — the id column
    // is the display index, not the server integer ID.
    // Issue tracking: jjackson/ace#106 finding 5.
    const editMatch = rowHtml.match(/payment_unit\/([0-9a-f-]{36})\/edit/);
    out.push({
      id,
      payment_unit_uuid: editMatch ? editMatch[1] : undefined,
      name: cells[col.name!] ?? '',
      description: '',                 // not rendered in this table
      amount: col.amount !== undefined ? parseNumericCell(cells[col.amount]) : undefined,
      org_amount: col.org_amount !== undefined ? parseNumericCell(cells[col.org_amount]) : undefined,
      max_total: parseNumericCell(cells[col.max_total!]),
      max_daily: parseNumericCell(cells[col.max_daily!]),
      start_date: parseDateCell(cells[col.start_date!]),
      end_date: parseDateCell(cells[col.end_date!]),
      required_deliver_units: [],      // DU cell renders names only, no server IDs
      optional_deliver_units: [],
    });
  }
  return out;
}

/**
 * Parse Django form errors into a flat list. Returns [] if no errors.
 *
 * Supports both the legacy Django `<ul class="errorlist">` markup AND the
 * crispy-tailwind `<p id="error_N_id_FIELD" class="text-red-500…">…</p>`
 * markup that Connect's modern templates emit. Some forms in Connect
 * render only one or the other depending on the crispy template pack
 * the view uses.
 */
export function parseFormErrors(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<ul class="errorlist[^"]*"[^>]*>([\s\S]*?)<\/ul>/g)) {
    for (const li of m[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
      out.push(li[1].replace(/<[^>]+>/g, '').trim());
    }
  }
  // crispy-tailwind: <p id="error_N_id_FIELD" class="text-red-500…">…</p>
  for (const m of html.matchAll(/<p[^>]+id=["']error_\d+_id_[a-zA-Z0-9_]+["'][^>]*>([\s\S]*?)<\/p>/g)) {
    const txt = m[1].replace(/<[^>]+>/g, '').trim();
    if (txt) out.push(txt);
  }
  return out;
}

/**
 * Parse Django form errors keyed by field name.
 *
 * Connect's crispy-rendered forms wrap each field in a div with id
 * `div_id_<fieldname>` (e.g. `<div id="div_id_api_key" class="mb-3">…`). When
 * the form fails validation Django re-renders the same template with a
 * `<ul class="errorlist">` injected inside the field wrapper. We walk each
 * `div_id_*` block and harvest the errorlist items inside it.
 *
 * Form-level errors (i.e. `<ul class="errorlist">` outside any field wrapper —
 * Django renders these with `class="errorlist nonfield"`) are returned under
 * the special key `__all__`.
 *
 * Returns `{}` when the response has no errorlist at all (i.e. it's not a
 * validation-failure render).
 */
export function parseFormErrorsByField(html: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};

  const errorlistRe = /<ul class="errorlist[^"]*"[^>]*>([\s\S]*?)<\/ul>/g;
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;

  // 1. Scan each div_id_<field> block. We greedily match up to the next
  //    div_id_ opener (or end-of-string) to scope errorlists to a field.
  const fieldBlockRe = /<div\s+id="div_id_([a-zA-Z0-9_]+)"[^>]*>([\s\S]*?)(?=<div\s+id="div_id_[a-zA-Z0-9_]+"|<\/form>|$)/g;
  const consumedRanges: Array<[number, number]> = [];
  for (const m of html.matchAll(fieldBlockRe)) {
    const field = m[1];
    const block = m[2];
    const errs: string[] = [];
    for (const e of block.matchAll(errorlistRe)) {
      for (const li of e[1].matchAll(liRe)) {
        errs.push(li[1].replace(/<[^>]+>/g, '').trim());
      }
    }
    if (errs.length) {
      out[field] = (out[field] ?? []).concat(errs);
    }
    if (m.index != null) consumedRanges.push([m.index, m.index + m[0].length]);
  }

  // 2. Form-level / non-field errors: any errorlist outside the field blocks.
  //    Django marks these `errorlist nonfield` but we accept both for safety
  //    (Connect's templates may not always include the modifier).
  for (const m of html.matchAll(errorlistRe)) {
    const start = m.index ?? -1;
    if (start < 0) continue;
    const inField = consumedRanges.some(([s, e]) => start >= s && start < e);
    if (inField) continue;
    const errs: string[] = [];
    for (const li of m[1].matchAll(liRe)) {
      errs.push(li[1].replace(/<[^>]+>/g, '').trim());
    }
    if (errs.length) {
      out['__all__'] = (out['__all__'] ?? []).concat(errs);
    }
  }

  // 3. crispy-tailwind: <p id="error_N_id_FIELD" class="text-red-500…">…</p>.
  //    The field name lives in the id, so we don't need the surrounding
  //    div_id_<field> wrapper to scope it. (And the wrapper-based scan above
  //    won't catch these because the <p> sits inside the wrapper but doesn't
  //    contain a <ul class="errorlist">.)
  for (const m of html.matchAll(/<p[^>]+id=["']error_\d+_id_([a-zA-Z0-9_]+)["'][^>]*>([\s\S]*?)<\/p>/g)) {
    const field = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    out[field] = (out[field] ?? []).concat([text]);
  }

  return out;
}
