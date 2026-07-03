# ── ACE Environment (generated from 1Password) ──────────────────────
#
# Generate / refresh .env for the installed plugin — USE:
#   /ace:setup --force-env        (or: bash bin/ace-setup --force-env)
#
# ⚠️ Do NOT run a raw `op inject -i .env.tpl -o <plugin-data>/.env` — it
# overwrites the whole file and DROPS local-only secrets that aren't in this
# template (ACE_WEB_PAT_TOKEN, minted per-machine via /ace:ace-web-pat-mint,
# and anything else you added by hand). `/ace:setup --force-env` snapshots the
# `# --- ACE local-only secrets ---` marker block and re-appends it after the
# inject, so those survive. (A PreToolUse rail — config/gating.json — blocks the
# raw form for Claude; it can't stop a human terminal — hence this warning.)
#
# For local dev in a repo worktree (no local-only secrets to lose), a raw
# inject to ./.env is fine:
#   op inject -i .env.tpl -o .env --account dimagi.1password.com
#
# The MCP server loads from $CLAUDE_PLUGIN_DATA/.env (plugin) or ./.env (dev).
# All secret references resolve from the AI-Agents vault in Dimagi's 1Password.
#
# ⚠️ AUTHOR CONTRACT (jjackson/ace#753): adding a 1Password secret reference here
# REQUIRES the field to ALREADY EXIST — `op read '<the ref>'` must succeed first.
# (Do NOT write a bare op-scheme reference in a comment: `op inject` scans the
# whole file and aborts on it, even inside a `#` line.)
# `op inject` is ALL-OR-NOTHING: ONE unresolvable ref makes the entire render
# fail and writes an EMPTY .env for every consumer (a silent breakage that
# burned a week of headless runs). If the field isn't ready yet, land the line
# COMMENTED OUT. `/ace:doctor`'s env_tpl_render probe test-renders this file and
# FAILs naming any ref that can't resolve — run it after editing.

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

# ── Multi-team REST tokens (optional) ────────────────────────────────
# The REST observation atoms (`ocs_get_me`, `ocs_list_chatbots`,
# `ocs_inspect_chatbot`) accept an optional `team_slug` argument. When supplied,
# the MCP server resolves the token from a matching `OCS_API_TOKEN_<SLUG>` env
# var (slug uppercased, non-alphanumeric → `_`). Omitting the arg falls back to
# `OCS_API_TOKEN` + `OCS_TEAM_SLUG` above. Each team key still hangs off a
# specific user account (via `UserAPIKey`) and the `read_only=true` flag is
# enforced framework-side at the HTTP method layer.
#
# Add one line per team you also want read access to:
OCS_API_TOKEN_VACCINE_COACH=op://AI-Agents/h6m2u53h364ifenhu2toe67ceu/credential

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

# ── Solicitations ───────────────────────────────────────────────────

# ── Google Drive ─────────────────────────────────────────────────────

ACE_DRIVE_ROOT_FOLDER_ID=1HThsA_0Lr5p1OdI5r-aQ446HlNBaySLz

# ── CommCare HQ ──────────────────────────────────────────────────────
#
# ACE_HQ_DOMAIN is the HQ project space ACE uploads CommCare apps to
# via the Nova plugin (`/nova:upload_to_hq`). Nova reads the actual
# target project space from whichever HQ API key is saved on its
# settings page — ACE cannot pass a domain at upload time. This value
# lets skills pre-flight that Nova's bound API key matches the
# expected domain before pushing apps.
#
# Sourced from 1Password — add a `domain` field to the
# `ACE - CommCareHQ` item in the AI-Agents vault with the value for
# your deployment (e.g. `connect-ace-prod` for production). For a
# staging-domain dev workflow, point this at a different 1Password
# field or override the resolved `.env` after `op inject`.
# `bin/ace-doctor` warns when ACE_HQ_DOMAIN is unset or
# != connect-ace-prod after op inject.

ACE_HQ_BASE_URL=https://www.commcarehq.org
ACE_HQ_DOMAIN=op://AI-Agents/ACE - CommCareHQ/domain

# CommCare HQ API key for ace@dimagi-ai.com on connect-ace-prod.
# Connect's `connect_create_opportunity` REST endpoint validates this
# against CCHQ before it will create the opp. Item name contains
# parentheses → use UUID reference (same pattern as OCS_API_TOKEN above).
# If the 1Password item is ever recreated, update this UUID.
ACE_HQ_API_KEY=op://AI-Agents/juii2ov6xju5s4n73qlz7jutli/credential

