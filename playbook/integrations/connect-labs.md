# Connect-Labs Integration

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
there and re-inject `.env` via
`op inject -i .env.tpl -o $CLAUDE_PLUGIN_DATA/.env --force`.

`bin/ace-doctor`'s `[Auth liveness]` block runs a one-shot
`labs_context` against the live PAT; failure points at the rotation
command above. After any change to plugin.json's `connect-labs` wiring,
a **full Claude Code restart** is needed for it to take effect.

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
  the cryptic `unable to discriminate` error. The union is exactly
  three variants (source: `commcare_connect/labs/synthetic/generator/fixtures/manifest.py`):
  `normal` (`mean` + `stddev`), `uniform` (`low` + `high`), and
  `binary` (`rate`). `categorical` / `uniform_int` are NOT valid and
  are rejected at the labs boundary.
- **`binary` distribution: the param is `rate` (0-1), NOT `p_yes`.**
  `{ field: "slept_under_net", distribution: "binary", rate: 0.7 }` draws
  1 at 70%. To vary the rate per week — the week-scoped-anomaly
  mechanism — add `period_rates: {<week_index>: <rate>}` (week_index is
  an int), e.g. `period_rates: {2: 0.3}` drops week 2 to 30% while every
  other week keeps `rate`. Emitting `p_yes` silently fails to set the
  rate (`rate` is the required field; an unknown `p_yes` is ignored), so
  the output reverts toward the default share — the bednet-spot-check
  20260608-0711 45%-vs-requested-70% symptom (jjackson/ace#737). Source:
  `BinaryDistribution` in `.../generator/manifest.py`.

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
| 2026-05-28 | Replaced the stdio→HTTP proxy with a native `type: "http"` entry + `headersHelper` (`scripts/labs-auth-headers.mjs`). Proxy retained as one-line-revert fallback pending production validation. Requires Claude Code ≥ 2.1.141. |
| 2026-05-28 | Native path confirmed in production (live `labs_context` returned the real org tree via headersHelper); removed the retired stdio proxy (`connect-labs-server.ts` + its tests). Restore from git history if a revert is ever needed. |
