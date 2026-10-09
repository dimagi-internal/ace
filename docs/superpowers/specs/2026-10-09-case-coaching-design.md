# Case coaching: coach a worker about ONE case, with a picture of that case

Owner request (Jonathan, 2026-10-09, Slack #C05UCR4VDHR thread 1791521280.070339), for the
IDM AI talk (13–14 Oct 2026). Ideas from Lilianna Bagnoli and Surabhi Dubey in that thread.

Until now a Coach conversation was about a WORKER's indicators (`renderBriefing`,
connect-labs `workflow/coach_briefing.py`). This adds a conversation about one CASE (one
baby, in KMC): Labs picks out the case's story from its visits, draws a picture of THAT
case, and briefs the Coach with the case's own visits.

## The loop (owner, 2026-10-09)

- **One story per conversation.** A worker gets roughly one case conversation a week, about
  one case and one story. The Coach is never asked to cover two stories in a thread.
- **Per opportunity.** Whoever runs the opportunity (Dimagi or the LLO) coaches its workers;
  nothing here is programme-level.
- **The production rule** is automated: find every eligible story per worker, then start a
  session either on the worker's **spotlight** case (the baby coached about last time, when
  it has new visits to follow up) or on a story the worker has **not been coached on
  recently**.
- **Who decides what.** Labs is deterministic: eligibility, the facts and the pictures,
  saved in each run's snapshot per worker. The **canopy agent** on the opportunity's
  workflow is the planner. It works out each worker's case-coaching history ITSELF, by
  reading earlier saved runs' snapshots and the coaching sessions started from them. There
  is no history feature in Labs (owner, 2026-10-09: too large for now). It then proposes
  one session per worker with its reason (follow up the spotlight baby, or rotate to a story
  not done lately), the person picks or approves, and it triggers them. Every saved run must
  carry what the agent needs to decide and to write the session.
- **Recent** means the story's evidence falls within 30 days of the opportunity's latest
  visit.
- **Believable weights first.** THRIVING, FALTERING and DANGER_SIGN only apply to a case
  whose whole weight series is plausible (800–5,000 g, no interval that is itself a weight
  check). Otherwise the bad weighing is the story. Scan of the synthetic KMC opportunities
  2026-10-09: without this rule, a "faltering" baby was really 3,213 → 2,881 → 3,300 g and a
  "danger sign" baby weighed 250 g.
- **Weight per visit.** Follow-up forms carry the registration weight as well
  (`child_details.birth_weight_reg.child_weight_reg`). Take a visit's weight only from
  `anthropometric.child_weight_visit`, and the registration weight only from the
  registration form. Reading the repeated field made 371 of 606 BERI babies look like they
  had lost more than 10%.

## The four stories (topic keys)

| Key | Label | When Labs says so (KMC) | What the coach does |
|---|---|---|---|
| `CASE_THRIVING` | Baby is growing well | every interval between weighings at or above 15 g/kg/day and the latest weight above the first by 20% or more | Recognise the worker's effort, ask what they think worked with this family, then next steps: keep up follow-up visits, vaccines on time, exclusive breastfeeding to 6 months. |
| `CASE_WEIGHT_CHECK` | A weighing that is hard to believe | one interval's gain above 40 g/kg/day, OR a loss of more than 10% between visits, OR the same weight on three visits in a row | Non-judgemental, about data quality: "Can you walk me through how you weighed baby on this visit?" Weighing checklist: set the scale to zero, weigh baby without clothes, read the number when baby is still, write it down straight away. |
| `CASE_FALTERING` | Weight has stalled and skin-to-skin time is falling | gain below 5 g/kg/day over the last two intervals, and skin-to-skin hours lower at the latest visit than at the one before | Ask how the family is managing; reinforce KMC practices (hours of skin-to-skin, feeding); agree a sooner follow-up visit. |
| `CASE_DANGER_SIGN` | Danger sign recorded, no referral | a visit records a danger sign and `child_referred` is no | Explain why that sign needs a health facility, ask the worker to check in with the family and refer the baby if the sign is still there. Never diagnose. |

Thresholds are Labs' and live in connect-labs; this table is what the coach is told they mean.

## The briefing contract (Labs writes it, the Coach reads `{session_state.coach_briefing}`)

```
BRIEFING (system text — do not show to the worker)
Programme: Kangaroo Mother Care
Worker: <worker display name, or username>
Case: <case display name>
About this case: <one line: birth weight, date registered, number of visits, date of the last>
Topic: <label> [<CASE_* key>]
What the data shows: <one or two factual sentences with the figures Labs computed>
Earlier coaching on this case: <d Mon yyyy> — <story label>; agreed: <the step agreed, or none>   (optional: written only when the caller supplies it, e.g. the agent from earlier snapshots)
Visits, oldest first:
- <d Mon yyyy>: weight <n,nnn> g; skin-to-skin <h> h in the last 24 h; danger signs: <comma list | none>; referred: <yes | no | not asked>
...
Follow your conversation steps from the opening.
```

- One topic per conversation. The topic key is also the task's `coaching_indicators`
  entry, so coaching progress counts it like an indicator.
- A missing value is written `not recorded`, never left blank or guessed.
- ACE renders the same shape in `lib/coach-briefing.ts` `renderCaseBriefing` (tests pin
  it); the coach prompt's **Case cards** say what each key means and how to talk about it.

## The picture

A case picture is a Labs chart type (connect-labs `workflow/coach_charts`), drawn by Labs
from the case's own visits — one per story, so a field worker understands it at a glance
on a phone. The caption (`coach_image_caption`) names the baby's story in plain words, no
numbers.

## The send

On the KMC worker review's case panel, a "Coach about this baby" button previews the
conversation (picture, opening, briefing). On these synthetic opportunities it offers ONLY
**Send to me (QA test)** — `deliver_to` = the viewer's own ConnectID username — and no
send to the worker (Jonathan: "since these are not real users, don't even have the real
send button").