# ── Connect (ace-connect MCP) ────────────────────────────────────────
#
# ace-connect drives connect.dimagi.com through an authenticated browser
# session belonging to ace@dimagi-ai.com. Login is OAuth-via-CommCareHQ:
# Connect bounces to HQ, HQ accepts these creds, HQ redirects back.
#
# When real Connect REST APIs land (CCC-301 + invite + invoice), individual
# atoms flip from PLAYWRIGHT to REST in mcp/connect/capability-map.ts.

CONNECT_BASE_URL=https://connect.dimagi.com

# CommCare HQ credentials for the ACE service account. ace-connect drives
# the HQ OAuth flow with these to mint a Connect session cookie.
ACE_HQ_USERNAME=op://AI-Agents/ACE - CommCareHQ/username
ACE_HQ_PASSWORD=op://AI-Agents/ACE - CommCareHQ/password

# ── Nova (CommCare app builder MCP) ──────────────────────────────────
#
# Nova's MCP server lives at https://mcp.commcare.app/mcp. Nova plugin
# v1.1.0+ reads this value from the Claude Code parent shell's env via
# a headersHelper in its .mcp.json and sends it as
# `Authorization: Bearer …` on every Nova MCP call. See
# voidcraft-labs/nova-plugin#11 / #13 / #16.
#
# Mint a key at https://commcare.app/settings → Sign in as the ACE
# Gmail identity → API Keys → New (Read+Write floor; HQ scopes are
# required for /nova:upload_to_hq). Save the `sk-nova-v1-…` value to
# the 1Password item "ACE - Nova" / field `api_key`.
#
# After /ace:setup writes `.env` from 1Password, it also writes
# `~/.ace/env.sh` (containing `export NOVA_API_KEY=…`) AND auto-appends
# a marker-fenced source line to the right shell rc (since 0.13.298):
#   macOS+zsh → ~/.zshenv | macOS+bash → ~/.bash_profile
#   Linux+zsh → ~/.zshrc  | Linux+bash → ~/.bashrc
# Restart Claude Code (Cmd-Q + reopen) after setup so the Nova plugin's
# headersHelper reads NOVA_API_KEY from the new shell env. Pass
# /ace:setup --no-shell-edit to opt out of the rc edit. See
# playbook/integrations/nova-integration.md.
NOVA_API_KEY=op://AI-Agents/ACE - Nova/api_key

# ── Connect Labs (solicitations / reviews / awards) ─────────────────
#
# Bearer PAT for the labs MCP at labs.connect.dimagi.com/mcp/. ACE's
# connect-labs stdio proxy reads this and injects it as the
# Authorization header on every JSON-RPC frame forwarded to labs.
# To rotate: a labs admin runs:
#   python manage.py mcp_create_token --user ace@dimagi-ai.com --name ACE-plugin --ttl-days 0
# then drops the printed token into the 1Password item below.
LABS_MCP_TOKEN=op://AI-Agents/ACE - Connect Labs/mcp_token

# ─── ACE Mobile Emulation ──────────────────────────────────────────
# Local-Mac-only. Populated once via /ace:mobile-bootstrap.
ACE_E2E_PHONE=op://AI-Agents/connect-test-user/phone
ACE_E2E_PHONE_LOCAL=op://AI-Agents/connect-test-user/phone-local
ACE_E2E_COUNTRY_CODE=op://AI-Agents/connect-test-user/country-code
ACE_E2E_PIN=op://AI-Agents/connect-test-user/pin
ACE_E2E_BACKUP_CODE=op://AI-Agents/connect-test-user/backup-code
ACE_E2E_NAME="ACE Test"
ACE_AVD_NAME=ACE_Pixel_API_34

# Pinned Connect APK version. Read by:
#   - `bin/ace-doctor` `selector_map_currency` probe (warns when this !=
#     the newest `mcp/mobile/selectors/connect-*.yaml` selector map).
#   - `skills/connect-baseline-screenshots` + `skills/training-flw-guide`
#     for selector resolution + reference framing.
# Bump in lockstep when a new selector map lands under
# `mcp/mobile/selectors/connect-<version>.yaml`. Inline literal (not 1P-backed)
# because it's a public Connect APK version, not a secret, and changes via PR.
ACE_CONNECT_APK_VERSION=2.63.0

