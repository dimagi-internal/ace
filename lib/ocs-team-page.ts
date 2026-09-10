/**
 * Pure HTML-parsing helpers for OCS team-management pages.
 *
 * Extracted from `scripts/grant-review-access.ts` (the manual half of
 * `skills/share-run-access`) so the `ocs_add_team_member` atom
 * (mcp/ocs/backends/playwright.ts) and the script share one proven
 * implementation surface (dimagi-internal/ace#906). Everything here is
 * pure string → data; no I/O.
 *
 * Contract notes (read off OCS source + live pages; members list re-read
 * 2026-09-10, dimagi-internal/ace#2344):
 * - Team page: `/a/<team>/team/` renders the invite form (a modal inside
 *   `#members-section`, groups as checkboxes) but NO member rows any more —
 *   the member + pending-invitation list is an htmx partial,
 *   `/a/<team>/team/members/table/` (`MembersTable`, one row per accepted
 *   member or pending invitation). Read membership off the PARTIAL; use the
 *   page only for the invite form + csrf. `parseOcsTeamPage` takes the
 *   partial's HTML and reports `parsed: false` — INCONCLUSIVE, never
 *   "absent" — when it finds no rows, because ACE is a member of every team
 *   it can open, so an empty read is a wrong read (that is exactly how #2344
 *   told a reviewer she had no access while OCS was refusing to re-invite an
 *   existing member).
 * - Membership page: `/a/<team>/team/members/<id>/` renders
 *   `MembershipForm` — `fields = ("groups",)`, CheckboxSelectMultiple
 *   (apps/teams/forms.py) — whose save() REPLACES the m2m set, which is
 *   why callers must always POST the UNION of current + wanted groups.
 */

import { parseOcsMembersTable } from './ocs-team-members.js';

export interface OcsPendingInvite {
  email: string;
  invited: string;
  /** Group names exactly as OCS renders them (`invitation.groups.all|join:", "`). */
  groups: string[];
  /** Per-row cancel URL from invitation_row.html, or undefined if not rendered. */
  cancelUrl?: string;
}

export interface OcsTeamPageReadback {
  /**
   * True when at least one member/invitation row was parsed. FALSE means the
   * read is INCONCLUSIVE (wrong page, changed template, no access) and
   * `isMember: false` beneath it means nothing — callers must not treat it as
   * "not a member" (dimagi-internal/ace#2344).
   */
  parsed: boolean;
  isMember: boolean;
  /** The matched accepted member's row, when `isMember` — id drives the edit URL. */
  member?: { id: string; label: string; groups: string[] };
  pending?: OcsPendingInvite;
  raw: string[];
}

export { ocsMembersTablePath } from './ocs-team-members.js';

export function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Value of the Django `{% csrf_token %}` hidden input on a rendered page. */
export function csrfFromHtml(html: string): string | undefined {
  return html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/)?.[1];
}

/** All `<input type=checkbox name=X value=V>` + their trailing label text. */
export function checkboxOptions(html: string, name: string): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const re = new RegExp(
    `<input[^>]*type="checkbox"[^>]*name="${name}"[^>]*value="([^"]*)"[^>]*>([^<]*)`,
    'gi',
  );
  for (const m of html.matchAll(re)) out.push({ value: m[1], label: unescapeHtml(m[2].trim()) });
  return out;
}

/** The `value`s of the CHECKED checkboxes of a named group (order-independent). */
export function checkedCheckboxValues(html: string, name: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(new RegExp(`<input\\b[^>]*name="${name}"[^>]*>`, 'gi'))) {
    if (/\bchecked\b/i.test(m[0])) {
      const v = m[0].match(/\bvalue="([^"]*)"/)?.[1];
      if (v !== undefined) out.push(v);
    }
  }
  return out;
}

/** Section of `html` from the element carrying `id="<id>"` to EOF. */
export function sectionById(html: string, id: string): string {
  const i = html.indexOf(`id="${id}"`);
  return i === -1 ? '' : html.slice(i);
}

export function stripTags(s: string): string {
  return unescapeHtml(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Case-insensitive set equality over group-label lists. */
export function sameGroups(a: string[], b: string[]): boolean {
  const norm = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))].sort().join('|');
  return norm(a) === norm(b);
}

/**
 * Parse the members-table PARTIAL (`ocsMembersTablePath(team)`) for one email:
 * accepted-member row (with membership id + groups), pending-invite row (with
 * groups + cancel URL), plus a raw evidence trail for read-back reporting.
 *
 * Kept under its historical name so both consumers keep one import; the
 * implementation lives in `lib/ocs-team-members.ts` with the live fixture.
 */
export function parseOcsTeamPage(html: string, email: string): OcsTeamPageReadback {
  const rb = parseOcsMembersTable(html, email);
  return {
    parsed: rb.parsed,
    isMember: rb.isMember,
    ...(rb.member ? { member: rb.member } : {}),
    ...(rb.pending ? { pending: rb.pending } : {}),
    raw: rb.raw,
  };
}
