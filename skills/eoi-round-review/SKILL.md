---
name: eoi-round-review
description: >
  AI-review a marketplace EOI round's responses on its labs criteria and write a shortlist doc. Needs the round slug.
disable-model-invocation: false
---

# EOI Round Review

The AI first pass on a marketplace round. It reads every response, scores each on the
round's evaluation criteria (saved on the round in labs, 1–10 per criterion), adds what
labs already knows about each organisation (rounds it answered before, what it actually
delivered on Connect), and writes one **AI review per response into labs**. Every statement
in a review is a **claim** that points at the evidence it rests on: the exact words in the
response, an answer that is silent on the point, or labs history or a web source. People
then review in labs, starting from those AI reviews and clicking a claim to see its
passages highlighted in the response (see § What happens next in labs). It also
writes the short document a programme team acts on: who to go with, in which role, why,
what to ask them first, and who is on the bench. Across several rounds it adds a short
cross-round section.

The criteria are the round's, not this skill's. EOI forms go out without a published
evaluation framework, so the criteria are written after the submissions arrive, by
`eoi-criteria-proposal`, approved by a person and saved on the round. This skill never
scores against a private rubric of its own: an AI review and a human review of the same
response must be scored on the same criteria to be comparable.

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
in it, or in any field of a labs review, including a claim's `text` or a `quote`. Reviews
in labs are visible only inside the round's owner org (Dimagi), but treat every field as a
record others will read: cite the organisation's answers, never a person.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Requester or `current_page` | round slug(s), e.g. `ulab-scoping-2026` | which rounds to read |
| connect-labs | `marketplace_rounds_list(slug=…)` | title, deadline, countries, questions, announcement link |
| Drive | the round's announcement doc (`announcement_url`) | what was asked: activities, priority areas, budget and rates, roles |
| connect-labs | `marketplace_round_responses(slug=…)` | every submission's answers (each `{question_id, question, answer}`; claims cite `question_id`), its `response_id` and matched org; `round.evaluation_criteria` and `round.rubric_version` |
| connect-labs | `list_reviews(response_id=…)` | reviews already on each response (an earlier AI pass, human reviews built on it) |
| connect-labs | `marketplace_orgs_get(slugs=…)` | each matched org's delivered and applied programmes, year established, team size |
| Requester (optional) | the team's own picks, for comparison | the agreement table (step 9) |

## Products

- **One AI review per response in labs**, written with `create_review(kind="ai", …)`:
  1–10 per criterion, `claims` (each criterion's reason, the strengths, the concerns, each
  with the passages it rests on), questions to ask, flags, an outcome (`pick` / `backup` /
  `waitlist` / `pass`) and provenance. Labs fills the per-criterion notes, strengths and
  concerns from the claims, and computes the overall score from the criteria scores and
  the round's weights. Re-running replaces ACE's earlier AI review of that response.
- A Google Doc, published with `gdoc-writer` under `Projects/<project>/` (the project is
  the round's programme or the requester's project name). It has two tabs:
  1. **Recommendation**, under ~2 pages: bottom line, picks table, a note per pick,
     waitlist, pass list, gaps to close before launch, and how it was scored.
  2. **Every response**: one ≤120-word entry per submission, with outcome, role fit,
     cost per unit, strengths and concerns citing the answer, and questions to ask.
  The doc opens with a link to the round page in labs,
  https://labs.connect.dimagi.com/labs/marketplace/rounds/<slug>/, where reviewers verify,
  edit or add their own reviews. The doc is a summary of the AI pass; labs holds the
  reviews.
- Both links (doc and round page), in the reply to the requester. The document is never
  pasted into chat or email.

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
   - Every score and the recommendation are checked against these facts, not
     against what applicants say about the call.

3. **Require the round's criteria.**
   - Read `round.evaluation_criteria` and `round.rubric_version` from
     `marketplace_round_responses(slug=…)` (step 4 makes this call; make it now if
     needed).
   - **If the criteria are empty, run `eoi-criteria-proposal` first** and come back once
     the requester has approved and saved a set. Do not invent a rubric here, and do not
     score against criteria that exist only in this conversation. If the requester brings
     their own criteria, they go through `eoi-criteria-proposal` too, so they are tested
     against the pool and saved on the round.
   - If the criteria exist but the requester questions them, or they plainly do not fit
     the pool (a criterion every response would score the same), say so and offer
     `eoi-criteria-proposal` before scoring. Replacing them later invalidates this pass.
   - Show the criteria (name, weight) in one short list before scoring, with the
     `rubric_version` the reviews will carry.

