---
name: video-from-program-page
description: >
  Generate a new ace-web video program (spec.yaml + run-001) from a
  Connect program page URL using the 60s-campaign-overview template.
  Reads the page, optionally enumerates a Drive folder for media,
  fills the template's placeholders, and POSTs the complete spec to
  ace-web. Owns one artifact: the new program's spec.yaml in Drive.
disable-model-invocation: true
---

# video-from-program-page

Turn a Connect **program page URL** (e.g.
`https://labs.connect.dimagi.com/programs/chc`) into a fully-populated
`spec.yaml` for ace-web's videos surface, and write it as a new
program in the target workspace. The output is a Drive file at
`<workspace.drive_root>/videos/<slug>/runs/run-001/spec.yaml` plus a
program detail page in the ace-web UI ready to render.

The generation step is an LLM-as-agent run (this skill, executing in
the current Claude session). Server-side CLI orchestration is a
follow-up; for now the human invokes this skill, the agent does the
extraction + filling + POST, and the resulting spec is editable in the
ace-web UI.

## When to run

- A new Connect program is operational and you want a 60-second video
  for stakeholder decks.
- You have a usable source URL (the canonical program page on Connect
  or a similar write-up). If you only have a one-paragraph brief,
  prefer hand-pasting into the ace-web UI rather than fighting the
  WebFetch step.

## Inputs

| Name | Required | Default | Notes |
|---|---|---|---|
| `program_url` | yes | — | The page to read. Treated as the source of truth for `program_name`, `country_focus`, headline stats. |
| `program_slug` | no | last URL path segment | Slug for the new video program. Must match `[a-z0-9][a-z0-9-]{0,63}`. |
| `workspace_slug` | no | `dimagi-team` | ace-web workspace to write into. |
| `template_id` | no | `60s-campaign-overview` | Currently the only template. |
| `gdrive_folder_id` | no | — | Drive folder holding the program's media. When set, the agent enumerates it and populates `manifest:` + clip refs. |
| `base_url` | no | `$ACE_WEB_BASE` or `https://labs.connect.dimagi.com/ace` | ace-web base URL. |
| `ACE_WEB_PAT_TOKEN` | yes (env) | — | Per-human Bearer token; mint via `/ace:ace-web-pat-mint`. |

## Outputs

1. **One Drive file** at `videos/<slug>/runs/run-001/spec.yaml` in the
   target workspace's Drive root.
2. **Stdout summary** — program detail URL + a list of any `[TBD]`
   placeholders the agent couldn't confidently fill (the operator
   will edit them in the UI).

## Preconditions

- `ACE_WEB_PAT_TOKEN` is set. If not, instruct the operator to run
  `/ace:ace-web-pat-mint` and stop.
- The target ace-web is reachable at `<base_url>/api/health`.
- The operator has Editor (or higher) membership in the target
  workspace.

## Steps

### 1. Resolve inputs

- Parse args. Strip trailing slash from `base_url`. Derive `program_slug`
  from the last path segment of `program_url` if not provided.
- Validate slug against `[a-z0-9][a-z0-9-]{0,63}`. Reject `..`, `/`,
  leading hyphen.

### 2. Fetch the template bundle from ace-web

```bash
curl -sS -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
  "$BASE_URL/api/w/$WORKSPACE_SLUG/videos/templates/$TEMPLATE_ID"
```

The response envelope's `data` field has:
- `meta` — template metadata (id, name, description, expected duration)
- `skeleton_yaml` — the `spec.template.yaml` skeleton with
  `{{placeholders}}`
- `prompt_md` — the generation instructions for the agent (this is
  the **load-bearing context** for what the agent fills)

Stop on non-200 with a clear error.

### 3. WebFetch the program page

Use the WebFetch tool against `program_url`. Capture:
- `program_name` (page H1 / `<title>`)
- `country_focus` (look for country mentions, "active in" lines)
- `program_tagline` (one-line description / hero subtitle)
- `status` (e.g. "Active in 4 countries", scale indicators)
- Headline stats: e.g. "1M+ verified visits", "350K beneficiaries"
- Partner / funder mentions (informational only)

If the page returns 4xx/5xx or has no extractable content, fall back
to operator-pasted source — print:

> "Could not auto-extract from `<program_url>` ({status}). Paste the
> program write-up below as raw text (Ctrl-D to finish), or rerun
> with a working URL."

…and read from stdin.

### 4. Optionally enumerate Drive media

If `gdrive_folder_id` is set, call:

```
mcp__plugin_ace_ace-gdrive__drive_list_folder { folder_id: gdrive_folder_id }
```

Filter to MP4 / MOV / PNG / JPG mime types. Suggest aliases by
filename: `web-microplan.mp4` → `@microplan`,
`field-walking-towards-house.mp4` → `@field-walk`. Format as the
`gdrive_media` input the template prompt expects:

```yaml
gdrive_media:
  - { name: "web-microplan.mp4", file_id: "1...", mime_type: "video/mp4", suggested_alias: "microplan" }
  - ...
```

If `gdrive_folder_id` is absent, skip — the generator leaves manifest
empty for hand-edit.

### 5. Fill placeholders per the template prompt

