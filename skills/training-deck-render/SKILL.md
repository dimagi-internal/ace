---
name: training-deck-render
description: >
  Render a training deck spec.yaml into a Google Slides deck via the
  14-stencil ACE template. Produces a presentable Slides URL.
disable-model-invocation: false
---

# Training Deck Render

Reads `training-deck-spec.yaml` from Drive, validates it, resolves the
manifest, copies the template, and executes the Slides batchUpdate
pipeline. Single-pass (no speaker notes).

## When to run

Phase 6 (`qa-and-training`), after `training-deck-generate`. The last
training material step before Phase 7.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 6 (`training-deck-generate`) | `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-deck-spec.yaml` | The spec to render |

## Inputs (env)

- `ACE_TRAINING_DECK_TEMPLATE_ID` — the 14-stencil Slides template.

## Process

1. **Read** `training-deck-spec.yaml` from the run's
   `6-qa-and-training/` folder.

2. **Parse and validate** via `parseTrainingSpec(yamlStr)` — halt on
   validation error.

3. **Resolve manifest** via `resolveManifest(spec.manifest)`.

4. **Check image aliases.** Verify all image aliases used in
   `walkthrough` / `mobile_flow` / `web_screen` / `mobile_zoom` /
   `two_column` slides are resolvable against the manifest. HALT if
   any are unresolvable — do not render a partial deck.

5. **Verify env.** Confirm `ACE_TRAINING_DECK_TEMPLATE_ID` is set.
   HALT if missing with a clear error.

6. **Copy template.** Call `slides_copy_template` with:
   - `templatePresentationId`: `ACE_TRAINING_DECK_TEMPLATE_ID`
   - `title`: `"<opp-name> — Training Deck"`
   - `parentFolderId`: the run's `6-qa-and-training/` folder ID

7. **Discover stencil objectIds.** Call `slides_get` on the copied
   deck. Verify all 14 stencils are present (match against the
   `STENCILS` constant). HALT if any missing.

