# Platform Test: Paid Deliveries Against Group Records

**Archetype:** atomic-visit
**Opportunity:** group-payment-test
**Run:** 20261007-1700
**Date:** 2026-10-07
**Status:** Draft for requester review. Throwaway platform test; not a programme. Nothing here carries into any other opportunity.
**Requested by:** Sophie Feintuch (requester and the one test worker)
**Sources:** "PDD: Platform test, paid deliveries against group records" v0.1 (Oct 7, 2026) — the only input. No comment threads were open on it when read.

> **How to read this document.** Items marked **[FIXED]** are copied from the requester's design and are implemented exactly. Items marked **[ACE]** are choices ACE made inside the latitude the requester gave; each one is also a row in the run's decisions log, where it can be overridden. Where a [FIXED] item is ambiguous or conflicts with how Connect works, this document does not resolve it silently: it says what ACE will build and lists the point in **§ Before building: decided, conflicting, cannot build**. A **Requirement** is binding; a **Mechanism (advisory)** is a suggestion the app build may implement differently.

## Archetype

`atomic-visit` — each paid unit is one group-session form submission. The app still keeps durable group, member and session records (see § Deliver App Specification › Case Management), but there is no progression or state for a group to move through, every session is the same activity, and the source names no state vocabulary. ACE's `longitudinal-visits` archetype requires non-interchangeable visits and a declared state vocabulary, so declaring it here would invent one. Decision row `archetype-selection` (conflicting evidence, confirmation requested).

## Problem Statement

**[FIXED]** In the requester's graduation programmes, training and coaching sessions are paid per session against a group record, weekly, for up to two years. As far as the requester knows, no existing Connect programme pays against a record that is not a person. This test checks two ways of doing it before the coach design is written:

- **Variant A:** pay repeatedly against the group record itself.
- **Variant B:** create a new session record for each session and pay once against that.

It answers one platform question: **can Connect count and pay repeated deliveries against a record that is not a person?** It is not a programme. Paying repeated visits to a person record is already established by the Connect-RUTF program and is not retested here.

## Intervention Design

**[FIXED]** A new opportunity, separate from every other opportunity. No solicitation, no work order. One test worker (the requester) runs a four-step script on a real phone, syncing after each step, and records what Connect shows.

How the two variants differ **inside Connect** (this is the key point ACE wants the requester to see before the build — decision rows `connect-payment-attachment`, `variant-a-delivery-key`, `variant-b-delivery-key`):

- Connect does not link a payment to an app record. Every paid form submission sends Connect a **delivery key** and a **delivery name**; Connect groups submissions with the same key on one delivery record and approves and pays the individual submissions.
- **Variant A** sends the **group record's identifier** as the key (no period key). All of a group's sessions land on one Connect delivery record.
- **Variant B** creates a **session record** under the group on every submission and sends **that session record's identifier** as the key. Every session is its own Connect delivery record, including two on the same day.

**What ACE expects, from reading Connect's source (not yet observed live):** under ACE's normal automatic verification, a submission whose key Connect has already seen is not held or rejected; it is reset to pending, auto-approved, and counted for payment again, so Variant A's three sessions should all be approved and payable on one delivery record (decision row `repeat-payment-expectation`; `playbook/integrations/connect-api.md § A repeated entity_id is PAID AGAIN`). The test is the first live observation of this, and its results override the expectation.

## Learn App Specification

**[FIXED]** The minimum Connect needs to open the Deliver app: one short module and one trivial assessment.

- **Working language:** English only (CommCare language code `en`). Decision row `working-language`.

### Learning Objectives

- Module 1 — "About this test": the worker knows (a) the test registers two groups, one per variant, with three members each; (b) the two session forms (A and B) are the only paid forms; (c) she syncs after every step.

### Assessment

- One question, scored. **Passing score 100** (with one item the attainable scores are 0 and 100). [ACE] Decision row `learn-module-and-assessment`.
- Illustrative item (illustrative of the required shape — the app build authors the item and may replace this one): *"Which forms in this test are paid?"* — options: the two group session forms (correct); Register group; Add member.
- The passing score reaches Connect when the opportunity is created; it is not settable in the app.

### FLW Work-Unit Structure

- Work unit: one group-session form submission (Variant A or Variant B).
- Frequency: per the test script — three sessions per variant over two days (§ Test Script).
- Expected paid submissions per worker: 6 (3 per variant).
- Duration per submission: a few minutes; there is no real session behind it.

### Forms

