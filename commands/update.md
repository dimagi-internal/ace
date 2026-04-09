---
description: Update the ACE plugin to the latest version from GitHub
allowed-tools: [Bash, Read]
---

# /ace:update

Pull the latest ACE release from GitHub, copy it into a fresh version in the
plugin cache, carry forward the user's service-account key and any user state,
reinstall dependencies, and update `installed_plugins.json`.

**This is a rigid, scripted skill.** Run the bash blocks EXACTLY as written.
Do NOT explore, ls, glob, read files, or improvise. The scripts below are the
complete procedure — there is nothing else to discover.

## Step 1: Pull and compare (ONE command)

Run this single bash command. Do NOT split it up or run anything before it:

```bash
cd ~/.claude/plugins/marketplaces/ace && git pull origin main 2>&1 && python3 -c "
import json, subprocess, sys, os

home = os.path.expanduser('~')

# Read installed version
with open(f'{home}/.claude/plugins/installed_plugins.json') as f:
    installed = json.load(f)
entry = installed.get('plugins', {}).get('ace@ace', [{}])[0]
iv = entry.get('version', 'unknown')
sha = entry.get('gitCommitSha', 'unknown')[:8]

# Read marketplace version (the repo root IS the plugin root for ACE)
with open(f'{home}/.claude/plugins/marketplaces/ace/.claude-plugin/plugin.json') as f:
    marketplace = json.load(f)
mv = marketplace['version']

# Recent commits
log = subprocess.run(['git', 'log', '--oneline', '-5'], capture_output=True, text=True).stdout.strip()

print(f'Installed: v{iv} ({sha})')
print(f'GitHub:    v{mv}')
print(f'')
print(log)
print(f'')
if iv == mv:
    print('STATUS: UP_TO_DATE')
else:
    print(f'STATUS: UPGRADE_AVAILABLE {iv} {mv}')
"
```

**Read the STATUS line at the end of the output:**
- `UP_TO_DATE` → Tell the user "Already up to date at **vX.Y.Z**." and **STOP. Do nothing else.**
- `UPGRADE_AVAILABLE <old> <new>` → Continue to Step 2.

If the `cd` or `git pull` fails, tell the user the ACE marketplace is not
installed at `~/.claude/plugins/marketplaces/ace` and **STOP**. They need to
install it first via `/plugin install ace@ace` or by adding the marketplace
with `/plugin marketplace add jjackson/ace`.

## Step 2: Install and update (ONE command)

Run this single bash command. Replace `NEW_VERSION` with the version from Step 1:

```bash
NEW_VERSION=<version from step 1> && \
mkdir -p ~/.claude/plugins/cache/ace/ace/$NEW_VERSION && \
rsync -a --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  ~/.claude/plugins/marketplaces/ace/ \
  ~/.claude/plugins/cache/ace/ace/$NEW_VERSION/ && \
cd ~/.claude/plugins/cache/ace/ace/$NEW_VERSION && \
echo "INSTALLING: npm install (may take 30-60s)" && \
npm install --silent 2>&1 | tail -10 && \
cd ~/.claude/plugins/marketplaces/ace && python3 -c "
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
    f.write(f\"{entries[0].get('version','unknown')}\n\")

if cv == mv:
    print(f'VERIFIED: v{cv} installed and matches GitHub')
else:
    print(f'MISMATCH: installed v{cv} but GitHub has v{mv}')
"
```

**Read the output:**
- `VERIFIED` → Tell the user exactly: "Updated ACE to **vX.Y.Z** (verified against GitHub). Run `/reload-plugins` to activate. Then `/ace:doctor` to confirm everything is healthy."
- `MISMATCH` → Tell the user the update failed and show the mismatch.

## Step 3: Show what's new (optional, if CHANGELOG.md exists)

If the user asks what changed, run:

```bash
awk '/^## /{c++} c>0 && c<=3' ~/.claude/plugins/marketplaces/ace/CHANGELOG.md 2>/dev/null | head -60
```

Summarize the top entry in 3-5 bullets.

## Rules

- **Run EXACTLY the two bash blocks above.** No exploring, no ls, no reading
  files (except CHANGELOG.md in Step 3), no globbing.
- Always pull from `~/.claude/plugins/marketplaces/ace` — NEVER from any
  `~/emdash-projects/ace` or dev worktree.
- If Step 1 says `UP_TO_DATE`, STOP immediately. Do not run Step 2.
- Always tell the user to run `/reload-plugins` after a successful update.
- `node_modules/` is deliberately excluded from the rsync so it's reinstalled
  fresh against the new `package.json`. The service-account key lives in
  `$CLAUDE_PLUGIN_DATA` (outside the versioned cache dir) so it automatically
  survives updates without any explicit copy-forward.
