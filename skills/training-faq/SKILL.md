---
name: training-faq
description: >
  Generate anticipated LLO + FLW questions with authoritative answers.
  Owns one artifact: training-faq.md.
disable-model-invocation: true
---

# Training FAQ

Produce the FAQ document — Q&A pairs anticipating the questions LLOs
and FLWs will ask once they're using the system. Audience: someone
who's mid-task and stuck, scanning for their question.

## When to run

Phase 6 (`qa-and-training`). Reads upstream Phase 1 artifacts —
`pdd-to-app-journeys`'s `pdd-to-app-journeys.md` for journey edge cases
and `pdd-to-test-prompts`'s `test-prompts.md` for OCS-side seed
questions.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/runs/<run-id>/1-design/idea-to-pdd.md` | escalation triggers, evidence model rules, opp framing |
| Phase 1 | `ACE/<opp>/runs/<run-id>/2-scenarios/pdd-to-test-prompts.md` | seed Q's that the OCS bot was tested on (high-confidence "FLWs will ask this") |
| Phase 3 | `ACE/<opp>/runs/<run-id>/3-commcare/pdd-to-learn-app_summary.md` | content-clarification questions |
| Phase 3 | `ACE/<opp>/runs/<run-id>/3-commcare/pdd-to-deliver-app_summary.md` | per-form field-clarification questions |
| Phase 4 (`run_state.yaml`) | `connect.payment_units` + `connect.verification_flags` | "why was my submission flagged?" answers |
| Phase 5 | `ACE/<opp>/runs/<run-id>/5-ocs/ocs-setup_widget-handoff.md` (`widget_url`) | "how do I ask?" answer |
| Phase 1 | `ACE/<opp>/runs/<run-id>/2-scenarios/pdd-to-app-journeys.md` (edge cases per journey) | seed Q's about boundary conditions |

## Output

Single file: `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-faq.md`.

## Format

Markdown grouped into 4 categories. Each Q is in **bold**, answer
follows in plain text. Audience: split between LLO operations
questions and FLW field questions; mark each with a `[LLO]` or
`[FLW]` tag in the question line so a reader scanning the doc can
filter mentally.

```markdown
# FAQ — <Opportunity Name>

Common questions from LLOs and FLWs.

## <Vendor / Subject> interaction

**[FLW] Q: <question 1>**
<answer — 2-4 sentences, authoritative, action-oriented>

**[FLW] Q: <question 2>**
<answer>

## App / Device

**[FLW] Q: The app crashed mid-form. Did I lose my data?**
<answer pulled from CommCare's actual draft-save behavior + PDD's
escalation guidance>

## Payment & Verification

**[LLO] Q: Why was FLW Asha's submission flagged?**
<answer pulled from `connect.verification_flags` rules — explain
which rule triggered, what to do>

**[LLO] Q: When does payment hit the FLW account?**
<answer from connect Programs payment cadence>

## Logistics