# Local AVD port pinning. Set to override; LEAVE UNSET for auto-allocation.
#
# When unset, ACE's local AVD backend probes TCP ports on every MCP session
# and picks the first free pair starting at adb 5037 + emulator console
# 5554/5555. This means two concurrent `/ace:run` cycles on the same
# laptop get distinct adb-server + emulator instances — no collision.
#
# Set explicitly when you need DETERMINISTIC ports: shared CI runners that
# expect a fixed adb-server, multi-user macOS hosts that want one user
# pinned and the other on auto, or debugging where you want to attach
# `adb -P <port>` from a separate shell.
#
#   ANDROID_ADB_SERVER_PORT must be 1-65535.
#   ACE_MOBILE_EMULATOR_PORT must be EVEN and in [5554, 5680] — the
#     emulator binary refuses values outside that range, and console+
#     adb-bridge are always allocated as a consecutive even/odd pair.
#
# Both are honored natively by adb + emulator; ACE injects them into
# spawned children via `mcp/mobile/backends/avd.ts` + `port-allocator.ts`.
#
# ⚠ Leave BOTH unset on any machine that runs ACE sessions in parallel.
# Setting either DISABLES the per-session dynamic allocator (env wins in
# port-allocator.ts), forcing every session onto the same fixed ports →
# adb-server / emulator-console collisions. Pin only for a single
# deliberate debug session, and set it in that session's env — not here.
# ANDROID_ADB_SERVER_PORT=
# ACE_MOBILE_EMULATOR_PORT=

# ── Content Generator (image gen for app-multimedia-coverage) ───────
#
# Dimagi's internal image-generation service (Cloud Run, Gemini-3-Flash).
# Used by the app-multimedia-coverage skill to attach display-only images
# to CommCare app questions.
#
# 1Password item: "Content Generator API" in AI-Agents vault.
#   - hostname  → CONTENT_GENERATOR_URL
#   - credential → CONTENT_GENERATOR_API_KEY (Google Cloud API key)

CONTENT_GENERATOR_URL=op://AI-Agents/Content Generator API/hostname
CONTENT_GENERATOR_API_KEY=op://AI-Agents/Content Generator API/credential

# ── Video rendering (connect-videos local renders) ──────────────────
#
# ElevenLabs API key for the connect-videos renderer's per-beat
# voiceover. Read from process env by ace-web's `scripts/render_locally.py`
# (and the `/ace:video-render-local` skill that wraps it) — the renderer
# refuses to silently drop voice when a spec asks for elevenlabs. Same
# 1Password item ace-web's own .env.tpl uses.
ELEVENLABS_API_KEY=op://AI-Agents/ACE - ElevenLabs API Key/credential

# ── ace-web Personal Access Token (per-human, per-machine) ─────────
#
# NOT 1Password-backed. Minted via /ace:ace-web-pat-mint (gh-style
# loopback flow); written by that script to the local-only-secrets
# marker block at the bottom of the resolved .env. `bin/ace-setup`
# preserves keys not declared in this template across `op inject`, so
# the value survives env re-injection.
#
# Replaces the deployment-wide ACE_E2E_AUTH_TOKEN shared secret. Token
# represents the actual human operator (whoever signs in to ace-web in
# their browser at mint time), not the ace@dimagi-ai.com service
# account — so ace-web actions are attributable to a real person.
#
# Consumers: skills/upload-transcript, /ace:run --ace-web-url. Doctor
# verifies presence + Bearer-auth liveness in the [Auth liveness]
# block.
#
# This commented declaration is intentional: it documents the key for
# operators reading the template without forcing an `op inject`
# resolution (the script writes the real value below the marker).
# ACE_WEB_PAT_TOKEN=  # populated by /ace:ace-web-pat-mint

# ─── ACE Drive Templates ───────────────────────────────────────────
# File IDs of Google Drive templates ACE skills copy from at runtime.
# Provisioned once per environment via per-template bootstrap scripts,
# then stashed in the 1Password item `AI-Agents/ACE - Drive Templates`
# and re-injected via `op inject`. Add new template IDs to that item
# rather than scattering them across product-specific items (the OCS
# golden template is OCS-specific and stays in `ACE - Open Chat Studio`).

# Training deck template (Google Slides). Bootstrap: `npx tsx scripts/bootstrap-training-deck-template.ts`.
# Stencil slides are duplicated and filled via TITLE / SUBTITLE / BODY
# placeholders (double-curly tokens — left undescribed inline because
# op inject parses double-curlies as ref delimiters even inside comments).
# Iterate branding/layout in Slides directly; do NOT change stencil
# objectIds or placeholder tokens (they're wired to `lib/training-deck-spec.ts`).
ACE_TRAINING_DECK_TEMPLATE_ID=op://AI-Agents/ACE - Drive Templates/training_deck_template_id

# Partnership pitch-deck template (Google Slides). Optional — falls back
# to ACE_TRAINING_DECK_TEMPLATE_ID when unset (Phase 1 reuses the same 14
# stencils). Set to a dedicated deck id once pitch-specific stencils ship.
ACE_PARTNERSHIP_DECK_TEMPLATE_ID=op://AI-Agents/ACE - Drive Templates/partnership_deck_template_id

# Work-order template (Google Doc). Bootstrap: `npx tsx scripts/bootstrap-work-order-template.ts`.
# See playbook/integrations/work-order-template.md for token contract.
WORK_ORDER_TEMPLATE_ID=op://AI-Agents/ACE - Drive Templates/work_order_template_id
