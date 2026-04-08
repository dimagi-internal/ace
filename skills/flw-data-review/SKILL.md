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
   - **IDD `archetype:` and `## Evidence Model` section** — these determine whether this is a quantitative review (`atomic-visit`, query-driven) or a qualitative review (`focus-group`, content-driven). See `## Archetypes` below. The Evidence Model's Layer B is what step 2/3 evaluates per delivery; Layer C is what they evaluate across deliveries.

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

## Archetypes

What "FLW data review" means depends on the IDD's `archetype:` field. The base steps above describe a quantitative review (`atomic-visit`); other archetypes review fundamentally different things.

### `atomic-visit`
Quantitative review as written above:
- Submission rates by FLW (vs. expected daily caps)
- Completion rates and dropout patterns
- Outlier detection on numeric fields, photo features, GPS clustering
- Cap and rate-limit violations (e.g., more than 5 vendors per market per day)
- Per-FLW outliers vs. cohort baseline
- Cross-FLW clustering (suspicious copy-paste patterns)

This corresponds to Layer B and Layer C of the IDD's Evidence Model.

### `focus-group`
Qualitative review — the FLW data is **session content**, not numeric submissions. The skill is acting as a research analyst, not a data quality auditor.

- **Per-session quality** (Layer B): for each session, read the per-domain summary sections — are they specific (with quotes, with examples) or generic (vague themes, no detail)? Is each domain actually covered or skipped? Does the facilitator reflection acknowledge what worked and what didn't?
- **Cross-session synthesis** (Layer C): across all completed sessions, what themes are emerging per segment? Where do segments differ (e.g., women-close-to-PHC vs. men-remote)? Where do they converge? Map findings to the IDD's intervention hypotheses.
- **Saturation check**: are new sessions still surfacing new themes, or are we hearing the same things? If saturation is reached, suggest stopping or moving to the next stage.
- **Quote bank**: extract the most illustrative verbatim quotes per theme, with segment attribution, for the eventual output report.
- **Facilitator coaching signals**: are some facilitators consistently capturing thinner summaries? Suggest probing/training adjustments.

Don't run quantitative checks (submission rates, outlier detection) — they don't apply. Don't grade individual FLWs on volume — sessions are facilitated, not metered.

### `multi-stage`
Run the per-archetype review against each stage's data. For multi-stage IDDs where Stage 2 design depends on Stage 1 findings, the Stage 1 review should explicitly produce input for `learnings-summary` and the Stage 2 IDD revision.

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
| 2026-04-08 | Add `## Archetypes` section: focus-group review = qualitative synthesis (per-session quality, cross-session themes, saturation, quote bank), no quantitative outlier checks | ACE team (PM scout, focus-group framework lens) |
| 2026-04-08 | Read IDD `## Evidence Model` in step 1; Layer B drives per-delivery evaluation, Layer C drives cross-delivery synthesis | ACE team (PM scout, focus-group framework lens) |
