/**
 * Parser for Connect's organization member table (`org_member_table`).
 *
 * Why this exists: `connect_add_org_member` used to verify its POST with
 * `tableHtml.includes(email)` — a substring match over the whole page. That is
 * true whenever the address appears ANYWHERE in the markup, and it cannot
 * answer the two questions that actually matter:
 *
 *   1. Was this person already a member before the call? Connect's
 *      `MembershipForm.clean_email` excludes users already in the org, so for
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
