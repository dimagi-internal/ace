"""Link-verification receipts: a body may not be sent until its links have been OPENED.

The contract is `skills/_verify-before-send.md`. This module is its mechanism, and it is
deliberately shaped like canopy's pre-send review receipt: a receipt is keyed to the body's
exact bytes, so editing the body invalidates it.

WHY A RECEIPT RATHER THAN A CHECK AT SEND TIME. The send path cannot fetch pages itself —
it would need live sessions, it would be slow, and a failure there is discovered at the
worst possible moment. So verification is a separate, explicit act (`bin/ace-verify-links`)
that leaves evidence, and the send path checks only that the evidence exists and covers
this body and these recipients.

WHAT COUNTS AS VERIFIED (ace#3426, measured 2026-11-13):

    /labs/workflow/11988/run/                        -> 302, 0 bytes
    /labs/workflow/11988/run/?run_id=99999999&opp=…  -> 200, 177 KB, right title, NO data
    /labs/workflow/11988/run/?run_id=11990&opp=…     -> 200, 193 KB, the dashboard

The middle row is why a status code is never the test. A verified link is one that returned
200 AND contained a caller-declared string proving the content rendered. The caller has to
say what they expect to see, which is the part that cannot be faked by automation.

SCOPE. Only OUR OWN surfaces are gated (`GATED_HOSTS`): those are the ones with access
semantics a reader can fail, and the ones ACE actually sends. A link to a public third
party is not gated — ACE cannot authenticate it and a 403 there means nothing.

Not a script — imported by bin/ace-verify-links and bin/ace-email (they put bin/ on sys.path).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from urllib.parse import urlsplit

RECEIPT_DIR = os.environ.get(
    "ACE_LINK_RECEIPT_DIR", os.path.expanduser("~/.ace/link-receipts")
)

# The surfaces ACE's saved sessions can actually OPEN, which is also exactly where the
# measured failure class lives: a reader can be refused, mis-scoped, or shown an empty
# state on any of these, and ACE can see that happen before sending.
#
# DELIBERATELY ABSENT, and a known gap rather than an oversight:
#   * docs.google.com / drive.google.com — ACE reaches Drive through the gdrive MCP, not a
#     cookie jar, and "can they open it" there is a PERMISSIONS question
#     (`drive_list_permissions`), not a fetch. Gating them here would make the rail
#     unsatisfiable for the gdoc deliverables §1b requires, and an unsatisfiable rail gets
#     reverted. `share-run-access` owns that check; it is weaker, and it is named as weaker.
#   * canopy.dimagi.com — a PAT surface; a cookie fetch always lands on login, so a gate
#     here would fail every legitimate canopy link.
# `_check_canopy_urls` already gates canopy link SHAPE, which is the part a string can see.
GATED_HOSTS = (
    "labs.connect.dimagi.com",
    "connect.dimagi.com",
    "www.commcarehq.org",
)

# Empty states that render with HTTP 200. These EXPLAIN a failure; they do not define one —
# see `classify`, where the caller's expected string is the test and these are only used to
# say WHY it was absent. Deliberately not a veto: a 190 KB dashboard ships a JS bundle that
# can contain almost any phrase, so "the page mentions X" cannot mean "the page is empty".
# ("workflow definition" was briefly a veto here and failed a perfectly good dashboard.)
EMPTY_STATE_MARKERS = (
    "no workflows found",
    "not created",
    "no results found",
    "not found under opportunity",  # ace#2521: right workflow, wrong scope
    "you do not have permission",
    "page not found",
)

_URL = re.compile(r"https?://[^\s<>\"')\]]+", re.IGNORECASE)


def _strip_trailing_punctuation(url: str) -> str:
    """Sentence punctuation after a link is not part of it."""
    return url.rstrip(".,;:!?")


def extract_urls(text: str) -> list[str]:
    """Every distinct URL in `text`, in order of first appearance."""
    seen: list[str] = []
    for m in _URL.finditer(text or ""):
        url = _strip_trailing_punctuation(m.group(0))
        if url not in seen:
            seen.append(url)
    return seen


def is_gated(url: str) -> bool:
    """True when `url` points at one of our own surfaces, so it must be verified."""
    host = (urlsplit(url).hostname or "").lower()
    return any(host == h or host.endswith("." + h) for h in GATED_HOSTS)


def gated_urls(text: str) -> list[str]:
    return [u for u in extract_urls(text) if is_gated(u)]


def body_fingerprint(body: str) -> str:
    """The receipt key: the body's exact bytes.

    Same rationale as canopy's review receipt — a revised body is a different body, and a
    verification of the old one says nothing about the new one.
    """
    return hashlib.sha256((body or "").encode("utf-8")).hexdigest()


def receipt_path(fingerprint: str) -> str:
    return os.path.join(RECEIPT_DIR, f"{fingerprint}.json")


def normalise_recipients(values) -> list[str]:
    """Lower-cased, de-duplicated addresses from a list or a comma/space-separated string."""
    if values is None:
        return []
    if isinstance(values, str):
        values = re.split(r"[,\s]+", values)
    out: list[str] = []
    for v in values:
        addr = (v or "").strip().strip("<>").lower()
        # "Name <a@b.c>" -> a@b.c
        m = re.search(r"[^\s<>]+@[^\s<>]+", addr)
        if m:
            addr = m.group(0)
        if addr and addr not in out:
            out.append(addr)
    return out


_ACE_RUN_PAGE = re.compile(
    r"^(?P<origin>https?://[^/]+/ace)/opps/(?P<ws>[^/]+)/(?P<opp>[^/]+)/runs/(?P<run>[^/?#]+)/summary/?(?:[?#].*)?$"
)


def content_url(url: str) -> str:
    """The URL whose body actually carries what `url` shows a person.

    ace-web's public run page is a client-rendered shell: its static HTML is identical for
    every run id, so no `--expect` can distinguish a real run from a wrong one (ace#3429).
    The page loads its data from `/ace/api/opps/public/<ws>/<opp>/runs/<run>/summary`, which
    is run-specific and 404s on a wrong id, so that is the URL to open. Any other URL is
    returned unchanged.
    """
    m = _ACE_RUN_PAGE.match(url)
    if not m:
        return url
    return f"{m['origin']}/api/opps/public/{m['ws']}/{m['opp']}/runs/{m['run']}/summary"


def classify(status: int | None, body: str, expect: str | None) -> tuple[bool, str]:
    """(ok, why) for one fetched link.

    `expect` is the caller's declaration of what proves the content rendered. It is required
    for a gated link precisely because the automatable signals (status, title, size) are the
    ones that were measured to pass a broken page.
    """
    if status is None:
        return False, "could not be fetched"
    if 300 <= status < 400:
        return False, f"HTTP {status} — a redirect means the page you promised did not render"
    if status != 200:
        return False, f"HTTP {status}"
    if not expect:
        return False, "no --expect given: a 200 is not evidence, name the content you promised"
    low = (body or "").lower()
    if expect.lower() in low:
        # The content you promised is on the page. That is the whole test — an empty-state
        # phrase elsewhere in a large bundle does not override what you can actually see.
        return True, f"HTTP 200 and {expect!r} present ({len(body)} bytes)"
    hit = next((m for m in EMPTY_STATE_MARKERS if m in low), None)
    if hit:
        return False, f'HTTP 200 but {expect!r} is absent and the page says "{hit}" — an empty state'
    return False, f"HTTP 200 but {expect!r} is not on the page — this is the wrong-id shell case"


def write_receipt(
    *,
    body: str,
    recipients,
    results: list[dict],
    access: dict[str, str] | None = None,
    stamped_at: float | None = None,
) -> str:
    """Record that `body`'s gated links were opened. Returns the receipt path."""
    fp = body_fingerprint(body)
    os.makedirs(RECEIPT_DIR, exist_ok=True)
    payload = {
        "fingerprint": fp,
        "recipients": normalise_recipients(recipients),
        "results": results,
        "access": access or {},
        "verified_at": stamped_at if stamped_at is not None else time.time(),
        "all_ok": all(r.get("ok") for r in results) if results else True,
    }
    path = receipt_path(fp)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
    return path


def read_receipt(body: str) -> dict | None:
    path = receipt_path(body_fingerprint(body))
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def missing_coverage(body: str, recipients) -> tuple[str | None, dict | None]:
    """Why `body` may not be sent to `recipients`, or (None, receipt) when it may.

    Three ways to fail, in the order a sender hits them: never verified, verified but a link
    failed, verified for someone else.
    """
    urls = gated_urls(body)
    if not urls:
        return None, None
    receipt = read_receipt(body)
    if receipt is None:
        return "no link-verification receipt for this body", None
    verified = {r.get("url") for r in receipt.get("results", []) if r.get("ok")}
    unverified = [u for u in urls if u not in verified]
    if unverified:
        failed = {r.get("url"): r.get("why", "") for r in receipt.get("results", []) if not r.get("ok")}
        detail = "; ".join(f"{u} ({failed[u]})" if u in failed else u for u in unverified[:3])
        return f"these links are not verified-good: {detail}", receipt
    want = set(normalise_recipients(recipients))
    covered = set(receipt.get("recipients", []))
    uncovered = sorted(want - covered)
    if uncovered:
        return (
            "the verification did not cover "
            + ", ".join(uncovered)
            + " — access differs per person, so re-verify naming every recipient"
        ), receipt
    return None, receipt
