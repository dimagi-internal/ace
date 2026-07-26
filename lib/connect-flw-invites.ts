/**
 * Parser for Connect's per-opportunity **workers** table — the authoritative
 * read of whether an FLW invite actually LANDED.
 *
 * Why this exists (dimagi-internal/ace#824 / #855): `connect_send_flw_invite`
 * returns `{status: "queued", invited_count: N}` on success, and Phase 4 has
 * been treating that as done. It is not evidence. The invite creates an
 * `OpportunityAccess` row that may have **no linked ConnectID user**, and
 * Connect's mobile API filters opportunities by `opportunityaccess__user`:
 *
 *     Opportunity.objects.filter(opportunityaccess__user=request.user, archived=False)
 *
 * An access with a null user matches nothing, so the opportunity never
 * appears in the worker's payload — no refresh gesture on the device can
 * ever surface it, and per the ConnectID change noted in #855 it does not
 * self-heal. Proven live 2026-07-25: a fresh invite stayed invisible on
 * device through both an `action_sync` and a swipe-refresh, while five
 * previously-linked opportunities rendered fine.
 *
 * The discriminator is the row's **status icon** plus the Name cell:
 *
 *   linked / accepted : `fa-solid fa-circle-check text-green-600`, Name =
 *                       "<display name> <connect user id>"
 *   pending / unlinked: `fa-regular fa-clock text-orange-600`,     Name = "-"
 *
 * A name-column read alone is NOT sufficient (#855 says so explicitly) —
 * hence both signals are captured and `linked` requires the positive one.
 *
 * Contract source: live markup captured 2026-07-25 from
 * `GET /a/<org>/opportunity/<opp_id>/workers/` (htmx fragment, session-cookie
 * authed, read-only). Columns are resolved by **header label**, never by
 * position, so a live template reshape fails loud instead of silently
 * shifting fields — same convention as `parsePaymentUnitTable`.
 */

/** Thrown when the workers table no longer matches the expected schema. */
export class WorkersTableSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkersTableSchemaError';
  }
}

export interface FlwInviteRow {
  /** Phone number exactly as Connect renders it (E.164, e.g. `+74260000101`). */
  phone: string;
  /**
   * Display name, or null when no ConnectID user is linked yet (Connect
   * renders a bare `-`). Null is the unlinked signature.
   */
  name: string | null;
  /** ConnectID user id shown beside the name, when linked. */
  connect_user_id: string | null;
  /**
   * TRUE only when the row shows the positive accepted/linked signal. This
   * is the value Phase 4 / Phase 6 must gate on — never the send response.
   */
  linked: boolean;
  /** `accepted` | `pending` | `unknown` (icon absent or unrecognized). */
  status: 'accepted' | 'pending' | 'unknown';
  /** Invited date as rendered, or null for `—`. */
  invited_date: string | null;
  /** Learn completion timestamp as rendered, or null for `—`. */
  completed_learn: string | null;
}

/** Strip tags/entities and collapse whitespace. `—` and `-` become null. */
function cellText(html: string): string | null {
  const t = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  if (t === '' || t === '—' || t === '-' || t === '--') return null;
  return t;
}

/**
 * Columns this parser reads, keyed by output field. `match` runs against
 * normalized (lowercased, whitespace-collapsed) `<th>` text.
 */
const WORKER_COLUMNS: Record<
  'status' | 'name' | 'phone' | 'invited_date' | 'completed_learn',
  { label: string; required: boolean; match: (h: string) => boolean }
> = {
  status: { label: 'Status', required: true, match: (h) => h === 'status' },
  name: { label: 'Name', required: true, match: (h) => h === 'name' },
  phone: {
    label: 'Phone Number',
    required: true,
    match: (h) => h.includes('phone'),
  },
  invited_date: {
    label: 'Invited Date',
    required: false,
    match: (h) => h.includes('invited'),
  },
  completed_learn: {
    label: 'Completed Learn',
    required: false,
    match: (h) => h.includes('completed learn'),
  },
};

