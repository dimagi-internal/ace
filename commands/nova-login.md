---
name: nova-login
description: >
  Recover Nova MCP authentication. Tries refresh-token first (no UI); on
  refresh failure, opens a headed Playwright browser so the operator can
  complete Nova's Google-SSO OAuth once interactively, after which the
  MCP host's localhost listener captures fresh tokens to
  ~/.claude/.credentials.json. Used as the manual fallback when Phase 2
  Step 0 of `/ace:run` finds Nova in `needs-auth` state.
---

# /ace:nova-login

Recover Nova MCP authentication.

Nova's auth is structurally different from Connect's and OCS's: Nova lives
on `commcare.app` and authenticates via **Google SSO only** (the OAuth
landing page has nothing but a "Sign in with Google" button — verified
2026-05-05). We do NOT have an automatable Google-creds path, so this
skill cannot run unattended like `auth/playwright-session.ts` does for
Connect or OCS.

But this skill DOES try cheaper recovery paths before asking for an
interactive sign-in:

1. **Refresh-token retry** — if `~/.claude/.credentials.json` has a Nova
   entry with a non-empty `refreshToken`, POST it to the OAuth refresh
   endpoint. If the refresh succeeds, write new tokens back and exit;
   no UI involvement.
2. **Headed-Playwright interactive flow** — only if the refresh attempt
   fails. Launches Chromium pointing at a fresh `authenticate`-issued
   OAuth URL; the operator signs in once; the MCP host's localhost
   listener captures the callback and persists tokens.

Always end with a backup write to `~/.ace/nova-credentials-backup.json`
so a future `.credentials.json` corruption doesn't force another
interactive flow.

## When to run

- Phase 2 of `/ace:run` halts at Step 0 with Nova showing as
  `needs-auth`, and pruning `~/.claude/mcp-needs-auth-cache.json` did
  not recover.
- A skill that calls Nova MCP atoms returns auth errors, and the
  registry shows the access token is expired.
- After a long enough gap that even the refresh token has expired
  (Cognito invalidates after ~30 days for the `commcare.app` client).

If `/ace:doctor` reports `nova_auth: ok`, you don't need this command.

## Procedure (Claude executes step-by-step)

### Step 1: Pre-check token state

Read `~/.claude/.credentials.json` and inspect the Nova OAuth entry:

```bash
python3 -c '
import json, time, os
home = os.path.expanduser("~")
with open(f"{home}/.claude/.credentials.json") as f:
    d = json.load(f)
oauth = d.get("mcpOAuth", {})
nova_keys = [k for k in oauth if k.startswith("plugin:nova:nova")]
if not nova_keys:
    print("STATE: no_entry")
    exit(0)
entry = oauth[nova_keys[0]]
exp_ms = entry.get("expiresAt", 0)
now_ms = int(time.time() * 1000)
delta_s = round((exp_ms - now_ms) / 1000, 1)
has_refresh = bool(entry.get("refreshToken"))
print(f"KEY: {nova_keys[0]}")
print(f"EXPIRES_IN_S: {delta_s}")
print(f"HAS_REFRESH: {has_refresh}")
if delta_s > 60:
    print("STATE: fresh")
elif has_refresh:
    print("STATE: expired_with_refresh")
else:
    print("STATE: expired_no_refresh")
'
```

Branch on the `STATE:` line:

- **`fresh`** — tokens look healthy; the issue is likely a stale
  needs-auth cache or a session that hasn't reconnected. Tell the
  operator: "Tokens look fresh (`expires in <delta>s`). Run
  `/reload-plugins` and retry whatever skill failed. If it still
  fails, re-run `/ace:nova-login` to force a refresh."
  STOP.
- **`expired_with_refresh`** — proceed to Step 2 (try refresh).
- **`expired_no_refresh` or `no_entry`** — proceed to Step 3
  (interactive flow).

### Step 2: Refresh-token attempt

If we got here, an access token is expired but a refresh token exists.
The MCP host *should* refresh automatically; the fact that we're here
means it didn't (cache poisoning, transient Cognito hiccup, etc.). Try
manually:

