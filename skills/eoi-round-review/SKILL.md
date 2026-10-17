---
name: eoi-round-review
description: >
  Summarise every response to one or more marketplace EOI/RFP rounds and recommend a shortlist with roles, a bench and questions to ask. Needs the round slug.
disable-model-invocation: false
---

# EOI Round Review

Turns a marketplace round's submissions into the document a programme team acts on: who
to go with, in which role, why, what to ask them first, and who is on the bench. It reads
every response, scores each against a rubric written for *this* call, adds what labs
already knows about each organisation (rounds it answered before, what it actually
delivered on Connect), and keeps the result short. Across several rounds it adds a short
cross-round section.

The yardstick is the team's own hand-built shortlist for the 2026 ULAB scoping EOI ("EOI
LLO recos" in the CGD Lead Research RFP doc): a bottom line, one table of picks, a short
note per pick, a waitlist, a pass list with one reason each. Neal's R pipeline
(`dimagi-internal/connect-interviews-analysis`, `llm/eoi_*`) produces exhaustive reports
with good quotes that are too long to act on. This skill keeps the quotes and drops the
length.

**Responses are confidential to Dimagi.** Applicants' answers are never shared with other
applicants or outside Dimagi. The document goes in ACE's Drive area and is shared only
with Dimagi people (`@dimagi.com`, `@dimagi-ai.com`, `@dimagi-associate.com`). Contact
names, emails and phones are not read (`include_contacts` stays false) and never appear
in it.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Requester or `current_page` | round slug(s), e.g. `ulab-scoping-2026` | which rounds to read |
| connect-labs | `marketplace_rounds_list(slug=…)` | title, deadline, countries, questions, announcement link |
| Drive | the round's announcement doc (`announcement_url`) | what was asked: activities, priority areas, budget and rates, roles |
| Requester (optional) | a scoring brief, budget, or the team's own criteria | the rubric, in place of one ACE derives |
| connect-labs | `marketplace_round_responses(slug=…)` | every submission's answers, and its matched org |
| connect-labs | `marketplace_orgs_get(slugs=…)` | each matched org's delivered and applied programmes, year established, team size |
| Requester (optional) | the team's own picks, for comparison | the agreement table (step 9) |

## Products

- A Google Doc, published with `gdoc-writer` under `Projects/<project>/` (the project is
  the round's programme or the requester's project name). It has two tabs:
  1. **Recommendation**, under ~2 pages: bottom line, picks table, a note per pick,
     waitlist, pass list, gaps to close before launch, and how it was scored.
  2. **Every response**: one ≤120-word entry per submission, with verdict, role fit,
     cost per unit, strengths and concerns citing the answer, and questions to ask.
- The link, in the reply to the requester. The document is never pasted into chat or
  email.

## Process

1. **Resolve the round(s).**
   - From the canopy panel, read `current_page`. A `labs-marketplace://rounds/<slug>` page
     names the round, so don't ask for it.
   - Otherwise take the slug(s) from the request, or match the name against
     `marketplace_rounds_list()`. If two rounds could be meant, ask in the chat.
   - Read each round with `marketplace_rounds_list(slug=…)`. If `applications` is 0 and
     the round has a response sheet, it has not been ingested. The usual cause is the
     sheet not being shared with the labs service account. Say so and stop: a review of
     zero responses is not a finding.

