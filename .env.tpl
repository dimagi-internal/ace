# ── ACE Environment (generated from 1Password) ──────────────────────
#
# Generate .env from this template:
#   op inject -i .env.tpl -o .env --account dimagi.1password.com
#
# All secret references resolve from the AI-Agents vault in Dimagi's
# 1Password account. This template is safe to commit — zero secrets.

# ── OCS Integration ─────────────────────────────────────────────────

OCS_BASE_URL=https://chatbots.dimagi.com

# Team slugs
OCS_TEAM_SLUG=op://AI-Agents/ACE - Open Chat Studio/Teams/team_slug
OCS_PROD_TEAM_SLUG=op://AI-Agents/ACE - Open Chat Studio/Teams/prod_team_slug

# OCS login (Playwright backend)
OCS_USERNAME=op://AI-Agents/ACE - Open Chat Studio/username
OCS_PASSWORD=op://AI-Agents/ACE - Open Chat Studio/password

# REST backend API token (not yet provisioned)
OCS_API_TOKEN=

# Golden template (from bootstrap script output)
OCS_GOLDEN_TEMPLATE_ID=op://AI-Agents/ACE - Open Chat Studio/Config/golden_template_id
OCS_GOLDEN_TEMPLATE_PUBLIC_ID=
OCS_GOLDEN_TEMPLATE_EMBED_KEY=

# Shared Connect knowledge collection
OCS_SHARED_COLLECTION_ID=op://AI-Agents/ACE - Open Chat Studio/Config/shared_collection_id

# ── Gmail (GOG CLI) ─────────────────────────────────────────────────

ACE_GMAIL_ACCOUNT=op://AI-Agents/ACE - Open Chat Studio/Config/gmail_account
ACE_GMAIL_CLIENT=op://AI-Agents/ACE - Open Chat Studio/Config/gmail_client

# ── Paths ────────────────────────────────────────────────────────────

ACE_SESSION_STATE_DIR=~/.ace
