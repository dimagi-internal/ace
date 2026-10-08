# The run's workspace — which tenants a skill writes into

A run is built in ONE ace-web workspace (`/ace:run <ws>/<opp>`; a bare `<opp>`
means the default workspace, `ACE_WEB_WORKSPACE`). The orchestrator resolves it
once at run start (`scripts/resolve-run-workspace.ts`, logic in
`lib/run-workspace.ts`) and passes the `run_workspace:` block into every phase
dispatch; `run_state.yaml` records it top-level as `workspace:`.

**When your dispatch prompt carries a `run_workspace:` block, its values
replace the `.env` ones everywhere this skill names them:**

| Skill text says | Use instead |
|---|---|
| `ACE_HQ_DOMAIN` / `<ACE_HQ_DOMAIN>` / `connect-ace-prod` as the target space | `run_workspace.hq_domain` |
| "the configured PM org" / `connect_orgs` from preflight | `run_workspace.connect_orgs` (`pm_org` = program org, `nm_org` = holding org) |
| `ACE_DRIVE_ROOT_FOLDER_ID` / "the ACE root" | `run_workspace.drive_root_folder_id` (pass as `resolve_opp_path`'s `aceRootFolderId`) |
| `${ACE_HQ_API_KEY}` as the `api_key` an opportunity's apps are read with | `run_workspace.hq_api_key` |
| `${ACE_WEB_WORKSPACE}` in an ace-web URL | `run_workspace.workspace` (or `run_state.yaml` `workspace:`) |

For the default workspace the block holds exactly the `.env` values, so nothing
changes. For a partner workspace (`is_default: false`):

- **Never fall back to `.env`.** A missing value is a halt, not a default —
  falling back builds a partner run in ACE's shared HQ space / Connect orgs,
  which is the isolation clones exist to provide.
- **HQ key.** `run_workspace.hq_api_key` is `hq-key:ace-run-<hq_domain>-<run-id>`:
  `connect-opp-setup` mints it with `commcare_create_api_key(domain:
  <hq_domain>, name: ace-run-<hq_domain>-<run-id>)` before the first
  `connect_create_opportunity` and passes the returned reference as `api_key`
  for BOTH apps (and to `connect_preflight_learn_app_user`). Per run, so it
  never rotates a key another opportunity holds. A partner's opportunity must
  never hold ACE's all-spaces `ACE_HQ_API_KEY` (`lib/hq-api-key-store.ts`).
- **Deleting an HQ app** outside `ACE_HQ_DOMAIN` (app-deploy Step 4.6) needs
  `allow_foreign_domain: <hq_domain>` — the rail names the space it overrides.
- **OCS.** `OCS_TEAM_SLUG` is fixed at MCP start; the resolver already refused
  a tenancy naming a different team. With `ocs_source: configured` the bot is
  on ACE's team and reviewed by its public link — say so in the summary.
- **Labs** needs nothing per workspace (ace-web dropped the per-opp Labs domain
  list on 2026-10-08; Labs stays Dimagi-only).
