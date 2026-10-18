#!/usr/bin/env python3
"""How well did the round's rubric serve the review? Run after the AI first pass
and calibration (and again once people have reviewed in labs).

Usage:
    python3 rubric_health.py <round.json> <reviews.json> [--calibration calibration.json]
                             [--json health.json]

round.json        marketplace_round_responses(slug=...) output (or its "round"
                  object): evaluation_criteria with ids and weights.
reviews.json      the round's reviews as labs returns them from list_reviews:
                  a list of reviews, or {response_id: [reviews]}, or
                  {response_id: {"reviews": [...]}}. AI reviews are kind "ai";
                  people's are kind "human" with based_on / stance.
calibration.json  optional, written by the calibrating agent (step 8):
                  {"changes": [{"response_id", "field": "outcome" | "score:<id>",
                                "before", "after", "why"}]}

Prints a markdown report to stdout; --json also writes the numbers. Every
recommendation carries the numbers it rests on, and the rules that produce
it are the constants below, so a reader can disagree with a threshold rather
than with a verdict. The agent running the step reads this and writes the
final keep / reweight / split / drop / add list in the report; the script's
list is the starting point, not the decision.

Standard library only.
"""

import argparse
import json
import math
import re
import sys
from collections import Counter, defaultdict

OUTCOMES = ("pick", "backup", "waitlist", "pass")
SELECTED = ("pick", "backup")

# Thresholds behind the recommendations.
BUNCHED_SD = 1.5          # sd below this: the criterion barely spreads the pool
BUNCHED_SHARE = 0.6       # or this share of scores sits on 3 adjacent values
WEAK_AUC = 0.65           # selected-vs-pass AUC below this separates little
STRONG_AUC = 0.85
REDUNDANT_R = 0.7         # |Pearson r| at or above this: the pair scores alike
OVER_INFLUENCE = 1.3      # effective weight / nominal weight above this
UNDER_INFLUENCE = 0.7
THIN_EVIDENCE = 0.4       # share of scores that are a low score for a missing answer
LOW_SCORE = 3             # at or below this, a score "for a missing answer" counts

# A claim whose text says something is missing ("gives no price", "does not
# name") rests on absence even when it quotes the answer that is silent.
_NEGATION = re.compile(
    r"\b(no|not|none|nothing|never|without|lacks?|missing|absent|silent|n/a|"
    r"does not|did not|doesn't|cannot|can't|unclear)\b", re.IGNORECASE)
_SILENT = re.compile(r"^\s*silent\s*:", re.IGNORECASE)

# What an outcome claim says the decision turned on, beyond the score.
OVERRIDE_REASONS = {
    "slot or geography": re.compile(
        r"\b(behind|ahead of|covers?|second|third|slot|(pick|backup) for|"
        r"outside (the )?priority|region)\b", re.IGNORECASE),
    "rescoping or cost": re.compile(
        r"\b(conditional|rescop\w*|cut to|must be cut|one site within|provided)\b",
        re.IGNORECASE),
    "safety or scope": re.compile(r"\b(safe|safety|scrap-yard|smelt\w*|scope)\b", re.IGNORECASE),
}


# ---------- loading ----------

def load(path, what):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"cannot read {what} {path}: {exc}", file=sys.stderr)
        sys.exit(2)


def criteria_of(raw):
    if isinstance(raw, dict) and isinstance(raw.get("round"), dict):
        raw = raw["round"]
    if isinstance(raw, dict):
        raw = raw.get("evaluation_criteria", raw.get("criteria", []))
    return [c for c in raw or [] if isinstance(c, dict) and c.get("id")]


def reviews_of(raw):
    if isinstance(raw, list):
        return [r for r in raw if isinstance(r, dict)]
    out = []
    for value in (raw or {}).values():
        if isinstance(value, dict):
            value = value.get("reviews", [])
        out.extend(r for r in value or [] if isinstance(r, dict))
    return out


# ---------- statistics ----------

