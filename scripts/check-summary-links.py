#!/usr/bin/env python3
"""Check every link on an ACE run-summary page and report whether each works.

Fetches the public run-summary payload
(<base>/api/opps/public/<workspace>/<slug>/runs/<run_id>/summary), recursively
extracts every URL — absolute http(s) AND page-relative (resolved against the
summary page URL, exactly as a browser would) — and HTTP-checks each one,
classifying results so a login-gated link (302→login / 401 / 403) counts as
REACHABLE (the link is valid, it just needs auth), while a 404 / 410 / 5xx /
DNS-failure is a BROKEN link.

TWO classes FAIL the run (non-zero exit): BROKEN, and PRIVATE-DELIVERABLE.

PRIVATE-DELIVERABLE is a Google Docs/Slides/Drive URL — i.e. a doc WE authored
as a deliverable — that is not shared. Anonymously it looks identical to a
third-party login wall (401/403 or a sign-in redirect), and it used to be
bucketed as AUTH-GATED and passed. It is not a pass: a platform login gate opens
for anyone with an account, whereas a private Google Doc opens only for accounts
explicitly shared on it, so the recipient of the summary link hits "You need
access." `skills/run-summary-qa` has said so in prose since ace#902; prose the
model has to remember is not enforcement (the ace#1060 shape), so it is a
distinct class with its own exit code here. Genuinely third-party auth walls
stay AUTH-GATED and still pass.
Origin: spark-facilitator/20260813-2126 reported "12 links - 0 BROKEN", exit 0,
while every one of its Google Doc deliverables 401'd anonymously.

Relative URLs matter for the same reason: `collect_urls` used to filter on
`v.startswith("http")`, so a root-relative link in the payload (the summary
footer's `workbench_url`, "See the full build process") was invisible to the
checker — and 404'd for every reader.

IMPORTANT — this probe is ANONYMOUS, so it can only prove a link is reachable to
*somebody*. Surfaces on MEMBER_GATED_HOSTS (CommCare HQ, OCS, Connect orgs) are
gated on MEMBERSHIP, not merely on sign-in: a user who is signed in but is not a
member of the domain/team/org gets a hard 404 (they deliberately don't leak the
existence of projects you can't see). Anonymously those links look identical to a
plain login gate, so they are reported as MEMBER-GATED — never as a clean pass —
and the caller must confirm the named reviewers actually hold membership (see
skills/share-run-access) before sharing. See dimagi-internal/ace#913.

Usage:
  scripts/check-summary-links.py <opp-slug> <run-id> [--workspace dimagi-team] \
      [--base https://labs.connect.dimagi.com/ace] [--json]

Exit code 0 iff no BROKEN and no PRIVATE-DELIVERABLE links; 1 if any of either;
2 on a fetch/parse error.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

# Field name -> the URL under it, collected with a human label for the report.
URL_KEYS = ("url", "hq_url", "nova_url", "ocs_url", "web_view_link", "slideshow_url")

# Hosts whose gate is MEMBERSHIP, not just sign-in. An anonymous probe sees a
# login redirect (indistinguishable from a plain login gate), but a signed-in
# NON-member gets a hard 404. Anonymous reachability therefore proves nothing
# about the reviewer we're about to share with — see ace#913.
# Matched as (host, path-prefix) — all three surfaces scope membership under
# /a/<domain-or-team-or-org>/. The path check matters: labs.connect.dimagi.com
# contains "connect.dimagi.com" but its /labs/... dashboards are merely
# login-gated (any CCHQ account reaches them), so they must NOT match here.
MEMBER_GATED = (
    ("commcarehq.org", "/a/"),      # HQ web-user on the project domain
    ("openchatstudio.com", "/a/"),  # OCS team membership
    ("connect.dimagi.com", "/a/"),  # Connect organization membership
)


# Hosts that serve ACE-AUTHORED deliverables (Docs, Slides, Sheets, Drive files:
# training deck, LLO/FLW guides, FAQ, onboarding email, open-questions,
# walkthrough video). A 401/403/sign-in-redirect on one of these is a
# PRIVATE-DELIVERABLE failure, not an AUTH-GATED pass — see the module docstring.
DELIVERABLE_HOSTS = ("docs.google.com", "drive.google.com")

# Classes that FAIL the check (non-zero exit).
FAILING_CLASSES = ("BROKEN", "PRIVATE-DELIVERABLE")

PRIVATE_DELIVERABLE_NOTE = (
    "ACE-authored Google deliverable is NOT shared - the recipient of the summary "
    "hits 'You need access'. Fix with drive_set_anyone_with_link (role reader or "
    "commenter), then re-check for OK 200"
)


def is_member_gated(url: str) -> bool:
    from urllib.parse import urlsplit

    parts = urlsplit(url)
    return any(
        parts.netloc.endswith(host) and parts.path.startswith(prefix)
        for host, prefix in MEMBER_GATED
    )


# ── Per-reviewer membership (dimagi-internal/ace#1060) ──────────────────
#
# MEMBER-GATED says "this link needs membership". It does NOT say whether the
# person we are about to send it to HAS that membership — and this script
# probes anonymously, so it cannot find out.
#
# For three runs that gap was covered by prose: the output told the reader to
# "confirm every named reviewer actually holds membership", and the confirming
# got done by an agent choosing to comply, at exactly the moment (about to send
# a reply) when it feels already-done. On 2026-07-23 that produced a written
# claim to an external partner — "you already had access there, so nothing to
# do" — that a read-back showed was false, and it stayed false for a week.
#
# What makes it worth automating: a reviewer without membership gets a flat
# 404, indistinguishable from "this run doesn't exist". It never reads as "you
# need access", so they report it as us shipping a broken link.
#
# This script does NOT grow three auth paths. The read-backs already exist —
# `scripts/grant-review-access.ts --dry-run` (HQ + OCS) and
# `lib/connect-member-table.ts` (Connect, ace#911). It consumes their results
# and REFUSES TO CERTIFY without them.

MEMBER_SURFACES = (
    ("commcarehq.org", "hq"),
    ("openchatstudio.com", "ocs"),
    ("connect.dimagi.com", "connect"),
)

#: Reviewer classes that block sharing. UNVERIFIED blocks too — "we did not
#: check" is not "it is fine", and treating it as fine is the whole bug.
REVIEWER_BLOCKING = ("MEMBER-MISSING", "MEMBER-UNVERIFIED")

READBACK_HINT = {
    "hq": "npx tsx scripts/grant-review-access.ts --dry-run (HQ role read-back)",
    "ocs": "npx tsx scripts/grant-review-access.ts --dry-run (OCS group read-back)",
    "connect": "connect_add_org_member's pre-read of /organization/member_table "
               "(lib/connect-member-table.ts)",
}


def member_surface(url: str):
    """Which read-back path can answer for this URL, or None if not gated."""
    from urllib.parse import urlsplit

    if not is_member_gated(url):
        return None
    host = urlsplit(url).netloc
    for suffix, surface in MEMBER_SURFACES:
        if host.endswith(suffix):
            return surface
    return None


def classify_reviewer(url: str, reviewer: str, memberships: dict):
    """(url, reviewer, read-back results) -> (class, note), or None.

    `memberships` is `{surface: {email: bool}}` as produced by the read-back
    tools above. A surface or email that is absent is UNVERIFIED, never OK.
    """
    surface = member_surface(url)
    if surface is None:
        return None
    known = (memberships or {}).get(surface, {})
    if reviewer not in known:
        return "MEMBER-UNVERIFIED", (
            f"no membership read-back for {reviewer} on {surface} - run "
            f"{READBACK_HINT[surface]} and pass the result via --memberships. "
            "Not checked is not the same as fine"
        )
    if known[reviewer]:
        return "MEMBER-OK", f"{reviewer} is a member of the {surface} surface"
    return "MEMBER-MISSING", (
        f"{reviewer} is NOT a member on {surface} - they will get a flat 404, "
        "indistinguishable from 'this run does not exist', and will report it as a "
        "broken link. Grant access before sharing (skills/share-run-access)"
    )


def is_ace_deliverable(url: str) -> bool:
    """True for a Google Docs/Slides/Sheets/Drive URL — a doc WE authored."""
    from urllib.parse import urlsplit

    return urlsplit(url).netloc.endswith(DELIVERABLE_HOSTS)


def looks_like_login(final_url: str) -> bool:
    low = (final_url or "").lower()
    return "login" in low or "accounts/login" in low or "oauth" in low


def classify(url: str, code, final_url: str = "") -> tuple[str, str]:
    """Pure classifier: (status_code, landing URL) -> (class, note).

    Split out of `check()` so the classification rules are unit-testable with
    no network. `code` is the HTTP status (or None for a transport failure);
    `final_url` is the URL actually landed on after redirects.
    """
    if code is None:
        return "BROKEN", f"unreachable ({final_url})" if final_url else "unreachable"
    if code in (401, 403) or (200 <= code < 400 and looks_like_login(final_url)):
        # Gated somehow. WHICH gate decides whether this passes.
        if is_ace_deliverable(url):
            return "PRIVATE-DELIVERABLE", PRIVATE_DELIVERABLE_NOTE
        if is_member_gated(url):
            return "MEMBER-GATED", (
                "requires membership, not just sign-in - a signed-in NON-member gets "
                "404; confirm the reviewer's membership before sharing"
            )
        if code in (401, 403):
            return "AUTH-GATED", "requires sign-in"
        return "AUTH-GATED", f"redirects to sign-in ({final_url[:60]})"
    if code in (404, 410):
        return "BROKEN", "not found"
    if code >= 500:
        return "BROKEN", "server error"
    if 200 <= code < 400:
        return "OK", ""
    return "REACHABLE", f"HTTP {code}"


def _is_url_key(key: str) -> bool:
    """Keys whose RELATIVE values are real links (not incidental slash-y strings)."""
    return key in URL_KEYS or key.endswith("_url") or key.endswith("_link")


def collect_urls(node, path="", base_url=""):
    """Recursively yield (label, url) for every URL in the payload.

    Absolute http(s) values are taken as-is. Page-RELATIVE values under a URL
    key are resolved against `base_url` (the summary page URL) exactly as a
    browser would — that is the only way the checker can see a link like
    `workbench_url: /w/<workspace>/opps/...`, which renders as an href on the
    page and 404s if the deployment path prefix is missing.
    """
    from urllib.parse import urljoin

    out = []
    if isinstance(node, dict):
        for k, v in node.items():
            label = f"{path}.{k}".lstrip(".")
            if isinstance(v, str) and v.startswith("http"):
                out.append((label, v))
            elif isinstance(v, str) and base_url and _is_url_key(k) and v.startswith("/"):
                out.append((label, urljoin(base_url, v)))
            else:
                out.extend(collect_urls(v, label, base_url))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out.extend(collect_urls(v, f"{path}[{i}]", base_url))
    return out


def check(url: str, timeout: float = 15.0):
    """Fetch `url` and return (status_code|None, classification, note).

    Transport only — every classification rule lives in `classify()`.
    """
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "ace-summary-qa/1"})
    try:
        # Redirects ARE followed: we want the landing status (a login redirect
        # resolves to 200 on the login page — the link itself is valid).
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            cls, note = classify(url, resp.getcode(), resp.geturl())
            return resp.getcode(), cls, note
    except urllib.error.HTTPError as e:
        cls, note = classify(url, e.code, getattr(e, "url", "") or "")
        return e.code, cls, note
    except urllib.error.URLError as e:
        return None, "BROKEN", f"unreachable ({e.reason})"
    except Exception as e:  # noqa: BLE001
        return None, "BROKEN", f"error ({type(e).__name__}: {e})"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("run_id")
    ap.add_argument("--workspace", default="dimagi-team")
    ap.add_argument("--base", default="https://labs.connect.dimagi.com/ace")
    ap.add_argument("--json", action="store_true")
    ap.add_argument(
        "--reviewer",
        action="append",
        default=[],
        help="Email of a named reviewer this summary is being prepared FOR. Repeatable. "
             "Every MEMBER-GATED link is then classified per reviewer, and an unverified "
             "or missing membership blocks the same way a BROKEN link does (ace#1060).",
    )
    ap.add_argument(
        "--memberships",
        help="Path to a JSON file of read-back results, {surface: {email: bool}} with "
             "surface in hq|ocs|connect. Produced by scripts/grant-review-access.ts "
             "--dry-run (HQ, OCS) and lib/connect-member-table.ts (Connect). Without it "
             "every reviewer is MEMBER-UNVERIFIED, which blocks.",
    )
    a = ap.parse_args()

    base = a.base.rstrip("/")
    summary_api = f"{base}/api/opps/public/{a.workspace}/{a.slug}/runs/{a.run_id}/summary"
    page_url = f"{base}/opps/{a.workspace}/{a.slug}/runs/{a.run_id}/summary"

    try:
        with urllib.request.urlopen(summary_api + "?force=1", timeout=20) as r:
            payload = json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        print(f"FAILED to fetch summary: {summary_api}\n  {e}", file=sys.stderr)
        return 2

    urls = collect_urls(payload, base_url=page_url)
    # de-dup while preserving order
    seen, uniq = set(), []
    for label, url in urls:
        if url not in seen:
            seen.add(url)
            uniq.append((label, url))

    results = []
    for label, url in uniq:
        code, cls, note = check(url)
        results.append({"label": label, "url": url, "status": code, "class": cls, "note": note})

    memberships = {}
    if a.memberships:
        try:
            with open(a.memberships, encoding="utf-8") as fh:
                memberships = json.load(fh)
        except Exception as e:  # noqa: BLE001
            print(f"FAILED to read --memberships {a.memberships}: {e}", file=sys.stderr)
            return 2

    # Per-reviewer verdicts on every member-gated link (ace#1060). Absent
    # --reviewer, behaviour is unchanged.
    reviewer_rows = []
    for r in results:
        for reviewer in a.reviewer:
            verdict = classify_reviewer(r["url"], reviewer, memberships)
            if verdict is None:
                continue
            cls, note = verdict
            reviewer_rows.append({"label": r["label"], "url": r["url"],
                                  "reviewer": reviewer, "class": cls, "note": note})
    reviewer_blocked = [r for r in reviewer_rows if r["class"] in REVIEWER_BLOCKING]

    broken = [r for r in results if r["class"] == "BROKEN"]
    private = [r for r in results if r["class"] == "PRIVATE-DELIVERABLE"]
    member_gated = [r for r in results if r["class"] == "MEMBER-GATED"]
    failed = broken + private + reviewer_blocked

    if a.json:
        print(json.dumps({"page_url": page_url, "checked": len(results),
                          "broken": len(broken), "private_deliverable": len(private),
                          "failed": len(failed), "member_gated": len(member_gated),
                          "reviewer_blocked": len(reviewer_blocked),
                          "reviewers": reviewer_rows,
                          "results": results}, indent=2))
    else:
        print(f"Run-summary link check — {a.slug}/{a.run_id}")
        print(f"Page: {page_url}")
        print(f"Checked {len(results)} links · {len(broken)} BROKEN · "
              f"{len(private)} PRIVATE-DELIVERABLE\n")
        for r in results:
            mark = {"OK": "✅", "AUTH-GATED": "🔒", "MEMBER-GATED": "👤",
                    "PRIVATE-DELIVERABLE": "🚫",
                    "REACHABLE": "➖", "BROKEN": "❌"}.get(r["class"], "?")
            code = r["status"] if r["status"] is not None else "—"
            print(f"  {mark} [{r['class']:<20}] {code!s:<4} {r['label']}")
            print(f"       {r['url']}" + (f"  ({r['note']})" if r["note"] else ""))
        if broken:
            print(f"\n❌ {len(broken)} BROKEN link(s) — fix before sharing:")
            for r in broken:
                print(f"   - {r['label']}: {r['url']} ({r['note']})")
        if private:
            print(f"\n🚫 {len(private)} PRIVATE ACE-AUTHORED DELIVERABLE(S) — "
                  "shared with nobody, so the recipient hits 'You need access'.")
            print("   These are OUR docs, not a third-party login wall. Share each one")
            print("   (drive_set_anyone_with_link — pass role='commenter' if the reviewer")
            print("   should be able to leave feedback) and re-check for OK 200:")
            for r in private:
                print(f"   - {r['label']}: {r['url']}")
        if reviewer_rows:
            print(f"\n👤 Per-reviewer membership on {len(member_gated)} member-gated link(s):")
            for r in reviewer_rows:
                mark = "✅" if r["class"] == "MEMBER-OK" else "❌"
                print(f"   {mark} [{r['class']:<18}] {r['reviewer']} — {r['label']}")
                print(f"        {r['note']}")
        if reviewer_blocked:
            print(f"\n❌ {len(reviewer_blocked)} reviewer/link pair(s) NOT cleared to share.")
            print("   A reviewer without membership gets a flat 404 — indistinguishable from")
            print("   'this run does not exist' — and will report it as a broken link, which is")
            print("   exactly how ace#913 and ace#916 reached us (ace#1060).")
        if not failed and member_gated and not a.reviewer:
            print(f"\n✅ No broken or private links, but {len(member_gated)} link(s) are "
                  "MEMBER-GATED — NOT cleared to share yet.")
            print("   This probe is anonymous. Each of these 404s for a signed-in NON-member,")
            print("   so confirm every named reviewer actually holds membership (skills/share-run-access)")
            print("   or don't present the link to them as reviewer-facing:")
            for r in member_gated:
                print(f"   - {r['label']}: {r['url']}")
        if not failed and member_gated and a.reviewer:
            print("\n✅ No broken links, and every named reviewer's membership is verified.")
        if not failed and not member_gated:
            print("\n✅ No broken links — every summary link is reachable.")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
