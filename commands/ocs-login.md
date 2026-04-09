---
name: ocs-login
description: >
  Interactive login flow for OCS. Opens a headed Playwright browser so the
  user can sign in (including SSO/MFA), then saves the resulting session state
  to ~/.ace/ocs-session-<team>.json for headless reuse.
---

# /ocs:login

Use this command to establish or refresh an OCS session for the Playwright backend.

## When to run

- First time setting up the OCS integration on a machine
- After seeing `SessionExpiredError` from any ACE skill that touches OCS
- After a password / SSO credential change

## What it does

1. Launches a headed Chromium window via Playwright
2. Navigates to `${OCS_BASE_URL}/accounts/login/`
3. Waits for the user to sign in manually (up to 5 minutes)
4. Saves `storageState` to `~/.ace/ocs-session-<team>.json`
5. Confirms the saved state works by fetching `/a/<team>/chatbots/`

## Implementation

Write a one-shot TypeScript helper to a tmp file and run it via `tsx`:

```bash
cat > /tmp/ocs-login.ts <<'EOF'
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const baseUrl = process.env.OCS_BASE_URL ?? 'https://chatbots.dimagi.com';
const teamSlug = process.env.OCS_TEAM_SLUG ?? 'dimagi';
const stateFile = path.join(os.homedir(), '.ace', `ocs-session-${teamSlug}.json`);

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ baseURL: baseUrl });
const page = await context.newPage();
await page.goto('/accounts/login/');

console.log('Sign in manually in the browser window.');
console.log('After you see the chatbots dashboard, return here and press Enter to save the session.');
process.stdin.resume();
process.stdin.once('data', async () => {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  await context.storageState({ path: stateFile });
  console.log(`Session saved to ${stateFile}`);
  await browser.close();
  process.exit(0);
});
EOF
npx tsx /tmp/ocs-login.ts
```

## Expected output

```
Sign in manually in the browser window.
After you see the chatbots dashboard, return here and press Enter to save the session.
[user signs in in the browser]
Session saved to /Users/jon/.ace/ocs-session-dimagi.json
```

## Troubleshooting

- **Browser doesn't open:** make sure Playwright's Chromium is installed (`npx playwright install chromium`).
- **Login page says "session expired" immediately:** you may be hitting a stale cookie; delete `~/.ace/ocs-session-<team>.json` before re-running.
- **Dimagi SSO redirect loop:** try signing into `chatbots.dimagi.com` in your regular browser first to complete MFA, then re-run this command.
- **"Saved" but headless calls still fail:** the Playwright backend validates by hitting `/a/<team>/chatbots/`. If that 302s, your session wasn't stored. Re-run the login and watch for errors before pressing Enter.
