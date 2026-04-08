# Intervention Design Document (IDD)

## Opportunity: Vaccine Hesitancy Focus Groups — TestLand
**Date:** 2026-04-08
**Author:** Neal (ACE focus-group test fixture)
**Archetype:** focus-group

> **About this fixture.** Simplified single-stage version of `docs/examples/idd-vaccine-hesitancy.md`. Two segments instead of six, one LLO instead of multiple, and the gaps the original IDD had (recruitment, language, consent, output spec, etc.) have been resolved so the stress-test rubric grades all-pass. This is the regression-test fixture for the `focus-group` archetype across all 7 archetype-aware ACE skills.

---

## Problem Statement

In TestLand's Eastern Province, childhood vaccination rates are below national targets. Existing data tells us *that* vaccination is below target, but not *why*. Quantitative health-records data cannot answer the underlying questions about caregiver beliefs, social influence, and access barriers in a way that would inform a follow-on household intervention.

This opportunity uses focus group discussions to surface caregiver-side drivers of under-vaccination directly from the affected communities, with enough specificity that the findings can shape Stage 2 (a household follow-up pilot, run as a separate opportunity).

## Intervention Design

Run **6 focus group sessions** across **2 community segments** (3 sessions per segment), each session ~75 minutes, facilitated by trained TestLand Health Partners (LLO) staff with audio recording and per-domain summary capture. Synthesize findings across sessions to produce a barriers-and-enablers report that informs Stage 2 design.

This is a single-stage IDD. The `multi-stage` Stage 2 follow-up that the source IDD describes is **out of scope** here — Stage 2 will be a separate opportunity if the findings warrant it.

## Recruitment Plan

**Segments (2):**

1. **Women, close to PHC, under-vaccinated children** — mothers living within 30 min walk of a primary health center whose youngest child is on the under-vaccinated list. Identify via the district health office's zero-/low-dose register, cross-checked at recruitment by self-report of vaccine card status. Target 8 participants per session × 3 sessions = 24 participants.

2. **Men, remote (1+ hr from PHC), mixed vaccination status** — fathers living more than an hour from the nearest PHC, mixed vaccination status. Identify via community health volunteer referral (no central register exists for fathers). Target 8 participants per session × 3 sessions = 24 participants.

**Total target:** 48 participants across 6 sessions.

**Recruitment lead time:** 7 days before each session, by community health volunteers paid a per-confirmed-participant recruitment stipend (separate from session compensation).

**Comparison group:** None in this stage. The intent is to surface barrier patterns within under-vaccinated populations, not to compare against vaccinated.

## Facilitation Protocol

**Facilitator skill level:** Existing TestLand Health Partners staff with prior community engagement experience. **All facilitators must complete the focus-group facilitation training in the Learn app before their first session** — this is a hard prerequisite, not optional.

**Working language:** Hausa. Sessions are conducted entirely in Hausa. Per-domain summaries are written in English by the facilitator post-session, with verbatim quotes preserved in Hausa with English gloss.

**Venue:** Neutral community spaces (community center, primary school after hours). Not health facilities (introduces program-bias) and not leader compounds (introduces deference-bias).

**Session length:** ~75 minutes including consent and warm-up; question guide budgeted at ~60 minutes of discussion.

**Audio recording:** All sessions audio-recorded after explicit verbal consent from every participant. Recordings stored in the opportunity's Google Drive folder. Participants may withdraw consent at any time, in which case the recording is stopped and any quotes attributed to them are removed from the summary.

**Consent process:** Verbal consent script read aloud at session start, in Hausa. Consent covers: participation, audio recording, use of anonymized quotes in the final report, right to leave at any time. Facilitator records consent confirmation per participant on the attendance form.

**Compensation:** Modest per-participant honorarium (e.g., NGN 2000 or local equivalent) acknowledging opportunity cost and travel. The same opportunity-cost barrier the study is investigating must not be the reason participants don't show up.

## Question Guide

Six question domains, ordered to avoid anchoring (program-specific questions last):

