---
name: commcare-setup
description: >
  Phase 2 of the CRISPR-Connect lifecycle: translate the approved PDD into
  Learn and Deliver apps via Nova, deploy them to CommCare HQ, and test.
model: inherit
phase: commcare-setup
phase_display: CommCare Setup
phase_ordinal: 2
skills:
  - { name: pdd-to-learn-app,        has_judge: true,  eval_skill: pdd-to-learn-app-eval }
  - { name: pdd-to-deliver-app,      has_judge: true,  eval_skill: pdd-to-deliver-app-eval }
  - { name: app-connect-coverage,    has_judge: false }
  - { name: app-deploy,              has_judge: false }
  - { name: app-test-cases,          has_judge: false }
  - { name: app-release,             has_judge: true,  eval_skill: app-release-eval }
---

# CommCare Setup (Phase 2 Procedure Document)

This file specifies Phase 2 of the CRISPR-Connect lifecycle: build and
deploy the CommCare-side apps.

**This file is read and executed inline by the top-level Claude Code
session — it is NOT dispatched as a subagent.** Step 1 invokes
`/nova:autobuild`, which itself dispatches `nova:nova-architect-autonomous`
via the `Agent` tool. `Agent` is only available at level 0; running
Phase 2 as a subagent would put Nova's dispatch at level 2 and fail.
See `agents/ace-orchestrator.md` § Agent Topology. The frontmatter is
retained for tooling that introspects agent metadata, not because Phase
2 is itself dispatched.

## Workflow

Execute these steps in order for the given opportunity:

### Step 0: Nova preconditions (HARD GATE — run before anything else)

Before dispatching any architect, verify Nova is authenticated **at the
top-level session** and bound to the expected HQ project space. Skipping
this step is the single biggest documented time-sink in Phase 2 — see the
turmeric-20260429-2330 e2e: the architect produced apps under its own
auth context that were invisible to the user's Nova account, every
`upload_to_hq` failed with "App not found", and the apps had to be
rebuilt from scratch (~30 min wasted, plus a re-run of `validate_app`).

The architect-vs-user auth split is silent — no symptom appears until
upload_to_hq, by which point the architect has already burned its budget.
Catch it here.

#### Step 0a: Stale needs-auth-cache preflight (before probing Nova)

Claude Code maintains a per-MCP-server "needs auth" cache at
`~/.claude/mcp-needs-auth-cache.json`. When an entry exists for
`plugin:nova:nova`, the MCP host **silently skips reconnecting** to Nova
on session start — the session log shows
`"Skipping connection (cached needs-auth)"` lines and refresh tokens are
never tried. The entry is meant to short-circuit retries within a session
but persists across sessions and routinely outlives the auth condition
that caused it. Prune it before probing:

```bash
node -e '
  const fs = require("fs"), path = require("path"), os = require("os");
  const f = path.join(os.homedir(), ".claude", "mcp-needs-auth-cache.json");
  if (!fs.existsSync(f)) { console.log("no needs-auth cache"); process.exit(0); }
  const c = JSON.parse(fs.readFileSync(f, "utf8"));
  const e = c["plugin:nova:nova"];
  if (!e) { console.log("no plugin:nova:nova entry"); process.exit(0); }
  const ageMs = Date.now() - e.timestamp;
  if (ageMs > 60 * 60 * 1000) {  // 1h
    delete c["plugin:nova:nova"];
    fs.writeFileSync(f, JSON.stringify(c));
    console.log(`pruned stale needs-auth entry (age ${Math.round(ageMs/60000)} min)`);
  } else {
    console.log(`needs-auth entry is fresh (age ${Math.round(ageMs/60000)} min) — leaving`);
  }
'
```

If a stale entry was pruned, **the MCP host needs a chance to retry the
connection.** A no-op MCP call (e.g., `mcp__plugin_nova_nova__list_apps`)
triggers a reconnect attempt against the saved refresh token; if the
refresh succeeds, Nova is authed without OAuth involvement. If the cache
entry was already fresh, skip ahead to Step 0b — the cache is reflecting
real state and pruning won't help.

**Do NOT call `mcp__plugin_nova_nova__authenticate` as part of this
preflight.** `authenticate` clears any stored tokens before starting a
new flow; calling it on a recoverable cache-staleness condition destroys
the very refresh token that would have let the MCP host self-recover.
`authenticate` is the LAST resort in 0c, not the first probe.

#### Step 0b: Probe Nova

Call `mcp__plugin_nova_nova__get_hq_connection` (no args). Branch on the
result:

- `{ configured: true, domain.name === <ACE_HQ_DOMAIN> }` → **proceed to Step 1.**
- `{ configured: true, domain.name !== <ACE_HQ_DOMAIN> }` → halt; Nova is
  bound to the wrong project space. Tell the operator to update Nova's
  settings page (`https://commcare.app/settings`) so the active HQ API
  key targets `<ACE_HQ_DOMAIN>`, then re-run.
- `{ configured: false }` OR the call surfaces an authorization URL OR
  the MCP server returns a 401-ish "not authenticated" error → fall
  through to Step 0c (auth path).

#### Step 0c: Auth path — invoke `/ace:nova-login`

Reaching here means: the cache prune in 0a did not unblock the
connection, and Nova still reports unauthenticated in 0b. Refresh tokens
are either missing or rejected.

**Invoke `/ace:nova-login`.** It is the canonical recovery skill for
this state. It:

1. Pre-checks `~/.claude/.credentials.json` for the Nova OAuth entry's
   `expiresAt` and `refreshToken`.
2. Tries a refresh-token POST against `commcare.app`'s OAuth token
   endpoint first — most "needs-auth" states are just an expired
   access token the MCP host should have refreshed but didn't. If the
   refresh succeeds, no UI involvement; the access token is rewritten
   and the operator only needs `/reload-plugins`.
3. Falls back to a headed Playwright flow if the refresh fails.
   `authenticate` is called inside the skill (NOT here in
   commcare-setup) so its 5-minute localhost-listener timeout starts
   when the operator is actually about to interact.
4. Verifies post-flow that tokens were persisted and writes a backup
   to `~/.ace/nova-credentials-backup.json` for future emergency
   restore.

**After `/ace:nova-login` returns:**

- Tell the operator to run `/reload-plugins` so the MCP host picks up
  the fresh tokens.
- Re-probe `mcp__plugin_nova_nova__get_hq_connection` to confirm
  `configured: true` against `<ACE_HQ_DOMAIN>`.
- Only then dispatch the architect (Step 1).

**Why we don't drive Google login programmatically.** The OAuth landing
page at `commcare.app/api/auth/oauth2/authorize` has nothing but a
"Sign in with Google" button — no username/password form (verified
via `curl -L` 2026-05-05). `ACE_HQ_USERNAME`/`ACE_HQ_PASSWORD` are
CommCareHQ creds (different domain) and don't apply. Driving Google
sign-in programmatically would require `ACE_GMAIL_PASSWORD` in `.env`
PLUS reliable handling of bot-detection, step-up auth, OTP prompts —
not realistic for a per-machine credential storage. The headed
Playwright path is the right answer: one interactive sign-in per
refresh-token lifetime (~30 days), full automation in between.

**Legacy manual path (fallback if `/ace:nova-login` itself breaks).**
Run `mcp__plugin_nova_nova__authenticate` directly, present the URL to
the operator, and either wait for the success-page reply or use
`mcp__plugin_nova_nova__complete_authentication` with the
`localhost:<port>/callback?code=…&state=…` URL from the address bar.
This is what `/ace:nova-login` automates; only do it by hand if the
skill itself is broken.

Do NOT dispatch the architect until `get_hq_connection` returns
`configured: true` against `<ACE_HQ_DOMAIN>`.

#### Why this layering

The 0.13.0 turmeric-20260504-2304 run halted at 0c because 0a/0b didn't
exist. The session log showed `"Skipping connection (cached needs-auth)"`
three times before the orchestrator ever invoked `authenticate` — a
plain cache prune would have likely recovered the session, since
refresh tokens were intact at that moment. Calling `authenticate`
*cleared* those tokens (`"Cleared stored tokens"` in the log) and forced
a full interactive OAuth round-trip. The 5-minute window then expired
because the operator was on a different terminal. Net cost: one wasted
authenticate call plus a forced halt that the cache prune would have
avoided.

#### Subagent inheritance

Apply the same gate at the start of any later subagent dispatch in this
phase that calls Nova MCPs (e.g. coverage retries) — but the parent's
auth state is what matters. Subagents inherit Nova's session because
Nova runs as a single MCP server process per session; once the parent
is authed, every subagent dispatch sees the same `get_hq_connection`
result.

### Step 1: PDD to Apps (sequential)
Invoke `pdd-to-learn-app`, then `pdd-to-deliver-app`.

**Run these sequentially, not in parallel.** An earlier note here
claimed they could batch in a single assistant message; that was
incorrect — Claude Code does not reliably parallelize `Agent`
dispatches the way it parallelizes regular tool calls, and Nova's
`/nova:autobuild` cannot be parallelized in this environment today.
Dispatch Learn, await its result, then dispatch Deliver. Each takes
10–15 minutes; the two together set the lower bound on Phase 2
wall-clock until upstream supports parallel architect runs.

