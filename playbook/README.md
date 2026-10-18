# Playbook — how do I do X on surface Y

This is the index for **acting on the platforms ACE integrates with**. It covers building
a new program and changing a live one. Pipeline procedure lives elsewhere: phases in
`agents/`, steps in `skills/`. This directory holds the platform facts both of those rely
on. When you need to change something on Connect, CommCare HQ, Nova, OCS or Labs, start
here, whether or not ACE built it.

Atom signatures are never paraphrased here. For ACE's own MCPs, grep the generated
[`docs/atom-schemas.md`](../docs/atom-schemas.md). For connect-labs, which is served
upstream, load the live schema with `ToolSearch "select:mcp__connect_labs__<atom>"`.

## Surfaces

| Surface | Doc | Atoms | Upstream repo |
|---|---|---|---|
| Connect (programs, opportunities, payment units, invites) | [`integrations/connect-api.md`](integrations/connect-api.md) | `docs/atom-schemas.md` § ace-connect (`connect_*`) | `dimagi/commcare-connect` |
| CommCare HQ (project spaces, builds, releases, users, lookup tables) | [`integrations/commcare-api.md`](integrations/commcare-api.md) | `docs/atom-schemas.md` § ace-connect (`commcare_*`) | `dimagi/commcare-hq` |
| HQ case sharing by location | [`integrations/hq-case-sharing.md`](integrations/hq-case-sharing.md) | `commcare_*` user + location atoms | `dimagi/commcare-hq` |
| Nova (authoring CommCare apps) | [`integrations/nova-integration.md`](integrations/nova-integration.md) | the `nova` MCP (`mcp__nova__*`) | `voidcraft-labs/commcare-nova` |
| Open Chat Studio (chatbots, knowledge) | [`integrations/ocs-integration.md`](integrations/ocs-integration.md) | `docs/atom-schemas.md` § ace-ocs (`ocs_*`) | `dimagi/open-chat-studio` |
| Connect Labs (solicitations, synthetic data, workflows, registry, supply chain) | [`integrations/connect-labs.md`](integrations/connect-labs.md) | live `tools/list` (`mcp__connect_labs__*`) | `dimagi-internal/connect-labs` |
| Mobile (emulator, Maestro recipes, test workers) | [`integrations/mobile-integration.md`](integrations/mobile-integration.md) | `docs/atom-schemas.md` § ace-mobile (`mobile_*`) | — |
| Google Slides | [`integrations/slides-integration.md`](integrations/slides-integration.md) | `docs/atom-schemas.md` § ace-gdrive (`slides_*`) | — |
| canopy-web (board, mailbox, capabilities) | [`integrations/canopy-web.md`](integrations/canopy-web.md) | the `canopy-web` MCP | `dimagi-internal/canopy-web` |
| External source material | [`integrations/external-sourcing.md`](integrations/external-sourcing.md) | — | — |
| Work order template | [`integrations/work-order-template.md`](integrations/work-order-template.md) | — | — |

Running a whole `/ace:run` alongside canopy's improvement loop:
[`opp-run-with-canopy.md`](opp-run-with-canopy.md).

## Common operations

These cover build and maintain tasks. "Limits" names what is not possible or not yet
verified, so check it before promising a change.

