/**
 * Pure HTML/JSON parsing + decision helpers for CommCare HQ's web-user pages.
 *
 * Extracted from `scripts/grant-review-access.ts` (the manual half of
 * `skills/share-run-access`) so the `commcare_invite_web_user` atom and the
 * script share one proven implementation surface — the same move
 * `lib/ocs-team-page.ts` made for the OCS half in ace#906. Everything here is
 * pure string/JSON → data; no I/O.
 *
 * ## Contracts, read off HQ source + live pages (2026-07-23)
 *
 * - **Invite view** `InviteWebUserView`, routed at `web/invite/` under
 *   `/a/<domain>/settings/users/`. Form `AdminInvitesUserForm`: `email` +
 *   `role` (a ChoiceField whose VALUES are `role.get_qualified_id()` —
 *   `admin` or `user-role:<uuid>`, never the label). Location / custom-data /
 *   tableau fields render only when the project enables them, which is why
 *   callers must read the LIVE form and refuse to guess.
 * - **Success** is a 302 to `.../web/`. A 200 means the form re-rendered with
 *   errors.
 * - **Duplicate** is `AdminInvitesUserFormValidator.validate_email` rejecting
 *   an email that is already a web user or already invited. That error IS the
 *   idempotency signal.
 *
 * ## The two lessons this file exists to keep
 *
 * **1. Granting access is a ROLE decision, not a membership decision.** The
 * pages ACE's run summary links (App Summary, the app-builder views) are gated
 * by `require_can_edit_or_view_apps`, i.e. `edit_apps` with
 * `view_only_permission='view_apps'`. HQ's stock `Read Only` preset grants only
 * `view_reports` + `download_reports` — **no `view_apps`** — so a "Read Only"
 * member gets a bare 403 on every app link ACE shares, while the *releases*
 * page still renders (it is only `login_and_domain_required`). That asymmetry
 * is exactly what makes the access look like it "mostly works". Of the presets
 * only `App Editor` and `Admin` carry `view_apps`; `App Editor` is the
 * narrower. Hence {@link DEFAULT_HQ_ROLE}, and hence
 * {@link classifyHqInviteState} treating a member on the wrong role as work to
 * do rather than as "already present".
 *
 * **2. HQ's `web/json/` user list is Elasticsearch-backed and lags a write.**
 * `_get_web_users` runs `UserES`, so a role change HQ has already saved (302)
 * can still read back with the OLD role for seconds. The authoritative read is
 * the user's edit page, which renders `editable_user.get_role(domain)` straight
 * from Couch. {@link reconcileRoleReadback} encodes that precedence: the edit
 * page decides, and the list JSON is corroboration that may only ever
 * downgrade confidence, never veto a write proved on the edit page.
 */

/** The narrowest stock HQ role that can actually open the app links ACE shares. */
export const DEFAULT_HQ_ROLE = 'App Editor';

export function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Value of the Django `{% csrf_token %}` hidden input on a rendered page. */
export function csrfFromHtml(html: string): string | undefined {
  return html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/)?.[1];
}

/** `<div data-name="X" data-value="<html-escaped json>">` — HQ's initial_page_data. */
export function initialPageData(html: string, name: string): unknown {
  const re = new RegExp(`data-name="${name}"\\s+data-value="([^"]*)"`);
  const raw = html.match(re)?.[1];
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(unescapeHtml(raw));
  } catch {
    return undefined;
  }
}

