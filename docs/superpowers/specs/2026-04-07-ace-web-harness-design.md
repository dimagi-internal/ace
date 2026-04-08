# ACE Web Harness — Module 1 Design

**Date:** 2026-04-07
**Status:** Draft for review
**Owner:** Jon

## Context

This is Module 1 of a larger "ACE web system" — a complete browser-based surface for the ACE (AI Connect Engine / CRISPR-Connect) initiative. The full system will eventually include ~13 modules covering the 21-step ACE process flow (IDD library, opportunity pipeline dashboard, per-opportunity workspace, app preview, test plans, training materials, LLO directory, comms log, babysitter dashboard, analyzer dashboard, closeout, OCS sync / agent provisioner, and more).

Module 1 is the **chat harness + transcript library**. It exists because the team needs a way to run conversations with ACE through a browser, share those conversations with others, and have a persistent library of past ACE conversations to reference. It is also the cross-cutting foundation the other modules will layer on top of.

**Two sample IDDs** (Vaccine Hesitancy focus groups and Turmeric Market Survey) were used to stress-test ACE's current assumptions in the conversation that preceded this design. Those observations are saved at `docs/examples/idd-stress-test-observations.md` and inform the module roadmap below.

## Goals

1. Internal-team members can start and continue multi-turn Claude conversations in a browser, using Jon's Claude subscription via the local `claude` CLI running inside a GCP Cloud Run container.
2. Conversations are persistent, searchable, and shareable within the team.
3. Existing local `.jsonl` transcripts (from `~/.claude/projects/`) can be uploaded via a small CLI command and become first-class viewable/shareable sessions.
4. Multi-player collaboration from day one: multiple team members can join a session, see each other's presence, and collaboratively compose the next message via a shared "Next message" draft backed by a queue of other parallel drafts.
5. Architectural foundation that protects future modules: pluggable chat backends, nullable hooks for opportunity / OCS agent / IDD references, append-only message log, many-to-many user-session model.

## Non-goals (Module 1)

- Building the `APIBackend` or `MCPAugmentedBackend` implementations. The interface contracts are defined, only `CLIBackend` ships.
- Any LLO-facing surface. Internal team only.
- Public (unauthenticated) share URLs. Share tokens give pretty URLs but still require team login via IAP.
- Extracting the CLI-bridge code into a shared library. That's a refactor planned after Module 1 stabilizes.
- IDD library, opportunity workspace, OCS sync, or any other non-chat module.
- Multi-instance Cloud Run scaling. Module 1 runs on a single instance to avoid Redis-for-Channels and shared-auth-token complexity.
- CRDT-based collaborative editing. Last-write-wins at ~500ms debounce is sufficient given low conflict rates and Slack-based human coordination.

## Architectural approach

Approach 3 from the brainstorm: **pluggable `ChatBackend` interface** with `CLIBackend` as the only implementation shipping in Module 1. The interface is designed so `APIBackend` and `MCPAugmentedBackend` can be added later as drop-in implementations. Postgres is the source of truth for all session state; the CLI's own session files inside the container are a side effect we don't read.

The harness copies rather than extracts the CLI-bridge patterns from canopy-web (`subprocess.run(["claude", "-p", ...])` with scrubbed env, headless PTY-based `claude setup-token` auth flow, circuit breaker on consecutive CLI failures, GCS-backed token persistence). After Module 1 ships, we refactor the shared bits into a small Python package and retrofit canopy-web.

