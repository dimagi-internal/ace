#!/usr/bin/env python3
"""Check that a proposed EOI rubric is explicit before it is saved to labs.

Usage:
    python3 check_rubric.py <rubric.json>

rubric.json   what eoi-criteria-proposal is about to pass to
              marketplace_round_criteria_set:
                {"criteria": [{id, name, weight, scoring_guide, rationale}],
                 "basis": "<criteria_basis text>"}
              A round as labs returns it ({"evaluation_criteria": [...],
              "criteria_basis": "..."}, or the whole marketplace_round_responses
              result with a "round" key) also works, so a saved rubric can be
              re-checked.

The rubric lives only in fields labs already stores:

- each criterion's `scoring_guide` holds its anchors, one per line:
      1: <what an answer at this level contains>
      3: ...
      5: ...
      7: ...
      10: ...
      Silent: <what to score, and how to cite it, when the answer says nothing>
  (labs scores 1-10, so the bottom anchor is 1);
- each criterion's `rationale` holds two labelled lines:
      Measures: <what the criterion measures>
      Separates: <why it separates THIS pool, with counts>
- `basis` (labs: `criteria_basis`) holds the outcome rules after a line
  "Outcome rules:", with one line each for Score, Slots, Pick, Backup,
  Waitlist, Pass and Overrides.

Prints every problem, or "OK: rubric is explicit". Exits 1 on problems, 2 when
the file cannot be read. Standard library only.
"""

import json
import re
import sys

ANCHORS = (1, 3, 5, 7, 10)
RATIONALE_LABELS = ("measures", "separates")
OUTCOME_LABELS = ("score", "slots", "pick", "backup", "waitlist", "pass", "overrides")
MIN_ANCHOR_WORDS = 5
MIN_CRITERIA, MAX_CRITERIA = 5, 8
_ID = re.compile(r"^[a-z][a-z0-9_]*$")
_LINE = re.compile(r"^\s*(?:[-*]\s*)?([A-Za-z]+|\d{1,2})\s*[:=.)-]\s*(.*\S)?\s*$")
# Words that judge an answer without saying what is in it. An anchor made only
# of these can't be applied the same way by two reviewers.
_VERDICT_ONLY = {"excellent", "good", "great", "strong", "weak", "poor", "adequate",
                 "fair", "average", "ok", "okay", "acceptable", "satisfactory",
                 "very", "somewhat", "quite", "some", "answer", "response", "the", "a",
                 "an", "is", "and", "or", "with", "of"}


def parse_labelled(text):
    """{label (lowercased str or int): value} for 'Label: value' lines."""
    found = {}
    for line in str(text or "").splitlines():
        m = _LINE.match(line)
        if not m:
            continue
        key, value = m.group(1), (m.group(2) or "").strip()
        found[int(key) if key.isdigit() else key.lower()] = value
    return found


def parse_anchors(scoring_guide):
    """{anchor score: text} and the silent rule, or ({}, None) when the guide is
    not in the anchored shape (e.g. an older banded '1-3: ...' guide)."""
    found = parse_labelled(scoring_guide)
    anchors = {k: v for k, v in found.items() if isinstance(k, int)}
    return anchors, found.get("silent")


def is_anchored(scoring_guide):
    anchors, _ = parse_anchors(scoring_guide)
    return all(a in anchors for a in ANCHORS)


def nearest_anchors(score):
    """The anchor(s) a score sits closest to (two on a tie)."""
    best = min(abs(score - a) for a in ANCHORS)
    return [a for a in ANCHORS if abs(score - a) == best]


def outcome_rules(basis):
    text = str(basis or "")
    m = re.search(r"outcome rules\s*:", text, re.IGNORECASE)
    if not m:
        return None
    return parse_labelled(text[m.end():])


def load_rubric(raw):
    if isinstance(raw, dict) and isinstance(raw.get("round"), dict):
        raw = raw["round"]
    if isinstance(raw, list):
        return raw, ""
    if not isinstance(raw, dict):
        return [], ""
    criteria = raw.get("criteria", raw.get("evaluation_criteria", []))
    basis = raw.get("basis", raw.get("criteria_basis", ""))
    return criteria or [], basis or ""


