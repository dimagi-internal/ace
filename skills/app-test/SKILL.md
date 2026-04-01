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

3. **Generate test plan** based on app structure:
   - Form completion flows (every form, every path)
   - Case management (create, update, close)
   - Skip logic and validation rules
   - Required fields and constraints
   - Edge cases (empty inputs, max lengths, special characters)
   - Cross-form data flow (does data from Learn appear correctly in Deliver?)

4. **Execute tests** using available tools:
   - Use CommCare MCP to inspect app structure and form questions
   - Use browse/gstack for UI testing if web app preview is available
   - Document each test case: input, expected output, actual output, pass/fail

5. **Self-evaluate (LLM-as-Judge):**
   - Is test coverage sufficient? (all forms, all case types, key validation rules)
   - Are any critical paths untested?
   - Are identified bugs real issues or false positives?

6. **Write test results** to `ACE/<opp-name>/test-results/`:
   - `test-plan.md` — the full test plan
   - `test-results.md` — pass/fail for each test case
   - `bugs.md` — list of identified bugs with severity and repro steps

7. **Notify admin group** with test summary (pass rate, critical bugs found).

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- CommCare (connect-labs): `get_app_structure`, `get_form_questions`

## Mode Behavior
- **Auto:** Run tests, write results, notify admin group, proceed
- **Review:** Present test results and any critical bugs for review
