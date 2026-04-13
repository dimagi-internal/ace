# ── ACE Environment (generated from 1Password) ──────────────────────
#
# Generate .env for the installed plugin:
#   op inject -i .env.tpl -o ~/.claude/plugins/data/ace-ace/.env --account dimagi.1password.com
#
# Or for local dev (repo worktree):
#   op inject -i .env.tpl -o .env --account dimagi.1password.com
#
# The MCP server loads from $CLAUDE_PLUGIN_DATA/.env (plugin) or ./.env (dev).
# All secret references resolve from the AI-Agents vault in Dimagi's 1Password.

# ── OCS Integration ─────────────────────────────────────────────────

OCS_BASE_URL=https://chatbots.dimagi.com

# Team slugs
OCS_TEAM_SLUG=op://AI-Agents/ACE - Open Chat Studio/Teams/team_slug
OCS_PROD_TEAM_SLUG=op://AI-Agents/ACE - Open Chat Studio/Teams/prod_team_slug

# OCS login (Playwright backend)
OCS_USERNAME=op://AI-Agents/ACE - Open Chat Studio/username
OCS_PASSWORD=op://AI-Agents/ACE - Open Chat Studio/password

# REST backend API token (for observation tools: list/get chatbots, sessions)
OCS_API_TOKEN=op://AI-Agents/ACE - OCS REST API Key (connect-ace)/credential

# Golden template (from bootstrap script output)
OCS_GOLDEN_TEMPLATE_ID=op://AI-Agents/ACE - Open Chat Studio/Config/golden_template_id
OCS_GOLDEN_TEMPLATE_PUBLIC_ID=
OCS_GOLDEN_TEMPLATE_EMBED_KEY=

# Shared Connect knowledge collection
OCS_SHARED_COLLECTION_ID=op://AI-Agents/ACE - Open Chat Studio/Config/shared_collection_id

# ── Gmail (GOG CLI) ─────────────────────────────────────────────────

ACE_GMAIL_ACCOUNT=op://AI-Agents/ACE - Open Chat Studio/Config/gmail_account
ACE_GMAIL_CLIENT=op://AI-Agents/ACE - Open Chat Studio/Config/gmail_client

# ── Google Drive ─────────────────────────────────────────────────────

ACE_DRIVE_ROOT_FOLDER_ID=1HThsA_0Lr5p1OdI5r-aQ446HlNBaySLz

# ── Paths ────────────────────────────────────────────────────────────

ACE_SESSION_STATE_DIR=~/.ace
