/**
 * grant-review-access — grant one person review access on the two platform
 * surfaces that have no MCP atom yet: CommCare HQ (web-user invite) and Open
 * Chat Studio (team invite). The manual half of `skills/share-run-access`.
 *
 *   npx tsx scripts/grant-review-access.ts <email> \
 *     [--domain connect-ace-prod] [--team connect-ace] \
 *     [--hq-role "App Editor"] [--ocs-groups "Chatbot Admin"] \
 *     [--only hq|ocs] [--dry-run]
 *
 * Auth is reused, never reimplemented: HQ goes through the Connect
 * `PlaywrightSession` (the OAuth-via-CCHQ flow leaves valid CCHQ cookies in the
 * same jar — see mcp/connect/backends/commcare.ts), OCS through the OCS
 * `PlaywrightSession`. Both backends are HTTP-only (`page.request`); this
 * script keeps that rule — no click-driving, no selectors.
 *
 * ── Verified contracts (live reads, 2026-07-23, + HQ source) ──────────────
 *
 * CommCare HQ — web-user invite
 *   View     `InviteWebUserView` (corehq/apps/users/views/__init__.py:910),
 *            routed at `web/invite/` (corehq/apps/users/urls.py:120) under the
 *            `/a/<domain>/settings/users/` include
 *            (corehq/apps/settings/urls.py:34).
 *   Form     `AdminInvitesUserForm` (corehq/apps/registration/forms.py:561):
 *            `email` (EmailField) + `role` (ChoiceField whose values are
 *            `role.get_qualified_id()` — `admin` or `user-role:<uuid>`, see
 *            corehq/apps/users/views/utils.py:49-52). Location / custom-data /
 *            tableau fields only render when the project enables them; the
 *            script reads the LIVE form and refuses to guess.
 *   Success  302 → `/a/<domain>/settings/users/web/` (the view's
 *            HttpResponseRedirect to ListWebUsersView). A 200 means the form
 *            re-rendered with errors.
 *   ⚠ DEFAULT ROLE = "App Editor", and that is load-bearing — the exact HQ-side
 *     twin of the OCS "Chat Viewer" trap below. The pages ACE's run summary links
 *     (App Summary, the app builder's form/module views) are gated by
 *     `require_can_edit_or_view_apps` = `require_permission('edit_apps',
 *     view_only_permission='view_apps')` (corehq/apps/app_manager/decorators.py:231,
 *     applied at app_summary.py:37). The stock "Read Only" preset grants ONLY
 *     `view_reports` + `download_reports` — no `view_apps`, no `edit_apps`
 *     (corehq/apps/users/role_utils.py:14) — so a "Read Only" member lands on a
 *     bare 403 on every app link, while the releases page still renders (it is
 *     `require_deploy_apps` = `login_and_domain_required`, decorators.py:234).
 *     That asymmetry is exactly what makes it look like access "mostly works".
 *     Of the presets, only "App Editor" and "Admin" carry `view_apps`
 *     (role_utils.py:15-18); "App Editor" is the narrower of the two. Do not
 *     "tighten" this back to Read Only without re-reading those lines — it
 *     silently reintroduces the 403. If a domain needs view-only app access,
 *     create a custom role with `view_apps` and pass it via --hq-role.
 *     Live-verified on connect-ace-prod, 2026-07-23.
 *   Conflict `AdminInvitesUserFormValidator.validate_email`
 *            (corehq/apps/registration/validation.py:28-38) rejects an email
 *            already a web user or already invited — that error IS the
 *            idempotency signal (attempt the transition, treat the conflict as
 *            the skip).
 *   Read-back
 *            pending invites: `GET /a/<domain>/settings/users/web/` renders
 *            `<div data-name="invitations" data-value="<json>">` via the
 *            `initial_page_data` tag (ListWebUsersView.invitations,
 *            corehq/apps/users/views/__init__.py:561-578;
 *            corehq/apps/hqwebapp/templatetags/hq_shared_tags.py:641).
 *            accepted web users: `GET /a/<domain>/settings/users/web/json/`
 *            (`paginate_web_users`, views/__init__.py:713). NOTE the
 *            `showActiveUsers` query param is mandatory — the view does
 *            `json.loads(request.GET.get('showActiveUsers', None))`
 *            (views/__init__.py:765), which raises on a missing param.
 *
 * Open Chat Studio — team invite
 *   Field shapes were read off the LIVE rendered page at `GET /a/<team>/team/`
 *   (no local checkout ships with ACE); group semantics were verified against
 *   upstream source, `github.com/dimagi/open-chat-studio` @ 149c591 (2026-07-23).
 *     <form hx-post="/a/<team>/team/invite/" hx-target="#invitation-form-and-table">
 *       <input type="hidden" name="csrfmiddlewaretoken" value="...">
 *       <input type="email" name="email" maxlength="254" required id="id_email">
 *       <input type="checkbox" name="groups" value="<pk>">  (one per team group)
 *   Cancel  `POST /a/<team>/team/invite/cancel/<invitation-uuid>/`
 *           (`single_team:cancel_invitation`, apps/teams/urls.py:22 →
 *           `cancel_invitation_view`, apps/teams/views/manage_team_views.py:207,
 *           which deletes the Invitation and returns an empty 200). The row's
 *           cancel URL is rendered per-invitation in
 *           templates/teams/components/invitation_row.html:12.
 *   Read-back
 *           `GET /a/<team>/team/` renders the "Team Members" table (accepted
 *           members) and, inside `#invitation-form-and-table`, a "Pending
 *           Invitations" table whose columns are Email / Invited / Roles
 *           (templates/teams/components/invitation_row.html:2-5).
 *
 *   ⚠ DEFAULT GROUP = "Chatbot Admin", and that is load-bearing. The surface the
 *   run-summary links is the chatbot admin page `/a/<team>/chatbots/<id>/`, served
 *   by `single_chatbot_home`, which is gated by
 *   `@permission_required("experiments.view_experiment", raise_exception=True)`
 *   (apps/chatbots/views.py:303). "Chat Viewer" DELIBERATELY does not carry that
 *   permission — `CHAT_VIEWER_PERMS` grants only `experiments.experimentsession`
 *   view, with the comment "so a Chat Viewer cannot view or edit
 *   experiment/chatbot configuration" (apps/teams/backends.py:180-186), and an
 *   upstream regression test asserts a Chat Viewer gets 403 on
 *   `chatbots:single_chatbot_home` (apps/teams/tests/test_permissions.py:231-241,
 *   :288). The only non-superuser group carrying `experiments.view_experiment` is
 *   CHATBOT_ADMIN_GROUP, via `AppPermSetDef("experiments", ALL)`
 *   (apps/teams/backends.py:205-219); Super Admin also has it but is strictly
 *   broader. So Chatbot Admin is the least-privilege group that actually opens the
 *   linked page. Do not "tighten" this to Chat Viewer without re-reading those
 *   lines — it silently reintroduces the 403.
 *
 *   Membership is not access here either: an ALREADY-accepted member on the wrong
 *   group 403s just the same. So "already a team member" is NOT the skip — the
 *   member's groups are reconciled (additively) through the membership edit page
 *   when they don't already include the requested set. See `ocsSetMemberGroups`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { APIRequestContext } from 'playwright';
import { PlaywrightSession as ConnectSession } from '../mcp/connect/auth/playwright-session.js';
import { PlaywrightSession as OcsSession } from '../mcp/ocs/auth/playwright-session.js';

// ── env ────────────────────────────────────────────────────────────────────
// Values live in the installed plugin-data .env (1Password-backed). Load them
// the same way the probe scripts do rather than hardcoding anything.
function loadEnv(): void {
  const candidates = [
    process.env.CLAUDE_PLUGIN_DATA,
    path.join(process.env.HOME ?? '', '.claude/plugins/data/ace-ace'),
  ].filter((d): d is string => Boolean(d) && !d!.includes('${'));
  for (const dir of candidates) {
    const file = path.join(dir, '.env');
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
    return;
  }
  throw new Error('No .env found — run /ace:setup first.');
}

// ── tiny HTML helpers (HTTP-only backends; no DOM available) ───────────────
function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Value of the Django `{% csrf_token %}` hidden input on a rendered page. */
function csrfFromHtml(html: string): string | undefined {
  return html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/)?.[1];
}

