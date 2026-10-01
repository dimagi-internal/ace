# Build memo — Spark Facilitator · run 20260925-1536

This is the run's build memo: a collation of what each build step recorded about the choices ACE made where the PDD left latitude, the ambiguities it hit in fixed material, and where each PDD verification rule is actually applied. No PDD in this run names a build memo; it is composed as the standing Phase 4 review artifact.

**How to review:** work through section 1. Each row says where to spot-check it in the apps or on Connect. Sections 2–4 are the producers' own memos, for context.

**Read first:** per the Phase 4 memo (section 4), the PDD's payment predicate (meeting_conducted = yes AND meeting_type = community_meeting) is NOT enforced by Connect on this run's build opportunity — Connect does not serve its verification-rules page for an opportunity held by the program's own org (dimagi-internal/ace#2419).

## 1. Every [ACE] latitude taken and every [FIXED] ambiguity hit

| # | Kind | PDD section | What ACE did | Where to spot-check | From |
|---|---|---|---|---|---|
| 1 | [ACE] latitude | PDD §5 / §6 | `community` is a child case of `cbf`; Community Enrolment is a followup on the worker's own facilitator record that creates it — A registration-only `cbf` menu would carry an unreachable case list (`case-list-unreachable` BLOCKER); the child link also records which CBF enrolled the community. | Deliver app › Facilitator › Community Enrolment | Deliver memo; decisions.yaml: deliver-latitude-community-child-of-cbf |
| 2 | [ACE] latitude | PDD §5.2 (Phase 2 flag a) | Added a blocking duplicate-enrolment check on `community_id` — Spark's own Village Profile Form carries exactly this check (`community_warning`, casedb count on `community_id`); a second enrolment would mint a second 3-per-step cap. Device-local only — a duplicate across two CBFs' devices is caught in Layer B. | Deliver app › Facilitator › Community Enrolment › community_warning | Deliver memo; decisions.yaml: deliver-latitude-duplicate-enrolment-guard |
| 3 | [ACE] latitude | PDD §5.4 screens 2/3/5 | Date, held?, meeting type and location on one screen ("About this meeting"), in the order date, held?, type, location — Keeps the one-community-meeting-per-day date check local to the screen that can fix it. This MOVES meeting type ahead of the step display and location after the held/not-held question relative to the PDD screen list. | Deliver app › Community meetings › Community Meeting Record › date_of_meeting | Deliver memo; decisions.yaml: deliver-latitude-about-this-meeting-screen |
| 4 | [ACE] latitude | PDD §3.2 / §14 entity_id_grain | Added `meeting_kind` as a fourth key component — Payability-scoped key: a committee or not-held record must not share the payable key space (ace#969). The pinned three components and the cap are unchanged. | Deliver app › Community Meeting Record › entity_key | Deliver memo; decisions.yaml: deliver-latitude-payability-discriminator |
| 5 | [ACE] latitude | PDD §5.4 write-back | Case-write only hidden derived mirrors, never raw answers — Nova preloads every case-written property; writing `meeting_conducted` / `meeting_type` would pre-fill the payment fields on the next visit (ace#2006). | Deliver app › Community Meeting Record › new_step … new_total_participation | Deliver memo; decisions.yaml: deliver-latitude-derived-case-writes-only |
| 6 | [ACE] latitude | PDD §5.1 | Education options are Spark's five codes (none, primary, secondary, tertiary, university) — The PDD asks for the list to be reconciled with Spark's; Spark's CF Registration Form has no "other". | Deliver app › Facilitator Registration › cbf_education | Deliver memo; decisions.yaml: deliver-latitude-education-codes |
| 7 | [ACE] latitude | PDD §4.1 / §7 (consent floor) | Read-aloud photo statement with an attestation (`photo_statement_read` must be yes) and a read-aloud call-consent script — Photographing an assembled group fires the consent-script floor even though the PDD declares no photo-consent field; both scripts carry all six elements. | Deliver app › Community Meeting Record › photo_statement | Deliver memo; decisions.yaml: deliver-latitude-photo-consent-script |
| 8 | [ACE] latitude | PDD §5.1 / §5.4 | Field ids lowercased (`sparktrainer_attendance`, `sedo_attendance`, `currently_not_saving`, `district`); stored option codes verbatim — Nova ids must be lowercase snake_case; the verification predicate fields (`meeting_conducted`, `meeting_type`) and all option codes are exactly Spark's. | Deliver app › Community Meeting Record › meeting_details | Deliver memo; decisions.yaml: deliver-latitude-field-id-case |
| 9 | [ACE] latitude | PDD §5.4 screen 9 | `SEDO_attendance` label reworded to "staff or a trainer from the partner organisation" — Spark's label names Malawi partner orgs (AFES/SPRODETA/Njira/Soff) the pilot may not use. | Deliver app › Community Meeting Record › sedo_attendance | Deliver memo; decisions.yaml: deliver-latitude-sedo-label |
| 10 | [ACE] latitude | PDD §5 (date bounds) | Recruitment date within 10 years; partnership date within 3 years; reschedule within 60 days — Data-quality rule requires two-sided dates; the PDD states only the upper bounds. | Deliver app › Facilitator Registration › cbf_recruitment_date | Deliver memo; decisions.yaml: deliver-latitude-date-and-count-bounds |
| 11 | [ACE] latitude | PDD §5.4 (count bounds) | Attendance 0–1000 per sex; leaders 0–50; people saving 0–2000; savings ≤ MWK 100,000,000 — The PDD bounds only households; the rest are plausibility caps above any 400-household community. | Deliver app › Community Meeting Record › who_came | Deliver memo; decisions.yaml: deliver-latitude-date-and-count-bounds |
| 12 | [ACE] latitude | PDD §5.4 screen 10 | Savings block shown for any HELD meeting at Step 5+ (community or committee) — The PDD gates on step only; not-held records skip it. | Deliver app › Community Meeting Record › savings | Deliver memo; decisions.yaml: deliver-latitude-savings-on-held-meetings |
| 13 | [ACE] latitude | PDD §5.4 screen 4 | Step shown as seven conditional labels, not a computed name — A step name inside a hidden calculate cannot be translated; separate labels carry nya/tum text. | Deliver app › Community Meeting Record › step_display…step_display_7 | Deliver memo; decisions.yaml: deliver-latitude-step-labels-translatable |
| 14 | [FIXED] ambiguity | PDD §6.1 / §14 entity_state_taxonomy | Step labels are verbatim, but the build rule banned "&" from label text — First built with "and"; `pdd-to-deliver-app-eval` hard-gated it (entity_state_fidelity BLOCKER). Restored verbatim ("Governance & Leadership", "Microgrant Pathway & Goals", "Initiative Pathway & Savings") in step labels, `step_name` and the case-list enum; HQ build v14 carries `&amp;` and parses — the ban had no reproducer (ace#2150, PR #2481). | — | Deliver memo; decisions.yaml: deliver-ambiguity-step-name-ampersand; decisions.yaml: deliver-ambiguity-step-name-ampersand-verbatim |
| 15 | [ACE] latitude | PDD §4.2 | Added a 6-item non-gating starting quiz alongside the 12-item gate — ACE's assessment-gate standard requires a baseline bank distinct from the gate; it carries `learn_module` only, never `connect.assessment`, so it cannot become an alternative unlock path. | Learn app › Before you start › Starting quiz | Learn memo; decisions.yaml: learn-latitude-baseline-pretest |
| 16 | [ACE] latitude | PDD §4.1 | 8 modules: the six PDD modules plus "Before you start" and "Final assessment" as their own modules — Keeps the baseline and the gate out of the teaching modules so each Connect learn module maps 1:1 to a PDD module. | Learn app › module list | Learn memo; decisions.yaml: learn-latitude-module-layout |
| 17 | [ACE] latitude | PDD §4.2 | The 5 high-consequence items chosen: enrol once, household count, photo, step-completed honesty, savings amounts — The PDD lists 9 candidate operations for 5 slots; the not-held branch and attendance-vs-participation are already covered by rule items q4/q5. The reschedule-date rule and "count on the day" are taught but not tested by the gate. | Learn app › Final assessment › q1–q3, q7, q9 | Learn memo; decisions.yaml: learn-latitude-high-consequence-items |
| 18 | [ACE] latitude | PDD §4.2 | Hardened the illustrative committee-vs-community item (q10 adds "the Spark trainer is there" to the committee meeting) — The PDD states its example is shape-only; the added detail makes the committee-not-paid rule, not arithmetic, decide the answer. | Learn app › Final assessment › q10 | Learn memo; decisions.yaml: learn-latitude-illustrative-item-hardened |
| 19 | [ACE] latitude | PDD §4.1 Module 3 | Module 3 stands alone without FIYP's "Running an Effective Meeting" video — No FIYP media asset is in inputs/ (open question fiyp-media-assets). | Learn app › Recording a meeting › Lesson 3 | Learn memo; decisions.yaml: learn-latitude-module3-without-fiyp-video |
| 20 | [ACE] latitude | PDD §6 | Pace guidance "about Step 4 after about 7 weeks" taught as an on-track check — The PDD gives ~13 weeks for 7 steps (≈1.9 meetings per step) but no mid-point marker; this is ACE's interpolation. | Learn app › Steps and savings › Lesson 5 | Learn memo; decisions.yaml: learn-latitude-pace-marker |
| 21 | [ACE] latitude | PDD §4 | Worked examples use fictional names (CBF "Grace", "Kalumbu village", "Chikondi") — Teaching examples need a concrete subject; no real person or community is named. | Learn app › Lesson 3 and Final assessment q2, q10 | Learn memo; decisions.yaml: learn-latitude-fictional-examples |
| 22 | [FIXED] ambiguity | PDD §6.1 / §14 entity_state_taxonomy | Step names are to be used verbatim, but three contain "&", which the build rule banned from label text — First built with "and"; `pdd-to-deliver-app-eval` hard-gated the same rewrite in the Deliver app, so "&" was restored verbatim in both apps. HQ built it (`&amp;` in the XForm) — the ban had no reproducer (ace#2150, fixed in PR #2481). | Learn app › Steps and savings › Lesson 5 › steps_list | Learn memo; decisions.yaml: learn-ambiguity-step-name-ampersand; decisions.yaml: learn-ambiguity-step-name-ampersand-verbatim |
| 23 | [ACE] latitude | §10.1, §14 `payment_rate_min/max` [PROPOSED] | FLW `amount` = **7,500 MWK** per verified meeting — Connect needs one integer; the band midpoint is the figure the PDD itself uses for per-CBF earnings (§10.1). Placeholder until the awarded rate replaces it. | Connect › opportunity › payment units › amount | Phase 4 memo; decisions.yaml: connect-latitude-payment-amount |
| 24 | [ACE] latitude | §13, §14 `opportunity_start_date/end_date` [PROPOSED] | Opportunity 2026-11-02 → 2027-02-26 (PDD dates, not today) — Moving the start date to make Phase 6 payable would edit the programme's contract to satisfy a test (app-screenshot-capture ace#2427). Consequence: Deliver credit is structurally 0 until 2026-11-02. | Connect › opportunity › start/end date | Phase 4 memo; decisions.yaml: connect-latitude-opportunity-dates; decisions.yaml: opportunity-end-date |
| 25 | [ACE] latitude | §13 (program window) | Program 2026-10-01 → 2027-03-31 — Contains the solicitation (early Oct), the opportunity window and the March 2027 closeout; the PDD names only "to 31 March 2027". | Connect › program › dates | Phase 4 memo; decisions.yaml: connect-latitude-program-dates |
| 26 | [ACE] latitude | §14 `total_budget`, skill Step 4a | Program ceiling 32,760,000 MWK (10 × the per-opp 3,276,000) — Program is a cross-run ceiling for every build run of this opp; Σ over its opps was 0 at creation. | Connect › program › budget | Phase 4 memo; decisions.yaml: connect-latitude-program-budget-ceiling |
| 27 | [ACE] latitude | §1 archetype | Program name "Spark FCAP Facilitation — Malawi Follow-Up Study (MWK)" — `longitudinal-visits` naming; "(MWK)" distinguishes it from the superseded USD program of near-identical name. | Connect › program › name | Phase 4 memo; decisions.yaml: connect-latitude-program-name |
| 28 | open item | §14 `verification_flags` / §7.1(1) | The PDD fixes `form_field_rules: meeting_conducted = yes; meeting_type = community_meeting`, but Connect will not serve the rules page for ACE's self-managed build opportunity — OPEN — not applied on this opp (ace#2419); must be applied on the Phase 9 LLO opportunity, or the capability decision in ace#2419 made. | — | Phase 4 memo; decisions.yaml: connect-ambiguity-form-field-rules-unreachable |
| 29 | [FIXED] ambiguity | §14 locale warning, `opportunity_currency: MWK` | The durable program was USD while the design is fixed in MWK; currency cannot change after creation — Resolved by operator decision `program-currency-usd-vs-mwk` (jjackson@dimagi.com, 2026-09-26): new MWK program `9e82982e`; USD program `a115e4f2` left in place, superseded. | — | Phase 4 memo; decisions.yaml: connect-ambiguity-program-currency; decisions.yaml: program-currency-usd-vs-mwk |
| 30 | decision | PDD §5 form table | How many deliver units does the Deliver app expose? → 1. Only the Community Meeting Record is paid; registration and enrolment are recorded, not paid. | Deliver app › Community meetings › Community Meeting Record | decisions.yaml: deliver-unit-count |
| 31 | decision | 2-scenarios/pdd-to-app-journeys.md (7 journeys); skills/app-test-cases § Products (lazy deep recipes, ace#605) | How many app-walkthrough scenarios feed the qa+eval pair, and how many get Phase 3 recipe files? → 7 journeys, 2 smoke recipes. Every Phase 2 journey is catalogued in app-test-cases.yaml; only the two is_smoke journeys (journey-learn-pass, journey-deliver-submit) get recipe files now. The 5 deep journeys carry recipe: deferred and are generated by /ace:qa-deep on demand. | — | decisions.yaml: test-scenario-count |
| 32 | decision | pdd-to-app-journeys.md § Coverage self-check; Nova get_app ef133601 / c57ad3f2 | Are all longitudinal-visits journey categories bound to built forms? → All covered, 5 deep deferred. registration, case-selection, visit-flow, followup-with-preload, repeat-activity and data-quality-error each bind to the Facilitator / Community meetings forms; the Learn smoke binds all 8 Learn forms. Smoke coverage is one per app, as Phase 6 pre-flight requires. | — | decisions.yaml: test-archetype-coverage |
| 33 | decision | Nova get_form: Community Enrolment is a followup on cbf creating child case community; Community Meeting Record is a followup on community | How does the Deliver smoke reach the payable Community Meeting Record? → Three legs: register, enrol, meeting. The payable form needs a community case, which only Community Enrolment creates, and enrolment needs a cbf case, which only Facilitator Registration creates. Substituting a registration form for the payable one is banned (ace#1138). Leg B is an inline menu walk because deliver-form-walk.yaml cannot cross a case list that appears after the form row in a mixed registration+followup module. | — | decisions.yaml: deliver-smoke-leg-structure |
| 34 | decision | Nova get_form: cbf_warning (casedb match on cbf_primary_contact), community_warning (casedb match on community_id); ace#2226 case accumulation | What values does the Deliver smoke type into the duplicate-guarded key fields? → Run-id-suffixed values. Both registration forms become unsaveable when the casedb already holds a match, and cases accumulate across runs for the same test user and domain. CBF phone 0925091536, name Thandiwe Banda 1536, community ID SPK-20260925-1536 and community Kunthembwe 1536 keep the guards hidden and make CASE_NAME matching unambiguous. | — | decisions.yaml: deliver-smoke-run-unique-keys |
| 35 | decision | skills/app-test-cases § kind: date (ace#1300); lib/fieldlist-gestures.ts safeScrollOriginX | How do the smoke recipes scroll field-list screens that put a date picker above further questions? → Edge-origin swipes at x=5%. Registration 'Where you work' and meeting 'About this meeting' carry an inline DatePicker above inputs, selects and the GPS button. A centre-origin scroll is consumed by the picker and spins the date. Picker bounds are 2.63.2 observations not re-observed on 2.64.0; a spun date is refused loudly by each field's own constraint. | — | decisions.yaml: date-picker-screen-scroll-method |
| 36 | decision | connect_list_programs(ai-demo-space) unfiltered, 45 programs; operator decision program-currency-usd-vs-mwk | Reuse an existing Connect program or create one? → Create. Only domain+archetype match was a115e4f2, whose currency (USD) diverges from the PDD's MWK; the operator chose replacement. | opp.yaml connect.program.id | decisions.yaml: program-reuse-vs-create |
| 37 | decision | PDD §14 connect_delivery_type; connect_list_delivery_types (19 types) | Which Connect delivery type does the program use? → ace. PDD declares ace; present in the live list. No type fits community-meeting facilitation (open question connect-delivery-type-fit). | Connect › program › delivery type | decisions.yaml: program-delivery-type |
| 38 | decision | PDD §3.1, §10.1, §14 daily_cap_per_flw, total_cap_per_flw | What payment unit shape does the opportunity use? → one PU per verified meeting, max_total 21, max_daily 1. longitudinal-visits: one PU for the whole arc; sequence lives in entity_id. PU 7a0d526c requires DU 7083. | Connect › opportunity › payment units | decisions.yaml: payment-unit-shape |
| 39 | decision | PDD §3.1, §7.1(1), §14 | Where is the PDD verification rule 'meeting_conducted = yes' enforced? → Not configurable on Connect — not applied. Not-held records get their own entity_key space (meeting_kind=not_held) but still carry the deliver block, so they mint work until rejected. Set on the Phase 9 LLO opp. | Connect verification config; Deliver app › Community Meeting Record › about_this_meeting › meeting_conducted | decisions.yaml: connect-rule-meeting-conducted-yes |
| 40 | decision | PDD §3.1, §7.1(1), §14 | Where is the PDD verification rule 'meeting_type = community_meeting' enforced? → Not configurable on Connect — not applied. Committee meetings keyed under meeting_kind=committee_meeting but still minted as work on this opp. Set on the Phase 9 LLO opp. | Deliver app › Community Meeting Record › about_this_meeting › meeting_type | decisions.yaml: connect-rule-meeting-type-community |
| 41 | decision | PDD §7.1(2) | Where is the PDD verification rule 'the submitting CBF owns the community case' enforced? → CCZ constraint. Community is a child case of the CBF's own cbf case; the meeting menu lists only the worker's cases. | Deliver app › Community meetings case list | decisions.yaml: connect-rule-case-ownership |
| 42 | decision | PDD §3.2, §7.1(3), §14 entity_id_grain | Where is the PDD verification rule 'at most 3 paid meetings per community per FCAP step' enforced? → CCZ constraint. entity_key = concat(case_id, step, min(stored_index+1,3), meeting_kind) feeds deliver/entity_id; Connect de-dups on it. Clamp verified in the released CCZ. | Deliver app › Community Meeting Record › entity_key / capped_index | decisions.yaml: connect-rule-three-per-step-cap |
| 43 | decision | PDD §5.4 screen 2, §7.1(3) | Where is the PDD verification rule 'a held community meeting must be dated after the last one' enforced? → CCZ constraint. date_of_meeting constraint vs last_community_meeting_date. | Deliver app › Community Meeting Record › date_of_meeting | decisions.yaml: connect-rule-one-meeting-per-day |
| 44 | decision | PDD §7.1(4), §5.4 | Where is the PDD verification rule 'speakers <= attendees; households represented <= enrolled' enforced? → CCZ constraint. Form constraints on the who_came group. | Deliver app › Community Meeting Record › who_came | decisions.yaml: connect-rule-in-form-consistency |
| 45 | decision | PDD §7.1(4), §4.1 | Where is the PDD verification rule 'a live meeting photo on every held meeting' enforced? → CCZ constraint. required binary + appearance=acquire (camera-only). Connect has no attachment check (ace#1013). | Deliver app › Community Meeting Record › attach_a_photo_for_the_meeting | decisions.yaml: connect-rule-live-photo |
| 46 | decision | PDD §7.1(5) | Where is the PDD verification rule 'every required field for the current step present' enforced? → CCZ constraint. Required binds throughout the meeting record. | Deliver app › Community Meeting Record | decisions.yaml: connect-rule-completeness |
| 47 | decision | PDD §7.1(6), §10.1, §14 daily_cap_per_flw | Where is the PDD verification rule 'at most 1 payable meeting per CBF per day' enforced? → CCZ constraint. Date check in the form, backed by Connect payment unit max_daily=1. | Connect › payment unit › max_daily; Deliver app › date_of_meeting | decisions.yaml: connect-rule-daily-limit |
| 48 | decision | PDD §14 total_cap_per_flw, cap_rationale | Where is the PDD verification rule 'total cap 21 per CBF' enforced? → CCZ constraint. Structural 7 x 3 from the per-step clamp, also Connect PU max_total=21. | Connect › payment unit › max_total | decisions.yaml: connect-rule-total-cap |
| 49 | decision | PDD §5.6, §14 verification_flags | Where is the PDD verification rule 'location captured for review only' enforced? → Not configurable on Connect — applied elsewhere. CCZ submits location_review_flag / distance_from_community_m as advisory review inputs; Connect has no GPS flag. | Deliver app › Community Meeting Record › meeting_gps | decisions.yaml: connect-rule-location-advisory |
| 50 | decision | PDD §14 verification_flags | Where is the PDD verification rule 'no duplicate or GPS flags; de-duplication rides on entity_id' enforced? → Not configurable on Connect — applied elsewhere. Held in the CCZ entity_key; no dead flags sent (ace#1013). | Deliver app › entity_key | decisions.yaml: connect-rule-no-duplicate-gps-flags |
| 51 | decision | PDD §7.2 | Where is the PDD verification rule 'review >= 20% of paid meetings plus 10% of unpaid' enforced? → Not configurable on Connect — applied elsewhere. Implementing organisation's review procedure (Phase 9 / training); CCZ submits repeat_counts_flag and location flags to target the sample. | training LLO guide (Phase 6) | decisions.yaml: connect-rule-layer-b-review |
| 52 | decision | PDD §7.3 | Where is the PDD verification rule 'confirmation calls for >= 10% of paid meetings' enforced? → Not configurable on Connect — applied elsewhere. Supervisor call procedure; consent captured at enrolment (contact_consents_to_calls). | Deliver app › Community Enrolment › contact_consents_to_calls | decisions.yaml: connect-rule-layer-c-calls |

## 2. Deliver app

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

## 3. Learn app

*From `3-commcare/pdd-to-learn-app_build-memo.md`, verbatim (includes the Learn PDD §6(5) framework-gap statement).*



Run spark-facilitator/20260925-1536 · Nova app `c57ad3f2-9524-4470-949b-fc02cbaf3810`


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

## 4. Opportunity configuration and verification flags

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


## 5. Completeness

| Input | Status | If not present |
|---|---|---|
| 3-commcare/pdd-to-deliver-app_summary.md (## Build memo) | present | — |
| 3-commcare/pdd-to-learn-app_build-memo.md | present | — |
| 4-connect/connect-opp-setup.md (## Build memo — opportunity configuration and verification) | present | — |
| decisions.yaml (phases 3-commcare, 4-connect) | present (55 rows) | — |
| PDD set (sentence naming a build memo) | present — no PDD sentence names a build memo | — |
