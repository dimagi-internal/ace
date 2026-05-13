# Connect-Labs Integration

## Status

**Live.** ACE consumes labs.connect.dimagi.com via the `connect-labs`
MCP server, an HTTP-over-stdio proxy. The proxy reads `LABS_MCP_TOKEN`
from `.env`, forwards JSON-RPC frames to
`https://labs.connect.dimagi.com/mcp/`, and exposes upstream tools as
local MCP atoms.

Auth is per-user PAT (minted via `/ace:labs-token-mint`). OAuth-via-
CCHQ happens server-side inside labs's tool handlers; the proxy itself
sees only Bearer-token requests.

The proxy is one config swap away from deletion when Claude Code gains
first-class HTTP MCP support — the design intent is that labs stays
HTTP and ACE simply consumes it directly. Until then, the stdio shim
keeps the surface uniform.

## Running the MCP server

```bash
npm run mcp:connect-labs
```

Required env: `LABS_MCP_TOKEN` (per-user PAT from
`/ace:labs-token-mint`). 1Password is the source of truth; rotate
there and re-inject `.env` via
`op inject -i .env.tpl -o $CLAUDE_PLUGIN_DATA/.env --force`.

`bin/ace-doctor`'s `[Auth liveness]` block runs a one-shot
`labs_context` against the live PAT; failure points at the rotation
command above.

## Capability map (atoms used by ACE)

### Solicitations + responses (Phase 8)

| Atom | Used by |
|---|---|
| `create_solicitation` | `solicitation-create` |
| `get_solicitation` | `solicitation-create` (reuse-detection), `solicitation-monitor` |
| `update_solicitation` | `solicitation-create` (re-publish path), `solicitation-review` |
| `list_solicitations` | `solicitation-create` (program-scoped reuse check) |
| `list_responses` | `solicitation-monitor`, `solicitation-review` |
| `get_response` | `solicitation-review` |
| `create_review` / `update_review` / `list_reviews` / `get_review` | `solicitation-review` |
| `award_response` | `solicitation-review` (HITL-gated; only path that populates `opp.yaml.selected_llo`) |

### Synthetic data (Phase 7)

| Atom | Used by |
|---|---|
| `synthetic_generate_from_manifest` | `synthetic-data-generate` |
| `synthetic_register` | `synthetic-data-generate` |
| `synthetic_disable` | reversal command (no skill; operator-driven) |
| `task_create_synthetic` | (v2) |
| `get_sample_ids` | (v2) |

### Workflows (Phase 7)

| Atom | Used by |
|---|---|
| `list_templates` | `workflows-instantiate` |
| `workflow_create_from_template` | `workflows-instantiate` |
| `workflow_clone` | (v2) |
| `workflow_get` / `workflow_list` | `workflows-instantiate` (verify-after-create), `program_admin_audit` |
| `workflow_update_definition` | `workflows-instantiate` (per-opp polish) |
| `workflow_patch_render_code` / `workflow_update_render_code` | `workflows-instantiate` (per-opp polish) |
| `workflow_save_snapshot` / `workflow_set_template_flag` | (v2) |
| `workflow_create_run` | `llo_weekly_review`, `program_admin_audit` |
| `workflow_update_opportunity_ids` | (v2) |
| `workflow_delete` | reversal command (no skill; operator-driven) |

### Funds (Phase 8 / 8 future)

| Atom | Used by |
|---|---|
| `create_fund` / `update_fund` / `get_fund` / `list_funds` | (v2; budget-tier funding) |
| `add_fund_allocation` / `remove_fund_allocation` | (v2) |

### Pipelines (Phase 9 / 9 future)

| Atom | Used by |
|---|---|
| `pipeline_get` / `pipeline_list` / `pipeline_preview` / `pipeline_sql` / `pipeline_update_schema` / `pipeline_delete` | (v2; flw-data-review pipelines) |

### Context / dashboards

| Atom | Used by |
|---|---|
| `labs_context` | `bin/ace-doctor` (auth liveness probe) |
| `mbw_dashboard_v1` / `mbw_dashboard_v3` / `mbw_dashboard_diff` | (v2; Phase 9 monitoring views) |

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

- **`field_distributions` entries need an explicit `distribution`
  discriminator.** Pydantic's tagged-union dispatch is keyed on a
  `distribution: <name>` field on each entry. Dropping it produces
  the cryptic `unable to discriminate` error.
  Wrong: `{ field: "shop_count", min: 5, max: 12 }`.
  Right: `{ field: "shop_count", distribution: "uniform_int", min: 5, max: 12 }`
  (or `distribution: "normal"`, `distribution: "categorical"`, etc.,
  per the union shape).

- **`aggregation` enum is `count | mean | validated_rate |
  non_null_rate`.** No `count_where_eq` (the natural author-side
  expression). To filter-then-count, define a derived `field` with
  the filter applied at field-distribution time and aggregate that
  with `count`. The generator pushes the filter into the distribution
  layer rather than the aggregation layer on purpose — keeps
  aggregation-rule cardinality bounded.

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
  template is a generic skeleton; ACE's `workflows-instantiate` skill
  applies the polish pass automatically — don't expect a useful
  dashboard from a raw `create_from_template`.

- **`award_response` succeeded but `opp.yaml.selected_llo` is null.**
  The labs `award_response` call is server-side authoritative for the
  award, but the ACE-side write to `opp.yaml.selected_llo` is the
  `solicitation-review` skill's job. If labs shows the response as
  awarded and `opp.yaml` doesn't, re-run `/ace:step solicitation-review
  <opp>/<run-id>` — it's idempotent and writes the selected_llo block
  defensively.

- **JSON-RPC notifications mysteriously break tool discovery.** The
  proxy distinguishes JSON-RPC notifications (no `id`) from requests;
  replying to a notification (i.e., echoing back with an `id`) breaks
  the upstream's notification semantics and disables tool discovery
  on the next request. Already handled in the proxy; flagged here so
  it doesn't get accidentally "fixed" out of the source.

## Cross-reference

- Spec: `docs/superpowers/specs/2026-04-26-connect-labs-mcp-design.md`.
- Skills using these atoms:
  - Phase 7: `synthetic-data-manifest`, `synthetic-data-generate`,
    `workflows-instantiate`, `persona-walkthroughs`.
  - Phase 8: `solicitation-create`, `solicitation-monitor`,
    `solicitation-review`, `llo-invite`.
- Token rotation: `commands/labs-token-mint.md`.

## Change log

| Date | Change |
|------|--------|
| 2026-04-26 | Initial connect-labs MCP shipped as stdio proxy (9 atoms, Phase 8 only) |
| 2026-05-02 | Synthetic + workflows atoms added (Phase 7) |
| 2026-05-09 | `## Synthetic-manifest schema gotchas` added — captures the 5-retry tax observed on `leep-paint-collection` run `20260509-1448`; conform on first attempt to skip it |
