# `ocs_upload_collection_files` Inline-Base64 Context Wedge (Phase 5 Stream-Idle Timeout)

**Status:** Mitigated in ACE v0.13.279 via `file_path` mode on `ocs_upload_collection_files`. Old inline `content` mode preserved for tiny strings (back-compat) but discouraged via tool description.

**Origin:** `leep-paint-collection` run `20260517-1515` Phase 5 — two consecutive `ace:ocs-setup` subagent dispatches hit stream-idle timeouts (one at ~30 min / 49 tool calls, second at ~114 min / 44 tool calls) without writing any Drive artifacts. Both stalled at the same point.

## What was framed as the bug (early hypotheses, in order of refutation)

1. **RAG indexing wedge** — `ocs_wait_for_collection_indexing` polling forever. Refuted: the wedge happened before any indexing call.
2. **Per-prompt QA loop** — `ocs_send_test_message` taking minutes each. Refuted: Phase 5 never reached QA in either dispatch.
3. **Auth / re-login churn** — Playwright session expired, atoms retrying. Refuted: no auth errors in either transcript.
4. **OCS server slowness** — Refuted: every atom that ACTUALLY ran completed in seconds. `ocs_clone_chatbot` ~13s, `ocs_create_collection` ~2s, `ocs_upload_collection_files` ~4s.

## What the bug actually is

**Model-generation stall caused by inflated agent context.** Both dispatches followed the same pattern:

1. Agent built the RAG content pack on disk (PDD + summaries + test prompts ≈ 50-67 KB combined).
2. Agent ran `base64 <file >file.b64` via Bash to encode it (correct).
3. **Agent then `Read` the resulting `.b64` files in quarters back into its own context** so it could emit the b64 string as part of the `ocs_upload_collection_files` tool_use `input.files[].content` field.
4. Next assistant turn stalled mid-emission with `API Error: Stream idle timeout - partial response received`. The stall happened either WHILE emitting the b64 (dispatch 2 had a 15-minute mid-stall before one upload landed) OR AFTER the upload returned cleanly but with the b64 still in context (dispatch 2 ran for another 90 minutes after a successful upload before terminating).

The root cause: the `ocs_upload_collection_files` MCP atom's `content` field required a base64 string the agent had to generate as output tokens. For non-trivial RAG payloads (10s of KB → 100s of KB of b64 ASCII), generating that many output tokens in a single tool_use input either stalls outright or accumulates enough context to stall the next turn.

## Proof (session-log evidence)

Source: `~/.claude/projects/-Users-jjackson-emdash-worktrees-ace-emdash-e2e-leep-paint-vsvc9/10b0a209-02b1-48ac-9c49-1a4a0309db96/subagents/agent-{a9539456f8738dccc,aabc8f9d0efda8e30}.jsonl`.

Dispatch 1 (`a9539456f8738dccc`): last 10 tool calls all `Read` calls on b64-chunk tmp files (`/tmp/b64_0_q1..q4.txt`). Final assistant text reads "Excellent. Now I have all 4 b64 chunks... The cleanest path: build the JSON in...". Next token never arrives. Stream-idle terminator. **22m 42s silent gap** between the last tool call and the timeout.

Dispatch 2 (`aabc8f9d0efda8e30`): same prefix shape (b64 chunks, Read calls), then one `ocs_upload_collection_files` succeeded with 3 files in 4s. Last assistant text reads "3 of 4 uploaded. Now upload the 4th." Next token never arrives. **1h 30m silent gap** before stream-idle. The successful upload's b64 was still in context, sufficient to stall the next turn.

OCS atoms never reached `ocs_wait_for_collection_indexing`, `ocs_set_chatbot_system_prompt`, `ocs_set_chatbot_pipeline`, or any QA step.

## Fix shipped (ACE v0.13.279)