/** `<div data-name="X" data-value="<html-escaped json>">` — HQ's initial_page_data. */
function initialPageData(html: string, name: string): unknown {
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
function selectOptions(html: string, name: string): Array<{ value: string; label: string }> {
  const sel = html.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`, 'i'));
  if (!sel) return [];
  return [...sel[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)].map((m) => ({
    value: m[1],
    label: unescapeHtml(m[2].replace(/<[^>]*>/g, '').trim()),
  }));
}

/**
 * The `<form>…</form>` slice that contains `marker`. Used to re-post a rendered
 * Django form field-for-field instead of guessing its payload — the page also
 * carries unrelated forms (the report-issue modal), so scraping the whole
 * document would mix them.
 */
function formContaining(html: string, marker: string): string | undefined {
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
 * `<textarea>`. Submit buttons and file inputs are excluded (a file input has
 * no re-postable value).
 */
function formFields(formHtml: string): Array<[string, string]> {
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
function selectedOptionLabel(html: string, name: string): string {
  const sel = html.match(new RegExp(`<select[^>]*name="${name}"[\\s\\S]*?</select>`, 'i'))?.[0];
  if (!sel) return '';
  const chosen = [...sel.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].find((o) =>
    /\bselected\b/i.test(o[1]),
  );
  return chosen ? unescapeHtml(chosen[2].replace(/<[^>]*>/g, '').trim()) : '';
}

/** All `<input type=checkbox name=X value=V>` + their `<label>` text. */
function checkboxOptions(html: string, name: string): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const re = new RegExp(
    `<input[^>]*type="checkbox"[^>]*name="${name}"[^>]*value="([^"]*)"[^>]*>([^<]*)`,
    'gi',
  );
  for (const m of html.matchAll(re)) out.push({ value: m[1], label: unescapeHtml(m[2].trim()) });
  return out;
}

/** Section of `html` between an element carrying `id="<id>"` and EOF-or-next marker. */
function sectionById(html: string, id: string): string {
  const i = html.indexOf(`id="${id}"`);
  return i === -1 ? '' : html.slice(i);
}

