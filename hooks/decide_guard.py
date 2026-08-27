#!/usr/bin/env python3
"""Stop-event decide-don't-poll rail — a LOADER. The engine lives in canopy.

Do not add matching logic or calibration to this file. It resolves the installed
canopy plugin and runs `agent-core/decide_guard.py`, so one implementation serves
the whole fleet and a calibration fix arrives via /canopy:update rather than five
pull requests — the same split `hooks/gating_guard.py` documents for the gating
engine, for the same measured reason: an engine copied into every agent repo
drifts, and improvements then flow the wrong way.

WHAT IT ENFORCES. A session must not end by handing back a call ACE was equipped
to make. Measured on ACE's own last 40 sessions (2026-08-27): 8 would have
blocked, and 7 of those 8 are real — "say the word and I'll…" appears FOUR times,
parking work ACE could have finished. Verbatim: "Say the word and I'll take it"
(#1609, untouched), "Want me to build the malawi_steps CSV from the PDF now",
"Want me to do that now?" (rewriting a handoff it had just diagnosed).

WIRED REPO-SCOPED, ON PURPOSE — via `.claude/settings.json` and
`$CLAUDE_PROJECT_DIR`, not `hooks/hooks.json`. `gating_guard.py` is deliberately
plugin-level ("fires in every session with ACE installed") because a deny rail on
the ACE identity should hold wherever that identity can be used. This one is the
opposite: it speaks to whether ACE finished ACE's work, so it must fire only in
ACE's own sessions. Plugin-level, it would nag every session on the machine.

WHAT IT NEVER TOUCHES. ACE's procedural gates stay exactly as they are. The engine
carves out any offer whose object is a DELIVERY (send / reply / publish / share —
canopy #542), and any offer ACE has ALREADY ANSWERED: a stated rationale or a
stated default (canopy #545). That second carve-out came from ACE's own
transcript — "A production deploy is outward-facing and yours to authorize, even
when the diff is clean. Want me to run it?" was a FALSE positive, and the rail
was fixed rather than ACE excluded. So the pause-point matrix in `run_state.yaml`
and solicitation-review's HITL checkpoint are untouched: state why it is
Jonathan's, or state your default, and the rail stays silent.

DEGRADED MODE IS SIMPLY OFF, and that is the honest choice. `gating_guard` fails
CLOSED because losing it costs SAFETY; losing this one costs a nudge. A local
half-implementation would be a second copy of the calibration this file exists to
avoid, and a rail that fires on the wrong shape teaches ACE to dismiss it — worse
than the gap. So an unresolvable engine exits 0 silently: no block, and no stderr
noise on every single Stop event.
"""
import json
import os
import runpy
import sys

STATE_HOME = os.path.expanduser("~/.ace")


def _engine():
    plugin_dir = os.environ.get("CANOPY_PLUGIN_DIR")
    if not plugin_dir:
        reg = json.load(open(os.path.expanduser("~/.claude/plugins/installed_plugins.json")))
        plugin_dir = reg["plugins"]["canopy@canopy"][0]["installPath"]
    path = os.path.join(plugin_dir, "agent-core", "decide_guard.py")
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    return path


def main() -> int:
    # The engine keeps its at-most-once marker under CANOPY_AGENT_HOME, so two
    # agents sharing a box cannot consume each other's single block.
    os.environ.setdefault("CANOPY_AGENT_HOME", STATE_HOME)
    try:
        path = _engine()
    except Exception:
        return 0
    runpy.run_path(path, run_name="__main__")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        # Belt and braces: this hook may never be the reason a session cannot end.
        sys.exit(0)
