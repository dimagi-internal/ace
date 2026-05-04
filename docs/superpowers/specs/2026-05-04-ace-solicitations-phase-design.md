# ACE Solicitations Phase — Design

**Status:** Draft
**Date:** 2026-05-04
**Author:** ACE
**Related:** [`docs/superpowers/specs/2026-04-28-ace-connect-mcp-design.md`](2026-04-28-ace-connect-mcp-design.md) (the sibling MCP that this work does **not** extend), [`playbook/integrations/connect-api.md`](../../../playbook/integrations/connect-api.md), connect-labs `commcare_connect/mcp/` source, connect-labs `user_docs/solicitations.md`

## Problem

Today ACE's lifecycle assumes the PDD already names which LLO will run an opportunity. Phase 6 (`llo-management`) opens with an `llo-invite` skill that builds a candidate roster from the PDD's preferred-LLO list and pushes the opportunity directly to those orgs.

That assumption holds for the early dogfood opps but does not hold long-term. The product direction is: **ACE always asks LLOs to fill out a solicitation before being awarded an opportunity**. We won't know who the LLO is until a solicitation closes and a winner is awarded. Even when we *do* know who we want short-term, we want them to go through the solicitation flow as a functional test of the path real LLOs will take.

The current pipeline can't represent that:
1. There is no place in the agent topology where a solicitation is published.
2. The Connect API surface ACE talks to (`connect.dimagi.com` via `ace-connect`) does not own solicitations — they live in Connect Labs at `labs.connect.dimagi.com`, a separate Django deployment.
3. Phase 6's `llo-invite` is wired to push opportunities directly to a known roster, not invitations to a public solicitation.

## Goal

Insert a new **Phase 6 — Solicitation Management** between Phase 5 (qa-and-training) and the existing LLO-management work. Renumber: existing Phase 6 becomes Phase 7 (renamed **Execution Management**); existing Phase 7 becomes Phase 8 (Closeout, unchanged).

Phase 6 publishes a solicitation derived from the PDD, optionally invites PDD-named LLO candidates to the solicitation by email, and stops there in default `/ace:run` mode. The review-and-award lifecycle continues via manually-invoked skills, gated by a hard human-in-the-loop checkpoint before the irreversible `award_response` call.

Phase 7 (Execution Management) consumes the awarded org from `opp.yaml` and proceeds with onboarding, UAT, go-live, and recurring monitoring — the same skills it has today, minus `llo-invite` (moved to Phase 6).

**Non-goals:**
- Extending `ace-connect` with solicitation atoms. Solicitations live in connect-labs; ACE consumes the existing remote MCP at `labs.connect.dimagi.com/mcp/` rather than re-implementing the surface.
- Auto-awarding. The award call (`award_response`) writes a fund allocation and is irreversible from ACE's perspective; it stays HITL.
- A migration path for in-flight opps' `run_state.yaml` files. Operations gate: finish in-flight opps on the old code, then merge.

## Phase topology

```
1. design-review            (unchanged)
2. commcare-setup           (unchanged)
3. connect-setup            (unchanged)
4. ocs-setup                (unchanged)
5. qa-and-training          (unchanged)
6. solicitation-management  ← NEW
7. execution-management     ← was llo-management (Phase 6)
8. closeout                 (was Phase 7)
```

**Agent forms** (per the level-0 dispatch invariant in `CLAUDE.md` § Agent topology):
- `solicitation-management` is a **subagent** (does not call `Agent`). Same shape as `ocs-setup`, `qa-and-training`, `closeout`. Dispatched by `ace-orchestrator` (the existing procedure doc) via `Agent(solicitation-management)` from level 0.
- `execution-management` is a subagent (rename of `llo-manager`).
- No procedure-doc agents added.

