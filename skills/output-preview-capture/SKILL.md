---
name: output-preview-capture
description: >
  Screenshot run outputs that lack a preview. Use at each phase end.
disable-model-invocation: false
---

# Output Preview Capture

Every output ace-web lists must be either a file its in-page viewer draws, or
have one or more GOOD screenshots (ace-web `docs/specs/2026-09-29-output-previews-design.md`,
addendum "every output is a doc or has screenshots"). ace-web computes which
outputs are neither — the **gap list** — and this skill photographs them.

A UTILITY skill, like `decisions-render`: it is not a `run_state` step, it is
idempotent, and it never fails or blocks a phase. Called by each phase agent
from Phase 3 to Phase 8 at the end of its write-back (filtered to that phase),
and once by the orchestrator at run end (all phases, `--run-end`).

Deterministic pieces live in `lib/preview-capture.ts` (gap parsing, which gaps
to take now, folder, per-kind shot plan, page screening, index) on top of the
contract helpers in `lib/output-previews.ts`; both are pinned by tests. The
browser work is `scripts/output-preview-capture.ts`. What stays here is the
Drive I/O and the one thing no script can do: **looking at every frame**.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| ace-web | `GET {ACE_WEB_BASE_URL}/api/w/{workspace}/opps/{opp}/runs/{run}/preview-gaps` | the gap list — `output_key`, `phase`, `kind`, `url`, `auth` per output. Used VERBATIM; never re-derive ace-web's product walk |
| Per-run state | `run_state.yaml` | product fields the gap does not carry: a chatbot's `public_url` / `team_slug` + `public_id`, a solicitation's `labs_program_id`, a program's `name` |
| Phase 2 | `2-scenarios/pdd-to-test-prompts.md` | the ONE real question the chatbot picture shows answered |
| Caller | `opp`, `run_id`, `captured_phase` (the run_state phase key this runs in), optional phase filter, `--run-end` | scope |

## Products

For each gap captured, in the folder of the phase that BUILT the output:

- `<N>-<phase>/previews/<slug of output_key>/<NN>-<step>.png` — the accepted frames (anyone-with-link).
- `<N>-<phase>/previews/<slug of output_key>/_previews.yaml` — the authoritative index: `captured_by: output-preview-capture`, `captured_phase: <caller's phase>`, one caption per frame saying what the frame SHOWS. Real YAML bytes (`drive_upload_binary`, `text/yaml`), never a Google Doc.

Nothing about previews is written under `phases.<phase>.products` — ace-web
reads any mapping there with a `file_id` as an output.

## What makes a GOOD screenshot (per kind)

`planCapture` in `lib/preview-capture.ts` is the table in code:

| Kind | Frame(s) | Session |
|---|---|---|
| `connect_opportunity` | top of the opportunity page (apps, payment units, dates, budget); then its Verification / payments section | connect |
| `connect_program` | its CARD on `…/a/<org>/program/` — Connect has no program detail route; the recorded `/program/<uuid>/` 404s | connect |
| `chatbot` | the PUBLIC chat page (`public_url`) with one real Phase 2 question answered — never the OCS admin page | none (anonymous) |
| `solicitation` | its labs page opened with `?program_id=<labs_program_id>` — labs' sticky context otherwise 404s it | labs |
| `dashboard` / labs report | the rendered report, top of page, with data loaded | labs |
| `walkthrough` (canopy DDD package) | the package page at its walkthrough's first scene — its hero video is H.264, which headless Chromium paints white | canopy |
| `commcare_app` (fallback) | the HQ app's Form Summary — only once the Phase 6 emulator walk has had its turn (deferred before Phase 6; never deferred at run end) | hq |
| Drive file the viewer cannot draw | an HTML file rendered in Chromium; otherwise Drive's thumbnail | Drive service account |

## Process

