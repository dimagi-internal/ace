---
name: validate-release-readiness
description: >
  Do all the work a release could need except sharing, then decide READY or NOT READY and, on READY, write the exact release plan. Use before /ace:release.
disable-model-invocation: false
---

# validate-release-readiness

`/ace:validate-release-readiness <workspace>/<opp>/<run-id> (--reviewers <email[:role]>,... | --from-thread <id>) [--cc <staff@dimagi.com>,...] [--waive <blocker-id>=<reason>]... [--forward-source [--allow-cross-workspace-forward]] [--allow-shared connect] [--read-only]`

Owner decision (Jonathan, 2026-10-03): *"we should have one
validate-release-readiness (which should take over whatever the release check
is doing) which does everything that could cause work to happen besides
sharing, and then the release should just be to share everything. but when
validate release readiness passes it means executing release doesn't change
anything other than sharing externally."*

So this skill does **every check and every content change** a release could
need — every readiness gate, the HQ plan, the per-reviewer audit of
the review page, the repairs `/ace:release` used to "polish" — and ends in ONE
verdict, **READY** or **NOT READY**. On READY the verdict carries the **release
plan**: the exact, ordered share actions `/ace:release` will execute and the
full text of every email it will send, hashed, with a hash of `run_state.yaml`
as validated. `/ace:release` executes that plan and nothing else
(`skills/release-run`), and refuses it if anything differs.

**It re-implements no gate.** It runs or reads the gates that already exist —
every `-qa` result, every `-eval` verdict, `connect-opp-setup`'s
post-condition, `output-preview-capture`, `run-surface-audit`,
`ocs-chatbot-qa`, `app-release-qa` — and rolls their evidence up
(`lib/release-readiness.ts`, pinned by `test/lib/release-readiness.test.ts` over the
real evidence of `spark-facilitator/20260926-1800`). The plan is
`lib/release-plan.ts` (`test/lib/release-plan.test.ts`), the gate
`releaseGate` (`test/lib/release-gate.test.ts`). Re-runnable and idempotent:
each run replaces the previous verdict and report.

## Inputs

| Source | What |
|---|---|
| Arguments | the run; **reviewers (required — without them it is never READY)**; the release flags, which become plan options |
| The run folder (Drive) | every file's path + modifiedTime; the text of each QA result, eval verdict, chatbot transcript and `decisions.yaml` (`$RC inventory`) — `decisions.yaml` feeds the plain-language gate (`assessDecisionsPlainLanguage`, one `public-summary` blocker per producing skill; `docs/decisions-contract.md § Plain-language gate`) and the required-before gate (`assessRequiredBeforeAsks`: every unanswered `review_ask: required-before` row is a blocker naming its question; an unanswered `recommended-confirmation` is not a finding — `docs/decisions-contract.md § Open asks`) |
| `ACE/<opp>/inputs/decision-overrides.yaml` (when it exists) | saved rulings — download it and pass `--decision-overrides`, so an ask answered in the decisions review after its row was written counts as answered |
| `run_state.yaml` | steps that ran, products, Phase 4's decisions, the `clone:` block (what was rebuilt into the run's own area, and the source run) |
| The opp's tenancy (ace-web `GET /api/w/<ws>/opps/<opp>/tenancy`) | `hq_domain`, `connect_holding_org`, `connect_pm_org` — the grant targets |
| ace-web | the run's outputs, the preview gap list, the public summary |
| Live systems | Connect, labs, HQ, OCS public chat, Drive sharing — each read with its own session; nothing is shared |