The two builds are otherwise independent — Learn reads the PDD's
learning objectives, Deliver reads the visit/registration spec,
neither depends on the other's `nova_app_id`.

If the Learn build fails, halt before dispatching Deliver — re-running
both wastes ~10 min and the failure is usually deterministic (PDD
spec issue, not transient).

#### Turn-0 halt detection (defensive — Nova issue #2)

Nova's `/nova:autobuild` occasionally returns from
`nova:nova-architect-autonomous` having taken zero tool actions — no
`create_app`, no scaffold, no error, just a prose response. When this
happens the `Agent` call appears to "succeed" but no Nova app exists.
Filed as `voidcraft-labs/nova-plugin#2`; the right fix is upstream
(autobuild refusing to return without ≥1 tool call). Until that lands,
defend against it on the ACE side:

After **each** Nova `Agent` dispatch returns, before treating its
output as authoritative:

1. Inspect the Agent's return string for a `nova_app_id` (or call
   `mcp__plugin_nova_nova__list_apps` and look for an app whose
   `created` is within the last few minutes and whose name matches
   the spec just submitted).
2. If no new app is present, the dispatch halted at turn 0. **Re-dispatch
   up to two more times** (so up to **3 total attempts**) with the same
   spec. Empirically (turmeric-20260429-2330): two halts in a row, third
   attempt completed cleanly — bumping the budget caps wasted wall-clock
   at ~30 sec per halted attempt while preserving the "don't loop forever"
   discipline.
3. If the third attempt also produces no app, surface a hard error
   with `nova-plugin#2` in the message — at that point the failure is
   no longer plausibly transient; let the operator decide whether to
   wait for upstream or escalate.

Apply this check after the Learn dispatch and again after the Deliver
dispatch — they fail independently. Apply the same retry policy to
**any** `nova:nova-architect-autonomous` dispatch elsewhere in this
phase (e.g., the `app-connect-coverage` verification dispatches in
Step 1.5), since `nova-plugin#2` affects every architect dispatch
identically — not just builds.

- Input: approved PDD from GDrive
- Output: app JSON/CCZ files + summaries written to `ACE/<opp-name>/app-summaries/`
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `pdd-to-learn-app-eval` after the Learn build and
  `pdd-to-deliver-app-eval` after the Deliver build. Each writes
  `runs/<run-id>/2-commcare/pdd-to-learn-app-eval_verdict.yaml` and
  `runs/<run-id>/2-commcare/pdd-to-deliver-app-eval_verdict.yaml`
  respectively. A `verdict: fail` here does not halt Phase 2 on its
  own; the Phase 2→3 gate uses
  `runs/<run-id>/2-commcare/app-deploy_gate-brief.md`.

### Step 1.5: Connect-marker coverage (verify + auto-fix)
Invoke the `app-connect-coverage` skill **once per app** (Learn, Deliver).
- Input: `nova_app_id` from each app summary; PDD for context
- Output: `ACE/<opp-name>/app-coverage/{learn,deliver}-connect-coverage.md`
  reporting before/after state per form. The Nova app on Firestore is
  mutated in place — every form's `connect` block (`learn_module` /
  `assessment` / `deliver_unit` / `task`) is set per the form's purpose.
- **Why before deploy:** Connect's `Sync Deliver Units` reads markers
  from the released CCZ. If markers are missing, the opp gets stuck
  silently at Phase 3 Step 2 (no deliver units → no payment unit).
  Fixing on the Nova side before upload avoids round-tripping HQ
  builds.
- **Why before eval:** the existing `pdd-to-{learn,deliver}-app-eval`
  judges grade Connectify wiring (25% weight). Running coverage first
  means evals score the auto-fixed app, not whatever Nova happened to
  emit.
- **Failure modes:**
  - **`blocked` with `voidcraft-labs/nova-plugin#1` (Bug 2 — empty
    `entity_id`/`entity_name` re-injected on `update_form`
    `deliver_unit`):** halt Phase 2. The malformed bind will fail
    CCHQ's build at `app-release`, and the eventual released CCZ
    won't carry the markers Connect needs. Wait for upstream fix.
  - **Coverage's architect dispatch can't get past `nova-plugin#2`
    (bootstrap halts on all 3 attempts):** **do NOT halt Phase 2.**
    Coverage is the upstream safety net; `app-release` (Step 2.7,
    0.10.5+) is the actual wall — its Step 6 downloads the released
    CCZ and greps for `<learn:deliver>` / `<learn:module>` element
    counts, which catches Bug 2 escapes cleanly. Log the coverage
    skip into `run_state.yaml` (`app-connect-coverage-{learn,deliver}:
    skipped-nova2`), write a stub coverage report noting the skip
    + reliance on app-release verification, and proceed to Step 2.
    Rationale: Nova's autobuild path doesn't go through `update_form`
    for the initial connect block, so a clean autobuild build report
    almost always means clean markers; the only risk is a silent
    Nova-internal regression that `app-release`'s grep catches anyway.

