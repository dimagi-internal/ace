/**
 * Pure HTML-parsing helpers for OCS team-management pages.
 *
 * Extracted from `scripts/grant-review-access.ts` (the manual half of
 * `skills/share-run-access`) so the `ocs_add_team_member` atom
 * (mcp/ocs/backends/playwright.ts) and the script share one proven
 * implementation surface (dimagi-internal/ace#906). Everything here is
 * pure string → data; no I/O.
 *
 * Contract notes (read off OCS source + live pages, 2026-07-24):
 * - Team page: `/a/<team>/team/` renders the Team Members table (rows are
 *   `Name <email>` anchors at `/team/members/<id>/`) and, inside
 *   `#invitation-form-and-table`, the invite form + Pending Invitations
 *   table (`<td>email</td><td>invited</td><td>roles</td>` + per-row
 *   hx-post cancel form — templates/teams/components/invitation_row.html).
 * - Membership page: `/a/<team>/team/members/<id>/` renders
 *   `MembershipForm` — `fields = ("groups",)`, CheckboxSelectMultiple
 *   (apps/teams/forms.py) — whose save() REPLACES the m2m set, which is
 *   why callers must always POST the UNION of current + wanted groups.
 */

export interface OcsPendingInvite {
  email: string;
  invited: string;
  /** Group names exactly as OCS renders them (`invitation.groups.all|join:", "`). */
  groups: string[];
  /** Per-row cancel URL from invitation_row.html, or undefined if not rendered. */
  cancelUrl?: string;
}

export interface OcsTeamPageReadback {
  isMember: boolean;
  /** The matched accepted member's row, when `isMember` — id drives the edit URL. */
  member?: { id: string; label: string };
  pending?: OcsPendingInvite;
  raw: string[];
}

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
 * Parse the `/a/<team>/team/` page for one email: accepted-member row
 * (with membership id), pending-invite row (with groups + cancel URL),
 * plus a raw evidence trail for read-back reporting.
 */
export function parseOcsTeamPage(html: string, email: string): OcsTeamPageReadback {
  const lower = email.toLowerCase();
  const raw: string[] = [];

  // Team Members table — rows render as `Name <email>` anchors.
  const membersIdx = html.indexOf('Team Members');
  const inviteIdx = html.indexOf('id="invitation-form-and-table"', membersIdx);
  const membersHtml =
    membersIdx === -1 ? '' : html.slice(membersIdx, inviteIdx === -1 ? undefined : inviteIdx);
  const members = [...membersHtml.matchAll(/<a[^>]*href="[^"]*\/team\/members\/(\d+)\/"[^>]*>([\s\S]*?)<\/a>/gi)].map(
    (m) => ({ id: m[1], label: stripTags(m[2]) }),
  );
  raw.push(`  Team Members table: ${JSON.stringify(members)}`);

  // Pending Invitations table lives inside #invitation-form-and-table, after
  // the invite form.
  const inviteSection = sectionById(html, 'invitation-form-and-table');
  const afterForm = inviteSection.slice(inviteSection.indexOf('</form>') + 7);
  const invites: OcsPendingInvite[] = [];
  for (const row of afterForm.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const tds = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
    if (tds.length < 3 || !tds[0].includes('@')) continue;
    invites.push({
      email: tds[0],
      invited: tds[1],
      groups: tds[2].split(',').map((s) => s.trim()).filter(Boolean),
      cancelUrl: row[1].match(/hx-post="([^"]*\/invite\/cancel\/[^"]*)"/)?.[1],
    });
  }
  raw.push(`  Pending Invitations table: ${JSON.stringify(invites)}`);

  const member = members.find((m) => m.label.toLowerCase().includes(lower));
  return {
    isMember: Boolean(member),
    member,
    pending: invites.find((i) => i.email.toLowerCase() === lower),
    raw,
  };
}
