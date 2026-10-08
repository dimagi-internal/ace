"""Workspace-addressed canopy-web URLs only — the one rule, shared by bin/ace-email and
bin/ace-canopy-web (canopy-web#1337, ace#2813).

canopy-web addresses every tenant artifact under `/w/<workspace>/…`. A flat link
(`/review/<id>`, `/walkthrough/<id>`, `/ddd/<slug>`, `/share/<token>`, the legacy
`/w/<uuid>`) depends on a redirect that canopy-web is removing, and never says which
workspace the thing lives in. On 2026-10-08 ACE emailed an external reviewer a flat
`/review/<id>/?t=…` link copied from `scripts.ddd.narrative post` output; the owner's
ruling: "make the workspaces required and more simple, I don't want to get confused
later".

Not a script — imported by the two bin wrappers (they put bin/ on sys.path).
"""
from __future__ import annotations

import re

CANOPY_HOSTS = ("canopy.dimagi.com", "canopy-web.dimagi.com")

# Non-tenant pages: public site + pages that name no workspace by design. Everything
# else on a canopy host must live under /w/<slug>/.
NON_TENANT_SEGMENTS = {
    "about",         # public site
    "guide",         # product guide, not tenant data
    "invite",        # /invite/<token>: the invitee has no workspace yet
    "new-workspace",
    "beta-requests",
    "api",           # API paths are not links a human follows; scoping is the API's job
    "static",
    "accounts",      # login callbacks
}

_URL = re.compile(
    r"https?://(?P<host>" + "|".join(re.escape(h) for h in CANOPY_HOSTS) + r"|localhost(?::\d+)?)"
    r"(?P<path>/[^\s<>\"')\]]*)?",
    re.IGNORECASE,
)
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def _first_segment(path: str) -> str:
    return (path or "/").rstrip(".,;:!?").lstrip("/").split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]


def _is_flat(host: str, path: str) -> bool:
    seg = _first_segment(path).lower()
    if host.lower().startswith("localhost"):
        # canopy-web's share_url bug emits https://localhost/<artifact>; only those count.
        return seg in {"review", "walkthrough", "share", "ddd"}
    if seg == "":
        return False
    if seg == "w":
        # /w/<slug>/… is scoped; /w/<uuid> is the legacy flat walkthrough viewer.
        rest = (path or "").lstrip("/").split("/")
        second = rest[1].split("?", 1)[0] if len(rest) > 1 else ""
        return bool(_UUID.match(second))
    return seg not in NON_TENANT_SEGMENTS


def flat_urls(text: str) -> list[str]:
    """Every canopy-web URL in `text` that is not workspace-addressed."""
    out = []
    for m in _URL.finditer(text):
        if _is_flat(m.group("host"), m.group("path") or "/"):
            out.append(m.group(0))
    return out


def scope_urls(text: str, workspace: str) -> tuple[str, list[tuple[str, str]]]:
    """Rewrite flat canopy-web URLs in `text` to https://canopy.dimagi.com/w/<workspace>/…

    The legacy /w/<uuid> form becomes /w/<workspace>/walkthrough/<uuid>. Returns the new
    text and the (old, new) pairs so the caller can say what it changed.
    """
    changes: list[tuple[str, str]] = []

    def repl(m: re.Match) -> str:
        host, path = m.group("host"), m.group("path") or "/"
        if not _is_flat(host, path):
            return m.group(0)
        # Sentence punctuation after a link is not part of it.
        stripped = path.rstrip(".,;:!?")
        tail = path[len(stripped):]
        rest = stripped.lstrip("/")
        if rest.lower().startswith("w/"):
            rest = "walkthrough/" + rest[2:]
        new = f"https://canopy.dimagi.com/w/{workspace}/{rest}"
        changes.append((m.group(0)[: len(m.group(0)) - len(tail)], new))
        return new + tail

    return _URL.sub(repl, text), changes
