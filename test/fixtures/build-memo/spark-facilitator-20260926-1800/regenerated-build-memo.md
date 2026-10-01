# Build memo — Spark Facilitator · run 20260926-1800

This memo explains what was built for this programme, what you need to decide, and where to check the build. It is written so you can review it without opening the apps first, then spot-check the places it names.

This memo describes run 20260926-1800, which was started as a copy (fork) of run 20260925-1536, re-running from the demo data step onward. The apps and the Connect setup described here were built in that run and copied over unchanged.

**Where to find things:** [Learn app](https://www.commcarehq.org/a/connect-ace-prod/apps/view/cc3aaedcfa9a47729873d4915e12d226/); [Deliver app](https://www.commcarehq.org/a/connect-ace-prod/apps/view/0d877e0f7bc14382b34f4a843803ca0a/); [Connect opportunity](https://connect.dimagi.com/a/ai-demo-space/opportunity/d5deee9b-e32e-4fae-81dd-a9a11d393f50/) — named "20260925-1536 · Spark Facilitator — FCAP Community Meeting Facilitation" (a test opportunity, status active); [Connect programme](https://connect.dimagi.com/a/ai-demo-space/program/9e82982e-7638-44bc-9de2-2bfcefae550d/).

**Terms:** CBF — Community Based Facilitator; FCAP — Facilitated Collective Action Process.

## Known limitations — read first

**Not enforced anywhere yet — real gaps.** These are rules the design requires that nothing in this build enforces. Connect saved 0 of the 2 verification rules the design asks it to hold.

- "meeting_conducted = yes" and "meeting_type = community_meeting" — Connect refused to save verification rules on this opportunity, because it is managed by the same organisation that runs the programme; Connect only accepts them on an opportunity run by a separate implementing organisation. Until this is fixed, Connect treats every submitted record as payable work, up to the per-worker payment limits — including records these rules should exclude.

**Checked outside Connect by design — not gaps.** The design itself places these off the platform:

- "Location is captured and submitted for review only … not a payment condition" — the app review flags, advisory only.
- "No duplicate or GPS flags (not available on Connect) — de-duplication rides on entity_id" — the app de-duplication key.
- "Review covers at least 20% of paid meetings, plus 10% of unpaid records" — the implementing organisation's review procedure.
- "at least 10% of paid meetings … a supervisor … phones the community's primary contact" — the implementing organisation's call procedure.

## Decisions you own

These are yours to make; the build could not settle them. Each is explained further down.

1. **Accept or replace the worker payment of 7,500 MWK per verified community meeting.** The design proposes 5,000–10,000 MWK; the build uses 7,500 as a placeholder. Connect pays whatever figure is set here.
2. **Confirm the payment to the implementing organisation of 3,000 MWK per verified community meeting.** The design marks it as proposed, not agreed.
3. **Confirm the total budget of 3,276,000 MWK.** The design marks it as proposed; the Connect opportunity was created with this figure.
4. **Confirm the delivery dates, 2026-11-02 to 2027-02-26.** The design marks them as proposed. Workers earn nothing for work recorded before the start date.
5. **Decide how "meeting_conducted = yes" and "meeting_type = community_meeting" will be enforced before any worker is paid.** Connect cannot hold them on this opportunity (see Known limitations). The way forward the build recorded: set these rules on the implementing organisation's own opportunity at launch — or have Connect changed so this opportunity can hold them. This must be settled before launch.
6. **Have a native speaker review the machine-translated Chichewa and Tumbuka text in both apps, and sign it off.** The translations were produced by AI and have not been reviewed by a speaker. The apps open in English; a worker who switches language sees the unreviewed text.

## Where each rule is enforced

Each rule is quoted from the design. "Applies to" is the rule's scope; the enforcement named first is the one that actually holds it at that scope.

| # | Rule (from the design) | Applies to | Enforced by |
|---|---|---|---|
| 1 | "meeting_conducted = yes" | each record | **Not enforced** — see Known limitations |
| 2 | "meeting_type = community_meeting" | each record | **Not enforced** — see Known limitations |
| 3 | "The submitting CBF owns the community case" | each record | A check in the app |
| 4 | "each community earns at most 3 paid meetings per FCAP step" | each community | A check in the app (per community) |
| 5 | "a held community meeting must carry a date later than the community's last recorded community meeting" | each record | A check in the app |
| 6 | "Speakers ≤ attendees (men and women separately); households represented ≤ enrolled households" | each record | A check in the app |
| 7 | "a live meeting photo present on every held meeting" | each record | A check in the app |
| 8 | "Every required field for the community's current step present" | each record | A check in the app |
| 9 | "At most 1 payable meeting per CBF per day" | each worker | Connect payment limit — pays at most 1 per worker per day. Also: A check in the app (per community) |
| 10 | "total cap 21 per CBF" | each worker | Connect payment limit — pays at most 21 per worker in total. Also: A check in the app (per community) |
| 11 | "Location is captured and submitted for review only … not a payment condition" | each record | Outside Connect, by design: the app review flags, advisory only |
| 12 | "No duplicate or GPS flags (not available on Connect) — de-duplication rides on entity_id" | each record | Outside Connect, by design: the app de-duplication key |
| 13 | "Review covers at least 20% of paid meetings, plus 10% of unpaid records" | each record | Outside Connect, by design: the implementing organisation's review procedure |
| 14 | "at least 10% of paid meetings … a supervisor … phones the community's primary contact" | each record | Outside Connect, by design: the implementing organisation's call procedure |

## What was built, and the choices the build made

The build produced two mobile apps and one Connect opportunity:

- a **Learn app** (training and the 12-question qualifying test), released as version 22;
- a **Deliver app** (facilitator registration, community enrolment, and the record of each community meeting), released as version 14;
- a **Connect opportunity**, marked as a test opportunity, with one payment line: 7,500 MWK to the worker and 3,000 MWK to the implementing organisation for each verified community meeting, at most 1 per worker per day and 21 per worker in total, running 2026-11-02 to 2027-02-26 with a budget of 3,276,000 MWK.

Where the design left a choice to the build, or said something that could not be built exactly as written, the build chose as follows. Each row says where to look and what correct looks like.

| # | What the build chose, and why | Where to check | What correct looks like |
|---|---|---|---|
| 1 | Each community is recorded under the facilitator who enrols it, so a facilitator only ever sees and records meetings for their own communities. | Deliver app → Facilitator → Community Enrolment | After enrolling a community, it appears only on that facilitator's meeting list. |
| 2 | Enrolling the same community twice on one phone is blocked, as in Spark's own village form. Two different facilitators' phones cannot see each other, so a duplicate across phones is left to the review step. | Deliver app → Community Enrolment, enter a community ID already used | A warning appears and the form cannot be saved. |
| 3 | Date, "was the meeting held?", meeting type and location are asked together on one "About this meeting" screen, slightly re-ordered from the design's screen list, so the date check sits on the screen that can fix it. | Deliver app → Community Meeting Record, first screen | The four questions appear together, date first. |
| 4 | A not-held meeting and a committee meeting are kept apart from community meetings in the payment key, so they can never use up a community's three paid meetings for a step. The design's 3-per-step limit is unchanged. | Deliver app → record a committee meeting, then a community meeting on the same step | The community meeting is still counted as the first paid meeting on that step. |
| 5 | The app never pre-fills the "held?" and "meeting type" answers from the previous visit, so a worker cannot re-file a past meeting by tapping through. | Deliver app → open a second meeting for the same community | Both questions start blank. |
| 6 | Education options are Spark's five (none, primary, secondary, tertiary, university), with no "other". | Deliver app → Facilitator Registration → education | Exactly those five options. |
| 7 | Before the group photo, the worker reads a short consent statement aloud and confirms they did; a similar script is read before asking for phone-call consent. | Deliver app → Community Meeting Record → photo screen | The statement shows, and the photo cannot be taken until the worker confirms it was read. |
| 8 | Spark's question about partner staff attending is reworded to "staff or a trainer from the partner organisation", because the named Malawi partners may not be part of the pilot. | Deliver app → Community Meeting Record → who ran the meeting | The reworded question. |
| 9 | Dates and counts have lower and upper limits the design did not state (for example recruitment within the last 10 years; attendance 0–1,000 per sex). | Deliver app → enter an out-of-range value | The form refuses it with a message. |
| 10 | The savings questions appear for any held meeting from Step 5 on, community or committee. | Deliver app → a held meeting at Step 5 | The savings questions appear. |
| 11 | FCAP step names are shown exactly as Spark writes them, including "&", and are translated. | Deliver and Learn apps → a meeting at Step 2 | "Community Dynamics, Governance & Leadership". |
| 12 | The Learn app has 8 parts: the six training modules, plus a short practice quiz at the start and the qualifying test at the end. The practice quiz does not count towards qualifying. | Learn app → module list | Eight modules; only the final test unlocks delivery work. |
| 13 | The qualifying test's five "high-consequence" questions cover enrolling once, household counts, the photo, honest step completion and savings amounts. Two rules — the reschedule date and "count on the day" — are taught but not tested. | Learn app → Final assessment | Those five topics among the 12 questions. |
| 14 | The training on running a meeting stands alone, without Spark's "Running an Effective Meeting" video, because the video was not provided. | Learn app → Recording a meeting | No video; the lesson reads on its own. |
| 15 | Training says a community should reach about Step 4 after about 7 weeks — the build's interpolation from the design's ~13 weeks for 7 steps. | Learn app → Steps and savings | That guidance, phrased as an on-track check. |
| 16 | Worked examples use invented names ("Grace", "Kalumbu village"). | Learn app → lessons and test | No real person or community is named. |
| 17 | Spark's Connect programme was created new, in Malawi kwacha, because the existing programme was in US dollars and a programme's currency cannot change. The dollar programme is left in place, unused. | Connect → programme page | Currency MWK. |
| 18 | The programme runs 2026-10-01 to 2027-03-31, to hold the solicitation, the delivery window and the closeout; its budget ceiling is 32,760,000 MWK, ten times one opportunity's budget. | Connect → programme page | Those dates and that ceiling. |

**Things the build team flagged for you to know** (not decisions, but worth a look):

- Location is recorded for review only: a fix worse than 50 metres, or more than 2 km from the community, is flagged for review, never refused. This matches the design.
- Workers can retake the qualifying test as often as they like against the same questions, as the design allows, so a worker could pass by memorising answers. On four questions the right answer is also the longest option.
- The Chichewa and Tumbuka text is complete but unreviewed (decision 6 above); the build team noticed about 12 Tumbuka strings spell one letter inconsistently.
- Until 2026-11-02, the opportunity's start date, no work earns payment, by design.
- The test login the build created for checking the apps has been invited but has not yet accepted.

## Appendix — references for the build team

- Run: spark-facilitator/20260926-1800 (forked from 20260925-1536 at synthetic-data-and-workflows)
- Connect verification: form_field_rules_saved: 0; not_applied_reason: connect_set_verification_flags refused: /verification_flags_config/ 302-redirects on a self-managed opp (Connect is_opportunity_pm requires requesting org != holding org) — ace#2419. Intended rules: form.about_this_meeting.meeting_conducted=yes, form.about_this_meeting.meeting_type=community_meeting on DU 7083. Carried to Phase 9 (LLO opportunity).
- Decision 1 sources: program_parameters.payment_rate_band, connect-latitude-payment-amount
- Decision 2 sources: program_parameters.llo_payment_per_visit
- Decision 3 sources: program_parameters.total_budget, connect-latitude-program-budget-ceiling
- Decision 4 sources: program_parameters.opportunity_start_date, opportunity-end-date, connect-latitude-opportunity-dates
- Decision 5 sources: phase4-table, connect-ambiguity-form-field-rules-unreachable
- Decision 6 sources: program_parameters.working_language: nya, program_parameters.working_language: tum
- Gap "meeting_conducted = yes": phase4-table
- Gap "meeting_type = community_meeting": phase4-table
- By design "Location is captured and submitted for review only … not a payment condition": phase4-table
- By design "No duplicate or GPS flags (not available on Connect) — de-duplication rides on entity_id": phase4-table
- By design "Review covers at least 20% of paid meetings, plus 10% of unpaid records": phase4-table
- By design "at least 10% of paid meetings … a supervisor … phones the community's primary contact": phase4-table
- Scope corrected from the producer: "At most 1 payable meeting per CBF per day": the producer credited "CCZ: date_of_meeting one-community-meeting-per-day check" first; corrected to the Connect payment unit limit (per worker), with the app check kept as per-community support.
- Scope corrected from the producer: "total cap 21 per CBF": the producer credited "CCZ: per-step clamp (7 × 3)" first; corrected to the Connect payment unit limit (per worker), with the app check kept as per-community support.

### Appendix B — Deliver app build notes, verbatim

*From `3-commcare/pdd-to-deliver-app_summary.md` § Build memo, verbatim.*



#### [ACE] latitudes taken


| PDD § | What ACE chose | Why |
|---|---|---|
| PDD §5 / §6 | `community` is a child case of `cbf`; Community Enrolment is a followup on the worker's own facilitator record that creates it | A registration-only `cbf` menu would carry an unreachable case list (`case-list-unreachable` BLOCKER); the child link also records which CBF enrolled the community. Spot-check: Deliver app › Facilitator › Community Enrolment. |
| PDD §5.2 (Phase 2 flag a) | Added a blocking duplicate-enrolment check on `community_id` | Spark's own Village Profile Form carries exactly this check (`community_warning`, casedb count on `community_id`); a second enrolment would mint a second 3-per-step cap. Device-local only — a duplicate across two CBFs' devices is caught in Layer B. Spot-check: Deliver app › Facilitator › Community Enrolment › community_warning. |
| PDD §5.4 screens 2/3/5 | Date, held?, meeting type and location on one screen ("About this meeting"), in the order date, held?, type, location | Keeps the one-community-meeting-per-day date check local to the screen that can fix it. This MOVES meeting type ahead of the step display and location after the held/not-held question relative to the PDD screen list. Spot-check: Deliver app › Community meetings › Community Meeting Record › date_of_meeting. |
| PDD §3.2 / §14 entity_id_grain | Added `meeting_kind` as a fourth key component | Payability-scoped key: a committee or not-held record must not share the payable key space (ace#969). The pinned three components and the cap are unchanged. Spot-check: Deliver app › Community Meeting Record › entity_key. |
| PDD §5.4 write-back | Case-write only hidden derived mirrors, never raw answers | Nova preloads every case-written property; writing `meeting_conducted` / `meeting_type` would pre-fill the payment fields on the next visit (ace#2006). Spot-check: Deliver app › Community Meeting Record › new_step … new_total_participation. |
| PDD §5.1 | Education options are Spark's five codes (none, primary, secondary, tertiary, university) | The PDD asks for the list to be reconciled with Spark's; Spark's CF Registration Form has no "other". Spot-check: Deliver app › Facilitator Registration › cbf_education. |
| PDD §4.1 / §7 (consent floor) | Read-aloud photo statement with an attestation (`photo_statement_read` must be yes) and a read-aloud call-consent script | Photographing an assembled group fires the consent-script floor even though the PDD declares no photo-consent field; both scripts carry all six elements. Spot-check: Deliver app › Community Meeting Record › photo_statement. |
| PDD §5.1 / §5.4 | Field ids lowercased (`sparktrainer_attendance`, `sedo_attendance`, `currently_not_saving`, `district`); stored option codes verbatim | Nova ids must be lowercase snake_case; the verification predicate fields (`meeting_conducted`, `meeting_type`) and all option codes are exactly Spark's. Spot-check: Deliver app › Community Meeting Record › meeting_details. |
| PDD §5.4 screen 9 | `SEDO_attendance` label reworded to "staff or a trainer from the partner organisation" | Spark's label names Malawi partner orgs (AFES/SPRODETA/Njira/Soff) the pilot may not use. Spot-check: Deliver app › Community Meeting Record › sedo_attendance. |
| PDD §5 (date bounds) | Recruitment date within 10 years; partnership date within 3 years; reschedule within 60 days | Data-quality rule requires two-sided dates; the PDD states only the upper bounds. Spot-check: Deliver app › Facilitator Registration › cbf_recruitment_date. |
| PDD §5.4 (count bounds) | Attendance 0–1000 per sex; leaders 0–50; people saving 0–2000; savings ≤ MWK 100,000,000 | The PDD bounds only households; the rest are plausibility caps above any 400-household community. Spot-check: Deliver app › Community Meeting Record › who_came. |
| PDD §5.4 screen 10 | Savings block shown for any HELD meeting at Step 5+ (community or committee) | The PDD gates on step only; not-held records skip it. Spot-check: Deliver app › Community Meeting Record › savings. |
| PDD §5.4 screen 4 | Step shown as seven conditional labels, not a computed name | A step name inside a hidden calculate cannot be translated; separate labels carry nya/tum text. Spot-check: Deliver app › Community Meeting Record › step_display…step_display_7. |


#### [FIXED] ambiguities hit


| PDD § | The ambiguity | How resolved, or OPEN |
|---|---|---|
| PDD §6.1 / §14 entity_state_taxonomy | Step labels are verbatim, but the build rule banned "&" from label text | First built with "and"; `pdd-to-deliver-app-eval` hard-gated it (entity_state_fidelity BLOCKER). Restored verbatim ("Governance & Leadership", "Microgrant Pathway & Goals", "Initiative Pathway & Savings") in step labels, `step_name` and the case-list enum; HQ build v14 carries `&amp;` and parses — the ban had no reproducer (ace#2150, PR #2481). |


#### Other build-memo lines


- **GPS:** the 50 m accuracy target and the 2 km distance flag are ADVISORY, not enforced — Nova rejects `validate` on a geopoint and Connect no longer carries GPS verification flags. Both feed review only (PDD §5.6 says the same).
- **Threshold coherence:** 2 km distance flag vs 50 m accuracy — coherent (2 km ≫ two 50 m errors); households represented / households saving ≤ enrolled households (1–400) — coherent; cap 3 per step × 7 steps = 21 vs ~13 expected — coherent; daily cap 1 vs the one-community-meeting-per-day date check — coherent.
- **Screen grouping:** "Who came and who spoke" 5 (one counting task); "Meeting details" up to 6 (who ran and joined); "Savings" up to 6 for a saving community (one topic, savings as of today); "About this meeting" 4 (identifies the encounter; every check there is local).
- **Consent floor:** photo statement and call script both carry (a) purpose, (b) voluntary, (c) opt out later, (d) name not attached / not public, (e) who sees it (organisation supervisor, Spark and Dimagi, automatic computer check), (f) no payment or benefit, staying out costs nothing. Nothing downstream of the call-consent answer depends on it.
- **Casedb reads:** the form reads `#case/` values (Nova renders them `#community/`) for step, index, enrolment date and last-meeting values; verified in Nova Preview. Released-CCZ confirmation is `app-release-qa`'s job.
- **Language:** English-complete; nya + tum added ACE-direct last (Step 4m), 202 units each, `origin: ai`, `needs-review`. Tumbuka ŵ spelling is inconsistent in about 12 strings — for native review.

### Appendix C — Learn app build notes, verbatim

*From `3-commcare/pdd-to-learn-app_build-memo.md`, verbatim (includes the Learn PDD §6(5) framework-gap statement).*



Authored in run 20260925-1536 (this run was copied from it) · Nova app `c57ad3f2-9524-4470-949b-fc02cbaf3810`


### [ACE] latitudes taken


| PDD § | What ACE chose | Why |
|---|---|---|
| PDD §4.2 | Added a 6-item non-gating starting quiz alongside the 12-item gate | ACE's assessment-gate standard requires a baseline bank distinct from the gate; it carries `learn_module` only, never `connect.assessment`, so it cannot become an alternative unlock path. Spot-check: Learn app › Before you start › Starting quiz. |
| PDD §4.1 | 8 modules: the six PDD modules plus "Before you start" and "Final assessment" as their own modules | Keeps the baseline and the gate out of the teaching modules so each Connect learn module maps 1:1 to a PDD module. Spot-check: Learn app › module list. |
| PDD §4.2 | The 5 high-consequence items chosen: enrol once, household count, photo, step-completed honesty, savings amounts | The PDD lists 9 candidate operations for 5 slots; the not-held branch and attendance-vs-participation are already covered by rule items q4/q5. The reschedule-date rule and "count on the day" are taught but not tested by the gate. Spot-check: Learn app › Final assessment › q1–q3, q7, q9. |
| PDD §4.2 | Hardened the illustrative committee-vs-community item (q10 adds "the Spark trainer is there" to the committee meeting) | The PDD states its example is shape-only; the added detail makes the committee-not-paid rule, not arithmetic, decide the answer. Spot-check: Learn app › Final assessment › q10. |
| PDD §4.1 Module 3 | Module 3 stands alone without FIYP's "Running an Effective Meeting" video | No FIYP media asset is in inputs/ (open question fiyp-media-assets). Spot-check: Learn app › Recording a meeting › Lesson 3. |
| PDD §6 | Pace guidance "about Step 4 after about 7 weeks" taught as an on-track check | The PDD gives ~13 weeks for 7 steps (≈1.9 meetings per step) but no mid-point marker; this is ACE's interpolation. Spot-check: Learn app › Steps and savings › Lesson 5. |
| PDD §4 | Worked examples use fictional names (CBF "Grace", "Kalumbu village", "Chikondi") | Teaching examples need a concrete subject; no real person or community is named. Spot-check: Learn app › Lesson 3 and Final assessment q2, q10. |


### [FIXED] ambiguities hit


| PDD § | The ambiguity | How resolved, or OPEN |
|---|---|---|
| PDD §6.1 / §14 entity_state_taxonomy | Step names are to be used verbatim, but three contain "&", which the build rule banned from label text | First built with "and"; `pdd-to-deliver-app-eval` hard-gated the same rewrite in the Deliver app, so "&" was restored verbatim in both apps. HQ built it (`&amp;` in the XForm) — the ban had no reproducer (ace#2150, fixed in PR #2481). Spot-check: Learn app › Steps and savings › Lesson 5 › steps_list. |


### Framework gaps (Learn PDD §6(5))


Not a componentized programme — no framework gap list applies.


### Language layer


Working languages Chichewa (`nya`) and Tumbuka (`tum`), added ACE-direct at Step 4e after every English edit. Final `get_languages`: nya 320 units, tum 320 units; each 320 needs-review, 0 ready, 0 out-of-date, 0 missing, 0 left origin:copied. The translations are ACE-authored (`origin: ai`) and carry `needs-review` until a speaker of each language reviews them; Tumbuka is the lower-confidence of the two. English stays the runtime default.


### Repairs applied


One round, from `pdd-to-learn-app-eval` (8.5 pass, graded before the repair):


| repairs[] entry / warning | Item touched | Change | Status |
|---|---|---|---|
| Uncovered rule "a facilitator registers once" (repairs[] suggested_target: Starting quiz q1) | Starting quiz q1 (`a7e06c79-…`) | Re-keyed to the already-registered warning: correct answer "Stop. You register only once, before your first meeting." Correct letter stays `b`; pre-test key `b d a c a d` (still not periodic). `q1_score` re-read: field-ref intact | applied |
| Warning: Lesson 1 said people review EVERY record (PDD §7.2 is a sample) | Lesson 1 `review_1` (`8b377387-…`) | Now "People check a sample of records. At least 1 in 5 paid meetings gets an independent check, and any record could be checked" | applied |


Six units per language were demoted by these edits and re-translated; nya and tum are back to 320/320, 0 out-of-date, 0 missing. The gating bank is unchanged, so the eval's gate findings stand; the eval was not re-run for this non-gating repair.


### Assessment self-check (per item)


| Q | Rule | Module | Operation protected | Counter-intuitive | Independent | Option rejectable on sight |
|---|---|---|---|---|---|---|
| 1 | Enrol a community once; check the list first | m2 | duplicate community record / second pay cap | yes | yes | no |
| 2 | Enrol the whole community's households | m2 | households-represented check | yes | yes | borderline ("400", "1 for now") |
| 3 | One wide live photo during the meeting | m3 | photo review | partly | yes | no |
| 4 | Not-held meeting recorded with reason, not paid | m3/m6 | not-held branch | yes | yes | no |
| 5 | Count people who spoke, never more than attendees | m4 | participation counts | yes | yes | no |
| 6 | Step read from record, moves only on "completed" | m5 | step progression | yes | yes | no |
| 7 | Wrong "completed" answer goes to the supervisor | m5 | step-completed answer | yes | yes | no |
| 8 | No savings questions before Step 5 is correct | m5 | false bug reports | yes | yes | no |
| 9 | Savings amounts only when saving | m5 | savings data | partly | yes | no |
| 10 | Committee meeting recorded, not paid | m6 | meeting type / payment | yes | yes | no |
| 11 | 4th meeting on a step recorded, not paid | m6 | per-step cap | yes | yes | no |
| 12 | Paid per meeting, max 1 per day | m6 | same-day sessions | yes | yes | no |


Residual owned by the operator: retakes are unlimited against a fixed bank (PDD §4.2 states this), so a worker could pass by memorising answers. On q1, q5, q6 and starting-quiz q1 the correct option is the longest, which a guesser could exploit.

### Appendix D — Connect setup notes, verbatim

*From `4-connect/connect-opp-setup.md` § Build memo — opportunity configuration and verification, verbatim.*


#### Verification rules — where each is applied

| Rule (quoted) | PDD § | Where applied | Evidence |
|---|---|---|---|
| "meeting_conducted = yes" (verification predicate, clause 1) | §3.1, §7.1(1), §14 | Not configurable on Connect — not applied anywhere in this build | `connect_set_verification_flags` refused: `/verification_flags_config/` 302s on a self-managed opp (ace#2419); `form_field_rules_saved: 0`. CCZ routes not-held records to `meeting_kind = not_held` (own entity_key space) but they still carry the deliver block. Must be set on the Phase 9 LLO opportunity: `form.about_this_meeting.meeting_conducted = yes`, DU community_meeting. |
| "meeting_type = community_meeting" (verification predicate, clause 2) | §3.1, §7.1(1), §14 | Not configurable on Connect — not applied anywhere in this build | Same refusal (ace#2419). CCZ keys committee meetings under `meeting_kind = committee_meeting`; still minted as work on this opp. Phase 9: `form.about_this_meeting.meeting_type = community_meeting`. |
| "The submitting CBF owns the community case" | §7.1(2) | CCZ: Community meetings menu — case list shows only the CBF's own `community` cases (child of their `cbf` case) | Deliver summary § Structure; community created as child of the worker's `cbf` case. |
| "each community earns at most 3 paid meetings per FCAP step" (entity_id de-dup) | §3.2, §7.1(3), §14 `entity_id_grain` | CCZ: Community Meeting Record / entity_key — `concat(case_id, '-', pilot_fcap_step, '-', capped_index, '-', meeting_kind)`, `capped_index = min(stored_index + 1, 3)`; Connect de-duplicates on `deliver/entity_id` | Released CCZ binds lines 147–149, 214; clamp verified (ace#2480 hand trace, indices 1,2,3,3). |
| "a held community meeting must carry a date later than the community's last recorded community meeting" | §5.4 screen 2, §7.1(3) | CCZ: Community Meeting Record / date_of_meeting — constraint `. > last_community_meeting_date` for held community meetings | Released CCZ bind line 138. |
| "Speakers ≤ attendees (men and women separately); households represented ≤ enrolled households" | §7.1(4), §5.4 | CCZ: Community Meeting Record / who_came — constraints | Deliver summary § screens 5. |
| "a live meeting photo present on every held meeting" | §7.1(4), §4.1 | CCZ: Community Meeting Record / attach_a_photo_for_the_meeting — `required="true()"`, `appearance="acquire"` (camera-only) | Released CCZ bind line 170, upload line 1466; app-hq-settings camera_only applied. |
| "Every required field for the community's current step present" | §7.1(5) | CCZ: required binds across the Community Meeting Record | Deliver summary § Checks 4a/4g. |
| "At most 1 payable meeting per CBF per day" | §7.1(6), §10.1, §14 `daily_cap_per_flw` | CCZ: date_of_meeting one-community-meeting-per-day check; also Connect payment unit `max_daily = 1` | PU create response `max_daily: 1`. |
| "total cap 21 per CBF" | §14 `total_cap_per_flw`, `cap_rationale` | CCZ: per-step clamp (7 × 3); also Connect payment unit `max_total = 21` | PU create response `max_total: 21`. |
| "Location is captured and submitted for review only … not a payment condition" | §5.6, §14 `verification_flags` | Not configurable on Connect — applied in CCZ review flags (`location_review_flag`, `distance_from_community_m`), advisory only | PDD itself excludes it from payment; Connect has no GPS flag (ace#1013). |
| "No duplicate or GPS flags (not available on Connect) — de-duplication rides on entity_id" | §14 `verification_flags` | Not configurable on Connect — applied in CCZ entity_key (see row 4) | None sent to `connect_set_verification_flags`. |
| "Review covers at least 20% of paid meetings, plus 10% of unpaid records" (Layer B) | §7.2 | Not configurable on Connect — applied in the implementing organisation's review procedure (Phase 9 / training) | No Connect surface; `repeat_counts_flag` + location flags submitted to target the sample. |
| "at least 10% of paid meetings … a supervisor … phones the community's primary contact" (Layer C) | §7.3 | Not configurable on Connect — applied in the implementing organisation's call procedure | `contact_consents_to_calls` captured at enrolment (CCZ). |

#### [ACE] latitudes taken

| PDD § | Value ACE chose | Why |
|---|---|---|
| §10.1, §14 `payment_rate_min/max` [PROPOSED] | FLW `amount` = **7,500 MWK** per verified meeting | Connect needs one integer; the band midpoint is the figure the PDD itself uses for per-CBF earnings (§10.1). Placeholder until the awarded rate replaces it. Spot-check: Connect › opportunity › payment units › amount. |
| §13, §14 `opportunity_start_date/end_date` [PROPOSED] | Opportunity 2026-11-02 → 2027-02-26 (PDD dates, not today) | Moving the start date to make Phase 6 payable would edit the programme's contract to satisfy a test (app-screenshot-capture ace#2427). Consequence: Deliver credit is structurally 0 until 2026-11-02. Spot-check: Connect › opportunity › start/end date. |
| §13 (program window) | Program 2026-10-01 → 2027-03-31 | Contains the solicitation (early Oct), the opportunity window and the March 2027 closeout; the PDD names only "to 31 March 2027". Spot-check: Connect › program › dates. |
| §14 `total_budget`, skill Step 4a | Program ceiling 32,760,000 MWK (10 × the per-opp 3,276,000) | Program is a cross-run ceiling for every build run of this opp; Σ over its opps was 0 at creation. Spot-check: Connect › program › budget. |
| §1 archetype | Program name "Spark FCAP Facilitation — Malawi Follow-Up Study (MWK)" | `longitudinal-visits` naming; "(MWK)" distinguishes it from the superseded USD program of near-identical name. Spot-check: Connect › program › name. |

#### [FIXED] ambiguities hit

| PDD § | The ambiguity | How resolved, or OPEN |
|---|---|---|
| §14 `verification_flags` / §7.1(1) | The PDD fixes `form_field_rules: meeting_conducted = yes; meeting_type = community_meeting`, but Connect will not serve the rules page for ACE's self-managed build opportunity | OPEN — not applied on this opp (ace#2419); must be applied on the Phase 9 LLO opportunity, or the capability decision in ace#2419 made. |
| §14 locale warning, `opportunity_currency: MWK` | The durable program was USD while the design is fixed in MWK; currency cannot change after creation | Resolved by operator decision `program-currency-usd-vs-mwk` (jjackson@dimagi.com, 2026-09-26): new MWK program `9e82982e`; USD program `a115e4f2` left in place, superseded. |

### Appendix E — Completeness

| Input | Status | If not present |
|---|---|---|
| 3-commcare/pdd-to-deliver-app_summary.md (## Build memo) | present | — |
| 3-commcare/pdd-to-learn-app_build-memo.md | present | — |
| 4-connect/connect-opp-setup.md (## Build memo — opportunity configuration and verification) | present | — |
| decisions.yaml (phases 3-commcare, 4-connect) | present (55 rows) | — |
| PDD set (sentence naming a build memo) | present — no PDD sentence names a build memo | — |
