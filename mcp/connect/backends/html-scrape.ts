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
 * `<td>` cells in this order: id, slug, name. Confirmed live 2026-04-28
 * against march-demo opp dea88661-1cd6-486b-ab25-48584bf61a8e.
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
 * Parse Connect's payment_unit_table HTML. Column order verified live
 * 2026-05-05 against connect.dimagi.com against an active opp's
 * `payment_unit_table/` page (see
 * `test/fixtures/connect-html/payment_unit_table-live-2026-05-05.html`):
 *
 *   #            (cells[0]) — display id
 *   Payment Unit Name (cells[1])
 *   Start date   (cells[2])
 *   End date     (cells[3])
 *   Total Deliveries  (cells[4]) — server field `max_total`
 *   Max daily    (cells[5])      — server field `max_daily`
 *   Delivery Units (cells[6])    — count + Alpine.js detail row
 *
 * The table does NOT display `amount`, `description`, `org_amount`, or
 * the per-PU `required_deliver_units` ids in a parseable form. They
 * remain `undefined`/`""`/`[]` here; callers that need them must read
 * the per-PU edit form (`/payment_unit/<uuid>/edit`) or — once shipped —
 * the REST `GET /api/opportunities/{id}/payment_units/` endpoint.
 *
 * Bug history (the reason this comment is so explicit):
 *
 *   Pre-0.13.2 the comment claimed columns were `id, name, start, end,
 *   amount, max_total` and code read `cells[4] → amount`,
 *   `cells[5] → max_total`. That was WRONG — Connect renders no `amount`
 *   column. The off-by-one read produced a "field-shift defect" that
 *   blocked turmeric-20260429-2330, turmeric-20260503-0835, and
 *   turmeric-20260504-2304 at Phase 3 verify-after-create. Live HTML
 *   inspection on 2026-05-05 against `f116865a-…/payment_unit/.../edit`
 *   confirmed the server-side data was correct on all three runs; the
 *   "field-shift" was entirely in this parser.
 */
export function parsePaymentUnitTable(html: string): PaymentUnit[] {
  const out: PaymentUnit[] = [];
  const rowRegex = /<tr class="(?:even|odd)"[^>]*>([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(rowRegex)) {
    const cells = [...m[1].matchAll(/<td\s*[^>]*>([\s\S]*?)<\/td>/g)]
      .map((c) => c[1].replace(/<[^>]+>/g, '').trim());
    if (cells.length >= 6) {
      const id = Number(cells[0]);
      const max_total = Number(cells[4]);
      const max_daily = Number(cells[5]);
      if (Number.isFinite(id)) {
        out.push({
          id,
          name: cells[1],
          description: '',                 // not rendered in this table
          // amount intentionally omitted — see PaymentUnit.amount jsdoc
          max_total: Number.isFinite(max_total) ? max_total : undefined,
          max_daily: Number.isFinite(max_daily) ? max_daily : undefined,
          start_date: cells[2] || undefined,
          end_date: cells[3] || undefined,
          required_deliver_units: [],      // not parseable from this table
          optional_deliver_units: [],
        });
      }
    }
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
