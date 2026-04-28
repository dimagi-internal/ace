---
name: connect-login
description: >
  Interactive login flow for Connect (connect.dimagi.com). Opens a headed
  Playwright browser so the user can sign in via OAuth-with-CommCareHQ
  (covers MFA / SSO edge cases), then saves the resulting session state to
  ~/.ace/connect-session.json for headless reuse by ace-connect MCP tools.
---

# /ace:connect-login

Use this command to establish or refresh a Connect session for the Playwright backend used by `ace-connect` MCP tools.

## When to run

- First time setting up `ace-connect` on a machine
- After seeing `SessionExpiredError` from any ACE skill that touches Connect
- After a CommCare HQ password / MFA change for `ace@dimagi-ai.com`
- If automated HQ-OAuth login (driven from `.env` creds) ever fails

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
