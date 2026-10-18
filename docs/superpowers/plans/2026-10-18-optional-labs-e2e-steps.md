# Optional Labs end-to-end steps: implementation plan

**Spec:** `docs/superpowers/specs/2026-10-18-optional-labs-e2e-steps.md`
**Shape:** staged PRs. Each PR is one bump → PR → auto-merge cycle via `skills/shipping`, and a PR merges before anything that depends on it starts. **Each file has exactly one owning PR**, so implementers working in parallel never touch the same file. PR 1 lands every new `lib/artifact-manifest.ts` entry up front, so later PRs never edit the manifest.

## Dependency graph

```
PR1 (framework + manifest) ─┬─ PR2 (private solicitation + #3146) ── PR4 (seed responses) ─┐
                            ├─ PR3 (llo_org)  ─────────────────────────────────────────────┤
                            ├─ PR5 (Forms atoms) ── PR5b (solicitation-google-form)          │
                            └─ PR6 (supply-chain playbook + setup) ── PR7 (procure) ── PR8 (fulfil) ── PR9 (operate)
                                                                                             └── PR10 (simulated execution) ── PR11 (tenancy + sweep) ── PR12 (docs)
```

These can run in parallel once PR1 has merged: PR2, PR3, PR5 and PR6. PR4 needs PR2 and PR3. PR10 needs PR4 and PR9.

---

## PR1: optional-steps framework + manifest entries

**Files (owned):**
- `lib/optional-steps.ts` (new): `resolveOptionalSteps(flags, oppYaml) → OptionalSteps | Error`, which applies the § A2 implications and refusals.
- `test/lib/optional-steps.test.ts` (new): the default is all-off; `labs_e2e` expands; `seed_responses` forces private; `supply_chain` without `ace_winner` is refused; `--invite-candidates` together with `seed_responses` is refused; an unknown name is refused.
- `commands/run.md`: the `--with` flag and its help text.
- `agents/ace-orchestrator.md`: a new `### Optional steps` under Pre-flight that resolves the steps once and writes `run_state.optional_steps`. In § Workflow, Phase 8 and Phase 9 say they dispatch the optional block only when it is enabled. In the Phase 8→9 boundary text, Phase 9 is dispatched only in simulated mode (§ G of the spec).
- `agents/orchestrator-reference.md`: § State Schema gains `optional_steps`, `solicitation.visibility`, `google_form`, `seeded_responses`, `selected_llo.synthetic_winner`, and the `execution-management.mode` / `products.supply_chain` / `products.simulation` blocks.
- `lib/run-state-validator.ts` + `test/lib/run-state-validator.test.ts`: accept the new shapes, and make `mode: simulated` legal.
- `lib/artifact-manifest.ts`: **every** artifact the spec adds, each `required: false`, with `producedBy` set to the new skill names. That covers the roster, the form record, each `-qa` and `-eval` verdict, the supply-chain plan and per-step reports, the weekly reviews and the simulation summary.
- `test/lib/artifact-manifest.test.ts`: the fixtures, if a count assertion moves.

**Acceptance:**
- `npm test` is green.
- A run with no `--with` resolves to `optional_steps` absent, and the fence behaves exactly as before. Pin this with a `classify_phase_writeback` fixture that has none of the new artifacts.

## PR2: private solicitation + award fix (closes ace#3146)

**Files:**
- `skills/solicitation-create/SKILL.md`: read `optional_steps.private_solicitation`, publish with `is_public: false`, add the demonstration banner, record `visibility`.
- `skills/solicitation-monitor/SKILL.md`: pass `program_id` on every `get_solicitation` / `list_responses`.
- `skills/solicitation-review/SKILL.md`:
  - Step 7 passes `reward_budget` + `org_id` (+ `fund_id`), not `amount`;
  - the Step 6 confirm prompt names the possible awardee email;
  - the award record captures `awardee_notified`;
  - add `program_id` on every read;
  - with `synthetic_winner`, write `selected_llo.synthetic_winner: true`.
