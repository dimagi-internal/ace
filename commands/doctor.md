---
description: Diagnose ACE plugin install health — version consistency, deps, key, MCP servers, external deps
allowed-tools: [Bash, Read]
---

# /ace:doctor

Diagnose the health of the local ACE plugin install. Checks version
consistency, Node dependencies, the Google service-account key, the `.mcp.json`
manifest, and the presence of related repos (ace-web, connect-labs). Prints
each check as PASS/WARN/FAIL with a fix hint.

**This is a rigid, scripted skill.** Run the bash block EXACTLY as written.
Do not improvise.

## Step 1: Run the health checks (ONE command)

```bash
bash -c '
set +e
# Detect plugin root
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json" ]; then
  ROOT="$CLAUDE_PLUGIN_ROOT"
else
  D="$PWD"
  while [ "$D" != "/" ]; do
    if [ -f "$D/.claude-plugin/plugin.json" ] && grep -q "\"name\": \"ace\"" "$D/.claude-plugin/plugin.json" 2>/dev/null; then
      ROOT="$D"; break
    fi
    D="$(dirname "$D")"
  done
  if [ -z "${ROOT:-}" ]; then
    ROOT="$(ls -1dt "$HOME"/.claude/plugins/cache/ace/ace/* 2>/dev/null | head -1)"
  fi
fi

if [ -z "${ROOT:-}" ] || [ ! -f "$ROOT/.claude-plugin/plugin.json" ]; then
  echo "FAIL plugin_root_not_found: could not locate ACE plugin"
  echo "  fix: run from an ACE checkout or after installing via /plugin install ace@ace"
  exit 1
fi
echo "INFO plugin_root=$ROOT"

pass() { echo "PASS $1"; }
warn() { echo "WARN $1"; [ -n "${2:-}" ] && echo "  fix: $2"; }
fail() { echo "FAIL $1"; [ -n "${2:-}" ] && echo "  fix: $2"; }

# --- Version consistency ---
VER_FILE="$(tr -d "[:space:]" < "$ROOT/VERSION" 2>/dev/null || echo missing)"
VER_PLUGIN="$(node -e "console.log(require(\"$ROOT/.claude-plugin/plugin.json\").version);" 2>/dev/null || echo missing)"
VER_MARKET="$(node -e "console.log(require(\"$ROOT/.claude-plugin/marketplace.json\").plugins[0].version);" 2>/dev/null || echo missing)"
VER_PKG="$(node -e "console.log(require(\"$ROOT/package.json\").version);" 2>/dev/null || echo missing)"

if [ "$VER_FILE" = "$VER_PLUGIN" ] && [ "$VER_PLUGIN" = "$VER_MARKET" ] && [ "$VER_MARKET" = "$VER_PKG" ]; then
  pass "version_consistency: all four sources agree on $VER_FILE"
else
  warn "version_consistency: VERSION=$VER_FILE plugin.json=$VER_PLUGIN marketplace.json=$VER_MARKET package.json=$VER_PKG" "bump all four in a single commit when releasing"
fi

# --- Node / npm ---
if command -v node >/dev/null 2>&1; then
  pass "node: $(node --version)"
else
  fail "node: not on PATH" "install Node.js v18+"
fi

if command -v npm >/dev/null 2>&1; then
  pass "npm: $(npm --version)"
else
  fail "npm: not on PATH" "install Node.js v18+ (bundles npm)"
fi

# --- node_modules + tsx ---
if [ -d "$ROOT/node_modules" ] && [ -x "$ROOT/node_modules/.bin/tsx" ]; then
  pass "deps: node_modules present, tsx=$($ROOT/node_modules/.bin/tsx --version 2>&1 | head -1)"
else
  fail "deps: node_modules missing or tsx not installed" "run /ace:setup"
fi

# --- Google service-account key ---
# Canonical location: $CLAUDE_PLUGIN_DATA/gws-sa-key.json (persistent across
# plugin updates). Falls back to the legacy in-repo path for pre-migration
# installs. Claude Code expands ${CLAUDE_PLUGIN_DATA} in .mcp.json at server
# launch, so the canonical path must exist whenever the plugin is installed
# from a marketplace.
if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
  DATA_DIR="$CLAUDE_PLUGIN_DATA"
else
  DATA_DIR="$HOME/.claude/plugins/data/ace-ace"
fi
CANONICAL_KEY="$DATA_DIR/gws-sa-key.json"
LEGACY_KEY="$ROOT/.gws-sa-key.json"

KEY=""
KEY_LOC=""
if [ -f "$CANONICAL_KEY" ] && [ -r "$CANONICAL_KEY" ]; then
  KEY="$CANONICAL_KEY"; KEY_LOC="canonical"
elif [ -f "$LEGACY_KEY" ] && [ -r "$LEGACY_KEY" ]; then
  KEY="$LEGACY_KEY"; KEY_LOC="legacy"
fi

if [ -n "$KEY" ]; then
  CE="$(node -e "try { console.log(JSON.parse(require(\"fs\").readFileSync(\"$KEY\",\"utf8\")).client_email); } catch(e) { console.log(\"unreadable\"); }" 2>/dev/null || echo unreadable)"
  if [ "$CE" = "unreadable" ]; then
    fail "gws_key: $KEY is not valid JSON" "re-drop the service-account key"
  elif [ "$KEY_LOC" = "legacy" ]; then
    warn "gws_key: $CE at LEGACY path $LEGACY_KEY" "migrate to $CANONICAL_KEY so it survives plugin updates: mv \"$LEGACY_KEY\" \"$CANONICAL_KEY\" && chmod 600 \"$CANONICAL_KEY\""
  else
    pass "gws_key: $CE at $CANONICAL_KEY"
  fi
else
  fail "gws_key: missing (checked $CANONICAL_KEY and $LEGACY_KEY)" "mkdir -p \"$DATA_DIR\" && drop the service-account JSON at $CANONICAL_KEY (ask Jon for the ACE key)"
fi

# --- .mcp.json sanity ---
if [ -f "$ROOT/.mcp.json" ]; then
  MCP_NAMES="$(node -e "const m=require(\"$ROOT/.mcp.json\"); console.log(Object.keys(m).join(\",\"));" 2>/dev/null || echo parse_error)"
  if [ "$MCP_NAMES" = "parse_error" ]; then
    fail "mcp_manifest: .mcp.json does not parse" "verify JSON syntax"
  else
    pass "mcp_manifest: servers=$MCP_NAMES"
    case "$MCP_NAMES" in
      *ace-gdrive*) ;;
      *) warn "mcp_manifest: ace-gdrive not declared" "restore the ace-gdrive entry in .mcp.json" ;;
    esac
  fi
else
  fail "mcp_manifest: .mcp.json missing" "restore .mcp.json at the plugin root"
fi

# --- ace-update-check binary ---
if [ -x "$ROOT/bin/ace-update-check" ]; then
  pass "update_check: bin/ace-update-check executable"
else
  warn "update_check: bin/ace-update-check missing or not executable" "chmod +x $ROOT/bin/ace-update-check"
fi

# --- Auto-update hook registration (informational) ---
if [ -f "$HOME/.claude/settings.json" ]; then
  if grep -q "ace-update-check" "$HOME/.claude/settings.json" 2>/dev/null; then
    pass "auto_update: SessionStart hook registered in ~/.claude/settings.json"
  else
    warn "auto_update: not registered" "run /ace:setup --auto-update to enable background update checks"
  fi
fi

# --- Related repos (optional, soft warnings) ---
if [ -d "$HOME/emdash-projects/ace-web" ] || [ -d "$HOME/ace-web" ]; then
  pass "ace_web: local checkout detected"
else
  warn "ace_web: no local checkout of jjackson/ace-web found" "clone if you need the browser harness"
fi

if command -v connect-mcp >/dev/null 2>&1 || [ -d "$HOME/emdash-projects/connect-labs" ]; then
  pass "connect_labs: available"
else
  warn "connect_labs: not detected" "install separately if skills need CommCare/Connect MCP tools"
fi

echo ""
echo "STATUS: COMPLETE"
'
```

## Step 2: Summarize

Read the output and tell the user:

1. A one-line headline: "All checks passed" (only PASS lines) / "N warnings, M failures — see below" (mixed) / "Critical failures — ACE will not work until these are fixed" (any FAIL on node/deps/gws_key/mcp_manifest).
2. For each **FAIL**, quote the line verbatim and tell the user the exact command from the `fix:` hint.
3. For each **WARN**, list them briefly. These are non-blocking.
4. If everything passes, suggest the next step: `/ace:status` to see opportunities, or `/ace:run <opp-name>` to try a dry-run.

## Rules

- **Run EXACTLY the one bash block above.** No exploring.
- FAIL = ACE cannot function. WARN = ACE works but some feature may be degraded.
- If `plugin_root_not_found`, stop after Step 1 — nothing else can be checked.
