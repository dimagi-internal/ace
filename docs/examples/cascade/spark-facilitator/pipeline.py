"""Layer 1 for the Spark registry: the programme report's `visits` pipeline, one
field per form path the registry reads. Paths are the released Deliver app's
(Nova ef133601, Community Meeting Record). Pipeline 6370 / opp 10082 are the ids
from the ace#2510 proof (spark-facilitator/20260926-1800) — substitute your own.
Worked example for skills/demo-data-setup § Process (ace-run) step C3."""
import json, subprocess, sys
fields = [
    ("community_case_id", "form.case.@case_id", None),
    ("meeting_conducted", "form.about_this_meeting.meeting_conducted", None),
    ("meeting_type", "form.about_this_meeting.meeting_type", None),
    ("meeting_kind", "form.meeting_kind", None),
    ("step_number", "form.step_number", "int"),
    ("step_completed", "form.step_progress.step_completed", None),
    ("hh_represented", "form.who_came.hh_represented_at_the_meeting", "int"),
    ("enrolled_households", "form.enrolled_households", "int"),
    ("male_attendance", "form.who_came.male_attendance", "int"),
    ("female_attendance", "form.who_came.female_attendance", "int"),
    ("male_participants", "form.who_came.male_participants", "int"),
    ("female_participants", "form.who_came.female_participants", "int"),
    ("currently_saving", "form.savings.currently_saving", None),
    ("repeat_counts_flag", "form.repeat_counts_flag", None),
    ("location_review_flag", "form.location_review_flag", None),
]
schema = {
    "data_source": {"type": "connect_csv"},
    "grouping_key": "username",
    "terminal_stage": "visit_level",
    "fields": [dict(name=n, path=p, aggregation="first", **({"transform": t} if t else {})) for n, p, t in fields],
}
mode = sys.argv[1]
if mode == "preview":
    out = {"pipeline_id": 6370, "opportunity_id": 10082, "opportunity_ids": [10082, 10083, 10084], "sample_size": 5, "schema_override": schema}
else:
    out = {"pipeline_id": 6370, "opportunity_id": 10082, "schema": schema, "expected_version": int(sys.argv[2]),
           "name": "Community meeting records (Deliver app form paths)",
           "description": "One row per Community Meeting Record; paths from the released Spark Deliver app (Nova ef133601)."}
json.dump(out, open(f"pipe_{mode}.json", "w"))
print(json.dumps(schema)[:200])
