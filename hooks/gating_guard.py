#!/usr/bin/env python3
"""Reads-free / writes-gated PreToolUse guard for ACE.

Adapted from hal's hooks/gating_guard.py (itself the generalization of echo's
block_raw_gog_send.py) — the canopy agent operating model's enforcement primitive.
Reads config/gating.json (sibling of this file's parent dir) and enforces, at the
tool-call boundary:

  - "deny" rules    -> exit 2 (hard block; the agent CANNOT bypass it), with a message
                       telling it the right way to do the action.
  - "approve" rules -> escalate to a human via a PreToolUse permissionDecision of "ask".
  - everything else -> allow (reads run free).

ACE extension over hal's guard: a rule may carry "tool_pattern" (regex tested against
the TOOL NAME) instead of "tool" (exact match). MCP atom names vary by how the host
registers the plugin (mcp__plugin_ace_ace-connect__X vs mcp__ace-connect__X), so atom
gates match on the atom suffix, e.g. "connect_send_llo_invite$".

This hook ships in the ACE plugin and fires in EVERY session with ACE installed —
rules must stay narrow (see docs/superpowers/specs/2026-07-01-agent-operating-model-adoption.md).

STDLIB ONLY by design: a PreToolUse hook runs under whatever python3 is on PATH, which
may not have PyYAML. That is why the gating config is JSON, not YAML.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(os.path.dirname(HERE), "config", "gating.json")


def _subject(tool_name, tool_input):
    """The string a rule's pattern is tested against, per tool."""
    if not isinstance(tool_input, dict):
        return ""
    if tool_name == "Bash":
        return tool_input.get("command", "") or ""
    if tool_name in ("Edit", "Write", "NotebookEdit"):
        return tool_input.get("file_path", "") or tool_input.get("notebook_path", "") or ""
    # MCP tools: give patterns a compact JSON view of the input to match against.
    try:
        return json.dumps(tool_input, sort_keys=True)
    except Exception:
        return ""


def _summarize_action(tool_name, subject):
    """A crisp, human-readable summary of the GATED action — so the approval prompt says
    exactly WHAT you're approving at a glance, not a generic 'needs approval'."""
    if tool_name != "Bash":
        return f"{tool_name} → {subject[:80]}"
    s = subject
    m = re.search(r"bin/ace-email\b([^\n;&|]*)", s)
    if m:
        to = re.search(r"--to[= ]+[\"']?([^\"'\s]+)", m.group(1))
        subj = re.search(r"--subject[= ]+[\"']?([^\"'\n]{0,60})", m.group(1))
        return ("SEND email as ace@" + (f" to {to.group(1)}" if to else "")
                + (f' — "{subj.group(1).strip()}"' if subj else ""))
    m = re.search(r"\bgog\s+gmail\s+(send|reply)\b", s)
    if m:
        return f"raw gog gmail {m.group(1)} (should be blocked — use bin/ace-email)"
    return s.strip().replace("\n", " ")[:100]


def _approval_reason(rule, tool_name, subject, cwd):
    """Build a scannable approval prompt: WHAT + WHERE + the exact command + WHY."""
    action = _summarize_action(tool_name, subject)
    repo = os.path.basename(cwd.rstrip("/")) if cwd else ""
    cmd = subject.strip().replace("\n", " ")
    if len(cmd) > 220:
        cmd = cmd[:220] + " …"
    note = rule.get("message") or "outbound action — needs your approval."
    lines = [f"APPROVE ACE → {action}" + (f"   (repo: {repo})" if repo else "")]
    lines.append(f"  why: {note}")
    lines.append(f"  full call: {cmd}")
    return "\n".join(lines)


def _matches(rule, tool_name, subject):
    if rule.get("tool") and rule["tool"] != tool_name:
        return False
    tp = rule.get("tool_pattern")
    if tp:
        try:
            if re.search(tp, tool_name) is None:
                return False
        except re.error:
            return False
    if not rule.get("tool") and not tp:
        return False  # a rule must scope to SOME tool; never match everything
    pat = rule.get("pattern")
    if not pat:
        return True
    try:
        return re.search(pat, subject) is not None
    except re.error:
        return False


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)            # never block on a parse failure
    try:
        cfg = json.load(open(CONFIG))
    except Exception:
        sys.exit(0)            # no/*broken* config = no extra gating

    tool_name = data.get("tool_name", "")
    subject = _subject(tool_name, data.get("tool_input"))
    cwd = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR", "")

    for rule in cfg.get("deny", []):
        if _matches(rule, tool_name, subject):
            msg = rule.get("message") or "BLOCKED by ACE gating policy (deny rule)."
            sys.stderr.write(msg.rstrip() + "\n")
            sys.exit(2)

    for rule in cfg.get("approve", []):
        if _matches(rule, tool_name, subject):
            reason = _approval_reason(rule, tool_name, subject, cwd)
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": reason,
                }
            }))
            sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
