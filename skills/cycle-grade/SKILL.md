---
name: cycle-grade
description: >
  Grade the overall CRISPR-Connect cycle with recommendations for
  improvements and next steps.
---

# Cycle Grade

Produce a final grade and assessment of the complete CRISPR-Connect cycle.

## Process

1. **Read all opportunity artifacts from GDrive**, including learnings summary.

2. **Grade across dimensions:**
   - **Intervention Effectiveness** (0-10) — did the intervention achieve its goals?
   - **App Quality** (0-10) — were the Learn/Deliver apps well-designed and functional?
   - **LLO Execution** (0-10) — did LLOs execute effectively?
   - **FLW Performance** (0-10) — did FLWs deliver quality data/services?
   - **Process Efficiency** (0-10) — how smoothly did the CRISPR-Connect process run?
   - **Communication Quality** (0-10) — was communication with LLOs effective?
   - **Overall Grade** — weighted average with narrative assessment

3. **Self-evaluate (LLM-as-Judge):**
   - Is the grading fair and evidence-based?
   - Are the recommendations actionable?
   - Does the grade accurately reflect the opportunity's outcomes?

4. **Generate recommendations:**
   - Top 3 things that went well (keep doing)
   - Top 3 things to improve (for next cycle)
   - Specific recommendations for each ACE skill that was used

5. **Write final report** to `ACE/<opp-name>/closeout/cycle-grade.md`.

6. **Email admin group** with the full cycle grade report.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`

## Mode Behavior
- **Auto:** Generate grade, email report, mark opportunity as closed
- **Review:** Present grade for team review and discussion