| Form Name | Purpose | Key Fields |
|-----------|---------|------------|
| About this test (Learn module) | Explain the test | Short text; no questions |
| Check (Learn assessment) | Trivial gate before Deliver | One single-choice question, scored |

## Deliver App Specification

### Services Delivered

Each paid submission is one recorded group session against one group, under Variant A or Variant B.

### Records

**[FIXED]** Records:

| Record | Created by | Parent | Holds |
|---|---|---|---|
| Group | Register group form | None | Group name, community name |
| Member | Add member form | Group | Member name |
| Session (Variant B only) | Group session form (B) | Group | Session date, members present |

### Forms

**[FIXED]** All forms are opened by the worker in the Deliver app.

| Form | Opened from | Paid | What it does |
|---|---|---|---|
| Register group | Case list | No | Creates a group record |
| Add member | Group | No | Creates a member record under the group; used two or three times per group |
| Group session (A) | Group | Yes, per submission | Records session date and members present (selected from the group's members). Can be submitted any number of times on the same group. Creates no new record. |
| Group session (B) | Group | Yes, per submission | Same questions as A. Each submission creates a new session record under the group, and the payment attaches to that session record. |

**[ACE]** Form labels, question wording and question order are ACE's. Interpretations of the [FIXED] table:

- **"Opened from: Case list" for Register group** is read as a *Register group* button on the list of groups (a registration form creates a record, so it cannot be opened from an existing one). Decision row `register-group-entry-point`, confirmation requested.
- **"Payment attaches to that session record"** is read as: the key Variant B sends to Connect is the session record's identifier. Connect has no other way to attach a payment to a record. Decision row `connect-payment-attachment`.

### Form fields

**Register group** (unpaid): group name (text, required, max 60 characters); community name (text, required, max 60 characters).

**Add member** (unpaid, opened on a group): member name (text, required, max 60 characters). Creates a member record whose parent is the group.

**Group session (A)** and **Group session (B)** (paid, opened on a group, same questions):

1. **Session date** — date, required, pre-filled with today, may not be in the future. Same-day repeats are allowed. Not part of either variant's Connect key. Decision row `session-date-entry`.
2. **Members present** — Requirement: the worker chooses the members who attended from **that group's own member records**; names are never typed. At least one member must be chosen. Mechanism (advisory): a multi-select whose choices are the group's member records. **Not confirmed buildable** on ACE's app builder, whose documented choice sources are fixed lists and lookup tables; fallback is one *present? yes/no* question per member of the group (a repeat over the group's members). Decision row `members-present-capture`.

Variant A creates no record and writes nothing back to the group. Variant B creates one session record per submission under the group, holding the session date and the members present.

### Case Management

- Case types (Mechanism, advisory names): `group` (no parent), `member` (child of `group`), `session` (child of `group`; Variant B only).
- Lifecycle: groups and members are created and never closed during the test; session records are created by Variant B and never updated. Nothing is closed.

### Menus and Connect payment wiring

Requirement: Connect counts and pays the two variants separately, and never pays Register group or Add member. Because Connect creates one deliverable per app menu (module), not per form (`playbook/integrations/connect-api.md § Deliver-unit granularity is module-level`), and every submission on a paid deliverable counts toward its daily and total limits, the Deliver app has three menus. Decision row `paid-forms-separate-menus`.

| Menu | Forms | Paid deliverable | Delivery key sent to Connect | Delivery name |
|---|---|---|---|---|
| Groups | Register group, Add member | None (no Connect payment marker) | — | — |
| Variant A sessions | Group session (A), opened on a group | Variant A payment unit | The group record's identifier (no period key) | Group name |
| Variant B sessions | Group session (B), opened on a group | Variant B payment unit | The new session record's identifier (no period key) | Group name + session date |

Mechanism (advisory) for Variant B's key: use the new session record's own identifier if the app builder can reference it within the same submission; otherwise generate a unique session id in the form, save it on the session record, and send that. Either satisfies the requirement of one Connect delivery per session record, traceable to it. Decision row `variant-b-session-record-identifier` (not yet verified buildable).

## Target Population

- Beneficiary criteria: none — test records only. Two test groups, each with three test members, registered by the tester.
- Geographic scope: none stated; the test runs wherever the tester's phone is.
- Expected reach: 2 group records, 6 member records, 3 Variant B session records.

## FLW Requirements

