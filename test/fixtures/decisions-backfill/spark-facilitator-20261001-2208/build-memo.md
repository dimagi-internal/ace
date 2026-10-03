# Build memo — Spark Facilitator — FCAP Community Meeting Facilitation · run 20261001-2208

This memo explains what was built for this programme, what you need to decide, and where to check the build. It is written so you can review it without opening the apps first, then spot-check the places it names.

This memo describes run 20261001-2208, which was started as a copy (fork) of run 20260926-1800, re-running from the app build step onward.

**Where to find things:** [Learn app](https://www.commcarehq.org/a/connect-ace-spark/apps/view/8c073531bbb94350a7f0e8b894709ec0/); [Deliver app](https://www.commcarehq.org/a/connect-ace-spark/apps/view/7c34a5505182408c99c537b97fe3e56b/); [Connect opportunity](https://connect.dimagi.com/a/spark-nm-org-test/opportunity/ad6c2d40-474f-4b52-a334-82d17387aeaf/) — named "20261001-2208 · Spark Facilitator — FCAP Community Meeting Facilitation"; [Connect programme](https://connect.dimagi.com/a/spark-pm-org-test/program/f537601b-9a58-40de-add0-fe3fed10f2ef/).

**Terms:** CBF — Community Based Facilitator; FCAP — Facilitated Collective Action Process.

## Known limitations — read first

**Not enforced anywhere yet:** none — every rule the design requires has an enforcement point.

**Checked outside Connect by design — not gaps.** The design itself places these off the platform:

- "location captured for review only, never a payment condition" — review.  
- "no duplicate or GPS flags; de-duplication rides on entity\_id" — the app's de-duplication key plus the Connect rule on the paid-slot field.  
- "review covers ≥ 20% of paid meetings plus 10% of unpaid records, risk-stratified" — the implementing organisation's review procedure.  
- "confirmation calls for ≥ 10% of paid meetings in consenting communities" — the supervisor's call procedure (consent captured at Community Enrolment).

## Decisions you own

These are yours to make; the build could not settle them. Each is explained further down.

1. **Accept or replace the worker payment of 7,500 MWK per verified community meeting.** The design proposes 5,000–10,000 MWK; the build uses 7,500 as a placeholder. Connect pays whatever figure is set here.  
2. **Confirm the payment to the implementing organisation of 3,000 MWK per verified community meeting.** The design marks it as proposed, not agreed.  
3. **Confirm the total budget of 3,276,000 MWK.** The design marks it as proposed; the Connect opportunity was created with this figure.  
4. **Confirm the delivery dates, 2026-11-02 to 2027-02-26.** The design marks them as proposed. Workers earn nothing for work recorded before the start date.  
5. **Have a native speaker review the machine-translated Chichewa and Tumbuka text in both apps, and sign it off.** The translations were produced by AI and have not been reviewed by a speaker. The apps open in English; a worker who switches language sees the unreviewed text.

## Where each rule is enforced

Each rule is quoted from the design. "Applies to" is the rule's scope; the enforcement named first is the one that actually holds it at that scope.

| \# | Rule (from the design) | Applies to | Enforced by |
| :---- | :---- | :---- | :---- |
| 1 | "meeting\_conducted \= yes" | each record | Connect verification rule. Also: A check in the app |
| 2 | "meeting\_type \= community\_meeting" | each record | Connect verification rule. Also: A check in the app |
| 3 | "at most 3 paid community meetings per community per FCAP step" | each community | Connect verification rule. Also: A check in the app (per community) |
| 4 | "the submitting CBF owns the community case" | each record | A check in the app |
| 5 | "a held community meeting dated after the community's previous one (one per community per day)" | each community | A check in the app (per community) |
| 6 | "speakers ≤ attendees; households represented ≤ enrolled households" | each record | A check in the app |
| 7 | "a live meeting photo present on every held meeting" | each record | A check in the app |
| 8 | "every required field for the community's current step present" | each record | A check in the app |
| 9 | "at most 1 payable meeting per CBF per day" | each worker | Connect payment limit — pays at most 1 per worker per day. Also: A check in the app (per community) |
| 10 | "total cap 21 per CBF" | each worker | Connect payment limit — pays at most 21 per worker in total. Also: A check in the app (per community) |
| 11 | "location captured for review only, never a payment condition" | each record | Outside Connect, by design: review |
| 12 | "no duplicate or GPS flags; de-duplication rides on entity\_id" | each record | Outside Connect, by design: the app's de-duplication key plus the Connect rule on the paid-slot field |
| 13 | "review covers ≥ 20% of paid meetings plus 10% of unpaid records, risk-stratified" | each record | Outside Connect, by design: the implementing organisation's review procedure |
| 14 | "confirmation calls for ≥ 10% of paid meetings in consenting communities" | each record | Outside Connect, by design: the supervisor's call procedure (consent captured at Community Enrolment) |

## What was built, and the choices the build made

**What was built.**

- **Learn app** (training), released version 1 in the Spark CommCare project space (the same content as the reviewed build). It has eight modules: a short starting quiz, the six lessons the design lists, and a 12-question final check. A worker passes with 10 of 12 (80%), and passing unlocks the Deliver app. It is in English, with Chichewa and Tumbuka translations that a native speaker has not yet reviewed.  
- **Deliver app** (field work), released version 1 in the Spark CommCare project space (the same content as the reviewed build). It has three menus. Facilitator holds Facilitator Registration and Community Enrolment. Community meetings holds the Community Meeting Record, the only paid record. Other meetings holds the Other Meeting Record, used for committee meetings and meetings that did not happen; it is never paid.  
- **Connect opportunity**, active and marked as a test, under a new Spark programme in Malawi kwacha (MWK). Spark's own Connect workspace runs the programme, and a second Spark workspace holds the opportunity, the way an implementing organisation would.  
  - Payment: one payment line, "Verified community meeting". The worker gets 7,500 MWK and the implementing organisation 3,000 MWK per verified meeting.  
  - Limits per worker: at most 1 paid meeting a day and 21 in total.  
  - Dates and budget: 2 November 2026 to 26 February 2027, with a total budget of 3,276,000 MWK. That is enough for about 14.9 facilitators at the 21-meeting limit, and 12 are planned.  
  - Payment rules: Connect holds three. The meeting happened. It was a community meeting. It is among the first three meetings on the community's current step.  
  - Test user: invited. The invite is pending until the test phone accepts it during the app walk-through.

**Does an unpaid record use up a paid slot?** A meeting past the third on a step still counts toward Connect's daily and total limits, even though it is not paid. Over the 117-day window, a facilitator meeting weekly can record at most 17 community meetings, paid and unpaid together. That is below the limit of 21, so an unpaid record never pushes a paid meeting over the limit. The limit would only start to bite at more than about 1.26 meetings a week. The limit was left at 21 because it is the only place Connect caps a single worker at 21 paid meetings.

| \# | What the build chose, and why | Where to check | What correct looks like |
| :---- | :---- | :---- | :---- |
| 1 | Committee meetings and meetings that did not happen are recorded on a separate unpaid form, not on the paid meeting form. An unpaid record on the paid form would still use up the worker's 21-meeting limit, so it was moved off. This departs from the design's single meeting form. | Deliver app › Other meetings › Other Meeting Record | The form records a committee meeting, or a meeting that did not happen with its reason and a new date; it never changes the community's step. |
| 2 | The paid record carries a "paid slot" marker (yes for the 1st to 3rd meeting on a step, no from the 4th). The marker is part of the record's duplicate-check key, and Connect has a rule that pays only when it is yes. Connect pays a repeated key again, so the key alone would not stop a 4th meeting being paid. | Deliver app › Community Meeting Record (hidden step values); Connect › opportunity › verification rules | A 4th community meeting on one step is saved and labelled "(not paid)"; Connect lists three payment rules. |
| 3 | Connect holds three payment rules, not the two the design lists. The design's two are that the meeting happened and that it was a community meeting. The third is the paid-slot rule, which carries out the design's own limit of 3 paid meetings per step. | Connect › opportunity › verification rules | Three rules: meeting happened \= yes, meeting type \= community meeting, paid slot \= yes. |
| 4 | Worker payment is set at 7,500 MWK, the middle of the design's proposed 5,000–10,000 MWK. It is a placeholder that the awarded rate replaces. | Connect › opportunity › payment units | 7,500 MWK per verified meeting. |
| 5 | Organisation payment is 3,000 MWK per verified meeting, as the design proposes. The design calls this a floor, to be reset from the implementing organisation's own costing. | Connect › opportunity › payment units | 3,000 MWK per verified meeting. |
| 6 | The budget (3,276,000 MWK) and dates (2 November 2026 to 26 February 2027\) are taken as the design proposes. The start was not moved earlier to make test meetings payable. | Connect › opportunity overview | Those dates and that budget. |
| 7 | One payment line covers the whole pilot, not one per step. The order of steps is tracked in the record itself. The Deliver app has one paid unit of work, "Community meeting". | Connect › opportunity › payment units | One payment line, tied to "Community meeting". |
| 8 | The daily limit of 1 and the total of 21 were kept, even though unpaid records count toward them (see the arithmetic above). | Connect › opportunity › payment units | 1 per day, 21 in total. |
| 9 | A new Spark programme was created in Spark's own Connect workspace, with the same name, description and kwacha pricing as the programme the design was reviewed against. Its budget ceiling was set to 32,760,000 MWK, ten times one opportunity's budget, so later runs fit under it. The design's warning that the programme is priced in US dollars does not apply: the new programme is in kwacha. | Connect › programme page | Malawi kwacha, Malawi, delivery type "ACE"; the description says whether the form replaces or adds to Spark's form is for Spark to decide. |
| 10 | The programme runs under Connect's general "ACE" delivery type. None of Connect's 19 types describes community-meeting facilitation, and a fitting type has been suggested to the Connect team. | Connect › programme page | Delivery type "ACE". |
| 11 | Each community is linked under the facilitator who enrolled it, and enrolment starts from the facilitator's own record. This also records which facilitator enrolled each community. | Deliver app › Facilitator › Community Enrolment | Enrolment is reached by opening the facilitator first. |
| 12 | Enrolling the same community ID twice on one phone is blocked, as in Spark's own form. A second enrolment would give the community a second set of paid slots. Duplicates across two phones are left to review. | Deliver app › Community Enrolment › community ID | A repeat ID on the same phone stops the form. |
| 13 | The education options follow Spark's own list (none, primary, secondary, tertiary, university), not the design's list with "other". | Deliver app › Facilitator Registration › education | Five options including university. |
| 14 | Only hidden, computed values are saved back to the community record. The two payment answers are never saved there, because saving them would pre-fill them on the next visit. | Deliver app › Community Meeting Record | "Did the meeting happen" and "meeting type" start blank on every new record. |
| 15 | Two read-aloud scripts were added, each with a confirmation answer. One is a statement read before the group photo; the other asks the community contact's consent to confirmation calls. | Deliver app › Community Meeting Record › photo statement; Community Enrolment › call consent | Each script covers purpose, that taking part is voluntary, how to opt out, privacy, who sees the data, and that there is no payment; a "no" blocks nothing further. |
| 16 | "Meeting type" is asked on the same screen as "did the meeting happen", before the current step is shown, so both payment answers can be fixed in one place. | Deliver app › Community Meeting Record › Meeting | Both questions on one screen. |
| 17 | Meeting location is optional. A missing location is flagged for review, because the design says location never blocks a record or a payment. | Deliver app › Community Meeting Record › Meeting date and place | The form can be saved without a location; review flags it. |
| 18 | Date limits were added where the design gave only an upper limit: recruitment within the last 10 years, partnership within 3 years, and a reschedule date within 60 days. | Deliver app › Facilitator Registration; Community Enrolment; Other Meeting Record | Dates outside those ranges are refused. |
| 19 | Plausibility limits were set on counts: attendance 0–1,000 each for men and women, leaders 0–50, people saving 0–2,000, savings up to 100,000,000 MWK. | Deliver app › Community Meeting Record › Who came and who spoke; Meeting details | Values above those limits are refused. |
| 20 | The unpaid Other Meeting Record asks no savings questions; savings are reported only on held community meetings from Step 5\. | Deliver app › Other Meeting Record | No savings screen. |
| 21 | The question about partner staff is reworded to "staff or a trainer from the partner organisation", because Spark's label names organisations the pilot may not use. Spark's answer codes are kept exactly. | Deliver app › Community Meeting Record › Meeting details | The reworded question. |
| 22 | The current step is shown as seven separate labels, so each step name can be translated. | Deliver app › Community Meeting Record › Step | "This community is on Step N: name", in the worker's language. |
| 23 | The step names keep Spark's "&" exactly as written in Spark's guide, in both apps. | Learn app › Steps and savings; Deliver app › Step | "Community Dynamics, Governance & Leadership" and the other "&" names unchanged. |
| 24 | The Learn app adds a 6-question starting quiz before the lessons. It does not count toward passing and cannot unlock the Deliver app. | Learn app › Before you start › Starting quiz | Six questions; passing it does not unlock delivery. |
| 25 | The Learn app has eight modules: the six lessons, plus separate "Before you start" and "Final assessment" modules. | Learn app › module list | Eight modules in that order. |
| 26 | Of the nine high-risk recording steps the design lists, the five tested in the final check are: enrol once, the household count, the photo, a step marked complete by mistake, and no savings amounts when not saving. Two others are covered by rule questions. | Learn app › Final assessment, questions 8–12 | Those five subjects. |
| 27 | The design's example question was replaced by a harder one about a committee meeting, so the answer turns on the "committee meetings are not paid" rule, not on arithmetic. | Learn app › Final assessment, question 1 | The answer is that the meeting is not paid. |
| 28 | The "Recording a meeting" lesson stands alone without Spark's "Running an Effective Meeting" video, which was not available. | Learn app › Recording a meeting | The lesson reads complete with no video. |
| 29 | The pace guidance "about Step 4 after about 7 weeks" is taught as an on-track check. It is the build's own estimate, worked out from 7 steps in about 13 weeks. | Learn app › Steps and savings | The guidance appears as a check, not a rule. |
| 30 | The lessons teach the two Deliver menus — Community meetings for held community meetings (paid) and Other meetings for everything else (unpaid) — because that is the app a worker will use. | Learn app › Recording a meeting; How payment works | Both menus are named in the lessons. |
| 31 | Teaching examples use made-up names (Chikondi, Mphatso); no real person or community is named. | Learn app › Final assessment | Only made-up names appear. |
| 32 | Left as the design states: a worker may retake the final check as often as they like, against the same 12 questions, so a worker could pass by memorising the answers. Rotating questions per attempt is a capability the build tools do not yet offer. | Learn app › Final assessment | The same 12 questions on every attempt. |
| 33 | Open for the design owner: the paid form requires a group photo, and there is no way to record a meeting where the whole group declines the photo. A meeting that happened could go unpaid. | Deliver app › Community Meeting Record › meeting photo | — the build recorded no fix; the decision belongs to Spark and the implementing organisation. |

## Appendix — references for the build team

- Run: spark-facilitator/20261001-2208 (forked from 20260926-1800 at commcare-setup)  
- Connect verification: form\_field\_rules\_saved: 3  
- Decision 1 sources: program\_parameters.payment\_rate\_band, connect-latitude-payment-amount-spark  
- Decision 2 sources: program\_parameters.llo\_payment\_per\_visit  
- Decision 3 sources: program\_parameters.total\_budget, connect-latitude-program-budget-ceiling-spark, connect-latitude-total-budget-spark  
- Decision 4 sources: program\_parameters.opportunity\_start\_date, opportunity-end-date-spark, connect-latitude-opportunity-dates-spark  
- Decision 5 sources: program\_parameters.working\_language: nya, program\_parameters.working\_language: tum  
- By design "location captured for review only, never a payment condition": phase4-table  
- By design "no duplicate or GPS flags; de-duplication rides on entity\_id": phase4-table  
- By design "review covers ≥ 20% of paid meetings plus 10% of unpaid records, risk-stratified": phase4-table  
- By design "confirmation calls for ≥ 10% of paid meetings in consenting communities": phase4-table

### Appendix A2 — provenance of the choices table

- 1: pdd-to-deliver-app \[ACE\] (Deliver memo); decisions.yaml `deliver-latitude-unpaid-records-separate-form`; PDD §5 / §5.4; ace\#2512.  
- 2: pdd-to-deliver-app \[ACE\] \+ \[FIXED\] (Deliver memo); decisions.yaml `deliver-latitude-payable-slot-key-component`, `deliver-ambiguity-entity-id-grain-vs-cap`; PDD §3.2 / §14 entity\_id\_grain; Phase 3 residual "payable\_slot \= yes".  
- 3: connect-opp-setup \[FIXED\] (Phase 4 memo); decisions.yaml `connect-ambiguity-verification-rules-spark`, `connect-rule-three-per-step-cap-spark`; PDD §14 verification\_flags, §3.2.  
- 4: connect-opp-setup \[ACE\]; decisions.yaml `connect-latitude-payment-amount-spark`; PDD §10.1 / §14 \[PROPOSED\].  
- 5: connect-opp-setup \[ACE\]; decisions.yaml `connect-latitude-org-amount-spark`; PDD §10.1 / §14 \[PROPOSED\].  
- 6: connect-opp-setup \[ACE\]; decisions.yaml `connect-latitude-total-budget-spark`, `connect-latitude-opportunity-dates-spark`, `opportunity-end-date-spark`; PDD §13 / §14 \[PROPOSED\].  
- 7: decisions.yaml `payment-unit-shape-spark`, `deliver-unit-count`; PDD §3.1, §10.1, §14.  
- 8: connect-opp-setup \[ACE\] (Phase 4 memo); decisions.yaml `connect-latitude-max-total-headroom-spark`; Phase 3 residual (pdd-to-deliver-app-eval R3).  
- 9: connect-program-setup (spark rebuild); decisions.yaml `program-reuse-vs-create-spark`, `connect-latitude-program-name-spark`, `connect-latitude-program-dates-spark`, `connect-latitude-program-budget-ceiling-spark`, `connect-ambiguity-program-currency-spark`; PDD §13, §14 locale warning.  
- 10: decisions.yaml `program-delivery-type`; PDD §14 connect\_delivery\_type, §15.3 connect-delivery-type-fit.  
- 11: pdd-to-deliver-app \[ACE\]; decisions.yaml `deliver-latitude-community-child-of-cbf`; PDD §5 / §6.  
- 12: pdd-to-deliver-app \[ACE\]; decisions.yaml `deliver-latitude-duplicate-enrolment-guard`; PDD §5.2.  
- 13: pdd-to-deliver-app \[ACE\]; decisions.yaml `deliver-latitude-education-options` (and the inherited `deliver-latitude-education-codes`); PDD §5.1.  
- 14: pdd-to-deliver-app \[ACE\]; decisions.yaml `deliver-latitude-derived-case-writes-only`; PDD §5.4 write-back; ace\#2006.  
- 15: pdd-to-deliver-app \[ACE\]; decisions.yaml `deliver-latitude-consent-scripts` (and the inherited `deliver-latitude-photo-consent-script`); PDD §5.2 / §7 / §7.3.  
- 16: pdd-to-deliver-app \[ACE\]; decisions.yaml `deliver-latitude-meeting-type-screen-order` (and the inherited `deliver-latitude-about-this-meeting-screen`); PDD §5.4 screens 2–5.  
- 17: pdd-to-deliver-app \[ACE\]; decisions.yaml `deliver-latitude-meeting-gps-optional`; PDD §5.4 screen 2 / §5.6.  
- 18: pdd-to-deliver-app \[ACE\]; decisions.yaml `deliver-latitude-date-bounds` (and the inherited `deliver-latitude-date-and-count-bounds`); PDD §5.  
- 19: pdd-to-deliver-app \[ACE\]; decisions.yaml `deliver-latitude-count-bounds`; PDD §5.4.  
- 20: pdd-to-deliver-app \[ACE\]; decisions.yaml `deliver-latitude-no-savings-on-other-record` (and the inherited `deliver-latitude-savings-on-held-meetings`); PDD §5.4 screen 10 / §5.5.  
- 21: pdd-to-deliver-app \[ACE\]; decisions.yaml `deliver-latitude-sedo-label-lowercase-ids` (and the inherited `deliver-latitude-sedo-label`, `deliver-latitude-field-id-case`); PDD §5.4 screen 9\.  
- 22: pdd-to-deliver-app \[ACE\]; decisions.yaml `deliver-latitude-step-display-labels` (and the inherited `deliver-latitude-step-labels-translatable`); PDD §6.1.  
- 23: decisions.yaml `learn-ambiguity-step-name-ampersand-verbatim`, `deliver-ambiguity-step-name-ampersand-verbatim`; PDD §6.1 / §14 entity\_state\_taxonomy \[FIXED\]. NOT listed under \[FIXED\] in this run's Learn memo ("None") or Deliver memo.  
- 24: pdd-to-learn-app \[ACE\]; decisions.yaml `learn-latitude-starting-quiz` (and the inherited `learn-latitude-baseline-pretest`); PDD §4.2; ace\#1131.  
- 25: pdd-to-learn-app \[ACE\]; decisions.yaml `learn-latitude-module-layout`; PDD §4.1.  
- 26: pdd-to-learn-app \[ACE\]; decisions.yaml `learn-latitude-high-consequence-items`; PDD §4.2.  
- 27: pdd-to-learn-app \[ACE\]; decisions.yaml `learn-latitude-illustrative-item` (and the inherited `learn-latitude-illustrative-item-hardened`); PDD §4.2.  
- 28: pdd-to-learn-app \[ACE\]; decisions.yaml `learn-latitude-module3-no-fiyp-video` (and the inherited `learn-latitude-module3-without-fiyp-video`); PDD §4.1; open question fiyp-media-assets.  
- 29: pdd-to-learn-app \[ACE\]; decisions.yaml `learn-latitude-pace-guidance` (and the inherited `learn-latitude-pace-marker`); PDD §6.  
- 30: pdd-to-learn-app \[ACE\]; decisions.yaml `learn-latitude-two-deliver-menus`; PDD §4.1 Module 3 / §5.  
- 31: pdd-to-learn-app \[ACE\]; decisions.yaml `learn-latitude-fictional-names` (and the inherited `learn-latitude-fictional-examples`); PDD §4.2.  
- 32: pdd-to-learn-app memo, "Residual owned by the operator" (Appendix C); PDD §4.2; open question assessment-item-rotation.  
- 33: Phase 3 residual (pdd-to-deliver-app-eval R1); NOT CITED by any Phase 3/4 producer section as a decision; carried in run\_state `phases.commcare-setup.residuals`.

**Moved here from the table — ACE's own test-harness choices:** decisions.yaml `test-scenario-count`, `test-archetype-coverage-rebuild`, `deliver-smoke-leg-structure`, `deliver-smoke-run-unique-keys-2208`, `date-picker-screen-scroll-method-rebuild`, `learn-smoke-long-lesson-walk` (app-test-cases).

**Rule-enforcement rows** (`connect-rule-*-spark`, 14 rows) are rendered in "Where each rule is enforced" above.

**Inherited rows not superseded.** This run was forked from 20260926-1800 at commcare-setup, and decisions.yaml still carries that run's Phase 3 rows next to this run's. Where an inherited row describes a superseded build, the table follows this run's producer sections. One example is `deliver-latitude-payability-discriminator` ("add meeting\_kind as 4th part"); this run's key uses the paid-slot marker instead. The inherited rows are listed in parentheses above.

### Appendix B — Deliver app build notes, verbatim

#### \[ACE\] latitudes taken

| PDD § | What ACE chose | Why |
| :---- | :---- | :---- |
| PDD §5 (three forms) / §5.4 | Committee meetings and meetings that did not happen are recorded in a separate unpaid **Other Meeting Record** (its own "Other meetings" menu), not on the paid Community Meeting Record | A rejected or unpaid record still counts against Connect's `max_daily` / `max_total`, so unpaid record kinds on the paid form would exhaust the 21-meeting cap around week 10 of 13 and push later paid meetings `over_limit` (ace\#2512). The PDD's verification predicate is unchanged and is enforced on the paid form by validation. This is a NAMED DEVIATION from the PDD's three-form list. Spot-check: Deliver app › Other meetings › Other Meeting Record. |
| PDD §3.2 / §14 entity\_id\_grain | `payable_slot` added as a fourth key component, with the same value carried in `entity_label` ("(not paid)") | The payability-scoped key and the Connect-side cap rule (ace\#2512, ace\#1434). The pinned grain `case_id-step-min(index,3)` is preserved, with the post-increment index. Spot-check: Deliver app › Community Meeting Record › entity\_key. |
| PDD §5 / §6 | `community` is a child case of `cbf`, and Community Enrolment is a follow-up on the worker's own facilitator record | A registration-only `cbf` menu would carry an unreachable case list (`case-list-unreachable`). The child link also records which CBF enrolled the community. Spot-check: Deliver app › Facilitator › Community Enrolment. |
| PDD §5.2 | Added a blocking duplicate-enrolment check on `community_id` | Spark's own Village Profile Form carries this check, and a second enrolment would create a second 3-per-step cap. It works on the device only; a duplicate across two CBFs' devices is caught in Layer B review. Spot-check: Deliver app › Community Enrolment › community\_id. |
| PDD §5.1 | Education options are none, primary, secondary, tertiary and university | The PDD lists "other" and asks for reconciliation with Spark's list. Spark's CF Registration Form has "university" and no "other" (the idea-to-pdd-eval WARN). Spot-check: Deliver app › Facilitator Registration › cbf\_education. |
| PDD §5.4 write-back | Only hidden derived mirrors are case-written | Nova preloads every case-written property, so writing `meeting_conducted` / `meeting_type` would pre-fill the payment fields on the next visit (ace\#2006). Spot-check: Deliver app › Community Meeting Record › total\_attendance. |
| PDD §5.2 / §7 (consent floor) | A read-aloud photo statement with an attestation (`photo_statement_read` must be yes), and a read-aloud call-consent script beside `contact_consents_to_calls` | Photographing an assembled group fires the consent-script floor even though the PDD declares no photo-consent field. Both scripts carry all six elements. Spot-check: Deliver app › Community Meeting Record › photo statement. |
| PDD §5.4 screens 2–5 | `meeting_type` is asked on the same screen as `meeting_conducted`, before the step display | It keeps the predicate fields together and fixable on one screen. The PDD lists the step display before the meeting type. Spot-check: Deliver app › Community Meeting Record › meeting. |
| PDD §5.4 screen 2 / §5.6 | `meeting_gps` is optional, not required | §5.6 says location is never a payment condition and nothing refuses a submission because of it. A missing fix sets `location_review_flag = yes` instead. Spot-check: Deliver app › Community Meeting Record › meeting\_gps. |
| PDD §5 (date bounds) | Recruitment date within 10 years; partnership date within 3 years; reschedule date within 60 days | The data-quality rule requires dates bounded on both sides, and the PDD states only the upper bounds. Spot-check: Deliver app › Facilitator Registration › cbf\_recruitment\_date. |
| PDD §5.4 (count bounds) | Attendance 0–1000 for each sex; leaders 0–50; people saving 0–2000; savings up to MWK 100,000,000 | The PDD bounds only households; these are plausibility caps above any 400-household community. Leader counts are not checked against attendance, because attendance sits on another screen (constraint locality). Spot-check: Deliver app › Community Meeting Record › meeting details. |
| PDD §5.4 screen 10 | No savings questions on the Other Meeting Record | The PDD's savings block belongs to the meeting record from Step 5\. Committee meetings moved to the unpaid form do not repeat it, so savings are reported only on held community meetings. Spot-check: Deliver app › Other Meeting Record. |
| PDD §5.4 screen 9 | The `SEDO_attendance` label is reworded to "staff or a trainer from the partner organisation", and the ids are lowercased (`sedo_attendance`, `sparktrainer_attendance`) | Spark's label names Malawi partner organisations the pilot may not use, and Nova ids must be lowercase. The predicate fields and every option code are exactly Spark's. Spot-check: Deliver app › Community Meeting Record › sedo\_attendance. |
| PDD §6.1 | The step is shown as seven conditional labels | A step name inside a hidden calculate cannot be translated; separate labels can carry nya and tum text. Spot-check: Deliver app › Community Meeting Record › step. |

#### \[FIXED\] ambiguities hit

| PDD § | The ambiguity | How resolved, or OPEN |
| :---- | :---- | :---- |
| PDD §14 entity\_id\_grain vs §3.2 / §7.1 | §14 pins an identity-only grain, `concat(case_id, step, min(index, 3))`, while §3.2 makes the 4th and later meetings on a step non-payable, and Connect pays a repeated key again with the duplicate flag off | Resolved by precedence (ace\#1434, `resolveEntityIdGrain`): the payability discriminator `payable_slot` is added to the key and to Phase 4's `form_field_rules`. The pinned components and their order are preserved. |

#### Other build-memo lines

- **GPS.** The 50 m target and the 2 km distance flag are ADVISORY, not enforced. Nova rejects `validate` on a geopoint, and Connect no longer carries GPS verification flags. Both feed review only, which matches PDD §5.6.  
- **Threshold coherence.** Each pair checked:  
  - **50 m accuracy vs 2 km review flag:** coherent; 2 km is far larger than two 50 m errors.  
  - **Households represented / saving vs enrolled households (1–400):** coherent. No form can update `number_of_households` after enrolment, so an enrolment typo caps every later meeting; that becomes a supervisor correction on HQ.  
  - **3 per step × 7 steps \= 21 vs about 13 expected:** coherent; the cap binds only if steps run long.  
  - **Daily limits, stated at their own scope:** the app's date check is PER COMMUNITY: one community meeting per community per day, and no back-filling a date earlier than the last recorded meeting. The per-WORKER daily limit of 1 is enforced only by Connect's payment unit `max_daily: 1`, not by the app. With one community per CBF the two coincide.  
- **Screen grouping:** `checkScreenShape` passed on 24 screens. The largest screen is "Who came and who spoke" with 5 answerable questions, kept together so that the speakers-vs-attendees checks fire where they can be fixed.  
- **Consent floor:** both scripts carry (a) purpose, (b) voluntary, (c) can opt out now or later, (d) no names attached and not public, (e) who sees it (implementing organisation supervisors, Spark MicroGrants, Dimagi), and (f) no payment or benefit, with staying out costing nothing. No field downstream of either answer is required on a "no".  
- **Case reads:** the paid form reads `#case/` values (Nova renders them `#community/`) for the step, the index, the enrolment date and the last-meeting values. Date comparisons are wrapped in `date()` with empty guards. The architect's precaution, not device-verified.  
- **Testing note:** to trace the 4-meeting cap in Preview, the architect saved revision 2 with the photo temporarily optional and restored it as required in revision 3\. Only revision 6 or later is ever uploaded.  
- **Language:** the app was built English-complete. nya and tum were added ACE-direct last (Step 4m): 232 units each, all `origin: ai`, `needs-review` until a native speaker reviews them. Tumbuka uses ŵ consistently; a step is "Gawo" in nya and "Sitepu" in tum.  
- **Phase 2 hand-off:** the PDD-checked meeting flow, the 3-per-step cap and the not-held branch (now on Other meetings) are the journeys `app-test-cases` binds.

### Appendix C — Learn app build notes, verbatim

#### \[ACE\] latitudes taken

| PDD § | What ACE chose | Why |
| :---- | :---- | :---- |
| PDD §4.2 | Added a 6-item non-gating Starting quiz alongside the 12-item gate | ACE's assessment-gate standard requires a baseline bank distinct from the gate. It carries `learn_module` only, never `connect.assessment`, so it cannot become an alternative unlock path (ace\#1131). Spot-check: Learn app › Before you start › Starting quiz. |
| PDD §4.1 | 8 modules: the six PDD modules, plus "Before you start" and "Final assessment" as their own modules | Keeps the baseline and the gate out of the teaching modules, so each Connect learn module maps 1:1 to a PDD module. Spot-check: Learn app › module list. |
| PDD §4.2 | The 5 high-consequence items are: enrol once, household count, photo, step-completed mistake, and no savings amounts when not saving | The PDD lists 9 candidate operations for 5 slots. The not-held branch and attendance-vs-participation are already covered by rule items q6 and q2. Lesson 1 content, the reschedule date, the location retry and "count on the day" are taught but not tested by the gate. Spot-check: Learn app › Final assessment › q8–q12. |
| PDD §4.2 | The illustrative committee-vs-community item was replaced by q1 ("Many leaders came and did important work. Is this meeting paid?") | The PDD says its example sets the shape only. The new stem makes the committee-not-paid rule, not arithmetic, decide the answer. Spot-check: Learn app › Final assessment › q1. |
| PDD §4.1 Module 3 | Module 3 stands alone without FIYP's "Running an Effective Meeting" video | No FIYP media asset is in inputs/ (open question fiyp-media-assets). Spot-check: Learn app › Recording a meeting › Lesson 3\. |
| PDD §6 | Pace guidance "about Step 4 after about 7 weeks" is taught as an on-track check (no longer tested: the Starting-quiz item was re-keyed by repair OP-8) | The PDD gives about 13 weeks for 7 steps but no mid-point marker; this is ACE's interpolation. Spot-check: Learn app › Steps and savings › Lesson 5\. |
| PDD §4.1 Module 3 / §5 | Lessons 3 and 6 teach two Deliver menus: Community meetings (held community meetings, the only paid record) and Other meetings (committee meetings, meetings that did not happen) | Follows the Deliver build's separate unpaid form (ace\#2512). The PDD describes one meeting record; the Learn app teaches the app the worker will actually use. Spot-check: Learn app › Recording a meeting › Lesson 3 › l3\_intro. |
| PDD §4.2 | Final-quiz items and examples use fictional names (Chikondi, Mphatso) | Teaching examples need a concrete subject; no real person or community is named. Spot-check: Learn app › Final assessment › q1, q7. |

#### \[FIXED\] ambiguities hit

None.

#### Framework gaps (Learn PDD §6(5))

Not a componentized programme — no framework gap list applies.

#### Language layer

Working languages are Chichewa (`nya`) and Tumbuka (`tum`), added ACE-direct at Step 4e after every English edit. Final `get_languages`: nya 196 units and tum 196 units; each 196 needs-review, 0 ready, 0 out-of-date, 0 missing (re-read after the repair save, revision 8). The translations are ACE-authored (`origin: ai`) and carry `needs-review` until a speaker of each language reviews them. 8 Connect learn-module names and descriptions stay single-language by Nova's design. A reconciliation pass aligned the Learn translations to the Deliver app's own translated menu names, form names, step names and Yes/No labels, so a worker sees the same words in both apps. English stays the runtime default.

#### Repairs applied

Pre-eval ACE-direct edits, not `repairs[]`: Lessons 3 and 6 English updated to name the two Deliver menus (revision 2), and the translation reconciliation to the Deliver wording (50 nya and 94 tum units, revision 7).

One round of `repairs[]` from `pdd-to-learn-app-eval` (8.5 pass, graded at revision 7; verdict fileId `12G2h0craYGYZQ-8exwoS5YRKnQGTaQNHpW_BPocymVQ`), applied at revision 8:

| repairs\[\] entry | Item touched | Change | Status |
| :---- | :---- | :---- | :---- |
| OP-7 Deliver menu routing (taught in Lessons 3 and 6, untested) | Final q6 (`045dfab4-…`) | Options re-keyed in place so they differ on WHERE the meeting is recorded as well as payability. Correct: "Record it in Other meetings, as not held, with the reason and a new date. It is not paid." Near-miss: "Record it in Community meetings, answer No…". Key stays `a`; option uuids retained. | applied |
| OP-8 consent to verification calls (taught in Lesson 2, untested) | Starting quiz q5 (`107114ff-…`), which was the consequence-free pace item | New stem: the contact person does not agree to confirmation calls. Correct: "The community stays in the pilot. It is only left out of the calls." Key stays `b`. | applied |
| OP-9 photo statement read aloud (neither taught nor tested) | Lesson 3: new screen `l3_photo_statement` (`839a3331-…`) before the photo; Final q10 (`9f7ae555-…`) hardened | Lesson 3 now teaches reading the photo statement aloud first and answering Yes only after reading it. q10 stem changed to "How do you take the meeting photo?" Correct (`d`): read the statement aloud first, then one wide photo during the meeting. Near-miss (`c`): photo first, statement after. Key stays `d`. | applied |

Read-back after the save: `q10_score` \= `if(#form/q10 = 'd', 1, 0)` and `user_score` still sums all 12 `#form/qN_score` refs; both answer keys are unchanged (final `d b a d c a c b b d a c`, starting `c a d a b c`), so the periodicity check still holds. The 14 English units demoted by these edits (plus the 1 new screen) were re-translated in nya and tum in the same work: final `get_languages` 196 units each, 0 out-of-date, 0 missing.

#### Assessment self-check (per item)

| Q | Rule | Module | Operation protected | Counter-intuitive | Independent | Option rejectable on sight |
| :---- | :---- | :---- | :---- | :---- | :---- | :---- |
| 1 | Committee meeting recorded, not paid | 6 (and 3\) | meeting type / payment | yes | yes | no |
| 2 | People who spoke can never exceed people who attended | 4 | speaker counts | yes | yes | no |
| 3 | 4th meeting on a step recorded, earns nothing | 6 | recording past the cap | yes | yes | no |
| 4 | Step read from the record, moves only on "Yes, completed" at a community meeting | 5 | step progress | yes | yes | no |
| 5 | No savings questions before Step 5 is correct | 5 | savings section | yes | yes | no |
| 6 | Meeting not held is recorded with a reason, not paid | 3, 6 | not-held branch | yes | yes | no |
| 7 | Paid per verified meeting, at most 1 a day | 6 | payment expectation | yes | yes | no |
| 8 | Check the list; enrol a community once | 2 | Community Enrolment | no | yes | borderline (c, "ask the contact person") |
| 9 | Households at enrolment \= the whole community | 2 | household count | yes | yes | no |
| 10 | One wide live photo during the meeting | 3 | meeting photo | no | yes | no |
| 11 | A wrong "step completed" goes to the supervisor | 5 | step-completed answer | yes | yes | no |
| 12 | Not saving: answer No, no amounts are asked | 5 | savings amounts | yes | yes | no |

Starting quiz (non-gating): q1 any record could be checked (L1), q2 "already registered" means stop (L2), q3 retry a poor location reading, which never blocks pay (L3), q4 count on the day (L4), q5 a contact who refuses calls keeps the community in the pilot (L2, repair OP-8), q6 at most 21 paid meetings (L6). Final q6 now also tests menu routing (OP-7) and q10 also tests reading the photo statement first (OP-9).

Residual owned by the operator: retakes are unlimited against a fixed bank (PDD §4.2 states this), so a worker could pass by memorising the answers.

### Appendix D — Connect setup notes, verbatim

#### Verification rules — where each is applied

| Rule (quoted) | PDD § | Where applied | Evidence |
| :---- | :---- | :---- | :---- |
| "meeting\_conducted \= yes" | §3.1, §7.1(1), §14 | Connect form\_field\_rules: meeting\_conducted=yes; also CCZ: Community Meeting Record / meeting\_conducted — constraint `. = 'yes'` | `form_field_rules_saved: 3`; released CCZ bind `/data/meeting/meeting_conducted` |
| "meeting\_type \= community\_meeting" | §3.1, §7.1(1), §14 | Connect form\_field\_rules: meeting\_type=community; also CCZ: Community Meeting Record / meeting\_type — constraint `. = 'community_meeting'` | `form_field_rules_saved: 3`; released CCZ bind `/data/meeting/meeting_type` |
| "at most 3 paid community meetings per community per FCAP step" | §3.2, §7.1(3), §14 entity\_id\_grain | Connect form\_field\_rules: payable\_slot=yes; also CCZ: Community Meeting Record / payable\_slot — calculate `step_meeting_index <= 3`, carried in entity\_key | `form_field_rules_saved: 3`; released CCZ bind `/data/step_info/payable_slot` |
| "the submitting CBF owns the community case" | §7.1(2) | CCZ: Community meetings case list — only the worker's own community cases are listed | Deliver summary: community is a child case of the CBF's own record |
| "a held community meeting dated after the community's previous one (one per community per day)" | §5.4 screen 2, §7.1(3) | CCZ: Community Meeting Record / date\_of\_meeting — constraint after last\_community\_meeting\_date | Deliver summary, screen 1 |
| "speakers ≤ attendees; households represented ≤ enrolled households" | §7.1(4), §5.4 | CCZ: Community Meeting Record / who came and who spoke — constraints | Deliver summary, screen 6 |
| "a live meeting photo present on every held meeting" | §7.1(4), §4.1 | CCZ: Community Meeting Record / attach\_a\_photo\_for\_the\_meeting — required, camera-only | Deliver summary, screen 5; app-hq-settings camera\_only applied |
| "every required field for the community's current step present" | §7.1(5) | CCZ: Community Meeting Record — required binds | Deliver summary |
| "at most 1 payable meeting per CBF per day" | §7.1(6), §10.1, §14 daily\_cap\_per\_flw | Connect payment unit max\_daily \= 1 (per worker); also CCZ: date\_of\_meeting check — per community | payment unit create response `max_daily: 1` |
| "total cap 21 per CBF" | §10.1, §14 total\_cap\_per\_flw | Connect payment unit max\_total \= 21 (per worker); also CCZ: payable\_slot — 3 per step × 7 steps, per community | payment unit create response `max_total: 21` |
| "location captured for review only, never a payment condition" | §5.6, §7.1 | Not configurable on Connect — applied in review (CCZ submits location\_review\_flag and distance from the community for Layer B) | Deliver summary, review-only fields |
| "no duplicate or GPS flags; de-duplication rides on entity\_id" | §14 verification\_flags | Not configurable on Connect — applied in the app's de-duplication key plus the Connect rule on the paid-slot field (Connect pays a repeated key again, ace\#2512) | no dead flags sent (ace\#1013) |
| "review covers ≥ 20% of paid meetings plus 10% of unpaid records, risk-stratified" | §7.2 | Not configurable on Connect — applied in the implementing organisation's review procedure (CCZ submits repeat\_counts\_flag to target it) | — |
| "confirmation calls for ≥ 10% of paid meetings in consenting communities" | §7.3 | Not configurable on Connect — applied in the supervisor's call procedure (consent captured at Community Enrolment) | Deliver summary: contact\_consents\_to\_calls |

#### \[ACE\] latitudes taken

| PDD § | Value ACE chose | Why |
| :---- | :---- | :---- |
| §10.1, §14 payment\_rate\_min/max \[PROPOSED\] | FLW amount MWK 7,500 per verified meeting | The band midpoint, the figure the PDD itself uses for per-CBF earnings. Replaced by the awarded rate. |
| §10.1, §14 llo\_payment\_per\_visit \[PROPOSED\] | Organisation amount MWK 3,000 per verified meeting | Taken as written; the PDD calls it a floor to be re-set from the responding organisation's costing. |
| §14 total\_budget \[PROPOSED\] | Opportunity budget MWK 3,276,000 | Taken as written (12 × 21 × (10,000 \+ 3,000)); funds 14.9 CBFs at the configured 7,500 rate. |
| §13, §14 opportunity dates \[PROPOSED\] | 2026-11-02 → 2027-02-26 | Taken as written; the start was not moved earlier to make Phase 6 test meetings payable (that would edit the design to satisfy a test, ace\#2427). |
| §10.1, §14 total\_cap\_per\_flw | `max_total` 21 and `max_daily` 1, not raised for over-cap records | At weekly cadence a CBF can record at most 17 community meetings in the 117-day window, below 21, so over-cap records never displace a paid one; raising `max_total` would remove the only per-worker 21 cap. |
| §13 program window | New program window 2026-10-01 → 2027-03-31 | The PDD names only the program end ("to 31 March 2027"); the start reproduces the source program so the spark copy matches what was reviewed. |

#### \[FIXED\] ambiguities hit

| PDD § | The ambiguity | How resolved, or OPEN |
| :---- | :---- | :---- |
| §14 verification\_flags vs §3.2 / §7.1(3) | §14 fixes two form-field rules (meeting\_conducted, meeting\_type), while §3.2 makes the 4th+ meeting on a step unpaid and Connect pays a repeated de-duplication key again | Resolved: a third rule `payable_slot = yes` was added on the field the Deliver app computes, so the cap is enforced on Connect. |
| §14 "Locale warning for Phase 4" | The PDD says the durable program is USD and Phase 4's reuse check will stop | Resolved: this spark copy creates a fresh MWK / MWI program in spark-pm-org-test, so there is no USD program in play. |

### Appendix E — Completeness

| Input | Status | If not present |
| :---- | :---- | :---- |
| `3-commcare/pdd-to-deliver-app_summary.md` § Build memo | present | — |
| `3-commcare/pdd-to-learn-app_build-memo.md` (incl. Framework gaps, Learn PDD §6(5)) | present — states "Not a componentized programme — no framework gap list applies." | — |
| `4-connect/connect-opp-setup.md` § Build memo — opportunity configuration and verification | present — 14 rule rows, every `Where applied` cell stated | — |
| `decisions.yaml` rows, phases 3-commcare / 4-connect | present (live rows used; superseded rows skipped — this rebuild's Phase 4 rows carry the `-spark` suffix and supersede the source run's `-2208` rows) | — |
| PDD set — sentence naming the build memo | absent by design: this PDD (single, not componentized) does not name a build memo; the memo is composed on every run regardless | — |

