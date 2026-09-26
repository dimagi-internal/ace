"""Spark facilitator synthetic programme: 3 partners x 12 CBFs x 1 community, 13 weeks.

Deliberate story signal (plan: test/fixtures/cascade/spark-facilitator-story.json).
What labs graded on the 20 Sep saved run (ace#2510 proof):
  lagging partner    Partner C  -- planned meetings recorded not-held from week 6 (PDD §5.4 codes): regularity 62% vs 95%
  standout worker    cbf_b03    -- women who spoke 72% vs <= 37% for every other CBF; reaches Step 7 first
  data quality       cbf_a07    -- identical attendance every meeting -> repeat_counts_flag 92% vs 0% (PDD §5.4 / §7.2 S-1)
  trend              Partner B  -- women attending (to date) 35% -> 45% across the 13 saved weekly runs
Every field path is the released Deliver app's (Nova ef133601, Community Meeting Record).

Mechanics worth copying (connect-labs generator, mirror mode):
  * the transplant pool is AUTHORED, not profiled: one series per followed entity, `owner` = its worker,
    so ownership, cadence and visit count are exact (synthetic slot mode draws a random entity per visit);
  * jitter_frac: 0 -- integer counts stay integers and a repeated count stays identical;
  * a categorical that never varies across an entity's visits is stamped onto ALL of them (incl. not-held
    records), so leave out constant answers that only belong on one branch;
  * with no form schema (labs-only opp) numeric-looking categoricals come back as "1.0" -- read them with
    CAST(... AS DECIMAL) in the registry, never `= '1'`.
"""
import datetime as dt, json, random, sys, yaml

START = dt.date(2026, 6, 22)  # Monday; 13 weeks through Sunday 2026-09-20
WEEKS = 13
FORM = "Community Meeting Record"
F = "form."


def community_series(rng, partner, idx):
    cbf = f"cbf_{partner.lower()}{idx:02d}"
    lag = partner == "C"
    standout = cbf == "cbf_b03"
    repeat = cbf == "cbf_a07"
    households = rng.randint(70, 240)
    start_offset = rng.choice([0, 0, 1, 2, 3])  # enrolment staggered over the first week
    step, idx_on_step = 1, 0
    visits = []
    rep_counts = None
    # meetings needed per step for this community (PDD: ~1.9 average)
    pace = 1.35 if standout else (2.3 if lag else rng.choice([1.6, 1.8, 1.9, 2.0, 2.1]))
    for w in range(WEEKS):
        day = w * 7 + start_offset
        if day > WEEKS * 7 - 1:
            break
        week = w + 1
        held_p = 0.95
        if lag and week >= 6:
            held_p = 0.45
        elif lag:
            held_p = 0.85
        if step > 7:
            break  # pilot complete: community leaves the meeting list
        base = {
            F + "step_number": step,
            F + "enrolled_households": households,
            F + "stored_index": idx_on_step,
        }
        loc_flag = "yes" if rng.random() < (0.12 if lag else 0.04) else "no"
        if rng.random() > held_p:
            reason = rng.choice(["poor_mobilization", "transport_difficulty", "community_delayed", "bad_weather"]) if not lag else rng.choice(["poor_mobilization", "poor_mobilization", "transport_difficulty"])
            visits.append({"day": day, "form": FORM, "values": base,
                           "dates": {F + "about_this_meeting.date_of_meeting": day, F + "why_not_held.reschedule_date": day + 7},
                           "cats": {F + "about_this_meeting.meeting_conducted": "no", F + "why_not_held.question2": reason,
                                    F + "meeting_kind": "not_held", F + "repeat_counts_flag": "no",
                                    F + "location_review_flag": loc_flag}})
            continue
        # a held community meeting
        idx_on_step += 1
        # female share of attendance
        if partner == "B":
            f_share = 0.34 + 0.018 * (week - 1) + rng.uniform(-0.03, 0.03)
        elif lag:
            f_share = rng.uniform(0.30, 0.38)
        else:
            f_share = rng.uniform(0.40, 0.48)
        if standout:
            f_share = max(f_share, 0.55)
        represented = int(households * (rng.uniform(0.35, 0.55) if lag else rng.uniform(0.55, 0.8)))
        attendees = max(8, int(represented * rng.uniform(0.9, 1.3)))
        female = int(round(attendees * f_share))
        male = attendees - female
        if repeat:
            if rep_counts is None:
                rep_counts = (male, female)
            male, female = rep_counts
        f_spoke_rate = 0.72 if standout else (0.22 if lag else rng.uniform(0.3, 0.4))
        m_spoke_rate = 0.45 if standout else (0.35 if lag else rng.uniform(0.35, 0.5))
        f_spoke = min(female, int(round(female * (f_spoke_rate + rng.uniform(-0.04, 0.04)))))
        m_spoke = min(male, int(round(male * (m_spoke_rate + rng.uniform(-0.04, 0.04)))))
        completes = rng.random() < (1.0 / pace) or idx_on_step >= 4
        capped = min(idx_on_step, 3)
        vals = dict(base)
        vals.update({
            F + "capped_index": capped,
            F + "who_came.hh_represented_at_the_meeting": min(represented, households),
            F + "who_came.male_attendance": male,
            F + "who_came.female_attendance": female,
            F + "who_came.male_participants": m_spoke,
            F + "who_came.female_participants": f_spoke,
            F + "total_attendance": male + female,
            F + "total_participation": m_spoke + f_spoke,
            F + "meeting_details.male_leader_attendence": 0 if step < 2 else rng.randint(2, 6),
            F + "meeting_details.female_leader_attendence": 0 if step < 2 else rng.randint(1, 5),
        })
        cats = {
            F + "about_this_meeting.meeting_conducted": "yes",
            F + "about_this_meeting.meeting_type": "community_meeting",
            F + "meeting_kind": "community_meeting",
            F + "step_progress.step_completed": "yes" if completes else "no",
            F + "repeat_counts_flag": "yes" if (repeat and len([v for v in visits if v["cats"].get(F + "meeting_kind") == "community_meeting"]) > 0) else "no",
            F + "location_review_flag": loc_flag,
            F + "meeting_details.sparktrainer_attendance": "yes" if rng.random() < 0.2 else "no",
            F + "meeting_details.sedo_attendance": "yes" if rng.random() < 0.3 else "no",
            F + "meeting_details.meeting_on_time": "yes" if rng.random() < 0.8 else "no",
        }
        if step >= 5:
            saving = rng.random() < (0.5 if lag else 0.85)
            cats[F + "savings.currently_saving"] = "1" if saving else "2"
            if saving:
                cats[F + "savings.savings_use"] = rng.choice(["vsla", "independent_project", "mg_project"])
                vals[F + "savings.hh_saving"] = int(represented * rng.uniform(0.4, 0.8))
                vals[F + "savings.amt_savings"] = rng.randint(20, 400) * 1000
            else:
                cats[F + "savings.currently_not_saving"] = "1"
        visits.append({"day": day, "form": FORM, "values": vals,
                       "dates": {F + "about_this_meeting.date_of_meeting": day}, "cats": cats})
        if completes:
            step += 1
            idx_on_step = 0
        # an occasional committee meeting the same week (recorded, never payable)
        if rng.random() < 0.18 and day + 3 <= WEEKS * 7 - 1:
            visits.append({"day": day + 3, "form": FORM,
                           "values": {F + "step_number": min(step, 7), F + "enrolled_households": households, F + "stored_index": idx_on_step,
                                      F + "who_came.male_attendance": rng.randint(3, 8), F + "who_came.female_attendance": rng.randint(2, 7),
                                      F + "who_came.male_participants": 2, F + "who_came.female_participants": 2,
                                      F + "who_came.hh_represented_at_the_meeting": rng.randint(5, 12)},
                           "dates": {F + "about_this_meeting.date_of_meeting": day + 3},
                           "cats": {F + "about_this_meeting.meeting_conducted": "yes", F + "about_this_meeting.meeting_type": "committee_meeting",
                                    F + "meeting_kind": "committee_meeting", F + "repeat_counts_flag": "no", F + "location_review_flag": "no"}})
    return cbf, {"owner": cbf, "start_date": START.isoformat(), "visits": visits}