4. **Pull every response, without contacts.**
   - Call `marketplace_round_responses(slug=…)`. Leave `include_contacts` false: the
     review never needs a person's address.
   - If `truncated` is true, say so in the doc.
   - Keep each answer's `question_id` and its `answer` text exactly as returned. Claims
     cite answers by `question_id`, and every `quote` is checked against that `answer`
     text, so never pass subagents a cleaned-up, summarised or re-wrapped copy.
   - Group duplicate submissions (the same org name, or the same matched `org_slug`, more
     than once). Review the latest and note the duplicate. Never count one org twice. Each
     duplicate still has its own `response_id`; write the AI review on the latest, with a
     `flag` claim noting the earlier submission.

5. **Add what labs already knows about each organisation.**
   - For every matched `org_slug`, call `marketplace_orgs_get` (≤100 slugs per call).
   - Use `delivered_programs` (what they actually ran on Connect) and `applied_programs`
     (what they asked for). A strong record on Connect is evidence. A string of
     applications with no delivery is a pattern worth one line.
   - An unmatched submission has no history here. Say "no labs record", not "new".

6. **Review each response on the round's criteria.**
   - Split the responses into batches of about 8 and give each batch to a subagent. Pass
     it the criteria exactly as saved (ids, weights, scoring guides), the call facts from
     step 2, the org history from step 5, each response's answers as
     `{question_id, question, answer}` exactly as labs returned them, and these rules
     (§ Claims and evidence below is part of the brief; paste it in).
   - Each subagent returns, per response (keyed by `response_id`):
     - `criteria_scores`: `{criterion_id: 1–10}` for **every** criterion on the round,
       scored against that criterion's `scoring_guide` anchors; ids exactly as saved;
     - `claims`: the review's statements, in the shape in § Claims and evidence:
       - at least one `about: "criterion:<criterion_id>"` claim for **every** criterion
         scored, giving the reason for that score;
       - 2–4 `strength` and 2–4 `concern` claims;
       - a `flag` claim for each flag, saying what in the response raised it;
       - one `outcome` claim giving the reason for the provisional outcome;
       - the role it suits (or neither) and the cost per unit go in a strength, concern or
         outcome claim, citing the answer they come from;
     - `role`: which role it suits, or neither (for the doc);
     - `cost_per_unit`: their quote converted to the call's unit (per survey, per
       interview), or "not given" (for the doc);
     - `ask_next`: 2–3 questions to ask before shortlisting;
     - `flags`: short strings from `generic-or-ai-drafted`, `inflated-numbers`,
       `cost-outlier`, `single-person-capacity`, `safety`, `duplicate`, or another short
       kebab-case label when none fits;
     - a provisional outcome (step 8 settles it across the pool, and rewrites the
       `outcome` claim if it changes).
   - **Separate facts from inference.** What they wrote is what they say about
     themselves. A statement confirmed by labs history or by a source counts as evidence,
     and the claim cites that source as well as the answer.
   - Do not reward a confident statement that has no evidence behind it.
   - Web-check only the candidates heading for the picks or the bench: registration, age,
     visible track record, and named partners. Cite every source as a `web` cite with its
     url.
   - When the batches come back, check every claim before step 10: each `quote` appears
     in the answer its `question` names (a plain substring check that, like labs,
     ignores case and runs of whitespace and normalises curly quotes and dashes), each
     `question` is a real `question_id` of that response, ids are unique within the
     review, and every scored criterion has a claim. Fix what fails by
     copying the words from the answer, or send the response back to a subagent. This
     catches most of what labs would refuse.

7. **Read across the whole pool before choosing.**
   - Find what the pool has in common and what separates it, the same way the team's
     ULAB notes do. Look at:
     - geography: who names districts, who claims many states and is vague outside one;
     - who has real access to the chain or the actors;
     - how young the organisations are;
     - how they sample, and who addresses bias;
     - the spread of prices, expressed in the call's units.
   - These patterns become the "how we scored" note and the "gaps to close" section.
   - If the pool shows a criterion is not separating anyone, or something decisive has no
     criterion, say so in the reply and suggest `eoi-criteria-proposal`. Do not adjust the
     scores to compensate.

8. **Settle outcomes, then write the recommendation.**
   - Give every response one `outcome`: `pick` (in the picks table), `backup` (a named
     fallback for a slot), `waitlist` (credible, not for now), or `pass`. The doc's picks
     table, waitlist and pass list are exactly these outcomes, so labs and the doc agree.
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
   - **How we scored**: the round's criteria and weights (with `rubric_version`), what the
     criteria basis says was dropped, and the round-page link, in three lines.
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

