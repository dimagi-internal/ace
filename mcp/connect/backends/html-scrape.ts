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

import type { DeliveryType, Program, Opportunity, Invite } from '../types.js';

/** Extract the csrfmiddlewaretoken value from a Django form HTML. */
export function extractFormCsrfToken(html: string): string | undefined {
  const m = html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/);
  return m?.[1];
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
 * Parse Connect's opportunity list page. The list page is currently behind
 * a different route (per-program `<program_uuid>/opportunity/` we believe);
 * this helper covers both org-wide and program-scoped listings.
 *
 * Row anchor: `hx-get="/a/<org>/opportunity/<uuid>/...` and the same
 * `<p class="card_title">` convention as programs.
 */
export function parseOpportunitiesList(html: string): Pick<Opportunity, 'id' | 'name' | 'short_description'>[] {
  const out: Pick<Opportunity, 'id' | 'name' | 'short_description'>[] = [];
  const cardRegex = /<div[^>]*class="[^"]*shadow-sm[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*shadow-sm|<\/section>|<\/main>)/g;
  for (const card of html.matchAll(cardRegex)) {
    const body = card[1];
    const titleMatch = body.match(/<p class="card_title"[^>]*>([\s\S]*?)<\/p>/);
    const descMatch = body.match(/<p class="card_description[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const uuidMatch = body.match(/\/opportunity\/([a-f0-9-]{36})/);
    if (titleMatch && uuidMatch) {
      out.push({
        id: uuidMatch[1],
        name: titleMatch[1].replace(/<[^>]+>/g, '').trim(),
        short_description: descMatch?.[1].replace(/<[^>]+>/g, '').trim() ?? '',
      });
    }
  }
  return out;
}

/**
 * Parse Connect's per-program invites list. Row format depends on the
 * member-table HTMX endpoint; for now we parse `<tr>` rows with org slugs.
 */
export function parseInvitesList(html: string, opportunityIdOrProgramId: string): Invite[] {
  const out: Invite[] = [];
  const rowRegex = /<tr[^>]*data-(?:invite|membership)-id="([a-f0-9-]{36})"[^>]*>([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(rowRegex)) {
    const id = m[1];
    const row = m[2];
    const orgMatch = row.match(/<td[^>]*data-org[^>]*>([\s\S]*?)<\/td>|class="org-name"[^>]*>([\s\S]*?)</);
    const emailMatch = row.match(/<td[^>]*data-email[^>]*>([\s\S]*?)<\/td>|<a href="mailto:([^"]+)"/);
    const statusMatch = row.match(/data-status="([^"]+)"|class="badge[^"]*"[^>]*>([\s\S]*?)</);
    out.push({
      id,
      opportunity_id: opportunityIdOrProgramId,
      organization_name: (orgMatch?.[1] ?? orgMatch?.[2] ?? '').replace(/<[^>]+>/g, '').trim(),
      contact_email: emailMatch?.[1] ?? emailMatch?.[2] ?? '',
      status: ((statusMatch?.[1] ?? statusMatch?.[2] ?? 'pending')
        .replace(/<[^>]+>/g, '').trim().toLowerCase() as Invite['status']),
    });
  }
  return out;
}

/** Parse a Django form errorlist into [..., ...]. Returns [] if no errors. */
export function parseFormErrors(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<ul class="errorlist[^"]*"[^>]*>([\s\S]*?)<\/ul>/g)) {
    for (const li of m[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
      out.push(li[1].replace(/<[^>]+>/g, '').trim());
    }
  }
  return out;
}
