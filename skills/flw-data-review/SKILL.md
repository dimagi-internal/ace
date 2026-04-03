---
name: flw-data-review
description: >
  Analyze FLW submission data to identify quality issues, trends, and
  improvement opportunities. Generate recommendations for the team.
  Runs recurring during active opp.
---

# FLW Data Review

Analyze FLW data and recommend improvements to communicate to LLOs.

## Process (runs periodically)

1. **Read opportunity context** from GDrive:
   - App summaries and expected data patterns
   - Previous data reviews from `ACE/<opp-name>/data-reviews/`
   - IDD success metrics

2. **Query FLW data** via scout-data MCP:
   - Form submission rates by FLW
   - Completion rates and dropout patterns
   - Data quality issues (missing fields, outlier values)
   - Case management compliance
   - Compare against expected metrics from IDD

3. **Self-evaluate (LLM-as-Judge):**
   - Are the identified patterns real signals or noise?
   - Are recommendations specific enough to act on?
   - Is the analysis grounded in data, not speculation?

4. **Generate recommendations:**
   - Specific issues identified (with data evidence)
   - Suggested actions for the Auto-Connect team to relay to LLOs
   - Trends over time (improving, declining, stable)

5. **Write data review** to `ACE/<opp-name>/data-reviews/YYYY-MM-DD-review.md`.

6. **Notify admin group** with summary of findings and recommendations.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- CommCare (scout-data): `query`, `list_tables`, `describe_table`
- Connect (connect-labs): `get_opportunity_apps` for app IDs

## Mode Behavior
- **Auto:** Analyze data, write report, email recommendations to admin group
- **Review:** Present findings and recommendations for team discussion

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