/** All `<option value=..>label</option>` pairs of a named `<select>`. */
export function selectOptions(
  html: string,
  name: string,
): Array<{ value: string; label: string }> {
  const sel = html.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`, 'i'));
  if (!sel) return [];
  return [...sel[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)].map(
    (m) => ({
      value: m[1],
      label: unescapeHtml(m[2].replace(/<[^>]*>/g, '').trim()),
    }),
  );
}

/**
 * The `<form>…</form>` slice containing `marker`. Used to re-post a rendered
 * Django form field-for-field instead of guessing its payload — the page also
 * carries unrelated forms (the report-issue modal), so scraping the whole
 * document would mix them.
 */
export function formContaining(html: string, marker: string): string | undefined {
  const at = html.indexOf(marker);
  if (at === -1) return undefined;
  const open = html.lastIndexOf('<form', at);
  if (open === -1) return undefined;
  const close = html.indexOf('</form>', at);
  if (close === -1) return undefined;
  return html.slice(open, close + '</form>'.length);
}

/**
 * Every field a rendered form would submit, verbatim: text/hidden inputs,
 * CHECKED checkboxes/radios, the SELECTED option of each `<select>`, and each
 * `<textarea>`. Submit buttons and file inputs are excluded.
 *
 * Re-posting the WHOLE live form is the HQ-side analogue of the OCS
 * "MembershipForm REPLACES the m2m set" trap: a partial POST silently drops
 * whatever custom-data fields the project has enabled.
 */
export function formFields(formHtml: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of formHtml.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = tag.match(/\bname="([^"]+)"/)?.[1];
    if (!name) continue;
    const type = (tag.match(/\btype="([^"]*)"/)?.[1] ?? 'text').toLowerCase();
    if (['submit', 'button', 'reset', 'file', 'image'].includes(type)) continue;
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(tag)) continue;
    out.push([name, unescapeHtml(tag.match(/\bvalue="([^"]*)"/)?.[1] ?? '')]);
  }
  for (const m of formHtml.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    const selected = [...m[2].matchAll(/<option\b([^>]*)>/gi)].find((o) =>
      /\bselected\b/i.test(o[1]),
    );
    const value = selected?.[1].match(/\bvalue="([^"]*)"/)?.[1];
    if (value !== undefined) out.push([m[1], unescapeHtml(value)]);
  }
  for (const m of formHtml.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/gi)) {
    out.push([m[1], unescapeHtml(m[2])]);
  }
  return out;
}

/** Label of the currently-`selected` option of a named `<select>`, or ''. */
export function selectedOptionLabel(html: string, name: string): string {
  const sel = html.match(new RegExp(`<select[^>]*name="${name}"[\\s\\S]*?</select>`, 'i'))?.[0];
  if (!sel) return '';
  const chosen = [...sel.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].find((o) =>
    /\bselected\b/i.test(o[1]),
  );
  return chosen ? unescapeHtml(chosen[2].replace(/<[^>]*>/g, '').trim()) : '';
}

/**
 * Resolve a human role LABEL ("App Editor") to the `role` ChoiceField VALUE
 * HQ expects (`admin` / `user-role:<uuid>`).
 *
 * Refuses to guess: an unknown label returns undefined so the caller can fail
 * loud with the live option list rather than POSTing something HQ will reject
 * or, worse, silently coerce.
 */
export function resolveRoleValue(
  options: Array<{ value: string; label: string }>,
  wantedLabel: string,
): string | undefined {
  const want = wantedLabel.trim().toLowerCase();
  return options.find((o) => o.label.trim().toLowerCase() === want)?.value;
}

export interface HqWebUserRow {
  email: string;
  name?: string;
  /** `u.role_label(domain)` — a LABEL, so it round-trips against the select. */
  role?: string;
  /** The exact edit-page path HQ rendered. Never construct this. */
  editUrl?: string;
}

/** Rows out of `web/json/`'s `{users: [...]}` payload, matched on email. */
export function findWebUser(
  payload: unknown,
  email: string,
): HqWebUserRow | undefined {
  const users = (payload as { users?: Array<Record<string, unknown>> } | undefined)?.users;
  if (!Array.isArray(users)) return undefined;
  const lower = email.trim().toLowerCase();
  const hit = users.find((u) => String(u.email ?? '').toLowerCase() === lower);
  if (!hit) return undefined;
  return {
    email: String(hit.email ?? ''),
    name: hit.name === undefined ? undefined : String(hit.name),
    role: hit.role === undefined ? undefined : String(hit.role),
    editUrl: hit.editUrl === undefined ? undefined : String(hit.editUrl),
  };
}

/** Pending invitation for `email` out of the `invitations` initial-page-data. */
export function findPendingInvite(
  invitations: unknown,
  email: string,
): Record<string, unknown> | undefined {
  if (!Array.isArray(invitations)) return undefined;
  const lower = email.trim().toLowerCase();
  return (invitations as Array<Record<string, unknown>>).find(
    (i) => String(i.email ?? '').toLowerCase() === lower,
  );
}

export type HqInviteAction =
  /** Not a member and not invited — send the invite. */
  | 'invite'
  /** Already invited and not yet accepted — nothing to do. */
  | 'invite-pending'
  /** Accepted member already on the wanted role — nothing to do. */
  | 'already-member'
  /** Accepted member on a DIFFERENT role — change it. Never a skip. */
  | 'reconcile-role';

export interface HqInviteState {
  action: HqInviteAction;
  currentRole?: string;
  /** Present iff `action === 'reconcile-role'`; the path to POST to. */
  editUrl?: string;
  reason: string;
}

/**
 * Decide what to do for `email` on this domain, given both read-backs.
 *
 * The load-bearing case is `reconcile-role`. An accepted member on `Read Only`
 * looks like success to every membership-shaped check, and the invite POST
 * cannot fix it (HQ rejects it as a duplicate) — so a classifier that collapsed
 * "is a member" into "already present" would report done while every app link
 * ACE shares 403s. That is the exact defect a real reviewer hit.
 */
export function classifyHqInviteState(input: {
  webUser?: HqWebUserRow;
  pendingInvite?: Record<string, unknown>;
  wantedRole: string;
}): HqInviteState {
  const { webUser, pendingInvite, wantedRole } = input;

  if (webUser) {
    const current = webUser.role?.trim() ?? '';
    if (current.toLowerCase() === wantedRole.trim().toLowerCase()) {
      return {
        action: 'already-member',
        currentRole: current,
        reason: `already an accepted web user on "${current}"`,
      };
    }
    return {
      action: 'reconcile-role',
      currentRole: current || undefined,
      editUrl: webUser.editUrl,
      reason:
        `accepted web user, but on "${current || '(unknown)'}" rather than ` +
        `"${wantedRole}". Membership is not access — a role without view_apps ` +
        `403s on every app link ACE shares, while the releases page still ` +
        `renders, so this reads as working when it is not.`,
    };
  }

  if (pendingInvite) {
    return {
      action: 'invite-pending',
      reason: 'invitation already sent and not yet accepted',
    };
  }

  return { action: 'invite', reason: 'no accepted membership and no pending invitation' };
}

/**
 * Reconcile the two role read-backs after a write.
 *
 * The edit page is Couch-backed and authoritative. `web/json/` is
 * Elasticsearch-backed and lags by seconds, so a disagreement in the
 * stale-looking direction is INDEX LAG, not a failed write, and must never
 * veto a change the edit page already confirmed.
 *
 * The one case that IS a failure is the edit page itself still showing the old
 * role — that means the POST did not take, whatever status it returned.
 */
export function reconcileRoleReadback(input: {
  editPageRole: string;
  listJsonRole?: string;
  wantedRole: string;
}): { ok: boolean; lagged: boolean; detail: string } {
  const want = input.wantedRole.trim().toLowerCase();
  const edit = input.editPageRole.trim().toLowerCase();

  if (edit !== want) {
    return {
      ok: false,
      lagged: false,
      detail:
        `edit page still shows "${input.editPageRole}" after the write — the ` +
        `POST did not take (a 302 is not proof)`,
    };
  }

  const list = input.listJsonRole?.trim().toLowerCase();
  if (list !== undefined && list !== want) {
    return {
      ok: true,
      lagged: true,
      detail:
        `edit page confirms "${input.wantedRole}"; web/json/ still reports ` +
        `"${input.listJsonRole}" — Elasticsearch index lag, not a failure`,
    };
  }

  return { ok: true, lagged: false, detail: `confirmed "${input.wantedRole}" on both reads` };
}