1. **Service delivery experience** (~10 min): What's it like to vaccinate children at the local PHC? Outreach experience? Probes: time, distance, cost, provider attitudes.
2. **Personal barriers** (~10 min): When you wanted to vaccinate but couldn't — what got in the way? Probes: specific instances, frequency, what would have helped.
3. **Personal views on vaccination** (~10 min): What is the value, what are the risks, are there specific vaccines you're more hesitant about? Probes: where do those views come from.
4. **Community views and social influence** (~15 min): What do other parents say? How has the community changed over time? Whose opinion matters? Probes: religious leaders, traditional birth attendants, elders.
5. **Gender and decision-making** (~10 min, men's groups especially): Who decides about vaccination in the family? What would make you more or less likely to support? Probes: religious authority, elders.
6. **Program exposure (asked LAST)** (~5 min): Have you heard of "All Babies Are Equal"? Participated? Thoughts? **This is intentionally last to avoid anchoring all earlier responses on the program.**

Warm-up question (not in the 60-minute budget): "Tell me about your day yesterday." Used to settle the group and observe communication patterns.

## Output Specification

Per session, the facilitator produces:

- **Pre-session block**: date, GPS coordinate, venue name, segment label, target participant count, actual participant count, consent confirmation per participant, audio recording start timestamp
- **Per-question-domain block (6 sections)**, each with:
  - **Themes** (2–4 sentences summarizing what the group discussed)
  - **Notable quotes** (2–4 verbatim quotes in Hausa with English translation, attributed to "participant 1/2/3/...")
  - **Level of consensus** (strong consensus / mixed / divided)
  - **Time spent** (in minutes)
- **Post-session block**: facilitator reflection (what went well, what didn't, anything surprising), attendance photo (group photo, faces visible only with consent), audio file uploaded to GDrive, total session duration

**Cross-session synthesis** (produced by `flw-data-review`, not by the facilitator):
- Themes by segment, with quote attribution
- Convergence and divergence across the two segments
- Saturation indicator (are sessions still surfacing new themes or repeating?)
- Top 5 barriers by frequency × severity, with supporting quotes
- Implications for the Stage 2 IDD

## Learn App Specification

Facilitation training app (the focus-group Learn app pattern). Modules:

1. **Facilitation basics** — opening the session, ground rules, body language, time management
2. **Probing techniques** — "tell me more," "give me an example," neutral redirect
3. **Neutral framing** — asking sensitive questions without conveying judgment, especially around religion and tradition
4. **Group dynamics** — managing dominant participants, drawing out quiet ones, handling disagreement
5. **Question guide walkthrough** — reading the IDD's question guide aloud, with the rationale for ordering and probes
6. **Session form walkthrough** — opening the Deliver app, completing the per-domain summary form, uploading audio and attendance photo
7. **Consent and ethics** — verbal consent script, audio recording consent, withdrawal handling
8. **Logistics** — venue setup, attendance register, compensation distribution

Each module ends with a 3-question knowledge check; facilitators must pass all 8 before being marked as session-ready.

## Deliver App Specification

Session documentation app (the focus-group Deliver app pattern). Forms:

| Form Name | Purpose | Key Fields |
|---|---|---|
| Session start | Begin a session | Date, GPS, venue, segment, target participant count, actual count, per-participant consent confirmation, audio recording start time |
| Per-domain summary (×6) | Capture themes for one question domain | Themes (paragraph), Notable quotes (3–5 fields), Level of consensus (select), Time spent (minutes) |
| Session end | Close out a session | Facilitator reflection (paragraph), Attendance photo (upload), Audio file (upload), Total duration |

**Case management:** One case per **segment**, not per participant. The segment-level case accumulates session deliveries. The case closes when the segment hits its target session count.

## Target Population

- **Beneficiary criteria:** Caregivers (women + men) of under-vaccinated children in TestLand Eastern Province
- **Geographic scope:** 2 districts (Luvale, Kaonde)
- **Expected reach:** 48 caregivers across 6 sessions; findings inform Stage 2 design which would reach a much larger downstream population

## FLW Requirements

- **Number of facilitators:** 4 (2 per district, gender-matched to segments — female facilitators for women's groups, male for men's groups)
- **Skills/qualifications:** Existing TestLand Health Partners community-engagement staff; literacy in Hausa and English; willingness to complete facilitation training
- **Training requirement:** Must complete and pass the Learn app's 8-module facilitation training before first session

## LLO Preference

- **Preferred LLO:** TestLand Health Partners (fictional)
- **LLO criteria:** Experience with community focus groups; existing relationship with district health offices in Luvale and Kaonde; capacity to recruit participants and provide gender-matched facilitators
- **Contact:** Neal (neal@test.example.com)

## Success Metrics

| Metric | Target | Measurement Method |
|---|---|---|
| Sessions completed | 6 of 6 (100%) | `connect-opp-setup` Layer A verification |
| Per-session attendance | ≥ 6 of 8 target participants per session | Attendance form |
| Audio capture completeness | 100% of sessions, ≥ 45 min duration each | Audio file metadata |
| Per-domain summary completeness | All 6 domains completed for all 6 sessions | Per-domain summary form submission |
| Theme saturation | Saturation reached by session 5 of 6 | `flw-data-review` cross-session synthesis |
| Quote density | ≥ 2 verbatim quotes per domain per session | Per-domain summary content audit |

## Evidence Model

| Layer | Purpose | Captured by | Verified by |
|---|---|---|---|
| **A — Delivery proof** | The session happened as a focus group with consenting participants | Session start form (date, GPS, venue, segment, attendance count, per-participant consent), audio file upload, attendance photo, session end form | Automated: GPS within target community area, audio file present and ≥ 45 minutes, attendance form complete, all 6 per-domain summary forms submitted, consent confirmation present, facilitator reflection present |
| **B — Content proof** | The session was facilitated properly and the summaries are usable | Per-domain summary forms (themes, ≥ 2 verbatim quotes per domain, level of consensus, time spent), facilitator reflection | AI-assisted: summaries are specific (not generic), quote count meets density target, consensus rating is grounded in the themes, facilitator reflection acknowledges what worked and what didn't |
| **C — Cross-delivery quality** | The dataset of 6 sessions yields actionable findings | All 6 session outputs taken together | AI synthesis: theme convergence and divergence across the 2 segments, saturation reached by session 5, top barriers identified with quote attribution, output usable as input to a Stage 2 IDD |

## Timeline

- **Start date:** 2026-04-15
- **End date:** 2026-05-31
- **Key milestones:**
  - Facilitator training complete: 2026-04-22
  - First session: 2026-04-29
  - All 6 sessions complete: 2026-05-20
  - Cross-session synthesis report: 2026-05-27
  - Closeout: 2026-05-31

## Budget

- **Estimated cost:** $4,800
- **Payment structure:** Per verified session ($500/session × 6 sessions = $3,000) + recruitment stipends + participant honoraria ($1,800)

---

## Stress Test Results

These results were produced by `idea-to-idd`'s 5-question stress-test rubric (see `skills/idea-to-idd/SKILL.md`). All grades **pass** — this fixture was constructed to pass the rubric so that downstream skills can run against it without `idea-to-idd` looping.

| Check | Grade | Evidence |
|---|---|---|
| Executability | **pass** | Recruitment plan specifies how each segment is identified, language declared (Hausa), facilitator skill level + training requirement explicit, consent process documented, venue selection rule stated, compensation specified |
| Verifiability | **pass** | Output Specification gives a concrete per-session schema (pre-session block, 6 per-domain blocks with themes/quotes/consensus/time, post-session block); Evidence Model maps each artifact to a verification mechanism |
| Measurability | **pass** | Success Metrics table has 6 metrics with targets and measurement methods; metrics span all three Evidence Model layers |
| Stage-gate clarity | **pass** | Single-stage IDD; Stage 2 explicitly out of scope; closeout produces a synthesis report whose role as "input to a possible Stage 2 IDD" is documented |
| Resource realism | **pass** | Facilitation skill is assumed to be developed via the Learn app's 8-module training (not assumed pre-existing); 48-participant recruitment scoped via 4 facilitators × 3 sessions × 8 participants with named recruitment lead time |
