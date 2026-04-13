---
description: Install plugin dependencies, verify the Google service-account key, and optionally register auto-update
argument-hint: [--auto-update] [--force-install]
allowed-tools: [Bash, Read, Write, AskUserQuestion]
---

# /ace:setup

One-shot installer for the ACE plugin. Runs `npm install` at the plugin root,
verifies the Google service-account key is in place, sanity-checks `tsx` and
the MCP manifest, and (optionally) registers a `SessionStart` hook so ACE
auto-updates on every new Claude Code session.

**This is a rigid, scripted skill.** Run the bash blocks EXACTLY as written.
Do not improvise, explore, or read other files. The scripts below are the
complete procedure — there is nothing else to discover.

## Arguments

- `--auto-update` — after setup, register a `SessionStart` hook that runs
  `bin/ace-update-check` at the beginning of every Claude Code session.
- `--force-install` — skip the "node_modules already present" shortcut and
  always run `npm install`.

Parse `$ARGUMENTS` for these flags. Default: no flags.

## Step 1: Detect plugin root and run checks (ONE command)

Run this single bash block. Do NOT split it or run anything before it:

```bash
bash -c '
set -e
# Detect plugin root: CLAUDE_PLUGIN_ROOT if the harness set it, else walk up
# from $PWD looking for .claude-plugin/plugin.json.
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json" ]; then
  ROOT="$CLAUDE_PLUGIN_ROOT"
else
  # Walk up from CWD
  D="$PWD"
  while [ "$D" != "/" ]; do
    if [ -f "$D/.claude-plugin/plugin.json" ] && [ -f "$D/package.json" ]; then
      # Confirm this is the ACE plugin by grepping the name
      if grep -q "\"name\": \"ace\"" "$D/.claude-plugin/plugin.json" 2>/dev/null; then
        ROOT="$D"
        break
      fi
    fi
    D="$(dirname "$D")"
  done
  # Fallback: marketplace cache
  if [ -z "${ROOT:-}" ]; then
    ROOT="$(find "$HOME/.claude/plugins/cache/ace" -maxdepth 3 -name plugin.json -path "*/.claude-plugin/*" -exec dirname {} \; 2>/dev/null | xargs -I{} dirname {} | head -1)"
  fi
fi

if [ -z "${ROOT:-}" ] || [ ! -f "$ROOT/package.json" ]; then
  echo "STATUS: ERROR plugin_root_not_found"
  echo "ACE plugin root could not be located. Looked in \$CLAUDE_PLUGIN_ROOT, parent dirs of \$PWD, and ~/.claude/plugins/cache/ace/."
  exit 1
fi

echo "PLUGIN_ROOT: $ROOT"
cd "$ROOT"

# --- Prerequisite checks ---
command -v node >/dev/null 2>&1 || { echo "STATUS: ERROR node_missing"; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "STATUS: ERROR npm_missing";  exit 1; }
NODE_VER="$(node --version)"
echo "NODE_VERSION: $NODE_VER"

# --- Install dependencies ---
FORCE_INSTALL="${ACE_FORCE_INSTALL:-0}"
if [ "$FORCE_INSTALL" = "1" ] || [ ! -d "node_modules" ] || [ ! -d "node_modules/tsx" ]; then
  echo "INSTALLING: npm install (may take 30-60s)"
  npm install --silent 2>&1 | tail -20
  echo "INSTALL_STATUS: $?"
else
  echo "INSTALLING: skipped (node_modules already present, pass --force-install to redo)"
fi

# --- Verify tsx is resolvable ---
if [ -x "node_modules/.bin/tsx" ]; then
  echo "TSX: $(node_modules/.bin/tsx --version 2>&1 | head -1)"
else
  echo "TSX: missing (expected at node_modules/.bin/tsx)"
fi

# --- Check for the Google service-account key ---
# Preferred location: $CLAUDE_PLUGIN_DATA/gws-sa-key.json — persistent across
# plugin updates and shared across worktrees. Claude Code sets
# $CLAUDE_PLUGIN_DATA when the plugin is loaded; if this script is run from a
# bare checkout we compute the canonical path the same way Claude Code would
# (~/.claude/plugins/data/<plugin>-<marketplace>/).
if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
  DATA_DIR="$CLAUDE_PLUGIN_DATA"
else
  DATA_DIR="$HOME/.claude/plugins/data/ace-ace"
fi
mkdir -p "$DATA_DIR"
CANONICAL_KEY="$DATA_DIR/gws-sa-key.json"
LEGACY_KEY="$ROOT/.gws-sa-key.json"

KEY_PATH=""
if [ -f "$CANONICAL_KEY" ] && [ -r "$CANONICAL_KEY" ]; then
  KEY_PATH="$CANONICAL_KEY"
elif [ -f "$LEGACY_KEY" ] && [ -r "$LEGACY_KEY" ]; then
  KEY_PATH="$LEGACY_KEY"
fi

if [ -n "$KEY_PATH" ]; then
  CLIENT_EMAIL="$(node -e "try { console.log(JSON.parse(require(\"fs\").readFileSync(\"$KEY_PATH\",\"utf8\")).client_email); } catch(e) { console.log(\"unreadable\"); }" 2>/dev/null || echo "unreadable")"
  if [ "$KEY_PATH" = "$CANONICAL_KEY" ]; then
    echo "GWS_KEY: ok ($CLIENT_EMAIL) at canonical $CANONICAL_KEY"
  else
    echo "GWS_KEY: ok ($CLIENT_EMAIL) at LEGACY path $LEGACY_KEY"
    echo "GWS_KEY_MIGRATE: move to $CANONICAL_KEY so it survives plugin updates"
  fi
else
  echo "GWS_KEY: MISSING — drop your service-account JSON at $CANONICAL_KEY"
  echo "GWS_KEY_HINT: mkdir -p \"$DATA_DIR\" && mv /path/to/key.json \"$CANONICAL_KEY\" && chmod 600 \"$CANONICAL_KEY\""
fi

# --- Check .mcp.json ---
if [ -f ".mcp.json" ]; then
  MCP_SERVERS="$(node -e "const m=require(\"./.mcp.json\"); console.log(Object.keys(m).join(\",\"));" 2>/dev/null || echo "parse_error")"
  echo "MCP_SERVERS: $MCP_SERVERS"
else
  echo "MCP_SERVERS: .mcp.json missing"
fi

# --- Check VERSION file matches plugin.json ---
VER_FILE="$(cat VERSION 2>/dev/null | tr -d "[:space:]" || echo "missing")"
VER_PLUGIN="$(node -e "console.log(require(\"./.claude-plugin/plugin.json\").version);" 2>/dev/null || echo "missing")"
if [ "$VER_FILE" = "$VER_PLUGIN" ]; then
  echo "VERSION: $VER_FILE (matches plugin.json)"
else
  echo "VERSION: MISMATCH (VERSION=$VER_FILE plugin.json=$VER_PLUGIN)"
fi

echo "STATUS: OK"
'
```

