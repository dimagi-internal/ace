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
- A 1Password item `ACE - Connect Labs` in the **`Agent-Ace`** vault —
  this is what `.env.tpl` actually reads
  (`op://Agent-Ace/ACE - Connect Labs/mcp_token`). The legacy shared
  `AI-Agents` vault still holds a same-titled copy that nothing reads;
  writing there looks like it succeeded and leaves `.env` stale. See
  `CLAUDE.md § Auth model` for the per-agent vault split.
- Network access to `labs.connect.dimagi.com` and
  `www.commcarehq.org`.

## TTL: 1–365, and `0` no longer means "no expiry"

The labs create form renders
`<input name="ttl_days" value="90" min="1" max="365">`. **Passing `0`
now fails**: it violates `min="1"`, so the browser blocks the POST
client-side, no token is created, and the script dies at
`#raw-token` with a Playwright visibility timeout that reads like a
broken selector. Non-expiring tokens are no longer obtainable through
this UI — tokens created before ~2026-05 still show
`expires: never`, but new ones cannot. **Use `365`** (the maximum) for
the canonical token and re-run this command annually.

## Usage

Default — mint the canonical `ACE-plugin` token with the maximum
365-day TTL, store in 1Password, and re-inject `.env`:

```bash
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
RAW=$(npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/labs-mint-token.ts" ACE-plugin 365)

# Update 1Password (creates item if missing, otherwise updates field).
# Vault MUST be Agent-Ace — that's what .env.tpl reads. AI-Agents is the
# legacy copy and writing there silently leaves .env stale.
if op item get "ACE - Connect Labs" --vault Agent-Ace \
    --account dimagi.1password.com >/dev/null 2>&1; then
  op item edit "ACE - Connect Labs" \
    --vault Agent-Ace --account dimagi.1password.com \
    "mcp_token=$RAW"
else
  op item create --vault Agent-Ace --account dimagi.1password.com \
    --category "API Credential" --title "ACE - Connect Labs" \
    "mcp_token=$RAW" \
    "user[text]=ace@dimagi-ai.com" \
    "name[text]=ACE-plugin"
fi

# Verify the store round-trips before trusting it
[ "$(op read --account dimagi.1password.com \
     "op://Agent-Ace/ACE - Connect Labs/mcp_token")" = "$RAW" ] \
  && echo "1Password OK" || echo "MISMATCH — wrong vault or field"

# Re-inject .env from 1Password (preserves local-only secrets like
# ACE_WEB_PAT_TOKEN — a raw `op inject -o $CLAUDE_PLUGIN_DATA/.env` would drop them)
bash "$ACE_ROOT/bin/ace-setup" --force-env

# Smoke
"$ACE_ROOT/bin/ace-doctor" 2>&1 | grep "connect_labs_"
```

Then **fully restart Claude Code** (not just `/reload-plugins`) so the
`connect-labs` MCP subprocess re-runs `scripts/labs-auth-headers.mjs`
and picks up the new token — see
`CLAUDE.md § MCP changes need a full Claude restart`.

### If you also have a hand-added `connect_labs` MCP entry

The plugin ships `connect-labs` in `plugin.json` with a `headersHelper`
that reads `LABS_MCP_TOKEN` from `.env`, so the steps above are enough
for it. But a **manually added** user-scope entry (`claude mcp add`)
stores a *hardcoded* `Authorization: Bearer <token>` header in
`~/.claude.json` and **never reads `.env`** — it keeps returning
HTTP 401 with `invalid_token` no matter how many times you re-inject.
Check with `claude mcp list`; if one is present, either drop it in
favour of the plugin's entry, or re-point it:

```bash
claude mcp remove connect_labs -s user
claude mcp add --transport http connect_labs \
  "https://labs.connect.dimagi.com/mcp/" --scope user \
  --header "Authorization: Bearer $RAW"
claude mcp get connect_labs      # expect: ✔ Connected
```

Custom name + 30-day TTL (e.g. for a separate machine alongside the
canonical one):

```bash
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/labs-mint-token.ts" "ACE-plugin-laptop" 30
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
4. **Submits the create form** with `name` + `ttl_days`. The script
   range-checks `ttl_days` against the form's `min="1" max="365"` and
   fails fast with a clear message rather than letting client-side
   validation swallow the POST.
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
[4/5] on tokens page, filling form: name="ACE-plugin" ttl_days=365
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
- **Timeout `waiting for locator('#raw-token')` / `raw-token element
  empty`** — the create POST never happened; the page you're scraping
  is still the empty form. **First suspect `ttl_days` out of the
  `1..365` range** (see § TTL above) — HTML5 validation blocks the
  submit silently, so the click "succeeds" and no token is created.
  Confirm by checking the token table for a row created today: if
  there isn't one, nothing was minted and it's safe to re-run. Other
  causes: CSRF mismatch, or a renamed field. Inspect with
  `headless: false` in the Playwright `launch` call inside
  `scripts/labs-mint-token.ts`.
  - Note the tokens page is **client-rendered** — the form and table
    are absent from the initial HTML. Any diagnostic must wait for
    `input[name="name"]` before dumping the DOM, or it will wrongly
    conclude the token UI is gone.
- **`HTTP 401` / `invalid_token` after storing** — in order of
  likelihood: (1) you wrote to the **`AI-Agents`** vault instead of
  **`Agent-Ace`**, so `.env` still holds the old token — verify with
  `op read --account dimagi.1password.com
  "op://Agent-Ace/ACE - Connect Labs/mcp_token"`; (2) you have a
  hand-added user-scope `connect_labs` MCP entry with a hardcoded
  header (see § above); (3) you haven't fully restarted Claude Code, so
  the MCP subprocess still holds the old header; (4) wrong field name
  on the item.
- **`connect_labs_mcp_reachable: HTTP 406` in `bin/ace-doctor`** — a
  **false alarm, not an auth failure**. The probe omits the
  `Accept: application/json, text/event-stream` header the Streamable
  HTTP transport requires, and 406 is returned *before* token
  validation — so it reports WARN even when the token is perfectly
  healthy, and a 406 is equally *not* evidence that auth works.
  Confirm real health with `claude mcp get connect_labs`
  (expect `✔ Connected`) rather than this probe.

## Related

- `scripts/labs-auth-headers.mjs` — the `headersHelper` that reads
  `LABS_MCP_TOKEN` and injects `Authorization: Bearer <token>` for the
  native `connect-labs` HTTP entry in `.claude-plugin/plugin.json`
- `bin/ace-doctor` — `[Connect Labs]` section verifies the token
- `.env.tpl` — `LABS_MCP_TOKEN` points at
  `op://Agent-Ace/ACE - Connect Labs/mcp_token`
- `playbook/integrations/connect-labs.md` — full integration reference
- `CLAUDE.md § Auth model` — the per-agent vault split
  (`Agent-Ace` authoritative, `AI-Agents` legacy)