**Pause-points (updated `pause-points` framework in `ace-orchestrator.md`):**
- Phase 5 → 6: no longer a mandatory pause. The CLAUDE.md prose flagging Phase 5→6 as "always pause / external-communication boundary" moves to Phase 6→7.
- **Phase 6 runs autonomously start to finish** (publish solicitation + send invites). No internal HITL gate.
- Phase 6 → 7: **the new external-communication boundary**. `/ace:run` halts here in default mode. Phase 7 will not start until `opp.yaml.selected_llo.org_slug` is populated, which only happens via the manual `solicitation-review` skill.
- After `solicitation-review`: HITL gate before `award_response` is called. (Manual flow only — not in default `/ace:run`.)
- Phase 7 internal pauses (`llo-launch`) unchanged.

## Architecture & MCP integration

**ACE consumes the existing remote `connect_labs` MCP.** It already exposes solicitation, response, review, and fund tools (verified live in `connect-labs/commcare_connect/mcp/tools/solicitations.py`). No new MCP server, no new atoms in `ace-connect`.

**Plugin manifest entry** (`/.claude-plugin/plugin.json`, under `mcpServers`):

```jsonc
"connect_labs": {
  "type": "http",
  "url": "https://labs.connect.dimagi.com/mcp/",
  "headers": {
    "Authorization": "Bearer ${LABS_MCP_TOKEN}"
  }
}
```

**Implementation hedge.** Whether `${LABS_MCP_TOKEN}` substitution works in `mcpServers.headers` is uncertain — `CLAUDE.md` documents historical breakage with `${CLAUDE_PLUGIN_DATA}` / `${CLAUDE_PLUGIN_ROOT}` substitution in plugin-root `.mcp.json` (worked around by inlining in `plugin.json` since 0.5.16). The plan step that wires this up should test the substitution path first; if it doesn't work, fall back to reading `LABS_MCP_TOKEN` from `${CLAUDE_PLUGIN_DATA}/.env` at MCP-server-startup time and injecting the header in code, mirroring how `ace-ocs` already handles credentials.

**Auth is Bearer PAT.** Verified by reading `connect-labs/commcare_connect/mcp/auth.py`: the endpoint expects `Authorization: Bearer <raw_token>` against the `MCPAccessToken` Django model. There is no OAuth on the wire today. The OAuth bridge described in connect-labs documentation is a *backend* call chain — once the PAT identifies the labs user, individual tool handlers call `require_connect_token(user)` to look up *that user's* stored Connect access token and use it server-to-server. ACE's responsibility is the PAT only.

**One-time setup.** A labs admin (or a labs user with shell access) runs:

```bash
python manage.py mcp_create_token --user ace@dimagi-ai.com --name ACE-plugin --ttl-days 0
```

The raw token is dropped into the 1Password item `op://Dimagi/labs-mcp-pat-ace/credential`. The labs `ace@dimagi-ai.com` account must also have completed Connect OAuth linkage at least once (so `require_connect_token(user)` succeeds inside tool handlers).

**`.env.tpl` adds one line:**

```
LABS_MCP_TOKEN=op://Dimagi/labs-mcp-pat-ace/credential
```

**`/ace:setup` does not grow an interactive flow.** ACE is a service identity; one long-lived PAT (`--ttl-days 0`) injected via `op inject` is the right shape. Connect-labs's interactive `labs-token-setup` skill is built for individual humans and is not vendored.

**`/ace:doctor` adds a `[Connect Labs]` section** with three checks:

1. `connect_labs_env` — `LABS_MCP_TOKEN` present and non-empty in installed `.env`. Same drift-detection pattern as the existing `[Connect]` section.
2. `connect_labs_mcp_reachable` — `POST` an `initialize` JSON-RPC frame with the PAT. 200/204 = OK; 401 = PAT bad; 5xx/timeout = labs is down. Class-level preventer against silent labs outages.
3. `connect_labs_connect_oauth` — `tools/call` the `list_solicitations` atom with no filter args (or the smallest possible page). Distinguishes (a) PAT-level 401 (HTTP transport rejects the bearer) from (b) HTTP 200 with a tool-level `PERMISSION_DENIED` envelope raised by `require_connect_token`. Each surfaces a different fix path. Mirrors the 0.7.1 `ocs_shared_collection_team` probe in spirit.

