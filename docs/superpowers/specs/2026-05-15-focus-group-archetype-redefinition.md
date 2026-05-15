# Focus-Group Archetype Redefinition (Attestation-Form-Only)

**Date:** 2026-05-15
**Status:** Approved — critical-path skills updated in [PR #305 placeholder]; eval rubrics + training-skill content shape follow up later.
**Triggered by:** `malaria-itn-fgd/20260514-2007` first end-to-end FGD run; conversation between jjackson + ACE on 2026-05-15 after the run halted with 7 fundamentals filed.

## Background

The first FGD-archetype end-to-end run built two CommCare apps:
- A 9-module Learn app (~17 forms, 9 quizzes) teaching facilitation craft.
- A 3-module Deliver app with a 69-field Post-Session Summary form capturing 28 per-section structured fields + post-FGD report + facilitator reflection.

Building both apps took ~20 minutes of Nova model time + ~16 skill-side patches to clear validation. Most of the patches were workarounds for Nova-side gaps (no `add_case_list_column` in the architect's tool inventory; partial persistence on long forms; brittle return-message contract — see voidcraft-labs/nova-plugin#17, #18, jjackson/ace#303).

After the run, the operator pushed back on the basic premise:

> Yeah I think how you are defining it is not a "thin focus group" — it's just the only way we will do the focus group. I'm not even sure they will use the mobile app at all vs. just submit an invoice into the connect web interface when they are done with the focus group. Maybe we should have them fill out a single form just about having held the focus group, but all the answers and content collection they will be doing won't go into the mobile app — that will happen manually and then they will send us a gdoc with the content/answers to our questions.

That reframe is **the** operational reality of FGDs. The Learn-app + 28-field-Deliver-app pattern is not "the rich variant" — it's the wrong shape.

## The new FGD operational model

For an FGD opportunity:

1. **Facilitator runs the FGD** (60–90 min). Audio recorded; notetaker takes notes on paper. **No mobile-app interaction during the session.**
2. **Out of band**, after the session:
   - Facilitator writes up per-section themes, verbatim quotes, level of consensus, time spent, post-FGD report, reflection — all into a **Google Doc** the LLO and ACE-program-team share access to.
   - Facilitator collects: audio file (primary + backup device if used), attendance-sheet photo (no faces, first names + role + consent marks only).
3. **Facilitator submits a 5-field attestation form** in the CommCare Deliver app at session end: consent (yes/no, must be yes), date, venue (free text), GPS (geopoint), one evidence photo. The attestation form is the payment trigger — one submission = one Connect deliver_unit submission = one payment_unit pay-out, contingent on coordinator review.
4. **Facilitator writes the gdoc later** (hours or days after the session) with all the qualitative content and shares it with the LLO + ACE-program-team out-of-band. The attestation form does not have a `gdoc_link` field — the gdoc URL doesn't exist when the attestation is submitted.
5. **ACE coordinator** reviews the gdoc + (optional audio, in Drive) + attestation form, matched by `(FLW identity, session_date, venue)` tuple. Marks the attestation verified or flagged via the existing Connect / FormRepeater observation feedback path, and pay-out is released or held.

What the FGD operational model is **not**:
- It is not a 28-field-on-mobile content-capture form. Content lives in the gdoc; the mobile form is payment plumbing only.
- It is not an in-app training surface. Facilitator training lives in the OCS chatbot (per-opp, loaded with the FGD Guide content) + a facilitator handbook gdoc + a coordinator-graded practice-session audio review (the pre-fielding certification gate).

## Sometimes (rare) we want quantitative data in CommCare

If a future FGD opp explicitly opts into structured quantitative capture beyond the attestation form (e.g., a counts-by-section quick-tally form), that's a per-opp call captured in the PDD's Output Specification + Decisions Log. The PDD author opts in explicitly; the default for `focus-group` is attestation-only. We assume this is **rare** and ship the default-attestation-only path now.

## What changes per phase

### Phase 1 — `idea-to-pdd` (skill: `idea-to-pdd`)

PDD shape stays the same. What changes:

- `## Archetypes § focus-group` "Facilitation skill level" question is recharacterized. Training surface is OCS chatbot + handbook gdoc + practice-session-audio-review, not Learn app.
- "Output spec" question is also recharacterized. The "good summary" anchors describe **gdoc content**, not Deliver-app form fields.
- Decisions Log focus-group additive rows updated:
  - `facilitator-training-stipend` — now pegged to practice-session-pass (coordinator audio review), not Learn-app completion.
  - `gdoc-content-template` — new row. What sections / fields should the facilitator's gdoc contain? Default = the PDD's Output Specification, verbatim.
  - `submission-window` — clarified. Hours between session end and **attestation form** submission. Gdoc submission window is a separate Decision (default: same window).

### Phase 2 — `scenarios-and-acceptance` (no direct change)

`pdd-to-test-prompts` keeps producing OCS test prompts. For FGD, the chatbot is the primary facilitator surface (training reference + post-session writing guidance), so the prompts cover both prep-time + post-session-write-up Q&A. No skill change needed; the existing focus-group archetype branch in `pdd-to-test-prompts` already targets this.

`pdd-to-app-journeys` produces journeys against the new tiny attestation form. The existing `focus-group` archetype branch's journey list (`session-setup`, `recruitment-failure`, `consent-handling`, `output-coherence`) still maps cleanly — these journeys describe what the FLW does, which is still "show up at venue → run session → submit attestation". `output-coherence` becomes "the FLW submits attestation + uploads gdoc link" rather than "the FLW fills 28 form fields". No skill change needed for this PR; output content adapts naturally.

### Phase 3 — `commcare-setup` (the core change)

The Phase 3 procedure doc branches on archetype at Step 1:

- `atomic-visit` / `multi-stage` — unchanged. Dispatch `pdd-to-learn-app`, then `pdd-to-deliver-app`, sequentially.
- `focus-group` — **dispatch only `pdd-to-deliver-app`.** Skip `pdd-to-learn-app` entirely. The Learn-app build is not just slow — it's the wrong artifact for the operational model.

Step 2.8 (`commcare-form-patch`) also skips for focus-group (no Learn app to strip Connect wrappers from).

Step 1.5 (`app-connect-coverage`) runs only for the one Deliver-app build for focus-group.

`pdd-to-learn-app` skill itself becomes a no-op for focus-group archetype: the skill reads the PDD, sees `archetype: focus-group`, writes a one-line summary doc to `3-commcare/pdd-to-learn-app_summary.md` explaining the skip, and exits with status `skipped`. It does NOT call `/nova:autobuild`.

`pdd-to-deliver-app` skill's `## Archetypes § focus-group` branch is rewritten. The Deliver app for focus-group has:
- **One module:** "Session Attestation"
- **One form: 5 fields total.** No audio, no gdoc link, no metadata.
  - `consent_all_participants` (single_select: yes / no) — required attestation that every participant consented. Constraint `. = 'yes'` — form cannot submit otherwise.
  - `session_date` (date) — facilitator picks; typically today.
  - `venue` (text) — free-text venue description (village + specific space).
  - `gps` (geopoint) — captured at the venue at form-fill time.
  - `photo` (image) — single evidence photo (attendance sheet with no faces / venue / group only with active face-consent).
  - Auto-generated `case_name` from `concat(#user/username, '-', #form/session_date)` keeps the case list legible.
- Connect markers: `connect.deliver_unit` on the form. `connect.entity_id` defaults to `concat(#user/username, '-', today())`; override to `#case/case_id` only if any LLO schedules ≥2 sessions/day per facilitator (a Decisions Log call: `payment-unit-entity-id`).

**Specifically not included** in the Deliver app for focus-group:
- **No audio upload.** Audio recording (if captured) is out-of-band entirely — CommCare doesn't carry large audio files for FGDs.
- **No `gdoc_link` field.** The gdoc is written **after** the session ends; the URL doesn't exist when the attestation is submitted. Coordinator review matches attestation to gdoc by `(FLW, session_date, venue)` tuple, out-of-band.
- **No metadata fields.** No `llo_name`, `site_village/district`, `venue_type`, `planned_segment`, `actual_participant_count`, `start_time/end_time`, `audio_duration_minutes`, `facilitator_reflection`, `pre_checklist_complete` — all in the gdoc.
- **No per-section structured summary fields** — the gdoc's job.
- **No pre-session + post-session + reviewer-verification form split.** One form, submitted at session end.
- **No case management beyond per-session.**

### Phase 4 — `connect-setup` (no direct change)

The Connect program, opportunity, and payment unit are wired against the one attestation form's `connect.deliver_unit` and `connect.entity_id`. Verification flags target what the 5-field form captures: GPS within an expected radius of the planned venue (`gps-verification-radius` decision), photo attached, consent attested (`consent_all_participants = 'yes'`), session_date within the expected fielding window. Audio + gdoc are out-of-band; coordinator reviews them separately. Same shape as atomic-visit; no skill change needed — the PDD's Evidence Model and the deliver-app summary drive `connect-opp-setup` cleanly.

### Phase 5 — `ocs-setup` (light recharacterization, no skill change)

For focus-group, the OCS chatbot is the **primary facilitator surface** for training + post-session writing guidance. The chatbot is loaded with the FGD Guide + a handbook gdoc + the PDD's Output Specification (so it can answer "what should I put in section 3 of my gdoc?" coherently). The existing per-opp RAG content path supports this without skill-level change.

### Phase 6 — `qa-and-training` (training content reshape — defer)

`training-deck-outline`, `training-flw-guide`, `training-quick-reference`, `training-faq` for focus-group should target the gdoc-deliverable workflow + the attestation-form-only mobile interaction. Current content shape needs review against the new model. **Defer to a follow-up PR** — the training-skill changes are content-shape, not blocking for a coherent FGD run.

### Phase 7 — `synthetic-data-and-workflows` (defer)

Synthetic data for focus-group generates fake attestation form submissions + fake facilitator gdocs (one per fake session). Synthetic-narrative-plan + synthetic-workflow-seed for focus-group need to be reshaped — current shape assumes Deliver-app form content carries the qualitative data. **Defer to a follow-up PR.**

### Phase 8 — `solicitation-management` (no direct change)

The solicitation language describes the work product as "audio + gdoc + attestation form per completed session; paid per verified attestation". Current `solicitation-create` skill drives off the PDD's Recruitment Plan + FLW Requirements + Budget; no skill change needed.

### Phase 9 — `execution-management` (light recharacterization, defer)

Monitoring tracks attestation-form submission rate + gdoc submission receipts. `flw-data-review` for focus-group reviews the gdoc content (against the PDD's Output Specification) rather than form-field substance. **Defer** the `flw-data-review` content-shape change to a follow-up.

### Phase 10 — `closeout` (defer)

Cross-session synthesis pulls from the submitted gdocs + attestation-form metadata, not from Deliver-app structured submissions. `cycle-grade` for focus-group needs review. **Defer.**

## Affected files (this PR — critical path only)

| File | Change |
|---|---|
| `agents/commcare-setup.md` | Phase 3 procedure branches on archetype at Step 1 + 2.8. Focus-group: skip Learn build, skip form-patch. |
| `skills/pdd-to-learn-app/SKILL.md` | `## Archetypes § focus-group` becomes "no-op; this skill does not produce a Learn app for the focus-group archetype." Update Process to short-circuit. |
| `skills/pdd-to-deliver-app/SKILL.md` | `## Archetypes § focus-group` rewritten to attestation-form-only spec (one module, one form, ~14 fields). Step 1.5 (`app-connect-coverage`) still applies. |
| `skills/idea-to-pdd/SKILL.md` | `## Archetypes § focus-group` recharacterizes Facilitation skill + Output spec. Decisions Log `focus-group` rows: `facilitator-training-stipend` (recharacterized), `gdoc-content-template` (new), `submission-window` (clarified). |
| `templates/pdd-template.md` | "Learn App Specification" marked archetype-conditional (atomic-visit / multi-stage); focus-group has no Learn app section. |
| `VERSION` + 3 manifest files | Version bump via `scripts/version-bump.sh`. |

## Affected files (follow-up PRs, not in this PR)

| File | Change |
|---|---|
| `skills/pdd-to-learn-app-eval/SKILL.md` | `focus-group` branch grades the skip rationale, not an app. |
| `skills/pdd-to-deliver-app-eval/SKILL.md` | `focus-group` branch grades the tiny attestation form (passing band is much narrower than 28-field). |
| `skills/training-deck-outline/SKILL.md` + siblings | Content shape for focus-group reflects gdoc-deliverable + attestation-form mobile workflow. |
| `skills/synthetic-narrative-plan/SKILL.md` + siblings | Generates fake gdocs + attestation submissions. |
| `skills/flw-data-review/SKILL.md` + eval | Reviews gdoc content against PDD Output Spec, not Deliver-app form substance. |
| `skills/cycle-grade/SKILL.md` + eval | Synthesis pulls from gdocs, not Deliver-app data. |
| `skills/solicitation-create/SKILL.md` | Solicitation language for focus-group describes the gdoc + attestation work product (probably already does — check). |
| `skills/llo-onboarding/SKILL.md`, `llo-uat/SKILL.md`, `llo-launch/SKILL.md` | Onboarding/UAT/launch for focus-group references the attestation form + gdoc workflow. |

These are all content-shape changes — they affect what gets produced or how it's graded, not whether a coherent FGD run can complete. The critical-path PR is enough to ship a clean FGD run end-to-end; the follow-up PRs sharpen content quality at each phase.

## Migration: the malaria-itn-fgd run

The existing `malaria-itn-fgd/20260514-2007` run produced the **old-shape** Learn + Deliver apps. Per the run-independence rule (`CLAUDE.md § Run independence`), a fresh run will produce the new-shape artifacts without contaminating the old run. The existing apps stay on Nova/Firestore as test fixtures of the old shape.

The existing PDD (`docs/.../1-design/idea-to-pdd.md`) is oversized for the new model (it has the Learn-App-with-9-modules spec + the 28-field Output Specification). A fresh run on the same opp would regenerate the PDD against the new archetype branch and produce a leaner spec.

## Out of scope

- **Invoice-only payment path** (no attestation form, LLO submits Connect-web invoice per N completed sessions). Considered and deferred — the attestation-form-per-session path keeps Connect's per-submission payment plumbing intact, which is structurally simpler for Phase 4 + Phase 9. Invoice-only stays available as a future variant if operational experience shows the attestation form is friction.
- **Quantitative data capture in CommCare.** Rare per-opp opt-in; not part of the default `focus-group` path.
- **Eval rubric calibration against the new tiny Deliver-app shape.** Follow-up PR; the current rubric will likely flag the tiny Deliver-app as "underspecified" until recalibrated, but that's a non-blocking eval finding.

## Decision history

- **2026-05-15** — Operator (jjackson) reframes FGD from "rich Learn-app + 28-field Deliver-app" to "attestation-form-only + gdoc content + invoice-or-form payment". Answers "one tiny attestation form per session" to the payment-shape question. Decision captured here.
- **2026-05-15** — Operator pares the attestation form further. Verbatim: "For the fields just have consent (this should confirm you have consent from all participants), date, venue, gps, photo. everything else is either wrong or goes into the gdoc. the gdoc will be created after the fact so no ability to enter it into commcare". Final field list is 5 fields (consent / date / venue / gps / photo). Audio upload removed (out-of-band); gdoc_link removed (gdoc doesn't exist at submission time). Coordinator review matches attestation to gdoc by `(FLW, session_date, venue)` tuple, not by an in-form link.
