---
name: training-quick-reference
description: >
  Generate the one-page printable pocket-card summary for FLWs in the
  field. Owns one artifact: training-quick-reference.md.
disable-model-invocation: false
---

# Training Quick Reference

Produce the FLW pocket card — single page, scannable, every word
earns its place. Audience: an FLW mid-visit, glancing at a printed
sheet for the right next step or a number they need to remember.

## When to run

Phase 6 (`qa-and-training`), after `app-screenshot-capture`. Independent
of other training skills.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/runs/<run-id>/1-design/idea-to-pdd.md` | per-visit step list, daily caps, key safety rules, support contact + GRM escalation route |
| Phase 3 | `ACE/<opp>/runs/<run-id>/3-commcare/pdd-to-deliver-app_summary.md` | exact required-field list (so the ref says what the form actually asks) |
| Phase 4 (`run_state.yaml`) | `connect.opportunity` + `connect.payment_units` | max-per-day numbers |

## Output

Single file: `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-quick-reference.md`.

## Format

A markdown document built to render to a single 8.5×11" sheet (or A4)
when printed. **Word budget: ~250 words total.** If it's longer, it
won't fit on one page; if it's a long checklist of vague guidance, it
fails the "card" test.

```markdown
# Quick Reference — <Opportunity Name>

Laminated pocket card. FLWs carry this in the field.

## Every delivery
1. <step 1, 5-8 words>
2. <step 2>
3. ...
N. **Submit**

## Limits today
- <X> deliveries per FLW
- <Y> deliveries per <unit>

## What good looks like
- <Layer-A signal 1, 5-10 words>
- <Layer-A signal 2>
- <Layer-A signal 3>

## When to stop / escalate
- <safety trigger>: leave, contact LLO
- <verification trigger>: complete partial, flag in notes

