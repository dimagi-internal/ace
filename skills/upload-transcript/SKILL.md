---
name: upload-transcript
description: Upload a Claude CLI stream-json transcript (.jsonl) to a deployed ace-web via /api/ingest/upload. Authenticates as ace@dimagi-ai.com via /auth/e2e-login/ using $ACE_E2E_AUTH_TOKEN (no personal bearer token required). Used by /ace:run --ace-web-url, or invoked directly for ad-hoc transcript uploads.
---

# upload-transcript

POSTs a `.jsonl` transcript file to `<base-url>/api/ingest/upload` so the
deployed ace-web can render it as a chat Session. Uses the e2e-login
shared-secret flow — no per-user personal tokens.

## Inputs

- `base_url` — deployed ace-web URL, e.g. `https://labs.connect.dimagi.com/ace`.
- `transcript_path` — filesystem path to a `.jsonl` file produced by
  `claude -p --output-format stream-json`.
- `ACE_E2E_AUTH_TOKEN` — env var; shared secret from the target instance's
  `deploy/aws/task-definition.json` or AWS Secrets Manager.

Optional: `email` (defaults to `ace@dimagi-ai.com`).

## Steps

1. **Verify preconditions.**
   - `transcript_path` exists and is non-empty.
   - `ACE_E2E_AUTH_TOKEN` is set in the environment.
   - `base_url` does not end in a trailing slash; strip if present.
   If any fail, stop and report which precondition failed.

2. **POST `/auth/e2e-login/`** with `{"email": <email>, "token": $ACE_E2E_AUTH_TOKEN}`
   using `curl -c <cookie-jar>` to persist the session cookie. Expect 200.
   On non-200, print the response body and fail. The cookie jar path can be
   a temp file (`mktemp`); clean up after.

3. **Warm `csrftoken_ace`** by GETting `<base-url>/` with the same cookie jar
   (`-b -c`). Django doesn't set the CSRF cookie until a view hit by
   `CsrfViewMiddleware` renders.

4. **POST `<base-url>/api/ingest/upload`** with:
   - `-b <cookie-jar>` for the `sessionid_ace` session cookie
   - `-H "X-CSRFToken: <csrf-value-from-jar>"`
   - `-H "Referer: <base-url>/"`
   - `-F "file=@<transcript_path>;type=application/x-ndjson"`
   Expect 201. On non-201, print the response body and fail.

5. **Return** the `data.session_slug` from the 201 response envelope as the
   skill's output. Callers (e.g. `/ace:run --ace-web-url`) can log the
   resulting URL: `<base-url>/chat/<session_slug>`.

## Shell reference

```bash
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

# 1. login
HTTP=$(curl -sS -c "$COOKIE_JAR" -o /tmp/login-resp.json -w '%{http_code}' \
  -X POST "$BASE_URL/auth/e2e-login/" \
  -H "Content-Type: application/json" \
  --data-raw "{\"email\":\"${EMAIL:-ace@dimagi-ai.com}\",\"token\":\"$ACE_E2E_AUTH_TOKEN\"}")
[ "$HTTP" = "200" ] || { echo "e2e-login $HTTP"; cat /tmp/login-resp.json; exit 3; }

# 2. warm csrf (sessionid_ace from login; csrftoken_ace after first GET)
curl -sS -b "$COOKIE_JAR" -c "$COOKIE_JAR" -o /dev/null "$BASE_URL/"
CSRF=$(awk '$6 == "csrftoken_ace" { print $7 }' "$COOKIE_JAR" | tail -n 1)

# 3. upload
HTTP=$(curl -sS -b "$COOKIE_JAR" -o /tmp/upload-resp.json -w '%{http_code}' \
  -X POST "$BASE_URL/api/ingest/upload" \
  -H "X-CSRFToken: $CSRF" \
  -H "Referer: $BASE_URL/" \
  -F "file=@$TRANSCRIPT_PATH;type=application/x-ndjson")
[ "$HTTP" = "201" ] || { echo "upload $HTTP"; cat /tmp/upload-resp.json; exit 4; }

# 4. extract session slug from envelope {data: {session_slug: "..."}}
SLUG=$(python3 -c "import json,sys; print(json.load(open('/tmp/upload-resp.json'))['data']['session_slug'])")
echo "Uploaded. View at $BASE_URL/chat/$SLUG"
```

## Failure modes

| HTTP | Cause | Remedy |
|------|-------|--------|
| 401  | `sessionid_ace` missing/expired | Re-run e2e-login; check token value. |
| 403  | e2e-login route disabled (instance has `ACE_E2E_AUTH_TOKEN` empty) | Set the env var on the target deployment. |
| 409  | Transcript already uploaded (duplicate `cli_session_id`) | Expected on re-runs; treat as success for idempotency. |
| 400 "file is required" | Multipart malformed | Check that the `-F "file=@..."` form field is present. |

## Reference

- ace-web `docs/architecture/cli-credentials.md` — broader auth model
  context. This skill uses the *e2e* flow (shared secret → session
  cookie), not the per-user CLI credential flow (laptop credential blob
  upload).
- ace-web `apps/ingest/views.py` defines the upload endpoint
  (`IsAuthenticated`, `MultiPartParser`). Any authenticated session —
  including the e2e-login `ace@dimagi-ai.com` session — can POST to it.
