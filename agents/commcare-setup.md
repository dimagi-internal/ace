---
name: commcare-setup
description: >
  Phase 3 of the ACE lifecycle: translate the approved PDD into
  Learn and Deliver apps via Nova, deploy them to CommCare HQ, and test.
model: inherit
phase: commcare-setup
phase_display: CommCare Setup
phase_ordinal: 3
skills:
  - { name: pdd-to-learn-app,        has_judge: true,  eval_skill: pdd-to-learn-app-eval }
  - { name: pdd-to-deliver-app,      has_judge: true,  eval_skill: pdd-to-deliver-app-eval }
  - { name: app-connect-coverage,    has_judge: false }
  - { name: app-media-coverage,      has_judge: false }
  - { name: app-deploy,              has_judge: false }
  - { name: app-test-cases,          has_judge: false }
  - { name: app-hq-settings,         has_judge: false }
  - { name: app-release,             has_judge: true,  eval_skill: app-release-eval }
  - { name: app-release-qa,       has_judge: false }
---

# CommCare Setup (Phase 3)

This file specifies Phase 3 of the ACE lifecycle: build and
deploy the CommCare-side apps.

**This is a subagent — the orchestrator dispatches it with
`Agent(commcare-setup)`.** It was an inline procedure doc until 0.13.1018,
for one reason that has since expired: Step 1 invokes `/nova:autobuild`,
which dispatches `nova:nova-architect-autonomous` via the `Agent` tool, and
Claude Code used to withhold `Agent` from every subagent — so a subagent
Phase 3 could not reach Nova at all. Nesting has been allowed since
v2.1.219, and this chain (`ace-orchestrator → commcare-setup →
nova:nova-architect-autonomous`) sits at depth 2 against a budget of 3. See
`CLAUDE.md § Agent topology`; `lib/agent-depth.ts` holds the arithmetic and
`test/lib/agent-depth.test.ts` fails CI if it stops fitting.

**What this buys, and what it costs you as the author of this file.** Phase 3
now runs in its own context window instead of consuming the orchestrator's.
That is the point — the orchestrator carries a ten-phase run, and this phase
was the heaviest thing in it. The cost is that a subagent starts *fresh*: it
does not see the orchestrator's conversation, the files it read, or the
skills it invoked. Everything this phase needs must arrive in the dispatch
message (see `agents/ace-orchestrator.md § Phase 3` → **Inputs**), and
everything it produces must be written to Drive and `run_state.yaml` rather
than left in context for a later phase to pick up.

**The Phase 3→4 gate is unaffected.** This file writes per-skill verdicts;
the orchestrator reads them at the phase boundary and synthesizes any pause
there, at level 0. Nothing in this file prompts a human.

## Workflow

Execute these steps in order for the given opportunity:

### Step 0: Nova preconditions (HARD GATE — run before anything else)

**SESSION-SCOPED PRECONDITION — re-run on EVERY entry into Phase 3,
including a mid-phase resume.** Step 0 asserts facts about *this Claude Code
session* — which principal the Nova MCP bound, which tool surface it serves.
`run_state.yaml` is per-RUN state that outlives the session, so a `done`
marker written by yesterday's session is not evidence about today's binding:
**treat Step 0 as unrun on entry, whatever the recorded step state says**,
and run it before the first not-yet-done step even when that step is 2.6 and
both apps are already built. Restore, don't adapt (CLAUDE.md § Phase
preconditions are restored, not adapted) — run it unconditionally, do not
probe-then-branch on whether it "already passed". The whole gate is three
read-only calls; what it catches is unrecoverable in-session. Precedent:
`ace-orchestrator.md § Resolution` step 5 makes the inputs-manifest capture
unconditional on resume for exactly this reason (dimagi-internal/ace#1234).
Cost of skipping it: dimagi-internal/ace#1604 —
`spark-facilitator/20260820-0817` resumed into Phase 3 mid-phase with the
Nova MCP bound to a different principal than `NOVA_API_KEY` names, and the
first Nova call answered `App not found` for an app the previous session had
built. Neither the L0 binding fence (which covered `pending` phases only) nor
this gate (stepped over as already-done) was in the resume path.

Before dispatching any architect, verify Nova is bound to the expected
HQ project space. Skipping this step is the single biggest documented
time-sink in Phase 3 — see the turmeric-20260429-2330 e2e: the
architect produced apps under its own auth context that were invisible
to the user's Nova account, every `upload_to_hq` failed with "App not
found", and the apps had to be rebuilt from scratch (~30 min wasted,
plus a re-run of `validate_app`).

The architect-vs-user auth split is silent — no symptom appears until
upload_to_hq, by which point the architect has already burned its
budget. Catch it here.

#### Step 0a: Verify Nova auth liveness + plugin freshness

Run `/ace:doctor` and confirm the `nova_auth` line passes:

    PASS nova_auth: ace-nova authed (POST initialize → HTTP 200)