## Need help?
Call your LLO coordinator: <name from connect-setup/opportunity.md>
To raise it formally: **GRM** in the app menu
```

## Format rules

- **Word budget ~250.** If you can't say it in 250 words, it doesn't
  belong on a pocket card.
- **Numbered for delivery steps, bulleted otherwise.** Numbers imply
  sequence; bullets imply "any one applies."
- **Real numbers, not paraphrased.** The `<X>` and `<Y>` are quoted
  from `run_state.yaml`'s payment-unit max counts, not summarized.
- **Imperative voice.** "Submit." not "You should submit when ready."
- **No screenshots.** This is a printed card — graphics blow the
  budget. Save those for the `flw-training-guide`.

## Process

1. **Read inputs.** Drive paths in the table above.

2. **Read run_state.yaml for hard numbers.** `connect.payment_units` →
   max-per-day numbers; `connect.opportunity.max_visits_per_day` →
   total cap.

3. **Determine archetype.** For `atomic-visit`, "Every delivery"
   numbered list mirrors the PDD's per-visit flow. For `focus-group`,
   the section reframes as "Every session" with the session-stage
   list. For `multi-stage`, two parallel lists or a single list with
   stage markers. For `longitudinal-visits`, one list per visit type
   with the visit trigger stated up front ("First visit" / "Follow-up,
   due N days after the last") — the FLW's question is *which* visit
   this is, not just what to do. Any archetype not named here falls
   back to the `atomic-visit` shape; never leave the card unwritten
   because the archetype was unrecognised (ace#1691).

4. **Draft the card.** Stay under 250 words. Use imperative voice
   throughout.

5. **Self-check before write.** Verify:
   - Total word count ≤ 280 (small overage tolerance for the
     section headers)
   - Every PDD-declared per-visit step is in the "Every delivery"
     list
   - Every "Layer-A signal" maps to an Evidence-Model rule in PDD
   - Every escalation trigger from PDD § Escalation is referenced
   - The "Need help?" block names a real person plus the GRM menu — no
     `openchatstudio.com` host, `public_id`, or `embed_key` (see
     § Support channel below)

6. **Write** to `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-quick-reference.md`
   **as a NATIVE Google Doc via `drive_create_doc_from_markdown`** — NOT
   `drive_create_file`, which uploads the body as `text/plain` so every `##`,
   `**`, `|` and `---` stays a literal character on the page. This document is
   read by a human (a field worker who will PRINT this card), and a partner opening it should see headings,
   bold and tables, not markdown source. The renderer round-trips: a properly
   formatted doc exports back to clean markdown via
   `drive_read_file(exportAs: 'text/markdown')`, so nothing machine-readable is
   lost — whereas a `text/plain` upload exports ESCAPED (`\---`, `run\_id`).
   Same find-or-create semantics: a same-name file under the parent is
   overwritten IN PLACE, so the fileId — and any sharing already applied to it —
   survives. (dimagi-internal/ace#1338; sibling of the PDD fix, ace#1061.)

   **Then persist the source markdown — the same string, written twice.**
   Immediately after the render, write the EXACT bytes you just passed to
   `drive_create_doc_from_markdown` to
   `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-quick-reference.source.md` via
   `drive_create_file` with `mimeType: 'text/markdown'`. **NOT
   `drive_create_doc_from_markdown`** — rendering the source copy converts it
   to a Doc as well and destroys the very bytes this step exists to preserve,
   which reproduces the defect while looking like the fix.

   Why it is not optional: the renderer CONSUMES its input. Once the Doc
   exists the markdown you composed exists nowhere, and the `.md` in the
   published name is display text, not a file — `drive_list_folder` over a
   finished run returns every one of these as
   `application/vnd.google-apps.document` with no sibling markdown. That is
   what leaves `run-surface-audit`'s `DOC-FIDELITY-UNVERIFIED` — the only
   check that compares what was PUBLISHED against what was WRITTEN, and the
   only one that could have caught a guide silently losing 44 screenshots and
   224 words with every other check green (ace#1418) — permanently
   unresolvable, because its `--doc-source` remediation has nothing real to
   point at. One extra call turns a blocking gate from decorative into
   operable. (ace#1687 half 2; declared `sourcePersisted` in
   `lib/artifact-manifest.ts`, enforced by
   `test/lib/source-persisted-artifacts.test.ts`.)

7. **Self-evaluate (LLM-as-Judge).** Four criteria:
   - **Word budget:** ≤ 280 words
   - **Hard-number fidelity:** caps + payment numbers match
     `run_state.yaml`
   - **Imperative voice:** all delivery-step lines start with a verb
   - **Coverage:** every per-visit step + every escalation trigger
     present

   Verdict to `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-quick-reference_verdict.yaml`.

8. **Hand off.** Print Drive URL + verdict summary.


9. **Share it anyone-with-link.** The pocket card is a deliverable a field worker opens from
   the run summary — a private Doc opens only for accounts explicitly shared on
   it, so a recipient following the link hits *You need access*. Nothing
   upstream catches this: the doc exists, has the right words, passes every
   content eval, and returns a 401 that a link checker reasonably reads as
   "auth-gated" (the correct verdict for a Connect/HQ/OCS login gate, the wrong
   one here).

   ```
   drive_set_anyone_with_link(fileId: <docId>, role: 'commenter')
   ```

   `role: 'commenter'` rather than `reader` — a partner reviewing a training
   deliverable should be able to leave feedback on it. Do this at creation, not
   as a cleanup step: on hh-poverty-targeting/20260722-1341 all six training
   links shipped private and were shared by hand afterwards. (ace#902; enforced
   by `test/lib/recipient-facing-artifacts.test.ts`.)

## MCP Tools Used
- `ace-gdrive`: `drive_set_anyone_with_link` — share the deliverable (ace#902).

- `ace-gdrive`: `drive_read_file`, `drive_create_doc_from_markdown` (the card —
  human-facing prose, must render), `drive_upload_binary` with `mimeType:
  'text/yaml'` (the verdict YAML — machine-parsed, so it must be stored as REAL
  BYTES; `drive_create_file` makes a Google Doc, whose export turns every `\n`
  into `\r\n\r\n\r\n`, and it has no mimeType parameter — see
  `skills/_training-template.md § Machine-parsed artifacts must not be written as
  Google Docs`)

## Mode Behavior

- **Auto:** Run end-to-end.
- **Review:** Pause after step 5, show drafted card.
- **Dry-run:** Steps 1-5, skip write. Verdict with `dry_run: true`.

## Products

- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-quick-reference.md`
- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-quick-reference_verdict.yaml`
- `run_state.yaml.phases.qa-and-training.products.training.docs.quick_reference` — `{file_id, title: "Quick reference card", web_view_link}` typed handoff. Multi-writer block: apply via read-modify-write per `skills/synthetic-data-generate/SKILL.md § Step 6`. See `agents/qa-and-training.md § Products` for the full slot table.

## Known limitations

- **Markdown-rendered PDF is the assumption.** v1 emits markdown that
  renders cleanly in Google Docs (which the LLO can print). A future
  iteration could emit `.pdf` directly via a markdown-to-PDF helper.
- **Single-language.** v1 produces the source-language card. Localized
  versions need a separate translate skill.

## Why a separate skill

Independent rerun: re-running this skill regenerates only
`training-quick-reference.md` — re-tightening the word budget after a PDD edit
doesn't re-emit the LLO guide or FAQ.

Fourth of the per-artifact training skills.

## Support channel (shared contract)

Follow `skills/_training-template.md § Support channel — one contract, all six
skills` (dimagi-internal/ace#1303): this artifact is **worker-facing**, so its
support line names a HUMAN (LLO coordinator / Partner Trainer) plus the in-app
**GRM menu** — never the `openchatstudio.com` host, the chatbot `public_id`, or
the `embed_key`. Those are embed credentials, not a destination a CBF can open
(the embed path live-probes 404; Connect has no per-opp widget field, CCC-301).
Run `checkWorkerFacingSupportChannel` from `lib/support-channel-guard.ts` over
the composed markdown before writing and rewrite any finding.

## Change Log

- v1 (0.10.84): Initial skill. Owns `training-quick-reference.md` only.
