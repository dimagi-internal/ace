#!/usr/bin/env python3
"""Check every link on an ACE run-summary page and report whether each works.

Fetches the public run-summary payload
(<base>/api/opps/public/<workspace>/<slug>/runs/<run_id>/summary), recursively
extracts every http(s) URL, and HTTP-checks each one — classifying results so a
login-gated link (302→login / 401 / 403) counts as REACHABLE (the link is valid,
it just needs auth), while a 404 / 410 / 5xx / DNS-failure is a BROKEN link.

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

Exit code 0 iff no BROKEN links; 1 if any link is broken; 2 on a fetch/parse error.
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


def is_member_gated(url: str) -> bool:
    from urllib.parse import urlsplit

    parts = urlsplit(url)
    return any(
        parts.netloc.endswith(host) and parts.path.startswith(prefix)
        for host, prefix in MEMBER_GATED
    )


def collect_urls(node, path=""):
    """Recursively yield (label, url) for every http(s) URL in the payload."""
    out = []
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, str) and v.startswith("http"):
                out.append((f"{path}.{k}".lstrip("."), v))
            else:
                out.extend(collect_urls(v, f"{path}.{k}".lstrip(".")))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out.extend(collect_urls(v, f"{path}[{i}]"))
    return out


def check(url: str, timeout: float = 15.0):
    """Return (status_code|None, classification, note)."""
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "ace-summary-qa/1"})
    try:
        # allow_redirects: we WANT to see the landing status (a login redirect
        # resolves to 200 on the login page, which is fine — the link is valid).
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            code = resp.getcode()
            final = resp.geturl()
            note = ""
            if "login" in final.lower() or "accounts/login" in final.lower() or "oauth" in final.lower():
                if is_member_gated(url):
                    return code, "MEMBER-GATED", (
                        "sign-in redirect anonymously, but a signed-in NON-member gets 404 — "
                        "confirm the reviewer's membership before sharing"
                    )
                return code, "AUTH-GATED", f"redirects to sign-in ({final[:60]})"
            return code, "OK", note
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            if is_member_gated(url):
                return e.code, "MEMBER-GATED", "requires membership, not just sign-in"
            return e.code, "AUTH-GATED", "requires sign-in"
        if e.code in (404, 410):
            return e.code, "BROKEN", "not found"
        if e.code >= 500:
            return e.code, "BROKEN", "server error"
        # 3xx that urllib didn't follow, or other 4xx — reachable but odd.
        return e.code, "REACHABLE", f"HTTP {e.code}"
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

    urls = collect_urls(payload)
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

    broken = [r for r in results if r["class"] == "BROKEN"]
    member_gated = [r for r in results if r["class"] == "MEMBER-GATED"]

    if a.json:
        print(json.dumps({"page_url": page_url, "checked": len(results),
                          "broken": len(broken), "member_gated": len(member_gated),
                          "results": results}, indent=2))
    else:
        print(f"Run-summary link check — {a.slug}/{a.run_id}")
        print(f"Page: {page_url}")
        print(f"Checked {len(results)} links · {len(broken)} BROKEN\n")
        for r in results:
            mark = {"OK": "✅", "AUTH-GATED": "🔒", "MEMBER-GATED": "👤",
                    "REACHABLE": "➖", "BROKEN": "❌"}.get(r["class"], "?")
            code = r["status"] if r["status"] is not None else "—"
            print(f"  {mark} [{r['class']:<10}] {code!s:<4} {r['label']}")
            print(f"       {r['url']}" + (f"  ({r['note']})" if r["note"] else ""))
        if broken:
            print(f"\n❌ {len(broken)} BROKEN link(s) — fix before sharing:")
            for r in broken:
                print(f"   - {r['label']}: {r['url']} ({r['note']})")
        elif member_gated:
            print(f"\n✅ No broken links, but {len(member_gated)} link(s) are MEMBER-GATED — "
                  "NOT cleared to share yet.")
            print("   This probe is anonymous. Each of these 404s for a signed-in NON-member,")
            print("   so confirm every named reviewer actually holds membership (skills/share-run-access)")
            print("   or don't present the link to them as reviewer-facing:")
            for r in member_gated:
                print(f"   - {r['label']}: {r['url']}")
        else:
            print("\n✅ No broken links — every summary link is reachable.")

    return 1 if broken else 0


if __name__ == "__main__":
    raise SystemExit(main())
