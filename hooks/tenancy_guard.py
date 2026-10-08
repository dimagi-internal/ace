#!/usr/bin/env python3
"""PreToolUse guard: a session bound to an opp may only write into that opp's tenancy.

Tenancy is where an opp's assets live in each system ACE writes to: its HQ
project space, Connect program-manager and holding orgs, OCS team and Labs
allowed domains. It is recorded per opp in ace-web
(GET /api/w/{ws}/opps/{slug}/tenancy); `bin/ace-bind <ws>/<opp>` fetches it and
writes a bind file for the current Claude session. This hook reads that file on
every ACE tool call, finds the call's tenant arguments via
config/tenancy-targets.json, and refuses (exit 2) a write that points anywhere
else — so one opp's work cannot land in another opp's HQ space, Connect org,
OCS team or Labs scope by mistake.

Why a hook and not an MCP-side wrapper: it is the one choke point every ACE
tool crosses, including the remote connect-labs server, and Claude Code hands
it the session id the bind file is keyed by.

What it is NOT: a boundary against a compromised session. ace@ is admin in
every tenancy and the bind file is writable by the agent; this stops mistakes.
A hard boundary needs a separate identity per tenancy (ace-web
docs/specs/2026-09-28-clone-and-release-design.md § "One agent").

Rollout: an UNBOUND session is allowed, and a write that a bound session would
have had checked is appended to <bind dir>/unbound-writes.log, so today's runs
keep working until every entry point binds. `ACE_TENANCY_GUARD=off` disables
the hook.

STDLIB ONLY, like hooks/gating_guard.py: it runs under whatever python3 is on
PATH.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ROOT = os.path.dirname(HERE)
TARGETS = os.path.join(PLUGIN_ROOT, "config", "tenancy-targets.json")


# --- bind files (shared with bin/ace-bind) ---------------------------------


def bind_dir() -> str:
    return os.environ.get("ACE_OPP_BIND_DIR") or os.path.join(
        os.path.expanduser("~"), ".ace", "opp-bind"
    )


def bind_path(session_id: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id)
    return os.path.join(bind_dir(), f"{safe}.json")


def read_bind(session_id: str) -> dict | None:
    if not session_id:
        return None
    try:
        with open(bind_path(session_id), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def plugin_env(key: str) -> str | None:
    """A value from the process env, else from the installed plugin's .env —
    the same precedence the MCP servers use (dotenv never overrides)."""
    if os.environ.get(key):
        return os.environ[key]
    data = os.environ.get("CLAUDE_PLUGIN_DATA")
    candidates = []
    if data and data != "${CLAUDE_PLUGIN_DATA}":
        candidates.append(os.path.join(data, ".env"))
    else:
        parts = PLUGIN_ROOT.split(os.sep)
        for i in range(len(parts) - 4):
            if parts[i] == "plugins" and parts[i + 1] == "cache":
                root = os.sep.join(parts[: i + 1])
                candidates.append(os.path.join(root, "data", f"{parts[i+2]}-{parts[i+3]}", ".env"))
                break
    for path in candidates:
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    m = re.match(rf"^\s*(?:export\s+)?{re.escape(key)}=(.*)$", line)
                    if m:
                        return m.group(1).strip().strip("'\"") or None
        except OSError:
            continue
    return None


# --- target extraction -----------------------------------------------------


def _values_at(obj, path: str) -> list:
    """Values at a dotted path; a segment ending in [] fans out over a list."""
    current = [obj]
    for seg in path.split("."):
        fan = seg.endswith("[]")
        key = seg[:-2] if fan else seg
        nxt = []
        for item in current:
            if isinstance(item, dict) and key in item:
                v = item[key]
                if fan and isinstance(v, list):
                    nxt.extend(v)
                else:
                    nxt.append(v)
        current = nxt
    return [v for v in current if v is not None and v != ""]


def _norm(value: str, field: str) -> str:
    v = str(value).strip().lower()
    if field.endswith("allowed_domains[]") and not v.startswith("@"):
        v = "@" + v
    return v


def _allowed(tenancy: dict, fields: list[str]) -> tuple[set[str], list[str]]:
    """(allowed values, fields that are not set up)."""
    allowed: set[str] = set()
    missing: list[str] = []
    for field in fields:
        name = field[:-2] if field.endswith("[]") else field
        raw = tenancy.get(name)
        if raw in (None, "", []):
            missing.append(name)
            continue
        for v in raw if isinstance(raw, list) else [raw]:
            allowed.add(_norm(v, name))
    return allowed, missing


def agent_email_domain() -> str | None:
    """ACE's own mailbox domain, from config/agent.json `email` (the single source)."""
    try:
        with open(os.path.join(PLUGIN_ROOT, "config", "agent.json"), encoding="utf-8") as f:
            email = (json.load(f) or {}).get("email") or ""
    except (OSError, ValueError):
        return None
    return email[email.rfind("@"):].lower() if "@" in email else None


