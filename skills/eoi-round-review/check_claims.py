#!/usr/bin/env python3
"""Check an eoi-round-review batch's reviews before they go to labs.

Usage:
    python3 check_claims.py <batch.json> <out.json> <criteria.json>

batch.json    the batch the scorer was given:
              [{response_id, org_name, org_slug, earlier_submissions,
                labs_history, answers: [{question_id, question, answer}]}]
out.json      the scorer's reviews for that batch:
              [{response_id, org_name, criteria_scores, claims, outcome, role,
                cost_per_site_usd, cost_note, ask_next, flags, one_line}]
criteria.json the round's saved criteria list ([{id, name, weight, ...}]);
              {"criteria": [...]} or a round with "evaluation_criteria" also works.

Prints every problem found, or "OK: every claim checks". Exits 1 on problems,
2 when a file cannot be read.

Quote matching mirrors labs' save-time check: lowercase, map curly quotes and
en/em dashes to their plain forms, collapse runs of whitespace, then a plain
substring test against the answer the cite's question_id names. A quote that
passes here can still be refused by labs if labs changes its rule; one that
fails here would be refused.

Standard library only, so it runs anywhere python3 does.
"""

import json
import re
import sys

OUTCOMES = ("pick", "backup", "waitlist", "pass")
ABOUT_FIXED = ("strength", "concern", "flag", "outcome")
BASES = ("quoted", "synthesized")

_CHAR_MAP = str.maketrans({
    "‘": "'", "’": "'",
    "“": '"', "”": '"',
    "–": "-", "—": "-",
})
_WS = re.compile(r"\s+")


def normalise(text):
    """Labs' quote normalisation: lowercase, plain quotes and dashes, one space."""
    return _WS.sub(" ", str(text).translate(_CHAR_MAP).lower()).strip()


def load(path, what):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"cannot read {what} {path}: {exc}", file=sys.stderr)
        sys.exit(2)


def criteria_ids(raw):
    if isinstance(raw, dict):
        raw = raw.get("criteria", raw.get("evaluation_criteria", []))
    ids = []
    for c in raw or []:
        cid = c.get("id") if isinstance(c, dict) else None
        if cid:
            ids.append(cid)
    return ids


def check_cite(where, cite, answers):
    problems = []
    if not isinstance(cite, dict):
        return [f"{where}: cite is not an object"]
    if "question" in cite:
        qid = cite["question"]
        if qid not in answers:
            return [f"{where}: question_id {qid!r} is not a question of this response"]
        if "quote" in cite:
            quote = cite["quote"]
            if not isinstance(quote, str) or not normalise(quote):
                problems.append(f"{where}: empty quote")
            elif normalise(quote) not in normalise(answers[qid]):
                problems.append(f"{where}: quote not found in answer {qid}: {quote!r}")
        elif not (cite.get("absent") is True or cite.get("whole") is True):
            problems.append(f"{where}: a question cite needs a quote, absent: true or whole: true")
    elif "source" in cite:
        source = cite["source"]
        if source == "web":
            if not cite.get("url"):
                problems.append(f"{where}: web cite has no url")
        elif source != "labs":
            problems.append(f"{where}: unknown source {source!r} (labs or web)")
        if not cite.get("detail"):
            problems.append(f"{where}: {source} cite has no detail")
    else:
        problems.append(f"{where}: cite names neither a question nor a source")
    return problems


def check_review(review, response, crit_ids):
    rid = review.get("response_id")
    problems = []
    answers = {a.get("question_id"): a.get("answer") or "" for a in response.get("answers", [])}

    scores = review.get("criteria_scores")
    if not isinstance(scores, dict):
        problems.append(f"{rid}: criteria_scores is missing")
        scores = {}
    for cid in crit_ids:
        score = scores.get(cid)
        if score is None:
            problems.append(f"{rid}: no score for criterion {cid}")
        elif isinstance(score, bool) or not isinstance(score, int) or not 1 <= score <= 10:
            problems.append(f"{rid}: score for {cid} is {score!r}, not a whole number 1-10")
    for cid in scores:
        if cid not in crit_ids:
            problems.append(f"{rid}: scores criterion {cid!r}, which is not on the round")

    outcome = review.get("outcome")
    if outcome not in OUTCOMES:
        problems.append(f"{rid}: outcome is {outcome!r}, not one of {'/'.join(OUTCOMES)}")

    claims = review.get("claims")
    if not isinstance(claims, list) or not claims:
        problems.append(f"{rid}: no claims")
        claims = []
    seen_ids = set()
    abouts = set()
    for n, claim in enumerate(claims):
        if not isinstance(claim, dict):
            problems.append(f"{rid} claim #{n + 1}: not an object")
            continue
        cl_id = claim.get("id")
        where = f"{rid} {cl_id or f'claim #{n + 1}'}"
        if not cl_id:
            problems.append(f"{where}: claim has no id")
        elif cl_id in seen_ids:
            problems.append(f"{where}: claim id is used twice")
        seen_ids.add(cl_id)
        about = claim.get("about")
        if about in ABOUT_FIXED:
            abouts.add(about)
        elif isinstance(about, str) and about.startswith("criterion:"):
            if about[len("criterion:"):] not in crit_ids:
                problems.append(f"{where}: about {about!r} names a criterion not on the round")
            abouts.add(about)
        else:
            problems.append(f"{where}: about is {about!r}")
        if not (claim.get("text") or "").strip():
            problems.append(f"{where}: claim has no text")
        if claim.get("basis") not in BASES:
            problems.append(f"{where}: basis is {claim.get('basis')!r}, not quoted or synthesized")
        cites = claim.get("cites", [])
        if not isinstance(cites, list):
            problems.append(f"{where}: cites is not a list")
            continue
        for k, cite in enumerate(cites):
            problems.extend(check_cite(f"{where} cite {k + 1}", cite, answers))

    for cid in crit_ids:
        if f"criterion:{cid}" not in abouts:
            problems.append(f"{rid}: no criterion:{cid} claim giving the reason for its score")
    if "outcome" not in abouts:
        problems.append(f"{rid}: no outcome claim")
    return problems


def check(batch, out, crit_ids):
    problems = []
    if not crit_ids:
        problems.append("criteria file has no criteria with an id")
    if not isinstance(out, list):
        return problems + ["out.json is not a list of reviews"]
    responses = {r.get("response_id"): r for r in batch}
    reviewed = {}
    for n, review in enumerate(out):
        if not isinstance(review, dict):
            problems.append(f"review #{n + 1}: not an object")
            continue
        rid = review.get("response_id")
        if rid not in responses:
            problems.append(f"review #{n + 1}: response_id {rid!r} is not in the batch")
            continue
        if rid in reviewed:
            problems.append(f"{rid}: reviewed twice")
            continue
        reviewed[rid] = review
        problems.extend(check_review(review, responses[rid], crit_ids))
    for rid in responses:
        if rid not in reviewed:
            problems.append(f"{rid}: in the batch but not reviewed")
    return problems


def main(argv):
    if len(argv) != 4:
        print("usage: python3 check_claims.py <batch.json> <out.json> <criteria.json>", file=sys.stderr)
        return 2
    batch = load(argv[1], "batch")
    out = load(argv[2], "reviews")
    crit_ids = criteria_ids(load(argv[3], "criteria"))
    if not isinstance(batch, list):
        print("batch.json is not a list of responses", file=sys.stderr)
        return 2
    problems = check(batch, out, crit_ids)
    if problems:
        for p in problems:
            print(p)
        print(f"{len(problems)} problem(s)")
        return 1
    print("OK: every claim checks")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