`mcp/ocs-server.ts` — `ocs_upload_collection_files` extended to accept `file_path` as an alternative source per file. The MCP reads the file server-side, no b64 ever crosses the agent's context. New exclusivity rule enforced server-side: each file MUST supply EXACTLY ONE of `content` (legacy inline b64) or `file_path` (absolute filesystem path). Mixed or missing sources fail fast with a named error citing the offending file.

Refactor: the file-decoding logic moved into a standalone exported helper `decodeUploadCollectionFileSource` so it's unit-testable in isolation.

7 new vitest cases in `test/mcp/ocs/unit/upload-collection-files-decoder.test.ts` covering:

- `file_path` reads UTF-8 text bytes verbatim
- `file_path` reads arbitrary binary bytes verbatim
- `content` (legacy) decodes inline b64
- Missing source → typed error naming the file
- Both sources → typed error naming the file
- ENOENT on missing file_path propagates cleanly

## Skill / agent-side guidance

Phase 5 `ocs-content-pack` + any future skill that calls `ocs_upload_collection_files` SHOULD use `file_path` for any payload > ~1KB. The pattern:

```ts
// Write the content to a tmp file via Bash. Never Read it back.
await Bash(`echo "$content" > /tmp/leep-rag/pdd-summary.md`);
// Or: drive_download_binary into a tmp path for files already on Drive.
await Bash(`drive_download_binary ... | base64 -d > /tmp/leep-rag/pdd.md`);

// Then upload by reference:
await ocs_upload_collection_files({
  collection_id: 123,
  files: [{
    name: 'pdd.md',
    file_path: '/tmp/leep-rag/pdd.md',  // absolute path; MCP reads + b64s server-side
    mime_type: 'text/markdown',
  }],
});
```

DO NOT `Read` the `.b64` files. DO NOT `Read` the original markdown files into context if all you're going to do is re-emit them through the upload tool — that's the wedge.

## Generalization

This is a different shape from the 50-char slug trap (#347/#1195) and the `short_description` 50-char trap (`docs/learnings/2026-05-12-connect-opp-short-description-50-char-trap.md`):

| | short_description / slug trap | b64-context wedge |
|---|---|---|
| Layer | Connect DB column / serializer | Agent context / model generation |
| Failure shape | Opaque HTTP 500 with empty body | Stream-idle timeout (no error response, just stall) |
| Pre-fix preventer | Column width / serializer validation | None |
| Post-fix preventer | Zod cap / CCZ projection gate | MCP atom accepts file_path (caller never holds payload) |
| Class | Postgres column overflow | Output-token budget exhaustion |

**Generalized boundary-probe candidate (for the registry):** any MCP atom whose input schema accepts large binary-or-encoded content as a string parameter is a wedge candidate. The systemic fix is to give every such atom a `file_path` (or `drive_file_id`) alternate source so the agent never holds the payload as output tokens. Audit candidates today:

- `commcare_upload_multimedia` — already has `file_bytes_path` (correct pattern; this PR's `file_path` adoption matches it)
- `drive_upload_binary` — currently inline `content` only; same wedge class
- `ocs_upload_collection_files` — fixed by this PR
- `commcare_patch_xform` — has both `new_xform_xml` and `new_xform_xml_path`; correct
- `drive_create_file` / `drive_update_file` — content is typically text (markdown, YAML), so the wedge bound is higher but still real for >100KB docs

The registry entry under § Shipped probes would name "input-payload size at MCP atom boundary" as the class, with this PR + `commcare_upload_multimedia`'s `file_bytes_path` + `commcare_patch_xform`'s `new_xform_xml_path` as the existing instances.

## See also

- `docs/learnings/2026-05-12-boundary-probe-registry.md` — registry update will add this as Shipped probe.
- `mcp/ocs-server.ts` § `ocs_upload_collection_files` — the fix.
- `test/mcp/ocs/unit/upload-collection-files-decoder.test.ts` — the tests.
- Session log subagent transcripts (above) — the bisect evidence.
