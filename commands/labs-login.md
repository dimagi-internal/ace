---
description: Establish a Connect-Labs UI session for walkthrough automation. Drives the headless OAuth-via-CCHQ flow + labs "Authorize with Connect" click-through, persists ~/.ace/labs-session.json, imports cookies into the gstack browse profile.
---

Run the labs walkthrough login script:

```bash
bash ~/.claude/plugins/cache/ace/ace/$(cat ~/.claude/plugins/marketplaces/ace/VERSION)/bin/ace-labs-walkthrough-login
```

This reuses `mcp/connect/auth/hq-oauth-login.ts` (the same headless Connect OAuth driver `ace-connect` uses) and adds a labs-side click-through (`mcp/connect-labs/auth/labs-oauth-login.ts`). No labs-side auth bypass is needed — labs has no `/auth/e2e-login/` shared-secret endpoint (only the ace-web mount does).

After login, cookies are imported into the gstack `browse` profile so `/canopy:walkthrough` runs against `https://labs.connect.dimagi.com/...` URLs are authenticated.

Re-run when:
- `~/.ace/labs-session.json` is missing
- A walkthrough run hits a redirect to `/labs/login/` mid-scene (session expired)
- You changed the `ACE_HQ_USERNAME`/`PASSWORD` in `.env` and need to re-authenticate as a different user

Auth surface:
- **Connect-Labs (this script):** `~/.ace/labs-session.json`, cookies for `labs.connect.dimagi.com`
- **Connect (existing):** `~/.ace/connect-session.json`, cookies for `connect.dimagi.com` + `www.commcarehq.org`
- **OCS (existing):** `~/.ace/ocs-session-<team>.json`

Both Connect and Labs OAuth flows share the same `hqOAuthLogin` infra, so a fresh login establishes both sessions in one bounce.