**Atom inventory ACE consumes** (names match `@register(name=...)` in `connect-labs/commcare_connect/mcp/tools/solicitations.py` and `tools/reviews.py`):

| Atom | Used by skill | Notes |
|---|---|---|
| `create_solicitation` | `solicitation-create` | publishes in one shot |
| `list_solicitations` | `solicitation-monitor` | idempotency check |
| `get_solicitation` | `solicitation-monitor`, `solicitation-review` | |
| `update_solicitation` | reserved | future: extend deadline |
| `list_responses` | `solicitation-monitor`, `solicitation-review` | |
| `get_response` | `solicitation-monitor`, `solicitation-review` | |
| `award_response` | `solicitation-review` (post-HITL) | irreversible |
| `create_review` | `solicitation-review` | per-criterion scoring |
| `list_reviews` | `solicitation-review` | dedupe before re-scoring |
| `generate_criteria` | `solicitation-create` | AI-derived rubric from PDD scope text |

**Atoms ACE explicitly does not use:** `fund_*` (out of scope), `create_response` (responses come from real LLOs, not ACE).

## Data contract

### PDD → solicitation field mapping

`solicitation-create` builds the payload from the existing PDD plus three new optional fields surfaced by Phase 1 `idea-to-pdd`:

| Solicitation field | Source | Notes |
|---|---|---|
| `title` | PDD `title` + archetype | e.g. `"EOI: Vaccine Hesitancy FLW pilot — atomic-visit"` |
| `solicitation_type` | new PDD field `solicitation_type: EOI \| RFP` | default `EOI` |
| `description` | PDD `intervention_summary` + `target_flw_profile` | full prose |
| `scope_of_work` | PDD `visit_structure` + `success_criteria` | what the LLO must execute |
| `budget` | PDD `total_budget` | already used by Connect opp setup |
| `deadline` | new PDD field `solicitation_deadline_days: int` | default 14; Phase 6 computes `now() + N` |
| `evaluation_criteria` | derived via `generate_criteria` | structured rubric (criteria + weights), then included in payload |
| `response_template` | PDD `llo_questions` (new field) | falls back to a default 6-question template |
| `status` | hardcoded `published` | ACE always publishes |

The three new PDD fields (`solicitation_type`, `solicitation_deadline_days`, `llo_questions`) are **additive and optional**. Existing PDDs without them fall through to defaults; no breaking change to the PDD template.

### `opp.yaml` (opp-level, persists across runs)

```yaml
solicitation:
  solicitation_id: 1247
  public_url: https://labs.connect.dimagi.com/a/dimagi/solicitations/1247/
  manage_url: https://labs.connect.dimagi.com/a/dimagi/solicitations/1247/edit/
  type: EOI
  published_at: 2026-05-04T18:22:00Z
  deadline: 2026-05-18T23:59:59Z
  status: open                          # open | closed | awarded | failed
  awarded:
    response_id: null
    awarded_at: null
    awarded_org_slug: null
    awarded_org_name: null
    awarded_contact_email: null
    award_amount: null

selected_llo:                           # narrow contract Phase 7 reads
  org_slug: null
  contact_email: null
  source: null                          # 'solicitation' (only path today; reserved for future alternates)
  response_id: null
```

`solicitation` is the audit trail. `selected_llo` is the stable, narrow contract Phase 7 reads. They are separate so a future alternate selection path (e.g. closed-bid named-LLO mode) can populate `selected_llo` without producing fake `solicitation` metadata. Only `source: 'solicitation'` is implemented now — the field is included as a forward-compatibility hint.

### `run_state.yaml` (per-run)

The new phase appears as `phases.solicitation_management.<skill_name>: pending|complete|skipped`. Recurring `solicitation-monitor` invocations log under `phases.solicitation_management.solicitation_monitor.runs[]` like other recurring skills.