**[LLO] Q: <opp-specific operational question>**
<answer>
```

## Format rules

- **20-30 Q&A pairs total.** Fewer is too thin; more becomes
  hard-to-scan.
- **Bold the question, plain the answer.** Markdown `**Q:**` makes
  scanning fast.
- **Tag each Q with `[LLO]` or `[FLW]`** at the start. Lets readers
  jump to their role's questions.
- **Authoritative, not hedging.** "Yes, you can resubmit." not "You
  may possibly be able to resubmit if conditions allow."
- **Reference real config when it matters.** "The GPS fence is 50m"
  not "the GPS fence is small" — the LLO needs the actual number
  from `connect.verification_flags`.

## Process

1. **Read inputs.** Drive paths in the table above.

2. **Seed Q list from test-prompts.md.** Every prompt that has
   `expected_answer_summary` becomes a candidate FAQ entry; pick the
   ones an FLW or LLO would actually ask outside the OCS chat
   context (most will).

3. **Add edge-case Q's from pdd-to-app-journeys.md.** For each
   journey's `edge_cases` block (UX-outcome phrasing), generate a
   question framed as the failure mode the FLW would encounter
   (e.g., edge case "FLW understands why a submission outside the
   GPS fence was rejected" → FAQ Q "Why did my submission fail when
   I was just outside the market?").

4. **Add LLO-operations Q's from PDD § Escalation + run_state.yaml verification flags.**

5. **Categorize into 4 sections, archetype-aware.**

   For `atomic-visit` / `multi-stage` (default): Vendor/Subject
   Interaction, App/Device, Payment & Verification, Logistics.

   For `focus-group`: swap the category set to match the FGD operational
   model (out-of-band gdoc + minimal in-app attestation):
   - **Facilitation & Consent** (replaces "Vendor/Subject Interaction") —
     how to handle one-voice domination, leading questions, audio
     consent decline, the verbatim consent script.
   - **Attestation Form & Layer A** (replaces "App/Device") — the
     5-field form, GPS-out-of-radius cases, the 24h submission window,
     "what counts as a valid photo" (attendance sheet, no faces).
   - **Gdoc Writing & Layer B** (new for focus-group) — what to put in
     each section, what makes a "good theme" vs "weak theme", verbatim
     quote rules, when coordinator review flags content.
   - **Payment & Logistics** (merges "Payment & Verification" +
     "Logistics") — per-session rate, training stipend on
     practice-session-pass, venue acceptable list, refreshments.

6. **Draft answers** that are 2-4 sentences each. Authoritative tone.

7. **Self-check before write.** Verify:
   - 20-30 Q&A pairs total
   - Every Q has `[LLO]` or `[FLW]` tag
   - Every payment / verification number quoted matches `run_state.yaml`
   - At least 4 Q's seeded from `test-prompts.md`
   - At least 2 Q's seeded from `pdd-to-app-journeys.md` edge cases

8. **Write** to `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-faq.md` via
   `drive_create_file`.

9. **Self-evaluate (LLM-as-Judge).** Four criteria:
   - **Coverage:** every PDD escalation trigger + every Layer-A
     verification rule has at least one FAQ entry
   - **Tag fidelity:** every Q has `[LLO]` or `[FLW]`
   - **Answer authority:** answers cite real config / real numbers,
     not generic guidance
   - **Audience split:** at least 30% LLO Q's and at least 30% FLW
     Q's (otherwise the doc is over-skewed)

   Verdict to `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-faq_verdict.yaml`.

10. **Hand off.** Print Drive URL + verdict summary.

## MCP Tools Used

- `ace-gdrive`: `drive_read_file`, `drive_create_file`,
  `drive_list_folder`

## Mode Behavior

- **Auto:** Run end-to-end.
- **Review:** Pause after step 7, show drafted FAQ.
- **Dry-run:** Steps 1-7, skip write. Verdict with `dry_run: true`.

## Products

- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-faq.md`
- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-faq_verdict.yaml`
- `run_state.yaml.phases.qa-and-training.products.training.docs.faq` — `{file_id, title: "FAQ", web_view_link}` typed handoff. Multi-writer block: apply via read-modify-write per `skills/synthetic-data-generate/SKILL.md § Step 6`. See `agents/qa-and-training.md § Products` for the full slot table.

## Why a separate skill

Independent rerun is especially valuable for the FAQ — once an opp is
live, real FLW questions surface that weren't anticipated. Re-running
just this skill (with new seed Q's appended manually or via a future
"observed Q's" log) regenerates the FAQ without re-emitting the LLO
guide.

Fifth of the per-artifact training skills.

## Change Log

- v1 (0.10.84): Initial skill. Owns `training-faq.md` only.
- 2026-05-15: Replace the one-line "Participant Interaction" focus-group note in Step 5 with a full archetype-branched 4-category set: Facilitation & Consent / Attestation Form & Layer A / Gdoc Writing & Layer B / Payment & Logistics. Atomic-visit / multi-stage keep the default Vendor-Subject-Interaction / App-Device / Payment-Verification / Logistics categories. Prompted by `malaria-itn-fgd/20260514-2352` Phase 6 observation.
