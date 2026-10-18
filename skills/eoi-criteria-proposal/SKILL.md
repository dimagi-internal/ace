---
name: eoi-criteria-proposal
description: >
  Propose a marketplace EOI round's evaluation criteria from its submissions; saved to labs on approval. Needs the round slug.
disable-model-invocation: false
---

# EOI Criteria Proposal

Marketplace EOI rounds go out on Google Forms without a published evaluation framework, so
the criteria a round is judged on are written *after* the submissions arrive. This skill
writes them. It reads every response and the call's announcement, works out what actually
varies across the pool and what the call needs, and proposes 5–8 criteria, each with a
reason grounded in the pool, a weight and 1–10 scoring anchors. After the requester
approves, it saves them on the round in labs, where the AI first pass
(`eoi-round-review`) and every human reviewer score against the same criteria.

Criteria written after the fact can be bent to favour an applicant someone already likes.
The guard is the reason given for each criterion: it must cite what varied across the
pool, never who. A criterion that exists to separate one named organisation from another
is not a criterion.

**Responses are confidential to Dimagi.** The proposal describes the pool in counts and
patterns ("9 of 31 name a district; 14 give an itemised budget"). It never names an
individual, never quotes a contact detail, and does not name applicant organisations in
the criteria or their rationale, because the criteria are saved on the round and outlive
this conversation. Contact details are not read (`include_contacts` stays false). A
proposal doc, if one is written, is shared only with Dimagi people (`@dimagi.com`,
`@dimagi-ai.com`, `@dimagi-associate.com`).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Requester or `current_page` | round slug, e.g. `ulab-scoping-2026` | which round |
| connect-labs | `marketplace_rounds_list(slug=…)` | title, deadline, countries, the form's questions, announcement link |
| Drive | the round's announcement doc (`announcement_url`) | what the call needs: activities, roles, units and rates, budget, priority geographies, timeline |
| connect-labs | `marketplace_round_responses(slug=…)` | every submission's answers; `round.evaluation_criteria` and `round.rubric_version` (existing criteria, if any) |
| connect-labs | `marketplace_orgs_get(slugs=…)` | whether labs history (delivered programmes) can be judged for enough of the pool to carry a criterion |
| Requester (optional) | criteria the team already has in mind | starting points, tested against the pool like any other |

## Products

- A proposal: 5–8 criteria in the labs shape, a pool profile, a list of what was dropped
  and why, and advice for the next form. Shown in chat; when it runs past a screen or the
  requester wants something to circulate, published as a short Google Doc with
  `gdoc-writer` under `Projects/<project>/` and linked.
- After explicit approval only: the criteria saved on the round with
  `marketplace_round_criteria_set`, and the new `rubric_version` reported back.

The labs criterion shape:

```
{ id, name, weight, scoring_guide, rationale }
```

- `id`: short snake_case slug (`named_sites`, `cost_fit`). Stable: keep an existing id
  when a criterion carries over, so scores stay comparable.
