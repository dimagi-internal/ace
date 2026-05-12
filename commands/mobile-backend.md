---
description: Toggle which mobile backend (cloud emulator vs local AVD) this Claude Code session uses, without touching shared .env
allowed-tools: [Bash]
---

# /ace:mobile-backend [cloud|local|status]

Set or inspect the mobile backend for **this Claude Code session only**.

State is keyed by Claude Code's parent process ID at `~/.ace/mobile-backend.<ppid>`. Two emdash workspaces (or two terminals) running in parallel pick independent backends without any shared-file edits. The `ace-mobile` MCP server re-reads the file on every call, so toggles take effect immediately — no MCP restart needed.

Resolution order in the MCP server: `process.env.ACE_MOBILE_BACKEND` (set when launching `claude`) → `~/.ace/mobile-backend.<ppid>` (set by this command) → default `local`.

## Args

- `cloud` — route mobile atoms through ace-web's cloud emulator
- `local` — route through the operator's Mac-local AVD (default)
- `status` (or no arg) — print the current effective backend + where the value came from

## Step 1: Parse the arg and dispatch

```bash
bash -c '
set -eu
ARG="${1:-status}"
STATE_DIR="$HOME/.ace"
PPID_VAL="$PPID"
FILE="$STATE_DIR/mobile-backend.$PPID_VAL"

case "$ARG" in
  cloud|local)
    mkdir -p "$STATE_DIR"
    printf "%s\n" "$ARG" > "$FILE"
    echo "Set mobile backend to: $ARG"
    echo "  Session pid:  $PPID_VAL"
    echo "  Session file: $FILE"
    if [ "$ARG" = "cloud" ]; then
      echo ""
      echo "Cloud routing requires ACE_WEB_BASE_URL + ACE_WEB_PAT_TOKEN in .env."
      echo "Verify with: /ace:doctor"
    fi
    ;;
  status|"")
    if [ -n "${ACE_MOBILE_BACKEND:-}" ]; then
      echo "Effective backend: $ACE_MOBILE_BACKEND"
      echo "  Source: process env (ACE_MOBILE_BACKEND set when launching claude)"
      echo "  Note: env wins over the session file — clear the env to use /ace:mobile-backend"
    elif [ -f "$FILE" ]; then
      VAL="$(tr -d "[:space:]" < "$FILE")"
      echo "Effective backend: $VAL"
      echo "  Source: session file"
      echo "  Path:   $FILE"
    else
      echo "Effective backend: local"
      echo "  Source: default (no env, no session file)"
      echo "  Set with: /ace:mobile-backend cloud  (or  /ace:mobile-backend local)"
    fi
    ;;
  *)
    echo "Usage: /ace:mobile-backend [cloud|local|status]" >&2
    echo "  unknown arg: $ARG" >&2
    exit 1
    ;;
esac
' _ "$1"
```

## Step 2: Tell the user

For a `cloud` or `local` set: confirm the new backend and note that mobile MCP atoms will route accordingly on their **next** call (the resolver runs per-call; no MCP restart needed).

For `status`: relay the effective backend and source verbatim.

## Rules

- This command **does not** modify `${CLAUDE_PLUGIN_DATA}/.env`. The session file is per-pid in `~/.ace/`.
- Stale session files for dead Claude Code processes are harmless — they accumulate but are tiny (<10 bytes each). Clean them periodically with `find ~/.ace -name "mobile-backend.*" -mtime +7 -delete` if desired.
- Process env (`ACE_MOBILE_BACKEND=cloud claude`) always wins over the session file. Use that when you want the backend pinned for the whole session lifetime.