- `test/skills/solicitation-visibility.test.ts` (new): every `get_solicitation`/`list_responses` call block in these three skills carries `program_id`, and no `award_response` block contains `amount:`.

**Residual named in the PR:** spec § K2.

## PR3: the `llo_org` winner org

**Files:**
- `lib/connect-orgs.ts` + `test/lib/connect-orgs.test.ts`: the `llo_org` key from `ACE_CONNECT_LLO_ORG`; it must differ from `pm_org` and `nm_org`.
- `.env.tpl`: a comment-only line documenting the local-only key (no value, same as `ACE_CONNECT_NM_ORG`).
- `bin/ace-doctor`: `--preflight` WARNs when the key is unset (only matters for runs that request `ace_winner`).
- `test/skills/no-hardcoded-connect-org.test.ts`: extend so a literal winner-org slug in a skill is refused.
- `playbook/integrations/connect-api.md`: add a "The ACE-owned orgs" section (pm / nm / llo, what each holds, why they must be distinct).

**Operator step (before the FI run):** create the Connect org in the UI as ace@ and set `ACE_CONNECT_LLO_ORG` in `${CLAUDE_PLUGIN_DATA}/.env`, then run `/ace:setup --force-env` and restart Claude.

## PR4: `solicitation-seed-responses` (+ `-qa`)

**Files:**
- `skills/solicitation-seed-responses/SKILL.md` and `skills/solicitation-seed-responses-qa/SKILL.md` (new).
- `lib/synthetic-responses.ts` + `test/lib/synthetic-responses.test.ts` (new). It validates and builds the payload:
  - the `[Synthetic]` suffix;
  - no collision with real org names (case-insensitive, punctuation-folded);
  - the confidentiality deny list;
  - the `+synthetic-<n>` email;
  - every required question id is answered unless the persona is flagged `missing_answer`.
- `agents/solicitation-management.md`: Step 1b (google form, PR5b) and Step 1c (seed responses), each run only when enabled. The `skills:` frontmatter adds both, marked optional.
- `skills/README.md`: two catalogue rows.

**Live verification (in the PR):**
1. Create a private throwaway solicitation in ace-pm-org's sandbox program.
2. Seed 3 responses and confirm `get_response` on the bound winner. That pins spec § K1 (the `award_response.org_id` identifier) as a captured fixture.
3. Close the solicitation.

## PR5: Google Forms atoms

**Files:**
- `mcp/google-drive-server.ts`: `forms_create_from_spec`, `forms_set_publish_settings`, `forms_list_responses`, and the scopes `forms.body` + `forms.responses.readonly`. Creation goes through `drive.files.create` with a Shared Drive parent, then `assertParentOnSharedDrive`.
- `test/mcp/gdrive/forms-atoms.test.ts` (new): the item-kind mapping, the refusal of a My Drive parent, and the publish call.
- `docs/atom-schemas.md`: regenerate with `npx tsx scripts/dump-atom-schemas.ts`.
- `test/mcp/registration-coverage.test.ts`: update the snapshot.
- `bin/ace-doctor`: a `forms_api` probe that names "enable the Forms API on the SA's GCP project" when it gets a 403 `SERVICE_DISABLED`.
- `playbook/integrations/google-forms.md` (new): create, publish, responses, and the My-Drive-quota trap.

**Restart:** this changes MCP code, so it needs a full Claude restart after merge (CLAUDE.md § MCP changes).

## PR5b: `solicitation-google-form` (+ `-qa`)

**Files:**
- `skills/solicitation-google-form/SKILL.md` and `skills/solicitation-google-form-qa/SKILL.md` (new).
- `lib/form-from-solicitation.ts` + test (new): questions to items, the question id carried in each item description, and back-mapping responses by id.
- `skills/README.md`: catalogue rows.

## PR6: supply-chain playbook + `supply-chain-setup` (+ `-qa`)

