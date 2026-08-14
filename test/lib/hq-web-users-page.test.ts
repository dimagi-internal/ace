import { describe, it, expect } from 'vitest';

import {
  DEFAULT_HQ_ROLE,
  classifyHqInviteState,
  csrfFromHtml,
  findPendingInvite,
  findWebUser,
  formContaining,
  formFields,
  initialPageData,
  reconcileRoleReadback,
  resolveRoleValue,
  selectOptions,
  selectedOptionLabel,
} from '../../lib/hq-web-users-page.js';

// ---------------------------------------------------------------------------
// dimagi-internal/ace#905 — commcare_invite_web_user
//
// The parsing here is lifted verbatim from scripts/grant-review-access.ts,
// which was live-verified on connect-ace-prod on 2026-07-23. What these tests
// exist to protect is not the regexes — it is the two lessons the script's
// header documents, either of which a naive re-implementation loses:
//
//   1. Granting access is a ROLE decision, not a membership decision.
//   2. HQ's web/json/ list is Elasticsearch-backed and lags a write.
//
// Both were paid for by a real reviewer hitting a 403, not by a judge.
// ---------------------------------------------------------------------------

describe('the default role is not negotiable (#905)', () => {
  it('defaults to App Editor, never Read Only', () => {
    // The issue body says "Default role Viewer." That is precisely the trap:
    // HQ's stock Read Only preset grants view_reports + download_reports and
    // NOT view_apps, so every app link ACE shares 403s — while the releases
    // page still renders, which is what makes it look like it mostly works.
    // Of the presets only App Editor and Admin carry view_apps.
    expect(DEFAULT_HQ_ROLE).toBe('App Editor');
    expect(DEFAULT_HQ_ROLE).not.toMatch(/read only|viewer/i);
  });
});

describe('classifyHqInviteState — membership is not access', () => {
  it('THE REGRESSION: a member on the WRONG role is work to do, not "already present"', () => {
    const s = classifyHqInviteState({
      webUser: { email: 'x@dimagi.com', role: 'Read Only', editUrl: '/a/d/settings/users/web/account/abc/' },
      wantedRole: 'App Editor',
    });
    expect(s.action).toBe('reconcile-role');
    expect(s.currentRole).toBe('Read Only');
    expect(s.editUrl).toBe('/a/d/settings/users/web/account/abc/');
    // The invite POST cannot fix this — HQ rejects it as a duplicate — so a
    // classifier that returned already-member here would report success while
    // the person still 403s.
    expect(s.action).not.toBe('already-member');
  });

  it('a member already on the wanted role is a genuine no-op', () => {
    const s = classifyHqInviteState({
      webUser: { email: 'x@dimagi.com', role: 'App Editor' },
      wantedRole: 'App Editor',
    });
    expect(s.action).toBe('already-member');
  });

  it('role comparison ignores case and surrounding whitespace', () => {
    const s = classifyHqInviteState({
      webUser: { email: 'x@dimagi.com', role: '  app editor ' },
      wantedRole: 'App Editor',
    });
    expect(s.action).toBe('already-member');
  });

  it('a member with an unreadable role still reconciles rather than skipping', () => {
    // Unknown is not "fine". Defaulting to already-member here would be the
    // same silent 403.
    const s = classifyHqInviteState({
      webUser: { email: 'x@dimagi.com' },
      wantedRole: 'App Editor',
    });
    expect(s.action).toBe('reconcile-role');
  });

  it('a pending invitation is a no-op, not a re-invite', () => {
    const s = classifyHqInviteState({
      pendingInvite: { email: 'x@dimagi.com' },
      wantedRole: 'App Editor',
    });
    expect(s.action).toBe('invite-pending');
  });

  it('an accepted membership outranks a stale pending invite row', () => {
    const s = classifyHqInviteState({
      webUser: { email: 'x@dimagi.com', role: 'App Editor' },
      pendingInvite: { email: 'x@dimagi.com' },
      wantedRole: 'App Editor',
    });
    expect(s.action).toBe('already-member');
  });

  it('absent from both reads means invite', () => {
    expect(classifyHqInviteState({ wantedRole: 'App Editor' }).action).toBe('invite');
  });
});

