---
name: ocs-bootstrap-template
description: >
  Bootstrap the ACE OCS golden template on the configured team. One-time
  (or refresh) setup that creates a chatbot ACE will clone for every new
  opportunity. Prints the resulting OCS_GOLDEN_TEMPLATE_ID to paste into
  .env.
---

# /ocs:bootstrap-template

Run this once per ACE environment (sandbox, staging, prod) to establish the
OCS chatbot that `ocs-agent-setup` clones for every new opportunity.

## When to run

- **First-time setup** of an ACE environment against a new OCS team
- **After the golden template system prompt changes** — use `OCS_BOOTSTRAP_FORCE=1` to archive and recreate
- **After a team migration** — when ACE starts using a different OCS team

## Prerequisites

1. An OCS session has been established via `/ocs:login` (session state file at `~/.ace/ocs-session-<team>.json`)
2. At least one chatbot exists on the target team to clone from (the script will auto-pick one, or you can set `OCS_BOOTSTRAP_SOURCE_ID`)
3. Environment variables: `OCS_BASE_URL`, `OCS_TEAM_SLUG`

## What it does

1. Reads the saved Playwright session state for the team
2. Lists existing chatbots on the team
3. If a bot named "ACE Golden Template" already exists: prints its id and exits (unless `OCS_BOOTSTRAP_FORCE=1`)
4. Otherwise clones the configured source chatbot (or the first one found on the team)
5. Sets the cloned pipeline's `LLMResponseWithPrompt.prompt` to the ACE-flavored system prompt skeleton
6. The clone inherits the source's LLM provider, pipeline structure, and tool wiring; it also gets a new EMBEDDED_WIDGET channel created as part of the clone step
7. Prints `OCS_GOLDEN_TEMPLATE_ID`, `OCS_GOLDEN_TEMPLATE_PUBLIC_ID`, and `OCS_GOLDEN_TEMPLATE_EMBED_KEY` for pasting into `.env`

## Usage

```bash
# Default run (clones the first chatbot found on the team)
OCS_TEAM_SLUG=<your team> \
  npx tsx scripts/bootstrap-ocs-golden-template.ts

# With an explicit source chatbot
OCS_TEAM_SLUG=<your team> \
OCS_BOOTSTRAP_SOURCE_ID=7804 \
  npx tsx scripts/bootstrap-ocs-golden-template.ts

# Force a refresh (archives the existing template and recreates)
OCS_TEAM_SLUG=<your team> \
OCS_BOOTSTRAP_SOURCE_ID=7804 \
OCS_BOOTSTRAP_FORCE=1 \
  npx tsx scripts/bootstrap-ocs-golden-template.ts
```

## Expected output

```
ACE OCS golden template bootstrap
──────────────────────────────────────────────────
  team:          <your team>
  base URL:      https://chatbots.dimagi.com
  template name: ACE Golden Template
  state file:    /Users/you/.ace/ocs-session-<team>.json

[1/5] Checking for existing golden template...
      Found N chatbot(s) on team:
        <id>: <name>
        ...

[2/5] Choosing source chatbot for the clone...
      Auto-picked source: <id> (<name>)

[3/5] Cloning source and creating widget channel...
      Cloned to experiment <new_id>
        public_id:   <uuid>
        pipeline_id: <pid>

[4/5] Setting the ACE golden template system prompt...
      Prompt patched.

[5/5] Reading embed info...
      public_id: <uuid>
      embed_key: <token>

──────────────────────────────────────────────────
Golden template bootstrapped successfully.

Add to your ACE .env:
  OCS_BASE_URL=https://chatbots.dimagi.com
  OCS_TEAM_SLUG=<your team>
  OCS_GOLDEN_TEMPLATE_ID=<new_id>
  OCS_GOLDEN_TEMPLATE_PUBLIC_ID=<uuid>
  OCS_GOLDEN_TEMPLATE_EMBED_KEY=<token>
```

The script prints real values that you should copy into your local
`.env` (which is gitignored). Do NOT paste them into `.env.example`
or any committed file.

## Troubleshooting

- **`No session state at ~/.ace/ocs-session-<team>.json`** — run `/ocs:login` first
- **`Session invalid: /a/<team>/chatbots/ returned 302`** — session expired, re-run `/ocs:login`
- **`No source chatbot available to clone from`** — the team has no chatbots yet. Create one manually or set `OCS_BOOTSTRAP_SOURCE_ID` to a chatbot id on another team this user can access
- **Template appears but prompt is unchanged after force refresh** — the old template was archived but the new clone didn't get the patch; check the script output for step [4/5] errors

## After bootstrap

The resulting `OCS_GOLDEN_TEMPLATE_ID` becomes the source that `ocs-agent-setup` clones from for every new opportunity. Each per-opp clone:

- Inherits the golden template's pipeline shape (one `LLMResponseWithPrompt` node — the golden template invariant)
- Inherits the LLM provider and model
- Has its system prompt replaced with opp-specific framing by `ocs-agent-setup`
- Gets its own Collection with the opp's IDD + training + app summaries
- Gets its own EMBEDDED_WIDGET channel (created by the clone step)
- Reports its `public_id` + `embed_key` back to Connect for the widget routing