def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def sd(xs):
    if len(xs) < 2:
        return 0.0
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def pearson(xs, ys):
    if len(xs) < 3:
        return float("nan")
    mx, my = mean(xs), mean(ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    return sxy / math.sqrt(sxx * syy) if sxx and syy else float("nan")


def auc(high, low):
    """P(a random 'high' scores above a random 'low'), ties count half."""
    if not high or not low:
        return float("nan")
    wins = sum(1.0 if h > lo else 0.5 if h == lo else 0.0 for h in high for lo in low)
    return wins / (len(high) * len(low))


def bunched_share(xs):
    """Largest share of scores on any 3 adjacent values."""
    if not xs:
        return 0.0
    c = Counter(xs)
    return max(sum(c.get(v + k, 0) for k in range(3)) for v in range(1, 9)) / len(xs)


def fmt(x, nd=2):
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:.{nd}f}"


# ---------- analysis ----------

def evidence_profile(review, cid):
    """How a criterion's score was evidenced in one review."""
    claims = [c for c in review.get("claims") or [] if c.get("about") == f"criterion:{cid}"]
    if not claims:
        return "no claim"
    kinds = set()
    for cl in claims:
        cites = cl.get("cites") or []
        if cl.get("basis") == "synthesized":
            kinds.add("synthesized")
        if any(c.get("absent") for c in cites):
            kinds.add("absent")
        if cites and all(c.get("whole") or c.get("absent") for c in cites):
            kinds.add("no exact passage")
        if not cites:
            kinds.add("no cite")
        if _NEGATION.search(cl.get("text") or "") or _SILENT.match(cl.get("text") or ""):
            kinds.add("rests on what is missing")
    return kinds or {"quoted passage"}


