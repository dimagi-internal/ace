---
name: app-test
description: >
  Create and execute an automated test plan for the Learn and Deliver apps.
  Identify bugs and issues before LLO deployment.
---

# App Test

Create a test plan and execute it against the deployed Learn and Deliver apps.

## Process

1. **Read app summaries** from `ACE/<opp-name>/app-summaries/` via Google Drive MCP.

2. **Read deployment details** from `ACE/<opp-name>/deployment-summary.md`.

3. **Read the IDD's `archetype:` and `## Evidence Model` section.** Use the archetype to pick the test plan structure (see `## Archetypes` below). Use Layer A entries from the Evidence Model as a checklist of "what must be capturable end-to-end" — every Layer A artifact must have a passing test that exercises its capture path. Use Layer B entries to determine which content fields need length/quality validation tests. **If the IDD has no Evidence Model section, stop and return an error.**

4. **Generate test plan** based on app structure:
   - Form completion flows (every form, every path)
   - Case management (create, update, close)
   - Skip logic and validation rules
   - Required fields and constraints
   - Edge cases (empty inputs, max lengths, special characters)
   - Cross-form data flow (does data from Learn appear correctly in Deliver?)

5. **Execute tests** using available tools:
   - Use CommCare MCP to inspect app structure and form questions
   - Use browse/gstack for UI testing if web app preview is available
   - Document each test case: input, expected output, actual output, pass/fail

6. **Self-evaluate (LLM-as-Judge):**
   - Is test coverage sufficient? (all forms, all case types, key validation rules)
   - Are any critical paths untested?
   - Are identified bugs real issues or false positives?
   - Does every Layer A artifact from the Evidence Model have a passing capture test?

7. **Write test results** to `ACE/<opp-name>/test-results/`:
   - `test-plan.md` — the full test plan, with each test case linked back to its Evidence Model layer where applicable
   - `test-results.md` — pass/fail for each test case
   - `bugs.md` — list of identified bugs with severity and repro steps

8. **Notify admin group** with test summary (pass rate, critical bugs found).

## Archetypes

The test plan structure depends on the IDD's `archetype:` field. The base steps above describe the `atomic-visit` test plan; other archetypes need different coverage.

### `atomic-visit`
Tests as written in step 3 above: every form, every path, every validation rule, every case state transition, cross-form data flow. The test plan should also exercise the IDD's photo standardization protocol and any per-FLW/per-location caps.

### `focus-group`
A focus-group Deliver app is a session-documentation form with per-domain summary sections. The test plan still covers form completion, validation, and case management — but the high-value tests are different:

- **Per-domain section coverage**: every question domain in the IDD's Question Guide must have a corresponding form section. Cross-check by name.
- **Required-evidence completeness**: pre-session (date, GPS, venue, segment, count, consent, recording), post-session (reflection, attendance photo, audio file, duration). Missing any of these is a hard fail.
- **File-upload paths**: audio recording upload, attendance photo upload — both must work end-to-end and produce retrievable artifacts.
- **Consent gating**: can the form be submitted if consent is not confirmed? It should not.
- **Per-section length sanity**: free-text "themes" / "notable quotes" fields should accept paragraph-length input, not be restricted to short text.
- **Case lifecycle at the segment level**: one segment-level case with multiple session deliveries, not per-participant cases.

Skip atomic-visit-specific tests like "duplicate beneficiary detection" or "photo+GPS atomicity" — they don't apply.

### `multi-stage`
Run the per-archetype test plan against each stage's Deliver app. Add cross-stage tests: data from Stage 1 (e.g., findings that informed Stage 2 design) should flow into Stage 2's case context where the IDD says it should.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- CommCare (connect-labs): `get_app_structure`, `get_form_questions`

## Mode Behavior
- **Auto:** Run tests, write results, notify admin group, proceed
- **Review:** Present test results and any critical bugs for review

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-08 | Add `## Archetypes` section: focus-group test plans cover per-domain sections, file-upload paths, consent gating, segment-level cases | ACE team (PM scout, focus-group framework lens) |
| 2026-04-08 | Add explicit step 3 to read IDD `## Evidence Model`; every Layer A artifact must have a capture test, Layer B fields drive content-quality tests; error if Evidence Model missing | ACE team (PM scout, focus-group framework lens) |
