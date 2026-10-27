---
description: Install plugin deps, write .env from ACE's Canopy vault, verify with doctor
argument-hint: [--agent <instance>] [--rebind] [--auto-update] [--force-install] [--force-env] [--skip-env] [--skip-doctor]
allowed-tools: [Bash, Read]
---

# /ace:setup

One-shot installer for the ACE plugin. Order is "cheap pre-flight checks first, slow state changes after, doctor last" so an unresolvable ACE instance fails in <1s instead of 60s. Drives:

1. Verify Node/npm, **resolve this install's ACE instance** (`canopy agent env --plugin ace --print`, canopy ≥ 0.2.681 — an install binds to ONE instance on canopy-web)
2. `bin/ace-install-deps`: an installed plugin gets runtime-only deps, installed once per lockfile into the data dir and linked in as `node_modules` (old cached versions are pruned); a dev checkout gets a plain `npm install`
3. **Writes `.env` from ACE's Canopy vault** (canopy-web, agent `ace`, Settings → Credentials — the one declaration of ACE's env secrets, layered over the `dimagi/Shared` workspace vault) via `canopy agent env --plugin ace` (no template; records the binding in `$CLAUDE_PLUGIN_DATA/canopy-instance.json`), preserving the local-only marker block (keys the vault does not hold, e.g. `ACE_WEB_PAT_TOKEN`). To add or rotate a value, set it in the vault, re-run with `--force-env`, and restart Claude Code
4. **Downloads `commcare-cli.jar` from `dimagi/commcare-core` releases** (latest tagged release, ~10MB, cached at `$CLAUDE_PLUGIN_DATA/commcare-cli.jar` + sidecar `.version` file). Gates Phase 3 `app-release-qa` Step 4.5 (runtime install validation). Skip with no jar already present — `--force-install` re-downloads. Requires `gh` CLI authenticated; falls back to a `WARN` if missing.
5. Optionally registers a `SessionStart` hook that runs `bin/ace-update-check` so ACE auto-updates (`--auto-update`)
6. Runs `bin/ace-doctor` and surfaces remaining issues (Mobile, OCS, Connect, Drive)

**This is a rigid, scripted skill.** Run the bash block EXACTLY as written. Do not improvise. The real logic lives in `bin/ace-setup`; this launcher just locates and execs the script.

## Arguments

- `--auto-update` — register the `SessionStart` auto-update hook
- `--force-install` — reinstall deps even if they are present
- `--force-env` — rewrite `.env` from the vault even if it is already present (after adding or rotating a vault value)
- `--agent <instance>` — the ACE instance (canopy-web agent slug) to bind to, when you can see several
- `--rebind` — re-bind this install to a different instance than the one recorded (canopy's `--force`); only when the user means to switch
- `--skip-env` — skip the `.env` injection step (e.g. CI environments that pre-populate the file)
- `--skip-doctor` — skip the trailing `bin/ace-doctor` pass
- `--print-root` — resolve the plugin root, print it, and exit. No side effects.

Forward `$ARGUMENTS` to the script unchanged.

## Google access

ACE reaches Drive/Docs/Slides/Sheets/Forms as `ace@dimagi-ai.com` with the token `canopy cred google-token --agent ace` keeps (`~/.canopy/google-token/ace.json`); there is no service-account key to fetch. `/ace:doctor`'s `google_token` check proves it works and carries the scopes.

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
    INSTALL_PATH="$(node -e "try { const d=JSON.parse(require(\"fs\").readFileSync(\"$REG\",\"utf8\")); const p=(d&&d.plugins)||d||{}; const k=p[\"ace@ace\"]?\"ace@ace\":Object.keys(p).find(k=>/^ace@/.test(k)); const e=k&&p[k]; if(Array.isArray(e)){for(const x of e){if(x&&x.installPath){console.log(x.installPath);break;}}} else if(e&&e.installPath){console.log(e.installPath);} } catch(_) {}" 2>/dev/null)"
    if [ -n "$INSTALL_PATH" ] && [ -x "$INSTALL_PATH/bin/ace-setup" ]; then
      SCRIPT="$INSTALL_PATH/bin/ace-setup"
    fi
  fi
fi
if [ -z "$SCRIPT" ]; then
  LATEST="$(ls -1d "$HOME"/.claude/plugins/cache/*/ace/*/ 2>/dev/null | sed "s:/\$::" | sort -V | tail -1)"
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

# Forward $ARGUMENTS via bash -c "$0" args. Claude Code substitutes
# $ARGUMENTS literally at command-load time; the trick below makes bash
# word-split the result safely regardless of whether ARGUMENTS is empty,
# a single flag, or multiple flags.
ARGS="$ARGUMENTS"
exec "$SCRIPT" $ARGS
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
4. **Special-case the most common first-run FAILs** with explicit hand-holding:
   - **`FAIL instance:`** → quote canopy's message verbatim (it is relayed under the FAIL line). Several instances → ask the user which one this install is for, then re-run `/ace:setup --agent <instance>`; never pick one yourself. Not signed in → `/canopy:setup`. canopy too old → `/canopy:update`.
5. **If the output contains `PASS env: wrote` or `PASS env: synced` — say the restart out loud, first, before anything else** (ace#880). `.env` was rewritten, and every MCP subprocess already running is now holding the previous values; they call `dotenvConfig()` at import and never re-read the file. Tell the user verbatim: *"`.env` was rewritten — fully quit and reopen Claude Code (Cmd-Q) before running anything else. `/reload-plugins` does NOT respawn MCP subprocesses."* Do not bury this under the PASS list: the failure mode is silent (an MCP that answers normally with stale values), and the operator has no other signal. If the script also printed a `WARN env_freshness` line, quote it — it names the exact stale pids.
6. If everything passes:
   - **If mobile is needed (Phase 6 `qa-and-training`):** suggest `/ace:mobile-bootstrap` next.
   - **Otherwise:** suggest `/ace:status` to view opportunities, or `/ace:run --dry-run` for a safe end-to-end smoke.

## Rules

- **Run EXACTLY the one bash block above.** No exploring, no extra commands.
- Never paste secrets into the chat. If the user does, warn them.
- The launcher is intentionally tiny — all logic lives in `bin/ace-setup`. Do not duplicate the script's checks here.