def analyse(criteria, reviews, calibration=None):
    ids = [c["id"] for c in criteria]
    weight = {c["id"]: float(c.get("weight") or 0) for c in criteria}
    ai = [r for r in reviews if r.get("kind") == "ai" and isinstance(r.get("criteria_scores"), dict)]
    ai = [r for r in ai if all(isinstance(r["criteria_scores"].get(i), (int, float)) for i in ids)]
    by_id = {r.get("id"): r for r in reviews}
    total_w = sum(weight.values()) or 1.0

    def weighted(r):
        return sum(weight[i] * r["criteria_scores"][i] for i in ids) / total_w * 10

    totals = [weighted(r) for r in ai]
    outcomes = Counter(r.get("outcome") or "none" for r in ai)
    sel = [r for r in ai if r.get("outcome") in SELECTED]
    passed = [r for r in ai if r.get("outcome") == "pass"]
    picks = [r for r in ai if r.get("outcome") == "pick"]

    per = {}
    var_t = sd(totals) ** 2
    for i in ids:
        xs = [r["criteria_scores"][i] for r in ai]
        cov = (sum((x - mean(xs)) * (t - mean(totals)) for x, t in zip(xs, totals)) / (len(xs) - 1)
               if len(xs) > 1 else 0.0)
        # share of the weighted score's spread this criterion produces
        eff = (weight[i] / total_w * 10) * cov / var_t if var_t else float("nan")
        ev = Counter()
        thin = strict = 0
        for r in ai:
            kinds = evidence_profile(r, i)
            if isinstance(kinds, str):
                ev[kinds] += 1
                continue
            for k in kinds:
                ev[k] += 1
            if kinds & {"synthesized", "absent", "no exact passage", "no cite"}:
                strict += 1
            if (r["criteria_scores"][i] <= LOW_SCORE
                    and kinds & {"absent", "no exact passage", "no cite", "rests on what is missing"}):
                thin += 1
        per[i] = {
            "weight": weight[i],
            "n": len(xs),
            "mean": mean(xs),
            "sd": sd(xs),
            "min": min(xs) if xs else None,
            "max": max(xs) if xs else None,
            "histogram": {v: xs.count(v) for v in range(1, 11)},
            "bunched_share": bunched_share(xs),
            "mean_pick": mean([r["criteria_scores"][i] for r in picks]),
            "mean_selected": mean([r["criteria_scores"][i] for r in sel]),
            "mean_pass": mean([r["criteria_scores"][i] for r in passed]),
            "auc_selected_vs_pass": auc([r["criteria_scores"][i] for r in sel],
                                        [r["criteria_scores"][i] for r in passed]),
            "effective_weight": eff,
            "influence_ratio": eff / (weight[i] / total_w) if weight[i] and not math.isnan(eff) else float("nan"),
            "evidence": dict(ev),
            "thin_evidence_share": thin / len(ai) if ai else 0.0,
            "no_passage_share": strict / len(ai) if ai else 0.0,
        }

    corr = {}
    for a in range(len(ids)):
        for b in range(a + 1, len(ids)):
            xa = [r["criteria_scores"][ids[a]] for r in ai]
            xb = [r["criteria_scores"][ids[b]] for r in ai]
            corr[f"{ids[a]}|{ids[b]}"] = pearson(xa, xb)

    # Outcome decisions the weighted score alone does not explain: a response
    # given a better outcome than one that scored higher ("promoted"), and the
    # higher scorers it went ahead of ("passed over").
    rank = sorted(ai, key=weighted, reverse=True)
    order = {o: n for n, o in enumerate(OUTCOMES)}

    def outcome_text(r):
        return " ".join(c.get("text") or "" for c in r.get("claims") or [] if c.get("about") == "outcome")

    def reasons_in(text):
        return [k for k, rx in OVERRIDE_REASONS.items() if rx.search(text)] or ["not stated"]

    overrides = []
    for r in ai:
        o = r.get("outcome")
        if o not in order:
            continue
        over = [x for x in ai if x.get("outcome") in order
                and order[x["outcome"]] > order[o] and weighted(x) > weighted(r)]
        if not over:
            continue
        overrides.append({
            "response_id": r.get("response_id"),
            "outcome": o,
            "weighted": weighted(r),
            "rank": rank.index(r) + 1,
            "went_ahead_of": [{"response_id": x.get("response_id"), "outcome": x.get("outcome"),
                               "weighted": weighted(x), "reasons": reasons_in(outcome_text(x))}
                              for x in sorted(over, key=weighted, reverse=True)],
            "reasons": reasons_in(outcome_text(r)),
            "outcome_claim": outcome_text(r),
        })
    passed_over = {x["response_id"]: x for o in overrides for x in o["went_ahead_of"]}
    reason_counts = Counter(k for x in passed_over.values() for k in x["reasons"])
    # Overlap of the top-N by score with the picks + backups, N = their count.
    top = {r.get("response_id") for r in rank[:len(sel)]}
    overlap = len(top & {r.get("response_id") for r in sel})

    # Human reviews against the AI review they started from.
    humans = []
    for h in reviews:
        if h.get("kind") != "human":
            continue
        base = by_id.get(h.get("based_on"))
        row = {"response_id": h.get("response_id"), "stance": h.get("stance") or "none",
               "outcome_before": base.get("outcome") if base else None,
               "outcome_after": h.get("outcome"), "deltas": {}}
        if base and isinstance(h.get("criteria_scores"), dict):
            for i in ids:
                a, b = base["criteria_scores"].get(i), h["criteria_scores"].get(i)
                if isinstance(a, (int, float)) and isinstance(b, (int, float)) and a != b:
                    row["deltas"][i] = b - a
        humans.append(row)
    human_by_crit = defaultdict(list)
    for h in humans:
        for i, d in h["deltas"].items():
            human_by_crit[i].append(d)

    cal = {"preserved": calibration is not None, "outcome_changes": 0, "score_changes": Counter()}
    if calibration:
        for ch in calibration.get("changes", []):
            f = str(ch.get("field", ""))
            if f == "outcome":
                cal["outcome_changes"] += 1
            elif f.startswith("score:"):
                cal["score_changes"][f[6:]] += 1
    cal["score_changes"] = dict(cal["score_changes"])

    recs = recommend(ids, per, corr, reason_counts, overrides, human_by_crit)
    return {
        "criteria": ids, "n_ai": len(ai), "outcomes": dict(outcomes),
        "weighted": {"mean": mean(totals), "sd": sd(totals), "min": min(totals) if totals else None,
                     "max": max(totals) if totals else None},
        "per_criterion": per, "correlations": corr,
        "overrides": overrides, "passed_over": len(passed_over),
        "override_reasons": dict(reason_counts),
        "top_by_score_vs_selected": {"n": len(sel), "overlap": overlap},
        "human": humans, "human_deltas_by_criterion": dict(human_by_crit),
        "calibration": cal, "recommendations": recs,
    }


