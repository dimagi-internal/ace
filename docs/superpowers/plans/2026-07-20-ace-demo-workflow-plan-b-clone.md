# ACE Demo Workflow — Plan B (clone provider, EU-aware)

> **Status: BLOCKED on dependency** — do not start until `26e0ace feat(connect): multi-cluster HQ registry` merges to `main`, then rebase this worktree onto it. Plan A (denovo) is the proven foundation this builds on.

**Goal:** Add the `clone` provider to `/ace:demo` — clone a real Connect opportunity (incl. the **EU-only** RUTF app) into a labs-only synthetic env, then render dashboards + narrative through the *same* Plan A spine.

**Architecture:** `clone` is a third data-source provider that converges on the identical handoff Plan A uses — the realized `${var}` map (dashboard URLs at `/labs/workflow/<def>/run/?run_id=…`). Only the *front half* differs: instead of authoring data from a brief, we profile a real opp and generate a synthetic clone of it. It reaches the real opp through the multi-cluster HQ registry (US OAuth / EU API-key).

## Hard dependency: the multi-cluster HQ registry (9619 / `26e0ace`)

The real RUTF app is **EU-only** (`eu.commcarehq.org/a/connect-rutf-master`). The 9619 session built exactly the plumbing to reach it — do NOT build a parallel EU path:
- `mcp/connect/hq-clusters.ts` — per-cluster config registry (US default + EU).
- `mcp/connect/backends/apikey-hq-session.ts` — session-less **API-key** adapter (EU uses API-key auth; US stays OAuth/session).
- `mcp/connect-server.ts` — registry of live `CommCareBackend`s keyed by server.
- `.env.tpl` EU block (`ACE_HQ_EU_*`; now quoted — see 9619 `9140533`).

**Plan B's "reach the real opp" step routes through this registry**, selecting the EU cluster (API-key) for the RUTF app.

## Provider flow (`--source clone --opp <op-id> [--cluster eu]`)

1. **Resolve the real opp via the cluster registry.** Use the `hq-clusters` registry + the API-key EU backend to reach `connect-rutf-master`; resolve its apps (`get_opportunity_apps`) and identity.
2. **Profile.** `synthetic_clone_profile` (spec_yaml with the real opportunity_id + a `bundle_root`) → per-opp profile bundles (aggregate stats + scrubbed config; no row-level data).
3. **Generate the clone.** `synthetic_clone_generate` / `synthetic_clone_to_labs_only` → labs-only opp(s) under a program_id, mirroring the real distributions.
4. **Author dashboards over the cloned opp ids** — the SAME dynamic path Plan A verified:
   - Pick templates per narrative beat (`sam_followup` for MUAC recovery, `program_admin_report` for multi-LLO). Reuse `demo-data-setup`'s template selection.
   - **Mint a run** for action-shaped dashboards via `workflow_create_run`; build the URL `…/run/?run_id=<id>&opportunity_id=<opp>` (the verified 2026-07-21 model).
5. **Fidelity gate (clone-only).** `synthetic_fidelity_report` on the bundle → a `demo-fidelity-check` QA gate ("is the clone realistic enough to show a funder?") before narrative.
6. **Narrate + render** — unchanged from Plan A (`demo-narrative` → `record_video` / DDD).

## Open design questions (resolve at build time, live)

1. **Composite rollups over cloned opps.** Plan A learned that `program_admin_report` (a multi-opp rollup) is populated by the **env-ensure ensurer chain**, not by raw fixtures. Clone yields opps+fixtures, NOT a rollup. So a program-admin dashboard over cloned RUTF data likely needs the **clone→env bridge** (synthesize an EnvManifest over the cloned opp ids + run `synthetic_env_ensure`). Per-child `sam_followup` is fixture-driven and should clone cleanly. **Confirm live; the bridge — if needed — is a connect-labs enhancement.**
2. **EU API-key surface coverage.** Confirm `synthetic_clone_profile` / `get_opportunity_apps` work through the API-key EU backend (they may assume the OAuth/session path). If not, a small labs/connect adapter gap to close.
3. **RUTF labels.** The reused `program-admin-report` env is CHC/Northern-labeled; a cloned RUTF demo wants RUTF framing → decide re-label vs. a committed `rutf-*` env (the "author a new-domain env" capability question).

## Sequencing (once unblocked)

1. Rebase onto `main` after `26e0ace` merges; confirm the `hq-clusters` registry + EU API-key backend are present.
2. `demo-data-setup` `clone` branch: registry-resolve → profile → clone-generate → realized map (reusing the run-mint + URL model).
3. `demo-fidelity-check` (+ `-eval`) gate.
4. `/ace:demo --source clone --opp <id>` end-to-end against the real EU RUTF opp; confirm dashboards render.
5. Resolve open-question #1 (clone→env bridge for the rollup) live; enhance connect-labs only if proven needed.
