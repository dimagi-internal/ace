---
description: Update the ACE plugin to the latest version from GitHub
allowed-tools: [Bash, Read]
---

# /ace:update

Check for a new ACE release on GitHub and, if one exists, pull it, install
dependencies, and update `installed_plugins.json`.

**This is a rigid, scripted skill.** Run the bash blocks EXACTLY as written.
Do NOT explore, ls, glob, read files, or improvise. The scripts below are the
complete procedure — there is nothing else to discover.

## Step 1: Fast version check (ONE command)

Fetches the remote VERSION via `git fetch` against the local marketplace
clone — uncached, unlike `raw.githubusercontent.com` (which is CDN-cached
1–5 minutes and would spuriously report `UP_TO_DATE` immediately after a
push). Should complete in under 2 seconds.

```bash
bash -c '
set +e
MARKETPLACE="$HOME/.claude/plugins/marketplaces/ace"
REG="$HOME/.claude/plugins/installed_plugins.json"

# Read installed version from registry
if [ ! -f "$REG" ]; then
  echo "STATUS: ERROR registry_missing"
  echo "  ~/.claude/plugins/installed_plugins.json not found."
  echo "  Install ACE first: /plugin install ace@ace"
  exit 0
fi

if [ ! -d "$MARKETPLACE/.git" ]; then
  echo "STATUS: ERROR marketplace_missing"
  echo "  $MARKETPLACE is not a git checkout."
  echo "  Re-add the marketplace: /plugin marketplace add jjackson/ace"
  exit 0
fi

IV="$(node -e "
  try {
    const d = JSON.parse(require(\"fs\").readFileSync(\"$REG\",\"utf8\"));
    const e = d[\"ace@ace\"] || (d.plugins && d.plugins[\"ace@ace\"]);
    const v = Array.isArray(e) ? e[0] : e;
    console.log(v && v.version || \"unknown\");
  } catch(_) { console.log(\"unknown\"); }
" 2>/dev/null)"
SHA="$(node -e "
  try {
    const d = JSON.parse(require(\"fs\").readFileSync(\"$REG\",\"utf8\"));
    const e = d[\"ace@ace\"] || (d.plugins && d.plugins[\"ace@ace\"]);
    const v = Array.isArray(e) ? e[0] : e;
    console.log((v && v.gitCommitSha || \"unknown\").slice(0,8));
  } catch(_) { console.log(\"unknown\"); }
" 2>/dev/null)"

# Fetch remote VERSION via git (uncached, no CDN)
git -C "$MARKETPLACE" fetch --quiet origin main 2>/dev/null
RV="$(git -C "$MARKETPLACE" show origin/main:VERSION 2>/dev/null | tr -d "[:space:]")"
if [ -z "$RV" ] || ! echo "$RV" | grep -qE "^[0-9]+\.[0-9]+\.[0-9]+$"; then
  echo "STATUS: ERROR fetch_failed"
  echo "  Could not read VERSION from origin/main in $MARKETPLACE"
  echo "  Check your network connection and that the remote is reachable."
  exit 0
fi

echo "Installed: v$IV ($SHA)"
echo "GitHub:    v$RV"
echo ""
if [ "$IV" = "$RV" ]; then
  echo "STATUS: UP_TO_DATE $IV"
else
  echo "STATUS: UPGRADE_AVAILABLE $IV $RV"
fi
'
```

**Read the STATUS line at the end of the output:**
- `UP_TO_DATE` → Tell the user "Already up to date at **vX.Y.Z**." and **STOP. Do nothing else.**
- `UPGRADE_AVAILABLE <old> <new>` → Continue to Step 2.
- `ERROR` → Show the error to the user and **STOP**.

## Step 2: Pull, install, and register (ONE command)

This is the slow step (~30-60s, mostly npm install). Replace `NEW_VERSION`
with the remote version from Step 1:

