# Partnership Video — Design Spec

**Date:** 2026-06-06
**Status:** Approved design, pre-plan
**Command:** `/ace:partnership-video`
**Test cases:** Noora Health → Nigeria; Lafiya → beyond Nigeria

---

## 1. North star

Given a prospect organization in active sales discussions — one that runs a real program today but is **not yet on Connect** — produce, mostly autonomously, a **high-gloss narrated video + a matching pitch deck**, grounded in real cited research, tailored to *that org's specific expansion story*, with a **real micro-demo proof moment** showing what their program would look like on Connect.

The deliverable exists to do three things at once (the user's framing):
1. Convey the approach we'd take with them.
2. Impress them with the video/deck itself (production quality).
3. Impress them that it was **AI-generated**.

Two-phase interaction: **propose three narrative angles → human picks one → produce + publish.**

### The durable asset is the narrative library, not any one video

The three angles are **not invented fresh each run.** They instantiate a **library of three reusable narrative templates** that we author once and **iterate on as we learn from the first two real prospects** (Noora, Lafiya). Each run *grounds* those three narratives in the specific prospect's research; it does not re-derive them.

Corollary — **branded vs. unbranded is a ~5% overlay.** The prospect identity + branding is a thin skin on top of the narrative templates. Remove it and the *same* machinery produces an **unbranded "This is how it works to create a program on Connect"** explainer video. Designing for this from day one keeps the narratives generic and forces a clean seam between "the story" (95%, reusable) and "who it's for" (5%, swappable).

---

## 2. Interaction model

```
# Phase 1 — propose (cheap, no render)
/ace:partnership-video "in discussions with Noora Health about expanding to Nigeria"
  → Profile + deep research + Connect-fit
  → returns THREE narrative angles, each = one reusable narrative template
    grounded in this prospect:
      · title + logline
      · arc / beats
      · hero (whose POV)
      · emotional beat
      · the Connect capability it leans on
      · the grounded research facts it stands on (cited)

# Phase 2 — produce (the expensive half)
You: "do angle 2"   (or)   /ace:partnership-video --produce <angle-id>
  → micro-demo sourcing (reuse-or-mock)
  → fill ace-web spec (all 3 variants embedded; #2 active)
  → render video · build deck · publish package
  → returns: ace-web editable video URL · Google Slides deck URL · canopy-web package URL
```

### Modes & flags

- `--prospect-folder <drive-id>` — optional operator-context booster (call notes, their deck, MoU drafts). Highest-signal but not required.
- `--workspace <slug>` — ace-web workspace (default per env).
- `--angles N` — default 3 (one per narrative template).
- `--produce <angle-id>` — enter phase 2 for a previously-proposed angle.
- `--generic` — **unbranded mode**: no prospect; produce the "How to create a program on Connect" explainer using the same narratives with generic Connect framing.
- `--no-render` — fill specs but skip the render/poll (spec-only dry run).

---

## 3. Reusable narrative template library

A first-class, versioned set of **three** narrative templates. These are the thing we improve over time.

- **Storage:** `templates/partnership-narratives/<narrative-id>/narrative.yaml` in the ACE repo (versioned, code-reviewed). Each carries a `version` and a changelog stub so we can track what we learned from Noora/Lafiya.
- **Shape (per narrative):** id, title, one-line thesis, target emotional beat, hero/POV, ordered beats mapped to the ace-web `partnership-pitch` beat structure, per-beat **narration intent** (what the beat must accomplish + word budget) with `{{slots}}` for prospect-grounded facts, and the **primary Connect capability** it showcases.
- **Grounding, not generation:** the `partnership-angles` skill fills each narrative's slots from the research + Connect-fit memo. It does **not** invent arcs. If a narrative can't be grounded for this prospect (missing facts), it says so honestly rather than fabricating (see §7 No inferred backstory).
- **Starter set (provisional — to be refined after the first two runs):**
  1. **"A day in the life"** — single FLW/nurse POV; intimate; the work made easier/visible. Capability lean: Learn→Deliver→Verify→Pay loop on the ground.
  2. **"The scale gap"** — the reach math; proven model, 10× the people. Capability lean: rapid program stand-up + payment-for-verified-delivery at scale.
  3. **"Trust travels"** — proven model, new geography; de-risking expansion. Capability lean: verification/quality + funder-grade reporting.
- **Iteration cadence:** after each real prospect run, a short retro updates the narratives (what landed, what felt generic). Version bump + changelog entry. The library is expected to churn early and stabilize.

The same three narratives back the `--generic` explainer (slots filled with generic Connect facts instead of prospect facts).

---

## 4. State model (Drive)

These are **not** Connect opportunities, so they live under a new root, parallel to `ACE/<opp>/`:

```
ACE/partnerships/<prospect-slug>/
  prospect.yaml            # identity: name, slug, current program, target geography,
                           # the person/contact, sector, branding refs
  research/
    deep-research.md       # cited org profile (deep-research output)
    connect-fit.md         # what Connect specifically unlocks for this org+geo
  runs/<run-id>/
    angles.yaml            # the 3 grounded narrative angles  ← propose-phase artifact
    selected_angle         # which was picked
    video_spec.yaml        # ace-web spec (all 3 variants; active set)
    deck_spec.yaml         # pitch-deck spec
    micro-demo/            # sourced/mocked clips + reuse-vs-mock provenance
    package.yaml           # final URLs (ace-web video, slides deck, canopy-web package)
    run_state.yaml         # Phase Write-Back Contract (status/verdict/products per phase)
```

`--generic` runs live under `ACE/partnerships/_generic/` with prospect fields blank.

Two-phase = two invocations writing the same `runs/<run-id>/`. Runs are independent (ACE run-independence rule); the narrative library and `prospect.yaml` are the cross-run durable state.

---

## 5. Pipeline

All steps run **inline at level 0** because the orchestrator dispatches `Agent` (deep-research, canopy walkthrough, Nova for mocks). Per ACE topology, anything that calls `Agent` cannot be a subagent — so the orchestrator is a **procedure doc executed inline by the slash command** (the `ace-orchestrator` / `commcare-setup` pattern), never an `Agent(partnership-video)` dispatch.

| # | Phase | Does | Reuses |
|---|-------|------|--------|
| 1 | **Profile** | Parse prospect from the prompt → `prospect.yaml`; read `--prospect-folder` if given. | gdrive MCP |
| 2 | **Research** | Deep web research: what they do, scale, model, geography, the expansion thesis. Verified + cited. | `deep-research` skill |
| 3 | **Connect-fit** | Cross-reference Connect/Dimagi capability against existing ACE PDDs / program library / case studies → fit-memo: what Connect unlocks for this org in the target geo. | ACE Drive PDDs, WebSearch |
| 4 | **Ideate** | Ground all three narrative-library templates against research + fit → `angles.yaml`. **Propose phase stops here; return to human.** | `partnership-angles` skill + narrative library |
| 5 | *(gate)* | Human picks an angle (and may tweak). | — |
| 6 | **Micro-demo sourcing** | Per proof clip: reuse from ace-web/Connect media library when a match exists; else lightweight mock (Nova app stub filmed via canopy walkthrough, or Connect-styled clickable mock filmed headless). Provenance recorded. | `walkthrough`, `record_video`, `nova autobuild`, gstack browse |
| 7 | **Video build** | Fill the ace-web `partnership-pitch` template: prospect branding, all 3 narration variants (active = pick), product beats = reused + mock clips + research stat-cards → POST → render → poll. | ace-web video API |
| 8 | **Deck build** | Fill `partnership-pitch-deck` Slides bundle → Google Slides. Mirrors the video arc + adds the business case + the ask. | training-deck stencil machinery (`slides_copy_template`, `slides_batch_update`) |
| 9 | **Publish** | Assemble canopy-web package (hero video + deck + narrative + research appendix), external-release gate, publish → navigable URL. | canopy-web package / `walkthrough-share` |
| 10 | **Write-back + eval** | `run_state.yaml` products + partnership `-eval` rubric. | run-state-validator, opp-eval pattern |

---

## 6. ace-web platform work — *improving the template-narrative concept*

ace-web's video system auto-discovers templates from `templates/<id>/` (`template.yaml`, `spec.template.yaml`, `generate.prompt.md`), renders via Remotion with per-beat ElevenLabs narration, and exposes a run/render API + a browser beat-editor. It has **no multi-angle narrative concept today** — narration is a single `by_beat` block per spec. The work below makes multi-angle narrative first-class.

### Phase 1 (A) — thin platform, backward-compatible

In `video-production/connect-videos/`:
- **Schema** (`src/lib/spec.ts`): add `narration.variants[]` `{angle_id, description, by_beat}` + `narration.active_angle`. Legacy single `by_beat` still renders (fallback). Add a `prospect{}` block (`name`, `logo_asset?`, `region?`, `sector?`). Add `is_demo_clip?` to product beats (skip Ken Burns; play the real clip as-is).
- **Template:** new `templates/partnership-pitch/` (the 3 files), whose `narration.variants` map 1:1 to the three narrative-library templates.
- **Render:** resolve the active variant in `Intro` / `ProgramBody`; conditional `ProspectBranding` overlay (logo + name), Dimagi chrome otherwise → this is the branded/unbranded seam.

Net effect: angle-swap is a metadata edit (all variants live in the spec); branded vs. unbranded is `prospect{}` present-or-absent.

### Phase 2 (B) — platform-rich editor UI

- `NarrativeAnglePanel` — swap the active angle in the browser (metadata-only; re-synth on next render).
- `ProspectPanel` — edit name/logo.
- demo-clip beat type in the clip picker.
- Server-side "generate N variants" endpoint so the product can re-ideate without the CLI.

### (C) — fallback only

If ace-web render is unavailable, stitch canopy walkthrough clips into an MP4. Not a primary path; documented so the skill degrades instead of failing hard.

---

## 7. Skills, commands, files

ACE-topology-correct layout:

- `commands/partnership-video.md` — slash command (thin; points at the procedure doc).
- `agents/partnership-video.md` — **procedure doc executed inline at level 0** (the orchestrator). Frontmatter retained so `/ace:status` / `/ace:eval` keep working.
- `skills/`:
  - `partnership-research` (+ `-qa`, `-eval`) — prospect deep research + Connect-fit memo.
  - `partnership-angles` (+ `-eval`) — ground the three narrative templates; eval = grounded / distinct / capability-tied.
  - `partnership-microdemo` (+ `-eval`) — source-or-mock proof clips with provenance.
  - `partnership-video-build` (+ `-eval`) — fill ace-web spec, render, poll.
  - `partnership-deck-build` (+ `-eval`) — fill pitch-deck spec, render Slides.
  - `partnership-publish` — assemble + publish canopy-web package.
- `templates/partnership-narratives/<id>/narrative.yaml` — the three reusable narratives (versioned).
- `templates/partnership-deck/` — new Slides stencil bundle for the pitch deck.
- ace-web: `templates/partnership-pitch/` + schema extension (Phase 1), editor UI (Phase 2).

---

## 8. Guardrails (ACE conventions — load-bearing here)

- **No inferred backstory (cardinal rule).** Every claim in the angles, video narration, and deck must trace to a cited research fact or a real Connect capability. This artifact goes to a prospect — a fabricated stat or invented partnership history is the worst possible failure. Ungroundable beats are flagged, not filled.
- **Close the loop to the source of truth.** Research is verified + cited; Connect capabilities are validated against real PDDs / atoms / case studies, not asserted from memory.
- **Phase Write-Back Contract.** Every phase writes `phases.<phase>.{status, verdict, completed_at, summary_artifact, steps}` to `run_state.yaml`.
- **QA vs Eval, two-phase.** Each skill captures (QA) + an LLM judge grades (`-eval`) against a partnership rubric: **grounding · distinctness · persuasiveness · production polish · factual/brand safety.**
- **Restore-not-adapt** preconditions for render + mock surfaces.
- **File ACE issues mid-run** the moment a defect is confirmed; report them in the run summary.

---

## 9. Default sub-decisions (settled; revisit if wrong)

- **Brand safety:** use the prospect's **name** + their **publicly-available logo**, but keep **Dimagi-branded chrome**. The whole package is **flagged for human review before any external send** (no auto-send). Avoids brand-impersonation / legal risk.
- **Deck:** ~10–12 slide pitch deck — cover → their world/problem → expansion thesis → how Connect works → micro-demo proof → business case → the ask. Reuses existing stencils + a few new pitch stencils.
- **Share surface of record:** **canopy-web** for the shareable package; **ace-web** remains the *editable* video home.

---

## 10. Phasing

1. **Phase 1 (A) — first real video+deck.** Narrative library (3 starter narratives) + ace-web `partnership-pitch` template + minimal schema extension + the level-0 command + the six skills + pitch-deck Slides bundle + canopy-web publish. Run Noora and Lafiya end-to-end.
2. **Retro + narrative iteration.** Refine the three narratives from what the first two runs taught us (version bump + changelog).
3. **Phase 2 (B) — platform-rich editor UI** in ace-web.
4. **Unbranded explainer** validated via `--generic` (should fall out of Phase 1 nearly for free; confirm the 95/5 seam holds).

---

## 11. Open questions to resolve during planning

- Exact ace-web checkout/PR flow for the schema + template change (sibling repo; its own branch/PR).
- Whether the narrative library lives in the ACE repo (proposed) or is mirrored into ace-web's `templates/partnership-pitch/` at build time — single source of truth must be unambiguous.
- canopy-web package shape for a *prospect-facing* (not internal-feature) artifact — reuse `ddd-upload`'s packager or a new partnership package type.
- Micro-demo mock fidelity bar: when is a Nova stub "good enough to film" vs. a hand-built clickable mock.
