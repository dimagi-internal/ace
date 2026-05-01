---
description: Install plugin dependencies, inject .env from 1Password, verify with doctor, and optionally register auto-update
argument-hint: [--auto-update] [--force-install] [--force-env] [--skip-env] [--skip-doctor]
allowed-tools: [Bash, Read]
---

# /ace:setup

One-shot installer for the ACE plugin. Drives:

1. `npm install` at the plugin root
2. Verifies the Google service-account key at `$CLAUDE_PLUGIN_DATA/gws-sa-key.json`
3. **Injects `.env` from 1Password** (vault `AI-Agents`) via `op inject`, skipping when the existing `.env` already covers every key in `.env.tpl`
4. Optionally registers a `SessionStart` hook that runs `bin/ace-update-check` so ACE auto-updates on every new Claude Code session (`--auto-update`)
5. Runs `bin/ace-doctor` and surfaces remaining issues (Mobile, OCS, Connect, Drive)

**This is a rigid, scripted skill.** Run the bash block EXACTLY as written. Do not improvise. The real logic lives in `bin/ace-setup`; this launcher just locates and execs the script.

## Arguments

- `--auto-update` — register the `SessionStart` auto-update hook
- `--force-install` — re-run `npm install` even if `node_modules` is present
- `--force-env` — re-run `op inject` even if `.env` already has every `.env.tpl` key
- `--skip-env` — skip the `.env` injection step (e.g. CI environments that pre-populate the file)
- `--skip-doctor` — skip the trailing `bin/ace-doctor` pass

Forward `$ARGUMENTS` to the script unchanged.

## 1Password prerequisite

Before running this command:

- **Personal sign-in (interactive):** `op signin --account dimagi.1password.com`
- **Service account (non-interactive):** `export OP_SERVICE_ACCOUNT_TOKEN=ops_...` — the SA must have read access on the items referenced under `op://AI-Agents/...` in `.env.tpl`. Service-account mode skips the `--account` flag automatically.

If neither auth path is set up, `/ace:setup` fails with the exact command to run.

## Step 1: Locate bin/ace-setup and run it

```bash
bash -c '
set +e
SCRIPT=""
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -x "$CLAUDE_PLUGIN_ROOT/bin/ace-setup" ]; then
  SCRIPT="$CLAUDE_PLUGIN_ROOT/bin/ace-setup"
fi
if [ -z "$SCRIPT" ]; then
  REG="$HOME/.claude/plugins/installed_plugins.json"
  if [ -f "$REG" ]; then
    INSTALL_PATH="$(node -e "try { const d=JSON.parse(require(\"fs\").readFileSync(\"$REG\",\"utf8\")); const e=d[\"ace@ace\"]; if(Array.isArray(e)){for(const x of e){if(x&&x.installPath){console.log(x.installPath);break;}}} else if(e&&e.installPath){console.log(e.installPath);} } catch(_) {}" 2>/dev/null)"
    if [ -n "$INSTALL_PATH" ] && [ -x "$INSTALL_PATH/bin/ace-setup" ]; then
      SCRIPT="$INSTALL_PATH/bin/ace-setup"
    fi
  fi
fi
if [ -z "$SCRIPT" ]; then
  LATEST="$(ls -1d "$HOME"/.claude/plugins/cache/ace/ace/*/ 2>/dev/null | sed "s:/\$::" | sort -V | tail -1)"
  if [ -n "$LATEST" ] && [ -x "$LATEST/bin/ace-setup" ]; then
    SCRIPT="$LATEST/bin/ace-setup"
  fi
fi
if [ -z "$SCRIPT" ]; then
  D="$PWD"
  while [ "$D" != "/" ]; do
    if [ -x "$D/bin/ace-setup" ] && [ -f "$D/.claude-plugin/plugin.json" ]; then
      SCRIPT="$D/bin/ace-setup"; break
    fi
    D="$(dirname "$D")"
  done
fi

if [ -z "$SCRIPT" ]; then
  echo "FAIL launcher: could not locate bin/ace-setup"
  echo "  fix: install ACE via /plugin install ace@ace, or run from an ACE checkout"
  exit 1
fi

exec "$SCRIPT" '"$ARGUMENTS"'
'
```

## Step 2: Summarize

Read the script output and tell the user:

1. **Headline:**
   - All `PASS` lines and `STATUS: COMPLETE` exit 0 → "Setup complete — ACE is ready."
   - Any `FAIL` line → "Setup blocked — N failure(s); see below."
   - Otherwise → "Setup ran with N warnings — see below."
2. For each `FAIL`, quote the line verbatim and the `fix:` hint immediately after it.
3. For each `WARN`, list briefly. These are non-blocking but worth resolving.
4. If everything passes:
   - **If mobile is needed (Phase 5 `qa-and-training`):** suggest `/ace:mobile-bootstrap` next.
   - **Otherwise:** suggest `/ace:status` to view opportunities, or `/ace:run --dry-run` for a safe end-to-end smoke.

## Rules

- **Run EXACTLY the one bash block above.** No exploring, no extra commands.
- Never paste secrets into the chat. If the user does, warn them.
- The launcher is intentionally tiny — all logic lives in `bin/ace-setup`. Do not duplicate the script's checks here.