```bash
NEW_VERSION=<version from step 1> && \
cd ~/.claude/plugins/marketplaces/ace && \
OLD_SHA="$(git rev-parse HEAD)" && \
echo "PULLING: git pull origin main" && \
git pull origin main 2>&1 && \
if git diff --name-only "$OLD_SHA" HEAD | grep -qE '^mcp/'; then MCP_CHANGED=yes; else MCP_CHANGED=no; fi && \
echo "MCP code changed in this update: $MCP_CHANGED" && \
mkdir -p ~/.claude/plugins/cache/ace/ace/$NEW_VERSION && \
rsync -a --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  ~/.claude/plugins/marketplaces/ace/ \
  ~/.claude/plugins/cache/ace/ace/$NEW_VERSION/ && \
cd ~/.claude/plugins/cache/ace/ace/$NEW_VERSION && \
echo "INSTALLING: npm install (may take 30-60s)" && \
npm install --silent 2>&1 | tail -10 && \
cd ~/.claude/plugins/marketplaces/ace && MCP_CHANGED="$MCP_CHANGED" python3 -c "
import json, subprocess, os
from datetime import datetime, timezone

home = os.path.expanduser('~')
version = '$NEW_VERSION'
cache_path = f'{home}/.claude/plugins/cache/ace/ace/{version}'
sha = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')

path = f'{home}/.claude/plugins/installed_plugins.json'
with open(path) as f:
    data = json.load(f)

entries = data.get('plugins', {}).get('ace@ace', [{}])
old_version = entries[0].get('version', 'unknown')
entries[0]['version'] = version
entries[0]['installPath'] = cache_path
entries[0]['gitCommitSha'] = sha
entries[0]['lastUpdated'] = now

with open(path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')

# Verify
with open(path) as f:
    check = json.load(f)
cv = check['plugins']['ace@ace'][0]['version']
with open(f'{home}/.claude/plugins/marketplaces/ace/.claude-plugin/plugin.json') as f:
    mv = json.load(f)['version']

# Write the 'just upgraded from' marker for bin/ace-update-check
state_dir = f'{home}/.ace'
os.makedirs(state_dir, exist_ok=True)
with open(f'{state_dir}/just-upgraded-from', 'w') as f:
    f.write(f\"{old_version}\n\")

if cv == mv:
    print(f'VERIFIED: v{cv} installed and matches GitHub')
    print(f'MCP_CHANGED: {os.environ.get(\"MCP_CHANGED\", \"unknown\")}')
else:
    print(f'MISMATCH: installed v{cv} but GitHub has v{mv}')
"
```

**Read BOTH the `VERIFIED`/`MISMATCH` line and the `MCP_CHANGED` line:**
- `MISMATCH` → Tell the user the update failed and show the mismatch. **STOP.**
- `VERIFIED` + `MCP_CHANGED: no` → Tell the user exactly: "Updated ACE to **vX.Y.Z** (verified against GitHub). Run `/reload-plugins` to activate. Then `/ace:doctor` to confirm everything is healthy."
- `VERIFIED` + `MCP_CHANGED: yes` (or `unknown`) → Tell the user exactly: "Updated ACE to **vX.Y.Z** (verified against GitHub). ⚠️ This update changed MCP server code (`mcp/`). `/reload-plugins` reloads skills, commands, agents, and hooks but does **NOT** respawn the MCP subprocesses — you must **fully quit and reopen Claude Code** to pick up the new MCP behavior. Then `/ace:doctor` to confirm everything is healthy." (See CLAUDE.md § *MCP changes need a full Claude restart*. Upstream MCP schema changes — labs/OCS/Connect deploying a new `tools/list` mid-session — need the same full restart even when this check says `no`.)

## Step 3: Show what's new (optional, if CHANGELOG.md exists)

If the user asks what changed, run:

```bash
awk '/^## /{c++} c>0 && c<=3' ~/.claude/plugins/marketplaces/ace/CHANGELOG.md 2>/dev/null | head -60
```

Summarize the top entry in 3-5 bullets.

## Rules

- **Run EXACTLY the bash blocks above.** No exploring, no ls, no reading
  files (except CHANGELOG.md in Step 3), no globbing.
- Always pull from `~/.claude/plugins/marketplaces/ace` — NEVER from any
  `~/emdash-projects/ace` or dev worktree.
- If Step 1 says `UP_TO_DATE`, STOP immediately. Do not run Step 2.
- After a successful update, the activation step depends on `MCP_CHANGED`:
  `/reload-plugins` is enough for skills/commands/agents/hooks, but when the
  update touched `mcp/` (`MCP_CHANGED: yes`) only a full Claude Code restart
  respawns the MCP subprocesses. `/reload-plugins` does NOT respawn them. See
  CLAUDE.md § *MCP changes need a full Claude restart*.
- `node_modules/` is deliberately excluded from the rsync so it's reinstalled
  fresh against the new `package.json`. The service-account key lives in
  `$CLAUDE_PLUGIN_DATA` (outside the versioned cache dir) so it automatically
  survives updates without any explicit copy-forward.
