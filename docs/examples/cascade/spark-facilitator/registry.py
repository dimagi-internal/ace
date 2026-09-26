"""Spark facilitator semantic registry (authored from PDD run 20260925-1536). Emits registry.json."""
import json, sys

props = {
    "version": 1,
    "entity": {"name": "community", "plural": "communities", "key": "community_case_id", "cohort_date": "first_visit"},
    "visit_columns": [
        {"name": "is_held", "word_match": {"column": "meeting_conducted", "word": "yes"}},
        {"name": "is_community_meeting", "word_match": {"column": "meeting_type", "word": "community_meeting"}},
        {"name": "is_verified", "sql": "COALESCE(meeting_conducted = 'yes' AND meeting_type = 'community_meeting', FALSE)"},
        {"name": "step_done", "sql": "COALESCE(step_completed = 'yes', FALSE)"},
        {"name": "is_repeat_flag", "sql": "COALESCE(repeat_counts_flag = 'yes', FALSE)"},
        {"name": "is_location_flag", "sql": "COALESCE(location_review_flag = 'yes', FALSE)"},
        {"name": "is_saving", "sql": "COALESCE(CAST(currently_saving AS DECIMAL) = 1, FALSE)"},
        {"name": "attendance", "sql": "COALESCE(male_attendance, 0) + COALESCE(female_attendance, 0)"},
        {"name": "spoke", "sql": "COALESCE(male_participants, 0) + COALESCE(female_participants, 0)"},
    ],
    "pipelines": {"entity": "visits"},
    "constants": {"ON_TIME_DAYS": 105, "SAVINGS_STEP": 5, "FINAL_STEP": 7},
    "aggregates": [
        {"name": "num_records", "label": "Meeting records", "means": "Every meeting record filed for the community, held or not.", "sql": "COUNT(*)"},
        {"name": "first_visit", "label": "First record", "means": "Date of the community's first meeting record.", "sql": "MIN(visit_date)"},
        {"name": "last_visit", "label": "Latest record", "means": "Date of the community's most recent meeting record.", "sql": "MAX(visit_date)"},
        {"name": "verified_meetings", "label": "Verified meetings", "means": "Records with meeting_conducted = yes and meeting_type = community_meeting (PDD §3.1).", "sql": "COUNT(*) FILTER (WHERE is_verified)"},
        {"name": "verified_weeks", "label": "Weeks with a verified meeting", "means": "Distinct calendar weeks containing at least one verified community meeting.", "sql": "COUNT(DISTINCT DATE_TRUNC('week', visit_date)) FILTER (WHERE is_verified)"},
        {"name": "step7_done_date", "label": "Step 7 completed on", "means": "Date of the verified meeting at which the community completed Step 7 (Vision).", "sql": "MIN(visit_date) FILTER (WHERE is_verified AND step_done AND step_number = :FINAL_STEP)"},
        {"name": "max_step", "label": "Furthest FCAP step", "means": "Highest FCAP step recorded on any meeting.", "sql": "MAX(step_number)"},
        {"name": "hh_represented_sum", "label": "Households represented", "means": "Households represented, summed over verified meetings.", "sql": "SUM(hh_represented) FILTER (WHERE is_verified)"},
        {"name": "hh_enrolled_sum", "label": "Households enrolled (per meeting)", "means": "The community's enrolled households, counted once per verified meeting.", "sql": "SUM(enrolled_households) FILTER (WHERE is_verified)"},
        {"name": "attended_sum", "label": "People attending", "means": "Men plus women attending, summed over verified meetings.", "sql": "SUM(attendance) FILTER (WHERE is_verified)"},
        {"name": "female_attended_sum", "label": "Women attending", "means": "Women attending, summed over verified meetings.", "sql": "SUM(female_attendance) FILTER (WHERE is_verified)"},
        {"name": "spoke_sum", "label": "People who spoke", "means": "Men plus women who spoke, summed over verified meetings.", "sql": "SUM(spoke) FILTER (WHERE is_verified)"},
        {"name": "female_spoke_sum", "label": "Women who spoke", "means": "Women who spoke, summed over verified meetings.", "sql": "SUM(female_participants) FILTER (WHERE is_verified)"},
        {"name": "repeat_flag_records", "label": "Repeat-count flags", "means": "Community meetings whose men and women attending both equal the previous meeting's (repeat_counts_flag = yes, PDD §5.4).", "sql": "COUNT(*) FILTER (WHERE is_repeat_flag)"},
        {"name": "location_flag_records", "label": "Location review flags", "means": "Records whose location fix was worse than 50 m or more than 2 km from enrolment (PDD §5.6).", "sql": "COUNT(*) FILTER (WHERE is_location_flag)"},
        {"name": "last_step5_meeting", "label": "Latest held meeting at Step 5+", "means": "Date of the latest held meeting on Step 5 or later.", "sql": "MAX(visit_date) FILTER (WHERE is_held AND step_number >= :SAVINGS_STEP)"},
        {"name": "last_saving_meeting", "label": "Latest meeting reporting savings", "means": "Date of the latest meeting with currently_saving = 1.", "sql": "MAX(visit_date) FILTER (WHERE is_saving)"},
    ],
    "properties": [
        {"name": "active_days", "label": "Days in active window", "means": "Days from the first record to Step-7 completion, or to the report date if not yet complete (PDD §8.1 P1).", "type": "int",
         "sql": "FLOOR(EXTRACT(EPOCH FROM (COALESCE(step7_done_date::timestamp, (:as_of)::timestamp) - first_visit::timestamp)) / 86400)::int"},
        {"name": "active_weeks", "label": "Weeks in active window", "means": "Community-weeks in the active window, counting the first week.", "type": "int", "sql": "FLOOR(active_days / 7) + 1"},
        {"name": "reached_step5", "label": "On Step 5 or later", "means": "The community has held a meeting on Step 5 or later (savings are asked only from Step 5, PDD §5.5).", "type": "bool", "sql": "COALESCE(max_step >= :SAVINGS_STEP, FALSE)"},
        {"name": "saving_now", "label": "Saving at latest meeting", "means": "The latest held meeting on Step 5+ reported currently_saving = 1.", "type": "bool",
         "sql": "COALESCE(reached_step5 AND last_saving_meeting IS NOT NULL AND last_saving_meeting = last_step5_meeting, FALSE)"},
        {"name": "completed_on_time", "label": "Step 7 within 15 weeks", "means": "Completed Step 7 within 105 days (15 weeks) of the first record (PDD §8.1 P3).", "type": "bool",
         "sql": "COALESCE(step7_done_date IS NOT NULL AND FLOOR(EXTRACT(EPOCH FROM (step7_done_date::timestamp - first_visit::timestamp)) / 86400) <= :ON_TIME_DAYS, FALSE)"},
    ],
}


