# Expected User Journeys — CRISPR-Test-001

Derived from: pdd.md (rev 2026-04-03)
Archetype: atomic-visit

> Synthetic stub. Written by `pdd-to-app-journeys` (Phase 1) as the
> UX-intent ground truth that `app-test-cases` (Phase 3) and
> `app-ux-eval` (deep QA) consume. Mirrors `pdd-to-test-prompts` for
> the apps. Fixture content is illustrative — real PDDs produce
> richer journeys.

## Persona

CHW Asha — community health worker in TestLand pilot district.
Conducts ~10 household visits per day. Smartphone-literate but new to
the CommCare app. Connectivity is spotty in some target households,
strong at the LLO office where she syncs end-of-day.

## Journey 1 — Complete a household visit

**Goal:** FLW finishes one household visit end-to-end and sees
confirmation that the submission landed.

**Happy path narrative:**
Asha arrives at a household, opens the Deliver app from Connect,
confirms the household by name and phone number, walks through the
screening form, photographs the household ID card, and submits. She
sees a confirmation that her visit has been recorded and the count on
her daily tally increases by one.

**Edge cases (UX outcomes, not error codes):**
- FLW understands why a duplicate-household submission was rejected
  and how to proceed (error_recovery)
- FLW understands they cannot submit without a GPS reading and what
  to do to acquire one (error_recovery)

**Pass criteria:**
- Journey completes in <3 minutes including form fill
- Required-field errors are recoverable in-form (no data loss)
- Submission confirmation visible without scroll

## Journey 2 — Pass the Learn assessment

**Goal:** FLW finishes the Learn module and passes the assessment so
the Deliver app unlocks.

**Happy path narrative:**
Asha opens the Learn app, reads through the onboarding module, takes
the end-of-module assessment, and sees a passing score. The Deliver
app is now claimable from Connect.

**Edge cases (UX outcomes, not error codes):**
- FLW understands they can retake the assessment if they fail
  (error_recovery)
- FLW understands their progress is saved if the app is closed
  mid-module (error_recovery)

**Pass criteria:**
- Assessment passing threshold is visible in-app before the FLW
  starts
- Failing the assessment routes back into the module with prior
  reading still accessible
- Passing routes the FLW to the next clear step (claim Deliver app)
