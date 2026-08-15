---
name: run-surface-audit-eval
description: >
  Judge the EXTERNAL REVIEW SURFACE of a run as an outsider reads it — would a
  partner with no ACE context understand what they are looking at and what they
  are being asked to do? Grades orientation, insider jargon, claim accuracy
  against what the run actually produced, internal consistency, and whether the
  ask is actually actionable on the page in front of them. Gated by
  run-surface-audit; runs before a run-summary URL is shared with anyone
  external.
---

# Run-surface audit — eval

Grades the *quality* of what an external partner receives, given
`run-surface-audit` has confirmed the surface is structurally sound. An
independent grader exists because the two halves fail in genuinely different
ways: determinism can prove every link opens and every artifact is present, and
the page can still be incomprehensible, overclaiming, or give the reader nothing
they can act on. On 2026-08-14 the worst defects on
`spark-facilitator/20260813-2126` were *misleading*, not broken — and the
comprehension defects underneath them (a decisions log written in phase numbers
and skill names, for a reader who has met neither) were never checked at all.

Consumer: whoever is about to send the link, and `opp-eval`.

## Process

1. **Read the QA verdict first.** If `run-surface-audit` reported any `broken`
   or `misleading` finding, **stop** and write `verdict: incomplete` with
   `capture_path` naming the QA output. Grading the prose of a page whose links
   are private or whose sections contradict the payload wastes the judgement and
   produces a score nobody should trust.
2. **Read the surface AS AN OUTSIDER.** Fetch the anonymous payload
   (`.../api/opps/public/<ws>/<slug>/runs/<run>/summary?force=1`) and the
   rendered text of both tabs (the `--render --json` output of
   `scripts/audit-run-surface.ts` carries the rendered hrefs; open the page
   yourself for the prose). Read it once, straight through, as someone who has
   never heard of ACE, phases, Nova, or Connect internals.
3. **Read the run's own record of what happened** — `run_state.yaml`, including
   every `phases.<phase>.steps.<step>.verdict`. This is the anchor for
   `claim_accuracy`: the page must not present as finished what the run itself
   recorded as failed.
4. Apply the rubric below.
5. Write the verdict YAML to
   `<run>/8-solicitation-management/run-surface-audit-eval_verdict.yaml` — or,
   when the run is being shared at a different stage, alongside the artifacts of
   the phase the run is paused at. Shape per `lib/verdict-schema.ts`; see
   `skills/_eval-template.md § Verdict YAML contract`.
6. Surface auto-concerns per `skills/_eval-template.md § Auto-surfaced severity rules`.

## LLM-as-Judge Rubric

Score 0–10 per dimension. **Start every dimension at 5 and move from evidence**,
not from an impression of overall effort — the page is polished, and polish is
not comprehension.

### `outsider_orientation` — weight 0.20

Can a reader who has never heard of ACE tell, within the first screen: what this
is, who built it, what was actually built, and why they were sent the link?

- **9–10** — the opening states the intervention in the partner's own domain
  terms, says plainly that an AI system drafted it, and says what the reader is
  expected to do. No prior context required.
- **6–8** — the subject is clear; the reader's role is implied rather than
  stated, or the AI provenance is buried.
- **3–5** — the reader can work out the subject from the title but the page
  reads as an internal build record they are overhearing.