10. **Write the AI reviews to labs.**
    - For each response, call `list_reviews(response_id=…)` first. If people have already
      reviewed on top of ACE's earlier AI review (`based_on` it, or feedback on it), say so
      in the reply before replacing it: their review stays, but it now sits on an AI review
      that changed.
    - Then call, per response:

      ```
      create_review(
        public_record_acknowledged=true,
        response_id=<response_id>,
        llo_entity_id=<matched org_slug, or "">,
        kind="ai",
        criteria_scores={<criterion_id>: <1-10>, ...},   # every criterion on the round
        claims=[{id, about, text, basis, cites}, ...],   # § Claims and evidence
        ask_next="<2-3 questions>",
        flags=[...],
        outcome="pick" | "backup" | "waitlist" | "pass",
        provenance={
          model: "<the model running this skill>",
          skill: "eoi-round-review",
          skill_version: "<ACE plugin version: cat ${CLAUDE_PLUGIN_ROOT}/VERSION>",
          rubric_version: <round.rubric_version>,
          sources: ["form answers", "labs org history", "web: <url>", ...],
        },
      )
      ```

      Do not pass `score` (labs computes it from `criteria_scores` and the round's
      weights) or `based_on` (a human field). Do not pass `strengths`, `concerns` or
      `criteria_notes` either: labs fills them from the claims, and a second copy in the
      flat fields would drift from the evidence. `sources` lists only what this review
      actually used.
    - **Labs checks every quote on save.** If any `quote` is not found in the answer its
      `question` names, labs refuses the whole review with `BAD_REQUEST`, naming each
      quote it could not find. Then:
      1. For each quote named, reopen that response's answer to that `question_id` and
         copy the words exactly as they appear there (or the answer they actually came
         from, fixing `question`). Never paraphrase inside `quote` to make it pass.
      2. If the point is not in the answer in so many words, change the cite instead:
         `whole: true` with `basis: "synthesized"`, `absent: true` if the claim is that
         the answer is silent, or drop the claim if nothing supports it.
      3. Retry `create_review` with the corrected claims. Nothing was saved by the
         refused call, so retry the full review, not just the fixed claims.
      4. If the same response is refused twice, stop retrying it, list its `response_id`
         and the quotes labs named in the reply, and do not report the pass complete.
    - Contact details never go in any field, claim or quote. Name the organisation, never
      a person.
    - Re-running replaces ACE's AI review of that response; it never adds a second one.
    - Read back with `list_reviews` for a sample of responses (and every `pick`) and check
      the scores, the claims (with their cites) and `rubric_version` landed, and that
      labs filled the strengths, concerns and criteria notes from them. If any write failed, list the response ids in
      the reply; do not report the pass complete.
    - If `rubric_version` on the round changed while this ran, stop: the reviews written so
      far carry a version that no longer applies. Re-run.

11. **Publish and share the links.**
    - Publish with `gdoc-writer`, with the round-page link at the top. Run
      `agent-turn-review` before sending.
    - Reply with both links (doc and round page) and three lines: who, why, and what to
      ask first. Add one line on what happens next in labs (below).
    - Share only with Dimagi addresses.

## Claims and evidence

A claim is one statement in the review, tied to what it rests on. Reviewers click a claim
in labs and see its passages highlighted in the response, so a claim is only as useful as
its cites are exact.

