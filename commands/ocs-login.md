---
name: ocs-login
description: >
  Manual fallback login for OCS. Opens a headed Playwright browser so the user
  can sign in interactively (including SSO/MFA), then saves the resulting
  session state to ~/.ace/ocs-session-<team>.json. The Playwright backend
  auto-logs-in via OCS_USERNAME/OCS_PASSWORD by default — only use this
  command when those credentials are unavailable or the account requires
  interactive auth.
---

# /ace:ocs-login

Manual fallback for OCS login. **You usually do not need to run this** — the Playwright backend auto-logs-in using `OCS_USERNAME` / `OCS_PASSWORD` from `.env` whenever the saved session is missing or expired (see `mcp/ocs/auth/playwright-session.ts`).

## When to run

- The OCS account requires SSO / MFA (auto-login can't drive an interactive flow).
- You're testing against an OCS account whose creds aren't in 1Password.
- You're forced through an interactive login by a security policy change.

If you're hitting `SessionExpiredError` from a skill, first verify `OCS_USERNAME` and `OCS_PASSWORD` are set in `.env` — `/ace:doctor` reports `ocs_session: ... auto-login on first call ...` when creds are present, in which case you don't need this command at all.

## What it does

1. Launches a headed Chromium window via Playwright.
2. Navigates to `${OCS_BASE_URL}/accounts/login/`.
3. Waits for the user to sign in manually (up to 5 minutes).
4. Saves `storageState` to `~/.ace/ocs-session-<team>.json`.
5. Confirms the saved state works by fetching `/a/<team>/chatbots/`.

## Implementation

Write a one-shot TypeScript helper to a tmp file and run it via `tsx`:

```bash
cat > /tmp/ocs-login.ts <<'EOF'
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const baseUrl = process.env.OCS_BASE_URL ?? 'https://www.openchatstudio.com';
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
- **Dimagi SSO redirect loop:** try signing into `www.openchatstudio.com` in your regular browser first to complete MFA, then re-run this command.
- **"Saved" but headless calls still fail:** the Playwright backend validates by hitting `/a/<team>/chatbots/`. If that 302s, your session wasn't stored. Re-run the login and watch for errors before pressing Enter.
- **Auto-login should have worked but didn't:** confirm `OCS_USERNAME` / `OCS_PASSWORD` are populated in the resolved `.env` (run `/ace:doctor`). Auto-login fails silently to this command only when those vars are missing.
