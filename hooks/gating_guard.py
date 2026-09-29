#!/usr/bin/env python3
"""PreToolUse gating hook — a LOADER. The engine lives in canopy, not here.

Do not add rules or matching logic to this file. It resolves the installed canopy plugin and
runs `agent-core/gating_guard.py`, so one implementation serves the whole fleet and an engine
fix arrives via /canopy:update — exactly like the deny rails in agent-core/gating-baseline.json
already do.

WHY (2026-08-13): this file used to BE the engine, copied into every agent repo at scaffold
time and never updated. Config was centralized; code was forked. Measured across four agents:
three had drifted behind and were silently missing rail features, while one had invented a
genuinely useful one (`per_statement`) that no other agent could use. A one-line fix cost N
pull requests. Now it costs one.

What stays yours: `config/gating.json` — this agent's own deny/approve rails and its
`channels` mounts. That is config, and config is per-agent by design.

DEGRADED MODE. If the engine cannot be resolved this file still enforces the agent's LOCAL
deny rails, using a deliberately minimal matcher (`tool` + `pattern` only). It never silently
weakens anything: a rule using a feature this fallback does not implement is treated as
MATCHING, and an agent that mounts `channels` fails closed outright, because it is depending
on baseline rails it cannot read. Losing the engine must cost availability, never safety.
"""
import json
import os
import re
import runpy
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(REPO, "config", "gating.json")
_RICH = ("tool_pattern", "per_statement")   # engine-only rule features


class _NotInstalled(Exception):
    """The canopy plugin is not installed at all, so /canopy:update does not exist yet."""


def _engine():
    plugin_dir = os.environ.get("CANOPY_PLUGIN_DIR")
    if not plugin_dir:
        reg_path = os.path.expanduser("~/.claude/plugins/installed_plugins.json")
        if not os.path.isfile(reg_path):
            raise _NotInstalled(reg_path + " does not exist")
        reg = json.load(open(reg_path, encoding="utf-8"))
        entries = (reg.get("plugins") or {}).get("canopy@canopy")
        if not entries:
            raise _NotInstalled("no canopy@canopy entry in " + reg_path)
        plugin_dir = entries[0]["installPath"]
    path = os.path.join(plugin_dir, "agent-core", "gating_guard.py")
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    return path


def _degraded(exc):
    """Engine unreachable: enforce local deny rails only, or fail closed if we cannot."""
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    try:
        cfg = json.load(open(CONFIG, encoding="utf-8"))
    except Exception:
        sys.exit(0)                       # no/broken config = no extra gating (engine parity)

    slug = cfg.get("slug") or os.path.basename(REPO) or "the agent"
    if cfg.get("channels"):
        # Depends on baseline rails it cannot read — same fail-closed contract as the engine.
        if isinstance(exc, _NotInstalled):
            # Fresh account: /canopy:update does not exist yet, and this hook blocks the
            # agent's own shell, so only a human-typed `!` command (which skips hooks) can fix it.
            sys.stderr.write(
                "BLOCKED (fail closed): " + slug + " mounts gating channels but the canopy "
                "plugin is not installed (" + str(exc) + ").\n"
                "Fix: the human types this in the prompt (the leading ! runs it outside "
                "this hook, which blocks the agent's own shell):\n"
                "  ! claude plugin marketplace add dimagi-internal/canopy && "
                "claude plugin install canopy@canopy\n"
                "No restart needed: this hook re-resolves the engine on every call.\n")
            sys.exit(2)
        sys.stderr.write(
            "BLOCKED (fail closed): " + slug + " mounts gating channels but the canopy gating "
            "engine (agent-core/gating_guard.py) is unresolvable - "
            + type(exc).__name__ + ": " + str(exc) + "\n"
            "Fix: run /canopy:update, then retry.\n")
        sys.exit(2)

    tool = payload.get("tool_name", "")
    inp = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    shell = tool in ("Bash", "PowerShell")    # engine parity: a "Bash" rail covers every shell
    if shell:
        subject = inp.get("command", "") or ""
    elif tool in ("Edit", "Write", "NotebookEdit"):
        subject = inp.get("file_path", "") or inp.get("notebook_path", "") or ""
    else:
        subject = ""
    for rule in cfg.get("deny", []):
        want = rule.get("tool")
        if want and want != tool and not (want == "Bash" and shell and not rule.get("bash_only")):
            continue
        if any(rule.get(k) for k in _RICH):
            pass                          # cannot evaluate it here -> assume it fires
        elif rule.get("pattern"):
            try:
                if re.search(rule["pattern"], subject) is None:
                    continue
            except re.error:
                continue
        sys.stderr.write((rule.get("message")
                          or ("BLOCKED by " + slug + " gating policy (deny rule).")).rstrip() + "\n")
        sys.exit(2)
    sys.exit(0)


try:
    ENGINE = _engine()
except Exception as exc:
    _degraded(exc)

os.environ.setdefault("CANOPY_AGENT_REPO", REPO)
runpy.run_path(ENGINE, run_name="__main__")
