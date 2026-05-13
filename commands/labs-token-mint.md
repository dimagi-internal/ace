---
name: labs-token-mint
description: >
  Mint a Labs MCP Personal Access Token (PAT) for ace@dimagi-ai.com via
  the self-service UI at labs.connect.dimagi.com/labs/mcp/tokens/, store
  the raw value in 1Password, and re-inject the local .env. One-time
  provisioning per machine; also used to rotate expired or compromised
  tokens.
---

# /ace:labs-token-mint

Mints a `LABS_MCP_TOKEN` for the `connect-labs` MCP without leaving the
terminal. ACE drives the full Labs → Connect → CommCareHQ OAuth chain
headlessly using the `ACE_HQ_USERNAME` / `ACE_HQ_PASSWORD` creds already
in your local `.env`.

## When to run

- **First-time setup** on a new machine where `bin/ace-doctor` shows
  `connect_labs_env: LABS_MCP_TOKEN missing` (the new Phase 8
  Solicitation Management work depends on it; see `CHANGELOG.md`
  `0.12.0`)
- **Rotation** when an existing token is expired or compromised
- **Per-environment** if you want a separate token labeled for sandbox
  vs. prod use

## Prerequisites

- `ACE_HQ_USERNAME` / `ACE_HQ_PASSWORD` resolved in
  `${CLAUDE_PLUGIN_DATA}/.env` (the standard ACE service-account creds
  for `ace@dimagi-ai.com`). Run `op inject -i .env.tpl -o
  $CLAUDE_PLUGIN_DATA/.env --account dimagi.1password.com` if missing.
- A 1Password item `ACE - Connect Labs` in the `AI-Agents` vault (the
  script creates it if absent — confirm vault writes are OK before
  running).
- Network access to `labs.connect.dimagi.com` and
  `www.commcarehq.org`.

## Usage

Default — mint the canonical `ACE-plugin` token with no expiry, store
in 1Password, and re-inject `.env`:

```bash
# Run from the plugin root
RAW=$(npx tsx scripts/labs-mint-token.ts ACE-plugin 0)

# Update 1Password (creates item if missing, otherwise updates field)
if op item get "ACE - Connect Labs" --vault AI-Agents \
    --account dimagi.1password.com >/dev/null 2>&1; then
  op item edit "ACE - Connect Labs" \
    --vault AI-Agents --account dimagi.1password.com \
    "mcp_token=$RAW"
else
  op item create --vault AI-Agents --account dimagi.1password.com \
    --category "API Credential" --title "ACE - Connect Labs" \
    "mcp_token=$RAW" \
    "user[text]=ace@dimagi-ai.com" \
    "name[text]=ACE-plugin"
fi

# Re-inject .env from 1Password
op inject -i .env.tpl -o "$CLAUDE_PLUGIN_DATA/.env" \
  --account dimagi.1password.com --force

# Smoke
bin/ace-doctor 2>&1 | grep "connect_labs_"
```

Custom name + 30-day TTL (e.g. for a separate machine alongside the
canonical one):

```bash
npx tsx scripts/labs-mint-token.ts "ACE-plugin-laptop" 30
```

## What it does

1. **Reads creds.** `ACE_HQ_USERNAME` and `ACE_HQ_PASSWORD` from
   `${CLAUDE_PLUGIN_DATA}/.env`.
2. **Launches headless Chromium** via Playwright (resolves out of
   `node_modules/`).
3. **Drives the OAuth chain:**
   - `GET /labs/initiate/?next=/labs/mcp/tokens/` →
     redirects to Connect's `/o/authorize/`
   - Connect's login page → click "Login with CommCareHQ" → bounces to
     CCHQ
   - CCHQ login form: fill `auth-username` / `auth-password` →
     submit
   - Walk OAuth consent screens (Connect-side and Labs-side) by
     clicking `input[name="allow"]` / `Authorize` / `Allow` if present
   - Land on `/labs/mcp/tokens/`
4. **Submits the create form** with `name` + `ttl_days`.
5. **Reads the raw token** from `<code id="raw-token">` in the
   response page.
6. **Prints to stdout.** Diagnostics go to stderr so the stdout is
   pipeable to `op item edit` / `op item create`.

## Output

```
[1/5] navigating to https://labs.connect.dimagi.com/labs/initiate/?next=/labs/mcp/tokens/
[2/5] current URL: https://connect.dimagi.com/accounts/login/?next=/o/authorize/...
[2/5] clicking Connect's "Login with CommCareHQ"
[3/5] CCHQ login: filling creds
[3/5] OAuth consent hop 1 on www.commcarehq.org/oauth/authorize/
[3/5] OAuth consent hop 2 on connect.dimagi.com/o/authorize/
[4/5] on tokens page, filling form: name="ACE-plugin" ttl_days=0
[5/5] submitted; reading raw token from DOM
<43-char raw token on stdout>
[done] minted token "ACE-plugin", length=43
```

## Troubleshooting

- **`Did not reach CCHQ login. Current URL: ...`** — Connect login
  page changed selectors. Inspect the URL the script ended on; if you
  see `accounts/login/` with no "Login with CommCareHQ" button,
  `mcp/connect/auth/hq-oauth-login.ts` needs updated selectors.
- **`Failed to land on tokens UI`** — the OAuth consent loop didn't
  complete. Pass `headless: false` in the Playwright `launch` call
  inside `scripts/labs-mint-token.ts` and re-run to watch the chain.
- **`raw-token element empty`** — the labs UI rendered the page
  without the just-created token block. Likely the form POST failed
  (CSRF mismatch, validation error). Inspect the page in headed mode.
- **`HTTP 401` on `bin/ace-doctor` after store** — wrong field name
  in 1Password. Verify with `op read --account dimagi.1password.com
  "op://AI-Agents/ACE - Connect Labs/mcp_token"` returns the same
  value the script printed.

## Related

- `mcp/connect-labs-server.ts` — the stdio proxy that consumes
  `LABS_MCP_TOKEN`
- `bin/ace-doctor` — `[Connect Labs]` section verifies the token
- `.env.tpl` — `LABS_MCP_TOKEN` line points at this 1Password item