2. **Read the call itself.**
   - Open `announcement_url` with `drive_read_file` (or `read_personal_drive_doc` if the
     service account can't see it).
   - Pull out what the work is, the units and their rates, the total budget, the priority
     geographies, the roles being filled (e.g. "household survey LLO" vs "value-chain
     lead"), and the timeline.
   - Everything in the rubric and the recommendation is checked against these facts, not
     against what applicants say about the call.

3. **Write the rubric for this call, and show it before scoring.**
   - Use 6–8 criteria in the shape of Sagar's ULAB prompt (geography, relevant
     experience, access to the chain or the system, local knowledge, delivery capacity,
     recruitment and sampling, cost fit, organisational credibility). Adapt each one to
     what this call asks.
   - If the requester gave criteria, use theirs.
   - **Drop any criterion every applicant will pass.** In ULAB, "prevalence" and "has
     used a mobile app" separated nobody. Prefer criteria that do separate applicants:
     named districts or LGAs, an itemised budget, a documented link to the relevant
     actors, and a sampling plan that addresses bias.
   - Write it as a short list. In Review mode, post it and wait for agreement.

4. **Pull every response, without contacts.**
   - Call `marketplace_round_responses(slug=…)`. Leave `include_contacts` false: the
     review never needs a person's address.
   - If `truncated` is true, say so in the doc.
   - Group duplicate submissions (the same org name, or the same matched `org_slug`, more
     than once). Review the latest and note the duplicate. Never count one org twice.

5. **Add what labs already knows about each organisation.**
   - For every matched `org_slug`, call `marketplace_orgs_get` (≤100 slugs per call).
   - Use `delivered_programs` (what they actually ran on Connect) and `applied_programs`
     (what they asked for). A strong record on Connect is evidence. A string of
     applications with no delivery is a pattern worth one line.
   - An unmatched submission has no history here. Say "no labs record", not "new".

6. **Review each response against the rubric.**
   - Split the responses into batches of about 8 and give each batch to a subagent. Pass
     it the rubric, the call facts from step 2, the org history from step 5, and these
     rules.
   - Each subagent returns, per response:
     - `verdict`: Strong / Possible / Weak fit;
     - `role`: which role it suits, or neither;
     - a score of 0–3 per criterion, each with the answer it rests on;
     - `cost_per_unit`: their quote converted to the call's unit (per survey, per
       interview), or "not given";
     - 2–4 strengths and 2–4 concerns, each quoting or citing their answer;
     - 2–3 questions to ask before shortlisting;
     - `flags`: inflated or inconsistent numbers, a cost that is an outlier, answers that
       read as generic or AI-written, and capability that rests on one person.
   - **Separate facts from inference.** What they wrote is a claim. A claim confirmed by
     labs history or by a source counts as evidence.
   - Do not reward a confident claim that has no evidence behind it.
   - Web-check only the candidates heading for the picks or the bench: registration, age,
     visible track record, and named partners. Cite every source.

7. **Read across the whole pool before choosing.**
   - Find what the pool has in common and what separates it, the same way the team's
     ULAB notes do. Look at:
     - geography: who names districts, who claims many states and is vague outside one;
     - who has real access to the chain or the actors;
     - how young the organisations are;
     - how they sample, and who addresses bias;
     - the spread of prices, expressed in the call's units.
   - These patterns become the "how we scored" note and the "gaps to close" section.

8. **Write the recommendation.**
   - **Bottom line**: one or two sentences naming who to go with, for which role, within
     what budget.
   - **Picks table**: partner, country and site, role, why them (one line, with
     evidence), and approximate budget.
   - **One note per pick**: why them; gaps; "ask them" (2–3 questions); the role.
   - **Waitlist**: named fallbacks per slot, each with one reason.
   - **Pass list**: the notable passes, each with one line of reason. Give a strong
     applicant that doesn't fit this budget or scope its own line, so the team keeps it
     for later.
   - **Gaps to close before launch**: what the pool cannot yet answer, which design
     assumption the responses challenge, and the standard rate card or template to issue.
   - **How we scored**: the rubric from step 3 and what was dropped, in three lines.
   - Keep the Recommendation tab under ~2 pages. Everything else goes in the Every
     response tab.
   - For several rounds, add **Across rounds**: organisations that answered more than one
     round and how they did, how the pools differed, and any organisation strong in one
     round that is worth inviting to another.
   - Plain language. No scores in the bottom line. Numbers only where they decide
     something (a price, a count, a budget).

9. **Compare with the team's picks when there are any.**
   - When the requester gives the team's own shortlist (as for ULAB), add a short table
     with each pick, theirs vs ACE's, agree or differ, and why.
   - A difference is information, not an error to hide. A difference ACE cannot defend
     from the responses is a finding about this skill. Note it in the reply.

10. **Publish and share the link.**
    - Publish with `gdoc-writer`. Run `agent-turn-review` before sending.
    - Reply with the link and three lines: who, why, and what to ask first.
    - Share only with Dimagi addresses.

## MCP Tools Used

- connect-labs: `marketplace_rounds_list`, `marketplace_round_responses` (owner-gated:
  ACE's labs user must belong to Dimagi, the owner of every directory round),
  `marketplace_orgs_get`
- canopy-web: `current_page` (when started from the marketplace panel)
- Google Drive: `drive_read_file`, `read_personal_drive_doc` (the announcement);
  publishing goes through `gdoc-writer`
- Web search, for shortlist candidates only

## Mode Behavior

- **Auto:** derive the rubric, score, publish and reply with the link.
- **Review:** post the rubric from step 3 and wait for agreement before scoring. Publish
  the draft and wait for the requester's edits before it goes to anyone else.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-16 | Initial version, modelled on the team's ULAB shortlist and Sagar's ULAB EOI prompt; reads round responses through connect-labs `marketplace_round_responses` (connect-labs#2586) | ACE team |