**Renames:**
- `phases.llo_management.*` → `phases.execution_management.*`
- `phase_6_backlog` (was llo-management bucket) → `phase_7_backlog`
- `phase_7_backlog` (was closeout bucket) → `phase_8_backlog`
- New `phase_6_backlog` for solicitation-management

No migration script. In-flight opps finish on the old code; new opps use the new schema.

### New artifact paths under `ACE/<opp>/`

```
ACE/<opp>/solicitation/
  draft.md                   # solicitation-create writes before publish
  published.md               # snapshot of submitted fields + URLs returned by labs
  invitations.md             # llo-invite writes: who got emailed, when, status
  responses/                 # solicitation-monitor writes one file per response
    <response_id>.md
  review/
    scoring-rubric.md        # solicitation-review writes per-response scores
    recommendation.md        # ranked candidates + reasoning, input to HITL gate
  award-record.md            # written when award_response is called (success or failure)
```

All registered in `lib/artifact-manifest.ts` (which skill produces, which skills consume).

## New skills (Phase 6)

Four skills under `skills/<name>/SKILL.md`. Two run automatically in default `/ace:run`; one is recurring; one is manual. All stateless per the convention in `skills/README.md`.

### `solicitation-create` (auto, default run)

**Inputs:** approved `ACE/<opp>/design/pdd.md`, `ACE/<opp>/opp.yaml` (program_id, total_budget).

**Steps:**
1. Map PDD fields to solicitation payload using the table above.
2. Call `connect_labs.generate_criteria` with PDD scope text; capture the structured rubric.
3. Write `ACE/<opp>/solicitation/draft.md` for traceability (the full payload + the AI-derived rubric).
4. Call `connect_labs.create_solicitation` with `status=published`.
5. Write `ACE/<opp>/solicitation/published.md` with `solicitation_id`, `public_url`, `manage_url`, deadline, criteria.
6. Update `opp.yaml.solicitation` block.

**Outputs:** `published.md`, `opp.yaml.solicitation.{solicitation_id, public_url, deadline, status: open}`.

**Eval companion:** `solicitation-create-eval` — provisional rubric. Mirrors `connect-program-setup-eval` shape. Grades PDD-fidelity (do scope/criteria match the PDD substance?), field completeness, deadline sanity. Calibrated per `eval-calibration` once 3+ real solicitations have shipped.

### `llo-invite` (auto, default run — moved from Phase 7, transformed)

**Behavior change:** previously identified PDD-named candidates and prepared a Connect-side invite roster. Now identifies the same candidates and emails each one a link to the public solicitation URL. **Makes no Connect API calls.** The Connect program-level invite (`connect_send_llo_invite`) is no longer this skill's responsibility — it fires only for the awardee inside `llo-onboarding`.

**Inputs:** `ACE/<opp>/design/pdd.md` (preferred LLOs), `opp.yaml.solicitation.public_url`.

**Steps:**
1. Read `preferred_llos` from PDD.
2. If empty: write `ACE/<opp>/solicitation/invitations.md` with `status: empty (long-term solicitation flow)`, exit successfully.
3. Otherwise: for each preferred LLO, send an email via `email-communicator` containing the solicitation URL, deadline, and scope summary.
4. Write `ACE/<opp>/solicitation/invitations.md` listing every recipient with send status (`sent | failed: <reason>`).

**Skill directory stays `skills/llo-invite/`** (name preserved per design discussion). Frontmatter `phase: solicitation-management`.

**No `llo-invite-eval` rubric.** The skill is a templated email sender; LLM-as-Judge grading is not load-bearing.

### `solicitation-monitor` (recurring while solicitation open)

**Trigger:** runs while `opp.yaml.solicitation.status == open`. Mirrors the recurring-skill pattern in current Phase 6 (`timeline-monitor`, `flw-data-review`, `ocs-chatbot-qa`).

**Inputs:** `solicitation_id`.