1. **Resolve the run and the scope.**
   - `opp`, `run_id`, and `captured_phase` come from the caller. At run end
     `captured_phase` is the last phase that ran, and pass `--run-end`.
   - The workspace is the plugin `.env`'s `ACE_WEB_WORKSPACE` (the script reads
     it; pass `--workspace` only for a run in another workspace — the same rule
     as `bin/ace-bind`).
   - Resolve the run folder with `resolve_opp_path`. Read `run_state.yaml` to a
     local file (`drive_read_file` `writeToPath`, default `text/plain` export) and,
     when the scope includes `ocs-setup`, `2-scenarios/pdd-to-test-prompts.md`
     the same way.
   - Scratch dir: `<scratchpad>/output-preview-capture/<run_id>-<captured_phase>/`.

2. **Capture.** One Bash call; the script restores every session itself
   (below) and writes nothing to Drive:

   ```bash
   ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/output-preview-capture.ts" capture \
     --opp <opp> --run <run_id> --captured-phase <captured_phase> \
     [--phase <phase-to-filter>] [--run-end] \
     --run-state <local run_state.yaml> [--test-prompts <local pdd-to-test-prompts.md>] \
     --out <scratch dir>
   ```

   The last stdout line is a JSON summary (`captured`, `failed`, `skipped`,
   `deferred`); `<scratch dir>/plan.json` has, per gap, the target `folder`
   (relative to the run folder), the local frame paths, each frame's caption and
   its deterministic screen verdict. The script already retried each failure once
   with a fresh session. A 404 from ace-web means its gap endpoint is not deployed
   — report that and stop (nothing to do, nothing to fail).

   **Sessions — all headless, all work on canopy's cloud runner:**
   - **connect / hq:** `PlaywrightSession` (the ace-connect MCP's own session
     code): probes Connect AND HQ, re-logs-in from `ACE_HQ_USERNAME` /
     `ACE_HQ_PASSWORD`, persists `~/.ace/connect-session.json`. `/ace:connect-login`
     is only the manual fallback when those credentials cannot log in.
   - **labs:** runs `bin/labs-walkthrough-login.ts` once, unconditionally, before
     the first labs gap — Phase 7 Step 3.0's restore — and uses
     `~/.ace/labs-session.json`. `/ace:labs-login` is the same script.
   - **canopy:** a canopy PAT as a Bearer header, resolved as canopy resolves it:
     `CANOPY_WEB_PAT`, then `~/.<CANOPY_AGENT or ace>/.env`, then
     `~/.claude/canopy/workbench-token`. A labs session does NOT open canopy pages
     (they bounce to Google sign-in).
   - **ocs:** none — the chatbot's public chat page is anonymous.
     `/ace:ocs-login` is not needed for previews.
   - **google:** the Drive service account key (`gws-sa-key.json`).

3. **LOOK at every frame — this is the gate, not the screen verdict.** `Read`
   each PNG listed for a `captured` gap. Reject a frame that shows a login or
   sign-in page, an error or 404, a spinner / "loading" / an empty report (a
   report with no numbers, a table with no rows), a blank or white page or
   video box, a context picker ("Select context", "No organizations found"), or
   the WRONG thing (a different opportunity, program or chatbot than the gap's
   title). Also reject one whose caption does not describe what is actually on
   it — or rewrite the caption to what it shows. The deterministic screen only
   catches the obvious; passing it proves nothing.
   - **All frames of a gap rejected:** re-run step 2 ONCE for that gap alone
     (`--only <gap id>`); a second rejection means write NOTHING for that output
     and record why (what the frame showed).
   - A `failed` or `skipped` gap: nothing to upload; carry its reason to the report.

