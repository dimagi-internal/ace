"""The words a round's reviews are written in: outcomes and flags, with what each means.

A copy of connect-labs' `connect_labs/solicitations/vocabulary.py`, which is the
source of truth: labs refuses a review whose flags are not in FLAGS (it reads the
older free-text names in LEGACY_FLAGS as the flag they meant, but this skill
writes only the defined keys). Stored values are the short keys (`pick`,
`padded`); what a person reads is the label.

Standard library only; imported by check_claims.py and rubric_health.py.
"""

# What a review recommends for one applicant in one round. The keys are what
# labs stores and the API takes; the labels are what people read.
OUTCOMES = {
    "pick": {
        "label": "Recommended",
        "definition": "Proposed for one of the round's places now.",
    },
    "backup": {
        "label": "Backup",
        "definition": "Ready to step in for a named place if a recommended applicant falls through.",
    },
    "waitlist": {
        "label": "Keep in view",
        "definition": "Credible, but not needed for this round's places. Worth asking again in a later round.",
    },
    "pass": {
        "label": "Not recommended",
        "definition": "Not a fit for this round, for the reasons the review gives.",
    },
}
NO_OUTCOME = {"label": "No recommendation yet", "definition": "Nobody has reviewed it, or the review set no outcome."}
SHORTLIST = ("pick", "backup")

# Things a reviewer should check before relying on a response. A flag is not a
# verdict and costs no points: the criterion scores do that. Each names something
# checkable in the response, never a guess about how it was written (whether an
# applicant used AI is not a flag; what the answer contains is).
FLAGS = {
    "unsupported": {
        "label": "Claims to check",
        "definition": "Numbers, partners, licences or past work that look inflated or that nothing in the response or "
        "labs history backs up.",
    },
    "inconsistent": {
        "label": "Answers disagree",
        "definition": "Two answers in the same response contradict each other (dates, numbers, places, staff).",
    },
    "templated": {
        "label": "Shared or template text",
        "definition": "Placeholders left in, text near-identical to another applicant's, or the same response "
        "submitted twice.",
    },
    "padded": {
        "label": "Long but thin",
        "definition": "Answers the question at length with few checkable facts: restates the question, describes "
        "intentions rather than what they know or have done.",
    },
    "incomplete": {
        "label": "Incomplete",
        "definition": "A key answer is missing, cut off or does not address the question asked.",
    },
    "out-of-scope": {
        "label": "Outside the brief",
        "definition": "Proposes places, activities or a scale the call did not ask for.",
    },
    "capacity": {
        "label": "Thin capacity",
        "definition": "The work rests on one person, or on a team already committed elsewhere at the same time.",
    },
    "cost": {
        "label": "Cost out of line",
        "definition": "The quote is far from the others or from the call's budget, or cannot be compared with them.",
    },
    "early-start": {
        "label": "Starts before contract",
        "definition": "Plans to begin work before a contract is in place.",
    },
    "safety": {
        "label": "Safety",
        "definition": "The plan puts staff or respondents at risk without saying how.",
    },
}


def outcome_label(key):
    """What a person reads for an outcome key; "No recommendation yet" when unset or unknown."""
    return OUTCOMES.get(key, NO_OUTCOME)["label"]


def flag_label(key):
    return FLAGS[key]["label"] if key in FLAGS else key