function stripTags(s: string): string {
  return unescapeHtml(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// ── report model ───────────────────────────────────────────────────────────
type Status = 'granted' | 'already-present' | 'NOT DONE';
interface SurfaceResult {
  surface: string;
  status: Status;
  detail: string;
  /** Verbatim read-back output. Empty means the read-back did NOT prove anything. */
  readback: string[];
}

const results: SurfaceResult[] = [];
function record(r: SurfaceResult): void {
  results.push(r);
  console.log(`\n[${r.surface}] ${r.status} — ${r.detail}`);
  for (const line of r.readback) console.log(`    ${line}`);
}

// ── CommCare HQ ────────────────────────────────────────────────────────────
interface HqReadback {
  webUser?: Record<string, unknown>;
  invitation?: Record<string, unknown>;
  raw: string[];
}

async function hqReadback(
  request: APIRequestContext,
  hqBase: string,
  domain: string,
  email: string,
): Promise<HqReadback> {
  const raw: string[] = [];
  const lower = email.toLowerCase();

  // 1. accepted web users — paginate_web_users. showActiveUsers is REQUIRED.
  const jsonUrl =
    `${hqBase}/a/${domain}/settings/users/web/json/` +
    `?limit=100&page=1&showActiveUsers=true&query=${encodeURIComponent(email)}`;
  const jr = await request.get(jsonUrl, { maxRedirects: 0 });
  raw.push(`GET ${jsonUrl} -> ${jr.status()}`);
  let webUser: Record<string, unknown> | undefined;
  if (jr.status() === 200) {
    const body = (await jr.json()) as { users?: Array<Record<string, unknown>> };
    webUser = (body.users ?? []).find((u) => String(u.email ?? '').toLowerCase() === lower);
    raw.push(
      `  web_users matching "${email}": ` +
        JSON.stringify(
          (body.users ?? []).map((u) => ({ email: u.email, name: u.name, role: u.role })),
        ),
    );
  } else {
    raw.push(`  (non-200 — read-back for accepted web users INCONCLUSIVE)`);
  }

  // 2. pending invitations — rendered into the web-users page as initial_page_data.
  const listUrl = `${hqBase}/a/${domain}/settings/users/web/`;
  const lr = await request.get(listUrl, { maxRedirects: 0 });
  raw.push(`GET ${listUrl} -> ${lr.status()}`);
  let invitation: Record<string, unknown> | undefined;
  if (lr.status() === 200) {
    const invites = initialPageData(await lr.text(), 'invitations');
    if (Array.isArray(invites)) {
      invitation = (invites as Array<Record<string, unknown>>).find(
        (i) => String(i.email ?? '').toLowerCase() === lower,
      );
      raw.push(`  initial-page-data "invitations" = ${JSON.stringify(invites)}`);
    } else {
      raw.push('  (could not parse "invitations" initial-page-data — read-back INCONCLUSIVE)');
    }
  } else {
    raw.push('  (non-200 — read-back for pending invitations INCONCLUSIVE)');
  }

  return { webUser, invitation, raw };
}

/**
 * Bring an ALREADY-accepted web user's role up to `roleLabel`.
 *
 * Membership is not access: a member on a role without `view_apps` gets a bare
 * 403 on every app page we link (see the ⚠ block in the header). The invite POST
 * cannot fix that — HQ rejects it as a duplicate — so the role is changed
 * through `EditWebUserView` instead.
 *
 * Contract (read off HQ source + the live page, 2026-07-23):
 *   Route   `web/account/<couch_user_id>/` → `EditWebUserView`
 *           (corehq/apps/users/urls.py:115). The exact path arrives as
 *           `editUrl` on the `web/json/` row — never constructed here.
 *   Form    `WebUserFormSet` (corehq/apps/users/forms.py:1493) = the
 *           `UpdateUserRoleForm` (`role`, forms.py:247) plus the custom-data
 *           form, dispatched on a hidden `form_type=update-user`
 *           (views/__init__.py:354-365). Custom-data fields vary per project,
 *           so the whole live form is re-posted field-for-field.
 *   Success 302 → the same page (views/__init__.py:367-370). A 200 means the
 *           form re-rendered with errors, i.e. NOT saved.
 *   Proof   `web/json/` re-read: `role` is `u.role_label(domain)`
 *           (views/__init__.py:722), so the label round-trips.
 */
async function hqSetRole(
  request: APIRequestContext,
  hqBase: string,
  editUrl: string,
  roleLabel: string,
  dryRun: boolean,
): Promise<{ ok: boolean; detail: string; raw: string[] }> {
  const raw: string[] = [];
  const url = editUrl.startsWith('http') ? editUrl : `${hqBase}${editUrl}`;

  const gr = await request.get(url, { maxRedirects: 0 });
  raw.push(`GET ${url} -> ${gr.status()}`);
  if (gr.status() !== 200) {
    return { ok: false, detail: `GET ${url} -> ${gr.status()} (expected 200)`, raw };
  }
  const html = await gr.text();

  const form = formContaining(html, 'value="update-user"');
  const csrf = csrfFromHtml(html);
  const roles = selectOptions(html, 'role').filter((o) => o.value);
  if (!form || !csrf || roles.length === 0) {
    return {
      ok: false,
      detail:
        'Could not parse the update-user form, its csrfmiddlewaretoken, and/or the role ' +
        '<select> off the live edit page — HQ changed the template. Not guessing a payload.',
      raw: [...raw, `role options parsed: ${JSON.stringify(roles)}`],
    };
  }

  const chosen = roles.find((r) => r.label.toLowerCase() === roleLabel.toLowerCase());
  if (!chosen) {
    return {
      ok: false,
      detail:
        `Requested role "${roleLabel}" is not offered on this page. ` +
        `Pick one of the live options with --hq-role.`,
      raw: [...raw, `live role options: ${roles.map((r) => `${r.label} = ${r.value}`).join(' | ')}`],
    };
  }

  const fields = formFields(form).filter(([n]) => n !== 'role' && n !== 'csrfmiddlewaretoken');
  const body = new URLSearchParams([
    ['csrfmiddlewaretoken', csrf],
    ...fields,
    ['form_type', 'update-user'],
    ['role', chosen.value],
  ]);
  // form_type is already a hidden input on the form; de-dup so HQ reads one value.
  const seen = new Set<string>();
  const deduped = new URLSearchParams();
  for (const [k, v] of [...body.entries()].reverse()) {
    if (k === 'form_type' || k === 'role' || k === 'csrfmiddlewaretoken') {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    deduped.append(k, v);
  }

  raw.push(
    `[hq] POST ${url} role="${chosen.label}" (${chosen.value}); ` +
      `re-posting ${fields.length} other live field(s): ${fields.map(([n]) => n).join(', ') || '(none)'}`,
  );
  if (dryRun) return { ok: false, detail: '--dry-run: no POST issued', raw };

  const pr = await request.post(url, {
    data: deduped.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': csrf,
      Referer: url,
    },
    maxRedirects: 0,
  });
  raw.push(`POST ${url} -> ${pr.status()}`);
  if (pr.status() === 302) {
    // Prove it against the AUTHORITATIVE source, not the search index. This page
    // renders the selected role from `editable_user.get_role(domain)` straight out
    // of Couch (views/__init__.py:392-404), whereas `web/json/` is served from
    // Elasticsearch (`_get_web_users` → `UserES`, views/__init__.py:759-793) and
    // lags a save by seconds — a stale ES read here reports a landed change as
    // NOT DONE.
    const vr = await request.get(url, { maxRedirects: 0 });
    raw.push(`GET ${url} (verify) -> ${vr.status()}`);
    const nowLabel = vr.status() === 200 ? selectedOptionLabel(await vr.text(), 'role') : '';
    raw.push(`  edit page (Couch) now shows role: "${nowLabel || '(unparsed)'}"`);
    if (nowLabel.toLowerCase() !== roleLabel.toLowerCase()) {
      return {
        ok: false,
        detail:
          `HQ returned 302 but the edit page still shows role "${nowLabel || '?'}" — ` +
          `a 302 is not proof; treat as not done.`,
        raw,
      };
    }
    return { ok: true, detail: `role set to "${chosen.label}"`, raw };
  }
  {
    const text = await pr.text();
    const errs = [
      ...text.matchAll(
        /<(?:ul|div|p|span)[^>]*class="[^"]*(?:errorlist|invalid-feedback|alert-danger|help-block)[^"]*"[^>]*>([\s\S]*?)<\/(?:ul|div|p|span)>/gi,
      ),
    ]
      .map((m) => stripTags(m[1]))
      .filter(Boolean);
    return {
      ok: false,
      detail:
        `HQ did not save the role change (expected 302, got ${pr.status()})` +
        (errs.length ? `: ${errs.join(' | ')}` : ''),
      raw,
    };
  }
}

async function grantHq(opts: {
  email: string;
  domain: string;
  roleLabel: string;
  dryRun: boolean;
}): Promise<void> {
  const surface = `CommCare HQ · ${opts.domain}`;
  const hqBase = process.env.ACE_HQ_BASE_URL || 'https://www.commcarehq.org';
  const session = new ConnectSession({
    baseUrl: process.env.CONNECT_BASE_URL || 'https://connect.dimagi.com',
    cchqBaseUrl: hqBase,
    hqUsername: process.env.ACE_HQ_USERNAME,
    hqPassword: process.env.ACE_HQ_PASSWORD,
  });

  try {
    const ctx = await session.getContext();
    const request = ctx.request;

    // Pre-check (reporting only — the POST's conflict error is the real guard).
    const pre = await hqReadback(request, hqBase, opts.domain, opts.email);
    if (pre.webUser) {
      const current = String(pre.webUser.role ?? '');
      // Membership is not access. A member whose role lacks `view_apps` 403s on
      // every app link we share, so a role mismatch is NOT "already present".
      if (current.toLowerCase() === opts.roleLabel.toLowerCase()) {
        record({
          surface,
          status: 'already-present',
          detail: `already an accepted web user on the requested role "${current}"`,
          readback: pre.raw,
        });
        return;
      }
      const editUrl = String(pre.webUser.editUrl ?? '');
      if (!editUrl) {
        record({
          surface,
          status: 'NOT DONE',
          detail:
            `accepted web user but on role "${current}", not the requested ` +
            `"${opts.roleLabel}" — and the read-back carried no editUrl, so the role ` +
            `cannot be reconciled here. Owner: a domain admin must change it in the UI.`,
          readback: pre.raw,
        });
        return;
      }
      console.log(
        `[hq] ${opts.email} is already a web user but on role "${current}" — ` +
          `reconciling to "${opts.roleLabel}"`,
      );
      // hqSetRole proves the change against the edit page (Couch). The web/json
      // read-back below is CORROBORATION ONLY — it is Elasticsearch-backed and
      // lags a save by seconds, so it must never be able to veto the proof.
      const set = await hqSetRole(request, hqBase, editUrl, opts.roleLabel, opts.dryRun);
      const post = await hqReadback(request, hqBase, opts.domain, opts.email);
      const esRole = String(post.webUser?.role ?? '?');
      const esAgrees = esRole.toLowerCase() === opts.roleLabel.toLowerCase();
      record({
        surface,
        status: set.ok ? 'granted' : 'NOT DONE',
        detail: set.ok
          ? `role changed "${current}" -> "${opts.roleLabel}" (was already a web user)` +
            (esAgrees ? '' : `; the ES-backed user list still shows "${esRole}" — index lag, not a failure`)
          : set.detail,
        readback: [...pre.raw, ...set.raw, ...post.raw],
      });
      return;
    }
    if (pre.invitation) {
      const current = String(pre.invitation.role_label ?? '');
      const matches = current.toLowerCase() === opts.roleLabel.toLowerCase();
      record({
        surface,
        status: matches ? 'already-present' : 'NOT DONE',
        detail: matches
          ? `pending invitation already exists on the requested role "${current}"`
          : `pending invitation exists but on role "${current}", not the requested ` +
            `"${opts.roleLabel}". Accepting it would land them on a role that cannot open ` +
            `the app links. Owner: edit or delete + re-issue the invite at ` +
            `${hqBase}/a/${opts.domain}/settings/users/web/.`,
        readback: pre.raw,
      });
      return;
    }

    // Read the LIVE form. Never guess a field or a role id.
    const invitePath = `${hqBase}/a/${opts.domain}/settings/users/web/invite/`;
    const gr = await request.get(invitePath, { maxRedirects: 0 });
    if (gr.status() === 302) {
      record({
        surface,
        status: 'NOT DONE',
        detail:
          `GET ${invitePath} -> 302 ${gr.headers()['location'] ?? ''} — ` +
          `ACE lacks edit-web-users permission on ${opts.domain}, or the session expired. ` +
          `Owner: a domain admin of ${opts.domain} must grant ace@dimagi-ai.com the ` +
          `"Edit Web Users" permission (or run the invite themselves).`,
        readback: [],
      });
      return;
    }
    if (gr.status() !== 200) {
      record({
        surface,
        status: 'NOT DONE',
        detail: `GET ${invitePath} -> ${gr.status()} (expected 200)`,
        readback: [],
      });
      return;
    }
    const html = await gr.text();
    const csrf = csrfFromHtml(html);
    const roles = selectOptions(html, 'role').filter((o) => o.value);
    if (!csrf || roles.length === 0) {
      record({
        surface,
        status: 'NOT DONE',
        detail:
          'Could not parse csrfmiddlewaretoken and/or the role <select> off the live invite ' +
          'form — HQ changed the template. Not guessing a payload.',
        readback: [`role options parsed: ${JSON.stringify(roles)}`],
      });
      return;
    }

    const chosen = roles.find((r) => r.label.toLowerCase() === opts.roleLabel.toLowerCase());
    if (!chosen) {
      record({
        surface,
        status: 'NOT DONE',
        detail:
          `Requested role "${opts.roleLabel}" is not offered on ${opts.domain}. ` +
          `Pick one of the live options with --hq-role.`,
        readback: [`live role options: ${roles.map((r) => `${r.label} = ${r.value}`).join(' | ')}`],
      });
      return;
    }

    // Any other required field on this form is a field we did not verify.
    // Fail loud rather than invent a value (CLAUDE.md: no plausible guesses at
    // another system's contract).
    const unknownRequired = [
      ...html.matchAll(/<(input|select)\b([^>]*\brequired\b[^>]*)>/gi),
    ]
      .map((m) => m[2].match(/\bname="([^"]+)"/)?.[1])
      .filter((n): n is string => Boolean(n))
      .filter((n) => !['email', 'role', 'csrfmiddlewaretoken'].includes(n));
    if (unknownRequired.length) {
      record({
        surface,
        status: 'NOT DONE',
        detail:
          `The live invite form requires field(s) this script has not verified: ` +
          `${[...new Set(unknownRequired)].join(', ')}. Refusing to guess values. ` +
          `Owner: a human should complete the invite at ${invitePath}.`,
        readback: [],
      });
      return;
    }

    console.log(
      `[hq] POST ${invitePath} email=${opts.email} role="${chosen.label}" (${chosen.value})`,
    );
    if (opts.dryRun) {
      record({ surface, status: 'NOT DONE', detail: '--dry-run: no POST issued', readback: [] });
      return;
    }

    const body = new URLSearchParams({
      csrfmiddlewaretoken: csrf,
      email: opts.email,
      role: chosen.value,
    });
    const pr = await request.post(invitePath, {
      data: body.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRFToken': csrf,
        Referer: invitePath,
      },
      maxRedirects: 0,
    });

    if (pr.status() === 302) {
      const post = await hqReadback(request, hqBase, opts.domain, opts.email);
      const proven = Boolean(post.webUser || post.invitation);
      record({
        surface,
        status: proven ? 'granted' : 'NOT DONE',
        detail: proven
          ? `invite created (role "${chosen.label}"); HQ 302 -> ${pr.headers()['location']}`
          : `HQ returned 302 -> ${pr.headers()['location']} but the read-back does NOT show ` +
            `${opts.email} as a web user or pending invite. A 200/302 is not proof — treat as not done.`,
        readback: post.raw,
      });
      return;
    }

    if (pr.status() === 200) {
      // Form re-rendered with errors. The "already in this project or has a
      // pending invitation" error is the idempotency signal.
      const text = await pr.text();
      const errs = [...text.matchAll(/<(?:ul|div|p|span)[^>]*class="[^"]*(?:errorlist|invalid-feedback|alert-danger|help-block)[^"]*"[^>]*>([\s\S]*?)<\/(?:ul|div|p|span)>/gi)]
        .map((m) => stripTags(m[1]))
        .filter(Boolean);
      const blob = errs.join(' | ') || stripTags(text).slice(0, 400);
      if (/already in this project or has a pending invitation/i.test(text)) {
        const post = await hqReadback(request, hqBase, opts.domain, opts.email);
        record({
          surface,
          status: 'already-present',
          detail: 'HQ rejected the invite as a duplicate (already a web user or already invited)',
          readback: post.raw,
        });
        return;
      }
      record({
        surface,
        status: 'NOT DONE',
        detail: `HQ re-rendered the invite form (200) with validation errors: ${blob}`,
        readback: [],
      });
      return;
    }

    record({
      surface,
      status: 'NOT DONE',
      detail: `POST ${invitePath} -> ${pr.status()}: ${(await pr.text()).slice(0, 300)}`,
      readback: [],
    });
  } catch (err) {
    record({
      surface,
      status: 'NOT DONE',
      detail: `threw: ${(err as Error).message}`,
      readback: [],
    });
  } finally {
    await session.close().catch(() => undefined);
  }
}

// ── Open Chat Studio ───────────────────────────────────────────────────────
interface OcsPendingInvite {
  email: string;
  invited: string;
  /** Group names exactly as OCS renders them (`invitation.groups.all|join:", "`). */
  groups: string[];
  /** Per-row cancel URL from invitation_row.html:12, or undefined if not rendered. */
  cancelUrl?: string;
}

interface OcsReadback {
  isMember: boolean;
  /** The matched accepted member's row, when `isMember` — id drives the edit URL. */
  member?: { id: string; label: string };
  pending?: OcsPendingInvite;
  raw: string[];
}

function parseOcsTeamPage(html: string, email: string): OcsReadback {
  const lower = email.toLowerCase();
  const raw: string[] = [];

  // Team Members table — rows render as `Name &lt;email&gt;` anchors.
  const membersIdx = html.indexOf('Team Members');
  const inviteIdx = html.indexOf('id="invitation-form-and-table"', membersIdx);
  const membersHtml =
    membersIdx === -1 ? '' : html.slice(membersIdx, inviteIdx === -1 ? undefined : inviteIdx);
  const members = [...membersHtml.matchAll(/<a[^>]*href="[^"]*\/team\/members\/(\d+)\/"[^>]*>([\s\S]*?)<\/a>/gi)].map(
    (m) => ({ id: m[1], label: stripTags(m[2]) }),
  );
  raw.push(`  Team Members table: ${JSON.stringify(members)}`);

  // Pending Invitations table lives inside #invitation-form-and-table, after the
  // invite form. Each row: <td>email</td><td>invited</td><td>roles</td> plus a
  // cancel form (templates/teams/components/invitation_row.html:2-15).
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

/** The `value`s of the CHECKED checkboxes of a named group (order-independent). */
function checkedCheckboxValues(html: string, name: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(new RegExp(`<input\\b[^>]*name="${name}"[^>]*>`, 'gi'))) {
    if (/\bchecked\b/i.test(m[0])) {
      const v = m[0].match(/\bvalue="([^"]*)"/)?.[1];
      if (v !== undefined) out.push(v);
    }
  }
  return out;
}

