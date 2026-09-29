---
name: ace-web-token-mint
description: >
  Mint ACE's OWN ace-web token (as ace@dimagi-ai.com, headlessly), store it
  in 1Password Agent-Ace, and re-inject .env. The machine-independent way to
  provision ACE_WEB_PAT_TOKEN — no browser, no human sign-in, no server
  command. Also rotates it.
---

# /ace:ace-web-token-mint

`ACE_WEB_PAT_TOKEN` authenticates ACE to ace-web's API (`bin/ace-bind`,
`fork-run`, `clone-to-new-workspace`, `/ace:release`, `share-run-access`
invites, `sweep-ace-web`, the video skills, `upload-transcript`, the cloud
mobile backend). Since ace-web#670 `ace@dimagi-ai.com` is a first-class ace-web
user (an OWNER of `dimagi-team`), so the token belongs to **ACE**, and like
every other ACE credential it lives in 1Password and `/ace:setup` injects it
(`ACE_WEB_PAT_TOKEN=op://Agent-Ace/ACE - ace-web/pat_token` in `.env.tpl`).

`scripts/ace-web-bot-token-mint.ts` drives only public surfaces, as ACE:

1. ACE's maintained Connect login (`mcp/connect/auth/hq-oauth-login.ts`, the
   `ACE_HQ_USERNAME` / `ACE_HQ_PASSWORD` creds) — the same path every Connect
   atom uses;
2. ace-web's "Sign in with Connect" (admitted by workspace membership,
   `apps/auth/login_gate.py`);
3. ace-web's own `/auth/cli/authorize/` page → Authorize → a 127.0.0.1
   listener this script owns for the duration;
4. a verify call (`GET /api/auth/me` must answer `ace@dimagi-ai.com`) before
   anything is stored.

**Not** `python manage.py mint_personal_token` — that needs shell on the
deployed ace-web and is not an operator step. **Not** `/ace:ace-web-pat-mint`
either, which mints a token for whichever HUMAN is signed into the browser
and so attributes ACE's writes to that person; keep that one only for a human
who deliberately wants their own name on the calls.

## When to run

- Once, ever — then every machine gets the token from `/ace:setup`.
- Rotation (leak, or deliberate). Then revoke the old one (below).
- `bin/ace-doctor` reports `ace_web_pat_token` missing **and** `op read` of
  the item above fails (the item does not exist yet).

## Usage

```bash
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
RAW=$(node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/ace-web-bot-token-mint.ts" "ace-bot-$(date +%Y-%m-%d)")
[ -n "$RAW" ] || { echo "mint failed — read the stderr above"; exit 1; }

# Vault MUST be Agent-Ace — that's what .env.tpl reads.
if op item get "ACE - ace-web" --vault Agent-Ace --account dimagi.1password.com >/dev/null 2>&1; then
  op item edit "ACE - ace-web" --vault Agent-Ace --account dimagi.1password.com "pat_token=$RAW" >/dev/null
else
  op item create --vault Agent-Ace --account dimagi.1password.com \
    --category "API Credential" --title "ACE - ace-web" \
    "pat_token[password]=$RAW" "user[text]=ace@dimagi-ai.com" \
    "base_url[text]=https://labs.connect.dimagi.com/ace" >/dev/null
fi

# Verify the store round-trips before trusting it.
[ "$(op read --account dimagi.1password.com 'op://Agent-Ace/ACE - ace-web/pat_token')" = "$RAW" ] \
  && echo "1Password OK" || echo "MISMATCH — wrong vault or field"

# Re-inject .env (the template now carries the op:// ref).
bash "$ACE_ROOT/bin/ace-setup" --force-env
```

Then **fully restart Claude Code** — MCP subprocesses (the cloud mobile
backend reads this token) bind `.env` at spawn.

## Rotating: revoke the old token

List ACE's tokens with the new one and revoke by id (never the one you just
stored):

```bash
T=$(op read --account dimagi.1password.com 'op://Agent-Ace/ACE - ace-web/pat_token')
curl -s -H "Authorization: Bearer $T" https://labs.connect.dimagi.com/ace/api/tokens
curl -s -X DELETE -H "Authorization: Bearer $T" https://labs.connect.dimagi.com/ace/api/tokens/<id>
```

## Failure modes

- **Stops at HQ with a disabled Authorize** — HQ's project-space consent
  step; `hqOAuthLogin` owns it (`grantAllProjectSpaces` in
  `mcp/connect/auth/hq-oauth-login.ts`). If HQ changed the page, the Connect
  atoms break the same way — fix it there, once.
- **`did not reach ace-web's authorize page … Access is restricted`** —
  ace-web no longer admits `ace@dimagi-ai.com` (its `dimagi-team` membership
  is gone). That is an ace-web data problem, not a script one.
- **`Authorize was clicked but no loopback redirect arrived`** — the POST
  minted a token that nothing received. List and revoke it (above), then
  re-run. Set `ACE_TOKEN_MINT_DEBUG=1` to print every response.
- **`token authenticates as …, not ace@dimagi-ai.com`** — refused on purpose;
  nothing was stored.
