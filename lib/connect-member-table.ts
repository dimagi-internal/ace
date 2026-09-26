/**
 * Parser for Connect's organization member table (`org_member_table`).
 *
 * Why this exists: `connect_add_org_member` used to verify its POST with
 * `tableHtml.includes(email)` — a substring match over the whole page. That is
 * true whenever the address appears ANYWHERE in the markup, and it cannot
 * answer the two questions that actually matter:
 *
 *   1. Was this person already a member before the call? Connect's
 *      `OrganizationInviteForm.clean_email` (formerly `MembershipForm`) excludes users already in the org, so for
 *      an existing member the form never validates and the POST is a silent
 *      no-op returning the same 302 as success.
 *   2. What role did Connect actually STORE? The old code returned the role the
 *      caller asked for, which is a fabricated field whenever the POST no-opped.
 *
 * Upstream shape (commcare-connect `organization/tables.py::OrgMemberTable`):
 *   sequence = ("select", "index", "user", "role")
 *   user = columns.Column(verbose_name="member", accessor="user__email")
 *   role = tables.Column()   # renders the display label: Admin | Member | Viewer
 *
 * See dimagi-internal/ace#911.
 */

export interface OrgMemberRow {
  email: string;
  /** Display label as stored ("admin" | "member" | "viewer"), lowercased; null if unparseable. */
  role: string | null;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const KNOWN_ROLES = ['admin', 'member', 'viewer'];

/** Strip tags/entities from a table cell and collapse whitespace. */
function cellText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse the rendered member table into one row per membership.
 *
 * Only rows that contain BOTH an email and a recognised role are returned — a
 * header row, an empty-state row, or a stray email elsewhere in the markup will
 * not masquerade as a membership.
 */
export function parseOrgMemberTable(html: string): OrgMemberRow[] {
  const rows: OrgMemberRow[] = [];
  // Split on the WHOLE opening tag, attributes and closing '>' included. A
  // character-class delimiter (`/<tr[\s>]/`) consumes only ONE character after
  // the tag name, so Connect's `<td >` (django-tables2 renders a space before
  // the close when the column has no attrs) leaves a stray '>' at the head of
  // every cell. The email cell survives that — EMAIL_RE is a substring test —
  // but the role cell is matched by EXACT equality, so `"> member"` never
  // equals `"member"` and EVERY row is silently skipped. See ace#1064.
  const chunks = html.split(/<tr\b[^>]*>/i).slice(1);

  for (const chunk of chunks) {
    const rowHtml = chunk.split(/<\/tr>/i)[0] ?? '';
    const cells = rowHtml
      .split(/<t[dh]\b[^>]*>/i)
      .slice(1)
      .map((c) => cellText(c.split(/<\/t[dh]>/i)[0] ?? ''));
    if (!cells.length) continue;

    const emailCell = cells.find((c) => EMAIL_RE.test(c));
    if (!emailCell) continue;
    const email = emailCell.match(EMAIL_RE)?.[0];
    if (!email) continue;

    // The role cell is a different cell whose text is exactly a known role.
    const roleCell = cells.find((c) => {
      const t = c.toLowerCase().trim();
      return KNOWN_ROLES.includes(t);
    });
    if (!roleCell) continue;

    rows.push({ email, role: roleCell.toLowerCase().trim() });
  }

  return rows;
}

export interface PendingInviteRow extends OrgMemberRow {
  /** "Invited on" cell text as rendered (e.g. "26-Sep-2026 13:19"); null if absent. */
  invited_on: string | null;
  /** "Expires on" cell text as rendered; null if absent. */
  expires_on: string | null;
}

/** Connect's DMYTColumn renders `DD-Mon-YYYY[ HH:MM]`. */
const DMY_RE = /^\d{1,2}-[A-Za-z]{3}-\d{4}(?:\s+\d{1,2}:\d{2})?$/;

/**
 * Parse Connect's pending-invite table (`/a/<org>/organization/pending_invites_table`).
 *
 * Why this exists (ace#2503): Connect's add-member form no longer creates a
 * membership. `add_members_form` now calls `OrganizationInvite.send_invite`, so
 * a successful add lands HERE as a pending invite — never in the member table
 * until the invitee accepts. Reading only the member table reported every
 * successful invite as "no Connect account exists".
 *
 * Upstream shape (commcare-connect `organization/tables.py::PendingInviteTable`):
 *   sequence = ("index", "email", "role", "date_modified", "expiry_date", "actions")
 *   verbose names: # | Email | Role | Invited on | Expires on | (actions)
 *   role via organization/role_badge.html → `get_role_display` (Admin | Member | Viewer)
 *   empty_text = "No pending invites."
 *   rows: status=INVITED and not expired, ordered by -date_modified
 *
 * Same row contract as parseOrgMemberTable (it reuses it for email + role): a
 * row counts only when it carries BOTH an email and a recognised role, so the
 * empty-state row, the header, and the htmx `hx-swap-oob` messages block
 * ("Invite sent to <email>.") — rendered OUTSIDE any table row — never
 * masquerade as an invite.
 */
export function parsePendingInviteTable(html: string): PendingInviteRow[] {
  const rows: PendingInviteRow[] = [];
  for (const chunk of html.split(/<tr\b[^>]*>/i).slice(1)) {
    const rowHtml = `<tr>${chunk.split(/<\/tr>/i)[0] ?? ''}</tr>`;
    const [hit] = parseOrgMemberTable(rowHtml);
    if (!hit) continue;
    const dates = rowHtml
      .split(/<t[dh]\b[^>]*>/i)
      .slice(1)
      .map((c) => cellText(c.split(/<\/t[dh]>/i)[0] ?? ''))
      .filter((c) => DMY_RE.test(c));
    rows.push({ ...hit, invited_on: dates[0] ?? null, expires_on: dates[1] ?? null });
  }
  return rows;
}
