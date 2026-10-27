---
name: labs-token-mint
description: >
  Mint a Labs MCP Personal Access Token (PAT) for ace@dimagi-ai.com via
  the self-service UI at labs.connect.dimagi.com/labs/mcp/tokens/, store
  the raw value in ACE's Canopy vault, and rewrite the local .env. One-time
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
  for `ace@dimagi-ai.com`). Run `/ace:setup --force-env` if missing.
- Write access to **ACE's Canopy vault** on canopy-web (agent `ace`,
  Settings → Credentials) — the one place ACE's env secrets are declared.
  `LABS_MCP_TOKEN` is a name stored there; `/ace:setup` writes `.env`
  straight from it (`canopy agent env --plugin ace`). 1Password is no
  longer read for it: a value written to a 1Password item (the old
  `ACE - Connect Labs` item, in any vault) looks like it succeeded and
  leaves `.env` stale. See `CLAUDE.md § Auth model`.
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
365-day TTL, store it in ACE's Canopy vault, and rewrite `.env`:

```bash
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
RAW=$(node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/labs-mint-token.ts" ACE-plugin 365)

# Store $RAW as LABS_MCP_TOKEN in ACE's Canopy vault (value on stdin, never
# argv; needs a vault wrap on this device — else paste it into canopy-web,
# agent `ace`, Settings → Credentials). Do not print or keep it in a file.
printf '%s' "$RAW" | canopy vault zk set --agent ace LABS_MCP_TOKEN

# Rewrite .env from the vault (runs `canopy agent env --plugin ace`;
# preserves local-only secrets like ACE_WEB_PAT_TOKEN)
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
HTTP 401 with `invalid_token` no matter how many times you rewrite `.env`.
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
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/labs-mint-token.ts" "ACE-plugin-laptop" 30
```

A scoped token, e.g. the `coach-images` token an OCS team's `connect-labs`
Auth Provider holds (`skills/ocs-coach-setup § The briefing picture`). Pipe it
straight into its destination: it is a secret and must not be printed or kept in
a file. The script refuses rather than mint a different scope if the page does
not offer the one asked for:

```bash
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/labs-mint-token.ts" "OCS <team> coach pictures" 365 coach-images | <into the OCS Auth Provider>
```

CommCare HQ's consent screen keeps "Authorize" disabled until a project space is
selected. The script selects `ACE_HQ_DOMAIN`, never "all", and fails with the
form's markup if that space is not offered (seen 2026-10-08).

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
   pipeable into its destination (the vault, or an OCS Auth Provider).

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

## Full access and the passkey approval

Labs asks for a person's passkey approval (through canopy) before it creates any
full-access token. ACE's account, `ace@dimagi-ai.com`, is ticked in labs' Django admin
under **Full-access self-mints** (Jonathan, 2026-10-27: ACE is never in a project space
with real data), so this command still creates the token in one pass. If that tick is
ever removed, the script stops with `labs asked for a passkey approval instead of
creating the token` and creates nothing: re-tick it, or mint with scope
`no-uservisit-data`.

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
  likelihood: (1) the new value is not in ACE's Canopy vault (e.g. it
  went to a 1Password item, which nothing reads now) or `.env` was not
  rewritten afterwards — re-run `/ace:setup --force-env`; (2) you have a
  hand-added user-scope `connect_labs` MCP entry with a hardcoded
  header (see § above); (3) you haven't fully restarted Claude Code, so
  the MCP subprocess still holds the old header; (4) wrong name in the
  vault (it must be exactly `LABS_MCP_TOKEN`).
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
- ACE's Canopy vault (canopy-web, Settings → Credentials) — holds
  `LABS_MCP_TOKEN`
- `playbook/integrations/connect-labs.md` — full integration reference
- `CLAUDE.md § Auth model` — the vault-backed `.env`