def recommend(ids, per, corr, reason_counts, overrides, human_by_crit):
    recs = []
    redundant = [(k.split("|"), r) for k, r in corr.items() if not math.isnan(r) and abs(r) >= REDUNDANT_R]
    merged = set()
    for (a, b), r in redundant:
        weaker = a if (per[a]["auc_selected_vs_pass"] or 0) < (per[b]["auc_selected_vs_pass"] or 0) else b
        merged.add(weaker)
        recs.append({"criterion": weaker, "action": "drop",
                     "why": f"scores alike with {b if weaker == a else a} (r = {r:.2f}); keep the one that "
                            f"separates better (AUC {fmt(per[a]['auc_selected_vs_pass'])} vs "
                            f"{fmt(per[b]['auc_selected_vs_pass'])}) and fold the other into it"})
    for i in ids:
        p = per[i]
        if i in merged:
            continue
        bunched = p["sd"] < BUNCHED_SD or p["bunched_share"] >= BUNCHED_SHARE
        weak = not math.isnan(p["auc_selected_vs_pass"]) and p["auc_selected_vs_pass"] < WEAK_AUC
        strong = not math.isnan(p["auc_selected_vs_pass"]) and p["auc_selected_vs_pass"] >= STRONG_AUC
        thin = p["thin_evidence_share"] >= THIN_EVIDENCE
        ratio = p["influence_ratio"]
        nums = (f"sd {fmt(p['sd'])}, {p['bunched_share']:.0%} on 3 adjacent values, AUC "
                f"{fmt(p['auc_selected_vs_pass'])}, effective weight {fmt(p['effective_weight'] * 100, 0)}% "
                f"vs nominal {p['weight']:g}%, {p['thin_evidence_share']:.0%} of scores are low scores for a missing "
                f"answer")
        if bunched and weak:
            recs.append({"criterion": i, "action": "drop", "why": f"neither spreads nor separates: {nums}"})
        elif thin and strong:
            recs.append({"criterion": i, "action": "split",
                         "why": f"separates, but mostly by whether the form answer was empty: {nums}. "
                                "Split the part the form can show from the part that needs a follow-up "
                                "question, or add the question to the next form"})
        elif weak:
            recs.append({"criterion": i, "action": "reweight down", "why": nums})
        elif strong and not math.isnan(ratio) and ratio < UNDER_INFLUENCE:
            recs.append({"criterion": i, "action": "reweight up", "why": nums})
        elif not math.isnan(ratio) and ratio > OVER_INFLUENCE and not strong:
            recs.append({"criterion": i, "action": "reweight down",
                         "why": f"drives the total more than its weight says without separating well: {nums}"})
        else:
            recs.append({"criterion": i, "action": "keep", "why": nums})
        hd = human_by_crit.get(i)
        if hd and len(hd) >= 2 and abs(mean(hd)) >= 2:
            recs[-1]["why"] += f"; people moved it by {mean(hd):+.1f} on average across {len(hd)} reviews"
    for reason, n in reason_counts.items():
        if reason == "not stated":
            continue
        promoted = [o["response_id"] for o in overrides
                    if any(reason in x["reasons"] for x in o["went_ahead_of"])]
        recs.append({"criterion": None, "action": "add",
                     "why": f"{n} higher-scoring response(s) were placed below a lower scorer on {reason} "
                            f"(promoted: {', '.join(map(str, promoted))}); write it as an outcome rule in "
                            "criteria_basis, or as a criterion if it should score"})
    return recs


# ---------- report ----------