function sameGroups(a: string[], b: string[]): boolean {
  const norm = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))].sort().join('|');
  return norm(a) === norm(b);
}

/**
 * Bring an ALREADY-accepted team member's groups up to include `wantLabels`.
 *
 * Membership is not access — the OCS twin of the HQ role trap. The chatbot admin
 * page ACE links (`/a/<team>/chatbots/<id>/`) needs `experiments.view_experiment`,
 * carried only by "Chatbot Admin" (see the ⚠ block in the header); a member
 * accepted onto some other group 403s there. The invite POST can't fix it (they
 * are no longer invitable), so the groups are edited through the membership page.
 *
 * Additive by design: the POST is the UNION of the member's current groups and
 * the requested ones, because `MembershipForm.save()` REPLACES the m2m set
 * (apps/teams/forms.py:221-226 → `fields = ("groups",)`). Posting only the
 * requested groups would strip whatever else they had — this is a grant, not a
 * role-management tool, so it never removes access.
 *
 * Contract (read off OCS source + the live page, 2026-07-24):
 *   Route   `members/<membership_id>/` → `team_membership_details`
 *           (apps/teams/urls.py:18 → apps/teams/views/membership_views.py:19).
 *           membership_id is the `id` already parsed off the Team Members anchor.
 *   Guard   a non-admin GET on someone else's membership 302-redirects with
 *           "you don't have permission" (membership_views.py:22-24), so a 200
 *           here also proves ACE can edit.
 *   Form    `MembershipForm` — `fields = ("groups",)`, `CheckboxSelectMultiple`
 *           (apps/teams/forms.py:221-226). Plain form POST to the same URL with
 *           `{% csrf_token %}` (templates/teams/team_membership_details.html);
 *           NOT htmx. Live groups render as
 *           `<label><input name="groups" value="<pk>" [checked]> Label</label>`.
 *   Success re-renders the page 200 with the new set checked (the view returns
 *           `render(...)`, not a redirect — membership_views.py:41-50).
 *   Proof   re-GET the same page; every requested group's checkbox is `checked`.
 */
