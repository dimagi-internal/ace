---
description: Install plugin deps, fetch GWS service-account key + .env from 1Password, verify with doctor
argument-hint: [--auto-update] [--force-install] [--force-env] [--skip-env] [--skip-doctor]
allowed-tools: [Bash, Read]
---

# /ace:setup

One-shot installer for the ACE plugin. Order is "cheap pre-flight checks first, slow state changes after, doctor last" so a missing 1Password signin fails in <1s instead of 60s. Drives:

1. Verify Node/npm, then **1Password CLI is installed + authenticated (FAST FAIL)**
2. **Fetches the Google service-account key from 1Password** (Document `ACE - Google Service Account` in vault `AI-Agents` by default; overridable via `ACE_GWS_KEY_OP_DOC`) → `$CLAUDE_PLUGIN_DATA/gws-sa-key.json`
3. `npm install` at the plugin root (skip if `node_modules` + `tsx` present)
4. **Injects `.env` from 1Password** (`op inject -i .env.tpl -o $CLAUDE_PLUGIN_DATA/.env`), skipping when the existing `.env` covers every key
5. Optionally registers a `SessionStart` hook that runs `bin/ace-update-check` so ACE auto-updates (`--auto-update`)
6. Runs `bin/ace-doctor` and surfaces remaining issues (Mobile, OCS, Connect, Drive)

**This is a rigid, scripted skill.** Run the bash block EXACTLY as written. Do not improvise. The real logic lives in `bin/ace-setup`; this launcher just locates and execs the script.

## Arguments

- `--auto-update` — register the `SessionStart` auto-update hook
- `--force-install` — re-run `npm install` even if `node_modules` is present
- `--force-env` — re-run `op inject` even if `.env` already has every `.env.tpl` key
- `--skip-env` — skip the `.env` injection step (e.g. CI environments that pre-populate the file)
- `--skip-doctor` — skip the trailing `bin/ace-doctor` pass

Forward `$ARGUMENTS` to the script unchanged.

## 1Password auth

The script handles this — if you're not signed in, `/ace:setup` fails fast with the exact `! op signin --account dimagi.1password.com` command to type in the chat. Two supported auth paths:

- **Interactive personal signin:** type `! op signin --account dimagi.1password.com` in the chat (the `!` prefix runs in this session). On Mac, alternatively enable 1Password.app → Settings → Developer → CLI integration for biometric unlock.
- **Service account (non-interactive):** add `export OP_SERVICE_ACCOUNT_TOKEN=ops_...` to your shell rc and reopen the Claude Code session. The SA must have read on every item in `.env.tpl` plus the GWS-key Document.

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
   - `FAIL op: not authenticated to 1Password` → tell the user verbatim: "Type `! op signin --account dimagi.1password.com` now (the `!` prefix runs it in this session). After it succeeds, re-run `/ace:setup`."
   - `FAIL gws_key: missing and could not auto-fetch from 1Password` → if the script printed candidate Document items, tell the user: "Pick the right item from the candidate list above and re-run with `ACE_GWS_KEY_OP_DOC='<exact name>' /ace:setup` — or if no candidate looks right, ask Jon for the SA key JSON and drop it at the path the script printed."
5. If everything passes:
   - **If mobile is needed (Phase 6 `qa-and-training`):** suggest `/ace:mobile-bootstrap` next.
   - **Otherwise:** suggest `/ace:status` to view opportunities, or `/ace:run --dry-run` for a safe end-to-end smoke.

## Rules

- **Run EXACTLY the one bash block above.** No exploring, no extra commands.
- Never paste secrets into the chat. If the user does, warn them.
- The launcher is intentionally tiny — all logic lives in `bin/ace-setup`. Do not duplicate the script's checks here.