```bash
python3 << 'EOF'
import json, os, time, urllib.request, urllib.parse, sys
home = os.path.expanduser("~")
cred_path = f"{home}/.claude/.credentials.json"
with open(cred_path) as f:
    d = json.load(f)
oauth = d.get("mcpOAuth", {})
key = next(k for k in oauth if k.startswith("plugin:nova:nova"))
entry = oauth[key]
refresh = entry["refreshToken"]
# The client_id is baked into the OAuth URL the MCP host issues; lift
# it from the saved entry's serverUrl-region by reading any prior
# authenticate URL the user might have, OR fall back to the known-good
# Cognito client for the commcare.app/mcp server.
# Empirical (2026-05-05): the prod commcare.app MCP client_id is:
client_id = "oTtEuWWfElUyujPBfGjRltStbPZaaMZB"
body = urllib.parse.urlencode({
    "grant_type": "refresh_token",
    "refresh_token": refresh,
    "client_id": client_id,
}).encode()
req = urllib.request.Request(
    "https://commcare.app/api/auth/oauth2/token",
    data=body,
    method="POST",
    headers={"Content-Type": "application/x-www-form-urlencoded"},
)
try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = resp.read().decode()
        toks = json.loads(body)
        print(f"REFRESH_OK: got new access_token ({len(toks.get('access_token',''))} chars)")
        # Write back to .credentials.json with new expiresAt
        entry["accessToken"] = toks["access_token"]
        # Cognito returns a new refresh_token only on rotation; preserve old if not rotated
        if "refresh_token" in toks:
            entry["refreshToken"] = toks["refresh_token"]
        if "expires_in" in toks:
            entry["expiresAt"] = int(time.time() * 1000) + toks["expires_in"] * 1000
        with open(cred_path, "w") as f:
            json.dump(d, f, indent=2)
        print(f"WROTE: {cred_path}")
        sys.exit(0)
except urllib.error.HTTPError as e:
    err_body = e.read().decode()
    print(f"REFRESH_FAILED: HTTP {e.code} — {err_body[:200]}")
    sys.exit(2)
except Exception as e:
    print(f"REFRESH_ERROR: {type(e).__name__}: {e}")
    sys.exit(3)
EOF
```

Branch on exit code:
- `0` (REFRESH_OK) — proceed to Step 4 (backup + final).
- `2` or `3` (REFRESH_FAILED / REFRESH_ERROR) — proceed to Step 3
  (interactive flow). The refresh token is no longer valid; only
  fresh OAuth recovers.

### Step 3: Interactive Playwright flow

Refresh didn't work. Trigger a fresh OAuth flow and drive it with
headed Chromium so the operator only has to interact with the Google
sign-in form (the rest is automatic).

**3a.** Call the MCP tool to start a fresh OAuth flow:

```
mcp__plugin_nova_nova__authenticate (no args)
```

The response includes a line of the form
`https://commcare.app/api/auth/oauth2/authorize?...`. Capture that URL
verbatim — pass it to the Playwright helper as the `NOVA_OAUTH_URL`
env var. The MCP host has now also opened a localhost listener on the
port encoded in `redirect_uri`; do NOT delay before launching
Playwright (the listener has a 5-minute timeout).

**3b.** Launch headed Chromium pointing at the URL. Playwright detects
the localhost callback automatically; once the redirect fires, the
script exits and the MCP host's listener captures the code.

```bash
NOVA_OAUTH_URL="<paste the URL from the authenticate response>" \
NOVA_LOGIN_TIMEOUT_MS="${NOVA_LOGIN_TIMEOUT_MS:-300000}" \
npx tsx <(cat <<'EOF'
import { chromium } from 'playwright';

const url = process.env.NOVA_OAUTH_URL;
if (!url) {
  console.error('NOVA_OAUTH_URL is required (the authorize URL from `authenticate`)');
  process.exit(1);
}
const timeoutMs = Number(process.env.NOVA_LOGIN_TIMEOUT_MS);

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

console.log('[nova-login] navigating to authorize URL');
await page.goto(url);
console.log('[nova-login] sign in with Google in the browser window');
console.log('[nova-login] waiting for localhost callback (max', timeoutMs / 1000, 's)');

try {
  await page.waitForURL((u) => /localhost:\d+\/callback/.test(String(u)), {
    timeout: timeoutMs,
  });
  const finalUrl = page.url();
  console.log('[nova-login] callback detected:', finalUrl.replace(/code=[^&]+/, 'code=***'));
  // The MCP host's listener has captured the code by now; give it a beat
  // to write tokens to .credentials.json before we close the browser.
  await new Promise((r) => setTimeout(r, 2000));
  console.log('[nova-login] tokens should be persisted; closing');
} catch (err) {
  console.error('[nova-login] timed out waiting for callback. The operator did not complete sign-in within', timeoutMs / 1000, 's.');
  process.exitCode = 2;
} finally {
  await browser.close();
}
EOF
)
```

If the bash exits non-zero, the operator did not complete the
sign-in. Tell them clearly: "Nova OAuth was not completed. Re-run
`/ace:nova-login` when you have time to sign in." STOP.

### Step 4: Verify and backup

Re-read `.credentials.json` and confirm the Nova entry's `expiresAt`
is now in the future:

```bash
python3 -c '
import json, time, os
home = os.path.expanduser("~")
with open(f"{home}/.claude/.credentials.json") as f:
    d = json.load(f)
oauth = d.get("mcpOAuth", {})
nova_keys = [k for k in oauth if k.startswith("plugin:nova:nova")]
if not nova_keys:
    print("VERIFY_FAILED: no nova entry written")
    exit(2)
entry = oauth[nova_keys[0]]
delta_s = round((entry.get("expiresAt", 0) - int(time.time() * 1000)) / 1000, 1)
if delta_s > 60:
    print(f"VERIFY_OK: tokens valid for {delta_s} more seconds")
else:
    print(f"VERIFY_FAILED: expiresAt is {delta_s}s from now (expected > 60s)")
    exit(3)
'
```

If verify fails, surface the issue plainly and STOP — there's no
automated recovery.

Then write a backup of just the Nova entry to
`~/.ace/nova-credentials-backup.json` for emergency restore. The
backup is plaintext on disk with the same protections as the source
file (`~/.claude/.credentials.json`); both live in the user's home and
are not committed anywhere. A future `/ace:doctor` could detect a
missing/empty Nova entry in the live file and offer to restore from
the backup before forcing a fresh OAuth round.

```bash
mkdir -p ~/.ace
python3 -c '
import json, os
home = os.path.expanduser("~")
with open(f"{home}/.claude/.credentials.json") as f:
    d = json.load(f)
oauth = d.get("mcpOAuth", {})
nova_keys = [k for k in oauth if k.startswith("plugin:nova:nova")]
if not nova_keys:
    print("BACKUP_SKIPPED: no nova entry to back up")
    exit(0)
backup = {nova_keys[0]: oauth[nova_keys[0]]}
out = f"{home}/.ace/nova-credentials-backup.json"
with open(out, "w") as f:
    json.dump(backup, f, indent=2)
import os as _os
_os.chmod(out, 0o600)
print(f"BACKUP_OK: {out}")
'
```

### Step 5: Final operator note

Tell the operator: "Nova auth recovered. Run `/reload-plugins` for the
MCP host to pick up the fresh tokens, then resume whatever skill
needed Nova (e.g., re-run `/ace:run <opp>`)."

## Why this approach

- **Refresh-first** — most "Nova is unauthenticated" states are just
  expired access tokens that the MCP host should have refreshed itself
  but didn't. Trying refresh manually skips the interactive flow when
  it's not needed.
- **Headed Playwright** for the fallback — Google's anti-bot
  protection rules out programmatic sign-in for `ace@dimagi-ai.com`,
  so we surface a real browser. The MCP host's localhost listener
  handles the callback automatically (no manual "paste the callback
  URL" step the bare `complete_authentication` flow needed).
- **Tokens stay where the MCP host expects them** — we don't try to
  store auth state in our own format. The MCP host owns
  `.credentials.json`; we backup a copy to `~/.ace/` so we have a
  recovery-from-corruption path if needed, but the live source remains
  the host's own file.

## Why we cannot drive Google login programmatically

The procedure doc for `agents/commcare-setup.md` Step 0c originally
noted this; making it concrete:

- The OAuth landing page at `commcare.app/api/auth/oauth2/authorize`
  has only one button — "Sign in with Google" — and no
  username/password form (verified via `curl -L` 2026-05-05).
- Driving `accounts.google.com` login programmatically is brittle: bot
  detection, step-up auth, OTP prompts on new devices, per-account
  challenge questions. The Connect-side flow works because CCHQ owns
  its own login page; Nova's flow doesn't.
- We don't carry `ACE_GMAIL_PASSWORD` in `.env.tpl` even if we wanted
  to try, and adding it would be a security regression since it'd live
  on every operator's machine just to support a fragile automation.

The headed-Playwright path is the right structural answer: one
interactive sign-in per refresh-token lifetime (~30 days), then full
automation in between.

## Troubleshooting

- **Playwright doesn't launch:** `npx playwright install chromium`.
- **Browser opens but sign-in stalls:** check that you're signed into
  the correct Google account (`ace@dimagi-ai.com`) — Chrome may pick
  the wrong default. Use the account picker.
- **Sign-in succeeds but localhost callback shows
  `ERR_CONNECTION_REFUSED`:** the MCP host's listener timed out.
  Re-run `/ace:nova-login` (it'll issue a fresh URL with a fresh
  listener).
- **`STATE: fresh` but `/reload-plugins` doesn't recover:** restart
  Claude Code. The MCP host's tool inventory is set at session start
  and doesn't always refresh on `/reload-plugins`.
- **Refresh succeeded but `/reload-plugins` still shows Nova as
  `needs-auth`:** the needs-auth cache was poisoned. Run
  `agents/commcare-setup.md § Step 0a` (the cache-prune one-liner) and
  retry.
