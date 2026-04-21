---
description: Diagnose ACE plugin install health — version consistency, deps, key, MCP servers, external deps
allowed-tools: [Bash, Read]
---

# /ace:doctor

Diagnose the health of the installed ACE plugin. Checks version consistency,
Node dependencies, the Google service-account key, the `plugin.json` `mcpServers` manifest,
and the presence of related repos (ace-web, connect-labs). Prints each check
as PASS/WARN/FAIL with a fix hint.

**This is a rigid, scripted skill.** Run the bash block EXACTLY as written.
Do not improvise. The real logic lives in `bin/ace-doctor`; this launcher just
locates the script and execs it.

## Step 1: Locate bin/ace-doctor and run it

```bash
bash -c '
set +e
# Find the ace-doctor script. Priority:
#   1. $CLAUDE_PLUGIN_ROOT (set by Claude Code when invoking plugin commands)
#   2. Authoritative installPath from ~/.claude/plugins/installed_plugins.json
#   3. Version-sorted newest directory under ~/.claude/plugins/cache/ace/ace/*
#   4. Walk up from $PWD to find a dev checkout (fallback)
SCRIPT=""
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -x "$CLAUDE_PLUGIN_ROOT/bin/ace-doctor" ]; then
  SCRIPT="$CLAUDE_PLUGIN_ROOT/bin/ace-doctor"
fi
if [ -z "$SCRIPT" ]; then
  REG="$HOME/.claude/plugins/installed_plugins.json"
  if [ -f "$REG" ]; then
    INSTALL_PATH="$(node -e "try { const d=JSON.parse(require(\"fs\").readFileSync(\"$REG\",\"utf8\")); const e=d[\"ace@ace\"]; if(Array.isArray(e)){for(const x of e){if(x&&x.installPath){console.log(x.installPath);break;}}} else if(e&&e.installPath){console.log(e.installPath);} } catch(_) {}" 2>/dev/null)"
    if [ -n "$INSTALL_PATH" ] && [ -x "$INSTALL_PATH/bin/ace-doctor" ]; then
      SCRIPT="$INSTALL_PATH/bin/ace-doctor"
    fi
  fi
fi
if [ -z "$SCRIPT" ]; then
  LATEST="$(ls -1d "$HOME"/.claude/plugins/cache/ace/ace/*/ 2>/dev/null | sed "s:/\$::" | sort -V | tail -1)"
  if [ -n "$LATEST" ] && [ -x "$LATEST/bin/ace-doctor" ]; then
    SCRIPT="$LATEST/bin/ace-doctor"
  fi
fi
if [ -z "$SCRIPT" ]; then
  D="$PWD"
  while [ "$D" != "/" ]; do
    if [ -x "$D/bin/ace-doctor" ] && [ -f "$D/.claude-plugin/plugin.json" ]; then
      SCRIPT="$D/bin/ace-doctor"; break
    fi
    D="$(dirname "$D")"
  done
fi

if [ -z "$SCRIPT" ]; then
  echo "FAIL launcher: could not locate bin/ace-doctor"
  echo "  fix: install ACE via /plugin install ace@ace, or run from an ACE checkout"
  exit 0
fi

exec "$SCRIPT"
'
```

## Step 2: Summarize

Read the output and tell the user:

1. A one-line headline: "All checks passed" (only PASS lines) / "N warnings, M failures — see below" (mixed) / "Critical failures — ACE will not work until these are fixed" (any FAIL on node/deps/gws_key/mcp_manifest).
2. If the output contains an `INFO cwd_is_ace_checkout=` line, mention it — the user is inside a dev worktree that is NOT being audited; they can pass `--here` to `bin/ace-doctor` directly to audit that checkout instead.
3. For each **FAIL**, quote the line verbatim and tell the user the exact command from the `fix:` hint.
4. For each **WARN**, list them briefly. These are non-blocking.
5. If everything passes, suggest the next step: `/ace:status` to see opportunities, or `/ace:run` (zero-arg — smart defaults auto-pick a PDD from Drive) to kick off a fresh opp. Add `--dry-run` for a safe first try.

## Rules

- **Run EXACTLY the one bash block above.** No exploring.
- FAIL = ACE cannot function. WARN = ACE works but some feature may be degraded.
- If the launcher prints `FAIL launcher:`, stop — nothing else can be checked.
