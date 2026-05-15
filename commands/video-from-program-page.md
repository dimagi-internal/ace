---
description: Generate a new ace-web video program (spec.yaml) from a Connect program page URL using the 60s-campaign-overview template
argument-hint: <program-url> [--slug=<slug>] [--workspace=<slug>] [--template=<id>] [--gdrive=<folder-id>] [--base-url=<url>]
allowed-tools: [Read, Write, Edit, Bash, WebFetch, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_read_file]
---

# /ace:video-from-program-page

Generate a fresh **ace-web video program** from a Connect program page
URL (or an operator-pasted brief). The agent reads the page, optionally
enumerates a Drive folder for media, fills the `60s-campaign-overview`
template, and POSTs the complete `spec.yaml` to ace-web — which writes
it to Drive at `videos/<slug>/runs/run-001/spec.yaml`.

After this command finishes, the program appears in the workspace's
Videos UI and the operator can click **Re-render** to produce the
first draft MP4.

## Arguments

- **`<program-url>`** *(required, first positional)* — the canonical
  program page on Connect or a similar source. Examples:
  - `https://labs.connect.dimagi.com/programs/chc`
  - `https://commcareconnect.com/connect-programs/kangaroo-care`
- `--slug=<slug>` — slug for the new video program in ace-web (e.g.
  `chc`, `kangaroo-care`). Defaults to the last path segment of
  `<program-url>`. Must match `[a-z0-9][a-z0-9-]{0,63}`.
- `--workspace=<slug>` — ace-web workspace to write into. Default:
  `dimagi-team`.
- `--template=<id>` — which video-spec template to use. Default:
  `60s-campaign-overview` (currently the only one).
- `--gdrive=<folder-id>` — optional Drive folder id holding the
  program's clip footage + screenshots. When given, the agent
  enumerates it and populates `manifest:` + `scene.clips[]` /
  `product.beats[]` asset refs. Omit and the spec ships with an empty
  manifest for the operator to hand-attach later.
- `--base-url=<url>` — ace-web base URL. Defaults to
  `$ACE_WEB_BASE` env var, else `https://labs.connect.dimagi.com/ace`.

## When to use

- A new Connect program reaches enough operational maturity to have
  field footage + app screenshots + at least two reportable outcome
  stats, and you want a 60-second video to drop into a deck.
- You want to seed ace-web with a video program quickly from an
  existing program write-up rather than authoring the spec by hand.

## Steps

The agent invokes the **`video-from-program-page`** skill, which:

1. Fetches the template bundle from ace-web.
2. WebFetches the program URL (or reads operator-pasted source).
3. Optionally enumerates the Drive folder for media.
4. Generates the placeholder-filled JSON per the template's prompt.
5. Substitutes placeholders into the skeleton to produce a complete
   `spec.yaml`.
6. POSTs the spec to ace-web's `POST /api/w/<workspace>/videos/programs`.
7. Prints the new program URL and any `[TBD]` items that need
   operator review.

The full contract lives in `skills/video-from-program-page/SKILL.md`.