def manifest_for(partner, opp_id, seed):
    rng = random.Random(seed)
    personas, pool = [], []
    for i in range(1, 13):
        cbf, series = community_series(rng, partner, i)
        personas.append({"id": cbf, "display_name": f"CBF {partner}-{i:02d}", "archetype": "steady",
                         "accuracy_distribution": {"mean": 0.9, "stddev": 0.03},
                         "completeness_distribution": {"mean": 0.95, "stddev": 0.02}, "flag_rate": 0.02})
        pool.append(series)
    return {
        "opportunity_id": opp_id,
        "opportunity_name": f"[Synthetic] Spark facilitator - Partner {partner}",
        "random_seed": seed,
        "timeline": {"start_date": START.isoformat(), "end_date": (START + dt.timedelta(days=WEEKS * 7 - 1)).isoformat(),
                     "weeks": WEEKS, "visit_cadence_per_week_per_flw": {"mean": 1, "stddev": 0}},
        "flw_personas": personas,
        "beneficiary_cohorts": [{"id": "communities", "size": 12, "field_distributions": {}, "progression": "flat",
                                 "longitudinal": {"mode": "mirror", "jitter_frac": 0.0, "transplant_pool": pool}}],
        "anomalies": [],
        "kpi_config": [{"kpi": "meeting_held", "field_path": "form.about_this_meeting.meeting_conducted",
                        "aggregation": "non_null_rate", "threshold_underperform": 0.5}],
    }


if __name__ == "__main__":
    opps = {"A": 10082, "B": 10083, "C": 10084}
    for p, oid in opps.items():
        m = manifest_for(p, oid, 20260926 + ord(p))
        open(f"manifest_{p}.yaml", "w").write(yaml.safe_dump(m, sort_keys=False, allow_unicode=True))
        n = sum(len(s["visits"]) for s in m["beneficiary_cohorts"][0]["longitudinal"]["transplant_pool"])
        print(p, oid, "visits", n)