async function ocsSetMemberGroups(
  request: APIRequestContext,
  ocsBase: string,
  team: string,
  memberId: string,
  wantLabels: string[],
  dryRun: boolean,
): Promise<{ ok: boolean; detail: string; raw: string[] }> {
  const raw: string[] = [];
  const url = `${ocsBase}/a/${team}/team/members/${memberId}/`;

  const gr = await request.get(url, { maxRedirects: 0 });
  raw.push(`GET ${url} -> ${gr.status()}`);
  if (gr.status() !== 200) {
    return {
      ok: false,
      detail:
        `GET ${url} -> ${gr.status()} ${gr.headers()['location'] ?? ''} — ACE cannot open the ` +
        `membership edit page (not a Team Admin on "${team}", or the session expired). ` +
        `Owner: a Team Admin must set the member's groups.`,
      raw,
    };
  }
  const html = await gr.text();
  const csrf = csrfFromHtml(html);
  const groups = checkboxOptions(html, 'groups');
  if (!csrf || groups.length === 0) {
    return {
      ok: false,
      detail:
        'Could not parse csrfmiddlewaretoken and/or the groups checkboxes off the live ' +
        'membership page — OCS changed the template. Not guessing a payload.',
      raw: [...raw, `groups parsed: ${JSON.stringify(groups)}`],
    };
  }

  const byLabel = (label: string) => groups.find((g) => g.label.toLowerCase() === label.toLowerCase());
  const wantValues: string[] = [];
  for (const label of wantLabels) {
    const g = byLabel(label);
    if (!g) {
      return {
        ok: false,
        detail: `Requested group "${label}" is not offered on team "${team}".`,
        raw: [...raw, `live groups: ${groups.map((g2) => `${g2.label} = ${g2.value}`).join(' | ')}`],
      };
    }
    wantValues.push(g.value);
  }

  const current = checkedCheckboxValues(html, 'groups');
  const labelOf = (v: string) => groups.find((g) => g.value === v)?.label ?? v;
  raw.push(`  member currently in group(s): ${current.map(labelOf).join(', ') || '(none)'}`);

  const missing = wantValues.filter((v) => !current.includes(v));
  if (missing.length === 0) {
    return {
      ok: true,
      detail: `already carries the requested group(s) ${wantLabels.join(', ')}`,
      raw,
    };
  }

  // Additive union — never strip an existing group (MembershipForm REPLACES the set).
  const union = [...new Set([...current, ...wantValues])];
  raw.push(
    `[ocs] POST ${url} adding [${missing.map(labelOf).join(', ')}]; ` +
      `posting union [${union.map(labelOf).join(', ')}]`,
  );
  if (dryRun) return { ok: false, detail: '--dry-run: no POST issued', raw };

  const body = new URLSearchParams();
  body.set('csrfmiddlewaretoken', csrf);
  for (const v of union) body.append('groups', v);
  const pr = await request.post(url, {
    data: body.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': csrf,
      Referer: url,
    },
    maxRedirects: 0,
  });
  raw.push(`POST ${url} -> ${pr.status()}`);
  if (pr.status() >= 400) {
    return {
      ok: false,
      detail: `POST ${url} -> ${pr.status()}: ${(await pr.text()).slice(0, 300)}`,
      raw,
    };
  }

  // Prove against a fresh read, not the POST response — every requested group checked.
  const vr = await request.get(url, { maxRedirects: 0 });
  raw.push(`GET ${url} (verify) -> ${vr.status()}`);
  const nowChecked = vr.status() === 200 ? checkedCheckboxValues(await vr.text(), 'groups') : [];
  raw.push(`  member now in group(s): ${nowChecked.map(labelOf).join(', ') || '(unparsed)'}`);
  const stillMissing = wantValues.filter((v) => !nowChecked.includes(v));
  if (stillMissing.length) {
    return {
      ok: false,
      detail:
        `POST returned ${pr.status()} but the member still lacks group(s) ` +
        `[${stillMissing.map(labelOf).join(', ')}] on re-read — a 200 is not proof; treat as not done.`,
      raw,
    };
  }
  return { ok: true, detail: `added group(s) ${missing.map(labelOf).join(', ')}`, raw };
}

