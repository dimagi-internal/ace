---
name: partnership-video
description: >
  Partnership-video orchestrator: research a non-Connect prospect,
  propose three grounded narrative angles, and (on pick) produce a
  high-gloss video + pitch deck and publish a shareable package.
model: inherit
phase: partnership-video
phase_display: Partnership Video
skills:
  - { name: partnership-research,    has_judge: true,  eval_skill: partnership-research-eval }
  - { name: partnership-angles,      has_judge: true,  eval_skill: partnership-angles-eval }
  - { name: partnership-microdemo,   has_judge: true,  eval_skill: partnership-microdemo-eval }
  - { name: partnership-video-build, has_judge: true,  eval_skill: partnership-video-build-eval }
  - { name: partnership-deck-build,  has_judge: true,  eval_skill: partnership-deck-build-eval }
  - { name: partnership-publish,     has_judge: false }
---

# Partnership Video (Procedure Document)

This file specifies the partnership-video pipeline: research a non-Connect
prospect organization, propose three grounded narrative angles from the
reusable library, then (on the operator's pick) produce a high-gloss narrated
video + pitch deck and publish a shareable package.

**This file is read and executed inline by the top-level Claude Code
session — it is NOT dispatched as a subagent.** This procedure dispatches
`Agent` for `deep-research`, `canopy:walkthrough` (micro-demo mock filming),
`nova:autobuild` (Nova app stub when no reusable clip exists), and
`canopy:walkthrough-share` (package publish). `Agent` is only available at
level 0; running partnership-video as a subagent would put those dispatches
at level 2 and fail. See `agents/ace-orchestrator.md` § Agent Topology.
The frontmatter is retained for tooling that introspects agent metadata, not
because this procedure is itself dispatched. **Never dispatch
`Agent(partnership-video)` — if you see that pattern, stop and fix it.**

## You are the partnership-video orchestrator

When the top-level session executes this procedure, treat the directive
voice ("dispatch", "write", "present") as instructions to the top-level
session. The orchestration logic that follows is yours to run.

## Drive state layout

Partnership artifacts live under a new root, parallel to `ACE/<opp>/`:

```
ACE/partnerships/<prospect-slug>/
  prospect.yaml            # identity: name, slug, current_program,
                           # target_geography, sector, contact, branding refs
  research/
    deep-research.md       # cited org profile (deep-research skill output)
    connect-fit.md         # what Connect unlocks for this org + geography
  runs/<run-id>/
    angles.yaml            # 3 grounded narrative angles (propose-phase terminal)
    video_spec.yaml        # ace-web spec as-POSTed (produce-phase)
    deck_spec.yaml         # pitch-deck spec (produce-phase)
    micro-demo/            # sourced/mocked clips + provenance.yaml
    package.yaml           # final URLs: ace-web video, Slides deck, canopy-web
    run_state.yaml         # Phase Write-Back Contract — status/verdict/products
```

`--generic` runs live under `ACE/partnerships/_generic/` with prospect
fields blank or set to generic Connect placeholders.

**Runs are independent.** Each invocation of this procedure creates a new
`runs/<run-id>/` directory and a fresh `run_state.yaml`. No run reads from
or writes to another run's state. The cross-run durable state is:

- `prospect.yaml` — prospect identity (written in the Profile step, reused
  by subsequent runs against the same prospect).
- `research/` — cited research artifacts (written once, reused across runs
  for the same prospect; re-run `partnership-research` explicitly to refresh).
- `templates/partnership-narratives/` in the repo — the versioned narrative
  library shared by all runs and all prospects.

---

## Phase Write-Back Contract

Every skill in this procedure MUST update `run_state.yaml` on completion
with the standard per-phase block shape:

```yaml
phases:
  <phase-name>:
    status: in_progress | done | error
    started_at: <ISO timestamp>
    completed_at: <ISO timestamp>         # required when status: done
    verdict: pass | proceed | warn | fail
    summary_artifact: <Drive fileId>      # if the skill produces a summary doc
    steps:
      <skill-name>:
        status: done | error | incomplete
        verdict: pass | warn | fail | incomplete
        started_at: <ISO>
        completed_at: <ISO>
        artifact: <relative path>         # required when status: done
        file_id: <Drive fileId>           # required when status: done
        artifacts:
          <name>: <fileId>               # additional files if any
```

All `update_yaml_file` calls MUST use `merge: 'deep'` when patching a
nested sub-block (e.g. adding one step to an existing phase block) to
avoid the wholesale-replace footgun. Use `merge: 'two-level'` only when
resending the phase's complete child block. See `agents/orchestrator-reference.md
§ Phase Write-Back Contract` for the full contract and the CAS retry semantics.

---

## Invocation modes

### Propose phase (default — no `--produce` flag)

```
/ace:partnership-video "<prospect brief>"
/ace:partnership-video "<prospect brief>" --prospect-folder <drive-id>
```

Produces three grounded narrative angles and stops. No render, no video,
no deck. Cheap. Returns the angles to the operator for a pick decision.

### Produce phase (`--produce <angle-id>`)

```
/ace:partnership-video --produce <angle-id> <prospect-slug>
```

Resumes a prior propose-phase run. Records the picked angle, then produces
the video + deck + publish package end-to-end.

### Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `--prospect-folder <drive-id>` | none | Optional Drive folder with high-signal operator context: call notes, their deck, MoU drafts |
| `--workspace <slug>` | `dimagi-team` (env default) | ace-web workspace slug |
| `--angles N` | 3 | Number of angles to propose (default 3 = one per narrative template) |
| `--produce <angle-id>` | — | Enter produce phase for the named angle |
| `--generic` | off | Unbranded mode — omit prospect identity; produce the "how Connect works" explainer using the same narrative machinery with generic Connect framing |
| `--no-render` | off | Fill specs but skip the ace-web render/poll (spec-only dry run) |

---

## PROPOSE phase (Steps 0–2)

Steps 0 through 2 run on every default invocation. They are cheap (no
render) and stop at a human decision gate.

### Step 0: Profile — parse the prospect + initialize the run

**Purpose:** Establish the prospect identity and create the run directory.

1. **Parse the operator's brief.** Extract from the natural-language
   argument: the prospect organization's name, what they do today, and
   the expansion geography or thesis. If the brief is ambiguous or missing
   a geography, ask one clarifying question — don't invent backstory.

2. **Resolve the prospect slug.** Kebab-case the org name, max 40 chars
   (e.g. `noora-health`, `lafiya-program`). For `--generic`, use slug
   `_generic`.

3. **Write `prospect.yaml` if not already present.**

   Resolve the partnerships root via `resolve_opp_path` (or find
   `ACE/partnerships/` on Drive), then `drive_create_folder` for
   `<slug>/` (findOrCreate). Write `prospect.yaml`:

   ```yaml
   name: <display name>
   slug: <kebab-slug>
   current_program: <what they do today>
   target_geography: <expansion target or "global">
   sector: <health | MNCH | agriculture | …>
   contact: <person/role, or null if unknown>
   logo_asset: null  # operator may fill this later
   branding_refs: []
   ```

   If `prospect.yaml` already exists (a prior propose run), read it
   and merge any newly-supplied fields. Do not overwrite values the
   operator confirmed in a prior run without asking.

   If `--prospect-folder <drive-id>` was supplied, read the folder
   contents (`drive_list_folder` → `drive_read_file` per file) and
   merge any extractable prospect fields. Treat these as highest-signal
   context. Do NOT halt if the folder is empty or inaccessible — warn
   and proceed.

4. **Create the run directory.**

   Generate a run id: `<YYYYMMDD-HHmm>` (UTC). Create
   `ACE/partnerships/<slug>/runs/<run-id>/` via `drive_create_folder`.

5. **Initialize `run_state.yaml`.**

   Write an initial `run_state.yaml` to the run dir:

   ```yaml
   run_id: <run-id>
   prospect_slug: <slug>
   mode: propose   # or produce when --produce is given
   phases: {}
   last_actor: <operator email>
   created_at: <ISO timestamp>
   ```

   For `--generic`: `prospect_slug: _generic`, `mode: propose`.

### Step 1: Research — dispatch `partnership-research` (+ QA + eval)

**Purpose:** Build the two cited artifacts the angles skill needs.

1. Dispatch `Skill(partnership-research)` with the prospect slug and
   the run id. The skill reads `prospect.yaml` (and the
   `--prospect-folder` contents if supplied) and produces:
   - `ACE/partnerships/<slug>/research/deep-research.md` — cited org
     profile from deep web research
   - `ACE/partnerships/<slug>/research/connect-fit.md` — Connect/Dimagi
     capability-fit memo

   The skill internally dispatches `Skill(deep-research)` (a fan-out
   web research skill). Because this procedure runs at level 0, that
   dispatch is legal.

2. After `partnership-research` completes, dispatch
   `Skill(partnership-research-qa)` for structural checks.

3. Dispatch `Skill(partnership-research-eval)` for LLM-as-Judge grading.
   Do not skip — has_judge is true and the Phase Write-Back Contract
   refuses `verdict: pass` when a `has_judge: true` skill has
   `steps.<skill>-eval.status: deferred`.

4. If `partnership-research-eval` returns `verdict: fail`, halt with
   `[BLOCKER]` and surface the eval findings to the operator. The
   produce phase cannot run on ungrounded research — fabricated stats
   would flow into the video narration and the prospect-facing deck.

### Step 2: Angles — dispatch `partnership-angles` (+ eval)

**Purpose:** Ground the three reusable narrative templates against the
research and produce the propose-phase terminal artifact.

1. Dispatch `Skill(partnership-angles)` with the prospect slug and run
   id. The skill:
   - Loads all three narratives from
     `templates/partnership-narratives/` (the versioned library:
     `day-in-the-life`, `the-scale-gap`, `trust-travels`)
   - Grounds each narrative's beat intents with cited facts from
     `research/deep-research.md` and `research/connect-fit.md`
   - Writes `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml`
     containing three complete, pitch-able angle objects

   The skill does NOT invent narrative arcs — it only grounds the
   library intents with prospect-specific facts. If a narrative can't
   be grounded (missing facts), it marks that angle `groundable: false`
   with the missing fact rather than fabricating.

2. Dispatch `Skill(partnership-angles-eval)`. Do not skip.

3. If `partnership-angles-eval` returns `verdict: fail` on all three
   angles, halt with `[BLOCKER]`. If some angles are `groundable: false`,
   present the groundable angles only and note which templates couldn't
   be grounded and why.

### PROPOSE-PHASE PAUSE POINT (mandatory human gate)

**Stop here.** Do not proceed to produce-phase steps without explicit
operator confirmation.

Present the three grounded angles to the operator in this format:

```
## Partnership Video — Three Narrative Angles

**Prospect:** <name> | **Run:** <run-id>

---

### Angle 1: <title> (`day-in-the-life`)
**Logline:** <one sentence>
**Hero:** <whose POV>
**Emotional beat:** <intimacy / ambition / confidence>
**Connect capability:** <primary capability this angle showcases>

| Beat | Grounded text |
|------|--------------|
| Hook | <hook beat, cited> |
| Cycle | <cycle beat, cited> |
| Handoff | <handoff beat> |
| Scene | <scene beat, cited> |
| Problem | <problem beat, cited> |
| Product | <product beat> |
| Impact | <impact beat, cited> |

**Grounding:** <N of 7 beats grounded to cited research>

---
[repeat for angles 2 and 3]
---

**To proceed:** reply with the angle id or number you want produced
(e.g. "angle 2" or "the-scale-gap"), or run:
  /ace:partnership-video --produce <angle-id> <prospect-slug>
```

Do NOT record `selected_angle` at this point. Do NOT begin any produce-
phase step. The run state at pause is:
- `phases.research.status: done`
- `phases.angles.status: done`
- No `phases.angles.products.selected_angle` yet

Wait for the operator's pick before continuing.

---

## PRODUCE phase (Steps 3–7)

Steps 3 through 7 run only when `--produce <angle-id>` is supplied (or
the operator replies with a pick after a propose run). The produce phase
is the expensive half — it renders the video, builds the deck, and
publishes.

### Step 3: Record the selected angle

1. Read `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` and
   confirm `phases.angles.status: done`. If missing or `error`, halt:
   "Produce phase requires a completed propose phase with status: done.
   Run the propose phase first."

2. Verify the angle id exists in `angles.yaml`. If not, halt and list
   the valid ids.

3. Write `phases.angles.products.selected_angle` to `run_state.yaml`
   via `update_yaml_file(..., merge: 'deep')`:

   ```yaml
   phases:
     angles:
       products:
         selected_angle: <angle-id>
   ```

4. Update the run mode field: `mode: produce`.

### Step 4: Micro-demo sourcing — dispatch `partnership-microdemo` (+ eval)

**Purpose:** Source the proof clip(s) that make the video's `product` beat
credible. Adaptive: reuse existing media when it matches; build a
lightweight mock only when nothing fits.

1. Dispatch `Skill(partnership-microdemo)` with the prospect slug, run
   id, and the selected angle id.

   The skill:
   - Queries the ace-web media library (`GET .../library/video`) for a
     reusable clip matching the angle's `product` beat + `primary_capability`
   - On a good match: records the clip ref with `source: reuse` provenance
   - On no match: builds a lightweight mock — a Nova app stub via
     `/nova:autobuild` (level-0 Agent dispatch, legal here) filmed via
     `Skill(canopy:walkthrough)` + record_video, OR a Connect-styled
     clickable mock filmed headless via gstack browse

   Clips are written to `micro-demo/` in the run dir; `provenance.yaml`
   records one entry per clip (`source`, `origin`, `caption`,
   `is_demo_clip: true`).

2. Dispatch `Skill(partnership-microdemo-eval)`. Do not skip.

3. If `partnership-microdemo-eval` returns `verdict: fail`, halt with
   `[BLOCKER]` and surface the eval findings. Downstream skills
   (`partnership-video-build`, `partnership-deck-build`) check
   `phases.microdemo.verdict` and refuse to run on a failed micro-demo.

### Step 5: Video build — dispatch `partnership-video-build` (+ eval)

**Purpose:** Fill the ace-web `partnership-pitch` template, POST the spec,
render, and capture the output URLs.

1. Dispatch `Skill(partnership-video-build)` with the prospect slug and
   run id.

   The skill:
   - Fetches the `partnership-pitch` template skeleton from ace-web
     (`GET /api/w/<ws>/videos/templates/partnership-pitch`). If this
     returns non-200, halt: the template depends on ace-web PR #610
     (multi-angle narration schema + partnership-pitch template) being
     deployed.
   - Fills the skeleton: prospect identity from `prospect.yaml`; all
     three angle variants from `angles.yaml`; `active_angle` = the
     picked angle; `product.beats` from the micro-demo manifest
     (`is_demo_clip: true` on real clips); stat cards from
     `research/deep-research.md`
   - Enforces the no-inferred-backstory rule: every filled value must
     trace to a cited research fact or a real Connect capability; values
     lacking a source are prefixed `[TBD] ` (not silently fabricated)
   - POSTs the filled spec to ace-web, triggers a render, polls until
     done, and saves the editable URL + output URL to `video_spec.yaml`
     and `package.yaml`

2. Dispatch `Skill(partnership-video-build-eval)`. Do not skip.

3. If `partnership-video-build-eval` returns `verdict: fail`, halt.
   Check the eval findings — a surviving `[TBD] ` in the spec signals
   an ungrounded claim that must be addressed before the video ships.

### Step 6: Deck build — dispatch `partnership-deck-build` (+ eval)

**Purpose:** Build the `connect-pitch-partnership` Google Slides pitch deck,
mirroring the video's narrative arc.

1. Dispatch `Skill(partnership-deck-build)` with the prospect slug and
   run id.

   The skill:
   - Builds a `connect-pitch-partnership` deck spec (`TrainingDeckSpec`
     shape) from `prospect.yaml` + `research/` + the picked angle from
     `angles.yaml` + the micro-demo screenshot manifest
   - Renders to Google Slides via the 14-stencil ACE template machinery
     (`slides_copy_template` → `slides_get` → `buildSlidesRequestsV2` →
     `slides_batch_update`), using `ACE_PARTNERSHIP_DECK_TEMPLATE_ID`
     (or `ACE_TRAINING_DECK_TEMPLATE_ID` as fallback)
   - Merges the Slides URL into `package.yaml` (preserving existing
     `video.*` keys)

2. Dispatch `Skill(partnership-deck-build-eval)`. Do not skip.

3. If `partnership-deck-build-eval` returns `verdict: fail`, halt.

### Step 7: Publish — dispatch `partnership-publish`

**Purpose:** Assemble the prospect-facing package and publish to
canopy-web. Requires explicit operator approval before any external send.

1. Dispatch `Skill(partnership-publish)` with the prospect slug and
   run id.

   The skill:
   - Reads `package.yaml` and confirms `video.program_url`,
     `video.media_url`, and `deck.slides_url` are all present
   - Assembles a structured `package_summary.md` (hero video + deck +
     picked narrative summary + cited research appendix)
   - Presents the package to the operator for explicit approval
     (brand-safety gate — see Guardrails below)
   - On approval: publishes to canopy-web via `Skill(canopy:walkthrough-share)`,
     which is dispatched from this level-0 procedure (legal). Captures
     the navigable package URL.
   - Writes the final URLs into `package.yaml` under `canopy_web.*`

   `partnership-publish` has `has_judge: false` — publishing is a
   mechanical handoff; quality was judged in steps 4–6.

2. No eval dispatch for this skill.

### Step 8: Final write-back + run summary

After `partnership-publish` completes, present the final package summary
to the operator:

```
## Partnership Package — Complete

**Prospect:** <name>
**Run:** <run-id>
**Angle selected:** <angle-id> — "<logline>"

| Artifact | URL |
|----------|-----|
| Video (editable) | <video.program_url> |
| Video (render)   | <video.media_url> |
| Pitch deck       | <deck.slides_url> |
| Shareable package | <canopy_web.share_url> |

**Next steps:**
- Review the package before any external send.
- `/ace:partnership-video --produce <other-angle-id> <slug>` to produce a
  second angle variant from the same research.
- File any defects found during review as `gh issue create` against
  the ACE repo's `origin`.
```

---

## Guardrails

These rules are non-negotiable. They derive from ACE conventions and from
the specific stakes of a prospect-facing artifact.

### No inferred backstory (cardinal rule)

Every claim in the angles, video narration, and deck MUST trace to a
cited research fact (from `research/deep-research.md` or
`research/connect-fit.md`) or a real Connect capability (validated against
real PDDs / atoms / case studies — not asserted from memory). This artifact
goes to a prospect. A fabricated stat or invented partnership history is
the worst possible failure class for this pipeline. Ungroundable beats
are flagged `[TBD] ` — never silently filled with plausible-sounding
content.

### Close the loop to the source of truth

Research is verified + cited via `deep-research`. Connect capabilities
are validated against real ACE run artifacts / atoms, not paraphrased
from memory. The `partnership-research-eval` rubric enforces this and
will return `verdict: fail` on ungrounded capability claims.

### Brand safety: human review before any external send

The package contains the prospect's name and their publicly-available
logo alongside Dimagi chrome. It MUST be reviewed and approved by a
human operator before any external send. `partnership-publish` Step 4
(the operator-approval gate) is non-bypassable — the skill never auto-
sends and never auto-publishes without explicit operator confirmation.
Violating this rule is brand-impersonation territory.

Brand composition rule: use the prospect's **name** and their
**publicly-available logo**; keep **Dimagi-branded chrome**. Do not
impersonate the prospect org's full brand identity.

### Phase Write-Back Contract (every skill must comply)

Each skill writes `phases.<phase>.{status, verdict, completed_at,
summary_artifact, steps}` to `run_state.yaml`. The orchestrator verifies
via the run-state validator. Without this, `/ace:status` misreports the
run state and resume-after-interrupt can't tell which phases shipped.
All `update_yaml_file` calls use `merge: 'deep'` for nested patches.

### File issues mid-run

The moment a defect is confirmed (root cause + how ACE should change),
file it as `gh issue create` against the ACE repo's `origin` (no `-R` needed) — one issue per
finding — and keep going. Report every issue filed in the run summary.
Don't defer to run-end (you'll lose the precise repro).

---

## `--generic` unbranded mode

When `--produce` is given with `--generic` (or the slug is `_generic`),
omit all prospect-specific identity: no `prospect.yaml` name/logo/contact
fields; no branded narration; generic Connect framing for all seven beats.
The same narrative library templates, the same machinery, the same
guardrails — just with generic Connect facts filling the slots instead of
prospect-specific ones.

The branded/unbranded seam is thin by design (~5% overlay). `prospect:` in
the ace-web spec is absent in generic mode; `ProspectBranding` is not
rendered. The render result is the "how to create a program on Connect"
explainer video.

---

## How `Agent` / `Skill` dispatches work from this procedure

This procedure runs inline at level 0, which makes the following dispatches
legal:

- `Skill(deep-research)` — invoked inside `partnership-research`; fans
  out web searches and synthesizes a cited report. Internal Agent
  dispatches are legal because the outer session is at level 0.
- `Skill(canopy:walkthrough)` — invoked inside `partnership-microdemo` for
  mock filming when no reusable clip exists.
- `Agent(nova:autobuild)` — invoked inside `partnership-microdemo` to build
  a Nova app stub when a tailored mock is needed.
- `Skill(canopy:walkthrough-share)` — invoked inside `partnership-publish`
  to publish the assembled package to canopy-web.

All four would push to level 2 and fail if this procedure were dispatched
as a subagent. That is the architectural reason this file is executed
inline at level 0 — and the reason you must never write
`Agent(partnership-video)`.