| Task | Surfaces | Where | Atoms | Limits / issue |
|---|---|---|---|---|
| Build a new program end to end | all | `/ace:run` (`agents/ace-orchestrator.md`) | — | — |
| Edit a deployed app and ship the new version | Nova → HQ → Connect | `nova-integration.md` § Uploading to HQ updates in place; `commcare-api.md` § Builds and releases; `connect-api.md` § Changing a live opportunity | `/nova:edit`, `upload_app_to_hq`, `commcare_make_build`, `commcare_release_build` | Re-apply HQ settings after every re-upload. **Whether a live opp picks up the release is UNVERIFIED** |
| Re-release an existing HQ app | HQ | `commcare-api.md` § Builds and releases; `skills/app-release` | `commcare_make_build`, `commcare_release_build` | `make_build` versions the HQ draft, not Nova (ace#1643) |
| Change verification flags on a live opp | Connect | `connect-api.md` § Changing a live opportunity | `connect_set_verification_flags` | PM-org URL only |
| Add a payment unit | Connect | same | `connect_create_payment_units` | Needs an unbound deliver unit (ace#573) |
| Change or delete a payment unit | Connect | same | **none** | Not possible from ACE; use the Connect UI |
| Change the Learn passing score | Connect | `connect-api.md` § Learn `passing_score` | `connect_set_learn_passing_score` | Shared by every opp in the holding org on that Learn app (ace#1350) |
| Change opp dates, budget, description, active | Connect | `connect-api.md` § Changing a live opportunity | `connect_update_opportunity` | Holding org is create-time only; 50-char traps |
| Add an LLO / a partner opportunity to an existing program | Connect + HQ | `connect-api.md` § Changing a live opportunity; `skills/llo-onboarding` | `connect_send_llo_invite`, `connect_accept_program_application`, `commcare_linked_app_copy`, `connect_create_opportunity` | Capture the application UUID from the invite POST |
| Invite / remove workers | Connect | `connect-api.md` | `connect_send_flw_invite`, `connect_delete_unaccepted_flw_invites` | Opp must be active |
| Read worker progress / visit data | Connect + Labs | `connect-api.md`; `connect-labs.md` § Semantic registry, explorer | `connect_get_deliver_progress`, `explorer_describe`, `explorer_query` | `explorer_query` returns rows only for synthetic opps through canopy |
| Refresh a bot's knowledge and republish | OCS | `ocs-integration.md` § Changing a live bot; `skills/ocs-knowledge-refresh` | `ocs_upload_collection_files`, `ocs_wait_for_collection_indexing`, `ocs_publish_chatbot_version` | Readers see only the published version |
| Update a bot's prompt, description or tools | OCS | `ocs-integration.md` § Changing a live bot | `ocs_set_chatbot_system_prompt` / `_description` / `_tools` → publish | Re-run a quick QA after |
| Share a bot | OCS | `ocs-integration.md` | `ocs_ensure_public_link` | Never regenerate a sent link; no Connect widget field (CCC-301) |
| Edit a solicitation (deadline, text, visibility) | Labs | `connect-labs.md` § Changing live labs objects | `update_solicitation` | Non-public reads need `program_id` |
| Seed responses / award a response | Labs | `connect-labs.md` § Solicitations | `create_response`, `award_response` | Award is irreversible and may email the awardee (ace#3146) |
| Point a labs workflow at other opportunities | Labs | `connect-labs.md` § Changing live labs objects | `workflow_update_opportunity_ids` | Rebuild history afterwards |
| Freeze or refollow template-driven report pages | Labs | `connect-labs.md` § Workflow template lifecycle | `workflow_follow_template`, `scripts/labs-report-templates.ts` | Refollow only pages nobody relies on as a record |
| Simulate N weeks of a program | Labs | `connect-labs.md` § History (simulated time) | `synthetic_generate_from_manifest`, `workflow_preview_as_of`, `workflow_rebuild_history` | No clock; backdate data |
| Procurement / stock | Labs | `connect-labs.md` § Supply chain | `supply_chain_*` | Skills being added |
| Case sharing between workers | HQ + Nova | `hq-case-sharing.md`; `skills/app-case-sharing` | `commcare_*` location + user atoms | — |
| Grant someone access to review | all | `skills/share-run-access` | `connect_add_org_member`, `ocs_add_team_member`, … | Role, not just membership (CLAUDE.md § Gotchas) |

## Learnings by surface

Durable post-mortems in `docs/learnings/`. Each surface doc links its own as well.

**Connect**
- [`2026-05-12-connect-opp-short-description-50-char-trap.md`](../docs/learnings/2026-05-12-connect-opp-short-description-50-char-trap.md)
- [`2026-05-17-connect-slug-length-50-char-trap.md`](../docs/learnings/2026-05-17-connect-slug-length-50-char-trap.md)
- [`2026-05-12-connect-uncaught-domain-exceptions.md`](../docs/learnings/2026-05-12-connect-uncaught-domain-exceptions.md)
- [`2026-05-18-connect-gates-deliver-on-learn-completion.md`](../docs/learnings/2026-05-18-connect-gates-deliver-on-learn-completion.md)
- [`2026-05-14-invite-verification-deferred.md`](../docs/learnings/2026-05-14-invite-verification-deferred.md)

**CommCare HQ / case model**
- [`2026-09-02-household-dual-group-membership.md`](../docs/learnings/2026-09-02-household-dual-group-membership.md)
- [`2026-09-04-vsla-group-running-ledger.md`](../docs/learnings/2026-09-04-vsla-group-running-ledger.md)

**Nova**
- [`2026-04-29-nova-connect-marker-bugs.md`](../docs/learnings/2026-04-29-nova-connect-marker-bugs.md)
- [`2026-05-25-entity-id-misdiagnosis.md`](../docs/learnings/2026-05-25-entity-id-misdiagnosis.md)
- [`2026-05-12-boundary-probe-registry.md`](../docs/learnings/2026-05-12-boundary-probe-registry.md)

**OCS**
- [`2026-05-19-ocs-upload-b64-context-wedge.md`](../docs/learnings/2026-05-19-ocs-upload-b64-context-wedge.md)
- [`2026-06-09-ocs-provider-key-revocation-misread-as-outage.md`](../docs/learnings/2026-06-09-ocs-provider-key-revocation-misread-as-outage.md)

**Connect Labs**
- [`2026-06-13-labs-workflow-run-deeplink.md`](../docs/learnings/2026-06-13-labs-workflow-run-deeplink.md)
- [`2026-07-20-demo-workflow-ddd-native.md`](../docs/learnings/2026-07-20-demo-workflow-ddd-native.md)

**Mobile**
- [`2026-05-14-atlas-side-channel-capture.md`](../docs/learnings/2026-05-14-atlas-side-channel-capture.md)
- [`2026-05-14-demo-user-no-otp.md`](../docs/learnings/2026-05-14-demo-user-no-otp.md)
- [`2026-05-14-phase6-validation-arc.md`](../docs/learnings/2026-05-14-phase6-validation-arc.md)
- [`2026-05-19-maestro-v2-probe-timeout.md`](../docs/learnings/2026-05-19-maestro-v2-probe-timeout.md)
- [`2026-05-21-parallel-session-adb-leak.md`](../docs/learnings/2026-05-21-parallel-session-adb-leak.md)
- [`2026-05-22-commcare-2.63.0-backup-code-cells.md`](../docs/learnings/2026-05-22-commcare-2.63.0-backup-code-cells.md)
- [`2026-05-25-bednet-smoke-phase6-install-rejection.md`](../docs/learnings/2026-05-25-bednet-smoke-phase6-install-rejection.md)
- [`2026-05-25-recipe-static-preventer-suite.md`](../docs/learnings/2026-05-25-recipe-static-preventer-suite.md)
- [`2026-05-26-deliver-atlas-coverage.md`](../docs/learnings/2026-05-26-deliver-atlas-coverage.md)
- [`2026-05-26-phase6-debug-arc-corrected.md`](../docs/learnings/2026-05-26-phase6-debug-arc-corrected.md)
- [`2026-05-27-bednet-permission-dialog-misdiagnosis.md`](../docs/learnings/2026-05-27-bednet-permission-dialog-misdiagnosis.md)
- [`2026-05-27-demo-user-rotation.md`](../docs/learnings/2026-05-27-demo-user-rotation.md)
- [`2026-06-01-selector-map-calibration-framework.md`](../docs/learnings/2026-06-01-selector-map-calibration-framework.md)
- [`2026-07-30-recording-validation-and-injected-seam-blindness.md`](../docs/learnings/2026-07-30-recording-validation-and-injected-seam-blindness.md)

**ACE's own process (not a platform)**
- [`2026-04-28-mcp-vs-skill-doc-drift.md`](../docs/learnings/2026-04-28-mcp-vs-skill-doc-drift.md)
- [`2026-04-pm-runs-compacted.md`](../docs/learnings/2026-04-pm-runs-compacted.md)
- [`2026-05-08-fake-qa-detection.md`](../docs/learnings/2026-05-08-fake-qa-detection.md)
- [`2026-05-09-orchestrator-judgment-vs-formal-spec.md`](../docs/learnings/2026-05-09-orchestrator-judgment-vs-formal-spec.md)
- [`2026-05-12-no-inferred-backstory.md`](../docs/learnings/2026-05-12-no-inferred-backstory.md)
- [`2026-05-14-fork-run-skill.md`](../docs/learnings/2026-05-14-fork-run-skill.md)
- [`2026-05-26-mcp-env-loader-asymmetry.md`](../docs/learnings/2026-05-26-mcp-env-loader-asymmetry.md)
- [`2026-06-01-seeded-run-structural-not-flags.md`](../docs/learnings/2026-06-01-seeded-run-structural-not-flags.md)

*Enforced:* `test/docs/playbook-index.test.ts` fails CI if an integration doc or a learning
is missing from this file.
