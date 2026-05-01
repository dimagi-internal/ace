---
name: connect-login
description: >
  Manual fallback login for Connect (connect.dimagi.com). Opens a headed
  Playwright browser so the user can sign in via OAuth-with-CommCareHQ
  (covers MFA / SSO edge cases), then saves the resulting session state to
  ~/.ace/connect-session.json. The Playwright backend auto-logs-in via
  ACE_HQ_USERNAME/ACE_HQ_PASSWORD by default — only use this command when
  those credentials are unavailable or the account requires interactive auth.
---

# /ace:connect-login

Manual fallback for Connect login. **You usually do not need to run this** — the Playwright backend auto-logs-in via the HQ-OAuth flow using `ACE_HQ_USERNAME` / `ACE_HQ_PASSWORD` from `.env` whenever the saved session is missing or expired (see `mcp/connect/auth/playwright-session.ts` and `mcp/connect/auth/hq-oauth-login.ts`).

## When to run

- The HQ account requires SSO / MFA (auto-login can't drive an interactive challenge).
- HQ rejects the auto-login credentials (you'll see `ConnectLoginFailedError` with `stage: "hq-creds"`); you want to verify by signing in manually.
- The OAuth consent screen changed and the auto-login selectors broke (you'll see `ConnectLoginFailedError` with `stage: "oauth-consent"`).
- You're forced through an interactive login by a security policy change.

If you're hitting `SessionExpiredError`, first verify `ACE_HQ_USERNAME` and `ACE_HQ_PASSWORD` are set in `.env` — `/ace:doctor` reports `connect_session: not present (will auto-login from .env on first call)` when creds are present, in which case you don't need this command at all.

## What it does

1. Launches a headed Chromium window via Playwright
2. Navigates to `${CONNECT_BASE_URL}/accounts/login/`
3. Waits for the user to click "Login with CommCareHQ" and complete sign-in (up to 5 minutes)
4. Saves `storageState` to `~/.ace/connect-session.json`
5. Confirms the saved state works by fetching `/` and verifying we don't 302 to the login page

## Implementation

Write a one-shot TypeScript helper to a tmp file and run it via `tsx`:

```bash
cat > /tmp/connect-login.ts <<'EOF'
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
const stateFile = path.join(os.homedir(), '.ace', 'connect-session.json');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ baseURL: baseUrl });
const page = await context.newPage();
await page.goto('/accounts/login/');

console.log('Sign in manually in the browser window.');
console.log('Click "Login with CommCareHQ" and complete the OAuth flow.');
console.log('After you see the Connect dashboard, return here and press Enter to save the session.');
process.stdin.resume();
process.stdin.once('data', async () => {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  await context.storageState({ path: stateFile });
  console.log(`Session saved to ${stateFile}`);
  await browser.close();
  process.exit(0);
});
EOF
npx tsx /tmp/connect-login.ts
```

## Expected output

```
Sign in manually in the browser window.
Click "Login with CommCareHQ" and complete the OAuth flow.
After you see the Connect dashboard, return here and press Enter to save the session.
[user signs in via HQ OAuth]
Session saved to /Users/jon/.ace/connect-session.json
```

## Troubleshooting

- **Browser doesn't open:** make sure Playwright's Chromium is installed (`npx playwright install chromium`).
- **OAuth bounce loop:** sign into `www.commcarehq.org` directly in your regular browser first to clear any stuck MFA state, then re-run this command.
- **"Saved" but headless calls still fail:** delete `~/.ace/connect-session.json` and re-run; old cookies can shadow the new state.
- **Automated login keeps working — why use this?** Most setups won't need this. The headless `auth/playwright-session.ts` will silently re-login from `.env` creds when its session expires. This command exists for the edge cases where automated login can't complete (MFA prompts, SSO redirect changes, etc.).