### Step 2: Deploy Apps
Invoke the `app-deploy` skill.
- Input: app JSON/CCZ files from GDrive
- Output: apps uploaded to CCHQ as **draft builds** (Nova does not release
  by design — see Step 2.7)
- **Gate (review mode):** Present app deployment summary for verification
- **HQ-id stability requirement (added 2026-04-30):** every `nova_upload_to_hq`
  call creates a **fresh** HQ application document with a new id (CCHQ has no
  atomic update API for app uploads). If Phase 2 has to re-upload an app for
  ANY reason after the first deploy — XForm escape fixes, Connect-marker
  patches, build-rejection iteration — the HQ ids in
  `2-commcare/app-deploy_summary.md` must be updated, and Phase 3
  (`connect-opp-setup`) MUST run against the FINAL post-iteration ids.
  Phase 3's `connect_create_opportunity` writes the HQ ids into the opp's
  app-wire fields at create time, and Connect's edit form does NOT expose
  those fields — so re-pointing a wired opp at new HQ ids requires
  delete-and-recreate. Surfaced 2026-04-30 (turmeric-20260429-2330): Phase 3
  ran after the first upload; Phase 2 then re-uploaded for the Q10 escape
  fix; the resulting opp was wired to abandoned drafts. The orchestrator's
  Phase 2→3 transition MUST verify
  `2-commcare/app-deploy_summary.md.released_at >= 2-commcare/app-deploy_summary.md.uploaded_at`
  AND that no subsequent re-upload happened, before dispatching Phase 3.

### Step 2.6: Generate app-test-cases.yaml

Dispatch `app-test-cases`:
- Reads: expected-journeys.md, both app summaries, Nova blueprints
- Writes: app-test-cases.yaml + recipes/J*.yaml under app-test-cases/
- Halts on missing inputs or recipe-validation failure

Phase 5 shallow runs the smoke recipes; /ace:qa-deep runs them all.

This step runs **after** `app-deploy` (so the Nova blueprints are
finalized and the HQ ids are stable) and **before** `app-release` (so
the recipes are in place by the time Phase 5 needs them, and so the
journey-to-form bindings are captured against the apps as built — not a
later re-build). Nova builds are uploaded via `app-deploy`, so the
blueprint IDs we read here are the same ones the released CCZ will
carry; `app-release` is when we can no longer rebuild the apps cheaply,
so it's the natural cutoff for "the apps are now what they are."

### Step 2.7: Release Apps
Invoke the `app-release` skill.
- Input: HQ app ids from `2-commcare/app-deploy_summary.md`
- Output: each app has a new released build; Connect's `Sync Deliver Units`
  can now read the form schema. Without this step, Phase 3
  (`connect-opp-setup`) creates the opp shell but cannot configure
  payment units (deliver-units list comes back empty).
- **Prerequisite:** the user backing `ACE_HQ_USERNAME` needs a role with
  `edit_apps` on the target project space; the standard `Admin` role
  includes it. The skill includes an empirical probe procedure for the
  underlying CCHQ endpoints — they're internal UI routes, not stable
  public APIs.
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `app-release-eval` after release. Writes `verdicts/app-release.yaml`.

Note: the `app-test` skill was retired in the shallow/deep QA split
(0.11.10). Phase 2's QA contribution is now Step 2.6's
`app-test-cases.yaml`; the actual smoke runs happen in Phase 5
(`app-screenshot-capture`) and the deep grading runs from
`/ace:qa-deep` (`app-ux-eval`). Spec:
`docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md`.

Note: `training-materials` no longer runs in Phase 2. As of 0.9.0 it lives
in Phase 5 (`qa-and-training`), where it consumes the screenshots produced
by `app-screenshot-capture` alongside the app summaries.

### Completion
Write phase summary to `ACE/<opp-name>/runs/<run-id>/2-commcare/commcare-setup_summary.md`,
then write the `phases.commcare-setup` block + flip `gates.app-deploy`
per `agents/ace-orchestrator.md § Phase Write-Back Contract`. Phase 2
is a procedure doc executed by the top-level orchestrator session
inline (see § Agent Topology), so the orchestrator owns this write.
Required top-level keys on the patch: `phases`, `gates`, `last_actor`,
`last_actor_at`.