**Reviewers.** `--reviewers` is comma-separated emails, each optionally
`:viewer` / `:editor` (default viewer). **Every reviewer is invited into the
ace-web workspace as `editor`, whatever that suffix says** (`RELEASE_ACE_WEB_ROLE`
in `lib/release-plan.ts`; owner directive, Jonathan, 2026-10-08: *"everyone ace
invites in as part of a release should be editor"*); the Connect org role stays
`viewer`. Dimagi staff (`@dimagi.com`) are
reviewers like anyone else — an ace-web workspace invite, the grants a partner
gets, and their own release email. Operator correction (Jonathan, 2026-10-05,
ace#2720): *"we want dimagi people to be invited into the workspace if they are
on the project"*.

**Cc (ace#2706) — explicit opt-in only.** `--cc` is comma-separated **Dimagi
staff** (`@dimagi.com`) copied on EVERY release email and granted nothing — they
are told, not let in. It is never derived from a thread (`--from-thread` makes
the thread's Dimagi staff reviewers, above); pass it only when the operator
names someone who should be copied without being let in. Any other address is refused (`parseCc`: a partner is a reviewer or nobody;
ACE's own mailbox is the sender), and so is an address that is also a reviewer
(blocker `reviewers-cc-is-reviewer:<email>`). The cc list is part of the plan —
on the plan and on every `email` action — so it is in the plan hash, and the
release gate compares it exactly, like the reviewers.

**Waivers (ace#2707).** `--waive <blocker-id>=<reason>` (repeatable) releases
past ONE named readiness blocker on the operator's say-so. Operator decision
(Jonathan, 2026-10-05, the spark-facilitator release): release the work order
as a **DRAFT** although `pdd-to-work-order-eval` fails — three independent
judges 7.15–7.65, not converging — *with the reason recorded and the failing
grade still visible*. So a waived blocker:

- **stays in the verdict's `blockers`**, its `detail` (the grade) untouched,
  marked `waived: {by, at, reason}` — `by` is the operator's git
  `user.email`, `at` the validation time;
- is **excluded from READY** (`counts.blockers` counts only un-waived ones;
  `counts.waived` the rest) and listed under its own heading in the report;
- is recorded on the release plan (`release_plan.waivers`, in the plan hash)
  and shown in `/ace:release`'s approval prompt (`plan-show`), and the release
  gate compares the waivers (id + reason) **exactly** — `/ace:release` must be
  given the same `--waive` flags.

**Only eval-quality blockers (area `eval`: `eval-below-band:*`,
`eval-missing:*`, `eval-stale:*`, `eval-unreadable:*`) are waivable.** A waiver
of any other area — sharing / Drive, confidentiality and the rest of the review
page, links, HQ, reviewers, required-before asks, plain language, Connect, apps,
QA, the release plan — is refused (blocker `waiver-refused:<id>`): those are
facts about what a reviewer will meet, not a grade. A waiver naming no blocker
of this validation (`waiver-unmatched:<id>`) or with no git email to record
(`waiver-unattributed:<id>`) is refused too. Take the id verbatim from the
report (`blockers[].id`).

**`--from-thread <id>`.** Read the ace@ thread that asked for the review
(`canopy email read <id>`), collect every From / To / Cc address, and split
them with `$RC thread-recipients --participants "<addr>,…"`: every Dimagi
staff member (`@dimagi.com`) on the thread is a **reviewer** (ace#2720);
partners, ACE's own mailbox and anyone else are **excluded**, each with its
reason. ace-web no longer has a per-opp Labs domain list (2026-10-08), so a
partner becomes a reviewer only when the operator names them in
`--reviewers`. Show the operator both lists, then use its
`flags.reviewers` as `--reviewers` for every step below. It derives no `--cc`.
`/ace:release` must later be given the SAME reviewers (and the same `--cc`, if
the operator added one) — the gate compares both exactly.

## Products

- `<run>/release-readiness_verdict.yaml` — `lib/release-readiness.ts`
  `ReleaseVerdict` v2, real YAML bytes (`drive_upload_binary`, `text/yaml`), at
  the RUN ROOT next to `run_state.yaml`. ace-web shows it on the run's tab row.
  It is the only verdict file the gate reads; no other name is accepted.
- `<run>/release-readiness_report.md` — the same verdict and plan for a human,
  rendered as a Google Doc (`drive_create_doc_from_markdown`).

```yaml
schema_version: 2
kind: release-readiness
workspace: <ws>            # the workspace the run lives in (a clone's, after a clone)
opp: <opp>
run_id: <run-id>
checked_at: <ISO>
run_last_write: <ISO>      # newest write in the run folder (the verdict's own files excluded)
verdict: READY | NOT_READY
read_only: <bool>          # a dry run — never releasable
counts: {blockers: N, warnings: N, waived: N}   # blockers = un-waived only
areas: {qa, eval, connect, previews, links, public-summary, chatbot, apps, hq, reviewers, drive, release-plan, run-state}
blockers: [{id, area, severity: blocker, owner, detail, fix, summary, action, merged?, waived?: {by, at, reason}}]
waivers: [{id, reason, by, at, detail}]   # applied --waive (eval area only)
warnings: [...]
reviewers: [{email, role}]
cc: [staff@dimagi.com]     # copied on every email, granted nothing (ace#2706)
run_state_hash: sha256:…   # run_state.yaml as validated (content, not bytes)
plan_hash: sha256:… | null
release_plan:              # null unless READY
  schema_version: 1
  workspace, opp, run_id
  options: {forward_source, allow_cross_workspace_forward, allow_shared_connect}
  reviewers: [{email, role}]
  cc: [staff@dimagi.com]   # in the plan hash; the gate compares it exactly
  actions:                 # executed in exactly this order, nothing else
    - {step: 1, id: "hq:a@x.org", system: hq, kind: hq_invite, email, target: <hq_domain>, role: "App Editor"}
    - {step: 2, id: "connect:a@x.org:<org>", system: connect, kind: connect_org_member, email, target: <org>, role: viewer, shared: false}
    - {step: 3, id: "drive:<file id>", system: drive, kind: drive_share, target: <file id>, title, url, role: commenter, scope: anyone_with_link}
    - {step: 4, id: forward-source, system: ace-web, kind: forward_source, target: <src ws>/<opp>/<run>, cross_workspace: true}
    - {step: 5, id: "ace-web-role:v@x.org", system: ace-web, kind: ace_web_role, email, target: <workspace>, user_id: 12, from_role: viewer, role: editor}   # an existing member below editor
    - {step: 6, id: "ace-web:a@x.org", system: ace-web, kind: ace_web_invite, email, target: <workspace>, role: editor, reinvite?: true}   # always editor; never for an existing member
    - {step: 7, id: "email:a@x.org", system: email, kind: email, email, target: a@x.org, subject: "…", cc: [staff@dimagi.com]}
  not_granted: [{email, system, reason}]   # shared tenants; OCS is always "public chat link, no account"
  ace_web: [{email, status: invite | invite-pending | already-member | role-upgrade, role}]   # the ace-web grant per reviewer, from the membership read (ace#2770)
  workbench_url: <ace-web base>/w/<ws>/opps/<opp>/runs/<run>   # where an existing member signs in
  emails: [{to, cc, subject, body, variant: invite | existing-member}]   # invite: body has the literal {{ACCEPT_LINK}} — the only part a release fills in; existing-member: no link
  waivers: [{id, reason, by, at, detail}]  # in the hash; shown for approval; compared exactly by the gate
```

### Why each kind of action is planned the way it is

- **HQ / Connect / labs only where the clone rebuilt the asset into the run's
  own area** (`clone.<system>.status == done`). A shared tenant is never
  granted to an outside reviewer (every grant there opens every ACE run) —
  it is listed in `not_granted`. Dimagi staff (`@dimagi.com`) are not outside
  reviewers. The one escape hatch is `--allow-shared connect` (a clone made
  with `--keep-shared connect`): both shared orgs, every grant marked
  `shared: true` for later revocation. Labs needs no call. The clone already
  WIDENED each synthetic opp's allowlist to the partner's domain, keeping ACE's
  own domain on it (`clone-to-new-workspace` § 4c). The clone records
  `clone.labs.status: done` only after its `labs_context` read-back showed ACE
  still sees every opp (ace#2713). **OCS is always the public chat link**, never
  an account.
- **Connect is BOTH orgs, the holding org and the PM org** (when they differ):
  the holding org holds the opportunity, the PM org holds the program and the
  verification-rules page, and the run links to both. A viewer of the holding
  org alone cannot open the program (operator, 2026-10-06: "they should be
  invited to the spark pm org too right?"). A self-managed opp, where the PM
  org holds its own opportunity, is one org and one grant.
- **Drive: verify, else plan an anyone-with-link share.** Every Drive document
  the review page links to is read with the service account
  (`$RC drive-access`). Already open to anyone with the link → verified,
  nothing planned. Private → a `drive_share` action (`anyone_with_link`,
  `commenter`, so the reviewer can comment). Not per-person: the review page
  is public, and `run-surface-audit`'s own contract (`LINK-PRIVATE-DELIVERABLE`)
  requires every document it links to be openable with the link. Sharing is
  sharing, so it is a plan action executed by the release — never done here.
  A document whose sharing cannot be read is a blocker, never assumed open.
- **`--forward-source` is an explicit plan item** and makes the SOURCE run's
  public summary redirect to this run. If the source run is in a DIFFERENT
  workspace (always the case for a clone — e.g. a Dimagi run cloned into
  Spark), forwarding would take over that workspace's own public page for
  everyone who opens it, its own people included. Validation **refuses** it
  (`forward-source-cross-workspace`) and says so plainly, unless
  `--allow-cross-workspace-forward` is also passed.
- **ace-web: read the workspace's membership first (ace#2770).** `assess`
  reads `GET …/api/workspaces/<ws>/members` and `GET …/api/workspaces/<ws>/invites`
  (pending, admin+, no tokens) — or takes `--ace-web-membership <json>`. ace-web
  refuses to invite ANY existing member (repro ace#2770, 2026-10-07: 409 `"<email> is already a <role> of
  this workspace"`, ace-web `apps/workspaces/api.py:472-477`), so per reviewer:
  - **member at editor, admin or owner** → no ace-web action; recorded
    `already-member` (role read back) in `ace_web`; the email is the
    **existing-member** variant: no accept link, step 1 is "sign in at
    `workbench_url`", everything else (review page, chatbot, what they can
    open, the Connect sign-in order note) unchanged;
  - **member below editor (viewer)** → an `ace_web_role` action raising them to
    editor. An invite is NOT the upgrade path: the invite endpoint 409s before
    the upgrade-only accept logic (`apps/workspaces/invites.py:21`) could run;
    the role change is `PATCH …/members/<user_id>` (`api.py:750-790`, ACE acting
    strictly above both roles, `permissions.py:185`). Email: existing-member;
  - **pending invite** → re-invited. ace-web keeps no uniqueness on (workspace,
    email) and mints a fresh token per POST (`api.py:479`,
    `models.py:98-123`), so the normal invite email works; the earlier invite
    stays valid (`reinvite: true`, shown in `plan-show`);
  - **neither** → invite + accept link, unchanged.
  A membership that was not read (or read with an error — e.g. ACE is not admin
  of the workspace, so the invites list 403s) is the blocker
  `plan-ace-web-membership-unread`, never "nobody is a member".
- **Emails are written in full now.** One per reviewer: the ace-web accept
  link (`{{ACCEPT_LINK}}` — minted by ace-web when the invite is made, so it is
  the only value a release fills in), the run's review page, the chatbot's
  public link, what they can and cannot open, and — when Connect is granted —
  "sign in with *Log in with CommCare HQ* BEFORE accepting the Connect
  invite". Platform name is "Connect" (`skills/_terminology.md`). Every email
  carries the plan's `cc` (Dimagi staff only); the cc changes the header, never
  the body, and no grant is planned for a cc'd address.

## Process

Resolve the run folder (`resolve_opp_path` → `runs/<run-id>`), download
`run_state.yaml` locally (`drive_read_file` `writeToPath`), bind the session
(`"$CLAUDE_PLUGIN_ROOT/bin/ace-bind" <workspace>/<opp>`), and pick a scratch
dir. `$RC` below is
`node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/release-readiness.ts"`,
and `$FLAGS` is `--reviewers "<list>"` plus `--cc "<list>"` when given, plus each `--waive "<id>=<reason>"` given, plus whichever of
`--forward-source`, `--allow-cross-workspace-forward`, `--allow-shared connect`
were given — the SAME `$FLAGS` on every command below and later on
`/ace:release`.

1. **Inventory.** `$RC inventory --run-folder <id> --out inventory.json`.

2. **Gates — every QA result and eval verdict of every step.** These come from
   the inventory in step 10 — a `fail`, a result that is not the canonical shape
   (ace-web shows it as "0/0 checks"), an unparseable verdict, an eval below its
   pass band, a step whose `-qa` / `-eval` has no file, or an artifact
   regenerated after its gate. Before assessing, **re-run every gate that is
   missing or stale** — dispatch the gate skill itself
   (`Skill(training-deck-render-eval)`, `Skill(demo-data-setup-qa)`, …) — then
   re-run step 1. Under `--read-only`, run each gate with its writes going to
   the scratch dir instead, and pass them with `--overlay` in step 10.

3. **Connect post-condition (live).** In one parallel message, at the holding
   org: `connect_get_opportunity`, `connect_list_payment_units`,
   `connect_list_flw_invites({phone: "${ACE_E2E_PHONE}"})`; save each JSON, then
   `$RC postcondition --run-state … --opportunity … --payment-units … --invites … --out postcondition.json`.

4. **Output previews.** `scripts/output-preview-capture.ts gaps --opp … --run …
   --refresh > gaps.json`. Any gap → run `output-preview-capture` for the run
   (all phases, `--run-end`), then fetch again. Then **LOOK** at a sample of the
   preview frames — at least one per phase that has previews, and every frame
   captured today: a login page, an error, an empty report or the WRONG thing
   is a blocker. Record each look as `{frame, ok, detail}` in `looks.json`.

5. **HQ plan.** `commcare_get_subscription(domain: <the apps' HQ space>)` →
   save as `hq-plan.json` (the space: `products.apps.domain`, else an app's
   `hq_url`; `hqDomainFromRunState`). Free → blocker `hq-plan-free:<space>`,
   owned by **HQ superuser (operator)**, whose fix is the exact URL and clicks
   (`$RC hq-flip-steps --domain <space>`). When run interactively
   (`/ace:validate-release-readiness`), print those steps verbatim and
   `AskUserQuestion` "Set `<space>` to Test or Demo Project — done?"
   (**Done — re-check** / **Stop**); on *Done* re-read the subscription and
   save it again. Never take "done" as the evidence. Dispatched (from
   `clone-to-new-workspace`), report it and go on.

6. **Repair — the work release used to call "polish".** Run `run-surface-audit`
   anonymously on `<workspace>/<opp>/<run-id>` and fix, in the run's OWN
   documents and run_state, everything an outsider would trip on that ACE can
   fix: links on the summary that point into the SOURCE workspace or a shared
   tenant (`scripts/clone-asset-refs.ts` plan → apply, as in
   `clone-to-new-workspace` Step 4e), anything marked misleading, missing
   previews (step 4). What cannot be fixed here stays a blocker, with its owner.
   **Sharing is never a repair** — a private document becomes a plan action
   (step 8), never a `drive_set_anyone_with_link` call here. After any repair,
   re-run step 1. All content changes happen here; `/ace:release` makes none.

7. **Links and the review page, per reviewer.**
   - `$RC links --workspace … --opp … --run … --run-state … --out links.json`
     loads every output with the session its host needs, and the public summary
     and the chatbot's public chat ANONYMOUSLY.
   - `$RC memberships --run-state run_state.yaml $FLAGS --out memberships.json`
     — the memberships each reviewer WILL hold once the plan has run (a planned
     HQ / Connect invite counts; a shared tenant does not; OCS never).
   - `scripts/audit-run-surface.ts <opp> <run> --workspace … --json --render
     --run-state … --run-files <paths json> --reviewer <email>` (once per
     reviewer) `--memberships memberships.json [--doc-source …] > surface.json`.
     This is the audit run anonymously AND as each named reviewer's access —
     it replaces the old `REVIEWERS-UNDECLARED` warning. A member-only link a
     reviewer will still not be able to open is `MEMBER-MISSING` (broken).
   - `verify_run_claims` on `claims.yaml` if the run has one → `claims.json`.
   - If the audit reports `broken` findings other than private Drive documents
     (those become plan actions), run `run-surface-audit-eval`.

8. **Drive sharing.** `$RC drive-access --surface surface.json --out drive-access.json`.

9. **Chatbot and apps.** If the newest `ocs-chatbot-qa_transcript*.md` is older
   than 7 days or records a failed exchange, run `ocs-chatbot-qa --quick` (and
   re-inventory). Apps need a released build per app and a passing
   `app-release-qa` result — both read from the inventory. The release is read
   from its contracted owner, `3-commcare/app-release_summary.md` frontmatter
   `apps.<kind>_app.{hq_app_id, build_id, is_released}` (`assessApps`; a
   summary naming a different `hq_app_id` than run_state blocks as
   `app-release-other-app`). run_state `products.apps` is only a fallback when
   that file is unreadable — no release key there is contracted (ace#2698).

10. **Verdict and plan.** Re-download `run_state.yaml` (anything above may have
    written it) and re-inventory, then:
    ```bash
    $RC assess --workspace <ws> --opp <opp> --run <run-id> --inventory inventory.json \
      --run-state run_state.yaml $FLAGS --drive-access drive-access.json \
      --gaps gaps.json --postcondition postcondition.json --links links.json \
      --surface surface.json [--claims claims.json] [--looks looks.json] \
      --hq-plan hq-plan.json [--decision-overrides decision-overrides.yaml] \
      [--overlay overlay.json] [--read-only] --out-dir <scratch>/out
    ```
    The tenancy is read from ace-web (or pass `--tenancy <json>` from
    `bin/ace-bind --show`), and so is the workspace's ace-web membership —
    members + pending invites, read-only (or pass `--ace-web-membership <json>`
    `{members: [{email, role, user_id}], pending_invites: [{email, role}]}`).
    Missing evidence is its own blocker ("not checked"),
    never a pass; no reviewers is a blocker. Upload
    `release-readiness_verdict.yaml` (`drive_upload_binary`, `text/yaml`) and
    the report (`drive_create_doc_from_markdown`, name
    `release-readiness_report.md`) to the RUN ROOT — **except under
    `--read-only`, which writes nothing to Drive.** Write nothing to the run
    after the verdict: any later write makes it stale.

11. **Report** the verdict line; every blocker as its `summary` and `action`
    (owner and technical fix beneath); every WAIVED blocker with its failing
    grade, reason, who and when; the warnings; and on READY the plan
    (`$RC plan-show --verdict <scratch>/out/release-readiness_verdict.yaml`) —
    the grant table and every email. End with the exact release command:
    `/ace:release <workspace>/<opp>/<run-id> $FLAGS`. A NOT READY run is not a
    failure of this skill — it is its answer.

## The gate `/ace:release` calls

```bash
$RC gate --workspace <ws> --opp <opp> --run <run-id> --verdict <local release-readiness_verdict.yaml> \
  --inventory <fresh inventory.json> --run-state <fresh run_state.yaml> $FLAGS
```

Exit 0 only when the verdict is a READY v2 `release-readiness` verdict, for this
workspace/opp/run, not a dry run, nothing in the run folder was written after
it, `run_state.yaml` hashes the same, the plan matches its hash, and the
reviewers, cc, waivers and flags are exactly the ones validated (`releaseGate`). Otherwise it
prints why and the release stops — it never adapts.

## MCP Tools Used

- **ace-gdrive:** `resolve_opp_path`, `drive_read_file`, `drive_upload_binary`,
  `drive_create_doc_from_markdown`, `verify_run_claims`; for repairs
  `drive_update_file`, `update_yaml_file`.
- **ace-connect:** `connect_get_opportunity`, `connect_list_payment_units`,
  `connect_list_flw_invites`, `commcare_get_subscription` (read-only).
- Skills it dispatches: the gate skills above, `output-preview-capture`,
  `run-surface-audit`, `run-surface-audit-eval`, `ocs-chatbot-qa`.
- Never: any invite, share, permission or email atom — those are
  `/ace:release`'s, and only from the plan.

## Mode Behavior

- **Auto / default / review:** identical except step 5's operator prompt,
  which only an interactive `/ace:validate-release-readiness` asks.
- **`--read-only` / dry-run:** no Drive writes, no repairs, no gate writes into
  the run (they go to the scratch dir and in via `--overlay`); the verdict says
  `read_only: true` and can never release.

## Related skills

- `release-run` (`/ace:release`) — executes this verdict's plan and nothing else.
- `clone-to-new-workspace` — runs this as its last step, to report (not block).

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-10-01 | First version: READY / NOT READY over every gate's evidence. | ACE team |
| 2026-10-05 | `--cc` (ace#2706, operator decision "All 8 get the email"): Dimagi staff copied on every release email, granted nothing; on the plan and every `email` action, in the plan hash, compared exactly by the gate; any non-Dimagi cc refused. `--from-thread` now splits participants with `$RC thread-recipients` (partner domains → reviewers, Dimagi staff → cc, the rest shown as excluded). | ACE team |
| 2026-10-05 | `--from-thread` makes the thread's Dimagi staff **reviewers** (viewer: ace-web workspace invite, the partner grants, their own email), not cc (ace#2720, operator correction: "we want dimagi people to be invited into the workspace if they are on the project"). `--cc` stays, as an explicit opt-in only — `thread-recipients` no longer derives it. | ACE team |
| 2026-10-08 | Every release `ace_web_invite` carries role `editor` (`RELEASE_ACE_WEB_ROLE`), regardless of the reviewer's `:viewer`/`:editor`; Connect org role unchanged (`viewer`). Owner directive (Jonathan): "everyone ace invites in as part of a release should be editor". Existing READY verdicts need re-validation (the plan hash changes). | ACE team |
| 2026-10-08 | Existing ace-web members (ace#2770): `assess` reads the workspace's members + pending invites. A reviewer already a member at editor or above gets no invite (`ace_web` status `already-member`, role read back) and the existing-member email (no accept link; "sign in at" the run's workbench page); a viewer member gets an `ace_web_role` raise to editor (PATCH — an invite 409s); a pending invite is re-invited (fresh token). Unread membership is a blocker. Plan hash changes — re-validate before releasing. | ACE team |
| 2026-10-05 | `--waive <blocker-id>=<reason>` (ace#2707, operator decision: release the work order as a DRAFT past a non-converging `pdd-to-work-order-eval`): eval-area blockers only; the blocker stays in the verdict marked `waived: {by, at, reason}`, is excluded from READY, shown in the report and approval prompt, on the plan (hashed) and compared exactly by the gate. | ACE team |
| 2026-10-03 | Became `validate-release-readiness` (owner decision): absorbs the HQ plan check, the review-page audit (per reviewer), the repairs `/ace:release` used to make, Drive sharing; requires reviewers; on READY writes the hashed release plan + every email, and a run_state hash. Verdict file renamed `release-readiness_verdict.yaml` (v2). | ACE team |
