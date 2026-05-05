# Expected User Journeys — CRISPR-Test-003-Turmeric

Derived from: pdd.md (rev 2026-04-16)
Archetype: atomic-visit

> Synthetic stub. Written by `pdd-to-app-journeys` (Phase 1) as the
> UX-intent ground truth that `app-test-cases` (Phase 2) and
> `app-ux-eval` (deep QA) consume. Mirrors `pdd-to-test-prompts` for
> the apps. Fixture content is illustrative.

## Persona

Vendor-survey FLW — visits up to 20 turmeric vendors per day across
South Asian and African markets. Smartphone-literate. Carries the
yellow MTN color-reference card and an Android phone with the
Deliver app pre-installed. Connectivity is intermittent on-site;
syncs at end of day.

## Journey 1 — Survey one vendor

**Goal:** FLW completes one vendor's intake form, captures the
photo with the MTN card in frame, and submits.

**Happy path narrative:**
The FLW arrives at the vendor stall, opens the Deliver app, walks
through the 18-question Vendor Intake form, captures a photo of the
turmeric product alongside the yellow MTN reference card, lets GPS
auto-capture the location, and submits. They see a confirmation that
the visit recorded, and their daily count increments.

**Edge cases (UX outcomes, not error codes):**
- FLW understands why a photo without the MTN card in frame was
  rejected and how to recapture (error_recovery)
- FLW understands they cannot submit without a GPS reading and what
  to do to acquire one (error_recovery)

**Pass criteria:**
- Journey completes in <10 minutes including form fill and photo
- Required-field errors are recoverable in-form (no data loss)
- Submission confirmation visible without scroll

## Journey 2 — Capture vendor education outcome

**Goal:** FLW completes the brief educational conversation and
records the vendor's response in the Vendor Education form.

**Happy path narrative:**
After the intake, the FLW opens the Vendor Education form, marks
that the awareness conversation happened, picks the vendor's
response from the dropdown, adds a free-text note, and submits.

**Edge cases (UX outcomes, not error codes):**
- FLW understands they can skip the education form if the vendor
  refused and the workflow continues (error_recovery)
- FLW understands a partially-filled note draft persists if the
  app is closed mid-form (error_recovery)

**Pass criteria:**
- Journey completes in <2 minutes including the conversation note
- The "vendor refused" path routes the FLW back to the intake list
  without losing prior intake state
- Submission confirmation visible without scroll