## Step 2: Interpret the output

Read the output line-by-line:

- `STATUS: OK` — Setup succeeded. Continue to Step 3.
- `STATUS: ERROR plugin_root_not_found` — Tell the user the plugin root couldn't be found. Ask them to run this from inside a Claude Code session that has ACE installed, or from their local ACE checkout. **STOP.**
- `STATUS: ERROR node_missing` or `npm_missing` — Tell the user to install Node.js (v18+). **STOP.**
- `GWS_KEY: MISSING …` — Include the exact path in your message and tell the user: "Drop your Google service-account JSON at `<path>` (use the `GWS_KEY_HINT` command to create the dir and chmod the file). Ask Jon for the ACE key if you don't have one (service account: `ace-service-account@connect-labs.iam.gserviceaccount.com`)."
- `GWS_KEY: ok … at LEGACY path …` — The key still works but lives in the plugin checkout dir, which gets wiped on plugin updates. Show the user the `GWS_KEY_MIGRATE` line and offer to move it: `mv <legacy> <canonical> && chmod 600 <canonical>`.
- `TSX: missing` or `INSTALL_STATUS` nonzero — Tell the user `npm install` failed; show the last ~20 lines of output and ask them to fix the underlying npm error.
- `VERSION: MISMATCH` — Warn the user and tell them to open an issue; this should never happen in a clean install.

## Step 3: Optional auto-update registration

If the user passed `--auto-update`, AND Step 1 printed `STATUS: OK`, run:

```bash
bash -c '
set -e
ROOT="'"$ROOT"'"  # reuse the detected root from Step 1
HOOK_SCRIPT="$ROOT/bin/ace-update-check"
if [ ! -x "$HOOK_SCRIPT" ]; then
  echo "AUTO_UPDATE: ERROR ace-update-check not executable at $HOOK_SCRIPT"
  exit 1
fi

SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo "{}" > "$SETTINGS"

# Use python to splice in the hook without clobbering other settings
python3 - "$SETTINGS" "$HOOK_SCRIPT" <<"PY"
import json, sys
path, hook_cmd = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
hooks = data.setdefault("hooks", {})
session_start = hooks.setdefault("SessionStart", [])
# Deduplicate: remove any existing ace-update-check entries
session_start = [h for h in session_start if "ace-update-check" not in json.dumps(h)]
session_start.append({
    "matcher": "*",
    "hooks": [{"type": "command", "command": hook_cmd, "async": True}],
})
hooks["SessionStart"] = session_start
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print("AUTO_UPDATE: registered SessionStart hook ->", hook_cmd)
PY
'
```

**Interpret:**
- `AUTO_UPDATE: registered …` — Tell the user: "Auto-update registered. Every new Claude Code session will check for ACE updates in the background."
- `AUTO_UPDATE: ERROR …` — Tell the user what went wrong and that they can still run `/ace:update` manually.

## Step 4: Summarize

Tell the user exactly what state they're in:

1. Plugin root and version.
2. Whether dependencies were installed or skipped.
3. Whether the service-account key is present (and which account) or missing (with drop-in path).
4. Whether auto-update was registered (if requested).
5. Next step: either "Restart your Claude Code session so the MCP servers load." (if anything changed) or "You're ready — try `/ace:status` to see the current opportunities." (if nothing changed).

## Rules

- **Run EXACTLY the two bash blocks above.** No exploring, no ls, no reading files, no globbing.
- Never commit the service-account key. If the user pastes it into the chat, warn them.
- If Step 1 reports any `ERROR`, do not run Step 2.