**Files:**
- `playbook/integrations/connect-labs-supply-chain.md` (new): the general reference, organised by resource (programme / registry / sourcing / contract / logistics / finance / stock / partner access). It must cover:
  - the `programme_runner` standing model and its platform-support-only setter;
  - `source.ref` idempotency;
  - decimal-string money;
  - "never compute what the supplier stated";
  - the irreversibility table (spec § F6).
- `lib/supply-chain-ref.ts` + `test/lib/supply-chain-ref.test.ts` (new): the deterministic `ace:<run>:<skill>:<step>:<key>` ref, and the `sent_on` derived from the simulated calendar.
- `skills/supply-chain-setup/SKILL.md` and `skills/supply-chain-setup-qa/SKILL.md` (new).
- `playbook/integrations/connect-labs.md`: one pointer line to the new doc. Nothing else in this file changes; the audit's restructure of it is separate work.
- `skills/README.md`: catalogue rows.

**Blocked on the owner:** spec § F1 (the programme runner).

## PR7: `supply-chain-procure` (+ `-qa`, `-eval`)

**Files:** `skills/supply-chain-procure/SKILL.md`, `skills/supply-chain-procure-qa/SKILL.md`, `skills/supply-chain-procure-eval/SKILL.md` (new), and `skills/README.md` rows.

## PR8: `supply-chain-fulfil` (+ `-qa`)

**Files:** `skills/supply-chain-fulfil/SKILL.md`, `skills/supply-chain-fulfil-qa/SKILL.md` (new), and `skills/README.md` rows.

## PR9: `supply-chain-operate` (+ `-qa`)

**Files:** `skills/supply-chain-operate/SKILL.md`, `skills/supply-chain-operate-qa/SKILL.md` (new), and `skills/README.md` rows.

## PR10: simulated execution

**Files:**
- `lib/sim-calendar.ts` + `test/lib/sim-calendar.test.ts` (new): the backdated week windows, week 0 for procurement, everything in the past, Monday-aligned.
- `skills/simulated-execution/SKILL.md` and `skills/simulated-execution-qa/SKILL.md` (new).
- `skills/simulated-weekly-review/SKILL.md` and `skills/simulated-weekly-review-eval/SKILL.md` (new).
- `agents/execution-manager.md`: the single simulated-mode carve-out in the "NOT YET LIVE" guard. Real mode is unchanged.
- `test/agents/execution-manager-guard.test.ts` (new): the guard text still halts real mode, and the simulated block contains no `connect_send_llo_invite`, no `bin/ace-email` and no `llo-onboarding`.
- `skills/README.md`: catalogue rows.

## PR11: tenancy + sweep

**Files:**
- `config/tenancy-targets.json`: the § I rules.
- `test/hooks/tenancy-guard.test.ts`: the new rules, including the inert `program_id` rule.
- `skills/sweep-labs/SKILL.md`: the private-solicitation listing with `program_id`, update-link revoke, `quote_void`, and the irreversible-records report.
- `skills/sweep-drive/SKILL.md`: closing forms.

**Cross-repo:** an ace-web issue for the `connect_program_ids` tenancy field.

## PR12: docs

**Files:**
- `CLAUDE.md`: one line under § Phases naming the optional track and `--with`, and one line in the Gotchas for `programme_runner_set` being platform-support only.
- `playbook/README.md`: the index rows, if the audit's index PR has landed; otherwise this PR leaves the file alone.

---

## Owner blockers (must be resolved before the Connect FI run reaches Phase 9)

1. **The labs programme runner.** Someone with labs platform support runs `supply_chain_programme_runner_set({program_id: <Connect FI program>, org_id: <ace-pm-org labs id>})`. It is verified that ACE cannot: its standing on its own program 353 reads `partner` and the runner is null.
2. **The winner Connect org.** Create it once in the Connect UI as ace@, and set `ACE_CONNECT_LLO_ORG`.
3. **The Forms API** must be enabled on the service account's GCP project, which needs whoever administers that project.

## Out of scope (spec § J)

Real Phase 9 for the winner, participant cash deposits, marketplace-round registration, and the `connect_create_organization` atom.