- `id`: short, unique within the review: `"c1"`, `"c2"`, …
- `about`: `"criterion:<criterion_id>"` (the reason for that criterion's score),
  `"strength"`, `"concern"`, `"flag"` or `"outcome"`.
- `text`: one sentence in plain language. No names, emails or phone numbers.
- `basis`: `"quoted"` when the claim rests on specific passages, or `"synthesized"` when
  it is a judgement drawn from across the response ("the text is generic throughout",
  "the answers contradict each other on staff numbers"). A synthesized claim is fully
  legitimate, not an unsourced one; mark it honestly rather than hunting for a quote that
  only half supports it.
- `cites`: a list; each entry is one of:
  - `{"question": "<question_id>", "quote": "<exact words from that answer>"}`. The quote
    must appear **verbatim** in that answer. Labs ignores case and runs of whitespace and
    normalises curly quotes and dashes, nothing else, so copy the words: never
    paraphrase, fix spelling or grammar, translate, join two passages with "…", or add
    words inside `quote`. Keep it short: the phrase that carries the point, typically 3
    to 25 words. Several cites per claim are fine, across several questions.
  - `{"question": "<question_id>", "absent": true}`: the claim is about something missing
    from that answer ("names no battery buyer").
  - `{"question": "<question_id>", "whole": true}`: a synthesized claim drawn from that
    whole answer.
  - `{"source": "labs", "detail": "<what labs shows>"}` for labs history, e.g. delivered
    programmes; `{"source": "web", "detail": "<what the page shows>", "url": "<url>"}`
    for the web (the url is required).
- A synthesized claim may have no cites at all when it is drawn from the whole response.
- **Contact details never go in a quote.** If the only passage that supports a claim
  contains a person's name, email or phone, cite that answer with `whole: true` instead
  of quoting it.

Example, for an invented applicant (criterion ids are whatever the round saved):

```json
[
  {"id": "c1", "about": "criterion:named_sites", "basis": "quoted",
   "text": "Names three districts and the markets it already works in there.",
   "cites": [{"question": "q4", "quote": "we work in Kisumu, Siaya and Homa Bay"},
             {"question": "q4", "quote": "weekly visits to the Kibuye and Bondo markets"}]},
  {"id": "c2", "about": "criterion:cost_fit", "basis": "quoted",
   "text": "Quotes 9 USD per household survey, under the call's rate.",
   "cites": [{"question": "q9", "quote": "USD 9 per completed household survey"}]},
  {"id": "c3", "about": "strength", "basis": "quoted",
   "text": "Has delivered a Connect programme before, and finished it.",
   "cites": [{"source": "labs", "detail": "delivered one Connect programme in 2025"},
             {"question": "q6", "quote": "completed our first Connect project last year"}]},
  {"id": "c4", "about": "concern", "basis": "quoted",
   "text": "Does not say who would buy the batteries it plans to collect.",
   "cites": [{"question": "q7", "absent": true}]},
  {"id": "c5", "about": "flag", "basis": "synthesized",
   "text": "Answers read as generic text that could fit any call.",
   "cites": [{"question": "q2", "whole": true}, {"question": "q3", "whole": true}]},
  {"id": "c6", "about": "outcome", "basis": "synthesized",
   "text": "Backup for the survey role: strong sites and price, but no buyer for the value-chain role."}
]
```

## What happens next in labs

The AI review is a first pass, not the decision. On the round page
(https://labs.connect.dimagi.com/labs/marketplace/rounds/<slug>/) a reviewer sees each
response and its reviews side by side. Clicking a claim in a review highlights the
passages it cites in the response (or marks the answer it says is silent, or shows the
labs or web source), so a reviewer checks the AI's reasoning against the applicant's own
words instead of taking it on trust. Any Dimagi reviewer can:

- **give feedback on the AI review**: agree, or say where it is wrong, without writing a
  review of their own; or
- **copy it into their own review and edit it**: a human review that starts from the AI
  scores and claims (`based_on` the AI review) and becomes theirs, with their own scores
  and outcome. While editing they can remove evidence that does not hold up and add their
  own, highlighting passages in the response; or write one from scratch.

Several people may review the same response; every review is scored on the same criteria
and `rubric_version`, so they can be compared side by side with the AI's. Re-running this
skill replaces only ACE's AI review; human reviews stay. If the criteria are replaced,
every review on the old version (AI and human) was scored against criteria that no longer
apply, which is why `eoi-criteria-proposal` asks before replacing them.

## MCP Tools Used

- connect-labs: `marketplace_rounds_list`, `marketplace_round_responses` (owner-gated:
  ACE's labs user must belong to Dimagi, the owner of every directory round),
  `marketplace_orgs_get`, `list_reviews`, `create_review` (`kind="ai"`, with `claims`;
  refuses with `BAD_REQUEST` on a quote it cannot find)
- canopy-web: `current_page` (when started from the marketplace panel)
- Google Drive: `drive_read_file`, `read_personal_drive_doc` (the announcement);
  publishing goes through `gdoc-writer`
- Web search, for shortlist candidates only

## Mode Behavior

- **Auto:** with criteria on the round, score, write the AI reviews, publish and reply
  with the links. With no criteria, run `eoi-criteria-proposal`, which always waits for
  approval before saving; scoring starts after that.
- **Review:** show the criteria from step 3 and wait for a go-ahead before scoring and
  writing reviews. Publish the draft and wait for the requester's edits before it goes to
  anyone else.

## Terminology

The doc and every review are prose a person reads. Follow `skills/_terminology.md`: the
platform is "Connect".

## Related skills

- `eoi-criteria-proposal` writes the round's criteria from the pool; run it first when the
  round has none.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-17 | Evidence: every statement in an AI review is a claim citing the response's exact words (`question_id` + verbatim quote), an absent or whole answer, or labs/web history; strengths, concerns and criterion notes go in `claims` (labs fills the flat fields); fix-and-retry on `BAD_REQUEST`; reviewers click a claim to see its passages | ACE team |
| 2026-10-17 | Scores on the round's saved criteria (1–10, via `eoi-criteria-proposal`; no private rubric), writes one AI review per response to labs (`create_review(kind="ai")`), links the doc to the round page, explains the human review flow in labs | ACE team |
| 2026-10-16 | Initial version, modelled on the team's ULAB shortlist and Sagar's ULAB EOI prompt; reads round responses through connect-labs `marketplace_round_responses` (connect-labs#2586) | ACE team |
