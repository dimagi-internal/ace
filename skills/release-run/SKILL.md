---
name: release-run
description: >
  Release a run to outside reviewers: audit its public summary, forward an
  already-shared link to it, then — last — invite each reviewer to the run's
  own HQ space, Connect org and ace-web workspace. Approval-gated. Run after
  clone-to-new-workspace, when everything is set up.
disable-model-invocation: true
---

# release-run

`/ace:release <workspace>/<opp>/<run-id> --reviewers <email[:role]>,... [--forward-source]`

The external-facing step after `clone-to-new-workspace`. The clone put the run
in its own workspace and tenancy; this makes it ready to look at and then lets
the reviewers in. **Everything is set up before anyone is invited** — nobody
should see a half-built run — and the ace-web workspace invite is the very last
thing, because it is what the reviewer actually opens.

Spec: ace-web `docs/specs/2026-09-28-clone-and-release-design.md` § E2.

## Inputs

- `<workspace>/<opp>/<run-id>` — the run to release, normally a clone.
- `--reviewers` — emails, each optionally `:viewer|editor` (default `viewer`).
- `--forward-source` — the source run's public summary link was already sent
  to these reviewers (Spark's case): make it land on this run.
- `--allow-shared connect` — **interim exception** (Jon, 2026-09-29): invite
  outside reviewers into the SHARED Connect orgs (the tenancy's
  `connect_pm_org` and `connect_holding_org`, i.e. `ace-pm-org` /
  `ace-nm-org`) even though that exposes every ACE opportunity in them. Every
  such grant is recorded as a shared grant to revoke once per-partner Connect
  orgs exist. Connect is the only system this flag applies to.

Auth: `ACE_WEB_BASE_URL` + `ACE_WEB_PAT_TOKEN`; the PAT's owner must be an
owner of `<workspace>`.

## Step 0 — Bind and check the tenancy is the reviewers' own

1. `"$CLAUDE_PLUGIN_ROOT/bin/ace-bind" <workspace>/<opp>` — every grant below is
   then checked against this opp's tenancy by the tenancy guard.
2. Read the tenancy (`bin/ace-bind --show`) and the run's `run_state.yaml`
   `clone:` block. For each **non-Dimagi** reviewer, a system is grantable only
   if the run's asset there was rebuilt into this run's own area:
   - **HQ:** `clone.hq.status == done` (the apps live in `tenancy.hq_domain`,
     which holds nothing else).
   - **Connect:** `clone.connect.status == done`.
   - **Labs:** `clone.labs.status == done`.
   A system that is still the shared tenant (no clone, `not-done`, or
   `kept-shared`) is **never** granted to an outside reviewer — every grant
   there opens every ACE run. Report it `NOT GRANTED — shared tenant` instead.
   **The one exception** is Connect with `--allow-shared connect`: grant it,
   and record it as a shared grant (Step 5).
3. **OCS: nobody gets an account.** Reviewers chat through the bot's public
   link (`products.ocs_chatbot.public_url`), which goes in the invite email.
   OCS permissions are team-wide (see `share-run-access`).

## Step 1 — Audit

Run `run-surface-audit` on `<workspace>/<opp>/<run-id>` (anonymously, as an
outsider sees it). Any **broken** finding stops the release — fix it first and
re-run. Carry **misleading** findings into Step 2.

## Step 2 — Polish

Fix what an outsider would trip on, in the run's own documents:
- links on the summary that point into the SOURCE workspace or shared tenants
  (they will 404 or be `admin only` for the reviewer) — replace or remove;
- anything the audit marked misleading.
Re-run the audit if anything changed. Record what you changed for the report.

## Step 3 — Forward the source link (only with `--forward-source`)

```bash
curl -sS -X POST -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
  -H "Content-Type: application/json" -d '{"forward_source": true}' \
  "${ACE_WEB_BASE_URL%/}/api/w/<workspace>/opps/<opp>/runs/<run-id>/release"
```

From then on the source run's public summary 308-redirects to this run's, and
the page moves its own address there. Verify: an anonymous `curl -sI` of the
source summary API shows `308` and a `Location` naming this run. A `400` means
this run is not a finished clone — there is no source link to forward.

## Step 4 — Invite, last

Build ONE list of every grant for every reviewer and show it for approval
before any is made (procedural gate — same posture as `share-run-access`):

| Reviewer | HQ | Connect | Labs | OCS | ace-web |
|---|---|---|---|---|---|

Then, in this order:

1. **HQ** — `commcare_invite_web_user(domain: tenancy.hq_domain, email, role:
   "App Editor")`. App Editor is acceptable only because the space holds just
   this run's apps; stock Read Only 403s on app pages.
2. **Connect** — `connect_add_org_member(organization_slug:
   tenancy.connect_holding_org, email, role: "viewer")`. With
   `--allow-shared connect`, ALSO add them as `viewer` to
   `tenancy.connect_pm_org` (the program lives there), and mark both grants
   shared. Tell the reviewer to
   sign in to Connect with "Log in with CommCare HQ" BEFORE accepting — an
   invite accepted first creates a password account that breaks HQ sign-in.
3. **Labs** — no call: the clone already allowed their domain.
4. **ace-web, last** — `POST ${ACE_WEB_BASE_URL}/api/workspaces/<workspace>/members/invite`
   `{"email": ..., "role": ...}` → `token`. The accept link is
   `${ACE_WEB_BASE_URL}/invite/<token>`. Their sign-in is admitted by the
   pending invite (invite-only login), so no domain allowlisting is needed.
5. **Email each reviewer** through `bin/ace-email` (approval-gated), one email
   per reviewer containing: the accept link; the "Log in with CommCare HQ
   first" instruction; the run summary URL; the bot's public chat link; what
   they can and cannot open.

Each grant is proven by a read-back (member list / invite list), never by the
call's own return value. A failure is `NOT DONE` with the evidence.

## Step 5 — Record

```bash
curl -sS -X POST -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
  -H "Content-Type: application/json" -d '{"reviewers": ["a@x.org", ...]}' \
  "${ACE_WEB_BASE_URL%/}/api/w/<workspace>/opps/<opp>/runs/<run-id>/release"
```

Also write `released: {at, by, to: [emails]}` into the run's `run_state.yaml`
(`update_yaml_file`). With `--allow-shared connect`, add
`released.shared_grants: [{system: connect, org, email, role, at}]` — one row
per grant into a shared org. That list is the revocation checklist: ACE has no
tool to remove a Connect org member, so revoking is manual in Connect's org
settings once per-partner orgs exist.

## Report

Per reviewer × system: `granted` (with read-back), `granted — SHARED, revoke
later` (Connect under `--allow-shared connect`, listed again at the end as the
revocation checklist), `NOT GRANTED — shared tenant`, `public link (no
account)` for OCS, or `NOT DONE` + reason; the audit
result and the polish changes; whether the source link now forwards.
