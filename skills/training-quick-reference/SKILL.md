---
name: training-quick-reference
description: >
  Generate `quick-reference.md` — the one-page laminated-pocket-card
  summary for FLWs in the field. Owns one artifact only. Fourth of the
  per-artifact training skills.
---

# Training Quick Reference

Produce the FLW pocket card — single page, scannable, every word
earns its place. Audience: an FLW mid-visit, glancing at a printed
sheet for the right next step or a number they need to remember.

## When to run

Phase 5 (`qa-and-training`), after `app-screenshot-capture`. Independent
of other training skills.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/runs/<run-id>/1-design/idea-to-pdd.md` | per-visit step list, daily caps, key safety rules |
| Phase 2 | `ACE/<opp>/runs/<run-id>/2-commcare/pdd-to-deliver-app_summary.md` | exact required-field list (so the ref says what the form actually asks) |
| Phase 3 (`run_state.yaml`) | `connect.opportunity` + `connect.payment_units` | max-per-day numbers |
| Phase 4 | `ACE/<opp>/runs/<run-id>/4-ocs/ocs-setup_widget-handoff.md` (`widget_url`) | OCS widget URL printed at the bottom |

## Output

Single file: `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-quick-reference.md`.

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
Open the chat widget: <widget_url>
LLO contact: <name from connect-setup/opportunity.md>
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
   stage markers.

4. **Draft the card.** Stay under 250 words. Use imperative voice
   throughout.

5. **Self-check before write.** Verify:
   - Total word count ≤ 280 (small overage tolerance for the
     section headers)
   - Every PDD-declared per-visit step is in the "Every delivery"
     list
   - Every "Layer-A signal" maps to an Evidence-Model rule in PDD
   - Every escalation trigger from PDD § Escalation is referenced
   - The widget URL renders as a real URL, not a placeholder

6. **Write** to `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-quick-reference.md`
   via `drive_create_file`.

7. **Self-evaluate (LLM-as-Judge).** Four criteria:
   - **Word budget:** ≤ 280 words
   - **Hard-number fidelity:** caps + payment numbers match
     `run_state.yaml`
   - **Imperative voice:** all delivery-step lines start with a verb
   - **Coverage:** every per-visit step + every escalation trigger
     present

   Verdict to `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-quick-reference_verdict.yaml`.

8. **Hand off.** Print Drive URL + verdict summary.

## MCP Tools Used

- `ace-gdrive`: `drive_read_file`, `drive_create_file`

## Mode Behavior

- **Auto:** Run end-to-end.
- **Review:** Pause after step 5, show drafted card.
- **Dry-run:** Steps 1-5, skip write. Verdict with `dry_run: true`.

## Outputs

- `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-quick-reference.md`
- `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-quick-reference_verdict.yaml`

## Known limitations

- **Markdown-rendered PDF is the assumption.** v1 emits markdown that
  renders cleanly in Google Docs (which the LLO can print). A future
  iteration could emit `.pdf` directly via a markdown-to-PDF helper.
- **Single-language.** v1 produces the source-language card. Localized
  versions need a separate translate skill.

## Why a separate skill

Independent rerun: re-running this skill regenerates only
`quick-reference.md` — re-tightening the word budget after a PDD edit
doesn't re-emit the LLO guide or FAQ.

Fourth of the per-artifact training skills.

## Change Log

- v1 (0.10.84): Initial skill. Owns `quick-reference.md` only.