### System diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ BROWSER (React 19 + Vite + Tailwind)                           │
│                                                                 │
│  Pages:                                                         │
│    /                       → SessionListPage (library)         │
│    /new                    → NewSessionPage                    │
│    /s/:slug                → SessionPage (chat + draft + queue)│
│    /settings               → SettingsPage (backend/auth)       │
│                                                                 │
│  Real-time: WebSocket → /ws/session/:slug                       │
│  HTTP: REST → /api/*                                            │
└─────────────────────────────────────────────────────────────────┘
                  ↓ (HTTPS via GCP IAP)
┌─────────────────────────────────────────────────────────────────┐
│ GCP CLOUD RUN — Django + Channels (ASGI via uvicorn)           │
│                                                                 │
│  Django apps:                                                   │
│    sessions/  — Session, Message, Draft, Participant models    │
│    chat/      — ChatBackend protocol + CLIBackend impl         │
│    ingest/    — upload endpoint for local .jsonl files         │
│    auth/      — IAP header parsing → Django user                │
│    common/    — shared utils adapted from canopy-web            │
│                                                                 │
│  Channels consumer: SessionConsumer — per-session pub/sub       │
│  Subprocess: spawns `claude -p` per turn                        │
└─────────────────────────────────────────────────────────────────┘
                  ↓ (subprocess)
┌─────────────────────────────────────────────────────────────────┐
│ LOCAL CLAUDE CODE CLI (inside the Cloud Run container)         │
│  npm install -g @anthropic-ai/claude                            │
│  Auth via CLAUDE_CODE_OAUTH_TOKEN from GCS-backed volume        │
└─────────────────────────────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────────────────┐
│ CLOUD SQL POSTGRES                                             │
│  Source of truth: sessions, messages, drafts, presence         │
│  Append-only message log                                       │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### `ChatBackend` protocol (`chat/backends/base.py`)

```python
class ChatBackend(Protocol):
    async def stream_turn(
        self,
        session: Session,
        history: list[Message],
        new_user_message: str,
    ) -> AsyncIterator[ChunkEvent]:
        """Yield chunks as they arrive.

        Chunk event types: text_delta, tool_use, tool_result, done, error.
        """

    def health(self) -> BackendHealth:
        """Return current health: installed, authed, circuit-breaker state."""
```

Three planned implementations (only the first ships in Module 1):

- **`CLIBackend`** — spawns `claude -p --output-format text` per turn via `subprocess.run` with `ANTHROPIC_API_KEY` scrubbed from env. History is assembled into a single combined prompt. Streams line-buffered stdout. Adapted from canopy-web's `anthropic_client._cli_call`.
- **`APIBackend`** *(stub only, shipped as `NotImplementedError`)* — direct Anthropic SDK call with the same interface.
- **`MCPAugmentedBackend`** *(stub only)* — API call with MCP client attached for tool calls.

### `SessionConsumer` (`sessions/consumers.py`)

Django Channels WebSocket consumer — one instance per open session tab. Handles presence heartbeats, draft edits, draft promotions, draft sends, and streams `message.chunk` events back to all subscribed peers. Group name = `session-{slug}`. Accepts/broadcasts the event types defined in the protocol section below.

### Components adapted from canopy-web

- CLI invocation pattern: `subprocess.run(["claude", "-p", "--output-format", "text"], input=prompt, env=_clean_env())`
- PTY-based `claude setup-token` headless auth flow (`common/auth_flow.py`)
- Circuit breaker on consecutive CLI failures
- GCS-mounted volume for persistent `CLAUDE_CODE_OAUTH_TOKEN`
- Backend health status endpoint + settings UI pattern
- Django project layout (apps/, config/, tests/)

### New components not in canopy-web

- `ChatBackend` protocol + backend registry (generalization of canopy-web's simple `AI_BACKEND` setting)
- Django Channels layer + `SessionConsumer`
- Draft / draft-queue models and last-write-wins edit sync
- Transcript upload + JSONL parse pipeline (adapted from canopy's `transcripts.py` scanner)
- Session share token generation
- `ace upload` CLI shipped as a separate package

## Data model

All tables have `id bigint pk`, `created_at`, `updated_at` unless noted.

### `users`

```
id                 bigint pk
email              text unique not null      -- from IAP X-Goog-Authenticated-User-Email
display_name       text not null
google_sub         text unique                -- from IAP X-Goog-Authenticated-User-ID
is_active          boolean default true
```

Populated from IAP headers on first request.

### `sessions`

```
id                 bigint pk
slug               text unique not null       -- short URL-safe id
title              text                       -- auto from first message, editable
owner_id           bigint fk → users.id
backend_kind       text not null              -- 'cli' | 'api' | 'mcp' (only 'cli' in Module 1)
backend_config     jsonb default '{}'
status             text not null              -- 'active' | 'archived' | 'imported'
source             text not null              -- 'web' | 'upload'
opportunity_id     bigint null                 -- placeholder, future opp module
ocs_agent_id       text null                   -- placeholder, future OCS sync module
idd_ref            text null                   -- placeholder, future IDD library module
cli_session_id     text null                   -- claude CLI's own session UUID, if we use --resume
```

Nullable placeholders for `opportunity_id`, `ocs_agent_id`, and `idd_ref` exist so later modules attach to existing sessions without a schema migration.

### `session_participants`

```
id                 bigint pk
session_id         bigint fk → sessions.id
user_id            bigint fk → users.id
role               text not null              -- 'owner' | 'editor' | 'viewer'
joined_at          timestamptz
last_seen_at       timestamptz                 -- heartbeat for presence
unique (session_id, user_id)
```

"Who's in the session right now" = participants with `last_seen_at` within the last ~30 seconds.

### `messages`

Append-only. One row per turn. Never updated after `status='complete'`.

```
id                 bigint pk
session_id         bigint fk → sessions.id
turn_index         int not null               -- monotonic per session
role               text not null              -- 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'
sender_user_id     bigint null                -- who hit send (user turns only)
content            jsonb not null             -- structured blocks matching Claude Code JSONL format
plaintext          text                       -- denormalized text rendering for search/list-view
status             text not null              -- 'pending' | 'streaming' | 'complete' | 'error'
error_detail       text null
started_at         timestamptz
completed_at       timestamptz null
unique (session_id, turn_index)
```

`content` is JSONB matching Claude Code's JSONL format so uploaded transcripts insert verbatim with no lossy conversion. `plaintext` is a denormalized cache for search.

### `drafts`

The collaborative "Next message" slot and the queue behind it.

```
id                 bigint pk
session_id         bigint fk → sessions.id
creator_user_id    bigint fk → users.id       -- original creator for attribution
slot               text not null              -- 'next' | 'queued'
queue_position     int null                   -- order in queue; null if slot='next'
body               text not null default ''   -- current collaborative text
version            int not null default 0     -- incremented per edit
last_editor_id     bigint fk → users.id
status             text not null              -- 'open' | 'sent' | 'discarded'
sent_at            timestamptz null
sent_message_id    bigint fk → messages.id null
```

Enforced by partial unique index:

```sql
create unique index one_next_per_session
  on drafts (session_id) where slot = 'next' and status = 'open';
```

### `share_tokens`

```
id                 bigint pk
session_id         bigint fk → sessions.id
token              text unique not null
created_by_id      bigint fk → users.id
revoked_at         timestamptz null
```

Pretty/revocable URLs. All share URLs still require team IAP login.

### `ingest_uploads`

Audit trail for `ace upload`.

```
id                 bigint pk
session_id         bigint fk → sessions.id
uploaded_by_id     bigint fk → users.id
source_path        text
raw_bytes          bigint
line_count         int
cli_session_id     text
```

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/me` | Current user from IAP headers |
| `GET` | `/api/sessions` | List sessions; query `q`, `limit`, `cursor` |
| `POST` | `/api/sessions` | Create session; body `{title?, backend_kind?}` |
| `GET` | `/api/sessions/:slug` | Full session + participants + messages + drafts |
| `PATCH` | `/api/sessions/:slug` | Update title / status / backend_config |
| `POST` | `/api/sessions/:slug/participants` | Add participant by email |
| `POST` | `/api/sessions/:slug/share-tokens` | Create share token |
| `DELETE` | `/api/sessions/:slug/share-tokens/:id` | Revoke share token |
| `POST` | `/api/ingest/upload` | Upload `.jsonl`; multipart; returns session |
| `GET` | `/api/backends` | List backends + auth status |
| `POST` | `/api/backends/auth/start` | Start headless PTY auth flow |
| `POST` | `/api/backends/auth/complete` | Submit auth code |
| `GET` | `/api/backends/auth/poll` | Non-blocking auth status poll |
| `GET` | `/health` | Cloud Run health check |

No REST "send message" endpoint — sending is a WebSocket event because the server streams the assistant response back to all participants.

## WebSocket protocol (`/ws/session/:slug`)

### Client → server

| `type` | `payload` |
|---|---|
| `presence.heartbeat` | `{}` |
| `draft.enqueue` | `{body}` |
| `draft.edit` | `{draft_id, body, version}` |
| `draft.promote` | `{draft_id}` |
| `draft.discard` | `{draft_id}` |
| `draft.send` | `{draft_id}` |

### Server → client

| `type` | `payload` |
|---|---|
| `presence.snapshot` | `{participants: [...]}` (on connect) |
| `presence.join` / `presence.leave` | `{user}` |
| `draft.snapshot` | `{drafts: [...]}` (on connect) |
| `draft.updated` | `{draft}` |
| `draft.removed` | `{draft_id}` |
| `message.started` | `{message}` |
| `message.chunk` | `{message_id, chunk}` |
| `message.completed` | `{message}` |
| `message.errored` | `{message_id, error_detail}` |
| `backend.status` | `{kind, ok, detail}` |

### Turn flow on `draft.send`

1. Validate draft is in `slot='next'` and user is a participant
2. Insert `messages` row: `role='user'`, `status='complete'`, `content=[{type:'text', text: draft.body}]`, `sender_user_id=current user`, `turn_index=next`
3. Mark draft `status='sent'`, `sent_message_id=...`
4. Insert placeholder `messages` row: `role='assistant'`, `status='streaming'`
5. Broadcast `message.started` for both rows
6. Call `backend.stream_turn(session, history, draft.body)` async iterator
7. For each chunk: append to assistant row's `content`, broadcast `message.chunk`
8. On completion: update `status='complete'`, broadcast `message.completed`
9. On error: `status='error'`, `error_detail=...`, broadcast `message.errored`, bump circuit breaker

### Draft edit concurrency

Client sends `draft.edit` with local `version`. Server accepts if `version >= stored_version`, increments, rebroadcasts. If a peer already advanced the version, the client's edit is rejected and it receives a `draft.updated` echo with current state. Debounced ~500ms on the client.

### Concurrent turn lock

Only one turn in flight per session. If `draft.send` arrives while another turn is streaming, server rejects with reason "turn in progress."

## Error handling

- **CLI subprocess failures**: stderr + exit code become `error_detail` on a failed assistant row. Visible in the transcript with `status='error'`.
- **Circuit breaker**: 5 consecutive CLI failures → backend marked unhealthy; new turns rejected with a clear message until admin resets via `/api/backends/reset`. Copied from canopy-web.
- **Auth token expiry**: CLI reports "not logged in" → assistant row errors with a specific code → frontend shows "Re-authenticate" prompt that triggers the PTY auth flow.
- **WebSocket disconnects**: client auto-reconnects with exponential backoff; on reconnect receives `presence.snapshot`, `draft.snapshot`, and catches up on recent messages.
- **Database transactions**: creating user message + assistant placeholder + draft state transition happens in one transaction so no half-committed state.
- **Ingest errors**: malformed JSONL lines are logged and skipped; the upload succeeds if at least one valid message is parsed. Audit row records `line_count` (valid entries).

## Auth and deployment

### Auth
- GCP IAP in front of Cloud Run, restricted to the Dimagi org (or explicit allowlist)
- Django middleware reads `X-Goog-Authenticated-User-Email` and `X-Goog-Authenticated-User-ID` from every request; creates `users` row on first sight
- WebSocket auth uses the same headers on the upgrade request
- No API keys in the app. Claude subscription auth via mounted `CLAUDE_CODE_OAUTH_TOKEN` from GCS-backed volume.
- Share URLs pass through IAP — no public access in Module 1

### Cloud Run deployment
- Single container image: Django + Channels + built React SPA served via WhiteNoise (or nginx sidecar if perf matters)
- Claude CLI installed via `npm install -g @anthropic-ai/claude` during build
- ASGI runtime via `uvicorn` (canopy-web pattern)
- Scaling: min/max instances = 1 in Module 1. Multi-instance requires Redis for Channels layer and shared auth token — deferred.
- Cloud SQL Postgres for app data
- `CLAUDE_CODE_OAUTH_TOKEN` stored in Google Secret Manager; entrypoint script reads the secret on container start and writes it to the path the CLI expects. On successful re-auth via the PTY flow, the new token is written back to Secret Manager so it survives container restarts.
- Other secrets also in Google Secret Manager (Django `SECRET_KEY`, DB creds). No Anthropic API key in Module 1.
- CI/CD: adapt canopy-web's Cloud Run deploy GitHub Action

### `ace upload` CLI
Separate small Python package shipped as a console entry point:
- Reads harness URL from `~/.ace/config.toml` or `ACE_HARNESS_URL` env var
- Auths via `gcloud auth print-identity-token` against the IAP client ID (standard GCP pattern)
- `ace upload <path-to-jsonl>` → POSTs file to `/api/ingest/upload`
- `ace upload --session-id <claude-session-id>` → resolves path automatically from `~/.claude/projects/` using canopy's directory-mangling function
- Server parses line-by-line (skipping `file-history-snapshot`), creates `sessions` row with `source='upload'`, bulk-inserts `messages` preserving turn order

## Testing

Pytest with `pytest-django` and `pytest-asyncio`. Structure follows canopy-web.

### Unit tests
- `test_chat_backends.py` — `CLIBackend` with mocked `subprocess`: streaming, error, circuit breaker, env stripping
- `test_models.py` — `turn_index` monotonicity, one-next-per-session constraint, draft version bumping
- `test_ingest.py` — JSONL parsing against the canopy sample fixture; roundtrip upload → list → render preserves message content
- `test_drafts.py` — last-write-wins edit logic, promote/enqueue/discard state transitions
- `test_auth.py` — IAP header parsing, user creation on first sight

### WebSocket integration tests
Use Channels' `WebsocketCommunicator` to simulate multi-client scenarios in `test_ws_session.py`:
- Two clients edit the same draft → last write wins, both see same final state
- Client A sends → Client B receives `message.started` + `message.chunk` events
- Disconnect and reconnect → receives snapshots and catches up
- Presence join/leave events fire on connect/disconnect

### End-to-end smoke test (`test_e2e_cli.py`)
Requires CLI installed and logged in, gated by `CLAUDE_CLI_AVAILABLE` env var:
- Start session → send "say hello in one word" → assert assistant `status='complete'`
- Upload fixture `.jsonl` → assert session + messages created

Runs in CI only on protected branches, not every PR.

### Explicitly not tested
- The CLI itself (not our code)
- IAP (mocked in tests; relies on Cloud Run config)
- Frontend components (manual QA in Module 1; add Playwright in later module)

## Module roadmap (post-Module 1)

| Module | Depends on | Notes |
|---|---|---|
| 1. Chat harness + transcripts | — | **this spec** |
| 2. Shared library extraction | 1 | Refactor CLI-bridge patterns into Python package; retrofit canopy-web |
| 3. IDD library + stress-tester | 1 | Upload/store IDDs, run stress-test skill, view diffs |
| 4. Opportunity pipeline dashboard | 1, 3 | One row per opp, current step, status, blockers |
| 5. Per-opportunity workspace | 4 | All artifacts for one opp; spawns context-scoped chats |
| 6. App preview / Nova output viewer | 5 | Inspect `/builder` outputs |
| 7. Test plan / report viewer | 5 | `/tester` outputs and pass/fail |
| 8. Training material viewer | 5 | `/trainer` outputs |
| 9. LLO directory | 5 | Managed LLO contacts (also Connect Tech Work item) |
| 10. Comms log | 5 | `/communicator` + `/supporter` emails |
| 11. Babysitter dashboard | 5 | Timeline compliance, alerts |
| 12. Analyzer dashboard | 5 | FLW data summaries |
| 13. Closeout view | 5 | Invoices, feedback, learnings |
| 14. **OCS sync / agent provisioner** | 5 | Packages opportunity context and creates/updates an OCS chat agent for LLO support |

## Open questions deferred to implementation planning

- Whether to use `claude -p --resume <cli-session-id>` vs assemble-full-history-per-turn for the `CLIBackend`. Both work; picked during planning after testing CLI behavior.
- Exact Channels layer backing in Module 1 — in-memory is simplest for single-instance; `channels-redis` is needed if we ever go multi-instance. Default: in-memory.
- Whether `ace upload` is shipped in this repo or a separate `ace-cli` repo. Default: same repo, separate Python package under `cli/`.
- Whether the frontend is served by Django (WhiteNoise) or an nginx sidecar. Default: WhiteNoise for Module 1 simplicity.
