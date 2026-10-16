<!--
VERBATIM EXCERPT of the real Phase 1 PDD of kaduna-graduation/20261015-1411
(Drive 1-design/idea-to-pdd.source.md, file 1g_auzqoznyjcwKAhvcQrZhCtPPqd7_c2,
revision 6, read 2026-10-16). Sections kept whole: header, Archetype, Learn App
Specification, Flags F2-F3, Program Parameters. Nothing reworded. This PDD
role-gated 14 Learn modules (9 FLW, 5 enumerator) and parked F3 for a device
walk; Connect then read 9/14 = 64.3% and Deliver never unlocked (ace#3036).
-->

# Kaduna-adjacent graduation program: FLW and enumerator opportunity

**Archetype:** longitudinal-visits
**Opportunity:** kaduna-graduation
**Run:** 20261015-1411
**Status:** compiled by ACE from the author's approved design (v0.1, revision 11, 15 October 2026); not redesigned
**Author of the design:** Sophie Feintuch
**Sources:** "PDD: Kaduna-adjacent graduation program (v0.1)" (the only design input); operator ruling `shared-test-project-space` (Jon, 2026-10-15)
**Country / currency:** Nigeria / NGN
**Build target:** the shared ACE test project space `connect-ace-prod` (operator ruling, overrides the design's "its own project space")
**Not produced this run:** solicitation, Work Order (design § 11.1)

# Part A: ACE's compilation

## Archetype

**longitudinal-visits.** Durable records (household, participant, Business Savings Group, business group) are visited repeatedly over about 12 months, the visits are ordered (enrollment, then baseline, then sessions and monthly home visits, then tranche receipts, then verification visits, then endline), and payability depends on each record's history (one routine visit per month, a targeted visit only with an open trigger, one paid session per group per day, the second tranche only after a cleared verification visit). It is one Connect opportunity with one Learn app, one Deliver app, and one payment unit per paid form, all running under the same clock per record. It is not `multi-stage`: the records progress independently, not as a cohort through a programme gate.

## Learn App Specification

**Requirement.** One Learn app certifies each worker before Deliver opens (Part B § 8). FLWs take the nine FLW modules and enumerators the five enumerator modules listed in Part B § 8, each a short module with a check of understanding. Learn content wording, module order and assessment questions are ACE's (Part B § 8 [ACE]); the pass mark is ACE's normal one, 80% (Program Parameters).

**Role separation in Learn ([ACE] choice, decision row `learn-role-separation`).** Connect stores one pass mark per Learn app and treats a pass on ANY scored assessment as opening Deliver, and it then opens the whole Deliver app (Part B § 8 says the same). So:

- Requirement: each worker sees only her role's modules.
- Requirement: there is exactly one scored certification assessment, whose questions are her role's questions (10 items per role, pass at 8). A worker cannot open Deliver by passing the other role's questions, because she never sees them.
- Mechanism (advisory): the per-module checks are practice checks with no Connect assessment marker; the single scored form carries the only assessment marker and shows FLW or enumerator items according to the worker's role property. Showing modules by role uses the same role property as Deliver (below).
- Requirement: a worker whose role property is not yet set sees a message to contact her supervisor instead of any module, so she cannot certify on the wrong content.

**Residual (see § Flags F3).** If Connect counts every Learn module in the app toward "Learn complete", an FLW would be required to finish the enumerator's modules too. ACE has not seen this either way; the first device walk confirms it.

**Assessment blueprint.** One fixed bank per role sized for the gate (10 items, 8 to pass), covering the consequential rules for that role: for the FLW, never asking for a PIN, only a completed eligibility visit is paid, recording an exit only when confirmed in person, a session never records an exit, the FLW never handles savings-group money, safeguarding (listen, do not investigate, pass on); for the enumerator, independence from coaching, the clearing rule applied the same way for every group, a live photo with no gallery images, flagging (not recording) a possible exit. No item draw or rotation is specified. Any example question is illustrative only; Phase 3 authors the bank.

**Working language.** English. The design names no working language; ACE does not assume one (decision row `working-language`).

## Flags

- **F2 One opportunity, two worker types.** Connect has no notion of a worker's role: it opens the whole Deliver app once the Learn assessment is passed, and it pays whichever worker submits a paid form. Role separation therefore rests entirely on the app reading a role property on each worker's CommCare HQ user, set by Dimagi staff. If the property is wrong or missing, a worker could see and be paid for the other role's forms; nothing on Connect's side stops it. Each paid form has its own payment unit; there is no per-role payment unit in Connect.
- **F3 Learn completion across roles.** Whether Connect requires every Learn module in the app (both roles' modules) to be completed before Deliver opens is not yet observed. If it does, role-separated Learn content does not work as designed and needs a different structure.

## Program Parameters

| Key | Value |
|---|---|
| connect_delivery_type | ACE [PROPOSED — no graduation delivery type exists on Connect (id 14, "ACE", on the programme-manager organisation); request a dedicated type before any real programme] |
| opportunity_country | NGA |
| opportunity_currency | NGN |
| payment_rate_currency | NGN |
| payment_rate_min | 1000 [PROPOSED — PLACEHOLDER, not a proposed rate; the LLO and Dimagi set real rates] |
| payment_rate_max | 1000 [PROPOSED — PLACEHOLDER] |
| flw_payment_per_visit | 1000 [PROPOSED — PLACEHOLDER; same placeholder for every paid form and both roles] |
| llo_payment_per_visit | 100 [PROPOSED — PLACEHOLDER] |
| payment_rate_unit | paid form submission (one per paid-form payment unit; 12 payment units, listed in § Payment units) |
| entity_id_grain | per payment unit, the record the paid form names plus that form's activity key: once-only activities use the activity code; group sessions use the session record; routine home visits use the scheduled month; targeted visits use the trigger record; verification visits use the visit number; receipts use the tranche |
| daily_cap_per_flw | 15 [PROPOSED — the largest per-unit daily cap; each payment unit carries its own cap, listed in § Payment units] |
| total_cap_per_flw | 480 [PROPOSED — the largest per-unit total cap (routine home visits); each payment unit carries its own cap] |
| cap_rationale | Caps are per worker per payment unit and sized with headroom for unpaid outcomes submitted on paid forms (not found, refused, left the programme). The routine-visit cap (480 = 12 months x 30 participants x 1.33) is deliberately above one FLW's expected count so it never refuses a legitimate visit; the paid-slot marker, not the cap, enforces one paid routine visit per participant per month. |
| campaign_target_visits | 2132 [PROPOSED — role-consistent: 2 FLWs x 936 FLW-unit caps + 1 enumerator x 260 enumerator-unit caps] |
| flw_count_min | 2 [PROPOSED — test cohort: 2 FLWs and 1 enumerator] |
| flw_count_max | 2 [PROPOSED] |
| enumerator_count | 1 [PROPOSED] |
| expected_reach_min | 30 [PROPOSED — placeholder caseload] |
| expected_reach_max | 60 [PROPOSED — 2 FLWs x 30 participants] |
| total_budget | 2345200 [PROPOSED — PLACEHOLDER: 2132 paid units x (1000 + 100) NGN; FLW and enumerator units counted only for their own role] |
| opportunity_start_date | 2026-11-01 [PROPOSED] |
| opportunity_end_date | 2027-12-31 [PROPOSED] |
| verification_flags | form duration flag on (threshold a programme-manager setting, placeholder); duplicate flag off; GPS captured on every paid form (no Connect GPS radius); spoofing, travel and score-outlier checks are review reports, not Connect flags [PROPOSED] |
| learn_passing_score | 80 |
| assessment_items | 10 |
| entity_state_taxonomy | enrolled=Enrolled; exited=Exited; graduated=Graduated; not_graduated=Not graduated [source: PDD: Kaduna-adjacent graduation program (v0.1)] |
| case_sharing | levels kgrad_area (owns no records; reaches all places below) above kgrad_flw_place (owns records; reaches none); one place per FLW; enumerator assigned to the area |
| hq_project_space | connect-ace-prod (operator ruling; additive, programme-named levels, places, tables and worker property only) |
| role_property | worker role on the CommCare HQ user, values FLW or enumerator; every form's display reads it |
| lookup_table_prefix | kgrad_ |
| working_language | English (en) |
| transfer_amount | 10000 NGN per month, 10 transfers, skipping calendar months 4 and 8 |
| grant_amount_per_tranche | 100000 NGN per business group, 2 tranches |
| attendance_threshold | 75% of core sessions (tentative) |
| solicitation | none this run |
| work_order | none this run |
