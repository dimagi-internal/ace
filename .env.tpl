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

OCS_BASE_URL=https://www.openchatstudio.com

# Team slug
OCS_TEAM_SLUG=op://AI-Agents/ACE - Open Chat Studio/Teams/team_slug

# OCS login (Playwright backend)
OCS_USERNAME=op://AI-Agents/ACE - Open Chat Studio/username
OCS_PASSWORD=op://AI-Agents/ACE - Open Chat Studio/password

# REST backend API token (for observation tools: list/get chatbots, sessions).
# Referenced by UUID because the 1Password item name contains parentheses
# ("ACE - OCS REST API Key (connect-ace)"), which op-inject's parser can't
# handle in name-based references (even when percent-encoded). UUID refs
# are slightly less self-documenting but op-inject resolves them cleanly.
# If the 1Password item is ever recreated, update this UUID.
OCS_API_TOKEN=op://AI-Agents/ccfc36cyidvecda5tzhseuouie/credential

# Golden template (created by `/ace:ocs-bootstrap-template`, stored in 1Password)
OCS_GOLDEN_TEMPLATE_ID=op://AI-Agents/ACE - Open Chat Studio/Config/golden_template_id

# LLM provider and embedding model for indexed collections (from OCS team config)
OCS_LLM_PROVIDER_ID=op://AI-Agents/ACE - Open Chat Studio/Config/llm_provider_id
OCS_EMBEDDING_MODEL_ID=op://AI-Agents/ACE - Open Chat Studio/Config/embedding_model_id

# Shared Connect knowledge collection
OCS_SHARED_COLLECTION_ID=op://AI-Agents/ACE - Open Chat Studio/Config/shared_collection_id

# ── Gmail (GOG CLI) ─────────────────────────────────────────────────

ACE_GMAIL_ACCOUNT=op://AI-Agents/ACE - Open Chat Studio/Config/gmail_account
ACE_GMAIL_CLIENT=op://AI-Agents/ACE - Open Chat Studio/Config/gmail_client

# ── Google Drive ─────────────────────────────────────────────────────

ACE_DRIVE_ROOT_FOLDER_ID=1HThsA_0Lr5p1OdI5r-aQ446HlNBaySLz

# ── CommCare HQ ──────────────────────────────────────────────────────
#
# Set ACE_HQ_DOMAIN to the HQ project space ACE uploads CommCare apps
# to via the Nova plugin (`/nova:upload_to_hq`). Nova reads the actual
# target project space from whichever HQ API key is saved on its
# settings page — ACE cannot pass a domain at upload time. Setting this
# value here lets skills pre-flight that Nova's bound API key matches
# the expected domain before pushing apps.
#
# Per deployment — leave commented out in the committed template; set
# in the operator's local `.env`.

ACE_HQ_BASE_URL=https://www.commcarehq.org
# ACE_HQ_DOMAIN=