- Number of FLWs: **1** — the requester herself. **[FIXED]** Decision row `flw-count`.
- Skills: none beyond using the Connect app; she wrote the script.
- Device and access: Connect installed and signed up on her own phone; ACE invites her to the opportunity by the phone number of her Connect account, which ACE does not yet have (decision row `tester-connect-access`, answer needed before the test can start).
- Note: ACE's own automated test phone also joins the opportunity before the tester does, to check that the apps install and open. It does not run the tester's script, but its app check does submit Deliver forms, so a few sessions from ACE's test user will appear on the same opportunity; the tester's results must be read for her own account only. The budget is sized so it cannot take the tester's place (decision rows `budget-plausibility`, `ace-test-user-submissions`).
- Seeing the results: the results table needs Connect's web view of the opportunity (visit list, approval status, flags), not only the phone. How the tester gets that view is an open ask (decision row `tester-results-view`).

## LLO Preference

- None. **[FIXED]** no solicitation and no partner organisation. The opportunity is held by ACE's own test organisation, which also receives the organisation amount Connect requires on each payment (decision row `llo-payment-rate`).

## Solicitation

- Not applicable. **[FIXED]** Do not publish a solicitation. The solicitation phase is skipped for this run.

## Success Metrics

**[FIXED]** Results are recorded from what is submitted and observed in Connect, not from expected behaviour.

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| Variant A: sessions submitted by end of Day 2 that show in Connect as approved and payable | 2 of 2, no duplicate flag | Tester reads Connect after the Day 2 sync |
| Variant B: sessions submitted by end of Day 2 that show in Connect as approved and payable | 2 of 2, no duplicate flag | Tester reads Connect after the Day 2 sync |
| Same-day result (third session, Day 2), per variant | Recorded either way; no target | Tester reads Connect after the final sync |
| Record each delivery is attached to, per session | Recorded as shown | Delivery name and record Connect shows for each session |

**[FIXED] What counts as a pass.** A variant passes if, after Day 2, each session submitted shows as its own approved, payable delivery with no duplicate flag. The same-day result is recorded either way: it tells the requester whether two sessions on one day for the same group need handling in the real design.

**Caveats ACE must state before the test, not after it:**

1. **"No duplicate flag" cannot fail under the required setup.** Under automatic verification as ACE configures it, Connect switches its duplicate check off and ACE's tooling cannot switch it on (`playbook/integrations/connect-api.md`; ace#1013). The test therefore shows whether repeats are approved and paid, but not how Connect's duplicate check would treat them. Decision row `duplicate-flag-unavailable`.
2. **"Its own delivery" has two readings, and under one of them Variant A fails by construction.** Under Variant A all sessions share one Connect delivery record by design; each session is still its own submission with its own approval and payment. If "its own delivery" means *its own Connect delivery record*, Variant A cannot pass; if it means *its own approved, payable submission*, it can. ACE does not pick between them: the results table records both what the delivery record shows and what each submission shows, and the requester decides which reading her pass criterion means. Decision row `variant-a-pass-reading`.
3. **ACE's test user also submits.** The automated app check submits a few Deliver forms on this opportunity; read results for the tester's account only. Decision row `ace-test-user-submissions`.
4. **Variant B delivery names can repeat.** Two Variant B sessions on the same day for the same group carry the same delivery name (group name + session date); tell them apart by the delivery key Connect shows.

## Test Script

**[FIXED]** The tester runs this on a real phone, syncing after each step.

1. **Setup.** Register two groups, one for each variant, and add three members to each.
2. **Day 1.** For each group, submit one session with its variant's form. Sync.
3. **Day 2.** For each group, submit a second session with a different session date. Sync.
4. **Day 2, again.** For each group, submit a third session on the same day. Sync.

After each step, record what Connect shows:

| Variant | Step | Session forms submitted so far | Deliveries shown in Connect | Approved and payable | Flags raised | Record the delivery is attached to |
|---|---|---|---|---|---|---|
| A | Day 1 | | | | | |
| A | Day 2 | | | | | |
| A | Day 2 again | | | | | |
| B | Day 1 | | | | | |
| B | Day 2 | | | | | |
| B | Day 2 again | | | | | |

## Evidence Model

| Layer | Purpose | Captured by | Verified by |
|---|---|---|---|
| **A — Delivery proof** | A group session form was submitted against a group | The session form submission (session date, members present) and the delivery key and name it sends | Connect automatic visit verification as ACE normally configures it: auto-approve, no form-answer rules, no submission-time window, no minimum duration. Connect's own daily and total limits (5 and 10 per variant) are set high enough never to bind during the script. Connect's duplicate check is off under this configuration and cannot be enabled. |
| **B — Content proof** | Not applicable | — | Not applicable: a platform test, no session actually happens |
| **C — Cross-delivery quality** | Not applicable | — | N/A — the only analysis is the tester's results table |

