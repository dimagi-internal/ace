---
name: video-from-program-page
description: >
  Generate a new ace-web video program (spec.yaml + run-001) from a
  Connect program page URL using the 60s-campaign-overview template.
  Thin wrapper around video-spec-generate: sets source=<program_url> and
  template_id=60s-campaign-overview, then delegates all generation logic
  there. Owns one artifact: the new program's spec.yaml in Drive.
disable-model-invocation: true
---

# video-from-program-page

Turn a Connect **program page URL** (e.g.
`https://labs.connect.dimagi.com/programs/chc`) into a fully-populated
`spec.yaml` for ace-web's videos surface using the `60s-campaign-overview`
template, and write it as a new program in the target workspace.

**This skill is a thin wrapper.** It sets `source=<program_url>` and
`template_id=60s-campaign-overview`, then delegates all generation logic to
`/ace:video-spec-generate`. Refer to that skill for the full step-by-step
procedure, word-budget formula, voice rules, grounding rule, and edge cases.

For other templates or non-URL sources (pasted briefs, prospect research),
call `/ace:video-spec-generate` directly.

## Inputs

| Name | Required | Default | Notes |
|---|---|---|---|
| `program_url` | yes | — | The Connect program page to read. Becomes `source` in video-spec-generate. |
| `program_slug` | no | last URL path segment | Slug for the new video program. Derived and passed to video-spec-generate. |
| `workspace_slug` | no | `dimagi-team` | ace-web workspace to write into. |
| `template_id` | no | `60s-campaign-overview` | Template override; default is always `60s-campaign-overview`. |
| `gdrive_folder_id` | no | — | Drive folder for program media. Forwarded to video-spec-generate. |
| `base_url` | no | `$ACE_WEB_BASE` or `https://labs.connect.dimagi.com/ace` | ace-web base URL. |
| `ACE_WEB_PAT_TOKEN` | yes (env) | — | Per-human Bearer token; mint via `/ace:ace-web-pat-mint`. |

## Steps

1. **Derive `program_slug`** from the last path segment of `program_url` if
   not provided explicitly.
2. **Invoke `/ace:video-spec-generate`** with:
   - `template_id` = `60s-campaign-overview` (or the override)
   - `source` = `program_url`
   - `program_slug`, `workspace_slug`, `gdrive_folder_id`, `base_url` forwarded
   - `ACE_WEB_PAT_TOKEN` forwarded from env

All generation logic — template bundle fetch, source ingestion via WebFetch,
word-budget derivation, placeholder fill, skeleton substitution, validation,
POST, and reporting — runs inside `video-spec-generate`.

## Why this wrapper exists

`/ace:status` and the ACE artifact manifest reference `video-from-program-page`
as a first-class skill. This wrapper preserves that entry point while moving
all logic to the general generator, so improvements to `video-spec-generate`
apply here automatically without a separate edit.
