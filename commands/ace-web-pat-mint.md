---
name: ace-web-pat-mint
description: >
  Mint a per-human personal access token (PAT) for ace-web via a
  gh-style loopback browser flow, write it to the local .env, and
  verify it round-trips. Replaces the deployment-wide
  ACE_E2E_AUTH_TOKEN shared secret. One-time per machine; re-run to
  rotate.
---

# /ace:ace-web-pat-mint

Mints `ACE_WEB_PAT_TOKEN` for the human operator (whoever is signed
into ace-web in their default browser, e.g. `jjackson@dimagi.com`) via
a `gh auth login` style loopback flow. The token belongs to *you* —
not to `ace@dimagi-ai.com` — so any actions ace-web attributes (e.g.
chat session ownership) trace back to the actual human.

## When to run

- **First-time setup** on a new machine where `bin/ace-doctor` shows
  `WARN ace_web_pat_token: not set`
- **Rotation** when an existing token is expired, leaked, or you've
  moved laptops (revoke the old one from ace-web Settings)
- **Per-environment** if you want a separate token labeled for sandbox
  vs. prod use (pass a custom label as the first arg)

## Prerequisites

- A reachable ace-web at `$ACE_WEB_BASE` (default
  `https://labs.connect.dimagi.com/ace`)
- A signed-in browser session at that URL — or willingness to sign in
  when the browser tab opens
- `${CLAUDE_PLUGIN_DATA}/.env` exists (created by `/ace:setup`)

## Usage

Default — token labeled `<hostname>-YYYY-MM-DD`:

```bash
npx tsx scripts/ace-web-pat-mint.ts
```

Custom label:

```bash
npx tsx scripts/ace-web-pat-mint.ts "jjackson-laptop-prod"
```

Pointed at a different ace-web (e.g. local dev):

```bash
ACE_WEB_BASE=http://localhost:8000 npx tsx scripts/ace-web-pat-mint.ts
```

## What it does

1. **Binds a free loopback port** (`socket(0)` on `127.0.0.1`).
2. **Generates a state nonce** (32 bytes urlsafe, binds the listener
   to this specific mint invocation).
3. **Opens your browser** to `${ACE_WEB_BASE}/auth/cli/authorize/?cb=
   http://127.0.0.1:NNNN/cb&state=<nonce>&label=<label>`.
4. **ace-web** (after `@login_required` bounce through OAuth if
   you're not already signed in) shows a one-click "Authorize CLI
   access" page identifying the label, callback host, and your
   account. Click **Authorize**.
5. **ace-web mints a PersonalToken** bound to your user, then
   `302`-redirects to `<cb>?token=<raw>&state=<nonce>`.
6. **Local listener** verifies the state nonce, extracts the token,
   writes it to `${CLAUDE_PLUGIN_DATA}/.env` inside the
   `# --- ACE local-only secrets ---` marker block (so future
   `op inject` calls preserve it), responds with a "Token captured"
   page, and shuts down.

## Output

```
[mint] label=jjackson-laptop-2026-05-08 ace_web_base=https://labs.connect.dimagi.com/ace
[1/3] listening on http://127.0.0.1:54321/cb
[2/3] open this URL in your browser to authorize:
  https://labs.connect.dimagi.com/ace/auth/cli/authorize/?cb=http%3A%2F%2F127.0.0.1%3A54321%2Fcb&state=...&label=jjackson-laptop-2026-05-08
[3/3] waiting up to 5 minutes for callback...
[done] minted "jjackson-laptop-2026-05-08" (43 chars), wrote ACE_WEB_PAT_TOKEN to /Users/.../ace-ace/.env
       /reload-plugins to pick up the new env, then bin/ace-doctor to verify.
```

## Trust model

The loopback flow is designed so the token never traverses the public
internet beyond the redirect to your own laptop:

- ace-web's `_validate_callback` rejects any `cb` URL that isn't
  `http://127.0.0.1:*` or `http://localhost:*` (no `https://evil.com`
  attacks)
- The `state` nonce binds the callback to the specific local listener
  that minted it (prevents cross-process race conditions)
- The token goes from ace-web → 302 redirect → your laptop. No
  upstream proxies, no referer leak, no third-party hops.
- The listener is one-shot: it shuts down after one callback, so even
  if the URL leaks, the port is closed.
- The PersonalToken is immediately revocable from the ace-web Settings
  page if you suspect compromise.

## Troubleshooting

- **`timeout — no callback received in 5 minutes`** — operator never
  approved. Re-run; complete the flow within 5 minutes.
- **`state mismatch`** — another mint invocation raced for the same
  port (very rare on a single user's laptop). Re-run.
- **Browser didn't open** — copy the URL printed in step `[2/3]` and
  paste it into your browser manually. The listener is waiting on the
  port shown in step `[1/3]`.
- **HTTP 401 from upload-transcript afterward** — token not picked up
  by the running MCP. Run `/reload-plugins` to refresh env, then
  retry. If still 401, run `bin/ace-doctor` and check the
  `[Auth liveness]` block for `ace_web_pat_auth`.
- **Want to use over SSH** — start a tunnel from your local machine:
  `ssh -L 54321:127.0.0.1:54321 <remote>`, run the mint script
  remotely with `ACE_E2E_PORT_HINT=54321` (not yet implemented — for
  now, run mint locally).

## Related

- `scripts/ace-web-pat-mint.ts` — the listener + browser-open
- `apps/auth/cli_authorize_views.py` — ace-web side (pull #250)
- `bin/ace-doctor` — `[Auth liveness]` block verifies the token
- `skills/upload-transcript/SKILL.md` — primary consumer
- `.env.tpl` — declares `ACE_WEB_PAT_TOKEN` as a local-only secret
