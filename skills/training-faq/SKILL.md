---
name: training-faq
description: >
  Generate `faq.md` — anticipated questions from LLOs and FLWs with
  authoritative answers. Seeded from `test-prompts.md` and `qa-plan`'s
  edge cases. Owns one artifact only. Fifth of the per-artifact
  training skills.
---

# Training FAQ

Produce the FAQ document — Q&A pairs anticipating the questions LLOs
and FLWs will ask once they're using the system. Audience: someone
who's mid-task and stuck, scanning for their question.

## When to run

Phase 5 (`qa-and-training`), after `qa-plan` (so we have the
test-matrix edge cases) and `pdd-to-test-prompts` from Phase 1 (so we
have the OCS test prompts to seed FLW-asked questions).

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/pdd.md` | escalation triggers, evidence model rules, opp framing |
| Phase 1 | `ACE/<opp>/test-prompts.md` | seed Q's that the OCS bot was tested on (high-confidence "FLWs will ask this") |
| Phase 2 | `ACE/<opp>/app-summaries/learn-app-summary.md` | content-clarification questions |
| Phase 2 | `ACE/<opp>/app-summaries/deliver-app-summary.md` | per-form field-clarification questions |
| Phase 3 (`run_state.yaml`) | `connect.payment_units` + `connect.verification_flags` | "why was my submission flagged?" answers |
| Phase 4 | `ACE/<opp>/ocs-setup/widget-handoff.md` (`widget_url`) | "how do I ask?" answer |
| Phase 5 Step 1 (`qa-plan`) | `ACE/<opp>/qa-plan/test-matrix.md` (edge cases section) | seed Q's about boundary conditions |

## Output

Single file: `ACE/<opp>/training-materials/faq.md`.

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

3. **Add edge-case Q's from qa-plan/test-matrix.md.** For each
   "boundary value" or "edge case" row in the matrix, generate a
   question framed as the failure mode the FLW would encounter
   (e.g., test row "GPS fence at 51m" → FAQ Q "Why did my submission
   fail when I was just outside the market?").

4. **Add LLO-operations Q's from PDD § Escalation + run_state.yaml verification flags.**

5. **Categorize into 4 sections.** Vendor/Subject Interaction, App/
   Device, Payment & Verification, Logistics. (For `focus-group`
   archetype, replace "Vendor/Subject Interaction" with "Participant
   Interaction.")

6. **Draft answers** that are 2-4 sentences each. Authoritative tone.

7. **Self-check before write.** Verify:
   - 20-30 Q&A pairs total
   - Every Q has `[LLO]` or `[FLW]` tag
   - Every payment / verification number quoted matches `run_state.yaml`
   - At least 4 Q's seeded from `test-prompts.md`
   - At least 2 Q's seeded from `qa-plan/test-matrix.md` edge cases

8. **Write** to `ACE/<opp>/training-materials/faq.md` via
   `drive_create_file`.

9. **Self-evaluate (LLM-as-Judge).** Four criteria:
   - **Coverage:** every PDD escalation trigger + every Layer-A
     verification rule has at least one FAQ entry
   - **Tag fidelity:** every Q has `[LLO]` or `[FLW]`
   - **Answer authority:** answers cite real config / real numbers,
     not generic guidance
   - **Audience split:** at least 30% LLO Q's and at least 30% FLW
     Q's (otherwise the doc is over-skewed)

   Verdict to `ACE/<opp>/verdicts/training-faq.yaml`.

10. **Hand off.** Print Drive URL + verdict summary.

## MCP Tools Used

- `ace-gdrive`: `drive_read_file`, `drive_create_file`,
  `drive_list_folder`

## Mode Behavior

- **Auto:** Run end-to-end.
- **Review:** Pause after step 7, show drafted FAQ.
- **Dry-run:** Steps 1-7, skip write. Verdict with `dry_run: true`.

## Outputs

- `ACE/<opp>/training-materials/faq.md`
- `ACE/<opp>/verdicts/training-faq.yaml`

## Why a separate skill

Independent rerun is especially valuable for the FAQ — once an opp is
live, real FLW questions surface that weren't anticipated. Re-running
just this skill (with new seed Q's appended manually or via a future
"observed Q's" log) regenerates the FAQ without re-emitting the LLO
guide.

Fifth of the per-artifact training skills.

## Change Log

- v1 (0.10.84): Initial skill. Owns `faq.md` only.