def ratio(name, ident, title, num_sql, den_sql, meta, num_filter=None, den_filter=None, kind="sum"):
    num = {"name": f"{name}_numerator", "type": kind}
    den = {"name": f"{name}_denominator", "type": kind}
    if num_sql:
        num["sql"] = num_sql
    if den_sql:
        den["sql"] = den_sql
    if num_filter:
        num["filters"] = [{"sql": num_filter}]
    if den_filter:
        den["filters"] = [{"sql": den_filter}]
    return [
        {"name": name, "title": title, "type": "number",
         "sql": f"100.0 * {{{name}_numerator}} / NULLIF({{{name}_denominator}}, 0)",
         "meta": {"indicator": ident, "unit": "%", **meta}},
        num, den,
    ]


measures = []
measures += ratio("sf_p1", "SF_P1", "Meeting regularity", "{CUBE}.verified_weeks", "{CUBE}.active_weeks", {
    "category": "Delivery", "prominence": "Top", "direction": "higher", "bands": [80, 60], "target": 80,
    "label": "Meeting regularity", "headline": 1, "order": 1, "flw_applicable": True, "benchmarkable": True,
    "plain": "Of the weeks each community has been active, the share with at least one verified community meeting.",
    "scope_note": "PDD §8.1 P1 — target ≥ 80%."})
measures += ratio("sf_p3", "SF_P3", "On-time step progression", None, None, {
    "category": "Progression", "prominence": "Top", "direction": "higher", "bands": [75, 50], "target": 75,
    "label": "Step 7 on time", "headline": 2, "order": 1, "flw_applicable": True, "benchmarkable": True,
    "plain": "Of enrolled communities, the share that completed Step 7 within 15 weeks of their first meeting — reported, not paid on.",
    "scope_note": "PDD §8.1 P3 — target ≥ 75%, reported not priced (§7.4)."},
    num_filter="{CUBE}.completed_on_time", kind="count")
measures += ratio("sf_s1", "SF_S1", "Household attendance", "{CUBE}.hh_represented_sum", "{CUBE}.hh_enrolled_sum", {
    "category": "Participation", "prominence": "Top", "direction": "higher", "label": "Household attendance", "order": 1,
    "flw_applicable": True, "benchmarkable": True,
    "plain": "Households represented at verified meetings, out of the community's enrolled households.",
    "scope_note": "PDD §8.2 S1 (Spark's own definition). The PDD sets no target."})
measures += ratio("sf_s2", "SF_S2", "Female attendance", "{CUBE}.female_attended_sum", "{CUBE}.attended_sum", {
    "category": "Participation", "prominence": "Top", "direction": "higher", "label": "Women attending", "headline": 3, "order": 2,
    "flw_applicable": True, "benchmarkable": True,
    "plain": "Of everyone attending verified meetings, the share who were women.",
    "scope_note": "PDD §8.2 S2. The PDD sets no target."})
