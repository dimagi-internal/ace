"""A labs workflow link a human can open is a RUN DEEP-LINK, never a bare one (ace#3418).

`https://labs.connect.dimagi.com/labs/workflow/<def>/run/` with no query string does
NOT open that dashboard. It resolves against whatever opportunity the reader happens to
have selected, so the reader lands on the workflow LIST — and on "No Workflows Found"
whenever their selection is not the opportunity the workflow belongs to. The link
returns a redirect, never an error, so it looks fine to whoever sent it.

`skills/demo-data-setup-qa/SKILL.md` had already recorded this as a verified-live trap
("`/run/?opportunity_id=` with no `run_id` → workflow LIST"). It was written down and
still shipped to a counterpart four times, because nothing checked the body of an email.
Hence a rail rather than another paragraph.

The shape that works is

    /labs/workflow/<def>/run/?run_id=<run>&opportunity_id=<opp>
    /labs/workflow/<def>/run/?run_id=<run>&program_id=<prog>     (program-owned dashboards)

with the scope parameter matching the dashboard's OWNERSHIP — an opp-owned dashboard
given `program_id` renders "not found", and vice versa. That half cannot be checked from
a string, so it stays `demo-data-setup-qa`'s job; this module checks only what is visible
in the URL, which is the half that reached a partner.

Measured 2026-11-13, signed in, on definition 11988 / run 11990 / opportunity 10174:

    /labs/workflow/11988/run/                                  -> HTTP 302, 0 bytes
    /labs/workflow/11988/run/?run_id=99999999&opportunity_id=10174
        -> HTTP 200 but no "Hanna colorimeter", no visit-count subtitle (a shell)
    /labs/workflow/11988/run/?run_id=11990&opportunity_id=10174
        -> HTTP 200, 193 KB, the dashboard with its data

Note the middle row: a 200 is not evidence a dashboard rendered. That is why the rail
refuses on the URL's SHAPE and never on a status code.

Not a script — imported by bin/ace-email (it puts bin/ on sys.path).
"""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urlsplit

LABS_HOSTS = ("labs.connect.dimagi.com",)

SCOPE_PARAMS = ("opportunity_id", "program_id")

_URL = re.compile(
    r"https?://(?:" + "|".join(re.escape(h) for h in LABS_HOSTS) + r")"
    r"/labs/workflow/(?P<rest>[^\s<>\"')\]]*)",
    re.IGNORECASE,
)


def _trailing_punctuation(url: str) -> str:
    """Sentence punctuation after a link is not part of it."""
    stripped = url.rstrip(".,;:!?")
    return url[len(stripped):]


def _defect(url: str) -> str | None:
    """Why `url` would not open its dashboard for a reader, or None if it is well-formed."""
    parts = urlsplit(url)
    path = parts.path.rstrip("/")
    segments = [s for s in path.split("/") if s]
    # /labs/workflow/api/... is a machine endpoint, not a link a human follows.
    if len(segments) >= 3 and segments[2].lower() == "api":
        return None
    # /labs/workflow/<def> with no /run/ renders the DEFINITION page, not a dashboard.
    if not path.lower().endswith("/run"):
        return "no /run/ — this renders the workflow definition page, not the dashboard"
    query = parse_qs(parts.query)
    if not query.get("run_id"):
        return "no run_id — this renders the workflow LIST for whatever opportunity the reader has selected"
    if not any(query.get(p) for p in SCOPE_PARAMS):
        return "no opportunity_id or program_id — the dashboard is not scoped to its owner"
    return None


def bare_workflow_urls(text: str) -> list[tuple[str, str]]:
    """Every labs workflow URL in `text` that would not open its dashboard.

    Returns (url, why) pairs, so a caller can say what is wrong with each one rather
    than printing a rule and leaving the reader to diff it by eye.
    """
    out: list[tuple[str, str]] = []
    for m in _URL.finditer(text):
        url = m.group(0)
        url = url[: len(url) - len(_trailing_punctuation(url))]
        why = _defect(url)
        if why:
            out.append((url, why))
    return out