def report(h, criteria):
    names = {c["id"]: c.get("name", c["id"]) for c in criteria}
    ids = h["criteria"]
    out = []
    out.append(f"AI reviews analysed: {h['n_ai']}. Outcomes: "
               + ", ".join(f"{o} {h['outcomes'].get(o, 0)}" for o in OUTCOMES) + ".")
    w = h["weighted"]
    out.append(f"Weighted score: mean {fmt(w['mean'], 1)}, sd {fmt(w['sd'], 1)}, range "
               f"{fmt(w['min'], 0)}-{fmt(w['max'], 0)}.")
    out.append("")
    out.append("### Per criterion")
    out.append("")
    out.append("| Criterion | Weight | Mean | SD | Range | On 3 adjacent | Pick / selected / pass mean | AUC selected vs pass | Effective weight | No exact passage | Low score for a missing answer |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for i in ids:
        p = h["per_criterion"][i]
        out.append(f"| {i} | {p['weight']:g}% | {fmt(p['mean'], 1)} | {fmt(p['sd'], 1)} | {p['min']}-{p['max']} | "
                   f"{p['bunched_share']:.0%} | {fmt(p['mean_pick'], 1)} / {fmt(p['mean_selected'], 1)} / "
                   f"{fmt(p['mean_pass'], 1)} | {fmt(p['auc_selected_vs_pass'])} | "
                   f"{fmt(p['effective_weight'] * 100, 0)}% | {p['no_passage_share']:.0%} | "
                   f"{p['thin_evidence_share']:.0%} |")
    out.append("")
    out.append("Score histograms (1..10):")
    out.append("")
    for i in ids:
        hist = h["per_criterion"][i]["histogram"]
        out.append(f"- {i}: " + " ".join(f"{v}:{hist[v]}" for v in range(1, 11) if hist[v]))
    out.append("")
    out.append("### Correlation between criteria (Pearson r)")
    out.append("")
    out.append("| | " + " | ".join(ids) + " |")
    out.append("|---" * (len(ids) + 1) + "|")
    for a in ids:
        row = []
        for b in ids:
            if a == b:
                row.append("-")
            else:
                k = f"{a}|{b}" if f"{a}|{b}" in h["correlations"] else f"{b}|{a}"
                row.append(fmt(h["correlations"][k]))
        out.append(f"| {a} | " + " | ".join(row) + " |")
    out.append("")
    out.append("### What the slate turned on besides the score")
    out.append("")
    t = h["top_by_score_vs_selected"]
    out.append(f"Of the top {t['n']} by weighted score, {t['overlap']} are picks or backups. "
               f"{len(h['overrides'])} response(s) got a better outcome than a higher scorer, passing over "
               f"{h['passed_over']} response(s). What the passed-over responses' outcome claims say: "
               + (", ".join(f"{k} {v}" for k, v in h["override_reasons"].items()) or "none") + ".")
    out.append("")
    if h["overrides"]:
        out.append("| Promoted response | Outcome | Score (rank) | Went ahead of (score, outcome) | Its own outcome reason |")
        out.append("|---|---|---|---|---|")
        for o in sorted(h["overrides"], key=lambda o: o["rank"]):
            ahead = "; ".join(f"{x['response_id']} ({x['weighted']:.0f}, {x['outcome']})" for x in o["went_ahead_of"][:6])
            if len(o["went_ahead_of"]) > 6:
                ahead += f"; +{len(o['went_ahead_of']) - 6} more"
            out.append(f"| {o['response_id']} | {o['outcome']} | {o['weighted']:.0f} (#{o['rank']}) | {ahead} | "
                       f"{', '.join(o['reasons'])} |")
        out.append("")
    out.append("### Calibration and human reviews")
    out.append("")
    cal = h["calibration"]
    if cal["preserved"]:
        out.append(f"Calibration changed {cal['outcome_changes']} outcome(s) and scores on: "
                   + (", ".join(f"{k} {v}" for k, v in cal["score_changes"].items()) or "none") + ".")
    else:
        out.append("Calibration before/after was not preserved (no calibration.json), so what it changed "
                   "per criterion cannot be measured.")
    if h["human"]:
        st = Counter(x["stance"] for x in h["human"])
        out.append(f"Human reviews: {len(h['human'])} ({', '.join(f'{k} {v}' for k, v in st.items())}).")
        for x in h["human"]:
            d = ", ".join(f"{k} {v:+d}" for k, v in x["deltas"].items()) or "no score changes"
            out.append(f"- {x['response_id']}: {x['stance']}, outcome {x['outcome_before']} -> "
                       f"{x['outcome_after']}; {d}")
    else:
        out.append("No human reviews yet.")
    out.append("")
    out.append("### Recommendations (script's starting point)")
    out.append("")
    for r in h["recommendations"]:
        who = r["criterion"] or "outcome rules"
        out.append(f"- **{r['action']}** {who}: {r['why']}")
    return "\n".join(out) + "\n"


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("round")
    ap.add_argument("reviews")
    ap.add_argument("--calibration")
    ap.add_argument("--json")
    a = ap.parse_args(argv[1:])
    criteria = criteria_of(load(a.round, "round"))
    if not criteria:
        print("the round has no evaluation_criteria", file=sys.stderr)
        return 2
    reviews = reviews_of(load(a.reviews, "reviews"))
    cal = load(a.calibration, "calibration") if a.calibration else None
    h = analyse(criteria, reviews, cal)
    if h["n_ai"] == 0:
        print("no AI review scores every criterion; nothing to analyse", file=sys.stderr)
        return 2
    sys.stdout.write(report(h, criteria))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(h, fh, indent=2, default=str)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