async function grantOcs(opts: {
  email: string;
  team: string;
  groupLabels: string[];
  dryRun: boolean;
  /** Cancel a pending invite whose groups differ from the requested set, then re-invite. */
  replaceInvite: boolean;
}): Promise<void> {
  const surface = `Open Chat Studio · ${opts.team}`;
  const ocsBase = process.env.OCS_BASE_URL || 'https://www.openchatstudio.com';
  const session = new OcsSession({
    baseUrl: ocsBase,
    teamSlug: opts.team,
    username: process.env.OCS_USERNAME,
    password: process.env.OCS_PASSWORD,
  });

  try {
    const ctx = await session.getContext();
    const request = ctx.request;
    const teamUrl = `${ocsBase}/a/${opts.team}/team/`;

    const gr = await request.get(teamUrl, { maxRedirects: 0 });
    if (gr.status() !== 200) {
      record({
        surface,
        status: 'NOT DONE',
        detail:
          `GET ${teamUrl} -> ${gr.status()} ${gr.headers()['location'] ?? ''} — ` +
          `ACE cannot reach the team-management page (not a team admin, or session expired). ` +
          `Owner: a Team Admin of "${opts.team}" must invite ${opts.email}.`,
        readback: [],
      });
      return;
    }
    let html = await gr.text();

    const pre = parseOcsTeamPage(html, opts.email);
    if (pre.isMember) {
      // Membership is not access. An accepted member on the wrong group 403s on
      // the chatbot page ACE links, so "already a member" is NOT the skip — the
      // member's GROUPS have to include the requested set. Reconcile if not.
      if (!pre.member?.id) {
        record({
          surface,
          status: 'NOT DONE',
          detail:
            `already an accepted team member, but the read-back carried no membership id, so the ` +
            `groups cannot be verified or reconciled here. Owner: a Team Admin must confirm ` +
            `${opts.email} has group(s) [${opts.groupLabels.join(', ')}].`,
          readback: [`GET ${teamUrl} -> 200`, ...pre.raw],
        });
        return;
      }
      const set = await ocsSetMemberGroups(
        request,
        ocsBase,
        opts.team,
        pre.member.id,
        opts.groupLabels,
        opts.dryRun,
      );
      // ok+"already carries" => nothing to do; ok+"added" => reconciled.
      const noop = set.ok && set.detail.startsWith('already carries');
      record({
        surface,
        status: set.ok ? (noop ? 'already-present' : 'granted') : 'NOT DONE',
        detail: set.ok
          ? noop
            ? `already an accepted team member; ${set.detail}`
            : `already a member but missing a group — ${set.detail}`
          : set.detail,
        readback: [`GET ${teamUrl} -> 200`, ...pre.raw, ...set.raw],
      });
      return;
    }
    if (pre.pending) {
      // A pending invite with the RIGHT groups is the idempotent skip. A pending
      // invite with the WRONG groups is NOT — it would leave the person short of
      // the permission the linked page needs, so fail loud unless told to replace.
      if (sameGroups(pre.pending.groups, opts.groupLabels)) {
        record({
          surface,
          status: 'already-present',
          detail: `pending invitation already exists with group(s) ${pre.pending.groups.join(', ')}`,
          readback: [`GET ${teamUrl} -> 200`, ...pre.raw],
        });
        return;
      }
      if (!opts.replaceInvite) {
        record({
          surface,
          status: 'NOT DONE',
          detail:
            `A pending invitation exists but carries group(s) [${pre.pending.groups.join(', ')}], ` +
            `not the requested [${opts.groupLabels.join(', ')}]. Re-run with --ocs-replace-invite ` +
            `to cancel it and re-invite.`,
          readback: [`GET ${teamUrl} -> 200`, ...pre.raw],
        });
        return;
      }
      if (!pre.pending.cancelUrl) {
        record({
          surface,
          status: 'NOT DONE',
          detail:
            `Pending invitation carries group(s) [${pre.pending.groups.join(', ')}] and must be ` +
            `replaced, but no cancel control is rendered for it — ACE is not a team admin on ` +
            `"${opts.team}". Owner: a Team Admin must cancel it and re-invite.`,
          readback: [`GET ${teamUrl} -> 200`, ...pre.raw],
        });
        return;
      }
      const cancelUrl = pre.pending.cancelUrl.startsWith('http')
        ? pre.pending.cancelUrl
        : `${ocsBase}${pre.pending.cancelUrl}`;
      console.log(
        `[ocs] cancelling pending invite (groups ${pre.pending.groups.join(', ')}): POST ${cancelUrl}`,
      );
      if (opts.dryRun) {
        record({ surface, status: 'NOT DONE', detail: '--dry-run: no cancel/POST issued', readback: [] });
        return;
      }
      const cancelCsrf = csrfFromHtml(sectionById(html, 'invitation-form-and-table')) ?? csrfFromHtml(html);
      const cr = await request.post(cancelUrl, {
        data: new URLSearchParams({ csrfmiddlewaretoken: cancelCsrf ?? '' }).toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': cancelCsrf ?? '',
          Referer: teamUrl,
          'HX-Request': 'true',
        },
        maxRedirects: 0,
      });
      console.log(`[ocs] cancel -> ${cr.status()}`);
      // Verify the cancel landed before inviting again — never assume.
      const after = await request.get(teamUrl, { maxRedirects: 0 });
      html = after.status() === 200 ? await after.text() : '';
      const check = html ? parseOcsTeamPage(html, opts.email) : undefined;
      if (!check || check.pending) {
        record({
          surface,
          status: 'NOT DONE',
          detail:
            `Cancel of the stale invitation returned ${cr.status()} but the read-back still shows ` +
            `it pending. Not re-inviting on top of an unverified cancel.`,
          readback: check ? [`GET ${teamUrl} -> ${after.status()}`, ...check.raw] : [],
        });
        return;
      }
      console.log('[ocs] cancel verified — stale invitation is gone');
    }

    const csrf = csrfFromHtml(sectionById(html, 'invitation-form-and-table')) ?? csrfFromHtml(html);
    const groups = checkboxOptions(html, 'groups');
    if (!csrf || groups.length === 0) {
      record({
        surface,
        status: 'NOT DONE',
        detail:
          'Could not parse csrfmiddlewaretoken and/or the groups checkboxes off the live team ' +
          'page — OCS changed the template. Not guessing a payload.',
        readback: [`groups parsed: ${JSON.stringify(groups)}`],
      });
      return;
    }

    const chosen: Array<{ value: string; label: string }> = [];
    for (const want of opts.groupLabels) {
      const g = groups.find((x) => x.label.toLowerCase() === want.toLowerCase());
      if (!g) {
        record({
          surface,
          status: 'NOT DONE',
          detail: `Requested group "${want}" is not offered on team "${opts.team}".`,
          readback: [`live groups: ${groups.map((g2) => `${g2.label} = ${g2.value}`).join(' | ')}`],
        });
        return;
      }
      chosen.push(g);
    }

    const invitePath = `${ocsBase}/a/${opts.team}/team/invite/`;
    console.log(
      `[ocs] POST ${invitePath} email=${opts.email} groups=${chosen
        .map((c) => `${c.label}(${c.value})`)
        .join(',')}`,
    );
    if (opts.dryRun) {
      record({ surface, status: 'NOT DONE', detail: '--dry-run: no POST issued', readback: [] });
      return;
    }

    // URLSearchParams (not Playwright's `form:` dict) — `groups` is a repeated key.
    const body = new URLSearchParams();
    body.set('csrfmiddlewaretoken', csrf);
    body.set('email', opts.email);
    for (const g of chosen) body.append('groups', g.value);

    const pr = await request.post(invitePath, {
      data: body.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRFToken': csrf,
        Referer: teamUrl,
        'HX-Request': 'true',
      },
      maxRedirects: 0,
    });
    const prText = pr.status() < 400 ? await pr.text() : (await pr.text()).slice(0, 500);
    console.log(`[ocs] POST -> ${pr.status()}`);

    if (pr.status() >= 400) {
      record({
        surface,
        status: 'NOT DONE',
        detail: `POST ${invitePath} -> ${pr.status()}: ${prText.slice(0, 300)}`,
        readback: [],
      });
      return;
    }

    // Read back from a FRESH page load, not the swap fragment.
    const post = await request.get(teamUrl, { maxRedirects: 0 });
    const postHtml = post.status() === 200 ? await post.text() : '';
    const rb: OcsReadback = postHtml
      ? parseOcsTeamPage(postHtml, opts.email)
      : { isMember: false, raw: ['  (re-GET failed — read-back INCONCLUSIVE)'] };
    // Proof requires the invite to be there AND to carry the groups we asked for —
    // a pending row with the wrong groups is not the grant that was requested.
    const wanted = chosen.map((c) => c.label);
    const proven = rb.isMember || (rb.pending !== undefined && sameGroups(rb.pending.groups, wanted));
    record({
      surface,
      status: proven ? 'granted' : 'NOT DONE',
      detail: proven
        ? `invitation created with group(s) ${wanted.join(', ')}`
        : `OCS returned ${pr.status()} but the read-back does NOT show ${opts.email} pending with ` +
          `group(s) [${wanted.join(', ')}]. A 200 is not proof — treat as not done. ` +
          `Response fragment (first 300 chars): ${stripTags(prText).slice(0, 300)}`,
      readback: [`GET ${teamUrl} -> ${post.status()}`, ...rb.raw],
    });
  } catch (err) {
    record({
      surface,
      status: 'NOT DONE',
      detail: `threw: ${(err as Error).message}`,
      readback: [],
    });
  } finally {
    await session.close().catch(() => undefined);
  }
}