Apply `prompt_md` to the gathered inputs (`program_identity`,
`source_content`, `gdrive_media`, `brand`). Brand defaults come from
the template prompt itself; do NOT override `narration_hook` away from
the Connect tagline.

Per-beat narration word budgets (from the prompt — non-negotiable):
- hook ~10, cycle ~20, handoff ~8, scene ~20, problem ~25,
  product ~30, impact ~20, cta = empty.

Output JSON (per the prompt's "Output format" section):

```json
{
  "program_slug": "<slug>",
  "workspace_slug": "<ws>",
  "program_name": "<name>",
  ...
  "narration_hook": "...",
  ...
}
```

For any value the agent can't confidently extract, write
`"[TBD] <what's missing>"` so the operator can grep it.

### 6. Substitute placeholders into the skeleton

Replace every `{{placeholder}}` in `skeleton_yaml` with the
corresponding JSON value. If the JSON includes a `manifest` /
`scene.clips` / `product.beats` block (from step 4), append it to the
skeleton output (the skeleton's `manifest: {}` and empty `clips: []`
get replaced with the populated versions).

Validate that no `{{` remains in the output — if any placeholder is
unresolved, stop with an error listing the missing keys.

### 7. POST to ace-web

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/api/w/$WORKSPACE_SLUG/videos/programs" \
  -d "$(jq -nc --arg slug "$PROGRAM_SLUG" --arg spec "$SPEC_YAML" \
        '{slug: $slug, spec_yaml: $spec}')"
```

Expect 201. The response envelope's `data` has:
- `program_slug`, `run_id` (= "run-001"), `spec_path`, `message`

On 409 (program already exists), stop with the suggestion to either
pick a different `--slug` or use the ace-web UI to **copy** the
existing run and edit (since the skill writes only fresh `run-001`s).

On 400, surface the validation message (`detail` field) — the agent's
spec failed server-side validation; revisit the placeholder fill.

### 8. Report

Print to stdout:

```
✓ Created video program <slug> in workspace <ws>
  Detail:    <base_url>/w/<ws>/videos/<slug>
  Spec:      videos/<slug>/runs/run-001/spec.yaml
  Run:       run-001
  TBDs (N):  <list of "[TBD]" placeholders the operator should edit>

Next: open the detail URL above and click "Re-render" to produce
the first MP4. Or POST /programs/<slug>/runs/run-001/build for a
quick rebuild without re-rendering.
```

## Edge cases

- **Slug collision**: 409 from ace-web. Don't auto-suffix — slugs are
  human-meaningful identifiers. Surface the error and ask the operator
  to pick a different `--slug` or copy the existing run via the UI.
- **Sparse source page**: when WebFetch returns less than ~200 useful
  words, the agent should mark more fields `[TBD]` rather than invent
  numbers. The video can still render — the operator edits gaps in
  the UI before clicking Re-render.
- **Drive folder enumeration fails**: degrade silently — the manifest
  ships empty. The operator hand-attaches clips in the UI.
- **`narration_*` over word budget**: enforce ±2 from the prompt's
  table. Going long means the synthesizer cuts mid-word.
- **Brand-tagline drift**: `narration_hook` MUST paraphrase or use
  verbatim the Connect tagline from the prompt. Don't invent a
  different tagline.

## Shell reference

```bash
set -euo pipefail

[ -n "${ACE_WEB_PAT_TOKEN:-}" ] || {
  echo "ACE_WEB_PAT_TOKEN not set; run /ace:ace-web-pat-mint"; exit 2;
}

BASE_URL="${BASE_URL:-${ACE_WEB_BASE:-https://labs.connect.dimagi.com/ace}}"
BASE_URL="${BASE_URL%/}"
WORKSPACE_SLUG="${WORKSPACE_SLUG:-dimagi-team}"
TEMPLATE_ID="${TEMPLATE_ID:-60s-campaign-overview}"

# 1. Fetch template bundle
TEMPLATE_JSON=$(curl -fsS \
  -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
  "$BASE_URL/api/w/$WORKSPACE_SLUG/videos/templates/$TEMPLATE_ID")

# 2-6. Agent does the extraction + fill + substitution.
#      (Not shell — this is the part the LLM owns.)

# 7. POST the spec
curl -fsS -X POST \
  -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/api/w/$WORKSPACE_SLUG/videos/programs" \
  -d "$(jq -nc --arg slug "$PROGRAM_SLUG" --arg spec "$SPEC_YAML" \
        '{slug: $slug, spec_yaml: $spec}')"
```

## Why this lives in the ace plugin (not ace-web)

The ace plugin owns the **agent-driven content generation** skills —
they read from sources, fill templates, and write to durable storage
via MCP / HTTP. ace-web owns the **storage + UI surface** the artifact
lands in. Keeping the generation here means:
- The skill is reusable from any Claude Code session (interactive or
  `claude -p` headless) without needing ace-web to host the LLM.
- Template + prompt + skeleton live in ace-web (one source of truth),
  but the agent that fills them runs alongside the operator.
- A future server-side CLI invocation (`POST /videos/programs/from-url`)
  can re-implement the same flow without duplicating the agent loop.
