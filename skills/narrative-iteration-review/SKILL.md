---
name: narrative-iteration-review
description: >
  Produce a domain-expert-facing before/after (pre-post) Google Doc for a DDD narrative iteration,
  and read the expert's edits back. Pull the verbatim CURRENT narration from canopy-web, apply
  reviewer feedback into a PROPOSED next version, publish a scannable side-by-side doc a non-engineer
  can review, then read their suggestion-mode edits via the structured Doc. Use when iterating a
  Connect DDD narrative on expert feedback (e.g. RF Surveys / Sophie), when asked to "make a
  before/after of the narration", "iterate the narrative on <expert>'s feedback", or "let <expert>
  sign off on the language".
---

# Narrative iteration review

Turn a domain expert's feedback on a DDD walkthrough video into (a) a **proposed next version of the
narration**, presented as a **scannable before/after Google Doc the expert can review**, and (b) a
clean round-trip that **reads their edits back** and folds them in.

This is the ACE dogfooding loop for canopy DDD narratives. It is NOT the canopy `ddd-narrative-review`
gate (that posts a narrative for machine/story sign-off); this produces the human-readable language
review a subject-matter expert marks up.

## Vocabulary — "iteration / new version", never "fork"

canopy-web stores each narrative as a **versioned lineage** (`versions[]` under one slug). A new
iteration is the **next version in that lineage** (v12 → v13), not a fork. Jon wants the lineage
continuity; call them **iterations / new versions**. Do not say "fork" in artifacts or chat.

## The authoritative source of the CURRENT narration

The verbatim narration the expert reviewed is the **canopy-web narrative `story`** — NOT the
`docs/walkthroughs/<slug>.yaml` scene-spec (that drifts) and NOT reconstructed from rendered audio.

```
GET https://labs.connect.dimagi.com/canopy/api/ddd/narratives/<slug>/
Authorization: Bearer <canopy PAT>      # token at ~/.claude/canopy/workbench-token
```

Returns `current_version.version` and `current_version.story` (the full verbatim narration), plus
`versions[]` (the whole lineage, each with its own `story` — the native pre/post history). Use
`current_version.story` verbatim as the "CURRENT" text; the new version is `current_version.version + 1`.

## Procedure

1. **Resolve the narrative.** Get the slug (from the walkthrough URL context or the expert's notes).
   Fetch the narrative from canopy-web (above). Record the current version N and its `story`.
2. **Chunk the story into beats.** Split `current_version.story` into logical beats (one per
   scene/idea) for the side-by-side. Beats are for presentation only — the `story` text stays verbatim.
3. **Apply the feedback → PROPOSED (version N+1).** Rewrite each beat to fold in the expert's points
   and any locked decisions. Beats are **not 1:1**: feedback may add net-new beats (`[NEW]`), merge,
   or reorder. Honor locked decisions exactly (e.g. keep an agreed term; a chosen design steer).
4. **Publish the review doc** (template below) with `drive_create_doc_from_markdown` into the project
   folder; `drive_set_anyone_with_link` (view) so it can be forwarded. For inline expert comments,
   the human owner grants comment access (no per-user-grant atom; anyone-with-link is reader-only).
5. **Read the expert's edits — via `docs_get` (structured), NOT `drive_read_file`.** Experts edit in
   **suggestion mode**; the plain-text export returns the BASE text with suggestions UNAPPLIED, so a
   plain diff shows nothing. `docs_get` on a full doc is large and auto-saves to a tool-results file —
   grep it for `suggestedInsertionIds` / `suggestedDeletionIds`; each such run's `content` is the
   inserted or deleted text. Reconstruct each suggestion (insert X, delete Y) and confirm it back.
6. **Incorporate.** If no other pending suggestions remain, regenerate the doc with the edits baked
   into the PROPOSED text (accepts them cleanly). If other suggestions must be preserved, apply a
   **surgical `docs_batch_update` `replaceAllText`** on just the changed cells (extract byte-exact
   match strings from the `docs_get` dump; watch smart-quote vs straight-apostrophe).
7. **On sign-off**, author version N+1 through the canopy DDD `concept_change` gate and (if there are
   product changes) queue the connect-labs build items; then render.

## The review doc template (domain-expert-facing)

Keep the top **plain and short** — a non-engineer must understand it in 10 seconds. Put version
numbers, the API source, the DDD gate, and connect-labs build items in a small **internal footer**,
not the header. The two links the expert cares about: the **video they reviewed** and **their feedback**.

```markdown
# RF Surveys — Video <N> narration: before & after (<narrative-title>)

**What this is.** The narration — the words spoken in the video — shown side by side. **Left** is what
the current video says (the version you reviewed). **Right** is the proposed new version, rewritten to
fold in your feedback.

**What would help.** Read the right-hand column and mark up the wording — suggest edits right in the
doc (Google Docs "Suggesting" mode is ideal). Your eye on the *language* of the background and
narrative is exactly what we want; the mechanics are ours to handle.

**Links.** ▶ Video you reviewed: <walkthrough share url> · 📝 Your feedback: <expert feedback doc url> · 🔎 Full DDD narrative (web app, sign-in): https://labs.connect.dimagi.com/canopy/ddd/<slug>

## Narration — before & after  *(changed wording in bold)*

| # | Beat | Current — the video today | Proposed — new version |
| … one row per beat; bold the changed phrases in both columns; `[NEW]` beats show Current = "(new)" |

## The proposed narration, read straight through

> <the full proposed narration as flowing prose, so the expert can judge how it reads aloud>

## What changed, and why (from your feedback)

- <beat> — <the expert point> → <how the new version answers it>

---
*Internal (ACE team) — not for review:* CURRENT text = canopy-web narrative `story` for `<slug>`
(v<N>); proposed = v<N+1> in the same lineage, authored via the DDD `concept_change` gate.
connect-labs build changes: <list of real product changes the new narration implies>.
```

## Gotchas (each cost a real round-trip)

- **Diff the rendered voiceover, not the scene-spec.** The `docs/walkthroughs/<slug>.yaml` scene-spec
  and the stale `video-engine/.../run-001/spec.yaml` narration both DRIFT from the shipped video. The
  canopy-web `story` is the shipped, verbatim narration the expert actually watched.
- **Suggestion-mode edits are invisible to the plain-text export.** Always read edits via `docs_get`
  (structured) and grep the saved dump for `suggested{Insertion,Deletion}Ids`.
- **Regen wipes pending suggestions.** Only full-regen when no unaccepted suggestions must survive;
  otherwise edit surgically with `replaceAllText`.
- **Keep the header expert-readable.** No API paths, gate names, version mechanics, or "connect-labs"
  in the part the expert reads — those live in the internal footer.
- **Beats are not 1:1.** Feedback legitimately adds/merges/splits beats; show `[NEW]` explicitly and
  never silently drop a current beat.
- **Two different URLs — include both.** The video's `?t=<token>` walkthrough link is the anonymous
  share link (works for anyone, e.g. an external reviewer). The DDD narrative page
  `https://labs.connect.dimagi.com/canopy/ddd/<slug>` (versions + runs in the web app) **requires a
  canopy sign-in** (an anonymous GET 302s to login), so it's for framework-familiar reviewers. Link
  the video for everyone and the DDD page for the DDD-literate.
