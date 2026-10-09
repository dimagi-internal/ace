# Case states: what we think about a case as of a run, and coaching on it

Owner request (Jonathan, 2026-10-09, Slack #C05UCR4VDHR thread 1791521280.070339), for the
IDM AI talk (13–14 Oct 2026). Coaching ideas from Lilianna Bagnoli and Surabhi Dubey in
that thread.

## What this is

A **case state** is what we think about one case (in KMC, one baby) as of a run's date:
"growing well", "a weighing that is hard to believe", "weight stalled and skin-to-skin
falling", "danger sign with no referral". It is the case-level sibling of indicators and
flags, which already work end to end. So it lives where they do: in the programme's
**semantic registry**, evaluated by the semantic engine as of the run date, stored in the
run's snapshot, and read by the same tools.

Owner (2026-10-09): "this is just another way of thinking about indicators / flags that
already work end to end", and "just add to the semantic layer if we need to, that's the
whole point."

## How it fits the semantic layer (connect-labs)

| Layer | What a case state uses |
|---|---|
| Layer 1 (pipeline columns) | The visit fields the states read (weights, skin-to-skin hours, danger signs, referral). |
| Layer 2 (`properties.yml`, one row per case, evaluated `:as_of` the run) | Each case state is a **bool property with a `case_state:` block**. Its SQL composes other properties and registry constants, so thresholds change with a registry edit, not a deploy. |
| Layer 3 (`indicators.yml`) | A count indicator per state. The existing grading gives "cases in state X" per worker, on the existing scorecard and history. |
| Saved run (`snapshot_inputs.case_index`) | The state properties and their evidence are case-index fields, so every saved run records each case's state **as of that run**. History comes from reading earlier runs. |
| Read API | `workflow_run_cases`: a run's cases filtered by state and worker, the case-level sibling of `workflow_run_indicators`. The snapshot carries `caseStateCatalog`. |

Anything the engine cannot yet express is added to the semantic layer as a
programme-agnostic feature. No programme-specific logic lives in Python.

### The `case_state:` block (on a bool Layer-2 property)

Named `case_state`, not `state`, because a worker (FLW) could have states too (owner,
2026-10-09); a worker-level state would take the same shape.

```yaml
- name: case_state_weight_check       # the property name is the topic key
  label: 'A weighing that is hard to believe'   # the state's label
  means: '...'                          # the card's "What it means"
  type: bool
  sql: '...'
  case_state:
    tone: celebrate | check | concern | urgent
    priority: <int>                     # lower = more urgent; a case's state is its true state with the lowest priority
    evidence: [<property/aggregate names>]   # quoted in "What the data shows", read by the picture
    facts: '<template over evidence>'
    picture: {type: series_vs_reference | series_highlight_step | series_with_bars | sign_card, ...}
    coach:
      approach: '<how to talk about it>'
      next_steps: '<the step to agree>'
      limits: '<what it does not tell you>'
```

KMC's four states: `case_state_danger_unreferred`, `case_state_weight_check`,
`case_state_faltering`, `case_state_thriving`. Lessons from scanning the synthetic KMC opportunities, now registry rules:

- **Believable weights first.** A case whose weights fail the plausibility rules is in the
  weight-check state and nothing else: a "faltering" baby was really 3,213 → 2,881 → 3,300 g,
  and a "danger sign" baby weighed 250 g.
- **Weight per visit.** Follow-up forms repeat the registration weight; reading it as that
  visit's weight made 371 of 606 BERI babies look like they had lost more than 10%.
- The weight-check rule is the registry's own `pct_impossible_weight_changes` step rule, so
  coaching and the dashboard agree.

## The loop

- **One state per conversation.** A worker gets roughly one case conversation a week.
- **Per opportunity.** Whoever runs the opportunity (Dimagi or the LLO) coaches its workers.
- **Labs is deterministic; the canopy agent plans.** The agent on the opportunity's
  workflow reads the run's cases by state and earlier runs' case indexes, then proposes one
  session per worker: follow up the **spotlight** case, or rotate to a state the worker has
  not been coached on recently. The person picks; the agent sends. Labs stores no coaching
  history of its own.

## The coach (ACE)

- **Case cards are generated from the registry**, the way indicator cards come from its
  measures: `lib/coach-briefing.ts` `caseStateCards(properties_doc.properties)` →
  `renderCaseCards`, via `scripts/render-coach-prompt.ts --properties`. A state without
  `case_state.coach` guidance is refused.
- **The briefing** (Labs writes it into `session_data.coach_briefing`; ACE pins the same
  shape in `renderCaseBriefing`):

```
BRIEFING (system text — do not show to the worker)
Programme: <programme>
Worker: <worker display name, or username>
Case: <case display name>
About this case: <one line>
Topic: <case state label> [<case state property name>]
What the data shows: <the state's facts template, filled from its evidence as of the run>
Earlier coaching on this case: <d Mon yyyy> — <state label>; agreed: <step, or none>   (optional: only when the caller supplies it)
Visits, oldest first:
- <d Mon yyyy>: weight <n,nnn> g; skin-to-skin <h> h in the last 24 h; danger signs: <list | none>; referred: <yes | no | not asked>
...
Follow your conversation steps from the opening.
```

  One topic per conversation; the topic key is also the task's `coaching_indicators`
  entry. A missing value is `not recorded`, never guessed.

## The picture and the send

- The picture is a generic Labs case chart, chosen by the case state's `picture` meta and filled
  from the case index and the case's series; its words come from the registry.
- `start_ocs_outreach` with a `case` reads the case's state from the run's case index. On
  the synthetic opportunities the only send is **Send to me (QA test)** (`deliver_to`)
  (Jonathan: "since these are not real users, don't even have the real send button").