measures += ratio("sf_s3", "SF_S3", "Overall participation", "{CUBE}.spoke_sum", "{CUBE}.attended_sum", {
    "category": "Participation", "prominence": "Top", "direction": "higher", "label": "Spoke up", "order": 3,
    "flw_applicable": True, "benchmarkable": True,
    "plain": "Of everyone attending verified meetings, the share who spoke.",
    "scope_note": "PDD §8.2 S3. The PDD sets no target."})
measures += ratio("sf_s4", "SF_S4", "Female participation", "{CUBE}.female_spoke_sum", "{CUBE}.female_attended_sum", {
    "category": "Participation", "prominence": "Top", "direction": "higher", "label": "Women who spoke", "headline": 4, "order": 4,
    "flw_applicable": True, "benchmarkable": True,
    "plain": "Of the women attending verified meetings, the share who spoke.",
    "scope_note": "PDD §8.2 S4. The PDD sets no target."})
measures += ratio("sf_s5", "SF_S5", "Communities saving", None, None, {
    "category": "Progression", "prominence": "Lower", "direction": "higher", "label": "Saving", "order": 2,
    "flw_applicable": False, "benchmarkable": True,
    "plain": "Of communities on Step 5 or later, the share whose latest meeting reported the community is saving.",
    "scope_note": "PDD §8.2 S5 — denominator restricted to Step 5+ (§5.5). The PDD sets no target."},
    num_filter="{CUBE}.saving_now", den_filter="{CUBE}.reached_step5", kind="count")
measures += ratio("sf_s6", "SF_S6", "Verified share of records", "{CUBE}.verified_meetings", "{CUBE}.num_records", {
    "category": "Delivery", "prominence": "Top", "direction": "higher", "label": "Verified share", "order": 2,
    "flw_applicable": True, "benchmarkable": True,
    "plain": "Of every meeting record filed (held or not, community or committee), the share that is a verified community meeting.",
    "scope_note": "PDD §8.2 S6. The PDD sets no target."})
measures += ratio("sf_d1", "SF_D1", "Repeat-count flag rate", "{CUBE}.repeat_flag_records", "{CUBE}.verified_meetings", {
    "category": "Data quality", "prominence": "Top", "direction": "lower", "label": "Repeat counts", "headline": 5, "order": 1,
    "flw_applicable": True, "benchmarkable": True,
    "plain": "Of verified meetings, the share whose attendance counts exactly repeat the previous meeting's — a review flag, not a rejection.",
    "scope_note": "PDD §5.4 repeat_counts_flag; S-1 review stratum (§7.2). The PDD sets no threshold."})
measures += ratio("sf_d2", "SF_D2", "Location review flag rate", "{CUBE}.location_flag_records", "{CUBE}.num_records", {
    "category": "Data quality", "prominence": "Lower", "direction": "lower", "label": "Location flags", "order": 2,
    "flw_applicable": True, "benchmarkable": True,
    "plain": "Of meeting records, the share whose location was worse than 50 m or more than 2 km from the community — reviewed, never a payment condition.",
    "scope_note": "PDD §5.6 location_review_flag; S-1 review stratum (§7.2). The PDD sets no threshold."})

indicators = {
    "version": 1,
    "cube": "spark_facilitator_community",
    "description": "One row per community (the followed entity, PDD §6). Indicators from PDD §8 and the review signals of §5.4/§5.6/§7.2.",
    "defaults": {"min_denominator": 1},
    "series": ["SF"],
    "display": {
        "title": "Spark facilitator programme (synthetic)",
        "entity": {"name": "community", "plural": "communities"},
        "worker": {"name": "facilitator", "plural": "facilitators"},
        "organisation": {"name": "partner", "plural": "partners"},
        "categories": ["Delivery", "Progression", "Participation", "Data quality"],
        "headline_count": 5,
        "case_fields": [
            {"field": "step_number", "label": "FCAP step", "format": "count"},
            {"field": "enrolled_households", "label": "Households enrolled", "format": "count"},
            {"field": "first_visit_date", "label": "First meeting", "format": "date"},
            {"field": "last_visit_date", "label": "Latest meeting", "format": "date"},
            {"field": "total_visits", "label": "Records", "format": "count"},
        ],
        "reading": {"column": "female_participants", "label": "Women who spoke", "unit": "people"},
        "targets_note": "Targets are the PDD's own (§8.1 P1 ≥ 80%, P3 ≥ 75%). Spark's participation indicators carry no target in the PDD, so they are shown without one. Synthetic data.",
    },
    "measures": measures,
}

deployment = {"version": 1}
if len(sys.argv) > 1:
    deployment["llo_map"] = json.loads(sys.argv[1])

json.dump({"properties_doc": props, "indicators_doc": indicators, "deployment": deployment}, open(sys.argv[2] if len(sys.argv) > 2 else 'registry.json', 'w'), indent=1)
print("ok", len(measures))
