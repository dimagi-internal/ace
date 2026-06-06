---
description: Research a prospect org and produce a partnership video + pitch deck (two-phase: propose 3 angles, then produce on pick)
argument-hint: "\"<prospect brief>\" | --produce <angle-id> [--prospect-folder=<id>] [--workspace=<slug>] [--angles=N] [--generic] [--no-render]"
allowed-tools: [Read, Write, Edit, Bash, WebFetch, Agent, AskUserQuestion, Skill, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__update_yaml_file, mcp__plugin_ace_ace-gdrive__resolve_opp_path]
---

# /ace:partnership-video

Research a prospect organization and produce a partnership video + pitch deck.

**Read `agents/partnership-video.md` and follow it as a procedure document from this
(top-level) Claude Code session. Do **not** dispatch `Agent(partnership-video)` — it is
a procedure doc, not a subagent, and it dispatches `Agent` itself (deep-research,
canopy walkthrough, Nova for micro-demo mocks), which is only available at level 0.
Running it as a subagent would put those dispatches at level 2 and break every one
of them.**

## Two-phase workflow

### Phase 1 — Propose (cheap; no render)

Invoke with a natural-language prospect brief in quotes:

```
/ace:partnership-video "in discussions with Noora Health about expanding to Nigeria"
```

The procedure doc runs Steps 0–2: profile the prospect, conducts deep web research,
grounds the three reusable narrative library templates against the research, and
**stops at a mandatory human pick gate**. It presents three grounded narrative angles
(title · logline · beats · grounding citations) and waits for a selection before
doing any render, video build, or deck work.

### Phase 2 — Produce (the expensive half)

After picking an angle from Phase 1, resume with `--produce`:

```
/ace:partnership-video --produce the-scale-gap noora-health
```

The procedure doc runs Steps 3–8: records the selected angle, sources or mocks the
proof clip (reuse from the media library or lightweight Nova/canopy mock), fills the
ace-web `partnership-pitch` spec (all 3 angle variants embedded; the picked angle
active), renders the video, builds the matching Google Slides pitch deck, and
publishes the prospect-facing package — stopping for human brand-safety review
before any external send.

## Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `--produce <angle-id>` | — | Enter Phase 2 for the named angle; requires a completed Phase 1 run for the given prospect slug |
| `--prospect-folder <drive-id>` | none | Optional Drive folder holding high-signal operator context: call notes, their deck, MoU drafts. Highest-signal input but not required. |
| `--workspace <slug>` | `dimagi-team` (env default) | ace-web workspace slug for the video program |
| `--angles N` | 3 | Number of angles to propose (default 3 — one per narrative template) |
| `--generic` | off | Unbranded mode — omit prospect identity; produce the "how Connect works" explainer using the same narrative machinery with generic Connect facts filling the slots |
| `--no-render` | off | Fill the ace-web spec and deck spec, but skip the render/poll step (spec-only dry run) |

## Examples

```text
# Phase 1 — research Noora Health and propose three narrative angles
/ace:partnership-video "in discussions with Noora Health about expanding to Nigeria"

# Phase 1 with operator-context booster (their deck, call notes in Drive)
/ace:partnership-video "Lafiya program considering expansion beyond Nigeria" --prospect-folder 1A2B3C4D5E

# Phase 2 — produce the video + deck for the picked angle
/ace:partnership-video --produce the-scale-gap noora-health

# Phase 2 — produce a second angle variant from the same research
/ace:partnership-video --produce trust-travels noora-health

# Generic unbranded explainer
/ace:partnership-video --generic
/ace:partnership-video --produce day-in-the-life --generic

# Spec-only dry run (no render/poll)
/ace:partnership-video "Noora Health" --no-render
```

## Process

1. Parse the arguments: detect whether `--produce` is present to determine the
   starting phase (propose vs. produce); extract the prospect brief (Phase 1) or the
   prospect slug (Phase 2); collect all flags.

2. **Execute the partnership-video procedure inline at top-level.** Read
   `agents/partnership-video.md` and follow it as a procedure document from this
   (top-level) Claude Code session. Pass through all parsed arguments and flags.

   The procedure document handles:
   - **Propose phase (default):** Steps 0–2 — profile, research, angles; stops at the
     human pick gate.
   - **Produce phase (`--produce`):** Steps 3–8 — record pick, micro-demo sourcing,
     video build, deck build, publish; stops for brand-safety review before any
     external send.