// ── main ───────────────────────────────────────────────────────────────────
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}

async function main(): Promise<void> {
  loadEnv();
  const email = process.argv.slice(2).find((a) => a.includes('@'));
  if (!email) {
    console.error(
      'usage: npx tsx scripts/grant-review-access.ts <email> ' +
        '[--domain <hq-domain>] [--team <ocs-team>] [--hq-role "App Editor"] ' +
        '[--ocs-groups "Chatbot Admin,..."] [--ocs-replace-invite] [--only hq|ocs] [--dry-run]',
    );
    process.exit(2);
  }
  const domain = arg('domain', process.env.ACE_HQ_DOMAIN || 'connect-ace-prod');
  const team = arg('team', process.env.OCS_TEAM_SLUG || 'connect-ace');
  // Default "App Editor": the narrowest preset carrying `view_apps`, which every app
  // link ACE shares requires. See the ⚠ block in the header comment for evidence.
  const hqRole = arg('hq-role', 'App Editor');
  // Default "Chatbot Admin": the least-privilege OCS group that actually grants
  // `experiments.view_experiment`, which the linked chatbot page requires. See the
  // ⚠ block in the header comment for the file:line evidence.
  const ocsGroups = arg('ocs-groups', 'Chatbot Admin')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const only = arg('only', '');
  const dryRun = process.argv.includes('--dry-run');
  const replaceInvite = process.argv.includes('--ocs-replace-invite');

  console.log(`grant-review-access → ${email}`);
  console.log(`  HQ   domain=${domain} role="${hqRole}"`);
  console.log(`  OCS  team=${team} groups="${ocsGroups.join(', ')}"`);
  if (dryRun) console.log('  (dry run — no writes)');

  if (only !== 'ocs') await grantHq({ email, domain, roleLabel: hqRole, dryRun });
  if (only !== 'hq') await grantOcs({ email, team, groupLabels: ocsGroups, dryRun, replaceInvite });

  console.log('\n─────────────────────────── VERDICT ───────────────────────────');
  for (const r of results) console.log(`${r.status.padEnd(15)} ${r.surface} — ${r.detail}`);
  const notDone = results.filter((r) => r.status === 'NOT DONE');
  if (notDone.length) {
    console.log(`\nOVERALL: NOT DONE (${notDone.length} surface(s) outstanding).`);
    process.exit(1);
  }
  console.log('\nOVERALL: all requested surfaces granted or already present (read-back verified).');
}

await main();
