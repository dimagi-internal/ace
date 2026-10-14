---
description: Toggle which mobile backend (local AVD, leased cloud emulator, or legacy ace-web cloud) this Claude Code session uses, without touching shared .env
allowed-tools: [Bash]
---

# /ace:mobile-backend [local|lease|cloud|status]

Set or inspect the mobile backend for **this Claude Code session only**.

State is keyed by Claude Code's parent process ID at `~/.ace/mobile-backend.<ppid>`. Two emdash workspaces (or two terminals) running in parallel pick independent backends without any shared-file edits. The `ace-mobile` MCP server re-reads the file on every call, so toggles take effect immediately — no MCP restart needed.

Resolution order in the MCP server (`mcp/mobile/backend-toggle.ts`): `process.env.ACE_MOBILE_BACKEND` (set when launching `claude`) → `~/.ace/mobile-backend.<ppid>` (set by this command) → default: `local` when a provisioned AVD exists on this machine (an `.ace-provisioned.json` marker under `$ANDROID_AVD_HOME`, default `~/.android/avd` — written only after a real bootstrap succeeded), else `lease`.

## Args

- `local` — route through this machine's AVD
- `lease` — lease ACE's own ephemeral `android-emulator` machine from canopy-web's capability broker (one machine per session, terminated on release). Needs ACE's `CANOPY_WEB_PAT` and a capability grant — `/ace:doctor` reports both under `capability_lease`.
- `cloud` — LEGACY: ace-web's one shared `/api/mobile` instance. Kept for one release while `lease` is proven live; prefer `lease`.
- `status` (or no arg) — print the current effective backend + where the value came from

## Step 1: Parse the arg and dispatch

```bash
bash -c '
set -eu
ARG="${1:-status}"
STATE_DIR="$HOME/.ace"
PPID_VAL="$PPID"
FILE="$STATE_DIR/mobile-backend.$PPID_VAL"

AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.android/avd}"
default_backend() {
  if ls "$AVD_HOME"/*.avd/.ace-provisioned.json >/dev/null 2>&1; then
    echo "local"
  else
    echo "lease"
  fi
}

case "$ARG" in
  cloud|local|lease)
    mkdir -p "$STATE_DIR"
    printf "%s\n" "$ARG" > "$FILE"
    echo "Set mobile backend to: $ARG"
    echo "  Session pid:  $PPID_VAL"
    echo "  Session file: $FILE"
    if [ "$ARG" = "lease" ]; then
      echo ""
      echo "Lease routing needs ACE's CANOPY_WEB_PAT in .env and a canopy-web grant for ace/android-emulator."
      echo "Verify with: /ace:doctor  (capability_lease)"
    fi
    if [ "$ARG" = "cloud" ]; then
      echo ""
      echo "LEGACY backend (ace-web /api/mobile) — prefer: /ace:mobile-backend lease"
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
      DEF="$(default_backend)"
      echo "Effective backend: $DEF"
      if [ "$DEF" = "local" ]; then
        echo "  Source: default (no env, no session file; a provisioned AVD exists in $AVD_HOME)"
      else
        echo "  Source: default (no env, no session file; no provisioned AVD in $AVD_HOME)"
      fi
      echo "  Set with: /ace:mobile-backend local | lease | cloud"
    fi
    ;;
  *)
    echo "Usage: /ace:mobile-backend [local|lease|cloud|status]" >&2
    echo "  unknown arg: $ARG" >&2
    exit 1
    ;;
esac
' _ "$1"
```

## Step 2: Tell the user

For a `local`, `lease` or `cloud` set: confirm the new backend and note that mobile MCP atoms will route accordingly on their **next** call (the resolver runs per-call; no MCP restart needed).

For `status`: relay the effective backend and source verbatim.

## Rules

- This command **does not** modify `${CLAUDE_PLUGIN_DATA}/.env`. The session file is per-pid in `~/.ace/`.
- Stale session files for dead Claude Code processes are harmless — they accumulate but are tiny (<10 bytes each). Clean them periodically with `find ~/.ace -name "mobile-backend.*" -mtime +7 -delete` if desired.
- Process env (`ACE_MOBILE_BACKEND=lease claude`) always wins over the session file. Use that when you want the backend pinned for the whole session lifetime.
