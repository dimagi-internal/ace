# Changelog

All notable changes to the ACE plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the plugin follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.3 — 2026-04-09

Auto-update checks are now built in — no setup step needed.

### Added

- `hooks/hooks.json` declares a native `SessionStart` hook that runs
  `bin/ace-update-check` on every new Claude Code session. This is the same
  mechanism superpowers uses. The hook loads automatically when the plugin is
  enabled — no user action, no settings.json patching, clean uninstall.

### Changed

- `/ace:doctor` now checks for `hooks/hooks.json` at the plugin root instead
  of grepping `~/.claude/settings.json` for a user-level hook. The old
  settings.json approach still works if present, but the native plugin hook is
  the canonical mechanism.

## 0.1.2 — 2026-04-09

`/ace:doctor` overhaul: the checks now actually print their messages, and the
detection logic stops getting confused when you run the doctor from inside a
dev worktree.

### Fixed

- `/ace:doctor` output lines were coming back as bare `PASS ` / `FAIL ` with
  empty messages. The helper functions in `commands/doctor.md` used `$1` / `$2`
  positional params, which Claude Code's slash-command argument expansion
  substituted with empty strings *before* bash ever saw the script. The doctor
  logic has been moved out of the slash command body into a real
  `bin/ace-doctor` script, so positional params behave normally.
- Plugin-root detection no longer silently audits a dev worktree when you meant
  to audit the installed plugin. Previously the detection walked up from `$PWD`
  before falling back to the installed cache, so running `/ace:doctor` from
  inside an ACE checkout shadowed the real install. `bin/ace-doctor` now
  defaults to auditing the copy it ships in (which, for the slash command, is
  always the installed plugin), and the launcher resolves that copy via
  `$CLAUDE_PLUGIN_ROOT` → `~/.claude/plugins/installed_plugins.json` → a
  version-sorted cache fallback.

### Added

- `bin/ace-doctor` standalone script. Supports `--here` (walk up from `$PWD`
  for dev workflows), `--installed` (force the registered install), and
  `ACE_DIR=/path` / `--root /path` overrides. Emits
  `INFO cwd_is_ace_checkout=...` when you're standing inside a different
  ACE checkout than the one being audited, so there's never ambiguity about
  which copy was checked.

## 0.1.1 — 2026-04-09

Shared Drive support for the Google Drive MCP and a clean service-account key
location that survives plugin updates.

### Fixed

- `mcp/google-drive-server.ts` now passes `supportsAllDrives: true` on every
  `drive.files.*` / `drive.permissions.create` call, and
  `includeItemsFromAllDrives: true` on list calls. Without these flags, service
  accounts hit `Service Accounts do not have storage quota` when creating docs
  even inside a Shared Drive folder, because the Drive API silently treated
  the write as a "My Drive" create. ACE skills can now write artifacts into
  the ACE Shared Drive folder.

### Changed

- Service-account key path is now resolved from the standard
  `GOOGLE_APPLICATION_CREDENTIALS` env var, which `.mcp.json` sets to
  `${CLAUDE_PLUGIN_DATA}/gws-sa-key.json`. That location is outside the
  versioned plugin cache dir, so it automatically survives `/ace:update` and
  is shared across worktrees and installs — drop the key once per machine.
  Falls back to the legacy `<plugin-root>/.gws-sa-key.json` for in-repo dev
  workflows.
- `/ace:setup` and `/ace:doctor` now probe the canonical
  `$CLAUDE_PLUGIN_DATA` path first and warn with a migration hint on legacy
  installs.
- `/ace:update` no longer copies `.gws-sa-key.json` forward on each update —
  it's in the persistent data dir now, so there's nothing to carry.
- README, design spec, and setup docs migrated off the retired
  `gws-local-dev@dimagi-chrome-extension` service account and on to
  `ace-service-account@connect-labs`, with a Shared Drive requirement note.

## 0.1.0 — 2026-04-09

Initial deploy infrastructure — ACE can now be installed, updated, and
diagnosed like a first-class Claude Code plugin.

### Added

- `.claude-plugin/marketplace.json` so ACE can be installed via
  `/plugin marketplace add jjackson/ace`. The repo root acts as both the
  marketplace and the plugin source.
- `VERSION` file as the lightweight source-of-truth for `bin/ace-update-check`.
  Must stay in lock-step with `plugin.json`, `marketplace.json`, and
  `package.json` on every release (`/ace:doctor` cross-checks them).
- `/ace:setup` — one-shot installer. Detects the plugin root, runs
  `npm install`, verifies `.gws-sa-key.json`, checks `tsx` and `.mcp.json`,
  and optionally registers a `SessionStart` hook for automatic update checks
  (`--auto-update`). Replaces the three manual README steps.
- `/ace:update` — rigid, scripted updater modelled on canopy's
  `/canopy:update`. Pulls from `~/.claude/plugins/marketplaces/ace`, rsyncs
  into a new versioned cache dir (excluding `node_modules` and the service
  account key, which are carried forward), runs `npm install`, updates
  `installed_plugins.json`, and tells the user to `/reload-plugins`.
- `/ace:doctor` — diagnostics command. Cross-checks version consistency,
  dependencies, the service account key, the MCP manifest, the update-check
  script, and related repos (`ace-web`, `connect-labs`). Prints PASS/WARN/FAIL
  with fix hints for each check.
- `bin/ace-update-check` — lightweight bash script borrowed from gstack. Reads
  local `VERSION`, curls the remote from `raw.githubusercontent.com`, caches
  in `~/.ace/update-check` (60-min TTL up-to-date, 720-min TTL
  upgrade-available), and respects a snooze file with escalating backoff
  (24h / 48h / 7d). Outputs `UPGRADE_AVAILABLE` / `JUST_UPGRADED` / nothing.
- `migrations/` directory and `migrations/README.md` explaining when to add
  version-to-version migration scripts for breaking changes.

### Changed

- README `Setup` section rewritten to describe the marketplace install
  followed by `/ace:setup` and `/ace:doctor`. Manual instructions are kept as
  a fallback for local dev checkouts.

### Inheritance notes

- **Canopy pattern (plugin manifest + marketplace + rigid update):** the
  update flow and marketplace layout are straight ports of canopy's approach,
  which has proven durable across 0.2.20 → 0.2.28 releases. ACE improves on
  canopy by carrying the service-account key forward across upgrades
  explicitly (canopy has no equivalent secret) and by running `npm install`
  inside the new cache dir so `node_modules` is always in sync with the
  updated `package.json`.
- **Gstack pattern (lightweight update-check + snooze):** `bin/ace-update-check`
  is a direct port of gstack's `bin/gstack-update-check`, minus the telemetry
  ping and the stale-Codex-description migration. The snooze levels (24h / 48h
  / 7d) and cache TTLs (60m / 720m) are kept identical — they're well-tuned
  and I didn't see a reason to deviate for a first cut.