4. **Write each gap that has ≥1 accepted frame.** Per gap, in order:
   1. **Folder.** `plan.json`'s `folder` is `<N>-<phase>/previews/<slug>`.
      Find the `<N>-<phase>` folder in the run folder (`drive_list_folder`), then
      `drive_create_folder` (find-or-create) `previews`, then `<slug>` inside it.
   2. **Ownership check, then clear.** `drive_list_folder` the slug folder. If it
      holds a `_previews.yaml` whose `captured_by` is NOT `output-preview-capture`
      and that lists ≥1 item, another skill owns this output's previews and the
      gap list is stale — write nothing, note it. Otherwise (empty, ours, or an
      `items: []` index from a failed Phase 6 leg) `drive_trash_file` every child:
      a re-capture REPLACES, frames of two captures never mix. Never touch any
      other folder — Phase 6's app folders and Phase 7's dashboard folders are
      only ever written here when the gap list says that output has NO previews.
   3. **Upload** each accepted PNG under its `plan.json` name —
      `drive_upload_binary({name, localFilePath, mimeType: 'image/png', parentFolderId, shareAnyoneWithLink: true})`.
   4. **Index.** Write the uploads as `[{name, file_id}]` to a local JSON file
      (accepted frames only, in display order), then:
      ```bash
      node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/output-preview-capture.ts" index \
        --plan <scratch dir>/plan.json --gap <gap id> --uploaded <uploads.json>
      ```
      It writes `<scratch dir>/<slug>/_previews.yaml` (`buildCaptureIndex` →
      `captured_by: output-preview-capture`, `captured_phase`, captions). If you
      rewrote a caption in step 3, edit it in `plan.json` first. Upload it with
      `drive_upload_binary({name: '_previews.yaml', mimeType: 'text/yaml', localFilePath, parentFolderId})`
      — **never** `drive_create_file`.
   5. **Read it back and assert.** `drive_read_file({fileId, writeToPath})`, then
      `… output-preview-capture.ts verify --plan … --gap <id> --readback <file> --count <N>`.
      Exit 1 → re-upload once; still failing → trash the folder's contents and
      report the output as not previewed (an index a reader cannot parse is worse
      than none).

5. **Re-fetch the gap list and report.**
   ```bash
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/output-preview-capture.ts" gaps \
     --opp <opp> --run <run_id> [--phase <phase>]
   ```
   (ace-web's snapshot cache follows Drive's Changes API, so a just-written
   index can take one request to show; a gap you just filled that is still
   listed is reported as "written, not yet visible", not as a failure.)
   Return ONE line the caller puts in its phase summary:
   `previews: N captured, M gaps left (<output_key>: <why>; …)`, plus the
   deferred app gaps at Phase 3 (`apps.learn: waits for the Phase 6 walk`).

## Best effort — this skill never fails a phase

Any error — ace-web unreachable, no credentials, a login that will not
complete, Drive refusing a write — ends with the report line naming it. It
never throws to the caller, never writes a verdict, never touches
`run_state.yaml`, and never re-dispatches a producer. A missing picture is
reported; it is not a blocker.

## MCP Tools Used

- **ace-gdrive:** `resolve_opp_path`, `drive_list_folder`, `drive_read_file`,
  `drive_create_folder`, `drive_trash_file`, `drive_upload_binary`.

Scripts (Bash): `scripts/output-preview-capture.ts` (`gaps`, `capture`,
`index`, `verify`), which calls `bin/labs-walkthrough-login.ts` for the labs
restore.

## Mode Behavior

- **Auto / default / review:** identical — no pause, no prompt. The frames are
  judged by this skill's own look in step 3, not by a human gate.
- **Dry-run:** run steps 1–3 (capture and look) and report; skip step 4's
  Drive writes.

## Related skills

- `app-screenshot-capture` — primary writer of `3-commcare/previews/apps-*` (Phase 6 emulator walk); this skill is its fallback only.
- `agents/synthetic-data-and-workflows.md § Step 3.95` — primary writer of `7-synthetic/previews/synthetic-workflows-*` from the DDD render.
- `decisions-render` — the same utility-skill shape (every phase end, idempotent).

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-09-29 | Initial skill (ace-web output previews addendum: every output is a doc or has screenshots). Reads ace-web's `preview-gaps` list and photographs the Connect program/opportunity, the chatbot's public chat with a real Phase 2 question answered, the solicitation, labs reports, the canopy DDD package, Drive files the viewer cannot draw, and — as a fallback after Phase 6 — CommCare apps via HQ's form summary. Every frame is looked at before upload. Called at the end of Phases 3–8 and at run end. Smoke-tested live on spark-facilitator/20260926-1800's outputs (8/8 kinds captured; Drive write + readback verified in a scratch folder). | ACE team |
