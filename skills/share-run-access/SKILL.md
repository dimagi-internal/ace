---
name: share-run-access
description: >
  Grant a set of people (typically everyone on a project thread) the access they need to
  work on an ACE run — across all surfaces the run-summary links: ace-web workbench + labs
  dashboards, the Connect opportunity, the CommCare HQ apps, and the OCS chatbot. ACE
  opportunities are CO-CREATED with partners, so the default grant on a run's own documents is
  EDITOR for named collaborators, not read-only. The public run-summary page itself is public,
  but its ACE-authored deliverable docs are NOT shared by default — this skill shares them and
  covers the platform-gated surfaces. Repeatable,
  idempotent, and approval-gated on every outbound invite. Invoked ad-hoc (a human asks "give
  Sophie and Sarvesh access") or as a standing step when a project thread gains participants.
disable-model-invocation: false
---

# Share run access — one primitive for "let the thread review this run"

> ## ⛔ Granting access is WORK TO DO NOW, not work to schedule
>
> When a human asks you to give named people access, the deliverable is **those people having
> access** — not a plan, not a ticket, not a skill describing how it would be done.
>
> - **A missing atom changes the MECHANISM, never WHETHER it happens this turn.** If there's no
>   atom for a surface, do it by hand *now* (UI, authenticated HTTP, a one-off script). Filing the
>   atom issue is something you do *in addition to* granting access, never instead of it.
> - **Do not decide the human's ask was unnecessary.** Default scope is every gated surface the
>   run-summary links. "They probably don't need the app builder" is not your call; narrowing is
>   the human's, made explicitly.
> - **You may not report success while any requested surface is ungranted**, and no outbound
>   message may say "access is set up" unless every surface is granted *and read back*. Say
>   plainly which ones are NOT DONE and who owns the next step.
>
> Origin (dimagi-internal/ace#915): asked to grant a thread access, ACE filed two atom issues at
> 16:36, merged a skill documenting them as "manual until the atom lands" at 16:47, and emailed
> "Access is set up" at 18:34 — having performed neither manual step. The reviewer hit 404s and had
> to write back. Three lines in this very skill authorized that: "atom pending → report the manual
> step", "most reviewers don't need the raw app-builder", and a report contract where
> `blocked: <precondition>` was an acceptable terminal state.

As more people use ACE and ace-web, sharing access must be a repeatable step, not a bespoke
scramble each time (Jon, 2026-07-23: access "should go to all individuals on a thread about a
project we are working on"). This skill is that primitive: given an opp/run and a set of emails,
it grants each person what they need to review the run, surface by surface, and reports exactly
what was granted vs. what's blocked on a precondition.

## Access is for CO-CREATION, not review (Jonathan, 2026-08-14)

This skill used to frame every grant as *review* access: share the docs so a partner can read
them and maybe comment. That is the wrong model. **ACE opportunities are co-created with
partners.** When Spark, or Sophie, or any partner engages with a run's outputs, they should be
able to **edit** the artifacts — feedback in this model arrives as *revisions*, not only as
comments.

So on ACE-authored Drive documents the default grant for a named partner collaborator is
**editor (`writer`)**, and the primitive is:

| Atom | Grant | Use when |
|---|---|---|
| `drive_share_with_person` | `type: user` — `writer` (default) / `commenter` / `reader` | **You know who the collaborators are.** The co-creation primitive. `writer` lets them edit; the grant is scoped to that person. |
| `drive_set_anyone_with_link` | `type: anyone` — `reader` (default) / `commenter` / `writer` | Nobody named: a public run-summary asset, a PNG a Slides deck must fetch (`reader`), or a doc handed round a thread for reactions (`commenter`). |

⚠ **`drive_set_anyone_with_link` at `writer` is a blunt instrument** — anyone the URL is
forwarded to can edit *or delete* the document. It works on this Shared Drive (verified
2026-08-14; Drive returned `{"id":"anyoneWithLink","type":"anyone","role":"writer"}`), but when
you can name the people, name them.

⚠ **Neither atom emails anyone.** `drive_share_with_person` sets Drive's
`sendNotificationEmail: false` unless you explicitly opt in — ACE's outbound email is gated
through `bin/ace-email` and a Drive-sent share notice would route around that gate. Sending the
link is a separate, approval-gated step you do through the normal email path.

Downstream implication, flagged not solved: `skills/feedback-ledger` models feedback as
**comments** (`channel: gdoc-comments`). Direct edits are a channel it does not capture — see
that skill's "Revisions are a channel this ledger does not yet capture" note and
dimagi-internal/ace#1335.

## The access model (why each surface is different)

The run-summary page itself is **public** ("the URL is the secret"). Its ACE-authored
deliverables are **not**.

> **Correction (2026-08-14).** This section used to claim every ACE-authored deliverable
> "is anyone-with-link — set at creation by the producer skills and enforced by
> `run-summary-qa`". None of that was true. `grep -rl drive_set_anyone_with_link skills/`
> hits only `training-deck-render`, `app-screenshot-capture`, `common-screenshot-capture`,
> `partnership-deck-build`, `run-summary-qa` and this skill — and all of those share **PNG
> images** so Slides' image-import service can fetch them, never a Doc or the deck itself.
> No producer skill shares a document. And `run-summary-qa` enforced nothing: its checker
> bucketed a private-doc 401 as AUTH-GATED and passed the run. Live proof on
> `spark-facilitator/20260813-2126` — the first run shown to an external partner: all 8
> reviewer-facing artifacts carried 24 permissions each and **zero** `type: anyone`, and the
> link checker still reported `12 links · 0 BROKEN`.

**What actually shares them, today, is this skill + `run-summary-qa`.** The checker now
classes an unshared `docs.google.com`/`drive.google.com` deliverable as
**`PRIVATE-DELIVERABLE`** and exits non-zero (so it can no longer certify a run whose docs
open for nobody), and step 2 below is the step that fixes them — by calling
`drive_set_anyone_with_link` per file. Producer-side sharing at creation is still an open
gap (jjackson/ace#902); until it lands, treat every run's docs as private until you have
shared them and re-checked. Beyond the docs, what needs a grant is the **platform-gated**
links, each a separate membership system:

| Surface | Summary link(s) | Auth | Grant mechanism |
|---|---|---|---|
| **ace-web workbench** | `/ace/w/<workspace>/opps/<opp>/runs/<run>` (the "how we got there" view) | Connect/CCHQ OAuth + `WorkspaceMembership` | **@dimagi.com/@dimagi-ai.com auto-join** on first sign-in (no grant). **Other domains cannot sign in at all** — see the allowlist box below; an invite to them is a no-op. |
| **labs dashboards** | `/labs/workflow/<id>/run/?...` | labs (CCHQ OAuth) | Same CCHQ login; visibility follows the run's synthetic/opp. Sign-in via CCHQ. |
| **Connect opportunity** | `connect.dimagi.com/a/<org>/opportunity/<id>/` | Connect org membership | `connect_add_org_member` (org from `run_state` → `connect.products.connect.organization_slug`). |
| **CommCare HQ apps** | `commcarehq.org/a/<domain>/apps/view/<id>/` | HQ web-user on the domain | `commcare_invite_web_user` (ships since ace#905; defaults to the **`App Editor`** role — load-bearing, see below; reconciles an existing member's role rather than skipping). |
| **OCS chatbot admin** | `openchatstudio.com/a/<team>/chatbots/<id>/` | OCS team membership | `ocs_add_team_member` (defaults to the "Chatbot Admin" group — the least-privilege group that opens the linked chatbot page; reconciles an existing member's groups additively). Internal-tool surface; most reviewers don't need it. |

**The account precondition threads through all of them:** every gated surface authenticates via
CommCareHQ/Connect OAuth, so a person can only reach ANY of them once they have a Connect/CommCare
account and have signed in once. `@dimagi.com` staff generally do; an **external collaborator**
(e.g. `@dimagi-associate.com`) must create one first. This skill never provisions accounts — it
grants membership and tells the person the one sign-in they must do themselves.

> ⛔ **ace-web workbench is CLOSED to external domains in production — an invite to one is a
> no-op.** ace-web's OAuth callback enforces an allowlist, `ACE_ALLOWED_EMAIL_DOMAINS=dimagi.com,
> dimagi-ai.com` (`deploy/aws/task-definition.json`, registered on every deploy). A non-matching
> address is rejected **before** a `User` row is created, with "Access is restricted to
> @dimagi.com, @dimagi-ai.com accounts." You *can* create a `WorkspaceInvite` for any email — the
> endpoint never touches the User table — but the recipient can never redeem it, because accepting
> requires a signed-in session that the allowlist prevents them from ever having. **So for an
> external collaborator, do NOT send a workspace invite and do NOT tell them to "accept a pending
> invite."** Widening access is a deploy-config change plus a redeploy, and it's a human decision —
> escalate it, don't work around it. (Origin: 2026-07-23 — an external reviewer was told to accept a
> pending invite that both did not exist and could not have been redeemed; dimagi-internal/ace#913.)

## Inputs

| Input | Required | Notes |
|---|---|---|
| `opp` (slug) + `run_id` | yes | Resolves `run_state.yaml` for the org/domain/team/opp identifiers below. |
| `emails[]` | yes | The people to grant. Default source: the current project thread's full To+Cc (verify from the structured read, never a raw dump). |
| `workspace` | no | ace-web workspace slug. Default `dimagi-team`. |
| `surfaces` | no | Subset to grant. Default: all gated surfaces the run has products for. |

## Process

1. **Resolve the run's identifiers** from `run_state.yaml` (`resolve_opp_path` → read the run's
   `run_state.yaml`): `connect.products.connect.organization_slug` (Connect org), `.opportunity.url`,
   the `commcare` `domain` (HQ), the `ocs_chatbot.team_slug` (OCS), the labs `opp_id`, and the
   `ace_web_summary_url`. Confirm the summary is clean first — run `run-summary-qa` if you haven't;
   never share a run whose links are broken.

2. **Share the deliverable docs — assume they are private.** Nothing sets anyone-with-link on
   them at creation (see the correction above), so this is a real step, not a verification.
   Two grants, and you normally do both:

   - **Per named collaborator → `drive_share_with_person({fileId, email})`, which defaults to
     `role: 'writer'`.** This is the co-creation grant: the partner can edit the artifact, and
     their feedback can arrive as a revision. Do this for everyone on the thread you were asked
     to grant. Narrow to `commenter` only when the human says the doc is read-and-react
     (a frozen deliverable, a signed work order), and say so in the report.
   - **Link-level floor → `drive_set_anyone_with_link`.** Run `run-summary-qa`'s link checker
     (`scripts/check-summary-links.py <opp> <run>`): every `docs.google.com`/Slides/Drive
     deliverable must report `OK 200`, and each one that comes back **`PRIVATE-DELIVERABLE`**
     must be fixed before proceeding (anyone else on the thread hits "You need access"
     otherwise). Use `role: 'commenter'` as the floor for a document — a `reader` physically
     cannot comment, so the `gdoc-comments` channel `feedback-ledger` assumes is dead. `reader`
     stays right for PNGs a Slides deck fetches. `writer` here is available and works, but
     prefer the named grant above: link-writer means anyone the URL reaches can edit or delete.

   Neither call emails anybody — see the co-creation section. Telling people they have access is
   step 5/6, through the gated email path.

3. **Classify each email once** (per-person isolation — one person, one decision, like inbox-triage):
   - `@dimagi.com` / `@dimagi-ai.com` → **internal**: ace-web auto-joins on sign-in (no invite needed);
     Connect/HQ/OCS grants apply normally.
   - anything else → **external collaborator**: **ace-web is blocked for them outright** (allowlist
     box above — report it, don't invite); for Connect, a deliberate external add —
     `add-org-member`'s @dimagi.com guard is intentional, so external Connect adds go through THIS
     skill's explicit external path (below), not that skill.

4. **Grant per surface** (idempotent — re-running skips people already granted):

   - **ace-web workbench.** Internal → nothing to grant; tell them to open the workbench URL and sign
     in (they auto-join). **External → STOP: report `blocked: ace-web domain allowlist` and escalate.**
     Do not send the invite below (see the allowlist box above — they can't redeem it). The invite
     endpoint is for internal addresses that somehow missed auto-join:
     ```bash
     curl -sS -X POST -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
       -H "Content-Type: application/json" \
       "${ACE_WEB_BASE:-https://labs.connect.dimagi.com/ace}/api/workspaces/<workspace>/members/invite" \
       -d '{"email":"<email>","role":"viewer"}'
     ```
     Owner-gated: `ACE_WEB_PAT_TOKEN` must belong to a workspace **owner**. ACE is now a first-class
     ace-web principal — `ace@dimagi-ai.com` is an **owner** of `dimagi-team` and mints its OWN bot PAT
     (ace-web#670: the `0005_promote_ace_owner` migration + the `mint_personal_token` command), so ACE
     invites under its own identity, never on behalf of a human. (Bring-up after an ace-web deploy:
     `python manage.py mint_personal_token --email ace@dimagi-ai.com --label ace-bot`, store in
     1Password, set as `ACE_WEB_PAT_TOKEN`.) The invitee then signs in once and accepts the pending
     invite. Read back `GET /api/workspaces/<workspace>/members` to confirm (pending until they accept).

   - **Connect opportunity.** `connect_add_org_member({ organization_slug, email, role: "viewer" })`.
     Preconditions Connect enforces (not bypassable): ACE must be an **admin** of the org, and the
     invitee must **already have a Connect account**. On 403 → ask a current org admin to add
     `ace@dimagi-ai.com` as admin. On "user does not exist" → the person must sign in once at
     https://connect.dimagi.com/ first, then re-run. **External emails:** allowed here (this is the
     deliberate external path `add-org-member` points to), but the account precondition still holds.

   - **labs dashboards.** No separate grant — labs authenticates via the same CCHQ OAuth. Once the
     person can sign in to labs (CCHQ account) they reach the run's dashboards. Just include the
     dashboard URLs and "sign in with your CommCare account" in the report.

   - **CommCare HQ apps.** Call `commcare_invite_web_user({domain, email})` (ships since ace#905).
     **Do NOT pass `role: "Read Only"`.** The default is `App Editor` and that is load-bearing: HQ's
     stock Read Only preset grants `view_reports` + `download_reports` and **not** `view_apps`, so a
     Read Only member gets a bare 403 on every app link this skill shares — while the *releases* page
     still renders, which is exactly what makes the access look like it mostly works. Of the stock
     presets only `App Editor` and `Admin` carry `view_apps`; `App Editor` is the narrower. (Found by
     a real reviewer, not a judge — Sophie Feintuch, 2026-07-23.)

     The atom handles every state itself with read-back proof: fresh invite, pending-invite
     idempotent skip, already-a-member no-op, and — the one that matters — **role reconciliation for
     a member sitting on the wrong role**, which membership-shaped checks report as success. Statuses
     `invited` / `invite-pending` / `already-member` / `role-reconciled` are all grants; a throw is a
     **NOT DONE** with the read-back evidence. Do not defer to "an HQ admin will do it" unless ACE
     genuinely lacks admin on the domain — and if so, that's a **NOT DONE** with a named owner.

   - **OCS chatbot admin.** Call `ocs_add_team_member({email})` (ships since ace#906; default group
     "Chatbot Admin" is load-bearing — it carries `experiments.view_experiment`, the permission the
     linked chatbot page needs; a member on any other group 403s there). The atom handles all three
     states itself with fresh-read proof: fresh invite, pending-invite idempotent skip (or
     `replace_invite: true` when the pending groups are wrong), and additive group reconciliation
     for an already-accepted member. Statuses `invited` / `invite-pending` / `already-member` /
     `groups-reconciled` are all grants; a throw is a **NOT DONE** with the read-back evidence.
     It is an internal-tool surface, which is a reason to ask the human whether to include it
     *before* they ask — never a reason to silently drop it from a grant they requested.

5. **Approval gate (procedural).** Sending invites is outbound. Present the full per-person /
   per-surface plan and get the human's yes before firing any invite or `connect_add_org_member`.
   Read-backs and doc-sharing (own artifacts) run freely.

6. **Report — binary per surface, no soft states.** Per person: domain class, then per surface
   exactly one of:
   - `granted` — **with the read-back that proves it** (a membership list showing them, not the
     invite call's response code)
   - `auto-join (sign in)` — nothing to grant; they land on first sign-in
   - `n/a` — the run has no product on that surface
   - **`NOT DONE — <reason> — owner: <who>`** — anything else. There is no `blocked:` status: an
     ungranted surface is outstanding work, not a state to file.

   **If any surface is NOT DONE, the skill's verdict is NOT DONE.** Say so first, before the
   granted list, and carry that into any outbound message — "access is set up" is false while one
   remains. End with the exact links to hand each person + the one sign-in action they must do.

## Guardrails

- **Idempotent + isolated.** Re-runnable; process one person at a time; a read-back is the success
  signal (invite endpoints can redirect identically on success/failure).
- **Never tell anyone their access is set up until you have read it back.** "You'll see a pending
  invite — accept it" is a claim about system state; verify it (`GET .../members`, and for a
  pending invite note there is **no** list endpoint, so you can only assert what you just created
  and got a token back for). An unverified access claim sends the person hunting for something that
  isn't there and costs a full round-trip. This is the `agent-turn-review` done-claim rule applied
  to grants. (Origin: 2026-07-23, dimagi-internal/ace#913.)
- **Never provision accounts.** Grant membership only; the person does their own first sign-in.
- **External domains are deliberate, not default.** An external add is an explicit choice surfaced
  in the approval step, never silent — Connect/ace-web both treat non-Dimagi domains specially.
- **Least privilege.** Default role is `viewer`/`member`, never owner/admin, unless asked.

## Related skills
- `feedback-ledger` — captures the reviewer's feedback and renders where each item went. It models
  **comments**; edits made under a `writer` grant are a channel it does not yet capture (ace#1335).
- `run-summary-qa` — gate the summary's links (and public-doc sharing) before you share access.
- `add-org-member` — the internal-only (@dimagi.com) Connect-org add; this skill is the superset
  that also covers ace-web + external collaborators + the other surfaces.
- `inbox-triage` — the per-sender isolation discipline this skill borrows for per-person grants.
