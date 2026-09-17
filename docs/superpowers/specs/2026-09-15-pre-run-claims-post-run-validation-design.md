# Pre-run claims / post-run validation

**Status:** implemented. The mechanism shipped 2026-09-15 (ace#2393); the reviewer-facing
half of § Rendering — the run-page section and the `says` / `evidence` split — shipped
2026-09-16 (ace#2420, ace-web).
**Origin:** thread `19f86579142e6ba5`, Sophie Feintuch's 2026-09-14 message on `poverty-graduation`.

## The failure this exists to kill

A counterpart clarifies or decides something between runs. The next run does not act on it.
Nothing notices.

That is the whole defect. It is silent by construction: the decision is recorded correctly,
the run completes green, every existing gate passes, and the artifact the counterpart
actually reads is unchanged in the way they asked for. There is no surface on which the
omission appears as an omission.

Jon, 2026-09-15: *"Its a specifically bad failure mode to have a user specifically try to
clarify / decide something and then not have that be addressed in the run."*

### It has already happened on this opportunity

`poverty-graduation/20260908-0510` carries a decision row `kb-payability-contradiction`
recording that three surfaces disagree about whether the consumption-support visit is paid:

- the Deliver app marks the distribution visit **paid**
- the Connect opportunity has **no payment unit** for it
- the support assistant tells workers it is **unpaid**

ACE's response was to prepend a disclosed correction header to the indexed copy in the RAG
corpus, so the bot would not promise a worker money that Connect cannot pay. That is good
triage of the symptom. Nobody reconciled the three surfaces, and no gate could have asked
them to, because "these three artifacts must agree with each other" is not a property any
existing check can express.

Sophie's 2026-09-14 message then says, in as many words: *"Please make the Deliver app, the
Connect opportunity and the support assistant agree on that."* One decision. Three
artifact-level consequences. Today, nothing in ACE will confirm that all three moved.

### ACE already names the gap and does not enforce it

`skills/feedback-ledger` states it precisely:

> *"'The value changed' and 'the work implied by the value changed' are different questions.
> A partner flipping `photo-required: no → yes` binds the input by itself; the Deliver-form
> change that follows still needs `Feedback-Ref: decision-edits/photo-required` like any
> other response. Self-routing for its own value; stampable for its consequences."*

The consequence half is carried by **a stamp a human has to remember to write** — prose
relying on compliance, which `CLAUDE.md` says outright fails under load ("invariants are
hooks, not memory"). This design converts that convention into a record with a verdict.

There is a symmetry worth recording: Sophie's July 2026 review is the origin story of
`feedback-ledger`. Her September 2026 review is surfacing the half that ledger deliberately
left out.

## What exists, and why none of it covers this

| Mechanism | Answers | Why it cannot answer this |
|---|---|---|
| `feedback-ledger` | did their input reach a store; did an edit bind | Explicitly scoped to routing + binding. `binding: applied` means a run's `decisions.yaml` recorded the value — not that any artifact changed. |
| `decision-overrides.yaml` | what the human set | An input to the next run. Says nothing about output. |
| `verify_phase_artifacts` | do the expected Drive files exist | Name-matching presence. A file can be present and identical to last run's. |
| `verify_phase_products` | is the typed handoff block well-shaped | Schema completeness of ACE's own bookkeeping. |
| `classify_phase_writeback` / `validate_run_state` | did the phase write its record correctly | Same class: ACE's record of itself. |
| `*-eval` rubrics | is the artifact good, against a calibrated rubric | Judges quality against ground truth, not *difference from the last run because a human asked*. |

Every enforced check verifies **ACE's bookkeeping completeness**. None can express *"this
artifact should differ from last run, in this specific way, because a named person said so."*

## Settled design decisions

Each was decided explicitly in the 2026-09-15 brainstorm; recorded here with its reasoning so
a later reader does not relitigate it.

### 1. ACE drafts the claims; the counterpart's own words are carried in verbatim

At turn time, when a counterpart's message is triaged, ACE converts each decision into a
falsifiable claim about the next run's output. Where the counterpart stated their own
acceptance criteria, those are carried in **verbatim** as claims ACE did not author.

Sophie already writes these unprompted: *"I want to see the memo, whether Targeting v1.1
compiles as Component 2, and whether my comments land."* That is three claims, in her words.

Claims carry `authored_by: ace | counterpart` and render distinctly, so a claim she set
cannot be quietly softened into one ACE set.

**The risk this accepts:** ACE writes its own exam and can write an easy one. The mitigation
is not a stricter author — it is §3 (frozen before results exist) plus § Rendering (every
claim renders whichever way it went), which together put the exam in front of the person who
made the decision. The reviewer is the only
check on ACE's self-marking that actually works, and it costs her nothing she is not already
doing.

### 2. Report loud; never halt

An UNMET claim does **not** stop the run. The run completes and the verdicts render on the
run page and in the reply, with UNMET as visible as MET — the completeness property that
makes `UNROUTED` work in `feedback-ledger`.

Rejected: halting at the phase boundary. Three reasons.

- What the counterpart is owed is a **diff**. A halt produces no diff.
- It repeats the hal lesson already settled in `CLAUDE.md`: a gate that stops an autonomous
  run is a gate nobody is standing at.
- It inverts the pressure on claim authorship. If an unmet claim halts the run, ACE is
  incentivised to write claims it knows it can meet — which re-introduces the easy-exam
  problem from §1 at exactly the point §1 was relying on visibility to solve.

Blocking claims are deliberately **not** in v1. Which claims genuinely need to block is a
question to answer from real runs, not to guess now.

### 3. Claims freeze when the run starts

Authored at turn time into an opp-level pending file; copied into the run folder at kickoff;
immutable thereafter. A claim cannot be added or reworded once the run is under way —
otherwise the exam gets rewritten after the results are in.

A claim authored after kickoff belongs to the *next* run.

### 4. No new judge — each claim is checked where it can be validly checked

Jon, 2026-09-15: *"we already have a ton of judging in general and this should just take that
into account based on when it can be tested in a valid way."*

Each claim declares `checkable_at: <phase>` — the first point in the pipeline where the
evidence legitimately exists — and is evaluated by the checkpoint that already runs there,
against artifacts that phase already produced.

Rejected alternatives:

- **Inject claims into the relevant `-eval` rubric as extra dimensions.** Maximum reuse, but
  the rubrics are calibrated against ground-truth catalogues and their worth depends on
  scores being comparable across runs. Splicing per-run claims in makes two runs' scores mean
  different things — spending a calibrated asset to avoid building a small one.
- **One end-of-run reconciliation pass.** Simplest, and wrong on Jon's constraint: a claim
  about the Learn walk is only validly testable while that walk is happening, and by closeout
  the device is gone. It also yields nothing when a run halts mid-pipeline — precisely when
  you most want to know which decisions landed before it stopped.

### 5. One claim per artifact that must change — never one per decision

The `kb-payability-contradiction` case is the proof. "The Deliver app, the Connect opportunity
and the support assistant agree that consumption support is unpaid" is **one decision and
three claims**. As a single claim it is unverifiable at any one checkpoint (the three
artifacts are produced in Phases 3, 4 and 5) and it fails as a lump, which tells a reader
nothing about which surface is wrong.

Granularity rule: **a claim names exactly one artifact and one checkable property of it.** A
decision with three consequences produces three claims, each with its own `checkable_at`.

## The claim record

New fact store. Opp-level while pending, copied per-run at kickoff.

- Pending: `ACE/<opp>/pending-claims.yaml`
- Frozen: `ACE/<opp>/runs/<run-id>/claims.yaml`

```yaml
schema_version: 1
kind: run-claims
opp: poverty-graduation
frozen_at: '2026-09-15T10:30:00Z'      # absent while pending
source_run_id: 20260908-0510            # the run this was authored AFTER
claims:
  - id: cs-deliver-unpaid
    # What must be true of the OUTPUT. One artifact, one property.
    claim: >-
      The Deliver app's consumption-support distribution visit carries no
      payment marker.
    artifact: deliver-app
    checkable_at: commcare-setup
    # Provenance — who asked, and where they said it.
    origin:
      kind: counterpart-decision
      person: Sophie Feintuch
      thread_id: '19f86579142e6ba5'
      message_id: '1a0a12c29f82d897'
      quote: >-
        Please make the Deliver app, the Connect opportunity and the support
        assistant agree on that.
    authored_by: ace            # ace | counterpart
    decision_ref: deployment-parameters-all-tbd   # optional
    # How it gets checked. `probe` = mechanical; `judged` = read and assessed.
    check:
      kind: probe
      how: >-
        Parse the released Deliver CCZ; assert the distribution-visit form
        carries no Connect payment marker.
```

Written back by the fence into the same file:

```yaml
    verdict: MET                 # MET | UNMET | NOT REACHED | INDETERMINATE
    evidence_kind: probed        # probed | judged  (orthogonal to verdict)
    checked_at: '2026-09-15T14:02:11Z'
    checked_in_phase: commcare-setup
    evidence: >-
      deliver CCZ b3f1c2 — form `distribution_visit` has no
      <connect:payment> element (0 matches).
    says: >-
      The Deliver app has no payment marker on consumption support — two
      payable activities, and no consumption form in it at all.
```

### `evidence` and `says` — two fields, two audiences

`evidence` is the **audit record**. It is written for whoever may later have to
re-derive this verdict, so it names file ids, revisions, the atom call that produced
the read and the reliability caveats of that read path. It is INTERNAL by
construction, and nothing below weakens it.

`says` is the **counterpart-facing sentence** — what this verdict says to the person
who asked, in their terms, with no internal identifiers.

Two fields rather than one because the audience genuinely differs and one string
cannot serve both. Measured on the first live run: the eight claims' `evidence` came
to ~3,900 words of Drive file ids, `commcare_download_ccz(domain=…, app_id=…)`
signatures, `connect_markers.deliver=2`-style internal field names and notes like
*"connect_list_payment_units is HTML-scraped and its required_deliver_units field
returns [] regardless of actual configuration"*. That is exactly what the audit
record is FOR, and exactly what `skills/agent-turn-review` § F bans from counterpart
comms (ace#2386). With one field the reply had to be hand-rewritten, and a hand
rewrite loses the completeness guarantee the renderer exists to provide — this run's
eight were all MET, so the omission risk never bit, but a run with one UNMET is
precisely where a tired rewrite drops a line (ace#2420).

`says` is OPTIONAL in the schema, so a set written before it existed still parses,
and `recordVerdict` does not refuse a verdict for want of it — a rejected write
would leave the claim unanswered, and the closeout sweep would then call it
`NOT REACHED`, which accuses falsely. Instead `classifyRunClaims` returns
`missing_says[]`: the ids of claims that HAVE a verdict and no sentence, reported at
the boundary where the phase that wrote the verdict can still add one. Report loud;
never halt, applied to the reporting mechanism itself.

### Verdict vocabulary

This is what the counterpart reads, so the words matter more than usual.

The outline approved on 2026-09-15 had four verdicts `MET / UNMET / NOT REACHED / JUDGED`.
Writing it out showed `JUDGED` was doing two unrelated jobs — describing **how** a claim was
checked and standing in for **what the answer was** — which is why it read fine in a table and
could not be implemented. A claim checked by reading rather than by probe still has a real
answer (it either happened or it did not), so `JUDGED` as a verdict would have forced every
soft claim into a non-answer. Split into two orthogonal fields:

**`verdict` — what happened.**

| verdict | meaning |
|---|---|
| `MET` | the change happened; `evidence` points at what proves it |
| `UNMET` | the checkpoint ran and the change is not there |
| `NOT REACHED` | the run never reached the checkpoint |
| `INDETERMINATE` | the checkpoint ran, the evidence was examined, and it does not settle the question |

**`evidence_kind` — how we know.** `probed` (a mechanical check) or `judged` (read and
assessed). Rendered as a qualifier, so `MET (judged)` is visibly weaker than `MET (probed)`.

Three rules carry the design's weight:

- **`NOT REACHED` accuses; it never passes.** A claim whose checkpoint never ran is a claim
  nobody answered. Rendering that as MET, or omitting it, is the exact silence this design
  exists to kill. A run reaching closeout with `NOT REACHED` claims is reporting a real gap.
- **`INDETERMINATE` must stay rare and must name what would settle it.** It is the honest
  answer when evidence is genuinely ambiguous, and it is also the comfortable place to hide a
  claim ACE would rather not fail. So it carries a required `would_settle_it` note. Compare
  `feedback-ledger`'s `stale`: a third state added because two states let a falsehood render
  as reassurance.
- **A `probe`-kind check may not silently become `judged`.** If the probe could not run, the
  verdict is `NOT REACHED` with the reason in `evidence` — never a `judged` opinion wearing a
  probe's authority. That degradation is the failure mode this vocabulary exists to prevent.

## Verification: a fifth, report-only check at the fence

`agents/ace-orchestrator.md § Phase boundary fence` already batches four checks plus
`decisions-render` into one parallel message at every transition. This adds a fifth:

```
verify_run_claims(fileId=<claims.yaml>, runFolderId=<run-folder>, phase=<phase>)
  → {phase, due[], met[], unmet[], not_reached[], judged[], summary}
```

It evaluates only claims whose `checkable_at` is this phase, writes their verdicts back, and
returns a summary. **It never gates.** Turn N+2's branch condition is unchanged — a
`verify_run_claims` result with UNMET entries does not stop the run. The orchestrator narrates
the summary line and proceeds.

At closeout, any claim still without a verdict is written `NOT REACHED`.

`opp-eval` aggregates the frozen `claims.yaml` into the run-level scorecard alongside the
per-skill verdicts it already rolls up — it is the existing aggregator, so claims need no
second one.

## Rendering: what the counterpart sees

One section, on the run's ace-web page and mirrored in the reply: **"What changed because you
asked."** Grouped by person, ordered by `checkable_at`, with every claim rendered whichever
way it went.

This follows `feedback-ledger`'s completeness property deliberately: the claim set is the
denominator, and an unmet claim shows up as an accusation rather than an absence. Per
`CLAUDE.md § Conventions`, the run page is the reviewer's surface — the reply leads with it
rather than with Drive.

Rendering the counterpart's own claims distinctly from ACE's is what makes §1 safe: she can
see which bar was hers and which ACE set for itself, and say so when ACE's is too low.

### The two surfaces, and the one contract they share

| Surface | Built by | Shows |
|---|---|---|
| The run's public summary page | `apps/opps/summary.py::_read_claims` + `ClaimsSection.tsx` in `ace-web` | claim, verdict, `judged` qualifier, `authored_by: counterpart` marking, `says` |
| The reply, `opp-eval`, the members' workbench | `lib/render-claims.ts::renderClaimsSection` | the same, plus `evidence` on an `internal` audience |

`renderClaimsSection(set, { audience })` takes `'counterpart'` (the default) or
`'internal'`. The default is the safe one on purpose: a caller that wants the audit
record has to ask for it, so a new consumer cannot leak by forgetting.

**ace-web matches this contract rather than inventing a second one.** The three
properties that carry the design's weight — every claim renders whichever way it went;
a claim the counterpart authored is marked as theirs; a `judged` verdict is qualified —
are what make the mitigation in §1 real, and a second renderer that dropped any one of
them would look fine and be useless. The public page is a `counterpart` surface and
therefore never carries `evidence`; a workspace member's view of the same page carries
it underneath, which is the `internal` half of the same split.

An ABSENT `claims.yaml` renders nothing at all — most opportunities have none, and a
"no claims" heading on every other run would train reviewers to skip the section. An
UNREADABLE one is surfaced as a visible problem, matching `classifyRunClaims`'s
`ok: false` posture; failing silently would put the reviewer back in front of a page
that renders an omission as an absence, which is the failure this whole design exists
to kill.

## What this deliberately does NOT do

- **It does not block.** §2.
- **It does not create a second judgment store.** Verdicts live in the claim record; the
  reviewer-facing view is derived, the same posture `feedback-ledger` takes.
- **It does not force claims into `decisions.yaml`.** A claim is not a decision — the same
  constraint Jon set on 2026-07-27 (*"not everything can be constituted as a decision"*).
  Writing claims there would fabricate deliberation that never happened and corrupt the one
  store whose worth depends on honestly recording what ACE actually weighed.
- **It does not replace `feedback-ledger`.** That answers *did their input reach us*; this
  answers *did the work implied by it happen*. They join on `thread_id` + `decision_ref` and
  render adjacently.
- **It does not infer claims from artifacts.** A claim exists because a person said
  something. No mining.

## Testing

- `lib/run-claims.ts` — pure: schema, freeze, verdict assignment, closeout sweep to
  `NOT REACHED`. Unit-tested with no Drive.
- A claim frozen into a run cannot be mutated — assert the freeze rejects edits.
- A `probe`-kind claim whose probe did not run yields `NOT REACHED`, never `judged` — assert
  the classifier refuses the degradation.
- `INDETERMINATE` without `would_settle_it` is rejected.
- A run halting at Phase 4 yields verdicts for Phases 1–4 claims and `NOT REACHED` for the
  rest — the partial-diff property from §4.
- Fixture from the real case: one decision → three claims across Phases 3/4/5, one MET, one
  UNMET, one NOT REACHED; assert the rendered section shows all three.
- **Regression control:** a claim set where every claim is MET but one checkpoint never ran
  must NOT render as fully met.
- `evidence` never reaches a `counterpart` render, at any verdict, including a claim that
  carries no `says` — the fallback is silence about the detail, not the audit record in its
  place.
- The ace-web payload's absent / unreadable branches, and that its render carries the
  counterpart marking and the `judged` qualifier.

## Residuals

- **Claim quality is unmeasured.** Nothing yet grades whether ACE's drafted claims faithfully
  capture the decision. The mitigation is reviewer visibility (§1), not a metric. If claims
  drift toward the easy, a `claims-eval` rubric is the answer — deliberately not in v1.
- **`checkable_at` is author-assigned** and can be wrong, which shows up as a claim that is
  `NOT REACHED` on a completed run. That is loud, which is the intended failure mode.
- **Cross-run claims are out of scope.** A claim belongs to exactly one run. A decision that
  should hold for every future run is a different object and is not modelled here.
