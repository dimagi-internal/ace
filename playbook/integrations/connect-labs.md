# Connect-Labs Integration

> **Upstream repo: [`dimagi-internal/connect-labs`](https://github.com/dimagi-internal/connect-labs).** Connect Labs ships continuously,
> so an ACE call path that has not changed in months can break because *they* shipped.
> When something that used to work starts failing — especially with an opaque error —
> run `skills/upstream-regression-triage` before concluding it needs a live probe.

## Status

**Live.** ACE consumes labs.connect.dimagi.com via the `connect-labs`
MCP server, wired in `plugin.json` as a **native `type: "http"` entry**
pointing directly at `https://labs.connect.dimagi.com/mcp/`. Claude Code
handles the JSON-RPC transport; a `headersHelper`
(`scripts/labs-auth-headers.mjs`) supplies the `Authorization: Bearer
<LABS_MCP_TOKEN>` header at connection time.

Auth is per-user PAT (minted via `/ace:labs-token-mint`). OAuth-via-
CCHQ happens server-side inside labs's tool handlers; ACE only ever
sends a Bearer token.

### headersHelper wiring (replaced the stdio proxy)

The `connect-labs` entry is:

```json
"connect-labs": {
  "type": "http",
  "url": "https://labs.connect.dimagi.com/mcp/",
  "headersHelper": "${CLAUDE_PLUGIN_ROOT}/scripts/labs-auth-headers.mjs"
}
```

`headersHelper` is a command Claude Code runs at connection time; it
must print a JSON object of string→string to stdout, which Claude Code
merges into the request headers. `scripts/labs-auth-headers.mjs`:

- Is a **node-only `.mjs`** (shebang `#!/usr/bin/env node`, executable
  bit committed). No `tsx`, no `node_modules` resolution, no CWD
  assumption — `headersHelper` runs in an unspecified shell, so the only
  runtime dependency is `node` (always present alongside Claude Code).
- **Self-derives** the plugin DATA dir from its own file location
  (mirroring `lib/plugin-data-dir.ts::derivePluginDataDir`) rather than
  trusting `$CLAUDE_PLUGIN_DATA`, which Claude Code does **not** expand
  in plugin MCP configs (anthropics/claude-code#9427, still open on
  2.1.153). `${CLAUDE_PLUGIN_ROOT}` *is* expanded, so the helper path in
  plugin.json resolves.
- Reads `LABS_MCP_TOKEN` (env var → `<data-dir>/.env` → dev-root `.env`)
  and emits `{"Authorization":"Bearer <token>"}`; emits `{}` + a stderr
  diagnostic and still exits 0 when no token is found.

**Requires Claude Code ≥ 2.1.141** (last `headersHelper` auth-state
bug-fix; the feature itself shipped by 2.1.118).

The native path was confirmed in production on 2026-05-28 (a live
`labs_context` returned the full real org tree through the headersHelper,
with no stdio subprocess running), and the old stdio→HTTP proxy
(`mcp/connect-labs-server.ts` + its tests) was removed. To revert if ever
needed, restore that file from git history and swap the plugin.json
`connect-labs` block back to a stdio `command`/`args` entry pointing at it.

## Running / testing

There's no standalone subprocess to run — Claude Code connects to the
HTTP endpoint directly and invokes the `headersHelper` at connection
time. To sanity-check the helper in isolation:

```bash
node scripts/labs-auth-headers.mjs   # prints {"Authorization":"Bearer …"} or {} + stderr diag
```

Required env: `LABS_MCP_TOKEN` (per-user PAT from
`/ace:labs-token-mint`). 1Password is the source of truth; rotate
there and refresh `.env` with `/ace:setup --force-env` (never a raw
`op inject -o <plugin-data>/.env`: that drops the local-only keys, and a
`config/gating.json` rail blocks it).

`bin/ace-doctor`'s `[Auth liveness]` block runs a one-shot
`labs_context` against the live PAT; failure points at the rotation
command above. After any change to plugin.json's `connect-labs` wiring,
a **full Claude Code restart** is needed for it to take effect.

## Capability map

Labs atoms are served by connect-labs itself, so they are **not** in
`docs/atom-schemas.md` (that file catalogues ACE's own MCPs). The live contract is the
server's `tools/list`; load a schema in-session with `ToolSearch "select:mcp__connect_labs__<atom>"`
before calling it. The families below are grouped by resource. "Typical callers" names
the ACE skills using an atom today. None of them is build-only; each acts on whatever
program, opportunity, solicitation or workflow id it is given.

### Solicitations, responses, reviews, awards

| Atom | Typical callers |
|---|---|
| `create_solicitation` | `solicitation-create` (pass `org_slug`; since connect-labs#2567 the call must be owned by a registered labs org the caller belongs to, ace#3049) |
| `get_solicitation` / `list_solicitations` / `update_solicitation` / `delete_solicitation` | `solicitation-create`, `solicitation-monitor`, `solicitation-review`, `sweep-labs` |
| `list_responses` / `get_response` | `solicitation-monitor`, `solicitation-review` |
| `create_response` | (no skill yet) seeds a response on a firm's behalf when the caller owns the call; built for demo/synthetic responses |
| `create_review` / `update_review` / `list_reviews` / `get_review` | `solicitation-review`, `eoi-round-review` |
| `award_response` | `solicitation-review` (HITL-gated). Requires `response_id`, `reward_budget`, `org_id`; **emails the awardee when labs email is on**; refuses a second award (ace#3146) |

`is_public: false` hides a call from the logged-in listing. Its owning org's members
(and anyone who responded) still read it by `solicitation_id` alone. Since
connect-labs#2567, labs authorizes solicitation reads and writes by owning-org
membership, and the live schema marks `program_id` "Accepted for compatibility; not
needed" on `get_solicitation`, `list_responses`, `get_response`,
`update_solicitation` and `award_response` (2026-10-18). A private call that reads as
"not found" is an ownership problem, not a missing `program_id`. Anonymously, a listed
call's `/solicitations/<id>/` answers 200 and an unlisted one 404, the same as a missing
record (observed 2026-10-19, ace#3254; CLAUDE.md § Phases).

### Marketplace (EOI rounds)

| Atom | Typical callers |
|---|---|
| `marketplace_rounds_list` / `marketplace_round_responses` / `marketplace_orgs_get` | `eoi-criteria-proposal`, `eoi-round-review`, `marketplace-outreach-doc`, `llo-directory-add` |
| `marketplace_round_criteria_set` | `eoi-criteria-proposal` |
| `marketplace_round_summary_set` | `eoi-round-review` (links the internal report on the round) |
| `marketplace_round_scores` | read-only: every applicant × criterion plus per-criterion mean / median / spread / shortlist gap, the same figures as the round's Scores page. `version` reads an earlier criteria version; `compare_with` adds whose recommendation moved and how each criterion's weight, mean and shortlist gap changed between two versions. Use it to report a re-score, never a hand-built diff |
| `marketplace_round_versions` | read-only: every criteria version of a round, oldest first, with its basis, author, whether it is current, and how many AI and people's reviews were scored on it |
| `marketplace_round_version_archive` / `marketplace_round_version_delete` | operator tasks, approval-gated. Archive puts a version kept outside labs (and its AI reviews) back into the round's history; delete removes an earlier version and EVERY review on it, people's included, and cannot be undone. Neither touches the current version |

A round keeps every criteria version. `marketplace_round_criteria_set` with new criteria
adds a version (it becomes current), and an AI re-score on it supersedes the earlier AI
review rather than overwriting it, so v1 → v2 → v3 stay comparable on the Scores page and
through `marketplace_round_scores(compare_with=…)`. Each AI review carries the
`rubric_version` it was scored on (`eoi-round-review` § Write to labs).

### Funds

| Atom | Typical callers |
|---|---|
| `create_fund` / `update_fund` / `get_fund` / `list_funds` / `add_fund_allocation` / `remove_fund_allocation` | (no skill yet). `award_response` takes an optional `fund_id` that appends an allocation |

### Synthetic data

| Atom | Typical callers |
|---|---|
| `synthetic_generate_from_manifest` / `synthetic_register` / `synthetic_create_labs_only` | `synthetic-data-generate`, `demo-data-setup` |
| `synthetic_env_ensure` / `synthetic_env_get` / `synthetic_env_list` | `demo-data-setup` (packaged envs, e.g. 4 completed weeks with weekly runs) |
| `synthetic_clone_opp` / `synthetic_clone_profile` / `synthetic_clone_generate` / `synthetic_clone_to_labs_only` / `synthetic_profile_*` / `synthetic_fidelity_*` | `clone-to-new-workspace`, `demo-data-setup` (clone mode), `demo-fidelity-check` |
| `synthetic_repoint_by_source` / `synthetic_reload_fixtures` / `synthetic_set_allowed_domains` / `synthetic_set_my_visibility` | operator tasks (see auto-memory's KMC notes) |
| `synthetic_disable` | reversal (no skill; operator-driven) |

### Workflows and templates

| Atom | Typical callers |
|---|---|
| `workflow_create_from_template` / `workflow_create` / `workflow_clone` / `list_templates` | `synthetic-workflow-seed`, `demo-data-setup`, `clone-to-new-workspace` |
| `workflow_get` / `workflow_list` / `workflow_update_definition` / `workflow_patch_render_code` / `workflow_update_render_code` | `synthetic-workflow-seed`, `demo-data-setup` |
| `workflow_create_run` / `workflow_run_action` / `workflow_save_snapshot` | `synthetic-workflow-seed`, `ocs-coach-setup`, `coach-session-capture` |
| `workflow_update_opportunity_ids` | (no skill yet) re-points a workflow at other opportunities |
| `workflow_template_*` / `workflow_follow_template` / `workflow_sync_from_*` | `lib/labs-report-templates.ts` (§ Workflow template lifecycle) |
| `workflow_delete` | `sweep-labs` |

### History (simulated time)

| Atom | Typical callers |
|---|---|
| `workflow_ensure_visit_cache` → `workflow_preview_as_of` → `workflow_rebuild_history` / `workflow_history_runs` / `workflow_prune_history` | `demo-data-setup` (cascade C5), `semantic-registry-author`, `clone-to-new-workspace` |

There is no clock to move. To simulate N weeks, generate backdated data, preview one date
with `workflow_preview_as_of` (writes nothing), then `workflow_rebuild_history`
(`cadence: weekly`, `semantic_snapshot` workflows only), which writes one completed run
per Monday–Sunday week.

### Semantic registry, explorer, benchmarks

| Atom | Typical callers |
|---|---|
| `semantic_registry_create` / `_update` / `_validate` / `_get` / `_explain` / `_set_indicator_meta` | `semantic-registry-author`, `clone-to-new-workspace`, `ocs-coach-setup` |
| `explorer_describe` / `explorer_query` / `explorer_validate` | `flw-data-review`, `timeline-monitor`. Called through canopy, `explorer_query` returns rows for SYNTHETIC opportunities only; on a real one validate the SQL and hand it to the labs page |
| `benchmarks_publish` / `benchmarks_create_opp_reports` / `benchmarks_cohort_*` | `demo-data-setup`, `semantic-registry-author` |

### Pipelines

| Atom | Typical callers |
|---|---|
| `pipeline_create` / `pipeline_get` / `pipeline_list` / `pipeline_preview` / `pipeline_sql` / `pipeline_update_schema` / `pipeline_delete` / `pipeline_set_shared` | `synthetic-workflow-seed`, `demo-data-setup`, `flw-data-review` |

### Targeting, microplans, campaigns

| Atom | Typical callers |
|---|---|
| `targeting_*` | `target-geographies`, `cost-effectiveness`, `defend-a-figure`, `scan-data-sources`, `build-targeting-model` (agent: `targeting-analyst`) |
| `microplans_*` / `campaign_build_national` | (no skill yet) |

### Supply chain

**Full reference: [`connect-labs-supply-chain.md`](connect-labs-supply-chain.md)** (the runner and standing model, evidence refs, money, each resource, what cannot be undone).

`supply_chain_*` is a full procurement and stock surface. The only ACE call today is
`supply_chain_org_upsert` in `solicitation-create` Step 5a, which registers the PM org as
the owning labs org. **Supply-chain skills are being added.** Until then, read the live
schemas. Every write takes `program_id` and a `source.ref` used for idempotency, and its
evidence dates (`received_on`, `sent_on`) can be backdated. The families, in lifecycle
order:

| Stage | Atoms |
|---|---|
| Programme setup | `supply_chain_programme_runner_set` (platform-support only) / `_get`, `supply_chain_programme_team_*`, `supply_chain_org_upsert` / `_list` / `_merge`, `supply_chain_commodity_upsert` / `_list`, `supply_chain_item_upsert` / `_get` / `_list`, `supply_chain_supply_point_*`, `supply_chain_supplier_create` / `_update` / `_get` / `_list` / `_mark_reviewed` |
| Sourcing | `supply_chain_tender_create` / `_update` / `_invite_org` / `_open` / `_compare` / `_close` / `_get` / `_list` / `_outstanding_questions`, `supply_chain_quote_record` / `_correct` / `_void` / `_get` / `_list`, `supply_chain_award_create` / `_list` |
| Contract | `supply_chain_contract_create` / `_update` / `_get` / `_list` / `_landed_cost` / `_match` / `_holds` |
| Logistics | `supply_chain_shipment_record` / `_update` / `_get` / `_list`, `supply_chain_consignment_dispatch` / `_receive` / `_list`, `supply_chain_receipt_record` / `_list` (a receipt is what creates stock) |
| Finance | `supply_chain_invoice_record` / `_update` / `_dispute` / `_list`, `supply_chain_payment_record` / `_confirm` / `_list`, `supply_chain_charge_*`, `supply_chain_approval_*` |
| Stock & distribution | `supply_chain_stock_on_hand` / `_position` / `_forecast` / `_flow` / `_by_batch`, `supply_chain_resupply_plan`, `supply_chain_distribution_*`, `supply_chain_worker_stock*`, `supply_chain_dispensing_rule_*`, `supply_chain_stock_count_*`, `supply_chain_movement_*`, `supply_chain_network_*` |
| Partner access & comms | `supply_chain_update_link_issue` / `_list` / `_revoke` (signed link for an org with no labs login), `supply_chain_request_render` / `_reminder_render` / `_followup_render` / `_tender_drafts_render`, `supply_chain_commitment_*`, `supply_chain_outreach_*`, `supply_chain_alert_*`, `supply_chain_document_*`, `supply_chain_view_*` |

### Context and config

| Atom | Typical callers |
|---|---|
| `labs_context` / `page_context` | `bin/ace-doctor` (auth liveness), `solicitation-create`, `connect-opp-setup`, `validate-release-readiness` |
| `get_opportunity_apps` | `semantic-registry-author`, `demo-data-setup`, `flw-data-review`, `timeline-monitor` |
| `labs_config_*`, `job_status` / `job_cancel`, `custom_analysis_run`, `program_admin_demo_seed` | `synthetic-workflow-seed` (`program_admin_demo_seed`), `lib/clone-run.ts` (`job_status`) |

## A solicitation is not tied to a Connect opportunity

A labs solicitation is scoped to a labs `program_id`, not to a Connect opportunity. Labs
has no foreign key to the opportunity. The `connect_opportunity_id` ACE records next to a
solicitation (`phases.solicitation-management.products.solicitation` in a run) is ACE-side
bookkeeping. Deleting and recreating the Connect opportunity therefore leaves the
solicitation alone: its URL keeps working, the deadline keeps running, and candidates'
views and applications continue. Recovery is to recreate the opportunity and update
the bookkeeping field. Multiple open solicitations on one program are expected (one per
run; `skills/solicitation-create § Per-run solicitations are expected, not a bug`).

## Workflow template lifecycle: follow, freeze, refollow

ACE's labs report pages are workflows that **follow a template workflow**. While a page
follows its template, every later publish of that template changes the page, including
pages a finished run was judged against or a release copies. Three states:

- **Following** (`workflow_follow_template({workflow_id, <scope>, template_workflow_id,
  template_program_id, follow: true})`): the page picks up each template publish.
- **Frozen**: the page is forked off its template at a recorded version. It stops moving
  and does not change at the moment of the fork. `scripts/labs-report-templates.ts freeze`
  does this for a run's reports and records `cascade.report_templates` with each
  `frozen_version` (`frozen_version_uncertain: true` when a publish raced the fork).
- **Refollow**: put a frozen page back on its template. `labs-report-templates.ts refollow
  [--apply]` prints or applies one `workflow_follow_template(follow: true)` per report.
  Only do this for a page nobody relies on as a fixed record.

`lib/clone-run.ts` copies each frozen page onto a clone's reports. Phase 7's use of this
is `agents/synthetic-data-and-workflows.md § Step 3.92`.

## Changing live labs objects

| Change | How | Limits |
|---|---|---|
| Solicitation deadline, text, visibility, close | `update_solicitation` (procedure: `skills/solicitation-edit`) | Read back with `get_solicitation`. Unlisted calls are readable by their owner by id alone; `program_id` is accepted for compatibility, not needed (live schema, 2026-10-18). Locked `evaluation_criteria` cannot change |
| Award a response | `award_response` | Irreversible and refused on a second try; may email the awardee |
| Point a workflow at other opportunities | `workflow_update_opportunity_ids` (procedure: `skills/labs-workflow-repoint`) | Rebuild history afterwards (`workflow_rebuild_history`), since past runs were computed on the old set |
| Change a report page's layout | Edit the template and publish, so following pages update; or `workflow_patch_render_code` on one page | A timed-out `workflow_patch_render_code` does not apply (§ Troubleshooting) |
| Change an indicator | `semantic_registry_update` → `_validate` | Saved runs freeze the registry, so a wording change needs a new run |
| Delete | `delete_solicitation`, `workflow_delete`, `pipeline_delete`, `synthetic_disable` | `sweep-labs` is the approval-gated path |

## Synthetic-manifest schema gotchas

`synthetic_generate_from_manifest` validates the manifest against a
strict pydantic schema before generation runs. Schema mismatches return
descriptive errors but the iteration is sequential (one mismatch
reported per call), so a fresh-author manifest typically takes
**3–5 retries to settle on the canonical shape**. Costing observed on
`leep-paint-collection` run `20260509-1448` (2026-05-09): five
retries before generation succeeded.

Document the canonical shape here so the next opp doesn't pay it.

### Field-by-field gotchas

Each row is a real pydantic-validation rejection observed during
manifest authoring. Conform to these on first attempt to skip the
retry tax.

- **`visit_cadence_per_week_per_flw` is a `MeanStddev` object, not an
  int.**
  Wrong: `visit_cadence_per_week_per_flw: 5`.
  Right: `visit_cadence_per_week_per_flw: { mean: 5.0, stddev: 1.5 }`.
  Plain-int authors are tempted because "5 visits per week" reads
  naturally as a single number; pydantic wants the distribution
  envelope so the generator can sample realistic FLW variance.

- **`flw_archetype` is a literal enum.** Allowed values:
  `rockstar | steady | struggling | new_hire`. Authors invent
  domain-specific labels (`lead_flw`, `support_flw`) and the validator
  rejects them. The labels stay generic on purpose — archetype drives
  visit-rate distributions and submission-quality patterns, not job
  titles.

- **`cohort_progression` is a single enum string, not an array.**
  Wrong: `cohort_progression: ["onboarding", "active", "winding_down"]`.
  Right: `cohort_progression: "ramp_up"` (or whichever single phase
  applies to the cohort being modeled).
  When you need multiple phases, define multiple cohorts; one cohort
  has one progression value at a time.

- **`field_distributions` is a MAPPING keyed by field path, NOT a list.**
  Upstream types it as `dict[str, FieldDistribution]`
  (`commcare_connect/labs/synthetic/generator/fixtures/manifest.py §
  BeneficiaryCohort`): the field path is the KEY, the distribution object
  is the VALUE. A list shape is rejected by the live Pydantic with
  `Input should be a valid dictionary` (jjackson/ace#806) — a full labs
  round-trip wasted. `synthetic-narrative-plan-qa` check 4 fails a list
  shape ACE-side.
  Wrong (list): `field_distributions: [{ field: "shop_count", distribution: "uniform", low: 5, high: 12 }]`.
  Right (mapping): `field_distributions: { shop_count: { distribution: "uniform", low: 5, high: 12 } }`.
- **Each `field_distributions` value needs an explicit `distribution`
  discriminator.** Pydantic's tagged-union dispatch is keyed on a
  `distribution: <name>` field on each value. Dropping it produces
  the cryptic `unable to discriminate` error. The union is **exactly
  four variants** — source, read 2026-08-26 at
  `dimagi-internal/connect-labs@main:connect_labs/labs/synthetic/generator/fixtures/manifest.py`:

  ```python
  FieldDistribution = Annotated[
      NormalDistribution | UniformDistribution | BinaryDistribution | CategoricalDistribution,
      Field(discriminator="distribution"),
  ]
  ```

  | tag | required params | notes |
  |-----|-----------------|-------|
  | `normal` | `mean`, `stddev` (>= 0) | optional `lo` / `hi` clamp the draw to plausible bounds |
  | `uniform` | `low`, `high` (`high >= low`) | |
  | `binary` | `rate` (0-1) | draws **`1` / `0`**, not strings. `period_rates: {<week_index>: <rate>}` varies it per week |
  | `categorical` | `values: {<value>: <share>}` | draws the KEY verbatim; shares need not sum to 1 (normalized at draw time), each must be >= 0 and the sum > 0 |

  All four also accept the shared optionals `transform: <str>` and
  `null_rate` (0-1). `uniform_int` is still NOT a variant.

  **`categorical` is the right choice for any `select1` / coded field**,
  because it round-trips the app's REAL encoding. A yes/no question whose
  released XForm carries `<bind constraint=". = 'yes' or . = 'no'"/>` must be
  authored as:

  ```yaml
  field_distributions:
    form.net_check.slept_under_net:
      distribution: "categorical"
      values: { 'yes': 0.66, 'no': 0.34 }
  ```

  Encoding it as `binary` instead writes floats `1.0` / `0.0` into
  `form_json`, so a pipeline authored against PRODUCTION data (keying on
  `'yes'`) does not work unchanged against the fixture, and vice versa — it
  forces `avg` + `transform: float` workarounds. `categorical` also works
  inside an `flw_personas[].field_overrides` block.

  **Prior claim corrected (ace#1656).** This bullet used to say the union was
  "exactly three variants" and that `categorical` was "rejected at the labs
  boundary". That was true when written (2026-06-09, ace#734/#737);
  `CategoricalDistribution` landed upstream ten days later, between
  connect-labs `53e7dbd` (2026-06-13, absent) and `e323ac0` (2026-06-19,
  present — PR #655 "High-fidelity synthetic generator"), and the doc was
  never re-checked. Live confirmation on
  `bednet-check-2-visit/20260825-1310` Phase 7 (labs-only opp 10046, fixture
  folder `1QtJa0Cwg1jBPTJQ29z7iAiDPRkyH4ibK`):
  `synthetic_generate_from_manifest` accepted `categorical`, generated 276
  `user_visits`, round-tripped the literal strings `'yes'` / `'no'` at the
  app's own nesting, and `pipeline_preview` returned `fields_all_null: []`.
  The `20260817-1720` run of the same opp believed the stale claim, encoded
  three yes/no fields as floats, and had to disclose the divergence in its own
  dataset audit.

  Note the **package rename**: upstream moved `commcare_connect/` →
  `connect_labs/` on 2026-07-01 (connect-labs PR #797). Citations elsewhere
  in ACE that still say `commcare_connect/labs/...` point at a path that no
  longer exists.
- **`binary` distribution: the param is `rate` (0-1), NOT `p_yes`.**
  `{ field: "slept_under_net", distribution: "binary", rate: 0.7 }` draws
  1 at 70%. To vary the rate per week — the week-scoped-anomaly
  mechanism — add `period_rates: {<week_index>: <rate>}`.
  **`week_index` is 1-BASED: key `1` is the FIRST week of the timeline,
  key `2` is the SECOND.** So `period_rates: {2: 0.3}` drops the second
  week (0-based index 1, i.e. `start_date + 7…13 days`) to 30% while
  every other week keeps `rate`; to dip the week at 0-based index 2, key
  it `3`. This is upstream's intent, not a bug — `VisitSlot.week_index`
  is declared `# 1-based` and produced by `for week in range(1,
  timeline.weeks + 1)` in `.../generator/fixtures/timeline.py`, the
  engine passes `period=slot.week_index` straight through, and
  `BinaryDistribution.rate_for_period` does a bare
  `period_rates.get(period, self.rate)` with no rebasing (pinned by
  `test_timeline.py`'s `assert 1 <= slot.week_index <= 4`). Measured
  live on labs opp 10045 (`random_seed: 20260817`, `start_date:
  2026-07-20`, 4 weeks): `net_hanging` (base 0.78) with a requested dip
  of 0.55 at key `2` measured 28/51 = **0.549** on 0-based week 1, while
  0-based week 2 sat at the 0.78 base (23/33 = 0.697) — the requested
  dip exactly, one 0-based slot "early", because the key is 1-based.
  Note this is NOT the same convention as `anomalies[].week` as ACE
  authors it (`skills/demo-data-setup/SKILL.md` records those as
  0-based) — do not carry one over to the other.

  Emitting `p_yes` silently fails to set the
  rate (`rate` is the required field; an unknown `p_yes` is ignored), so
  the output reverts toward the default share — the bednet-spot-check
  20260608-0711 45%-vs-requested-70% symptom (jjackson/ace#737). Source:
  `BinaryDistribution` in `.../generator/fixtures/manifest.py`.

- **The PIPELINE `aggregation` allow-list is exactly these ten:**
  `avg`, `count`, `count_distinct`, `count_unique`, `first`, `last`,
  `list`, `max`, `min`, `sum`. Anything else is rejected at
  `pipeline_update_schema` / `pipeline_preview` with the allow-list
  echoed back — `Unknown aggregation '<x>' on field '<name>'. Valid:
  [...]`. Verified live on `labs.connect.dimagi.com` 2026-08-26 (opp
  10047, pipeline 5242) and pinned by
  `scripts/probe-labs-pipeline-aggregations.ts`.

  **Do not confuse this with the MANIFEST's `kpi_config[].aggregation`,
  which is a different layer** with its own generator-side vocabulary
  (`validated_rate`, `non_null_rate`, `distinct_count`). Those are legal
  in a manifest and illegal in a pipeline schema; the translation table
  lives in `skills/synthetic-workflow-seed/SKILL.md` § step 4. Note the
  live pipeline token is `count_distinct`, NOT `distinct_count`.

  *Prior claim corrected (ace#1675).* This bullet used to say the enum
  was `count | mean | validated_rate | non_null_rate`. Only `count` of
  those four is real: `mean` is spelled `avg`, and `validated_rate` /
  `non_null_rate` are manifest-side tokens that were never pipeline
  aggregations. ace#749 fixed the same drift in
  `skills/synthetic-workflow-seed/SKILL.md` on 2026-06-12; this copy was
  not in its scope and carried the stale vocabulary for another two and
  a half months.

  No `count_where_eq` (the natural author-side expression) — to
  filter-then-count, keep `aggregation: "count"` and add
  `filter_path` + `filter_value` to the field (see the shared-path
  guardrail in `skills/synthetic-workflow-seed/SKILL.md`), or define a
  derived `field` with the filter applied at field-distribution time.
  The generator pushes the filter into the distribution layer rather
  than the aggregation layer on purpose — keeps aggregation-rule
  cardinality bounded.

- **Numeric aggregations REQUIRE `transform: "float"` on the field — and
  two of them fail SILENTLY without it.** The pipeline extracts form
  values with the JSONB text operator (`form_json->'form'->>'ppi_score'`),
  so every field arrives as **text** unless a transform casts it. What
  happens next depends on the aggregation:

  | aggregation | without `transform: "float"` | severity |
  |---|---|---|
  | `avg`, `sum` | hard error: `function avg(text) does not exist` (+ a `HINT` about explicit casts) | **loud** — you cannot ship it |
  | `min`, `max` | **succeeds, returning the lexicographic text extreme** | **silent + wrong** |
  | `count`, `count_distinct`, `count_unique`, `first`, `last`, `list` | fine — no numeric comparison happens | n/a |

  So the field must be written:

  ```yaml
  { name: "avg_ppi_score", path: "form.ppi_score",
    aggregation: "avg", transform: "float" }
  ```

  The `min`/`max` row is the one that costs money. Measured live
  (same opp/pipeline as above, `form.ppi_score`): worker `aisha_lawal`
  returned `max: "9"` untransformed versus `max: 75` with
  `transform: "float"` — `"9" > "75"` as *strings*. Untransformed
  `min` on another worker read `"10"` where the true numeric min was
  `2`. Nothing errors, nothing is null, so `fields_all_null` does not
  catch it and a demo happily displays the wrong headline number.

  **The failure only appears once the schema actually aggregates.** It is
  gated on `grouping_key` being set: with no `grouping_key` the preview
  emits no `AVG(...)`/`MAX(...)` at all, extracts the raw text per row,
  and returns `"30"` with `isError: false`. That is why an ungrouped
  smoke preview is not evidence the field is correct — re-preview with
  the real `grouping_key` before believing a numeric column.

### Practical authoring sequence

1. **Start from a working manifest from a prior run** (e.g. the
   manifest under `ACE/<opp>/runs/<latest-good>/7-synthetic/`).
   Even a different opp's manifest is closer to the canonical shape
   than a fresh-author attempt — every field has been validation-tested.

2. **Validate against `synthetic_generate_from_manifest` early** with
   a tiny scope (`shops: 1`, `cans: 1`, `weeks: 1`). The schema runs
   before the generator does any work, so a 1-row manifest tests
   schema validity for free.

3. **Layer in scale only after schema is clean.** Once the
   tiny-scope manifest validates, scale `shops`, `cans`, `weeks`,
   `flws` to the PDD's targets and re-run. Generation is fast at
   PDD-target scale (typically <30s for an `atomic-visit` opp).

## Resetting a live run's state between renders

A demo scene whose payoff is a stakeholder *creating* something (the "Create
coaching task" button on `llo_weekly_review`) writes real state onto the labs
**run**, and that state **persists across renders**. The second take finds the
control already gone and a `must_succeed` click aborts the whole render — a
failure that is order-dependent and invisible on the first pass (iteration 0
passes; every iteration after it fails on a scene that has not changed).
Measured on `spark-facilitator/20260908-2215`, DDD run
`spark-fcap-facilitation-2026-09-08-001`, labs run 5508 (workflow 5502, opp
10060) — ace#2297.

ACE's reset is `scripts/reset-labs-run-state.ts` (pure half in
`lib/labs-run-state-reset.ts`), registered per-run in the handoff by
`demo-data-setup` and run before EVERY render by the spec's
`setup: {rerun: per_render}` block — **through `bin/ace-reset-labs-run`, the
self-resolving shim, never by an absolute path into the plugin cache**
(ace#2351: a `~/.claude/plugins/cache/ace/ace/<version>/…` path keeps
resolving after `/ace:update` because the cache retains old versions, so it
ran stale code silently; `renderResetCommand()` is the canonical string).
Five things about the endpoint are pure external-system knowledge:

1. **`POST /labs/workflow/api/run/<run_id>/state/`, body NESTED as
   `{"state": {...}}`.** `update_state_api` reads `data.get("state")` and
   answers a flat body with `400 {"error": "state required in request body"}`
   (`commcare_connect/workflow/views.py`, `update_state_api`) — ace#2297.
2. **There is no `csrftoken` cookie on the labs domain.** labs runs
   `CSRF_USE_SESSIONS = True` + `CSRF_COOKIE_HTTPONLY = True`
   (`config/settings/base.py`), so the CSRF secret lives in the session and
   the token has to be read out of a rendered page's `csrfmiddlewaretoken`
   input (every page extending `base.html` has one; the workflow runner also
   exposes `data-csrf-token` on `#workflow-root`). Re-logging-in never
   produces the cookie — this is a settings-level fact, not a stale session.
3. **The write SHALLOW-MERGES.** `update_run_state` does
   `{**current_state, **sanitized}`, so `{"state": {}}` is a silent no-op and
   a reset must NAME every key it clears. There is no delete verb; overwrite
   is the only reset. (`status`, `period_start`, `period_end` are stripped
   silently — status transitions go through `complete_run` only.)
4. **A completed run refuses with `409`** ("Run is completed; state is
   immutable"). Only the interactive dashboard's run — the one
   `demo-data-setup § The interactive run stays live` deliberately leaves
   `in_progress` — is resettable, which is also the only one that needs it.
5. **WHICH keys to clear is declared, not guessed.** A workflow's mutable
   state keys are its `snapshot_inputs.state_keys` (`["worker_states",
   "spawned_tasks"]` for `llo_weekly_review`), returned by `workflow_get`
   under `saved_runs.snapshot_inputs`.

Auth is the labs **UI session** (`~/.ace/labs-session.json`, via
`/ace:labs-login`), not `LABS_MCP_TOKEN` — the endpoint is `@login_required`
+ CSRF-protected and the PAT only authenticates `/mcp/`.

## Troubleshooting

- **`401 Unauthorized` on any atom** — `LABS_MCP_TOKEN` is missing,
  expired, or revoked. Rotate via `/ace:labs-token-mint` and re-inject
  `.env`. `bin/ace-doctor` reports this at session start.

- **`PydanticValidationError: ...` on `synthetic_generate_from_manifest`**
  — see § Synthetic-manifest schema gotchas. The error names the bad
  field; map it to the table above.

- **`workflow_create_from_template` returns a workflow but the
  Workbench dashboard is empty.** The workflow needs a per-opp polish
  pass via `workflow_update_definition` /
  `workflow_patch_render_code` before its dashboard renders. The
  template is a generic skeleton; `synthetic-workflow-seed` applies the
  polish pass — don't expect a useful dashboard from a raw
  `create_from_template`.

- **A timed-out `workflow_patch_render_code` does NOT apply — re-fetch,
  do not assume a partial write.** Observed on
  `bednet-check-2-visit/20260825-1310`: the call timed out, a `workflow_get`
  showed `render_code_version` unmoved, and a single full
  `workflow_update_render_code` then succeeded. The timeout is unambiguous
  rather than a possible half-application, so the recovery is
  **re-fetch → re-derive the patch against what is actually there → retry**,
  never "assume the search string already got replaced". Assuming partial
  application is how a retry turns into an `AMBIGUOUS_MATCH` chase against a
  file that never changed. (ace#1662, secondary observation.)

- **A workflow's `render_code` is invisible to labs' Tailwind purge.** labs
  builds its bundle by scanning its own Django templates; `render_code`
  lives in the database and is never scanned, so any utility labs does not
  itself use is dropped from the shipped CSS — silently, because a missing
  utility degrades to the unstyled baseline (`bg-*` → transparent, `text-*`
  → inherited near-black, `border-*` → default grey, `h-*` → 0px) rather
  than erroring. The purge is per-UTILITY, not per-family (`text-slate-700`
  ships while `bg-slate-400` and `border-slate-400` do not), `border-*` and
  `text-*` do not mirror `bg-*`, and arbitrary values are not categorically
  blocked (`text-[11px]` ships, `min-w-[52px]` does not). ACE's preventer is
  the authoring-time lint `scripts/check-render-code-utilities.ts` (over
  `lib/tailwind-utility-resolution.ts`), wired into
  `skills/demo-data-setup` step 3b, `skills/synthetic-workflow-seed`
  § Utility-resolution gate, and `skills/synthetic-workflow-polish` step 3.
  Root cause is tracked upstream as **connect-labs#1294**; the ACE-side lint
  earns its keep regardless, because the available set drifts whenever labs
  changes its own UI. Check against ENUMERATED CSS RULES, never computed
  styles — `text-*` and `border-*` inherit `currentColor`, so a
  computed-style probe returns a plausible colour for a utility that does
  not exist and yields false passes. (ace#1662.)

- **Style `render_code` with `window.LabsReport`, not hand-written Tailwind.**
  labs publishes its shared report library on `window.LabsReport` to every
  render (source `components/workflow/report/` in connect-labs; the authoring
  guide's §4c lists it). It is the house look of the KMC and generic indicator
  reports: `ReportHeader`, `Card`, `SectionTitle`, `Tabs`, `Notice`, `Pill`,
  `Button`, `HeadlineTiles`, scorecard cells, peer and trend charts, and since
  VERSION 4 the scenario pieces (`StatTiles`, `Field`, `NumberField`,
  `RangeField`, `Segmented`, `RangeStrip`). A render built from them looks like
  every other report, picks up improvements on deploy, and sidesteps most of
  the purge trap above, because the library's own classes ship in the bundle.
  **When a render needs a look the library lacks, add it to the library** (a
  connect-labs PR with a contract test) instead of inlining it; until that
  deploys, gate on `R.VERSION` and fall back to a copy compiled from the same
  source. The utility lint above still applies to whatever page-level classes
  remain. Worked example: the KMC cost-effectiveness explorer (workflow 6627)
  and connect-labs#2178. Origin: 2026-10-03, Jon — "use the improved styling
  the semantic reports have ... we should be building up really strong styles
  we can re-use"; the explorer's first cut was hand-styled because neither the
  authoring guide nor these skills mentioned the library.

- **`award_response` succeeded but the run's `selected_llo` is null.**
  The labs `award_response` call is server-side authoritative for the
  award; the ACE-side write to the run's
  `run_state.yaml.phases.solicitation-management.products.selected_llo` is
  the `solicitation-review` skill's job. If labs shows the response as
  awarded and the run doesn't, re-run `/ace:step solicitation-review
  <opp>/<run-id>`. A second `award_response` is refused
  (FAILED_PRECONDITION), so the re-run must write `selected_llo` from the
  existing award rather than award again.

- **JSON-RPC notifications mysteriously break tool discovery.** This was
  a *proxy-era* hazard (now historical): the old stdio shim had to
  suppress replies to notifications (no `id`) or the host disabled tool
  discovery (jjackson/ace#106 finding 8). The native `type: "http"`
  transport owns JSON-RPC framing, so this class no longer exists.

- **`connect-labs` tools don't appear in `ToolSearch` after the
  headersHelper swap.** MCP wiring changes need a **full Claude Code
  restart** (not just `/reload-plugins`) — subprocesses/connections bind
  at startup. If they're still missing after a restart, the
  `headersHelper` path likely didn't resolve: confirm Claude Code is ≥
  2.1.141, and check the connect-labs MCP log for the helper's stderr
  (`[labs-auth-headers] ...`). A literal unexpanded
  `${CLAUDE_PLUGIN_ROOT}` in the helper path means expansion isn't
  happening in `headersHelper` — revert to the stdio proxy.

## Cross-reference

- Spec: `docs/superpowers/specs/2026-04-26-connect-labs-mcp-design.md`.
- Skills using these atoms: see § Capability map (grouped by resource).
- Index of every surface: [`playbook/README.md`](../README.md).
- Related learnings: `docs/learnings/2026-06-13-labs-workflow-run-deeplink.md`,
  `docs/learnings/2026-07-20-demo-workflow-ddd-native.md`.
- Token rotation: `commands/labs-token-mint.md`.

## Change log

| Date | Change |
|------|--------|
| 2026-10-18 | Capability map regrouped by resource, not phase; removed the never-built `workflows-instantiate` skill and `mbw_dashboard_*` atoms; added registry/explorer/history/supply-chain families, § A solicitation is not tied to a Connect opportunity, § Workflow template lifecycle, § Changing live labs objects |
| 2026-04-26 | Initial connect-labs MCP shipped as stdio proxy (9 atoms, Phase 8 only) |
| 2026-05-02 | Synthetic + workflows atoms added (Phase 7) |
| 2026-05-09 | `## Synthetic-manifest schema gotchas` added — captures the 5-retry tax observed on `leep-paint-collection` run `20260509-1448`; conform on first attempt to skip it |
| 2026-05-28 | Replaced the stdio→HTTP proxy with a native `type: "http"` entry + `headersHelper` (`scripts/labs-auth-headers.mjs`). Proxy retained as one-line-revert fallback pending production validation. Requires Claude Code ≥ 2.1.141. |
| 2026-05-28 | Native path confirmed in production (live `labs_context` returned the real org tree via headersHelper); removed the retired stdio proxy (`connect-labs-server.ts` + its tests). Restore from git history if a revert is ever needed. |
| 2026-09-08 | New `## Resetting a live run's state between renders` (ace#2297) — a labs run's `spawned_tasks` persists across renders, so the second take of a create-something scene aborts. Records the five endpoint facts (nested `{"state": …}` body; no `csrftoken` cookie because `CSRF_USE_SESSIONS=True`; shallow merge, so a reset must name its keys; 409 on a completed run; `snapshot_inputs.state_keys` is the declared key list) and points at `scripts/reset-labs-run-state.ts`. |
| 2026-09-10 | `## Resetting a live run's state between renders` now names `bin/ace-reset-labs-run` as the only registered entry point (ace#2351) — the per-run `render_reset.command` used to be an absolute plugin-cache path, which pins a version directory that the cache never deletes, so it kept resolving to stale code after every `/ace:update` (measured: `spark-facilitator/20260909-2242` ran 0.13.1413, pre-ace#2325). |
| 2026-08-26 | `## Troubleshooting` gains the two `render_code` findings from `bednet-check-2-visit/20260825-1310` (ace#1662): a timed-out `workflow_patch_render_code` does not apply (re-fetch before retrying), and `render_code` is invisible to labs' Tailwind purge (ACE preventer: `scripts/check-render-code-utilities.ts`; root cause upstream as connect-labs#1294). |