def check_anchor_text(where, text):
    words = re.findall(r"[A-Za-z0-9$%'/-]+", text or "")
    if len(words) < MIN_ANCHOR_WORDS:
        return [f"{where}: anchor is {len(words)} word(s); say what the answer contains"]
    if all(w.lower() in _VERDICT_ONLY for w in words):
        return [f"{where}: anchor judges the answer without saying what is in it"]
    return []


def check_criterion(c, n):
    cid = c.get("id") if isinstance(c, dict) else None
    where = cid or f"criterion #{n + 1}"
    if not isinstance(c, dict):
        return [f"{where}: not an object"]
    problems = []
    if not cid or not _ID.match(cid):
        problems.append(f"{where}: id must be a snake_case slug")
    if not (c.get("name") or "").strip():
        problems.append(f"{where}: no name")
    w = c.get("weight")
    if isinstance(w, bool) or not isinstance(w, (int, float)) or w != int(w) or w <= 0:
        problems.append(f"{where}: weight {w!r} is not a positive whole number")

    anchors, silent = parse_anchors(c.get("scoring_guide"))
    for a in ANCHORS:
        if a not in anchors:
            problems.append(f"{where}: scoring_guide has no anchor for {a}")
        else:
            problems.extend(check_anchor_text(f"{where} anchor {a}", anchors[a]))
    extra = sorted(set(anchors) - set(ANCHORS))
    if extra:
        problems.append(f"{where}: anchors {extra} are not {'/'.join(map(str, ANCHORS))}")
    texts = [anchors[a].lower() for a in ANCHORS if anchors.get(a)]
    if len(set(texts)) != len(texts):
        problems.append(f"{where}: two anchors have the same text")
    if not silent:
        problems.append(f"{where}: scoring_guide has no 'Silent:' rule for an answer that says nothing")
    elif not re.match(r"^\s*(10|[1-9])\b", silent):
        problems.append(f"{where}: the Silent rule must start with the score a silent answer gets (1-10)")

    found = parse_labelled(c.get("rationale"))
    for label in RATIONALE_LABELS:
        if not found.get(label):
            problems.append(f"{where}: rationale has no '{label.capitalize()}:' line")
    if found.get("separates") and not re.search(r"\d", found["separates"]):
        problems.append(f"{where}: 'Separates:' gives no count from the pool")
    return problems


def check(criteria, basis):
    problems = []
    if not isinstance(criteria, list) or not criteria:
        return ["no criteria"]
    if not MIN_CRITERIA <= len(criteria) <= MAX_CRITERIA:
        problems.append(f"{len(criteria)} criteria; propose {MIN_CRITERIA}-{MAX_CRITERIA}")
    ids = [c.get("id") for c in criteria if isinstance(c, dict)]
    for dup in sorted({i for i in ids if i and ids.count(i) > 1}):
        problems.append(f"{dup}: id used twice")
    for n, c in enumerate(criteria):
        problems.extend(check_criterion(c, n))
    weights = [c.get("weight") for c in criteria if isinstance(c, dict)]
    if all(isinstance(w, (int, float)) and not isinstance(w, bool) for w in weights):
        total = sum(weights)
        if total != 100:
            problems.append(f"weights sum to {total:g}, not 100")

    rules = outcome_rules(basis)
    if rules is None:
        problems.append("basis has no 'Outcome rules:' section")
    else:
        for label in OUTCOME_LABELS:
            if not rules.get(label):
                problems.append(f"outcome rules have no '{label.capitalize()}:' line")
    return problems


def main(argv):
    if len(argv) != 2:
        print("usage: python3 check_rubric.py <rubric.json>", file=sys.stderr)
        return 2
    try:
        with open(argv[1], encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"cannot read rubric {argv[1]}: {exc}", file=sys.stderr)
        return 2
    criteria, basis = load_rubric(raw)
    problems = check(criteria, basis)
    if problems:
        for p in problems:
            print(p)
        print(f"{len(problems)} problem(s)")
        return 1
    print("OK: rubric is explicit")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