def _operator_values(rule: dict, arg: str, field: str) -> set[str]:
    """Values a rule admits for `arg` whatever the tenancy says (ace#2713):
    labs operator domains, which never widen a partner's view."""
    out: set[str] = set()
    for v in (rule.get("operator_values") or {}).get(arg, []):
        if v == "{agent_email_domain}":
            v = agent_email_domain()
        if v:
            out.add(_norm(v, field))
    return out


def violations(rule: dict, tool_input: dict, tenancy: dict) -> list[str]:
    problems: list[str] = []
    for arg, fields in (rule.get("args") or {}).items():
        values = _values_at(tool_input, arg)
        if not values:
            continue
        operators = _operator_values(rule, arg, fields[0] if fields else arg)
        if not fields:
            # Operator-only rule: no tenancy field widens it (Labs stays
            # Dimagi-only since ace-web dropped labs_allowed_domains, 2026-10-08).
            for v in values:
                if _norm(v, arg) not in operators:
                    problems.append(
                        f"`{arg}` = {v!r}, but only {sorted(operators)} may be set here."
                    )
            continue
        allowed, missing = _allowed(tenancy, fields)
        if not allowed:
            problems.append(
                f"`{arg}` is checked against tenancy {' / '.join(missing)}, which is not set "
                "up for this opp. An owner sets it with PATCH /api/w/{ws}/opps/{slug}/tenancy."
            )
            continue
        for v in values:
            n = _norm(v, fields[0])
            if n not in allowed and n not in operators:
                problems.append(
                    f"`{arg}` = {v!r}, but this opp's tenancy allows {sorted(allowed)}."
                )
    for key, fields in (rule.get("server_env") or {}).items():
        actual = plugin_env(key)
        allowed, missing = _allowed(tenancy, fields)
        if not allowed:
            problems.append(
                f"tenancy {' / '.join(missing)} is not set up for this opp, so {key} "
                "cannot be checked."
            )
        elif not actual or _norm(actual, fields[0]) not in allowed:
            problems.append(
                f"this ACE install's {key} is {actual!r}, but this opp's tenancy is "
                f"{sorted(allowed)}. The tool acts on {key}, which is fixed when the MCP "
                "server starts."
            )
    return problems


def matching_rule(tool_name: str, rules: list[dict]) -> dict | None:
    for rule in rules:
        if re.search(rule["tool_pattern"], tool_name):
            return rule
    return None


def _log(name: str, session_id: str, tool_name: str, tool_input: dict, **extra) -> None:
    try:
        os.makedirs(bind_dir(), exist_ok=True)
        line = json.dumps({
            "at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
            "session_id": session_id,
            "tool": tool_name,
            "input": tool_input,
            **extra,
        }, sort_keys=True, default=str)
        with open(os.path.join(bind_dir(), name), "a", encoding="utf-8") as f:
            f.write(line[:4000] + "\n")
    except OSError:
        pass


def main() -> int:
    if os.environ.get("ACE_TENANCY_GUARD", "").lower() in ("off", "0", "false"):
        return 0
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    tool_name = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}
    if not tool_name.startswith("mcp__") or not isinstance(tool_input, dict):
        return 0
    try:
        with open(TARGETS, encoding="utf-8") as f:
            rules = json.load(f).get("rules", [])
    except (OSError, ValueError):
        return 0  # a broken config must never stall every ACE session
    rule = matching_rule(tool_name, rules)
    if rule is None:
        return 0

    session_id = payload.get("session_id") or ""
    bound = read_bind(session_id)
    if bound is None:
        _log("unbound-writes.log", session_id, tool_name, tool_input)
        return 0

    problems = violations(rule, tool_input, bound.get("tenancy") or {})
    if not problems:
        return 0
    opp = f"{bound.get('workspace', '?')}/{bound.get('opp', '?')}"
    if bound.get("mode") == "warn":
        # Rollout mode for /ace:run and /ace:turn: record what enforcement WOULD
        # refuse, and let the call through. Clone and release bind in enforce.
        _log("bound-violations.log", session_id, tool_name, tool_input,
             opp=opp, problems=problems)
        return 0
    sys.stderr.write(
        f"BLOCKED by the tenancy guard: this session is bound to opp {opp}, and "
        f"{tool_name.rsplit('__', 1)[-1]} would write outside that opp's tenancy.\n"
        + "".join(f"  - {p}\n" for p in problems)
        + "If this call is for a different opp, bind to it first "
        "(`bin/ace-bind <workspace>/<opp>`); `bin/ace-bind --show` prints the current "
        "binding. If the opp's tenancy is wrong, a workspace owner fixes it in ace-web — "
        "do not work around this guard.\n"
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
