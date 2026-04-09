# Migrations

One-shot scripts that run when a user upgrades across a breaking change in the
ACE plugin. The pattern is borrowed from gstack's `gstack-upgrade/migrations/`.

## When to add a migration

Add a migration script when a new ACE version requires any of the following on
an existing install:

- Moving or renaming files under `~/.ace/` (the user-state dir).
- Deleting a stale cached artefact that an old version left behind.
- Fixing up a corrupt config file that earlier versions produced.
- Re-registering a `SessionStart` hook because the command name or path changed.
- Anything that `/ace:setup` can't safely re-run on a clean machine.

If the change is purely additive (new commands, new skills, new MCP tools),
**no migration is needed** — `/ace:update` handles that automatically via the
rsync + `npm install` flow.

## File naming

One script per version, named for the version it migrates *to*:

```
migrations/v0.2.0.sh   # runs when upgrading TO 0.2.0 (regardless of old version)
migrations/v0.3.0.sh   # runs when upgrading TO 0.3.0
```

Scripts must be idempotent: `/ace:update` may run them more than once on rare
recovery paths.

## Template

```bash
#!/usr/bin/env bash
# migrations/vX.Y.Z.sh — one-line description of what this migrates.
set -euo pipefail

STATE_DIR="${ACE_STATE_DIR:-$HOME/.ace}"

# Example: rename a state file
if [ -f "$STATE_DIR/old-name.json" ]; then
  mv "$STATE_DIR/old-name.json" "$STATE_DIR/new-name.json"
  echo "migrated old-name.json -> new-name.json"
fi

# Example: drop a stale cache
rm -f "$STATE_DIR/stale-cache.jsonl" 2>/dev/null || true

echo "v0.X.Y migration complete"
```

## Wiring into /ace:update

`/ace:update` does **not** yet run migrations automatically (as of 0.1.0).
When the first migration is added, update `commands/update.md` to:

1. Compare old vs new version.
2. `for f in migrations/v*.sh; do [ "$(basename $f)" > "v$OLD_VERSION.sh" ] && bash "$f"; done`
3. Print which migrations ran so the user can see what changed under the hood.

See gstack's `gstack-upgrade/SKILL.md` for a reference implementation.