**Steps:**
1. Call `list_responses(solicitation_id)`. For each new response, call `get_response` and write `ACE/<opp>/solicitation/responses/<response_id>.md`.
2. Summarize inflow (count, time-to-deadline, no-response invitees if PDD-named LLOs exist).
3. Append a tick line to `comms-log/observations.md` per the canopy contract.

**Modes:** `--quick` (count only) vs `--monitor` (full pull). Mirrors `ocs-chatbot-qa --quick/--monitor`.

**No eval companion** initially. Read-only recurring skill.

### `solicitation-review` (manual, `/ace:step solicitation-review` only)

**Inputs:** `solicitation_id` + `responses/` directory.

**Steps:**
1. `list_responses` → for each, score against the rubric captured in `published.md` (LLM-as-Judge over each criterion).
2. Write `ACE/<opp>/solicitation/review/scoring-rubric.md` and `recommendation.md`.
3. Optionally call `create_review` for each response so labs has ACE's scores in the audit trail.
4. **HITL gate:** present `recommendation.md` and wait for explicit human approval of the awardee + amount.
5. On approval: call `award_response`. Write `ACE/<opp>/solicitation/award-record.md`.
6. Populate `opp.yaml.selected_llo` with `{ org_slug, contact_email, response_id, source: 'solicitation' }`.

**Outputs:** `review/` artifacts, `award-record.md`, `selected_llo` populated.

**Eval companion:** `solicitation-review-eval` — provisional. Compares ACE's top-ranked recommendation against the human's actual award decision over time (detection-rate metric). Calibrated per `eval-calibration` once 3+ awards have shipped.

## Phase 7 (Execution Management) changes

**Agent rename:** `agents/llo-manager.md` → `agents/execution-manager.md`.

Frontmatter: `name: execution-manager`, `phase: execution-management`, `phase_display: Execution Management`, `phase_ordinal: 7`. Description rewritten — Phase 7 is no longer "first LLO contact"; it is "execute the awarded LLO's run of the opportunity."

**Skill list inside Phase 7:**
- `llo-onboarding` — **modified**. Reads `opp.yaml.selected_llo`, fails fast with a "run /ace:step solicitation-review first" message if empty. Otherwise sends Connect program-level invite (`connect_send_llo_invite`) + ACE onboarding email to `selected_llo.contact_email`. Replaces the old roster-based flow.
- `llo-uat` — unchanged.
- `llo-launch` — unchanged.
- Recurring: `timeline-monitor`, `flw-data-review`, `ocs-chatbot-qa`, `ocs-chatbot-eval` — unchanged.

**Phase entry guard:** the orchestrator's pre-Phase-7 check enforces `opp.yaml.selected_llo.org_slug != null`. If empty, `/ace:run` halts at the 6→7 boundary with a message pointing to `solicitation-review`.

**Eval rubric updates:**
- `llo-launch-eval` — pure rename/renumber (Phase 6 → Phase 7 in references). No rubric content change.
- `cycle-grade-eval` — same.

## Renaming/renumbering blast radius

Concrete file touches:

**Agents (5 files):**
- `agents/ace-orchestrator.md` — phase order, pause-points, `phases:` block.
- `agents/connect-setup.md` — Phase 6/7 references.
- `agents/ocs-setup.md` — Phase 6/7 references.
- `agents/qa-and-training.md` — Phase 6/7 references; the "Phase 5→6 always pause" note moves.
- `agents/llo-manager.md` → renamed to `agents/execution-manager.md`.
- New `agents/solicitation-management.md`.