7b. **Scan the copied stencils for placeholder drift. HALT on any**
    (dimagi-internal/ace#2429).

    ```bash
    ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
    node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/check-stencil-token-drift.ts" \
      --deck <copied presentationId>
    ```

    Exit 0 = no drift. Exit 1 = drift, and the deck must not be
    rendered from this template until it is reconciled.

    **This is the check step 9's `unmatchedReplacements` cannot make,
    and the reason is worth knowing.** The template and
    `STENCIL_PLACEHOLDERS` are two halves of one contract kept in
    different places, and they drift in BOTH directions:

    - a token the builder replaces that the stencil lacks — silently
      **dropped**. `unmatchedReplacements` catches this (ace#2126).
    - a token the stencil carries that the builder no longer replaces
      — nothing targets it, so it survives onto the slide and the
      reader sees a literal `{{TOKEN}}`. `unmatchedReplacements` is
      **structurally blind** to this: it only reports tokens the
      builder *tried* to replace.

    The second is ace#2429. The duration badge left the exercise
    layout's contract on 2026-09-09; the live template, minted
    2026-09-07, kept it. `poverty-graduation/20260915-1518` rendered
    281 requests, 281 replies, **0 unmatched** — and shipped a partner
    a literal `{{DURATION}}` on all 13 of its exercise slides. The
    generate-side `/\{\{[A-Z_]+\}\}/` sweep passes too, because it
    scans the SPEC and the token lives in the TEMPLATE. This step is
    the one place both halves are in hand.

    **If it reports drift, repair the TEMPLATE, not the deck.** One
    `replaceAllText` over the rendered deck fixes that artifact and
    leaves the next render to reproduce it — that is exactly what
    happened on the run that filed #2429. The repair is in place, so
    the presentationId does not change and
    `ACE_TRAINING_DECK_TEMPLATE_ID` needs no rotation:

    ```bash
    node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/check-stencil-token-drift.ts" \
      --repair
    ```

    (No `--template` argument: it defaults to
    `ACE_TRAINING_DECK_TEMPLATE_ID` read from `<plugin-data>/.env` by
    the script itself. Do **not** interpolate that variable in the
    shell — ACE's env is loaded into MCP subprocesses, not the calling
    shell, so `$ACE_TRAINING_DECK_TEMPLATE_ID` expands to EMPTY in a
    Bash tool call and would send an empty id. ace#1147.)

    It deletes every text-bearing shape on each drifted stencil page
    and re-layers that stencil's boxes from
    `lib/training-deck-stencil-geometry.ts` — the same thing the
    bootstrap's step 4 does per page — then re-reads the template and
    proves the drift is gone. Chrome (accent bar, right rule, corner
    mark) is not text-bearing and is untouched, and the notes page is
    not scanned or rewritten, so `{{NOTES}}` survives.

    Note that **re-running `bootstrap-training-deck-template.ts` is a
    no-op here**, despite being the obvious move: it dedupes on
    `TEMPLATE_NAME` in the ACE root folder, so it finds the drifted
    template and returns `Template already exists`. Forcing a real
    re-mint means a new presentationId, which means a 1Password
    rotation plus `/ace:setup --force-env` plus a full Claude restart
    (every MCP server reads `.env` at module load). Repair in place
    unless the stencil GEOMETRY changed, not just its tokens.

    The comparison logic is `lib/stencil-token-drift.ts`
    (`scanStencilTokenDrift`), unit-tested in
    `test/lib/stencil-token-drift.test.ts` against both drift
    directions plus the live template's real pre- and post-repair
    content. The script is only the Slides round-trip around it.

8. **Build requests.** Call
   `buildSlidesRequestsV2(spec, { stencils, manifest })`.

9. **Execute.** Call `slides_batch_update` — single call with all
   requests.

   **Read `unmatchedReplacements` on the result — it is not decoration
   (ace#2126).** The deck's text does not arrive through
   `slides_copy_template`; step 6 copies the template BARE and every
   token is substituted here, by the `replaceAllText` requests
   `buildSlidesRequestsV2` emits. A token no stencil carries is
   replaced zero times, the API returns 200, and **no `{{token}}`
   survives in the rendered deck for any check to find** — so the
   slide ships without the content and every checkpoint reads green.
   That is the same silent-drop that put a contractual Work Order in
   front of a partner using "the partner" ~30 times with no antecedent
   while its QA returned 14/14 pass.

   A non-empty `unmatchedReplacements` (plus a `warning`) means those
   values were **silently dropped from the rendered deck**. It is a
   report, not a rollback — the deck exists and looks fine. Treat any
   entry as a **halt**, naming the unmatched tokens.

   **Do not work around it by folding the value into a neighbouring
   token.** That renders correctly once and teaches the next run
   nothing. A dropped token means the live template gdoc no longer
   carries the placeholder the builder targets, and the fix is to
   reconcile the template — step 7b's `--repair`, which rebuilds the
   drifted stencil pages in place and keeps the presentationId. (Step
   7b should have caught it first; an entry reaching HERE and not
   there means the token is on the notes page, which 7b does not
   scan.) `{{NOTES}}` is the likeliest such hit: the bootstrap injects
   it into each stencil's notes page, so an unmatched `{{NOTES}}` means
   the live template predates that step, and THAT one does need
   `scripts/bootstrap-training-deck-template.ts` (after trashing or
   renaming the existing template — it dedupes on `TEMPLATE_NAME`).

10. **Write deck handoff** to `run_state.yaml`:

    ```yaml
    phases:
      qa-and-training:
        products:
          training:
            deck:
              file_id: <presentationId>
              title: "<opp-name> — Training Deck"
              web_view_link: <url>
              slide_count: <N>
              rendered_at: <ISO timestamp>
    ```

    Multi-writer block (sibling slots are the five training doc
    skills' `docs.<key>` entries) — apply via read-modify-write
    following the canonical pattern in
    `skills/synthetic-data-generate/SKILL.md § Step 6` so sibling
    sub-keys are preserved. See `agents/qa-and-training.md § Products`
    for the full slot table.

11. **Print deck URL** for operator.

## Pre-flight checks

Before rendering:
- All Drive fileIds in manifest must be shared `anyone-with-link`. Use
  `drive_set_anyone_with_link` on each. (Slides image import won't
  work without this.)
- Template must exist and be accessible by the SA.

## Self-eval

Four criteria:

1. **Slide count**: Rendered deck slide count matches total slides in
   spec. FAIL if mismatch.
2. **Image resolution**: All images in the spec resolved successfully
   (no `createImage` errors). FAIL if any failed.
3. **API success**: `slides_batch_update` completed without error.
   FAIL if error.
4. **Visual coverage** (dimagi-internal/ace#856): re-read
   `visual_coverage` from the generate verdict, or recompute it via
   `computeVisualCoverage` (`lib/training-deck-spec.ts`). Record the ratio in
   this verdict. FAIL if `ratio < 0.5` with zero per-opp captures.

**Criteria 2 and 4 are not the same check, and conflating them is what let
this skill score 9.5 on a hollow deck.** Criterion 2 asks "did every image the
spec referenced resolve?" — which is *vacuously satisfied* when the spec
referenced almost no images, because generate had already downgraded the
unbacked slides to `content` layout. On
hh-poverty-targeting/20260702-1456 the 4 pool images resolved cleanly, so
criterion 2 passed, while 39 of 43 slides carried no substantive image.

**Never record "visually spot-checked" as evidence for a passing score
unless the sample was stratified.** That verdict's spot-check looked at the
cover plus the 4 image-bearing slides and never sampled the 39 empty ones —
it sampled exactly the population that could not fail. If you sample, sample
by stencil type and mandatorily include slides that *should* carry
screenshots.

Verdict to
`ACE/<opp>/runs/<run-id>/6-qa-and-training/training-deck-render_verdict.yaml`
in the standard shape (see `lib/verdict-schema.ts`).

### Post-render sweep: leftover decorative ellipse (pre-v6.1 templates)

A template minted before v6.1 carries a 6×6pt decorative ELLIPSE on the
`walkthrough` stencil (and `mobile_zoom` — same Dimagi source page),
cloned from the source slide and missed by the bootstrap strips. Fresh
renders from such a template inherit it as a stray blue dot on every
walkthrough-derived slide. If `ACE_TRAINING_DECK_TEMPLATE_ID` still
points at one, then after rendering: `slides_get` the deck, filter
pageElements with `isDecorativeLeftover`
(`lib/training-deck-stencil-geometry.ts` — ELLIPSE rendered ≤ 12pt in
both dimensions), and issue one `slides_batch_update` of `deleteObject`
requests for the matches. The in-place re-render script (below) runs
this sweep automatically when it rebuilds stencils, so re-rendered decks
self-clean.

**v6.1 mints clean.** The bootstrap now sweeps leftovers as a SECOND
pass over the elements that survive the strip
(`decorativeLeftoverIds`). Shown the raw element list it did not: the
predicate spares an ellipse whose slide also holds a LINE, and the only
LINE on the walkthrough page is a callout leader for a mockup the same
pass deletes — a doomed element vouching for the dot. The v6.0 mint
shipped `mobile_zoom` with the dot for exactly that reason.

## Output

- Google Slides deck in the run's `6-qa-and-training/` folder
- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-deck-render_verdict.yaml`
  per standard verdict shape
- Handoff written to `run_state.yaml`

## Same-link re-render

**Share the rendered deck anyone-with-link.** The pre-flight share above is
for the IMAGES the Slides importer fetches — it does not share the deck. The
deck is what the partner actually opens from the run summary, so share it too,
once, right after `slides_copy_template` returns:

```
drive_set_anyone_with_link(fileId: <presentationId>, role: 'commenter')
```

`commenter` so a reviewer can leave feedback on a slide. (ace#902 — on
hh-poverty-targeting/20260722-1341 the deck shipped private alongside the five
guides and every link check read green.)

For a deck that has already been shared at a stable URL and needs
regeneration (e.g. new screenshots after a capture unblock), do NOT
copy the template again — that mints a new presentationId and breaks
the shared link. Use the in-place re-render script instead
(dimagi-internal/ace#864):

```bash
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/rerender-training-deck-in-place.ts" \
  --deck <presentationId> \
  --spec <new-spec.yaml> \
  --old-spec <spec.yaml that produced the CURRENT slides> \
  [--key <gws-sa-key.json>]
```

- `--old-spec` is required: it must be the spec that rendered the
  deck's CURRENT slides — stored in the run's `6-qa-and-training/`
  folder as the deck-spec doc. The script derives each live slide's
  layout from it and HALTS if the live slide count differs (the deck
  was hand-edited; reconcile first).
- Safety property: the old slides are deleted ONLY after the new
  render batch succeeds — a failed render leaves the shared deck
  intact.
- Stencil text-box geometry comes from
  `lib/training-deck-stencil-geometry.ts` (single source, shared with
  the bootstrap script), so re-rendered stencils match the template.

## Error handling

- If `ACE_TRAINING_DECK_TEMPLATE_ID` not set: emit verdict `skipped`
  with reason. Don't FAIL.
- If spec validation fails: emit verdict `failed` with Zod error
  details.
- If `slides_batch_update` fails: emit verdict `failed` with API
  error.

## MCP Tools Used

- `scripts/check-stencil-token-drift.ts` (step 7b gate; `--repair` for the
  operator-side template reconcile)
- `ace-gdrive`:
  - `drive_read_file` (read the spec YAML)
  - `drive_set_anyone_with_link` (pre-flight image sharing)
  - `slides_copy_template` (copy the template into the opp folder)
  - `slides_get` (discover stencil objectIds)
  - `slides_batch_update` (render all slides in one call)

## Mode Behavior

- **Auto:** Run end-to-end, write the deck, update state, return URL.
- **Review:** Pause after step 8 (requests built). Show request
  count + slide count, let operator inspect before executing. Resume
  on approval.
- **Dry-run:** Steps 1-8 only, skip the copy/batchUpdate calls. Write
  a verdict with `dry_run: true` and a count of slides that would be
  created.

## Products

- The Google Slides deck itself (in Drive)
- `run_state.yaml.phases.qa-and-training.products.training.deck` —
  `{file_id, title, web_view_link, slide_count, rendered_at}` typed
  handoff (multi-writer block; sibling `docs.*` slots written by the
  five training doc skills)
- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-deck-render_verdict.yaml`
  — standard verdict shape (see `lib/verdict-schema.ts`); `passed:`
  true if parse + batchUpdate succeeded

## Change Log

- v2: Step 7b — post-copy stencil placeholder-drift scan, blocking.
  Catches builder/template drift in both directions at the one point
  where both halves are in hand (dimagi-internal/ace#2429). Logic in
  `lib/stencil-token-drift.ts`; `--repair` reconciles the template in
  place, so no template id changes and no `.env` rotation.
- v1: Initial skill. Replaces `training-deck-build`. Reads
  `training-deck-spec.yaml` (from `training-deck-generate`) instead
  of `training-deck-outline.md`. Single-pass render via
  `buildSlidesRequestsV2` against 14-stencil template. No speaker
  notes pass.
