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

`/ace:release <workspace>/<opp>/<run-id> (--reviewers <email[:role]>,... | --from-thread <id>) [--forward-source] [--allow-shared connect]`
`/ace:release <workspace>/<opp>/<run-id> --revoke-shared`

The external-facing step after `clone-to-new-workspace`. The clone put the run
in its own workspace and tenancy; this makes it ready to look at and then lets
the reviewers in. **Everything is set up before anyone is invited** — nobody
should see a half-built run — and the ace-web workspace invite is the very last
thing, because it is what the reviewer actually opens.

Spec: ace-web `docs/specs/2026-09-28-clone-and-release-design.md` § E2.

## Inputs

- `<workspace>/<opp>/<run-id>` — the run to release, normally a clone.
- `--reviewers` — emails, each optionally `:viewer|editor` (default `viewer`).
- `--from-thread <gmail-thread-id>` — instead of `--reviewers`: read the ace@
  thread that asked for the review (`canopy email read <id>`, or `gog gmail
  thread get <id> -a ace@dimagi-ai.com --client canopy -j`) and take every
  participant whose domain is in `tenancy.labs_allowed_domains` — the partner's
  own people, never Dimagi staff on the cc line. Show the derived list in the
  Step 4 approval table; the human approves names, not a lookup.
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

## Revoke mode (`--revoke-shared`)

Run once per-partner Connect orgs exist (or when a review ends). Bind (Step 0.1),
read `released.shared_grants` from the run's `run_state.yaml`, show them all
for approval as one list, then for each row not yet revoked:
`connect_remove_org_member(organization_slug: <org>, email)`. It reads back
both member tables itself; `removed` / `invite-revoked` / `not-present` are all
a revoked grant. Write each row back with `revoked_at` (the whole
`shared_grants` array via `localFilePath` — arrays are replaced wholesale by
every merge mode). Report per row. Nothing else runs in this mode.

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

## Step 0.5 — The run must be READY (release-check)

**Nobody is invited to a run release-check has not passed.** Inventory the run
and run the gate:

```bash
RC="node $ACE_ROOT/node_modules/tsx/dist/cli.mjs $ACE_ROOT/scripts/release-check.ts"
$RC inventory --run-folder <run folder id> --out inventory.json
# download <run>/release-check_verdict.yaml (drive_read_file writeToPath) — absent is a refusal
$RC gate --workspace <workspace> --opp <opp> --run <run-id> --verdict release-check_verdict.yaml --inventory inventory.json
```

Exit 0 only when the latest verdict is READY, is for THIS workspace/opp/run (a
release happens after a clone, so a verdict from the source workspace does not
count), was not a read-only dry run, and nothing in the run was written after it.
Otherwise STOP: print the gate's reason — the blockers with their owners and
fixes, or "the run changed after the check" — and tell the operator to fix them
and run `/ace:release-check <workspace>/<opp>/<run-id>`. Do not proceed to any
step below.

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
**Any change here makes the release-check stale** — run `release-check` again
after polishing (Step 4 re-checks the gate before the first invite).

## Step 3 — Forward the source link (only with `--forward-source`)

```bash
curl -sS -X POST -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
  -H "Content-Type: application/json" -d '{"forward_source": true}' \
  "${ACE_WEB_BASE_URL%/}/api/w/<workspace>/opps/<opp>/runs/<run-id>/release"
```

From then on the source run's public summary 307-redirects (uncacheable, so
turning forwarding off takes effect) to this run's, and
the page moves its own address there. Verify: an anonymous `curl -sI` of the
source summary API shows `307` and a `Location` naming this run. A `400` means
this run is not a finished clone — there is no source link to forward.

## Step 4 — Invite, last

**Re-run the Step 0.5 gate first** (fresh inventory) — Steps 2–3 may have
written to the run. A non-zero exit stops here, before any invite.

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

Each grant is proven by a read-back, never by an assumed success: HQ by
`commcare_list_users` / the invite list, ace-web by the workspace's pending
invites. `connect_add_org_member` IS its own read-back — it reads Connect's
member and pending-invite tables before and after the POST and reports what it
found there (`invited-pending`, `already-member`, …), and there is no separate
Connect member-list tool — so its `status` is the evidence; a thrown error is
the failure. A failure is `NOT DONE` with the evidence.

## Step 5 — Record

```bash
curl -sS -X POST -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
  -H "Content-Type: application/json" -d '{"reviewers": ["a@x.org", ...]}' \
  "${ACE_WEB_BASE_URL%/}/api/w/<workspace>/opps/<opp>/runs/<run-id>/release"
```

Also write `released: {at, by, to: [emails]}` into the run's `run_state.yaml`
(`update_yaml_file`). With `--allow-shared connect`, add
`released.shared_grants: [{system: connect, org, email, role, at}]` — one row
per grant into a shared org. That list is the revocation checklist:
`/ace:release <run> --revoke-shared` removes every row with
`connect_remove_org_member` once per-partner orgs exist.

## Report

Per reviewer × system: `granted` (with read-back), `granted — SHARED, revoke
later` (Connect under `--allow-shared connect`, listed again at the end as the
revocation checklist), `NOT GRANTED — shared tenant`, `public link (no
account)` for OCS, or `NOT DONE` + reason; the audit
result and the polish changes; whether the source link now forwards.