**Layer A, stated precisely.** Nothing in this design makes a session unpayable once submitted, other than Connect's own limits and dates. In particular no rule caps sessions per group: Variant A's repeated key is **not** expected to stop a repeat being paid, because Connect pays a repeated key again unless a limit or a verification rule stops it (ace#2512). That is exactly what the test observes. Decision rows `verification-config`, `verification-layers`, `repeat-payment-expectation`.

## Timeline

- The clock starts when the opportunity is created after the requester's answers (the run pauses for them after test scenarios are written).
- Start date: 2026-10-08 (proposed). End date: 2026-11-30 (proposed). Decision row `opportunity-dates`.
- Key milestones:
  - Requester answers the questions in § Before building: before the apps are built.
  - Apps built and opportunity created; ACE confirms the tester's access: after the answers.
  - Test script run: two consecutive days chosen by the tester, inside the window.

## Program Parameters

| Key | Value |
|---|---|
| learn_passing_score | 100 |
| assessment_items | 1 |
| payment_rate_min | 1 [PROPOSED] |
| payment_rate_max | 1 [PROPOSED] |
| payment_rate_currency | USD [PROPOSED] |
| payment_rate_unit | approved group session form submission (same rate for Variant A and Variant B, each its own payment unit) |
| flw_payment_per_visit | 1 [PROPOSED] |
| llo_payment_per_visit | 1 [PROPOSED] |
| daily_cap_per_flw | 5 per variant [PROPOSED] |
| total_cap_per_flw | 10 per variant [PROPOSED] |
| campaign_target_visits | 6 (3 per variant, from the test script) |
| flw_count_min | 1 |
| flw_count_max | 1 |
| expected_reach_min | 2 |
| expected_reach_max | 2 |
| entity_id_grain | Variant A: the group record (no period key). Variant B: the session record created by that submission (no period key). |
| entity_id_variant_a | group record identifier; delivery name = group name |
| entity_id_variant_b | identifier of the session record the submission creates (fallback: a unique session id saved on that record); delivery name = group name + session date |
| cap_rationale | Caps are deliberately non-binding: they sit above the script (2 per day, 3 in total per variant) so that a Connect limit can never be mistaken for a test result |
| total_budget | 80 [PROPOSED] — sized for 2 worker slots (the tester and ACE's automated test phone): 2 payment units x 10 x (1 + 1) = 40 per worker |
| opportunity_start_date | 2026-10-08 [PROPOSED] |
| opportunity_end_date | 2026-11-30 [PROPOSED] |
| verification_flags | automatic visit verification on, auto-approve; no form-field rules; no submission-time window; no duration floor; duplicate check unavailable (forced off under automatic verification) |
| connect_delivery_type | ace |
| opportunity_country | USA [PROPOSED] |
| opportunity_country_note | placeholder: the design names no country; create-time only, so it must be confirmed before the programme is created |
| opportunity_currency | USD [PROPOSED] |
| payment_units | 2 — Variant A sessions and Variant B sessions, same amounts and limits |

## Budget

- Estimated cost: 80 USD ceiling; expected accrual 12 USD (6 paid sessions x (1 worker + 1 organisation)).
- Payment structure: per approved session submission, two payment units at the same nominal rate. Payments are recorded in Connect; this test moves no real money unless someone chooses to.
- Worker economics: not applicable. The worker is the requester running a staff test; there is no livelihood or market rate to compare against, and the rate is nominal by design.

## Out of Scope

**[FIXED]** Consumption support, grants, roles other than the one worker, imports, households, and participant records under households. Repeated paid visits to a person record (already established elsewhere). No solicitation, no work order. Nothing from this test carries into any other opportunity, its decisions, or its feedback ledger.

## Before building: decided, conflicting, cannot build

**[FIXED]** Before building, ACE lists anything it had to decide itself, anything that conflicts with how Connect works, and anything it cannot build. Each item is a row in the run's decisions log (row id in brackets), where it can be answered or overridden.

### Decided by ACE

1. **Variant A delivery key** — the group record itself, no period key [`variant-a-delivery-key`]. Confirmation requested.
2. **Variant B delivery key** — the session record each submission creates, no period key [`variant-b-delivery-key`].
3. **Archetype** — one paid session submission is one delivery; no progression tracked [`archetype-selection`].
4. **Three menus** so the two variants are separate paid deliverables and registration is never paid [`paid-forms-separate-menus`].
5. **Register group** opens from a button on the group list [`register-group-entry-point`].
6. **Session date** asked on the form, today by default, not in the future, not part of the key [`session-date-entry`].
7. **Rate** 1 USD per session to the worker, 1 USD to the holding organisation, both variants [`payment-rate`, `llo-payment-rate`].
8. **Limits** 5 per day and 10 in total per variant, deliberately out of the way [`per-visit-daily-cap`].
9. **Budget** 80 USD for two worker slots [`budget-plausibility`].
10. **Dates** 8 Oct to 30 Nov 2026 [`opportunity-dates`].
11. **Verification** automatic, no extra rules [`verification-config`, `verification-layers`].
12. **Learn** one module, one question, pass mark 100 [`learn-module-and-assessment`].
13. **Delivery type** "ACE"; **language** English [`connect-delivery-type`, `working-language`].
14. **Build memo** compiled from the decisions log [`build-memo-artifact`].

### Conflicts with how Connect works

1. **Connect does not attach payments to records** — only to a key the form sends [`connect-payment-attachment`].
2. **No duplicate flag can be raised** under automatic verification as ACE configures it, so that half of the pass condition cannot fail [`duplicate-flag-unavailable`].
3. **Deliverables are per menu, not per form** — the reason for the three-menu layout [`paid-forms-separate-menus`].
4. **Country and currency are required** and cannot be changed after creation; the design names none, so the United States and US dollars are a placeholder [`opportunity-country-currency`].
5. **An organisation amount is required** on every payment even with no partner organisation [`llo-payment-rate`].
6. **ACE's automated test phone also joins** the opportunity, beside the one named worker [`budget-plausibility`].
7. **Expected behaviour on repeats** — each repeat approved and paid — is read from Connect's code and never yet observed [`repeat-payment-expectation`].
8. **The pass criterion has two readings for Variant A**, and under one of them Variant A fails by construction, because Connect puts all its sessions on one delivery record [`variant-a-pass-reading`].
9. **ACE's own test user submits Deliver forms** on the same opportunity during its app check [`ace-test-user-submissions`].

### Cannot build, or not yet confirmed buildable

1. **Picking members present from the group's own member list** — not confirmed on ACE's app builder; fallback is a yes/no per member [`members-present-capture`].
2. **Using the new session record's own identifier as Variant B's key** — not confirmed; fallback is a unique id saved on the session record [`variant-b-session-record-identifier`].
3. **A build memo as an automatic output** — ACE no longer produces one; it will be compiled by hand from the decisions log [`build-memo-artifact`].

### Needed from the requester before the test can start

- **The phone number of her Connect account**, so ACE can invite her [`tester-connect-access`].
- **How she will see Connect's web view of the opportunity** to fill in the results table [`tester-results-view`].

## Open Questions

Every item above with "confirmation requested" is an ask in the decisions log, answered there. Two block the test: the tester's Connect phone number [`tester-connect-access`] and how she sees Connect's web view of the results [`tester-results-view`]. One shapes how the result is read: which meaning of "its own delivery" the pass criterion intends [`variant-a-pass-reading`].

## Stress Test Results

| # | Check | Grade | Evidence |
|---|---|---|---|
| 1 | Executability | pass | The test script, records, forms, fields and menus are fully specified; the form flow is answerable screen by screen (session date, then members present — both known before the form opens). The two interpretations of [FIXED] text are named and asked about. |
| 2 | Verifiability | pass | Every claimed output is a Connect observation the tester records in the results table: visits, approval status, payable accrual, flags, delivery name. The known blind spot (duplicate flag cannot fire) is stated as a caveat before the test. |
| 3 | Measurability | pass | Pass criterion per variant is countable (2 of 2 approved and payable after Day 2); the same-day result is recorded without a target, as the design specifies. |
| 4 | Stage-gate clarity | pass | Single stage; the only gate is the requester's answers before the build. |
| 5 | Resource realism | pass | One staff tester, six submissions over two days; limits and budget have headroom for one re-try and for ACE's test phone. Worker economics do not apply (nominal rate, staff tester) and are stated as such rather than assumed. |
| 6 | Launch readiness | pass | Every launch parameter is a row in § Program Parameters (rates, organisation amount, limits, target, budget, dates, verification, delivery type, country, currency); proposals are marked [PROPOSED] and each has a decisions-log row. The tester's phone number is not a creation parameter; it is needed to invite her and is an open ask. |

Self-evaluation is by the author; the independent evaluation is a separate file.