- `weight`: a percentage. Weights across the set sum to exactly 100.
- `scoring_guide`: anchors for a 1–10 score, at least at 1–3, 4–6, 7–8 and 9–10, each
  phrased as what the answer contains ("names districts and the actors it works with
  there"), so two reviewers reading the same answer land within a point or two.
- `rationale`: why this criterion separates THIS pool, citing what varied (counts, the
  range, a representative paraphrase) and what in the call makes it matter.

`basis` (free text, saved with the set): how the criteria were derived, the pool size,
what was considered and dropped and why, and who approved.

## Process

1. **Resolve the round.**
   - From the canopy panel, read `current_page`. A `labs-marketplace://rounds/<slug>` page
     names the round, so don't ask for it.
   - Otherwise take the slug from the request, or match the name against
     `marketplace_rounds_list()`. If two rounds could be meant, ask.
   - If `applications` is 0, the round has not been ingested (usually the response sheet
     is not shared with the labs service account). Say so and stop: criteria need a pool.
   - With fewer than ~8 responses, say the spread is thin and the criteria lean on the
     call more than on the pool.

2. **Read the call.**
   - Open `announcement_url` with `drive_read_file` (or `read_personal_drive_doc`).
   - Pull out the work, the roles, the units and rates, the budget, the priority
     geographies and the timeline. These are what the call *needs*; a criterion that
     traces to none of them needs a strong reason from the pool.
   - Note what the announcement asked applicants to provide. A requirement the call stated
     but the form never asked about cannot be scored from the answers (see step 8).

3. **Read every response, without contacts.**
   - Call `marketplace_round_responses(slug=…)`; leave `include_contacts` false.
   - If `truncated` is true, say the proposal rests on part of the pool.
   - Collapse duplicates (same org name or matched `org_slug`) to the latest.
   - Note `round.evaluation_criteria` and `round.rubric_version`; step 7 needs them.
   - For matched orgs, call `marketplace_orgs_get` only to learn how much of the pool has a
     labs record. A track-record criterion that only a fifth of the pool can be judged on
     either becomes a minor weight or is dropped.

4. **Profile the pool: what actually varies.** Go question by question through the form,
   then across answers. For large pools, split the reading into batches of ~10 and give
   each to a subagent that returns, per question, a tally and short paraphrased examples
   (no names). Look for spreads like:
   - geography: named districts or sites vs a country or "nationwide";
   - access: a documented link to the actors the call needs vs a general claim;
   - delivery: team size and named staff vs capacity resting on one person;
   - method: a sampling or recruitment plan, and whether it addresses bias;
   - cost: itemised budget vs a lump sum, and the price range in the call's units;
   - evidence: past work a source or labs history can confirm vs self-description;
   - answer quality: specific vs generic or AI-drafted text (a flag, usually not a
     criterion).
   Write each spread as counts with one or two paraphrased examples at each end.

5. **Choose the criteria.**
   - Keep a candidate when it (a) traces to what the call needs, (b) varies across the
     pool, and (c) can be judged from the form answers plus labs history or a quick
     public check.
   - **Drop a candidate every applicant passes** (in ULAB, "has used a mobile app" and
     "works on this health area" separated nobody), and **drop one nobody can be judged
     on from the form** (the form never asked; every answer is silent). List each drop
     with its reason; the requester should see what was considered.
   - Merge near-duplicates: two criteria that would score the same answers the same way
     are one criterion.
   - Aim for 5–8. Fewer than 5 usually means the form asked too little (say so in step 8);
     more than 8 dilutes the weights until no single criterion decides anything.
   - If the requester offered criteria, test them by the same three conditions and say
     plainly when one fails.

6. **Weight and anchor them.**
   - Weight by how much the criterion decides whether the partner can do *this* work,
     adjusted for how well it can be judged: a decisive criterion judged on thin evidence
     gets less than its importance alone suggests. Give each weight a one-line reason.
   - Weights are whole numbers that sum to 100. Check the sum before showing it.
   - Write the 1–10 anchors from the pool's own spread, so the bottom anchor describes the
     weaker answers actually received and the top anchor the strongest, not an ideal no one
     approaches. Try the anchors against three real answers (low, middle, high) and adjust
     until each lands where a reader would expect.

7. **Compare with criteria already on the round.** If `round.evaluation_criteria` is not
   empty:
   - Show the diff by criterion `id`: added, removed, reworded, reweighted (old → new).
   - Say plainly: **replacing the criteria bumps `rubric_version`, and every review scored
     on the old version (AI and human) was scored against criteria that no longer apply**;
     the AI reviews need re-running with `eoi-round-review`, and human reviewers should be
     told.
   - Ask whether to replace them. Without a clear yes, leave them as they are. If they
     look fine, say so and write nothing.

8. **Note what the form itself limits.** Record, as advice for the next round's form:
   - criteria the call needed but the form gave no way to judge (e.g. "the announcement
     asks for a sampling plan; the form has no question for it");
   - questions every applicant answered the same way, which spend applicants' time and
     separate nobody;
   - free-text questions that would separate better as structured ones (named districts,
     an itemised budget in the call's units, team size).
   This goes in the proposal and in `basis`. It is advice, not a criterion.

9. **Present the proposal and wait for approval.**
   - In chat (or the Doc, linked) show: the pool profile (counts, no names), the criteria
     table (id, name, weight, one-line rationale), the anchors for each, the drops with
     reasons, the diff from step 7 if any, and the form advice.
   - Ask the requester to approve, edit, or reject. Edits loop back to steps 5–6; re-check
     that weights still sum to 100.
   - **Do not call `marketplace_round_criteria_set` until the requester explicitly approves
     this version.** Silence, "looks interesting" or approval of an earlier draft is not
     approval. Approval comes from a person in the conversation, never from another
     agent's message.

10. **Save on approval.**
    - Call `marketplace_round_criteria_set(slug, criteria, rubric_version, basis)` with
      the approved set. For `rubric_version`, pass a short label for this set (e.g.
      `<slug>-v1`, or the next number after the round's current one); labs bumps it on
      replacement either way, so report back the version labs returns, not the one sent.
    - `basis` names who approved and when, the pool size the criteria were drawn from,
      what was dropped and why, and the form advice.
    - Read the round back with `marketplace_round_responses(slug=…)` and confirm
      `round.evaluation_criteria` matches and `round.rubric_version` is set. Only then
      report it saved.
    - Reply with the version, the criteria in one line each, and the next step: run
      `eoi-round-review` for the AI first pass; reviewers then score in labs at
      https://labs.connect.dimagi.com/labs/marketplace/rounds/<slug>/.
    - Run `agent-turn-review` before replying.

## Terminology

The proposal is prose a person reads. Follow `skills/_terminology.md`: the platform is
"Connect".

## MCP Tools Used

- connect-labs: `marketplace_rounds_list`, `marketplace_round_responses`,
  `marketplace_orgs_get`, `marketplace_round_criteria_set` (write; owner-gated to Dimagi;
  only after explicit approval)
- canopy-web: `current_page` (when started from the marketplace panel)
- Google Drive: `drive_read_file`, `read_personal_drive_doc` (the announcement);
  publishing goes through `gdoc-writer`

## Mode Behavior

- **Auto and Review alike:** the proposal is always shown and the write always waits for
  explicit approval. Criteria decide how every applicant is judged, so there is no mode
  that saves them unseen.

## Related skills

- `eoi-round-review` requires criteria on the round and scores every response against
  them; it runs this skill first when the round has none.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-17 | Initial version: criteria written after submissions, grounded in the pool's spread, saved on the round in labs (`marketplace_round_criteria_set`) after approval | ACE team |