- **0–2** — the page opens on machine identity (run ids, phase names, section
  headings that name ACE's own pipeline) with no orientation at all.

### `jargon_and_insider_language` — weight 0.15

Count the terms a Spark or Sophie-equivalent reader has genuinely never met, and
weigh each by how load-bearing it is.

Standing offenders — every one of these has shipped on this surface: **phase
numbers as identity** ("Phase 6"), **skill names** (`pdd-to-deliver-app`,
`app-screenshot-capture`), **form/field internals** (`vmf_visit`,
`deliver_unit`, `meeting_conducted=Yes`), **ACE role acronyms** (`LLO`, `FLW`)
used before they are defined, **`PDD`** used as if it were a common noun, and
**run ids** presented as the run's name.

- **9–10** — every domain term is either universal or defined in place on first
  use. Internal names appear only where the reader needs them to file a bug.
- **6–8** — one or two undefined internal terms, none of which block
  comprehension of an ask.
- **3–5** — several, including at least one inside a question the reader is
  being asked to answer.
- **0–2** — the reader cannot answer what is being asked without a glossary they
  do not have.

**Hard deduction:** any term the reader must understand to *act* — inside an
open question, a decision they are invited to change, or the reply ask — that is
undefined on the page caps this dimension at 4.

### `claim_accuracy` — weight 0.25

Does any section overstate or understate what the run produced? Anchor to
`run_state.yaml`, not to the page's own confidence.

- **9–10** — every claim matches the run's record, and anything the run failed
  or withheld is either absent with a stated reason or shown with its real
  status.
- **6–8** — accurate, but a partial result is presented without its caveat.
- **3–5** — a section reads as complete where the run recorded a failure or a
  withheld artifact.
- **0–2** — the page asserts an outcome the run did not achieve.

**Hard deduction → `fail`:** a claim on the page contradicted by a
`verdict: fail` in `run_state.yaml` for the step that produced it. On
`spark-facilitator/20260813-2126` the Deliver leg of Phase 6 recorded
`verdict: fail` (Connect recorded `delivered: 0`); a training surface that
presents the delivery flow as proven end-to-end is making a claim the run's own
record contradicts.

**Also deduct for understatement.** A withheld walkthrough shown as
"Not shown — did not pass quality review" is *honest*; the same walkthrough shown
as "Not created" is not.

### `internal_consistency` — weight 0.10

Does any claim on the page contradict another claim on the page? Dates, counts,
payment figures, the number of workers, what is in scope. Both tabs count as one
document, and so do the linked deliverables the page presents as its own output.

- **9–10** — no contradictions; figures that appear twice agree.
- **5–8** — a cosmetic disagreement (a date formatted two ways, a rounded count).
- **0–4** — two load-bearing numbers disagree, or the summary and a linked
  deliverable state different scope.

### `ask_actionability` — weight 0.30 — **out-of-chain fitness dimension**

The anchor here is deliberately outside the AI authoring chain: not "does the
page match the PDD" but **could a real external partner, opening this cold and
alone, actually do the thing we need them to do?**

Judge against what the page *affords*, using the QA run's rendered evidence
(which controls exist, whether a change commits, whether the write paths answer)
plus your own read of the copy:

- Is there a specific, singular ask, or is the reader left to infer one?
- For each open question: is it answerable by *this* reader — or does it need
  information only Dimagi holds?
- Can they respond without an account, an email thread, or a meeting?
- If they disagree with a decision, is it clear that changing it does something,
  and what?
- Would they know who sees their response, and when they would hear back?

Anchors:

- **9–10** — a competent stranger could act within two minutes: the ask is
  named, the mechanism is on the page, and the consequence of responding is
  stated.
- **6–8** — they could act, but must infer either what to prioritise or what
  happens next.
- **3–5** — the surface is readable but essentially a broadcast; responding
  requires initiative the page does not invite.
- **0–2** — there is no ask, or the ask cannot be performed on this page.

**Teeth (required by `skills/_eval-template.md § out-of-chain fitness`):**
`ask_actionability ≤ 3` sets `verdict: fail` on its own, regardless of the
weighted mean. A surface an outsider cannot act on has failed at the only job it
has, however well written it is.

### Inflation guard

This surface is *designed to look finished* — that is what a summary page is
for. Two guards:

1. **No dimension above 8 without a quoted line from the page as evidence.** If
   the verdict cannot cite the sentence that earns the score, cap at 8.
2. **Cap `overall_score` at 7.5 when `jargon_and_insider_language ≤ 5`.** A page
   the reader cannot parse cannot be a good review surface no matter how
   complete it is, and the weighted mean will otherwise hide it behind four
   strong structural dimensions.

Record `overall_score_pre_cap` whenever a cap binds.

## Archetypes

| Archetype | Branch |
|---|---|
| `atomic-visit` | Default. The reader is judging one repeated paid unit; `claim_accuracy` should weigh whether the verification predicate is stated in the partner's own field terms rather than as a form expression. |
| `focus-group` | The primary deliverable is qualitative (a gdoc), not app screenshots. `ask_actionability` should check the page points at the discussion output, not at a Deliver app the reader will not recognise; `claim_accuracy` must not treat an absent Phase 7 as a gap. |
| `multi-stage` | Several delivery stages exist and an outsider will conflate them. `internal_consistency` weighs whether stage names are used identically across the summary, the decisions log, and the linked deliverables. |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used`. Additionally
`resolve_opp_path` + `drive_read_file` for `run_state.yaml` (the
`claim_accuracy` anchor), and the `--json` output of
`scripts/audit-run-surface.ts` for the rendered evidence
`ask_actionability` reads.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior`. `--quick` grades
`outsider_orientation` and `ask_actionability` only (the two that decide whether
to send it at all); `--deep` grades all five.

## Dry-Run Behavior

Reads only. Writes the verdict YAML to Drive and nothing else — it never
changes sharing, never edits a deliverable, and never sends. Under `--dry-run`
it prints the verdict instead of writing it.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-08-15 | Created alongside `run-surface-audit`, from the twelve defects found by hand on `spark-facilitator/20260813-2126`. | ACE |