/**
 * Parse the workers-table fragment into one row per worker/invite.
 *
 * Returns `[]` for an empty table (no invites yet) — that is a legitimate
 * state, not a schema failure. Throws `WorkersTableSchemaError` when a
 * required column is absent, so a Connect template change surfaces
 * immediately rather than producing confidently-wrong `linked` values.
 */
export function parseWorkersTable(html: string): FlwInviteRow[] {
  const headerCells = [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) =>
    (m[1] ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase(),
  );
  if (headerCells.length === 0) {
    throw new WorkersTableSchemaError(
      'Connect workers table: no <th> header cells found. Either the fragment ' +
        'was not the workers table (check the HX-Request header and the URL) or ' +
        'the template changed. Refusing to guess column positions.',
    );
  }

  // Header index -> output field. The leading checkbox column has no label,
  // so positions are derived from the header list itself rather than assumed.
  const colIndex: Partial<Record<keyof typeof WORKER_COLUMNS, number>> = {};
  for (const [field, spec] of Object.entries(WORKER_COLUMNS) as Array<
    [keyof typeof WORKER_COLUMNS, (typeof WORKER_COLUMNS)[keyof typeof WORKER_COLUMNS]]
  >) {
    const idx = headerCells.findIndex((h) => h.length > 0 && spec.match(h));
    if (idx >= 0) colIndex[field] = idx;
    else if (spec.required) {
      throw new WorkersTableSchemaError(
        `Connect workers table: required column "${spec.label}" not found. ` +
          `Headers seen: [${headerCells.filter((h) => h).join(' | ')}]. ` +
          'The template changed — update lib/connect-flw-invites.ts rather than ' +
          'reading positionally.',
      );
    }
  }

  const rows: FlwInviteRow[] = [];
  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowMatch[1] ?? '';
    const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1] ?? '');
    if (cells.length === 0) continue; // header row

    // Cells include the leading checkbox column that carries no <th> label,
    // so data cells are offset by (cells.length - headerCells.length).
    const offset = cells.length - headerCells.length;
    const cellAt = (field: keyof typeof WORKER_COLUMNS): string | undefined => {
      const i = colIndex[field];
      if (i === undefined) return undefined;
      return cells[i + offset];
    };

    const phone = cellText(cellAt('phone') ?? '');
    // Rows without a phone are totals/empty-state rows, not workers.
    if (!phone || !/^\+?\d[\d\s-]*$/.test(phone)) continue;

    const statusHtml = cellAt('status') ?? '';
    const status: FlwInviteRow['status'] = /fa-circle-check/i.test(statusHtml)
      ? 'accepted'
      : /fa-clock/i.test(statusHtml)
        ? 'pending'
        : 'unknown';

    const nameRaw = cellText(cellAt('name') ?? '');
    // Linked rows render "<display name> <connect user id>"; the id is a long
    // hex-ish token. Split it off so callers get both halves.
    let name: string | null = nameRaw;
    let connectUserId: string | null = null;
    if (nameRaw) {
      const m = nameRaw.match(/^(.*?)\s+([0-9a-f]{16,})$/i);
      if (m) {
        name = m[1].trim() || null;
        connectUserId = m[2];
      }
    }

    rows.push({
      phone: phone.replace(/[\s-]/g, ''),
      name,
      connect_user_id: connectUserId,
      // Require the POSITIVE signal. A name alone is explicitly not enough
      // (#855), and `unknown` must never read as linked.
      linked: status === 'accepted' && name !== null,
      status,
      invited_date: cellText(cellAt('invited_date') ?? ''),
      completed_learn: cellText(cellAt('completed_learn') ?? ''),
    });
  }
  return rows;
}

/**
 * Find one phone's row. Compares digits only, so `+7426...` and `7426...`
 * match — callers pass `${ACE_E2E_PHONE}` in whatever form their env holds.
 */
export function findInviteByPhone(rows: FlwInviteRow[], phone: string): FlwInviteRow | null {
  const norm = (p: string) => p.replace(/\D/g, '');
  const want = norm(phone);
  return rows.find((r) => norm(r.phone) === want) ?? null;
}
