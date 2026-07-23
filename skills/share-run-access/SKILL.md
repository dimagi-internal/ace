---
name: share-run-access
description: >
  Grant a set of people (typically everyone on a project thread) the access they need to
  review an ACE run — across all surfaces the run-summary links: ace-web workbench + labs
  dashboards, the Connect opportunity, the CommCare HQ apps, and the OCS chatbot. The public
  run-summary page and every ACE-authored deliverable doc are already anyone-with-link, so
  reviewers can always open those; this skill covers the platform-gated surfaces. Repeatable,
  idempotent, and approval-gated on every outbound invite. Invoked ad-hoc (a human asks "give
  Sophie and Sarvesh access") or as a standing step when a project thread gains participants.
disable-model-invocation: false
---

# Share run access — one primitive for "let the thread review this run"

As more people use ACE and ace-web, sharing access must be a repeatable step, not a bespoke
scramble each time (Jon, 2026-07-23: access "should go to all individuals on a thread about a
project we are working on"). This skill is that primitive: given an opp/run and a set of emails,
it grants each person what they need to review the run, surface by surface, and reports exactly
what was granted vs. what's blocked on a precondition.

## The access model (why each surface is different)

The run-summary page itself is **public** ("the URL is the secret") and every ACE-authored
deliverable (training deck, LLO/FLW guides, quick-ref, FAQ, onboarding email, walkthrough video)
is **anyone-with-link** — set at creation by the producer skills and enforced by `run-summary-qa`.
So a reviewer can ALWAYS open the summary and its docs with no grant. What needs a grant is the
**platform-gated** links, each a separate membership system:

| Surface | Summary link(s) | Auth | Grant mechanism |
|---|---|---|---|
| **ace-web workbench** | `/ace/w/<workspace>/opps/<opp>/runs/<run>` (the "how we got there" view) | Connect/CCHQ OAuth + `WorkspaceMembership` | **@dimagi.com/@dimagi-ai.com auto-join** on first sign-in (no grant). Others → **workspace invite** (this skill). |
| **labs dashboards** | `/labs/workflow/<id>/run/?...` | labs (CCHQ OAuth) | Same CCHQ login; visibility follows the run's synthetic/opp. Sign-in via CCHQ. |
| **Connect opportunity** | `connect.dimagi.com/a/<org>/opportunity/<id>/` | Connect org membership | `connect_add_org_member` (org from `run_state` → `connect.products.connect.organization_slug`). |
| **CommCare HQ apps** | `commcarehq.org/a/<domain>/apps/view/<id>/` | HQ web-user on the domain | HQ web-user invite — **atom pending (dimagi-internal/ace#905)**; manual via HQ Users UI until then. |
| **OCS chatbot admin** | `openchatstudio.com/a/<team>/chatbots/<id>/` | OCS team membership | OCS team invite — **atom pending (dimagi-internal/ace#906)**; manual via OCS team UI until then. Internal-tool surface; most reviewers don't need it. |

**The account precondition threads through all of them:** every gated surface authenticates via
CommCareHQ/Connect OAuth, so a person can only reach ANY of them once they have a Connect/CommCare
account and have signed in once. `@dimagi.com` staff generally do; an **external collaborator**
(e.g. `@dimagi-associate.com`) must create one first. This skill never provisions accounts — it
grants membership and tells the person the one sign-in they must do themselves.

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

2. **Verify the deliverable docs are public.** The producers should have set anyone-with-link, but
   confirm with `run-summary-qa`'s link checker (`scripts/check-summary-links.py <opp> <run>`): every
   `docs.google.com`/Slides/Drive deliverable must report `OK 200`. Any private one → fix with
   `drive_set_anyone_with_link` before proceeding (a reviewer hits "You need access" otherwise).

3. **Classify each email once** (per-person isolation — one person, one decision, like inbox-triage):
   - `@dimagi.com` / `@dimagi-ai.com` → **internal**: ace-web auto-joins on sign-in (no invite needed);
     Connect/HQ/OCS grants apply normally.
   - anything else → **external collaborator**: needs an explicit ace-web invite AND (for Connect)
     a deliberate external add — `add-org-member`'s @dimagi.com guard is intentional, so external
     Connect adds go through THIS skill's explicit external path (below), not that skill.

4. **Grant per surface** (idempotent — re-running skips people already granted):

   - **ace-web workbench.** Internal → nothing to grant; tell them to open the workbench URL and sign
     in (they auto-join). External → send a workspace invite:
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

   - **CommCare HQ apps** *(only if `surfaces` includes `hq`)*. HQ web-user invite atom is pending
     (dimagi-internal/ace#905); until it lands, report the manual step: an HQ admin invites the email
     as a web user (Viewer role) to the `<domain>` project via `commcarehq.org/a/<domain>/settings/users/`.
     Most reviewers don't need the raw app-builder — flag it as optional.

   - **OCS chatbot admin** *(only if `surfaces` includes `ocs`)*. OCS team-member atom is pending
     (dimagi-internal/ace#906); until it lands, report the manual step: an OCS team admin invites the
     email to the `<team_slug>` team. Internal-tool surface — usually skip for reviewers.

5. **Approval gate (procedural).** Sending invites is outbound. Present the full per-person /
   per-surface plan and get the human's yes before firing any invite or `connect_add_org_member`.
   Read-backs and doc-sharing (own artifacts) run freely.

6. **Report** — per person: domain class, and per surface either `granted` (with the read-back),
   `auto-join (sign in)`, `blocked: <precondition>` (no account / ACE not admin / atom pending), or
   `n/a`. End with the exact links to hand each person + the one sign-in action they must do.

## Guardrails

- **Idempotent + isolated.** Re-runnable; process one person at a time; a read-back is the success
  signal (invite endpoints can redirect identically on success/failure).
- **Never provision accounts.** Grant membership only; the person does their own first sign-in.
- **External domains are deliberate, not default.** An external add is an explicit choice surfaced
  in the approval step, never silent — Connect/ace-web both treat non-Dimagi domains specially.
- **Least privilege.** Default role is `viewer`/`member`, never owner/admin, unless asked.

## Related skills
- `run-summary-qa` — gate the summary's links (and public-doc sharing) before you share access.
- `add-org-member` — the internal-only (@dimagi.com) Connect-org add; this skill is the superset
  that also covers ace-web + external collaborators + the other surfaces.
- `inbox-triage` — the per-sender isolation discipline this skill borrows for per-person grants.