describe('reconcileRoleReadback — never let the ES-lagged list veto a proven write', () => {
  it('THE OTHER REGRESSION: edit page confirms, web/json/ lags → still a success', () => {
    // _get_web_users runs UserES, so a role HQ has already saved can read back
    // stale for seconds. The edit page renders get_role(domain) from Couch.
    const r = reconcileRoleReadback({
      editPageRole: 'App Editor',
      listJsonRole: 'Read Only',
      wantedRole: 'App Editor',
    });
    expect(r.ok).toBe(true);
    expect(r.lagged).toBe(true);
    expect(r.detail).toMatch(/index lag/i);
  });

  it('edit page still showing the old role IS a failure — a 302 is not proof', () => {
    const r = reconcileRoleReadback({
      editPageRole: 'Read Only',
      listJsonRole: 'App Editor',
      wantedRole: 'App Editor',
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/did not take/i);
  });

  it('both reads agreeing is a clean pass', () => {
    const r = reconcileRoleReadback({
      editPageRole: 'App Editor',
      listJsonRole: 'App Editor',
      wantedRole: 'App Editor',
    });
    expect(r).toMatchObject({ ok: true, lagged: false });
  });

  it('an absent list read does not downgrade a confirmed edit-page read', () => {
    const r = reconcileRoleReadback({ editPageRole: 'App Editor', wantedRole: 'App Editor' });
    expect(r).toMatchObject({ ok: true, lagged: false });
  });
});

describe('resolveRoleValue — refuse to guess', () => {
  const options = [
    { value: 'admin', label: 'Admin' },
    { value: 'user-role:abc123', label: 'App Editor' },
    { value: 'user-role:def456', label: 'Read Only' },
  ];

  it('maps a label to the qualified id HQ actually expects', () => {
    expect(resolveRoleValue(options, 'App Editor')).toBe('user-role:abc123');
    expect(resolveRoleValue(options, 'Admin')).toBe('admin');
  });

  it('is case- and whitespace-insensitive on the label', () => {
    expect(resolveRoleValue(options, '  app editor ')).toBe('user-role:abc123');
  });

  it('returns undefined for an unknown label rather than picking something', () => {
    // The caller fails loud with the live option list. Coercing here would POST
    // a role the domain does not have.
    expect(resolveRoleValue(options, 'Field Implementer')).toBeUndefined();
  });
});

describe('HTML parsing helpers', () => {
  const page = `
    <form action="/a/d/settings/users/web/invite/" method="post">
      <input type="hidden" name="csrfmiddlewaretoken" value="tok123">
      <input type="text" name="email" value="">
      <select name="role">
        <option value="admin">Admin</option>
        <option value="user-role:abc123" selected>App Editor</option>
        <option value="user-role:def456">Read &amp; Only</option>
      </select>
      <input type="checkbox" name="notify" value="yes" checked>
      <input type="checkbox" name="skip" value="no">
      <input type="submit" name="go" value="Send">
      <input type="file" name="attachment">
      <textarea name="note">hello &amp; welcome</textarea>
    </form>`;

  it('reads the csrf token', () => {
    expect(csrfFromHtml(page)).toBe('tok123');
  });

  it('reads select options and unescapes labels', () => {
    const opts = selectOptions(page, 'role');
    expect(opts).toHaveLength(3);
    expect(opts[2]).toEqual({ value: 'user-role:def456', label: 'Read & Only' });
  });

  it('reads the selected option label', () => {
    expect(selectedOptionLabel(page, 'role')).toBe('App Editor');
  });

  it('re-posts a form field-for-field, excluding submits/files/unchecked boxes', () => {
    const form = formContaining(page, 'name="email"');
    expect(form).toBeDefined();
    const fields = Object.fromEntries(formFields(form!));
    // Present: hidden, text, selected option, CHECKED checkbox, textarea.
    expect(fields.csrfmiddlewaretoken).toBe('tok123');
    expect(fields.role).toBe('user-role:abc123');
    expect(fields.notify).toBe('yes');
    expect(fields.note).toBe('hello & welcome');
    // Absent: submit, file input, UNCHECKED checkbox.
    expect(fields.go).toBeUndefined();
    expect(fields.attachment).toBeUndefined();
    expect(fields.skip).toBeUndefined();
  });

  it('formContaining picks the right form when the page carries several', () => {
    const two = `<form id="a"><input name="alpha" value="1"></form>
                 <form id="b"><input name="beta" value="2"></form>`;
    const f = formContaining(two, 'name="beta"');
    expect(f).toContain('beta');
    expect(f).not.toContain('alpha');
  });

  it('parses initial_page_data and survives malformed json', () => {
    const html = `<div data-name="invitations" data-value="[{&quot;email&quot;: &quot;x@dimagi.com&quot;}]"></div>`;
    expect(initialPageData(html, 'invitations')).toEqual([{ email: 'x@dimagi.com' }]);
    expect(initialPageData('<div data-name="invitations" data-value="{oops"></div>', 'invitations')).toBeUndefined();
    expect(initialPageData('<div></div>', 'invitations')).toBeUndefined();
  });
});

describe('read-back row matching', () => {
  it('finds a web user case-insensitively and keeps the rendered editUrl', () => {
    const payload = {
      users: [
        { email: 'Other@dimagi.com', name: 'Other', role: 'Admin' },
        { email: 'X@Dimagi.com', name: 'X', role: 'Read Only', editUrl: '/a/d/x/' },
      ],
    };
    const u = findWebUser(payload, 'x@dimagi.com');
    expect(u).toMatchObject({ role: 'Read Only', editUrl: '/a/d/x/' });
  });

  it('returns undefined on a non-200 / unparseable payload rather than throwing', () => {
    expect(findWebUser(undefined, 'x@dimagi.com')).toBeUndefined();
    expect(findWebUser({ nope: true }, 'x@dimagi.com')).toBeUndefined();
  });

  it('finds a pending invite case-insensitively', () => {
    expect(findPendingInvite([{ email: 'X@Dimagi.com' }], 'x@dimagi.com')).toBeDefined();
    expect(findPendingInvite([], 'x@dimagi.com')).toBeUndefined();
    expect(findPendingInvite(undefined, 'x@dimagi.com')).toBeUndefined();
  });
});