**Skills (6 files containing Phase 6/7 strings, plus moves and additions):**
- `skills/training-onboarding-email/SKILL.md` — Phase number references.
- `skills/training-deck-build/SKILL.md` — same.
- `skills/llo-launch-eval/SKILL.md` — phase ordinal.
- `skills/cycle-grade-eval/SKILL.md` — phase ordinal.
- `skills/connect-opp-setup/SKILL.md` — Phase 6 references.
- `skills/ocs-widget-handoff-eval/SKILL.md` — Phase 6/7 references.
- `skills/llo-invite/SKILL.md` — substantial rewrite + phase reassignment.
- New: `skills/solicitation-create/`, `skills/solicitation-monitor/`, `skills/solicitation-review/`, `skills/solicitation-create-eval/`, `skills/solicitation-review-eval/`.

**Library + tooling:**
- `lib/artifact-manifest.ts` — drop `connect-setup/invites.md`, add `solicitation/*` artifacts.
- `bin/ace-doctor` — phase health checks reference phase names; add `[Connect Labs]` section.
- `commands/run.md`, `commands/step.md` — `ace:llo-manager` → `ace:execution-manager`.
- `templates/pdd-template.md` — three new optional fields.
- `CLAUDE.md` — phase order list, pause-points prose, plugin overview.
- `README.md` — phase summary table if present.

**Config:**
- `.env.tpl` — `LABS_MCP_TOKEN` line.
- `.claude-plugin/plugin.json` — `mcpServers.connect_labs` entry.

Approximate count: ~25 files modified, 1 file renamed, 5 skill directories added, 0 deleted.

## Testing & evals

**Unit tests (vitest, default `npm test`):**
- `test/mcp/connect-labs/` — new directory. Mock the labs MCP transport; verify each consumed atom's request shape and response handling.
- `test/skills/solicitation/solicitation-create.test.ts` — fixture PDD → expected payload, mocked `create_solicitation`, verifies `published.md` + `opp.yaml` mutation.
- `test/skills/solicitation/solicitation-monitor.test.ts` — mocked `list_responses` returning N IDs, verifies one `responses/<id>.md` per ID, single observation-log append.
- `test/skills/solicitation/solicitation-review.test.ts` — mocked `list_responses` + `list_reviews`, verifies scoring rubric written, `award_response` not called pre-HITL, `selected_llo` populated only after approval.
- `test/skills/llo-invite/` — updated for new behavior (email send, no Connect call).

**Integration tests (`LABS_INTEGRATION=1`, hits live labs):**
- `test/mcp/connect-labs/integration/e2e.integration.test.ts` — end-to-end flow `create_solicitation` → `list_responses` → `get_response` → seeded test response → `create_review` → `award_response`. Authenticated by a CI-provisioned PAT in 1Password.
- Gated like `OCS_INTEGRATION` — does not run in default `npm test`.

**Fixtures:**
- New `test/fixtures/CRISPR-Test-004-Solicitation/` — PDD seeded with `solicitation_type: EOI`, `solicitation_deadline_days: 7`, two `preferred_llos`, `total_budget: 50000`. Used by both unit and (sanitized) integration tests. Registered in `test/fixtures/artifact-manifest.test.ts`.

**Eval rubrics (provisional, calibrated over time):**
- `solicitation-create-eval` — PDD-fidelity, field completeness, deadline sanity.
- `solicitation-review-eval` — recommendation-vs-actual-award detection rate.
- `opp-eval` umbrella aggregator — adds a `solicitation` category. Lifts the "full coverage" bar from 6 categories to 7.

## Error handling

**`solicitation-create`:**
- Labs MCP unreachable → halt with doctor-style error.
- `create_solicitation` returns 4xx → preserve `draft.md`, halt, surface error verbatim.
- `generate_criteria` returns degenerate output → write what was returned, mark `evaluation_criteria` as `needs-review` in `published.md`, still publish (criteria editable post-publish via labs UI without affecting responses).

**`llo-invite`:**
- Per-recipient email fails → log to `invitations.md` with `status: failed`, continue.
- All recipients fail → halt with surfaced error.
- PDD has no `preferred_llos` → no-op, `invitations.md: empty (long-term solicitation flow)`.

**`solicitation-monitor`:**
- Read-only; failures are non-fatal (log and skip this tick).

