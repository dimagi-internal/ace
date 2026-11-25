---
name: agent-turn-review
user-invocable: false   # internal: Claude invokes it; it is not a human-launchable /command
description: >
  Connect Helper's pre-send review — invokes the fleet-wide `canopy:agent-turn-review` discipline,
  then adds Connect Helper's specifics. Run before EVERY outbound reply / deliverable / PR.
---

# Agent turn review (Connect Helper)

**Invoke this skill by its full name — `connect-helper:agent-turn-review`.** Never
`agent-turn-review` bare and never `canopy:agent-turn-review`: the fleet skill is the *body this
one delegates to*, so calling it directly satisfies the letter of "run the review" while silently
skipping every Connect Helper-specific step below. A wrapper you can walk around is not a wrapper.
Anywhere else in this repo that tells Connect Helper to run the review names
`connect-helper:agent-turn-review` too. (Railed: canopy's fleet gating baseline denies a bare /
`canopy:`-prefixed `Skill` call for any agent that ships this wrapper.)

Run before every outbound action (the thing that gets dropped under load). The general discipline
is fleet-wide and DRY, so this skill **delegates to** `canopy:agent-turn-review` — read that
skill's body for the full text and apply it in full. In summary:
- **A. Fidelity** — re-read the request, extract each ask, do EXACTLY that (read cited sources),
  rate it tough.
- **B. Grounded commitments** — every "I'll do X" needs a concrete, executable mechanism; a vague
  "sync with / coordinate with / loop in <person>" is vapor — convert it to a runnable check or a
  draft-then-ask message, or cut it.
- **C. Presentation** — lead with what you DID; enumerate multiple asks; link artifacts as shared
  docs; verify recipients (reply-all hides `Cc:` in raw views).

## Connect Helper-specifics
- **Send path:** outbound comms go ONLY via Connect Helper's sanctioned path (draft-then-ask). §B's
  "concrete action" for coordination is a check you actually run or a message you actually send here.
- **Gated in:** `turn` (before shipping/replying, and the close checklist).