**In the same output, check `nova_plugin_current`** (ace#1165). Being *installed*
is not the same as being *current*, and the two fail differently:

    PASS nova_plugin_current: 1.14.0 is the current release
    WARN nova_plugin_current: installed 1.13.0 but 1.14.0 is released …

The Nova plugin declares an **HTTP** MCP server, so the *tool surface* is served
live and never goes stale with the package — a new Nova tool is callable from an
old plugin. What goes stale is everything the package ships: `/nova:autobuild`,
`/nova:upload_to_hq`, `nova-architect-autonomous`, and their prompt guidance. So
a stale plugin does not hide tools; it **silently runs an older Nova workflow**
and carries prose describing retired tools and argument shapes into the architect
dispatch. Nova validates every mutation before saving, so this fails closed rather
than corrupting an app — but the resulting error looks arbitrary, especially when
the same ACE workflow worked in an earlier run. That is Step 0c's symptom with a
nameable cause.

On WARN, refresh before dispatching the architect — Nova's maintainer asks that
**every** Nova release be treated as a compatibility update rather than judged
optional from the version number:

    /plugin marketplace update
    /plugin update nova
    # then RESTART Claude Code (Cmd-Q + reopen) — a changed MCP tool surface only
    # rebinds on a fresh session; /reload-plugins does NOT respawn it.

This is a **WARN, not a halt**: ACE runs fine on a slightly old plugin, and a
network blip must never block Phase 3. Refresh it unless you have a reason not to,
and say in the run notes that you proceeded stale. To check outside a doctor run —
before any other large batch of Nova work — call the probe directly:

    bin/ace-nova-check     # → UP_TO_DATE <v> | UPGRADE_AVAILABLE <old> <new> | NOT_INSTALLED | ERROR <why>

If `nova_auth` fails:

- `nova_env: NOVA_API_KEY missing or unresolved` → operator hasn't
  minted a key yet. Mint at `https://commcare.app/settings` as the ACE
  Gmail identity, save to 1Password item `ACE - Nova` / field
  `api_key`, then run `/ace:setup --force-env`.
- `nova_auth: HTTP 401` → key invalid or revoked. Rotate at
  `commcare.app/settings`, update the 1Password item in place, then
  `/ace:setup --force-env`.
- `nova_shell_env: NOVA_API_KEY not in shell env` → operator hasn't
  sourced `~/.ace/env.sh` from their shell rc. Run the remediation
  command doctor prints (`echo 'source ~/.ace/env.sh' >> ~/.zshrc &&
  exec zsh`) and restart Claude Code so the Nova plugin re-reads the
  env.
- `nova_shell_env: stale user-scope nova: MCP override detected` →
  pre-1.1.0 setup carried over. `/ace:setup` removes it idempotently;
  if doctor still flags it, run `claude mcp remove nova --scope user`
  manually and restart Claude Code.

Halt Phase 3 until `nova_auth` and `nova_shell_env` are both green.
Authentication uses Nova plugin v1.1.0's PAT path (voidcraft-labs/nova-plugin#11
/ #13 / #16) — there is no OAuth refresh-token rotation, no per-session
sign-in, no needs-auth cache to manage, and Claude Code's
`~/.claude/.credentials.json` does not hold Nova credentials under this
path. The plugin's `headersHelper` reads `NOVA_API_KEY` from the
Claude Code parent shell's env.

#### Step 0b: Probe HQ binding

Call Nova's `get_hq_connection` (no args). Since the
voidcraft-labs/nova-plugin#12 release it returns
`{ configured, available_domains: [{ name, displayName }, …] }` — the
set of project spaces the saved HQ API key can reach (no single bound
`domain.name` anymore; a key may reach several spaces). Branch on the
result:

- `{ configured: true }` **and `<ACE_HQ_DOMAIN>` appears in
  `available_domains[].name`** → **proceed to Step 1.** The key reaches
  the target space; Phase 3's uploads name `<ACE_HQ_DOMAIN>` explicitly,
  so a multi-space key is fine — no need for the key to be scoped to a
  single space.
- `{ configured: true }` but `<ACE_HQ_DOMAIN>` is NOT in
  `available_domains` → halt; the saved HQ API key can't reach the
  target space. Surface the reachable spaces (`available_domains`) and
  tell the operator to either fix `ACE_HQ_DOMAIN` or visit
  `https://commcare.app/settings` and paste an HQ API key that reaches
  `<ACE_HQ_DOMAIN>`, then re-run.
- `{ configured: false }` → halt; Nova has no HQ key bound. The
  operator needs to paste an HQ API key (generated under the ACE Gmail
  identity at `<ACE_HQ_BASE_URL>/account/api_keys/`) into Nova's
  settings page once. Note: this is independent from `NOVA_API_KEY` —
  that one authenticates ACE → Nova; this one binds Nova → CommCareHQ.

Do NOT dispatch the architect until `get_hq_connection` returns
`configured: true` with `<ACE_HQ_DOMAIN>` among `available_domains`.

**`configured: true` does not tell you WHO you are — assert the principal
too (dimagi-internal/ace#1604).** `get_hq_connection` describes the HQ key
saved on whichever Nova account this session's MCP connection bound; it does
not prove that account is the one `NOVA_API_KEY` names. A connection bound to
a different principal answers every call normally, about a different
account's apps — the failure looks like data loss, not like an auth problem.
So make one addressed check:

- **The run already records app ids** (`phases.commcare-setup.products.apps.{learn,deliver}.nova_app_id`
  in `run_state.yaml` — the normal case on a resume) → call
  `list_apps({limit: 20, sort: "updated_desc"})` and assert **both ids appear
  in the result**.
- **No app ids recorded yet** (a fresh run that has built nothing) → there is
  nothing to compare against; `get_hq_connection` returning `configured: true`
  is the whole assertion, and Step 1's first build establishes the ids.

On a miss, **HALT**: *"The Nova MCP bound a different principal than
NOVA_API_KEY names — `list_apps` does not show this run's apps (`<learn-id>`,
`<deliver-id>`). MCP auth binds at connection time, so this is unrecoverable
in-session. A plain restart is NOT the remedy here — it has been tried and the
wrong principal came back (dimagi-internal/ace#1614). The cause is a stored
OAuth token outranking the `headersHelper` PAT (voidcraft-labs/nova-plugin#52).
Run `/mcp`, select `nova`, choose **`Clear authentication`** — NOT
`Authenticate`, which mints a fresh OAuth token and leaves you on the wrong
credential — then quit and reopen Claude Code and resume
`/ace:run <opp>/<run-id>`. Verify with BOTH `list_projects` (must be the PAT's
project) and `get_hq_connection` (must be `configured: true`); `list_apps`
alone passes while still on OAuth."*

Keep this distinct from a plain **bind miss** (the `nova` tools do not resolve
at all), which a full restart DOES fix. Wrong-principal means the connection
attached and authenticated as someone else, so restarting re-establishes the
same binding. See `agents/ace-orchestrator.md § Step 2a` for the full
rationale and the one-`curl` confirmation that separates a bad credential
(rare) from a bad binding (the observed case).

**Do NOT rebuild the apps in response to `App not found`.** They exist, under
a principal this session is not talking to. Rebuilding orphans the run's two
Nova apps, re-burns two architect dispatches, and leaves the run's recorded
`nova_app_id`s pointing at the originals — which is a worse end state than
the halt. Verify the principal first; `App not found` from an ACE-direct Nova
read on an app THIS run built is a binding symptom until proven otherwise.


**This call is ALSO the Nova-binding check — actually make it; do not skip
it or hand-wave it as "the architect subagent will re-probe."** If the Nova
tools won't load here at all (a `ToolSearch` for a Nova tool name returns
nothing, or `get_hq_connection` errors as tool-unavailable rather than
returning a `configured` payload), the Claude Code process's Nova MCP
connection failed at startup — a transient where the plugin MCP times out at
session start and Claude Code does NOT retry it mid-session (and
`/reload-plugins` does not respawn it). **HALT immediately** with: "Nova MCP
did not bind in this Claude Code session — quit and reopen Claude Code (a
full restart, not just `/reload-plugins`), then resume
`/ace:run <opp>/<run-id>`." Do NOT proceed into Step 1 on the assumption that
the architect subagent's own connection covers Phase 3: the architect
*builds* work (each dispatch opens its own connection), but the ACE-direct
steps — `app-deploy`'s `/nova:upload_to_hq`, the `pdd-to-*-app-eval`
`get_app` reads, and `app-connect-coverage` — all need **this** phase's own
Nova surface and are unrunnable without it. Catching this at second 0 instead
of mid-phase (~25 min in, after both apps are built) is the whole point of
Step 0. See jjackson/ace#659 (bednet-spot-check 20260601-1252).

**Why the remedy is still a full restart now that Phase 3 is a subagent.**
This step said "level 0" until 0.13.1032, written when Phase 3 ran inline in
the top-level session. It became a subagent in 0.13.1018 and the wording did
not move — which mattered, because the halt message named a level this phase
no longer runs at and the remedy was derived from level-0 behaviour. It
survives the move: a subagent is launched **in the same Claude Code process**
and shares its session and MCP connections, so a bind that failed at session
start is inherited by every subagent underneath it. Re-dispatching Phase 3
gets the same dead connection; only a process restart re-establishes it. The
depth-coded spelling was the error, not the instruction.

#### Step 0c: Probe Nova build-tool liveness (form-creation path)

`get_hq_connection` passing proves Nova is *authed and HQ-bound* — it does
**not** prove the tools the architect will actually call to build an app are
callable this session. The two gates above (`nova_auth`, `get_hq_connection`)
both passed cleanly on `bednet-spot-check/20260613-2313` while **every**
form-creation path was unusable, and the architect burned ~170K tokens across
two dispatches before the blocker surfaced (jjackson/ace#779). Root cause: the
running Nova MCP subprocess bound a **stale tool list at session start** —
three-way drift between (a) the deferred-tool registry at L0, (b) the
architect's bound toolset at L1, and (c) the live Nova server contract:

- `create_form` hit **client/server schema drift** — the live server rejected
  with `fields: expected array, received undefined`, but the bound `create_form`
  schema had **no `fields` param at all**, so no payload could satisfy it.
- `generate_scaffold` returned `MCP error -32602: Tool generate_scaffold not
  found` on CALL, even though its full schema loaded at L0 via `ToolSearch` —
  the deferred registry advertised it but the running subprocess didn't serve it.

So probe **callability, not just loadability**. Before dispatching the
architect, exercise the live subprocess twice — once for the addressing model,
once for the build path. Both are mandatory; neither takes more than ~1s.

**1. Addressing-model round-trip (MANDATORY — the `*Uuid` probe).**

This probe exists because the two gates above CANNOT see an addressing-model
change. `get_hq_connection` and `list_apps` take no positional addressing at
all, so a session can satisfy Step 0a + 0b + a "does a Nova tool answer?"
check and still be holding a tool surface that rejects every read the phase is
about to issue. That is exactly what happened on
`spark-facilitator/20260731-0656` (jjackson/ace#1132): Nova migrated its whole
surface from `moduleIndex`/`formIndex`/`fieldId` to
`moduleUuid`/`formUuid`/`fieldUuid` mid-run, and the failure surfaced two Nova
builds deep.

Run an **addressed read round-trip against a real owned app**:

1. `list_apps({limit: 1})` → take any `app_id` the ACE identity owns (a prior
   run's app is fine; this is read-only).
2. `get_app({app_id})` → **assert the blueprint carries `[uuid <rfc-uuid>]`
   markers** on its modules and forms. `get_app` is ACE's index→uuid resolver;
   if the uuids are gone, every downstream addressed call is unsatisfiable.
3. Take the FIRST module uuid off that blueprint and call
   `get_module({app_id, moduleUuid})`. **Assert it returns a real module
   payload.**

**HALT** on any of: no `[uuid …]` markers in `get_app`; a
`code: "unrecognized_keys"` naming `moduleUuid`; an
`expected string, received undefined` on a `*Uuid` path; or `-32602 … not
found`. Halt message: *"Nova's addressing model does not match what ACE sends
(uuid-addressed reads rejected on ACE’s own Nova surface). This is an upstream contract
change, not a stale subprocess — run the Nova contract probe to get the exact
drift, then migrate the affected skills before resuming."*

Do NOT work around a failure here by guessing a different parameter name. The
authoritative answer is one command away — it diffs the live `tools/list`
against what ACE actually sends and names every parameter that moved:

```bash
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/probe-nova-contract.ts"
```

**2. Build-path callability.**

`ToolSearch select:create_form` to confirm the schema loads at L0, then confirm
the bound `create_form` schema's params match what the live server expects (if
the bound schema has no `fields` param but the server demands one — or vice
versa — that is the drift). The `-32602`-on-call class is real: on
`bednet-spot-check/20260613-2313` a tool whose full schema loaded at L0 was not
served by the running subprocess at all. (Note: `generate_scaffold` does **not**
exist on the live surface — the schema-generation tool is `generate_schema`. An
older revision of this step named `generate_scaffold`; don't probe with it.)

On `-32602 … not found`, a server schema-mismatch, or any "tool advertised but
uncallable" result, **HALT immediately** with the same remediation as the
Step-0b binding failure: *"Nova build tools did not bind in this Claude Code
session (stale MCP subprocess — schema/tool drift). Quit and reopen Claude Code
(a full restart, not just `/reload-plugins`, which does NOT respawn MCP
subprocesses — see CLAUDE.md § MCP changes need a full Claude restart), then
resume `/ace:run <opp>/<run-id>`."* This turns a 25-min-in, two-architect-dispatch
failure into a second-0 halt — the same asymmetry Step 0b closes for HQ binding.

**Telling the two failure classes apart matters.** A *stale subprocess*
(tool advertised but uncallable, or bound schema disagreeing with the server)
is fixed by restarting Claude Code. A *contract change* (the live server
rejects the parameter names ACE sends, and the probe script agrees) is NOT
fixed by restarting — it needs a skill migration. Restarting into the same
rejection twice is the tell.

#### Subagent inheritance

Apply the same gate at the start of any later subagent dispatch in
this phase that calls Nova tools (e.g. coverage retries) — but the
parent's auth state is what matters. Subagents inherit Nova's MCP
connection because the user-scope override registers it once for the
session; every subagent dispatch sees the same `get_hq_connection`
result.

### Step 1: PDD to Apps (sequential)

Invoke `pdd-to-learn-app`, then `pdd-to-deliver-app`. The Learn-app
shape varies by archetype — read `skills/pdd-to-learn-app/SKILL.md
§ Archetypes` for the per-archetype brief:

- **`atomic-visit` / `multi-stage`** — full Learn app (training
  curriculum); typically 10-15 min Nova build.
- **`longitudinal-visits`** — full Learn app like `atomic-visit`, plus
  the three things an FLW working a case list has to be taught that a
  fresh-sample FLW does not: working the case list (finding an entity,
  reading its tile to see which visit is due, what to do when it's
  missing), the visit sequence (which visits, in what order, at what
  cadence, on-track vs. behind), and payability-against-history
  (whether repeating an activity on the same entity pays). Skips the
  `atomic-visit` walkthrough parts that assume a fresh subject each
  time unless the PDD declares them.
- **`focus-group`** — minimal sentinel Learn app (1 module, 1 form,
  ~7 fields, both Connect markers, doubles as an in-app readiness
  gate). Typically 1-2 min Nova build. The sentinel satisfies
  `connect_create_opportunity`'s `learn_app` requirement and gates
  attestation submissions on coordinator-confirmed practice-session-pass.
  See `docs/superpowers/specs/2026-05-15-focus-group-archetype-redefinition.md`
  for the sentinel rationale.

**Run the builds sequentially, not in parallel.** An earlier note here
claimed they could batch in a single assistant message; that was
incorrect — Claude Code does not reliably parallelize `Agent`
dispatches the way it parallelizes regular tool calls, and Nova's
`/nova:autobuild` cannot be parallelized in this environment today.
Dispatch Learn, await its result, then dispatch Deliver.

The two builds are otherwise independent — Learn reads the PDD's
learning objectives (or the sentinel spec for focus-group), Deliver
reads the visit / session-attestation spec, neither depends on the
other's `nova_app_id`.

If the Learn build fails, halt before dispatching Deliver — re-running
both wastes time and the failure is usually deterministic (PDD spec
issue, not transient).

#### Turn-0 halt detection (defensive)

After **each** Nova `Agent` dispatch returns, verify an app was created:

1. Inspect the Agent's return string for a `nova_app_id`. The return
   message reliably includes the canonical `**App Name** (app_id)` line.
   Fall back to `list_apps` (filter by `created` within the last few
   minutes and name match) if the return string is malformed.
2. If no new app is present, **re-dispatch up to two more times** (3
   total attempts).
3. If the third attempt also produces no app, surface a hard error.

Apply this check after the Learn dispatch and again after the Deliver
dispatch — they fail independently.

**An app that EXISTS but is half-built is the other case, and it is NOT a
re-dispatch (dimagi-internal/ace#1504).** The rule above covers "the architect
never got started." A Nova build is long, so the likelier interruption is a
transport failure (`Connection lost mid-response`, an API 5xx) that kills the
agent *after* `create_app` returned and partway through the field work. The
return string is missing or truncated, so a literal reading of step 2 says
"no app → re-dispatch" — and `/nova:autobuild` **creates a second Nova app**,
leaving a duplicate for `app-deploy` to choose between and an orphan for the
sweep to find.

So branch on whether an app exists, not on whether the agent returned cleanly:

- **No app** (`list_apps` shows nothing created in the window) → the rule
  above; re-dispatch, cap 3.
- **App exists** → **RESUME the same agent** with `SendMessage` rather than
  re-dispatching `/nova:autobuild`. It still holds the build context, so it
  resumes where it stopped instead of re-deriving the app from the brief.

  The resume message MUST tell it to re-establish ground truth rather than
  trust its own recollection: call `get_app`, then `get_form` on every form it
  believes it finished, and compare persisted field counts against what it
  intended. The `add_fields` partial-persistence quirk applies to everything
  built before the interruption, so a form that looked complete in the agent's
  own summary may not be. Restate the invariants most likely to be mid-flight
  at the cut — for a Learn app: the language phase runs LAST (an English edit
  after translating silently reverts that unit), and only the gating
  assessment may carry `connect.assessment`.

  If the resumed agent also dies, resume once more, then fall back to a
  `/nova:edit` against the existing `app_id` naming the specific gaps. Never
  reach for `/nova:autobuild` while an app for this run exists.

Live: `spark-facilitator/20260817-1610`, where the Learn build dropped
mid-language-phase. On resume `get_app` showed all 8 forms at their intended
counts — no structural repair was needed at all, and the only casualty was one
`update_translations` batch Nova had ATOMICALLY refused over a mistyped uuid,
so nothing from it had saved.

- Input: approved PDD from GDrive
- Output:
  - app JSON/CCZ files + summaries written to `ACE/<opp-name>/app-summaries/`
  - From `pdd-to-deliver-app`: appended `deliver-unit-count`, `one-form-per-module-workaround`, `multimedia-coverage-strategy` rows in `decisions.yaml` (merge-only; rows are emitted only when they meet the bar criterion in `skills/idea-to-pdd/SKILL.md § Decisions Log Convention` — the list is a working catalog, not a required set).
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `pdd-to-learn-app-eval` after the Learn build and
  `pdd-to-deliver-app-eval` after the Deliver build. Each writes
  `runs/<run-id>/3-commcare/pdd-to-learn-app-eval_verdict.yaml` and
  `runs/<run-id>/3-commcare/pdd-to-deliver-app-eval_verdict.yaml`
  respectively. A `verdict: fail` here does not halt Phase 3 on its
  own; the Phase 3→4 gate uses the per-skill verdict files
  (`runs/<run-id>/3-commcare/pdd-to-{learn,deliver}-app-eval_verdict.yaml`
  + `app-release-eval_verdict.yaml`); the orchestrator synthesizes any
  pause-time summary from those at runtime (gate-briefs removed in
  0.13.116 — see `agents/orchestrator-reference.md § Pause Points`).

### Step 1.5: Connect-marker coverage (verify + auto-fix)
Invoke the `app-connect-coverage` skill **once per app** (Learn, Deliver).
- Input: `nova_app_id` from each app summary; PDD for context
- Output: `3-commcare/app-connect-coverage_{learn,deliver}.md`
  reporting before/after state per form. The Nova app on Firestore is
  mutated in place — every form's `connect` block (`learn_module` /
  `assessment` / `deliver_unit` / `task`) is set per the form's purpose.
- **Why before deploy:** Connect's `Sync Deliver Units` reads markers
  from the released CCZ. If markers are missing, the opp gets stuck
  silently at Phase 4 Step 2 (no deliver units → no payment unit).
  Fixing on the Nova side before upload avoids round-tripping HQ
  builds.
- **Why before eval:** the existing `pdd-to-{learn,deliver}-app-eval`
  judges grade Connectify wiring (25% weight). Running coverage first
  means evals score the auto-fixed app, not whatever Nova happened to
  emit.
- **Failure modes:**
  - **`blocked` (empty `entity_id`/`entity_name` on re-fetch):**
    halt Phase 3. The malformed bind will fail CCHQ's build at
    `app-release`.

    **Read the BIND, not the element text** (dimagi-internal/ace#1192).
    In the released CCZ, a *correct* deliver marker renders as **empty
    elements** — `<entity_id/>` / `<entity_name/>` — with the value
    carried by a `calculate` bind pointing at them. So "empty" judged
    from element text false-blocks every standard ACE Deliver app.
    The defect is a marker with **no non-empty `calculate` bind**;
    an empty element with a bind is correct and must pass. This
    matters most on the case-UPDATE path, where the preload-hidden-field
    pattern (§ `entity_id`, ace#1180) produces exactly that shape.
  - **Coverage dispatch can't produce an app (all 3 attempts fail):**
    **do NOT halt Phase 3.** `app-release` (Step 2.7) is the actual
    wall — its Step 6 downloads the released CCZ and greps for
    `<learn:deliver>` / `<learn:module>` element counts. Log the
    coverage skip into `run_state.yaml`, write a stub coverage
    report, and proceed to Step 2.

### Step 1.7: Media coverage (images on the apps)
Invoke the `app-media-coverage` skill **once per app** (Learn, Deliver), or
once with `--app=both`.

- Input: `nova_app_id` per app; `ACE/<opp>/inputs/media/` if the opp supplies
  one; `pdd.md` for the Application Context.
- Output: images and built-in menu icons attached **in the Nova blueprint** —
  field labels, select options, module and form tiles — plus
  `3-commcare/app-media-coverage_plan-<app>.yaml` and a dated report.
- **Why before deploy:** media lives in the blueprint, and Step 2's upload is
  what carries it to HQ. Nova's `compile_app` bundles linked assets and writes
  the matching `<image>` itext itself (verified live 2026-08-27 — the asset
  landed in the released CCZ at `commcare/<sha256>.png`). Attaching after the
  upload would mean patching form XML on HQ, which is what the retired
  `app-multimedia-coverage` did and why every Nova rebuild used to lose it.
- **Why after Step 1.5:** it binds to specific fields and select options, so
  the forms must be final. Connect-marker auto-fix rewrites forms; binding
  before it would waste the work.
- **Ordering against the language layer is a non-issue.** Media attaches to a
  message slot without touching the text, and Nova's translation
  `sourceFingerprint` covers text only — verified live 2026-08-27, attaching
  and clearing media left an existing Spanish translation intact at
  `needs-review`. Unlike translation, media has no translate-LAST hazard.
- **Failure modes:**
  - **No `inputs/media/` folder:** normal and expected. The skill still applies
    built-in menu icons and generates where a question earns a picture.
  - **Generation unavailable** (Content Generator down or `--no-generate`):
    **do NOT halt Phase 3.** Supplied files and built-in icons still apply;
    the report records what was skipped. Images are an enhancement to the
    worker experience, not a Connect precondition — nothing downstream gates
    on them.
  - **A Nova attach batch is rejected:** Nova names the offending row and
    changes nothing. Fix that row and re-send the batch. If it cannot be
    fixed, drop the row and continue — see above.

### Step 2: Deploy Apps
Invoke the `app-deploy` skill.
- Input: app JSON/CCZ files from GDrive
- Output: apps uploaded to CCHQ as **draft builds** (Nova does not release
  by design — see Step 2.7)
- **Gate (review mode):** Present app deployment summary for verification
- **HQ-id stability (added 2026-04-30; premise INVERTED 2026-08-18):**
  `nova_upload_to_hq` **updates the HQ app in place**. The first upload to a
  project space creates the HQ application; every upload after that updates
  that same document and keeps its id, with `hq_app_action` reporting
  `created` | `updated`. Verified live 2026-08-18 against `connect-ace-prod`
  (`4dd0325b…` re-uploaded twice: `updated` both times, id constant,
  `remote_revision` 6 → 8, `left_behind: []`) — see
  `playbook/integrations/nova-integration.md § Uploading to HQ updates in
  place`. The original entry asserted the opposite (a fresh document with a
  new id per upload, CCHQ having no atomic update API); that is retired.

  What still holds: if Phase 3 re-uploads an app for ANY reason after the
  first deploy — XForm escape fixes, Connect-marker patches, build-rejection
  iteration — Phase 4 (`connect-opp-setup`) MUST still run against the FINAL
  post-iteration state, because the app CONTENT changed even though the id
  did not. And the id is not guaranteed immutable: if the linked HQ app is
  deleted on HQ, the call refuses with `remote_app_missing` and the next
  upload creates a fresh one. So read `hq_app_action` / `left_behind` rather
  than assuming either way, and update the ids in
  `3-commcare/app-deploy_summary.md` if they moved.
  Phase 4's `connect_create_opportunity` writes the HQ ids into the opp's
  app-wire fields at create time, and Connect's edit form does NOT expose
  those fields — so re-pointing a wired opp at new HQ ids requires
  delete-and-recreate **of the Connect opportunity** (CCC-301 will
  eventually expose `update_opportunity({learn_app, deliver_app})` and
  retire this dance). Update-in-place makes this the exception rather than
  the routine cost of a re-upload: it is now only reachable when an id
  actually moved (`remote_app_missing` → recreate), not every time Phase 3
  iterates. The orchestrator's Phase 3→4 transition MUST
  verify `3-commcare/app-deploy_summary.md.released_at >= 3-commcare/app-deploy_summary.md.uploaded_at`
  AND that no subsequent re-upload happened, before dispatching Phase 4.

  **What delete-and-recreate of the Connect opportunity does NOT touch:**
  any labs solicitation already published for this opp. Per
  `skills/solicitation-create/SKILL.md`, solicitations are scoped to a
  labs `program_id`, NOT to a specific Connect opportunity UUID — the
  `connect_opportunity_id` field under the current run's
  `phases.solicitation-management.products.solicitation` is ACE-side
  bookkeeping that records ACE's intended target, not a labs-side
  foreign key. The public solicitation URL keeps working, the deadline
  keeps counting down, candidate LLO views and applications continue
  uninterrupted. The recovery is manual deletion in the Connect web UI
  (no connect-delete-opportunity atom yet — see
  `skills/sweep-connect/SKILL.md § Implementation notes`) followed by
  `connect_create_opportunity` against canonical HQ ids + a
  `connect_opportunity_id` bookkeeping update in the current run's
  `run_state.yaml`. **Repointing the Connect opp pre-Phase-9 is
  therefore a low-cost recovery, not a destructive one.** Phase 9
  onboarding then targets the new opp UUID. Surfaced 2026-04-30
  (turmeric-20260429-2330) and re-confirmed cheaply 2026-05-07
  (turmeric-20260507-1733).

### Step 2.6: Generate app-test-cases.yaml

Invoke `app-test-cases` via `Skill(app-test-cases)` (or `/ace:step
app-test-cases <opp>/<run-id>` from a fresh session). **Do NOT compose
its outputs inline.** This skill's contract is multi-file: it emits a
master `3-commcare/app-test-cases.yaml` AND per-journey recipe files
(`3-commcare/recipes/journey-*.yaml`) which Phase 6's
`app-screenshot-capture` requires for pre-flight. An inline-composed
master file with no per-recipe siblings will halt Phase 6 at
pre-flight (real failure mode from turmeric run 20260509-0455). See
`agents/orchestrator-reference.md § Skill Invocation Discipline`.

- Reads: pdd-to-app-journeys.md, both app summaries, Nova blueprints
- Writes:
  - app-test-cases.yaml + recipes/journey-*.yaml under 3-commcare/recipes/
  - Appended `test-scenario-count`, `test-archetype-coverage` rows in `decisions.yaml` (merge-only; rows use `phase: 3-commcare` matching this dispatch site; bar criterion per `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`).
- Halts on missing inputs or recipe-validation failure

Phase 6 shallow runs the smoke recipes; /ace:qa-deep runs them all.

This step runs **after** `app-deploy` (so the Nova blueprints are
finalized and the HQ ids are stable) and **before** `app-release` (so
the recipes are in place by the time Phase 6 needs them, and so the
journey-to-form bindings are captured against the apps as built — not a
later re-build). Nova builds are uploaded via `app-deploy`, so the
blueprint IDs we read here are the same ones the released CCZ will
carry; `app-release` is when we can no longer rebuild the apps cheaply,
so it's the natural cutoff for "the apps are now what they are."

### Step 2.65: Apply HQ-layer standing-instruction settings

Invoke the `app-hq-settings` skill. This applies the two HQ-layer
settings Nova cannot set at build time, directly on the deployed CCHQ
**draft** apps:

1. **Camera-only photo capture** (Deliver only, PDD-conditional) — adds
   `appearance="acquire"` to every image `<upload>` control so the
   on-device widget hides the CHOOSE IMAGE gallery button
   (dimagi-internal/ace#867).
2. **Grid menu display** (both apps) — sets every module's menu display
   style to grid.

- Inputs:
  - `3-commcare/app-deploy_summary.md` (HQ app ids for Learn + Deliver)
  - `1-design/idea-to-pdd.md` (whether the PDD demands camera-only capture)
  - `phases.commcare-setup.residuals[]` (the camera-only + grid entries it resolves)
  - `ACE_HQ_USERNAME` / `ACE_HQ_API_KEY` (so `run-form-walk` can overlay
    draft `form_unique_id` + `module_unique_id` — issue #108)
- Outputs:
  - `3-commcare/app-hq-settings_summary.md` (forms patched, modules
    gridded, residuals resolved, follow-ups)
  - Cleared `phases.commcare-setup.residuals[]` entries for camera-only
    + grid (removed once applied; audit trail in the summary)

**Position rationale — AFTER `app-deploy`, BEFORE `app-release`.** The
settings live on the CCHQ **draft** app document; all three atoms
(`commcare_patch_xform`, `commcare_set_menu_display`,
`commcare_set_app_menu_display`) mutate the draft
only. `app-release` (Step 2.7) is what makes the versioned build and
releases it, so the draft mutations MUST land before it — otherwise the
released CCZ carries the pre-flip (gallery-permitting, list-menu) state.
`app-release-qa` (Step 2.8) is the structural backstop that re-verifies
`appearance="acquire"` (#867) and grid from the released suite.xml + form
XML — it will BLOCK if these settings didn't take, so this step must run
first. It also runs after `app-test-cases` (Step 2.6) because that step
captures journey-to-form bindings against the apps as built, and this
step's XForm patches don't change form structure (they add an appearance
hint), so the bindings stay valid.

- **Best-effort on this initial rollout — does NOT halt Phase 3.** This step
  is newly added and not yet live-validated end to end. On ANY failure —
  `run-form-walk` reports `form_unique_id_source: 'suite_xml'` (no HQ API creds
  → draft uids unavailable, both per-form/per-module atoms reject); any
  `commcare_patch_xform` / `commcare_set_menu_display` /
  `commcare_set_app_menu_display` error; or a conflicting non-`acquire` appearance
  / unexpected `<case>` block on a form being patched (Vellum-cache guard) —
  the skill records the failure in its summary, LEAVES the affected
  `residuals[]` entry in place (un-cleared), and the agent CONTINUES to
  `app-release` (Step 2.7). Do NOT halt Phase 3. Rationale: a failed auto-apply
  degrades to exactly today's behavior — the manual-flip residual stays open and
  `app-release-qa`'s #867 check surfaces it at Step 2.8 — so a bug here is a
  no-op, never a regression. Once this step is live-validated across real runs,
  tighten to halt-on-error.

**Residual resolution.** On clean completion the skill CLEARS (removes) the
camera-only + grid `phases.commcare-setup.residuals[]` entries. Phase 6
(`qa-and-training`) treats a residual as open by its **presence** (no `status`
field), so resolution means removal — the audit trail is preserved in
`app-hq-settings_summary.md`, not in the array. Only entries whose toggle was
actually applied this run are removed; `app-release-qa` (Step 2.8)
independently re-verifies the released CCZ. If the app-root "Modules Menu
Display" grid proves to need a separate app-level flag, the skill records it as
a `follow-up` (NOT a cleared residual); the atom deliberately does not invent
that endpoint.

### Step 2.7: Release Apps
Invoke the `app-release` skill.
- Input: HQ app ids from `3-commcare/app-deploy_summary.md`
- Output: each app has a new released build; Connect's `Sync Deliver Units`
  can now read the form schema. Without this step, Phase 4
  (`connect-opp-setup`) creates the opp shell but cannot configure
  payment units (deliver-units list comes back empty).
- **Prerequisite:** the user backing `ACE_HQ_USERNAME` needs a role with
  `edit_apps` on the target project space; the standard `Admin` role
  includes it. The skill includes an empirical probe procedure for the
  underlying CCHQ endpoints — they're internal UI routes, not stable
  public APIs.
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `app-release-eval` after release. Writes
  `3-commcare/app-release-eval_verdict.yaml`.

Note: the `app-test` skill was retired in the shallow/deep QA split
(0.11.10). Phase 3's QA contribution is now Step 2.6's
`app-test-cases.yaml`; the actual smoke runs happen in Phase 6
(`app-screenshot-capture`) and the deep grading runs from
`/ace:qa-deep` (`app-ux-eval`). Spec:
`docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md`.

Note: `training-materials` no longer runs in Phase 3. As of 0.9.0 it lives
in Phase 6 (`qa-and-training`), where it consumes the screenshots produced
by `app-screenshot-capture` alongside the app summaries.

### Step 2.8: CommCare CCZ structural smoke

Invoke the `app-release-qa` skill. This step is a lightweight,
AVD-free structural check on the just-released Learn + Deliver CCZs:
download each via `commcare_download_ccz`, parse the zip + suite.xml +
form XMLs, and verify form counts + Connect-marker presence match the
Nova blueprint. Halts loud on mismatch.

**Position rationale.** Prior versions of this file tried to put
`app-screenshot-capture` (a full AVD smoke walk) at the end of Phase
3 to surface recipe-authoring + AVD infrastructure failures at the
source. That move was reverted because the live AVD smoke requires a
Connect opportunity + ACE-test-user invite (Phase 4 outputs); Phase 3
is upstream of those preconditions. `app-release-qa` is a tighter
CommCare-side-only check that DOES belong here: it catches
CCZ-marker drops, form-count drift vs. Nova blueprint, and XForm
parse errors that would otherwise only surface in Phase 4's Connect
Sync Deliver Units or Phase 6's `app-screenshot-capture`. Full AVD
smoke stays in Phase 6 where Connect state is available.

- Inputs:
  - `3-commcare/app-deploy_summary.md` (HQ app ids + released build ids)
  - Nova `get_app({app_id})` blueprints for each app (for the structural cross-reference)
- Outputs:
  - `3-commcare/app-release-qa_result.yaml` — structural verdict
- **Halts loud on structural mismatch.** Per
  `skills/app-release-qa/SKILL.md § Step 4`, any of:
  - Released CCZ download fails or yields non-zip bytes
  - Form count in released CCZ doesn't match Nova blueprint form count
  - Any Learn quiz form is missing `<learn:assessment>` or any Learn
    content form is missing `<learn:module>` (Nova maintainer #7
    closure: these wrappers are REQUIRED for Connect's sync)
  - Deliver form `du_poc_visit` missing `<learn:deliver>` namespace
  - XForm XML in any form fails to parse via stdlib ElementTree

  …is a `[BLOCKER]`. The skill writes a structured verdict with the
  specific mismatch class so the operator can decide whether to
  re-run `app-release` (transient build issue) or re-run
  `pdd-to-{learn,deliver}-app` (Nova emitted a structurally broken
  build).

**Why this is honest scope.** `app-release-qa` does NOT verify
the apps install + launch on a real device — that's the AVD smoke
in Phase 6 (`app-screenshot-capture`). What it DOES verify is that
the released CCZ artifact carries the structural markers Connect's
HQ→Connect sync requires. The single failure mode this catches in
isolation is "Nova built fine, validate_app passed, build released,
but a downstream consumer (Connect Sync or AVD runtime) finds the
released CCZ structurally broken" — historically the canonical
trigger for `commcare-form-patch` regressions (now removed; this
step exists in part as the structural watcher that would have caught
the form-patch over-stripping incident at Phase 3 instead of Phase 6).

### Completion
Write phase summary to `ACE/<opp-name>/runs/<run-id>/3-commcare/commcare-setup_summary.md`,
then write the `phases.commcare-setup` block per `agents/orchestrator-reference.md
§ Phase Write-Back Contract`. Phase 3 is a procedure doc executed by the
top-level orchestrator session inline (see § Agent Topology), so the
orchestrator owns this write. Required top-level keys on the patch:
`phases`, `last_actor`, `last_actor_at`. (0.13.116: legacy `gates.app-deploy`
flip dropped — derived from phases.commcare-setup.status + per-skill verdicts.)

**Residuals are first-class state, not build-memo prose
(dimagi-internal/ace#867).** Any deferred manual step this phase records
in its summary / build memo — "needs HQ app-builder flip" (e.g. the
camera-only photo `appearance="acquire"` toggle), post-export toggles —
MUST also be written to `phases.commcare-setup.residuals[]` in the same
write-back, one entry per deferred step:

```yaml
residuals:
  - what: "camera-only photo capture — flip appearance to acquire on the Deliver photo upload question"
    where_to_apply: "HQ app builder → <deliver app> → <form> → photo question → appearance"
    verifiable_by: "app-release-qa camera-only check (image <upload> carries appearance containing 'acquire' in the released CCZ)"
```

A build-memo note alone is write-once and gets lost: on
hh-poverty-targeting/20260702-1456 the camera-only flip sat in the
build-memo prose ("camera-only photo + Grid menu-display need HQ
app-builder flip"), was never performed, and Phase 6 shipped training
materials contradicting the live app. Downstream phases read
`residuals[]` as standing state (Phase 6's pre-flight surfaces open
residuals and blocks dependent training-material claims — see
`agents/qa-and-training.md § Pre-flight checklist`). Clear an entry only
after the step has been performed AND re-verified via its
`verifiable_by`.

#### Verdict-gate rule for `-eval` skills (since 0.13.207)

The skills frontmatter declares which producers have a paired `-eval`
skill (`has_judge: true` rows). Three of those — `pdd-to-learn-app-eval`,
`pdd-to-deliver-app-eval`, `app-release-eval` — historically ran
`status: deferred` in `/ace:run`, meaning the phase verdict landed on
`pass` while the LLM-as-Judge content quality had not been graded.

That pattern bit Phase 2 on turmeric run 20260513-0616 — the
(then-active, since-deleted) `commcare-form-patch` over-stripping bug
shipped to a `verdict: pass` phase because nothing in the inline run
looked at the released CCZ's structural state. The lesson generalizes:
eval verdicts are not the right tool for catching CCZ-marker drops,
that's a structural assertion. The general principle holds:

**Do NOT set `phases.commcare-setup.verdict: pass` when any
`has_judge: true` skill has `steps.<skill>-eval.status: deferred`.**

**And the same for PRODUCERS: do NOT set `status: done` / `verdict:
pass` when any declared producer step in this phase was skipped or
parked** (e.g. `app-test-cases` deferred via a `remaining_steps` note —
no `3-commcare/app-test-cases.yaml`, no `recipes/journey-learn.yaml`).
A skipped producer is a bigger hole than a deferred eval: the eval
grades quality, but the producer's artifacts are load-bearing inputs
downstream (Phase 6's pre-flight hard-halts on a missing Learn smoke
recipe). If a producer step did not ship its declared artifacts, the
write-back is `status: partial` with a verdict naming the unshipped
step (e.g. `partial-producer-deferred`), and the artifact fence
(`verify_phase_artifacts`) will flag the missing required files —
including `recipes/journey-learn.yaml`, registered required in
`lib/artifact-manifest.ts` (ace#892).

`partial` is a **legal, terminal** phase status — `validate_run_state`
accepts it and `classify_phase_writeback` returns `ok` (terminal, not a
retry trigger), so writing it does NOT cost a phase re-dispatch. Full
enum + the three-fence table:
`agents/orchestrator-reference.md § Phase Write-Back Contract §
`partial`: a phase that shipped but parked something`. Three things a
`partial` write-back owes:

- **Name the gap in `verdict`** (`partial-producer-deferred`,
  `partial-evals-skipped`, …) and, ideally, in a `status_note`.
- **Mark the parked step** `status: incomplete` (or `partial` — a
  synonym at step level). Do not leave it `done`.
- **Still write the complete `products` block.** `partial` may park
  ARTIFACTS; it may never park the typed handoff downstream phases read
  (`apps.learn.hq_app_id`, `apps.deliver.hq_app_id` for this phase).
  `verify_phase_products` runs its STRICT check on a `partial` phase. If
  the parked producer owns one of those keys, the honest status is
  `blocked`, not `partial` — downstream genuinely cannot proceed.

(Do not write `status: complete` — it is accepted as a legacy synonym
for `done` but warns, and it is the wrong word here regardless.)

For the EVAL half, either:

- **Run the eval inline** (preferred — write the verdict to
  `<phase>/<skill>-eval_verdict.yaml` and gate the phase on its
  verdict). The orchestrator's Per-Step Eval Hook is supposed to do
  this automatically; if it didn't, the phase write-back's `status`
  should be `partial` (not `done`) and `verdict` should be
  `passed-with-deferred-evals` (not `pass`).
- **OR explicitly opt out** via a top-level `--no-evals` flag on
  `/ace:run` (operator-asserted decision), in which case the phase
  status reflects the opt-out (`verdict: partial-evals-skipped`).

The legacy `status: deferred + rationale: backfill via /ace:eval --all`
shape is still useful for opp-level retroactive grading, but it MUST
NOT coexist with `verdict: pass` in the same write-back.
Catch this in the Phase Write-Back Verifier — if any step in the
phase has `status: deferred` on a `has_judge: true` producer, downgrade
the verdict to `partial` before writing. (Pre-0.13.116 this was framed
as "flip `gates.commcare-setup` to `partial`"; gates removed —
`phases.commcare-setup.verdict` carries the same signal now.)

This rule applies to every phase agent, not just `commcare-setup`. The
canonical implementation is the Phase Write-Back Verifier procedure in
`agents/orchestrator-reference.md`; this file documents the contract
for the procedure-doc form of the agent (Phase 2 / Phase 3).