**`solicitation-review`:**
- HITL gate timeout → no award call, no state mutation.
- `award_response` 4xx after approval → write `award-record.md` with `status: failed` and the error envelope; **do not** populate `selected_llo` (Phase 7 stays gated). Hard-deduct in eval rubric for any path that sets `selected_llo` when the award did not succeed.

## Future work (out of scope)

- **OAuth-on-the-wire for the labs MCP.** Connect-labs `CLAUDE.md` flags this as planned. When it ships, swap the `headers.Authorization` block for `auth: { type: oauth }` — single-PR migration.
- **Auto-award.** Once `solicitation-review-eval` is calibrated and detection-rate is high enough, an opt-in auto-award path becomes defensible. Not now.
- **`connect_labs.update_solicitation`-driven extend-deadline skill.** When monitoring detects low response rate, auto-extend the deadline once with notification. Reserved atom; no skill yet.
- **`solicitation-monitor` proactive nudge.** When PDD-named candidates haven't responded by N days before deadline, send a reminder email. Trivial extension of `email-communicator` once we see real solicitation data.
- **Labs-side improvements** to make service-account integration cleaner — see appendix.

## Appendix A — Prompt to hand to connect-labs

Paste verbatim into a Claude Code session in `~/emdash/repositories/connect-labs/`:

> **Make labs MCP easier to integrate for service-account / plugin clients (e.g. ACE).**
>
> Context: external Claude Code plugins (specifically `ace`, which lives in a sibling repo at `~/emdash/repositories/ace/`) want to call labs MCP tools — `create_solicitation`, `list_responses`, `award_response`, `create_review`, etc. — under a single service identity (`ace@dimagi-ai.com`), not per-developer tokens. The current PAT path works but has three rough edges that compound for service-account use.
>
> 1. **Self-serve service-account PATs.** Today `python manage.py mcp_create_token` requires shell access to a labs host or admin action. For service identities (where one PAT serves N developer machines and N CI runs), a self-serve UI gated by a specific role/permission would let the owning team rotate without filing a ticket. Spec: a labs UI page `/admin/mcp/tokens/` (or non-admin equivalent) where a user with `is_staff` or a new `mcp.create_service_token` perm can create a PAT for a target user, set TTL, and copy the raw value once. This already half-exists in the admin (`/admin/mcp/mcpaccesstoken/`); the gap is a non-admin route + UX for "create + copy raw token".
>
> 2. **Expose an MCP atom that returns token metadata for the current bearer.** Something like `whoami` returning `{ user, token_name, created_at, expires_at, last_used_at }`. Service-account clients (like ACE's `/ace:doctor`) would call this to detect upcoming expiry and warn at 30/14/7-day boundaries. Today the only signal of expiry is a 401 at use-time, which is too late.
>
> 3. **Distinguish "PAT bad" from "Connect OAuth missing" in error envelopes.** When a tool handler calls `require_connect_token(user)` and the user hasn't completed Connect OAuth linkage, the client gets a 200 with a tool-level `PERMISSION_DENIED`. When the PAT itself is bad, the client gets a 401. Both states are "fix your auth" but the *fix path* is different (rotate PAT vs. re-do Connect OAuth in labs UI). Surface the distinction explicitly: a stable error code per state in the JSON envelope (`AUTH_TOKEN_INVALID` vs `CONNECT_OAUTH_REQUIRED`), and ideally a `connect_oauth_url` field in the latter so clients can deep-link the user to fix it.
>
> 4. **Stretch: OAuth 2.1 on the wire.** CLAUDE.md flags this as planned for a later phase. Anyone who wants to prioritize it: ACE would swap a one-line config (`headers.Authorization: Bearer ...` → `auth: { type: oauth }`) and drop the PAT entirely. The earlier this ships, the less long-term PAT inventory there is.
>
> Pick whichever of (1)–(3) has the lowest cost-to-impact ratio first. (2) is probably the cheapest and unblocks the most concrete operator pain.
