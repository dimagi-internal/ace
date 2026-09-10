//
// Open Chat Studio team membership, read off the ONE surface that renders it.
//
// OCS moved the team's member list out of `GET /a/<team>/team/` and into an
// htmx partial, `GET /a/<team>/team/members/table/` (a django-tables2
// `MembersTable` that lists accepted members AND pending invitations as rows of
// one table — `templates/teams/components/members_section.html` loads it with
// `hx-get` on page load). The page itself now carries no member rows at all.
//
// ACE had two copies of a parser that sliced the old page between the text
// "Team Members" and `#invitation-form-and-table` — `scripts/grant-review-access.ts`
// and the `ocs_add_team_member` atom — and on 2026-09-10 both read the new page
// as "Team Members table: []" for a team ACE itself belongs to, concluded a
// reviewer had no access, and told her so, while OCS's own invite form was
// correctly refusing to re-invite an existing member (dimagi-internal/ace#2344).
// A parser that returns an empty list for a page it does not understand is
// indistinguishable from a parser reading an empty team; that is the defect
// this module closes:
//
//   - ONE parser, here, with a fixture cut from the live partial
//     (`test/fixtures/ocs/members-table.partial.html`).
//   - `parsed` is separate from `isMember`. Zero rows on a team ACE can read is
//     NEVER "absent" — ACE is a member of every team it can open — so a caller
//     that gets `parsed: false` must report the read as inconclusive, not the
//     person as missing.
//
// Row markup (upstream `templates/teams/components/member_row_*.html`):
//   td[0]  name cell — `record.name` then `record.email` in nested spans
//   td[1]  roles     — one `<span class="badge …">` per group
//   td[2]  status    — badge `Active` / `Invited`, plus an optional detail line
//   td[3]  actions   — member: `<a href="/a/<team>/team/members/<pk>/">` (edit)
//                      invitation: `hx-post="…/invite/cancel/<id>/"` (+ resend)
//
// Pure and content-only: the caller does the HTTP reads and hands the partial in.
//

export interface OcsTeamRow {
  kind: 'member' | 'invitation';
  name: string;
  email: string;
  /** Group names exactly as OCS renders the role badges. */
  groups: string[];
  /** `Active` / `Invited` badge text. */
  status: string;
  /** Optional status detail line ("Active 2 days ago", "Invited 3 hours ago"). */
  statusDetail?: string;
  /** Membership pk off the edit link — drives `/team/members/<pk>/`. Members only. */
  membershipId?: string;
  /** Per-row cancel URL, rendered only for a Team Admin. Invitations only. */
  cancelUrl?: string;
}

export interface OcsPendingInvite {
  email: string;
  invited: string;
  groups: string[];
  cancelUrl?: string;
}

export interface OcsTeamReadback {
  /**
   * True when the HTML contained at least one member/invitation row. FALSE means
   * the read cannot be trusted — wrong page, changed template, or no access —
   * and every `isMember: false` beneath it is meaningless. Callers must not
   * treat `!parsed` as "not a member".
   */
  parsed: boolean;
  isMember: boolean;
  /** The matched accepted member, when `isMember` — id drives the edit URL. */
  member?: { id: string; label: string; groups: string[] };
  pending?: OcsPendingInvite;
  rows: OcsTeamRow[];
  /** Human-readable evidence lines for read-back trails. */
  raw: string[];
}

/** The htmx partial that actually renders the team's members. */
export function ocsMembersTablePath(team: string): string {
  return `/a/${team}/team/members/table/`;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function badges(cell: string): string[] {
  return [...cell.matchAll(/<span[^>]*class="[^"]*\bbadge\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)]
    .map((m) => stripTags(m[1]))
    .filter(Boolean);
}

/** Parse the members-table partial. Pass the email you are looking for. */
export function parseOcsMembersTable(html: string, email: string): OcsTeamReadback {
  const lower = email.trim().toLowerCase();
  const rows: OcsTeamRow[] = [];

  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tds = [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (tds.length < 3) continue; // header row, empty-text row
    const nameText = stripTags(tds[0]);
    const rowEmail = EMAIL_RE.exec(nameText)?.[0];
    if (!rowEmail) continue;
    const name = nameText.replace(rowEmail, '').replace(/\s+/g, ' ').trim();
    // The avatar initials precede the name; drop a leading all-caps token of ≤3 chars.
    const cleanName = name.replace(/^[A-Z]{1,3}\s+/, '').trim() || rowEmail;
    const groups = badges(tds[1]);
    const statusBadges = badges(tds[2]);
    const status = statusBadges[0] ?? stripTags(tds[2]).split(' ')[0] ?? '';
    const statusDetail = stripTags(tds[2]).replace(status, '').trim() || undefined;
    const actions = tds[3] ?? '';
    const membershipId = /href="[^"]*\/team\/members\/(\d+)\/"/i.exec(actions)?.[1];
    const cancelUrl = /hx-post="([^"]*\/invite\/cancel\/[^"]*)"/i.exec(actions)?.[1];
    rows.push({
      kind: membershipId ? 'member' : 'invitation',
      name: cleanName,
      email: rowEmail,
      groups,
      status,
      ...(statusDetail ? { statusDetail } : {}),
      ...(membershipId ? { membershipId } : {}),
      ...(cancelUrl ? { cancelUrl } : {}),
    });
  }

  const raw = [
    `  members table: ${rows.length} row(s) — ` +
      rows.map((r) => `${r.email} [${r.kind}; ${r.groups.join(', ') || 'no groups'}; ${r.status}]`).join('; '),
  ];
  if (rows.length === 0) {
    raw.push('  members table: NO ROWS PARSED — read is INCONCLUSIVE (wrong page, changed template, or no access), not "absent"');
  }

  const memberRow = rows.find((r) => r.kind === 'member' && r.email.toLowerCase() === lower);
  const inviteRow = rows.find((r) => r.kind === 'invitation' && r.email.toLowerCase() === lower);

  return {
    parsed: rows.length > 0,
    isMember: Boolean(memberRow),
    ...(memberRow
      ? { member: { id: memberRow.membershipId!, label: `${memberRow.name} <${memberRow.email}>`, groups: memberRow.groups } }
      : {}),
    ...(inviteRow
      ? {
          pending: {
            email: inviteRow.email,
            invited: inviteRow.statusDetail ?? inviteRow.status,
            groups: inviteRow.groups,
            ...(inviteRow.cancelUrl ? { cancelUrl: inviteRow.cancelUrl } : {}),
          },
        }
      : {}),
    rows,
    raw,
  };
}
