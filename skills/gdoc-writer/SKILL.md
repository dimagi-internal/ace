---
name: gdoc-writer
description: >
  Publish an ad-hoc ACE deliverable (a scripts doc, a brief, a draft for review) as a Google Doc
  authored by ace@dimagi-ai.com, filed under ACE's own Drive root in Projects/<project>/. Thin
  stub over the shared `canopy gdoc` engine. NOT for opp-run artifacts, which file under
  ACE/<opp>/runs/<run>/ through the run's own skills.
---

# Google Doc Writer — ACE (stub over the shared `canopy gdoc` engine)

The convert → file → share → verify mechanism is canopy's shared engine; the filing standard
is `$CANOPY/agent-core/deliverables.md` (one subfolder per project, never My Drive root,
share and verify before handing over a link, link don't paste). This stub declares only
ACE's specifics.

**Not for opp runs.** A run's artifacts live under `ACE/<opp>/runs/<run>/` and are reached
through the run's ace-web page (CLAUDE.md § Conventions). This is for work outside a run,
e.g. a demo's scripts doc that people edit together.

## ACE specifics

- **Author:** `config/agent.json` (`ace@dimagi-ai.com`, client `canopy`); run from an ACE
  checkout or pass `--repo <ACE root>`.
- **Root:** `$GDRIVE_ROOT_FOLDER`, from `.env.tpl` (Agent-Ace vault), materialised into the
  installed plugin's `.env` by `/ace:setup --force-env`. It is NOT in the shell
  environment, so **source the `.env` in the same Bash call as the publish**, because shell
  state does not persist between calls:

  ```bash
  ACE_ENV="$HOME/.claude/plugins/data/ace-ace/.env"
  CANOPY_ROOT="$(bash "$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json')))['plugins']['canopy@canopy'][0]['installPath'])")/scripts/canopy-runtime.sh")"
  set -a; . "$ACE_ENV"; set +a
  uv run --project "$CANOPY_ROOT" canopy gdoc publish --repo . \
    --md <file.md> --name "<Doc title>" --project "<Project>" --share none
  # iterate in place: --replace <docId>   (same link, same permissions)
  ```

- **"no Drive root resolved"** means the installed `.env` predates this key. Run
  `/ace:setup --force-env`, which keeps local-only secrets. Never use a raw `op inject` (a
  deny rail blocks it), and never paste a folder id in to work around it.
- **Sharing is an outbound act.** In a manual-mode turn, publish with `--share none`, then
  share the doc with named people only after the operator approves the send. Confirm each
  person appears in the permission list before you hand over the link (`gog drive
  permissions <docId> -a ace@dimagi-ai.com --client canopy -j`).
