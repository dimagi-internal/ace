# Partnership Video — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/ace:partnership-video` — a two-phase ACE command that researches a non-Connect prospect org, proposes three grounded narrative angles from a reusable library, and (on pick) produces a high-gloss narrated video + pitch deck published as a shareable package.

**Architecture:** Two subsystems shipped as two PRs to two repos. **Part A** (ace-web, `github.com/jjackson/ace-web`) makes multi-angle narration + prospect branding first-class in the Remotion video spec and adds a `partnership-pitch` video template. **Parts B–E** (ace-web's sibling, `github.com/jjackson/ace`) add the reusable narrative library, a pitch-deck template bundle (reusing the training-deck Slides machinery), six skills, a level-0 procedure doc, and the slash command. The ACE orchestrator dispatches `Agent` (deep-research, canopy walkthrough, Nova) so it runs **inline at level 0**, never as a subagent.

**Tech Stack:** ace-web — TypeScript + Zod + Remotion + vitest (video lib), Django Ninja + pytest (API). ACE plugin — TypeScript + Zod + vitest (lib), Markdown SKILL.md + YAML templates, Google Slides via `ace-gdrive` MCP, `deep-research` / `canopy:walkthrough` / `nova:autobuild` via `Agent`.

**Source spec:** `docs/superpowers/specs/2026-06-06-partnership-video-design.md`

**Out of scope for Phase 1 (separate later plans):** ace-web browser editor UI (NarrativeAnglePanel, ProspectPanel, demo-clip beat type, server-side variant generation) — design §6 Phase 2; the post-run narrative retro/iteration loop — design §10 step 2; full `--generic` unbranded validation — design §10 step 4 (the seam is built in Phase 1 but only smoke-checked).

---

## File Structure

### Part A — ace-web repo (`/Users/jjackson/emdash/worktrees/ace-web/emdash/beats-x788j/`)
- Modify: `video-production/connect-videos/src/lib/spec.ts` — add `NarrationVariant`, `narration.variants[]`, `narration.active_angle`, `prospect{}`, `ProductBeat.is_demo_clip`; add `resolveActiveByBeat(spec)` helper.
- Modify: `video-production/connect-videos/src/lib/spec.test.ts` — tests for the new schema + helper.
- Create: `video-production/connect-videos/src/lib/__fixtures__/partnership-valid.yaml` — fixture spec with 3 variants.
- Modify: `video-production/connect-videos/scripts/render.ts` — read narration via `resolveActiveByBeat(spec)` instead of `spec.narration.by_beat` directly (two sites).
- Create: `video-production/connect-videos/templates/partnership-pitch/template.yaml`
- Create: `video-production/connect-videos/templates/partnership-pitch/spec.template.yaml`
- Create: `video-production/connect-videos/templates/partnership-pitch/generate.prompt.md`
- Modify: `apps/videos/tests/test_templates.py` — assert `partnership-pitch` loads + skeleton starts at `provenance:`.

### Part B — ACE narrative library (`/Users/jjackson/emdash/worktrees/ace/emdash/video-axlow/`)
- Create: `lib/partnership-narrative.ts` — Zod schema + loader/validator for the 3 reusable narratives.
- Create: `test/lib/partnership-narrative.test.ts` — schema + loader tests.
- Create: `templates/partnership-narratives/day-in-the-life/narrative.yaml`
- Create: `templates/partnership-narratives/the-scale-gap/narrative.yaml`
- Create: `templates/partnership-narratives/trust-travels/narrative.yaml`
- Create: `test/templates/partnership-narratives.test.ts` — every on-disk narrative parses + has all beats.

### Part C — ACE pitch-deck bundle
- Modify: `lib/training-deck-spec.ts` — add `'partnership-pitch'` to the archetype enum and `'prospect'` to the `voice.audience` enum.
- Modify: `test/lib/training-deck-spec.test.ts` — tests for the two enum additions.
- Create: `templates/training-deck/connect-pitch-partnership/template.yaml`
- Create: `templates/training-deck/connect-pitch-partnership/spec.template.yaml`
- Create: `templates/training-deck/connect-pitch-partnership/generate.prompt.md`

### Part D — ACE skills + orchestration
- Create: `skills/partnership-research/SKILL.md` (+ `partnership-research-qa/`, `partnership-research-eval/`)
- Create: `skills/partnership-angles/SKILL.md` (+ `partnership-angles-eval/`)
- Create: `skills/partnership-microdemo/SKILL.md` (+ `partnership-microdemo-eval/`)
- Create: `skills/partnership-video-build/SKILL.md` (+ `partnership-video-build-eval/`)
- Create: `skills/partnership-deck-build/SKILL.md` (+ `partnership-deck-build-eval/`)
- Create: `skills/partnership-publish/SKILL.md`
- Create: `agents/partnership-video.md` — level-0 procedure doc (orchestrator).
- Create: `commands/partnership-video.md` — slash command.

### Part E — wiring + ship
- Modify: `.env.tpl` — add `ACE_PARTNERSHIP_DECK_TEMPLATE_ID` (defaults to reuse `ACE_TRAINING_DECK_TEMPLATE_ID`).
- Modify: `lib/artifact-manifest.ts` — register the new per-run artifacts + `partnerships/` root.
- Modify: `CLAUDE.md` — document `/ace:partnership-video` in the commands list.
- Version bump + PRs (both repos).

---

## Conventions every task must follow

- **ace-web tests:** `cd /Users/jjackson/emdash/worktrees/ace-web/emdash/beats-x788j/video-production/connect-videos && npm test` (vitest) and `npm run typecheck`. Python: `cd /Users/jjackson/emdash/worktrees/ace-web/emdash/beats-x788j && pytest apps/videos/tests/test_templates.py`.
- **ACE tests:** `cd /Users/jjackson/emdash/worktrees/ace/emdash/video-axlow && npm test` (vitest).
- **Commit cadence:** one commit per task (after its tests pass). Conventional-commit prefixes (`feat:`, `test:`, `docs:`).
- **No direct push to either `main`** — both are branch-protected. Ship via PR with `gh pr merge <pr> --auto --merge`.
- **Co-author trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## Part 0 — Branch setup

### Task 0: Create feature branches in both repos

**Files:** none (git only)

- [ ] **Step 1: ACE branch**

The ACE work happens on the current worktree branch. Confirm:

```bash
cd /Users/jjackson/emdash/worktrees/ace/emdash/video-axlow && git branch --show-current
```
Expected: `emdash/video-axlow` (the spec + this plan are already committed here). Use this branch for Parts B–E.

- [ ] **Step 2: ace-web branch**

```bash
cd /Users/jjackson/emdash/worktrees/ace-web/emdash/beats-x788j && git fetch origin && git checkout -b feat/partnership-pitch-template origin/main
```
Expected: new branch off latest `main`. Use this for Part A.

- [ ] **Step 3: Confirm test baselines are green before changing anything**

```bash
cd /Users/jjackson/emdash/worktrees/ace-web/emdash/beats-x788j/video-production/connect-videos && npm test
cd /Users/jjackson/emdash/worktrees/ace/emdash/video-axlow && npm test
```
Expected: both suites PASS. If not, stop and report — do not build on a red baseline.

---

## Part A — ace-web platform: multi-angle narration + prospect branding

> All paths in Part A are under `/Users/jjackson/emdash/worktrees/ace-web/emdash/beats-x788j/`. Work on branch `feat/partnership-pitch-template`.

### Task A1: Extend the spec schema with narration variants

**Files:**
- Modify: `video-production/connect-videos/src/lib/spec.ts`
- Test: `video-production/connect-videos/src/lib/spec.test.ts`

The current `narration` block is (verbatim):
```typescript
  narration: z.object({
    generator: z.enum(["manual", "anthropic"]),
    prompt_version: z.string().min(1),
    script: z.string(),
    start_seconds: z.number().nonnegative().default(0),
    duration_seconds: z.number().positive().optional(),
    by_beat: z.record(z.string(), z.string()).optional(),
  }),
```
We add an optional `variants[]` + `active_angle`, keeping `by_beat` for backward compatibility.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/spec.test.ts`:

```typescript
import { loadProgramSpec, resolveActiveByBeat } from "./spec.node";

describe("narration variants", () => {
  const base = `
slug: noora-nigeria
name: Noora Health
country_focus: Nigeria
status: "[TBD] status"
tagline: t
program_url: https://example.org
scene: { clips: [a], lower_third: "Nigeria · Noora" }
problem: { big: "1", caption: c, source: s }
product:
  beats: [{ asset: a, caption: b }]
impact:
  - { big: "1", caption: x }
  - { big: "2", caption: y }
voice: { provider: elevenlabs, voice_id: v, model: eleven_turbo_v2 }
`;

  it("accepts a narration block with variants + active_angle", () => {
    const yaml = base + `
narration:
  generator: manual
  prompt_version: v3-partnership
  script: ""
  active_angle: the-scale-gap
  variants:
    - angle_id: day-in-the-life
      by_beat: { hook: "h1", cycle: "c1" }
    - angle_id: the-scale-gap
      by_beat: { hook: "h2", cycle: "c2" }
`;
    const spec = loadProgramSpec(yaml, { fromString: true });
    expect(spec.narration.variants).toHaveLength(2);
    expect(spec.narration.active_angle).toBe("the-scale-gap");
  });

  it("resolveActiveByBeat returns the active variant's by_beat", () => {
    const yaml = base + `
narration:
  generator: manual
  prompt_version: v3-partnership
  script: ""
  active_angle: the-scale-gap
  variants:
    - angle_id: day-in-the-life
      by_beat: { hook: "h1" }
    - angle_id: the-scale-gap
      by_beat: { hook: "h2" }
`;
    const spec = loadProgramSpec(yaml, { fromString: true });
    expect(resolveActiveByBeat(spec)).toEqual({ hook: "h2" });
  });

  it("resolveActiveByBeat falls back to legacy by_beat when no variants", () => {
    const yaml = base + `
narration:
  generator: manual
  prompt_version: v3
  script: ""
  by_beat: { hook: "legacy" }
`;
    const spec = loadProgramSpec(yaml, { fromString: true });
    expect(resolveActiveByBeat(spec)).toEqual({ hook: "legacy" });
  });

  it("rejects active_angle that names no variant", () => {
    const yaml = base + `
narration:
  generator: manual
  prompt_version: v3-partnership
  script: ""
  active_angle: nonexistent
  variants:
    - angle_id: day-in-the-life
      by_beat: { hook: "h1" }
`;
    expect(() => loadProgramSpec(yaml, { fromString: true }))
      .toThrowError(/active_angle/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd video-production/connect-videos && npx vitest run src/lib/spec.test.ts -t "narration variants"`
Expected: FAIL — `resolveActiveByBeat` is not exported; variant fields rejected by schema.

- [ ] **Step 3: Implement the schema + helper in `src/lib/spec.ts`**

Add the variant schema above `ProgramSpecSchema`:

```typescript
const NarrationVariantSchema = z.object({
  angle_id: z.string().min(1),
  description: z.string().min(1).optional(),
  by_beat: z.record(z.string(), z.string()),
});
```

Replace the `narration:` object inside `ProgramSpecSchema` with:

```typescript
  narration: z.object({
    generator: z.enum(["manual", "anthropic"]),
    prompt_version: z.string().min(1),
    script: z.string(),
    start_seconds: z.number().nonnegative().default(0),
    duration_seconds: z.number().positive().optional(),
    by_beat: z.record(z.string(), z.string()).optional(),
    // Multi-angle narration: each variant is one reusable narrative
    // angle's per-beat text. active_angle selects which renders. When
    // absent, the renderer falls back to the legacy single by_beat.
    variants: z.array(NarrationVariantSchema).optional(),
    active_angle: z.string().min(1).optional(),
  }).refine(
    (n) => !n.active_angle || (n.variants?.some((v) => v.angle_id === n.active_angle) ?? false),
    { message: "narration.active_angle must match a variants[].angle_id" },
  ),
```

Add the exported helper near the bottom of the file (after `export type ProgramSpec`):

```typescript
/**
 * The per-beat narration that should actually render. Prefers the
 * active variant (multi-angle specs); falls back to the legacy single
 * by_beat for older specs; empty object if neither is present.
 */
export function resolveActiveByBeat(spec: ProgramSpec): Record<string, string> {
  const n = spec.narration;
  if (n.variants && n.variants.length > 0) {
    const active = n.active_angle
      ? n.variants.find((v) => v.angle_id === n.active_angle)
      : n.variants[0];
    if (active) return active.by_beat;
  }
  return n.by_beat ?? {};
}
```

> Note: `resolveActiveByBeat` is imported from `./spec.node` in the tests because that's the module the existing tests import `loadProgramSpec` from. Confirm whether `spec.node.ts` re-exports from `spec.ts`; if `loadProgramSpec` lives in `spec.node.ts` and the schema in `spec.ts`, export `resolveActiveByBeat` from `spec.ts` and re-export it from `spec.node.ts` so both import paths resolve. Run `grep -n "loadProgramSpec\|export" src/lib/spec.node.ts` first.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/spec.test.ts && npm run typecheck`
Expected: PASS (including the pre-existing spec tests — backward compatibility intact).

- [ ] **Step 5: Commit**

```bash
git add video-production/connect-videos/src/lib/spec.ts video-production/connect-videos/src/lib/spec.test.ts
git commit -m "feat(videos): multi-angle narration variants + resolveActiveByBeat

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task A2: Add prospect branding + is_demo_clip to the schema

**Files:**
- Modify: `video-production/connect-videos/src/lib/spec.ts`
- Test: `video-production/connect-videos/src/lib/spec.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/spec.test.ts`:

```typescript
describe("prospect + is_demo_clip", () => {
  const base = `
slug: noora-nigeria
name: Noora Health
country_focus: Nigeria
status: s
tagline: t
program_url: https://example.org
scene: { clips: [a], lower_third: "x" }
problem: { big: "1", caption: c, source: s }
impact:
  - { big: "1", caption: x }
  - { big: "2", caption: y }
narration: { generator: manual, prompt_version: v3, script: x, by_beat: { hook: h } }
voice: { provider: elevenlabs, voice_id: v, model: eleven_turbo_v2 }
`;

  it("accepts a prospect block", () => {
    const spec = loadProgramSpec(base + `
prospect: { name: "Noora Health", logo_asset: "@prospect_logo", region: "Nigeria", sector: "MNCH" }
product: { beats: [{ asset: a, caption: b }] }
`, { fromString: true });
    expect(spec.prospect?.name).toBe("Noora Health");
  });

  it("accepts is_demo_clip on a product beat and defaults it false", () => {
    const spec = loadProgramSpec(base + `
product:
  beats:
    - { asset: clip.mp4, caption: "real demo", is_demo_clip: true }
    - { asset: shot.png, caption: "screenshot" }
`, { fromString: true });
    expect(spec.product.beats[0].is_demo_clip).toBe(true);
    expect(spec.product.beats[1].is_demo_clip).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/spec.test.ts -t "prospect"`
Expected: FAIL — `prospect` unknown key; `is_demo_clip` unknown key.

- [ ] **Step 3: Implement**

Add `is_demo_clip` to `ProductBeatSchema` (current schema has `asset`, `caption`, `start_seconds`, `duration_seconds`):

```typescript
const ProductBeatSchema = z.object({
  asset: z.string().min(1),
  caption: z.string().min(1),
  start_seconds: z.number().nonnegative().default(0),
  duration_seconds: z.number().positive().optional(),
  // When true the renderer plays the asset as a real video clip
  // (no Ken Burns still-zoom). Used for micro-demo walkthrough clips.
  is_demo_clip: z.boolean().default(false),
});
```

Add a `ProspectSchema` above `ProgramSpecSchema` and an optional `prospect` field inside `ProgramSpecSchema` (place it right after `program_url`):

```typescript
const ProspectSchema = z.object({
  name: z.string().min(1),
  logo_asset: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  sector: z.string().min(1).optional(),
});
```
```typescript
  program_url: z.string().url(),
  // Optional prospect identity for partnership-pitch videos. Absent =
  // unbranded "how Connect works" explainer (Dimagi chrome only).
  prospect: ProspectSchema.optional(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/spec.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add video-production/connect-videos/src/lib/spec.ts video-production/connect-videos/src/lib/spec.test.ts
git commit -m "feat(videos): prospect branding block + is_demo_clip product-beat flag

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task A3: Wire the renderer to read the active variant

**Files:**
- Modify: `video-production/connect-videos/scripts/render.ts` (two sites: narration synth ~line 163, captions ~line 204)

- [ ] **Step 1: Locate the two read sites**

Run: `grep -n "narration.by_beat" scripts/render.ts`
Expected: two matches (synthesis branch + captions branch).

- [ ] **Step 2: Replace both reads with the resolver**

At the top of `render.ts`, ensure `resolveActiveByBeat` is imported from the same module `loadProgramSpec`/spec types come from (e.g. `import { ..., resolveActiveByBeat } from "../src/lib/spec.node";` — match the existing import path).

Compute once after the spec is loaded:
```typescript
const activeByBeat = resolveActiveByBeat(spec);
```
Then change the synthesis branch from:
```typescript
} else if (spec.narration.by_beat) {
  ...
  byBeat: spec.narration.by_beat,
```
to:
```typescript
} else if (Object.keys(activeByBeat).length > 0) {
  ...
  byBeat: activeByBeat,
```
And the captions branch from:
```typescript
  : spec.narration.by_beat
    ? captionsFromBeats(timeline.beats, spec.narration.by_beat)
```
to:
```typescript
  : Object.keys(activeByBeat).length > 0
    ? captionsFromBeats(timeline.beats, activeByBeat)
```

- [ ] **Step 3: Typecheck (render.ts has no unit test; typecheck is the gate)**

Run: `npm run typecheck`
Expected: PASS, no references to the old direct `by_beat` reads remain except inside `resolveActiveByBeat`.

- [ ] **Step 4: Manual render smoke (optional but recommended before PR)**

If an ElevenLabs key + a fixture spec are available locally, render the Task A4 fixture to confirm the variant is voiced. Otherwise note "render smoke deferred to end-to-end (Task E5)".

- [ ] **Step 5: Commit**

```bash
git add video-production/connect-videos/scripts/render.ts
git commit -m "feat(videos): render active narration variant via resolveActiveByBeat

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task A4: Author the `partnership-pitch` video template bundle

**Files:**
- Create: `video-production/connect-videos/templates/partnership-pitch/template.yaml`
- Create: `video-production/connect-videos/templates/partnership-pitch/spec.template.yaml`
- Create: `video-production/connect-videos/templates/partnership-pitch/generate.prompt.md`
- Create: `video-production/connect-videos/src/lib/__fixtures__/partnership-valid.yaml`
- Test: `apps/videos/tests/test_templates.py`

The template loader (`apps/videos/templates.py`) auto-discovers any dir with the three files; no code change needed for discovery.

- [ ] **Step 1: Write `template.yaml`**

```yaml
# Template metadata for the partnership-pitch video.
id: partnership-pitch
name: Partnership pitch (prospect org)
description: |
  90-second pitch tailored to a prospect organization that runs a real
  program today but is not yet on Connect. Carries three selectable
  narrative angles (one per reusable narrative template), prospect
  branding, and a real micro-demo proof clip. Drop the prospect block
  and the same template produces the unbranded "how Connect works"
  explainer.
expected_duration_seconds: 90
intended_audience: |
  A prospect org's decision-makers in active partnership discussions —
  e.g. an NGO expanding to a new country. Quiet documentary pacing.
when_to_use: |
  - You are in discussions with an org not yet on Connect.
  - You have research-grounded narrative angles + at least one micro-demo clip.
  - For the generic explainer, omit prospect and use generic narration.
```

- [ ] **Step 2: Write `spec.template.yaml`**

Mirror the 60s template's placeholder-doc-header convention (the loader strips the leading comment block). Key differences: `prospect:` block, `narration.variants[]` with all three angles, `active_angle`.

```yaml
# Partnership-pitch — spec skeleton.
#
# The loader strips this comment block before returning the skeleton.
# Placeholders the generator must fill:
#   {{prospect_slug}} {{workspace_slug}} {{prospect_name}} {{country_focus}}
#   {{status}} {{tagline}} {{prospect_url}} {{template_id}} {{generated_at}}
#   {{prospect_region}} {{prospect_sector}} {{prospect_logo_ref}}
#   {{scene_lower_third}} {{problem_big}} {{problem_caption}} {{problem_source}}
#   {{impact_1_big}} {{impact_1_caption}} {{impact_2_big}} {{impact_2_caption}}
#   {{active_angle}}  — the picked narrative angle id
#   Per-angle, per-beat narration (one set per angle, each ±2 words of budget):
#     {{narration_<angle>_hook}} ... _cycle _handoff _scene _problem _product _impact
#
# manifest / scene.clips / product.beats are populated by the skill from
# sourced micro-demo clips + research stat cards, not by placeholder.

provenance:
  generator: partnership-video
  template: "{{template_id}}"
  generated_from: "{{prospect_url}}"
  generated_at: "{{generated_at}}"

slug: "{{prospect_slug}}"
workspace: "{{workspace_slug}}"
name: "{{prospect_name}}"
country_focus: "{{country_focus}}"
status: "{{status}}"
tagline: "{{tagline}}"
program_url: "{{prospect_url}}"

prospect:
  name: "{{prospect_name}}"
  logo_asset: "{{prospect_logo_ref}}"
  region: "{{prospect_region}}"
  sector: "{{prospect_sector}}"

manifest: {}

scene:
  clips: []
  lower_third: "{{scene_lower_third}}"

problem:
  big: "{{problem_big}}"
  caption: "{{problem_caption}}"
  source: "{{problem_source}}"

product:
  beats: []

impact:
- big: "{{impact_1_big}}"
  caption: "{{impact_1_caption}}"
- big: "{{impact_2_big}}"
  caption: "{{impact_2_caption}}"

narration:
  generator: manual
  prompt_version: v1-partnership-angles
  start_seconds: 0
  script: ""
  active_angle: "{{active_angle}}"
  variants:
  - angle_id: day-in-the-life
    by_beat:
      hook: "{{narration_day_in_the_life_hook}}"
      cycle: "{{narration_day_in_the_life_cycle}}"
      handoff: "{{narration_day_in_the_life_handoff}}"
      scene: "{{narration_day_in_the_life_scene}}"
      problem: "{{narration_day_in_the_life_problem}}"
      product: "{{narration_day_in_the_life_product}}"
      impact: "{{narration_day_in_the_life_impact}}"
      cta: ""
  - angle_id: the-scale-gap
    by_beat:
      hook: "{{narration_the_scale_gap_hook}}"
      cycle: "{{narration_the_scale_gap_cycle}}"
      handoff: "{{narration_the_scale_gap_handoff}}"
      scene: "{{narration_the_scale_gap_scene}}"
      problem: "{{narration_the_scale_gap_problem}}"
      product: "{{narration_the_scale_gap_product}}"
      impact: "{{narration_the_scale_gap_impact}}"
      cta: ""
  - angle_id: trust-travels
    by_beat:
      hook: "{{narration_trust_travels_hook}}"
      cycle: "{{narration_trust_travels_cycle}}"
      handoff: "{{narration_trust_travels_handoff}}"
      scene: "{{narration_trust_travels_scene}}"
      problem: "{{narration_trust_travels_problem}}"
      product: "{{narration_trust_travels_product}}"
      impact: "{{narration_trust_travels_impact}}"
      cta: ""

voice:
  provider: elevenlabs
  voice_id: "XB0fDUnXU5powFXDhCwa"
  model: eleven_turbo_v2
```

- [ ] **Step 3: Write `generate.prompt.md`**

This prompt is consumed by the ACE `partnership-video-build` skill, not by ace-web. It must instruct: fill identity from `prospect.yaml`; fill all three angles' beats from `angles.yaml` (each angle = one library narrative grounded in research); set `active_angle` to the picked angle; populate `product.beats` from the sourced micro-demo manifest (set `is_demo_clip: true` on real walkthrough clips); prefix any value lacking a research source with `[TBD] ` and never invent stats (design §8 no-inferred-backstory). End with the JSON output key list (one key per placeholder above). Model it structurally on the 60s template's `generate.prompt.md` (sections: "what this is for", "word budgets", "grounding rules", "output format").

- [ ] **Step 4: Write the fixture `src/lib/__fixtures__/partnership-valid.yaml`**

A fully-filled minimal partnership spec (no `{{}}` tokens, 3 variants, one `is_demo_clip: true` beat, a `prospect` block) used by render smoke + as a schema fixture. Keep narration short.

- [ ] **Step 5: Extend the Python template test**

Add to `apps/videos/tests/test_templates.py`:

```python
def test_load_template_partnership_pitch_strips_doc_header():
    bundle = templates.load_template("partnership-pitch")
    assert bundle is not None
    assert bundle.skeleton_yaml.splitlines()[0].startswith("provenance:")
    assert "narrative" not in bundle.skeleton_yaml.splitlines()[0].lower()
    # all three angle ids present in the skeleton
    for angle in ("day-in-the-life", "the-scale-gap", "trust-travels"):
        assert angle in bundle.skeleton_yaml
```

- [ ] **Step 6: Run tests**

```bash
cd /Users/jjackson/emdash/worktrees/ace-web/emdash/beats-x788j
pytest apps/videos/tests/test_templates.py -q
cd video-production/connect-videos && npx vitest run src/lib/spec.test.ts
```
Expected: PASS. (Add a vitest case loading `partnership-valid.yaml` via `loadProgramSpec` if not already covered.)

- [ ] **Step 7: Commit**

```bash
cd /Users/jjackson/emdash/worktrees/ace-web/emdash/beats-x788j
git add video-production/connect-videos/templates/partnership-pitch apps/videos/tests/test_templates.py video-production/connect-videos/src/lib/__fixtures__/partnership-valid.yaml
git commit -m "feat(videos): partnership-pitch template bundle + fixture + loader test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task A5: Ship Part A as a PR

- [ ] **Step 1: Full suite green**

```bash
cd /Users/jjackson/emdash/worktrees/ace-web/emdash/beats-x788j/video-production/connect-videos && npm test && npm run typecheck
cd /Users/jjackson/emdash/worktrees/ace-web/emdash/beats-x788j && pytest apps/videos/tests/ -q
```
Expected: PASS.

- [ ] **Step 2: Push + PR + auto-merge**

```bash
cd /Users/jjackson/emdash/worktrees/ace-web/emdash/beats-x788j
git push -u origin feat/partnership-pitch-template
gh pr create --title "feat(videos): partnership-pitch template + multi-angle narration" \
  --body "$(cat <<'EOF'
Adds multi-angle narration variants, prospect branding, and an is_demo_clip
product-beat flag to the video spec, plus a new partnership-pitch template.
Backward compatible: legacy single by_beat specs still render via
resolveActiveByBeat fallback.

Part A of the partnership-video feature (ACE spec
docs/superpowers/specs/2026-06-06-partnership-video-design.md).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr merge --auto --merge
```

- [ ] **Step 3: Record the PR number** in the run notes; Part D's `partnership-video-build` skill depends on this template existing in the deployed ace-web. Do not block — continue with Parts B–E while it lands.

---

## Part B — ACE reusable narrative library

> All paths in Parts B–E are under `/Users/jjackson/emdash/worktrees/ace/emdash/video-axlow/`. Work on branch `emdash/video-axlow`.

### Task B1: Narrative schema + loader with tests

**Files:**
- Create: `lib/partnership-narrative.ts`
- Test: `test/lib/partnership-narrative.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/lib/partnership-narrative.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseNarrative, NARRATIVE_BEATS } from "../../lib/partnership-narrative";

const valid = `
id: the-scale-gap
title: The Scale Gap
version: 1
thesis: A proven model reaching ten times the people.
emotional_beat: ambition
hero: the program's leadership
primary_capability: rapid program stand-up + pay-for-verified-delivery at scale
beats:
  hook: { intent: "Name the reach gap", words: 10 }
  cycle: { intent: "Show Learn/Deliver/Verify/Pay", words: 20 }
  handoff: { intent: "Hand to the prospect", words: 8 }
  scene: { intent: "Where the work happens", words: 20 }
  problem: { intent: "Frame the headline stat", words: 25 }
  product: { intent: "Walk the micro-demo", words: 30 }
  impact: { intent: "Read impact stats", words: 20 }
`;

describe("parseNarrative", () => {
  it("parses a valid narrative", () => {
    const n = parseNarrative(valid);
    expect(n.id).toBe("the-scale-gap");
    expect(n.version).toBe(1);
    expect(Object.keys(n.beats)).toEqual(expect.arrayContaining([...NARRATIVE_BEATS]));
  });

  it("rejects a narrative missing a required beat", () => {
    const bad = valid.replace(/  product:.*\n/, "");
    expect(() => parseNarrative(bad)).toThrow(/product/);
  });

  it("rejects an unknown beat id", () => {
    const bad = valid + `  bonus: { intent: x, words: 5 }\n`;
    expect(() => parseNarrative(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/partnership-narrative.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/partnership-narrative.ts`**

```typescript
import { parse } from "yaml";
import { z } from "zod";

/** The seven narration beats every partnership narrative must define.
 *  Matches the partnership-pitch video template's narration beats. */
export const NARRATIVE_BEATS = [
  "hook", "cycle", "handoff", "scene", "problem", "product", "impact",
] as const;

const BeatSpecSchema = z.object({
  intent: z.string().min(1),
  words: z.number().int().positive(),
});

export const NarrativeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  version: z.number().int().positive(),
  thesis: z.string().min(1),
  emotional_beat: z.string().min(1),
  hero: z.string().min(1),
  primary_capability: z.string().min(1),
  beats: z
    .object(Object.fromEntries(NARRATIVE_BEATS.map((b) => [b, BeatSpecSchema])))
    .strict(),
});

export type Narrative = z.infer<typeof NarrativeSchema>;

export function parseNarrative(yamlText: string): Narrative {
  return NarrativeSchema.parse(parse(yamlText));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lib/partnership-narrative.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/partnership-narrative.ts test/lib/partnership-narrative.test.ts
git commit -m "feat: partnership narrative schema + loader

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B2: Author the three starter narratives

**Files:**
- Create: `templates/partnership-narratives/day-in-the-life/narrative.yaml`
- Create: `templates/partnership-narratives/the-scale-gap/narrative.yaml`
- Create: `templates/partnership-narratives/trust-travels/narrative.yaml`
- Test: `test/templates/partnership-narratives.test.ts`

- [ ] **Step 1: Write the on-disk-validity test**

Create `test/templates/partnership-narratives.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseNarrative } from "../../lib/partnership-narrative";

const ROOT = join(__dirname, "..", "..", "templates", "partnership-narratives");

describe("partnership-narratives library", () => {
  const dirs = readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it("has exactly three starter narratives", () => {
    expect(dirs.sort()).toEqual(["day-in-the-life", "the-scale-gap", "trust-travels"]);
  });

  for (const dir of dirs) {
    it(`${dir}/narrative.yaml parses and id matches dir`, () => {
      const n = parseNarrative(readFileSync(join(ROOT, dir, "narrative.yaml"), "utf8"));
      expect(n.id).toBe(dir);
    });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/templates/partnership-narratives.test.ts`
Expected: FAIL — directory missing.

- [ ] **Step 3: Author the three `narrative.yaml` files**

Use the schema from B1. Each must define all seven beats with a concrete `intent` and a word budget (use the 60s template's budgets: hook 10 / cycle 20 / handoff 8 / scene 20 / problem 25 / product 30 / impact 20). Content per design §3:

- `day-in-the-life`: thesis "the work made visible and easier through one health worker's day"; emotional_beat `intimacy`; hero "a single frontline worker"; primary_capability "the on-the-ground Learn→Deliver→Verify→Pay loop".
- `the-scale-gap`: thesis "a proven model reaching ten times the people"; emotional_beat `ambition`; hero "the program's leadership"; primary_capability "rapid program stand-up + pay-for-verified-delivery at scale".
- `trust-travels`: thesis "a proven model de-risked into a new geography"; emotional_beat `confidence`; hero "the expansion team / funders"; primary_capability "verification/quality + funder-grade reporting".

Each beat `intent` describes what the beat must accomplish for *that* angle (e.g. day-in-the-life `problem`: "Frame the headline stat through the worker's eyes — what the gap means for the people she serves").

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/templates/partnership-narratives.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/partnership-narratives test/templates/partnership-narratives.test.ts
git commit -m "feat: three starter partnership narrative templates

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Part C — ACE pitch-deck bundle

### Task C1: Add `partnership-pitch` archetype + `prospect` audience to the deck schema

**Files:**
- Modify: `lib/training-deck-spec.ts`
- Test: `test/lib/training-deck-spec.test.ts`

The current top-level schema has `archetype: z.enum(['atomic-visit', 'focus-group', 'multi-stage'])` and `voice.audience: z.enum(['flw', 'llo', 'mixed'])`.

- [ ] **Step 1: Write the failing tests**

Add to `test/lib/training-deck-spec.test.ts`:

```typescript
it("accepts the partnership-pitch archetype and prospect audience", () => {
  const yaml = minimalYaml()
    .replace("archetype: atomic-visit", "archetype: partnership-pitch")
    .replace("audience: flw", "audience: prospect");
  const spec = parseTrainingSpec(yaml);
  expect(spec.archetype).toBe("partnership-pitch");
  expect(spec.voice.audience).toBe("prospect");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/training-deck-spec.test.ts -t "partnership-pitch archetype"`
Expected: FAIL — enum rejects both values.

- [ ] **Step 3: Implement the two enum additions in `lib/training-deck-spec.ts`**

```typescript
  archetype: z.enum(['atomic-visit', 'focus-group', 'multi-stage', 'partnership-pitch']),
```
```typescript
    audience: z.enum(['flw', 'llo', 'mixed', 'prospect']),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lib/training-deck-spec.test.ts`
Expected: PASS (all existing deck tests still pass).

- [ ] **Step 5: Commit**

```bash
git add lib/training-deck-spec.ts test/lib/training-deck-spec.test.ts
git commit -m "feat: partnership-pitch archetype + prospect audience for deck spec

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task C2: Author the pitch-deck template bundle

**Files:**
- Create: `templates/training-deck/connect-pitch-partnership/template.yaml`
- Create: `templates/training-deck/connect-pitch-partnership/spec.template.yaml`
- Create: `templates/training-deck/connect-pitch-partnership/generate.prompt.md`

Reuses the existing 14 stencils (`STENCILS` in `lib/training-deck-spec.ts`) and the existing `ACE_TRAINING_DECK_TEMPLATE_ID` Slides template — **no new Slides bootstrap needed for Phase 1** (new pitch-specific stencils are deferred). The render path is unchanged (`buildSlidesRequestsV2`).

- [ ] **Step 1: `template.yaml`**

```yaml
id: connect-pitch-partnership
name: "Connect Partnership Pitch"
description: >
  ~10-12 slide pitch deck for a prospect organization not yet on Connect.
  Mirrors the partnership video's arc and adds the business case + the ask.
archetype: partnership-pitch
audience: prospect
modules:
  - opening
  - their-world
  - the-thesis
  - how-connect-works
  - proof
  - business-case
  - the-ask
expected_slide_count: "10-12"
expected_duration_minutes: "10-15"
```

- [ ] **Step 2: `spec.template.yaml`**

A `TrainingDeckSpec`-shaped skeleton (`slug`, `name`, `program`, `archetype: partnership-pitch`, `template_id: connect-pitch-partnership`, `source`, `manifest`, `voice.audience: prospect`, `modules[]`). Map the 7 modules to existing layouts: `opening`→`cover`; `their-world`→`content`/`stats`; `the-thesis`→`section`+`content`; `how-connect-works`→`timeline` (Learn/Deliver/Verify/Pay); `proof`→`walkthrough`/`web_screen` (micro-demo screenshot); `business-case`→`stats`/`two_column`; `the-ask`→`closing`. Use `{{TOKENS}}` for content the skill fills.

> Note: `source.pdd_doc_id` is required by `TrainingDeckSpecSchema`. There is no PDD here. Set it to the prospect research doc's Drive fileId so provenance still resolves (document this in the generate prompt). If you prefer not to overload that field, add an optional `source.research_doc_id` in a follow-up — for Phase 1, reuse `pdd_doc_id` to avoid schema churn.

- [ ] **Step 3: `generate.prompt.md`**

Instruct the skill to fill the deck from `prospect.yaml` + `research/` + the picked angle in `angles.yaml` + the micro-demo manifest. Enforce design §8 grounding (every stat cited; `[TBD] ` prefix for unsourced). Mirror the video's narrative arc so the deck and video tell the same story. Model structure on `templates/training-deck/connect-training-atomic/generate.prompt.md`.

- [ ] **Step 4: Validate the skeleton parses after token substitution**

Add a vitest case (in `test/lib/training-deck-spec.test.ts` or a new `test/templates/partnership-deck.test.ts`) that loads `connect-pitch-partnership/spec.template.yaml`, replaces every `{{...}}` token with a placeholder string (and array tokens like `{{...SLIDES}}` with `[]`), and asserts `parseTrainingSpec` succeeds. Run it:

Run: `npx vitest run test/templates/partnership-deck.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/training-deck/connect-pitch-partnership test/templates/partnership-deck.test.ts
git commit -m "feat: connect-pitch-partnership deck template bundle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Part D — ACE skills + orchestration

> SKILL.md / agent / command files are authoring tasks. The verification gate for each is: (a) `npm test` still passes (the `test/skill-atom-references.test.ts` drift detector catches any atom-shaped token that isn't a registered atom), and (b) the YAML frontmatter parses. Each skill follows `skills/README.md`: kebab-case dir == frontmatter `name`; producers get a QA companion (or inline QA) + an eval companion (or inline self-eval); verdicts written per the artifact-path contract. Reference `skills/idea-to-pdd/` for the producer/qa/eval trio shape and `lib/verdict-schema.ts` for the verdict YAML shape.

### Task D1: `partnership-research` (+ qa, + eval)

**Files:**
- Create: `skills/partnership-research/SKILL.md`
- Create: `skills/partnership-research-qa/SKILL.md`
- Create: `skills/partnership-research-eval/SKILL.md`

- [ ] **Step 1: Author `partnership-research/SKILL.md`**

Frontmatter:
```yaml
---
name: partnership-research
description: >
  Research a non-Connect prospect org for a partnership video: deep web
  research (what they do, scale, model, geography, the expansion thesis)
  plus a Connect/Dimagi capability-fit memo. Verified + cited.
---
```
Body procedure:
1. Read `ACE/partnerships/<slug>/prospect.yaml` (+ `--prospect-folder` contents if present).
2. Dispatch deep research: `Skill(deep-research)` with a refined query woven from the prospect + target geography (the orchestrator runs at level 0, so deep-research's internal fan-out is legal). Capture the cited report to `research/deep-research.md`.
3. Build the Connect-fit memo: cross-reference real ACE PDDs / program library / case studies for what Connect unlocks for this org type in the target geo → `research/connect-fit.md`. Capabilities must be validated against real artifacts/atoms (design §8 close-the-loop), not asserted.
4. Write `phases.research.{status,verdict,completed_at,summary_artifact,steps}` to `runs/<run-id>/run_state.yaml` via `update_yaml_file(..., merge: 'two-level')`.

- [ ] **Step 2: Author `partnership-research-qa/SKILL.md`**

Binary structural checks: both research files exist + non-empty; deep-research report contains a citations/sources section; connect-fit memo names ≥1 concrete Connect capability. Write `2-research/partnership-research-qa_verdict.yaml` (pass/fail). Reference `skills/_qa-template.md`.

- [ ] **Step 3: Author `partnership-research-eval/SKILL.md`**

LLM-as-judge against `lib/verdict-schema.ts` shape. Dimensions: `grounding` (claims cited), `relevance` (to the expansion thesis), `capability_fit` (Connect mapping is real), `factual_safety` (no fabricated stats). Writes `2-research/partnership-research-eval_verdict.yaml`. Reference `skills/_eval-template.md`.

- [ ] **Step 4: Verify**

Run: `npm test -- test/skill-atom-references.test.ts`
Expected: PASS (no unregistered atom tokens). Also confirm frontmatter parses (`npm test` overall stays green).

- [ ] **Step 5: Commit**

```bash
git add skills/partnership-research skills/partnership-research-qa skills/partnership-research-eval
git commit -m "feat: partnership-research skill + qa + eval

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task D2: `partnership-angles` (+ eval)

**Files:**
- Create: `skills/partnership-angles/SKILL.md`
- Create: `skills/partnership-angles-eval/SKILL.md`

- [ ] **Step 1: Author `partnership-angles/SKILL.md`**

Frontmatter `name: partnership-angles`, description: "Ground the three reusable narrative templates against the prospect research into three pitch-able angles." Procedure: load the three narratives from `templates/partnership-narratives/` (via `lib/partnership-narrative.ts` shape); for each, fill its beat intents with grounded facts from `research/` → an angle with title, logline, arc, hero, emotional beat, the Connect capability it leans on, and the cited facts. Write `runs/<run-id>/angles.yaml` (3 angles). **Do not invent arcs** — only ground the library narratives; if a narrative can't be grounded, mark it `groundable: false` with the missing fact rather than fabricating (design §3, §8). This is the **propose-phase terminal artifact**. Write-back `phases.angles.*`.

- [ ] **Step 2: Author `partnership-angles-eval/SKILL.md`**

Dimensions: `grounded` (each beat traces to a research fact), `distinct` (the 3 angles are genuinely different), `capability_tied` (each leans on a real Connect capability), `persuasiveness`. Verdict file `2-research/partnership-angles-eval_verdict.yaml` (angles are a research-phase artifact; keep them in `2-research/` or a `2-angles/` phase folder — pick one and register it in `lib/artifact-manifest.ts` in Task E2).

- [ ] **Step 3: Verify + commit**

Run: `npm test -- test/skill-atom-references.test.ts` → PASS.
```bash
git add skills/partnership-angles skills/partnership-angles-eval
git commit -m "feat: partnership-angles skill + eval

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task D3: `partnership-microdemo` (+ eval)

**Files:**
- Create: `skills/partnership-microdemo/SKILL.md`
- Create: `skills/partnership-microdemo-eval/SKILL.md`

- [ ] **Step 1: Author `partnership-microdemo/SKILL.md`**

Frontmatter `name: partnership-microdemo`. Procedure (design §5 step 6, adaptive reuse-or-mock):
1. From the picked angle's `product` beat intent, decide the proof clip(s) needed.
2. **Reuse first:** query the ace-web media library (`GET /library/video`) for a matching existing clip; if found, record its `ref` + reuse provenance.
3. **Else mock:** build a lightweight tailored mock — a Nova app stub (`/nova:autobuild`, level-0 Agent dispatch) filmed via `Skill(canopy:walkthrough)` + record_video, OR a Connect-styled clickable mock filmed via gstack browse. Keep it to ~20-30s.
4. Write clips + a `micro-demo/provenance.yaml` (per clip: `source: reuse|mock`, origin, caption, `is_demo_clip: true`). Write-back `phases.microdemo.*`.

- [ ] **Step 2: Author `partnership-microdemo-eval/SKILL.md`**

Dimensions: `fidelity` (does the clip credibly show the claim), `relevance` (matches the angle), `provenance_honesty` (reuse vs mock recorded). Verdict `<phase>/partnership-microdemo-eval_verdict.yaml`.

- [ ] **Step 3: Verify + commit**

Run: `npm test -- test/skill-atom-references.test.ts` → PASS.
```bash
git add skills/partnership-microdemo skills/partnership-microdemo-eval
git commit -m "feat: partnership-microdemo skill + eval

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task D4: `partnership-video-build` (+ eval)

**Files:**
- Create: `skills/partnership-video-build/SKILL.md`
- Create: `skills/partnership-video-build-eval/SKILL.md`

- [ ] **Step 1: Author `partnership-video-build/SKILL.md`**

Frontmatter `name: partnership-video-build`. Procedure:
1. `GET /api/w/<ws>/videos/templates/partnership-pitch` → fetch skeleton + prompt (from the deployed ace-web; depends on Part A landing).
2. Fill the skeleton following its `generate.prompt.md`: identity from `prospect.yaml`; all three angle variants from `angles.yaml`; `active_angle` = picked; `product.beats` from the micro-demo manifest (`is_demo_clip: true` on real clips); stat cards from `research/`. Enforce design §8 grounding.
3. `POST /api/w/<ws>/videos/programs` with `{slug, spec_yaml}` → run-001.
4. `POST .../runs/run-001/build {mode: render}`; poll `.../render-status` until `busy:false`; capture the editable URL + output URL into `video_spec.yaml` + `package.yaml`.
5. Write-back `phases.video-build.*`.

Document the env: `ACE_WEB_PAT_TOKEN`, `ACE_WEB_BASE`, workspace slug (same as `/ace:video-from-program-page`).

- [ ] **Step 2: Author `partnership-video-build-eval/SKILL.md`**

Dimensions: `spec_validity` (posted spec validated server-side), `grounding` (no uncited stats, no surviving `[TBD]`), `render_success`, `brand_safety` (Dimagi chrome + prospect name/logo per design §9). Verdict file `<phase>/partnership-video-build-eval_verdict.yaml`.

- [ ] **Step 3: Verify + commit**

Run: `npm test -- test/skill-atom-references.test.ts` → PASS.
```bash
git add skills/partnership-video-build skills/partnership-video-build-eval
git commit -m "feat: partnership-video-build skill + eval

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task D5: `partnership-deck-build` (+ eval)

**Files:**
- Create: `skills/partnership-deck-build/SKILL.md`
- Create: `skills/partnership-deck-build-eval/SKILL.md`

- [ ] **Step 1: Author `partnership-deck-build/SKILL.md`**

Frontmatter `name: partnership-deck-build`. Procedure mirrors `training-deck-generate` + `training-deck-render` but for the pitch deck:
1. Build a `connect-pitch-partnership` spec (`TrainingDeckSpec` shape) from `prospect.yaml` + `research/` + picked angle + micro-demo screenshot → `runs/<run-id>/deck_spec.yaml`. Reuse `parseTrainingSpec` + `resolveModuleRefs`.
2. Render: `slides_copy_template(ACE_PARTNERSHIP_DECK_TEMPLATE_ID || ACE_TRAINING_DECK_TEMPLATE_ID, ...)` → `slides_get` for stencil ids → `buildSlidesRequestsV2(spec, {stencils, manifest})` → `slides_batch_update`. Capture the Slides URL into `package.yaml`.
3. Write-back `phases.deck-build.*`.

Reference `skills/training-deck-render/SKILL.md` for the exact atom call sequence.

- [ ] **Step 2: Author `partnership-deck-build-eval/SKILL.md`**

Dimensions: `arc_match` (deck mirrors the video's angle), `grounding`, `completeness` (all 7 modules present), `visual_polish`. Verdict `<phase>/partnership-deck-build-eval_verdict.yaml`.

- [ ] **Step 3: Verify + commit**

Run: `npm test -- test/skill-atom-references.test.ts` → PASS (confirms `slides_*` atom tokens resolve).
```bash
git add skills/partnership-deck-build skills/partnership-deck-build-eval
git commit -m "feat: partnership-deck-build skill + eval

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task D6: `partnership-publish`

**Files:**
- Create: `skills/partnership-publish/SKILL.md`

- [ ] **Step 1: Author `partnership-publish/SKILL.md`**

Frontmatter `name: partnership-publish`. Procedure (design §5 step 9): assemble the canopy-web package (hero video URL + deck URL + the picked narrative + a research appendix), run the external-release gate (HITL — never auto-send; design §9), publish via the canopy-web package path (reuse `canopy:walkthrough-share` / ddd-upload-style packager — confirm which during implementation per spec §11), and write the final navigable URL into `package.yaml`. Write-back `phases.publish.*`. No `-eval` (publishing is a mechanical handoff; quality was judged upstream).

- [ ] **Step 2: Verify + commit**

Run: `npm test -- test/skill-atom-references.test.ts` → PASS.
```bash
git add skills/partnership-publish
git commit -m "feat: partnership-publish skill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task D7: The level-0 procedure doc

**Files:**
- Create: `agents/partnership-video.md`

- [ ] **Step 1: Author the procedure doc**

Frontmatter (mirror `agents/commcare-setup.md` — retained for tooling, not dispatched as subagent):
```yaml
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
  - { name: partnership-research,   has_judge: true,  eval_skill: partnership-research-eval }
  - { name: partnership-angles,     has_judge: true,  eval_skill: partnership-angles-eval }
  - { name: partnership-microdemo,  has_judge: true,  eval_skill: partnership-microdemo-eval }
  - { name: partnership-video-build,has_judge: true,  eval_skill: partnership-video-build-eval }
  - { name: partnership-deck-build, has_judge: true,  eval_skill: partnership-deck-build-eval }
  - { name: partnership-publish,    has_judge: false }
---
```
Body must include, verbatim in spirit, the inline-at-level-0 disclaimer (copy the wording from `agents/commcare-setup.md`): this file is read and executed inline by the top-level session because it dispatches `Agent` (deep-research, canopy walkthrough, Nova); running it as a subagent would push those dispatches to level 2 and fail.

Then the two-phase procedure:
- **Propose phase** (default invocation): Profile → `partnership-research` (+qa+eval) → `partnership-angles` (+eval) → present the 3 angles to the operator and STOP. (Pause point.)
- **Produce phase** (`--produce <angle-id>`): record `selected_angle` → `partnership-microdemo` → `partnership-video-build` → `partnership-deck-build` → `partnership-publish` → final write-back + `package.yaml` summary.
Include the run-state write-back contract block (`phases.<phase>.*`, `merge: 'two-level'`) and the `ACE/partnerships/<slug>/runs/<run-id>/` layout.

- [ ] **Step 2: Verify + commit**

Run: `npm test` (confirms frontmatter parses + skill references resolve).
```bash
git add agents/partnership-video.md
git commit -m "feat: partnership-video level-0 procedure doc

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task D8: The slash command

**Files:**
- Create: `commands/partnership-video.md`

- [ ] **Step 1: Author the command**

Model on `commands/video-from-program-page.md` and `commands/run.md`. Frontmatter:
```yaml
---
description: Research a prospect org and produce a partnership video + pitch deck (two-phase: propose 3 angles, then produce on pick)
argument-hint: "\"<prospect brief>\" | --produce <angle-id> [--prospect-folder=<id>] [--workspace=<slug>] [--angles=N] [--generic] [--no-render]"
allowed-tools: [Read, Write, Edit, Bash, WebFetch, Agent, AskUserQuestion, Skill, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__update_yaml_file, mcp__plugin_ace_ace-gdrive__resolve_opp_path]
---
```
Body: the critical "execute inline at level 0" instruction (copy the wording from `commands/run.md`): "Read `agents/partnership-video.md` and follow it as a procedure document from this (top-level) Claude Code session. Do **not** dispatch `Agent(partnership-video)` — it is a procedure doc, not a subagent." Then document the two-phase usage, the flags, and the `--generic` unbranded mode.

- [ ] **Step 2: Verify + commit**

Run: `npm test`
```bash
git add commands/partnership-video.md
git commit -m "feat: /ace:partnership-video command

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Part E — wiring, ship, end-to-end

### Task E1: Env var for the pitch-deck template

**Files:**
- Modify: `.env.tpl`

- [ ] **Step 1: Add the optional var** (after the `ACE_TRAINING_DECK_TEMPLATE_ID` block)

```
# Partnership pitch-deck template (Google Slides). Optional — falls back
# to ACE_TRAINING_DECK_TEMPLATE_ID when unset (Phase 1 reuses the same
# 14 stencils). Set to a dedicated deck id once pitch-specific stencils ship.
ACE_PARTNERSHIP_DECK_TEMPLATE_ID=op://AI-Agents/ACE - Drive Templates/partnership_deck_template_id
```
> If the 1Password field doesn't exist yet, leave the line but note that `partnership-deck-build` must fall back to `ACE_TRAINING_DECK_TEMPLATE_ID` (the skill already does, per D5 step 1).

- [ ] **Step 2: Commit**

```bash
git add .env.tpl
git commit -m "feat: ACE_PARTNERSHIP_DECK_TEMPLATE_ID env (falls back to training deck)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task E2: Register artifacts + partnerships root

**Files:**
- Modify: `lib/artifact-manifest.ts`
- Test: `test/lib/artifact-manifest.test.ts` (existing — confirm it still passes / extend if it enumerates phases)

- [ ] **Step 1: Read the manifest to learn its shape**

Run: `grep -n "phase\|root\|partnerships\|ACE/" lib/artifact-manifest.ts | head -40`
Then register: the `partnerships/<slug>/` root, the per-run phase folders used by the skills (`2-research/` or `2-angles/` — match what you chose in D2), and the artifacts: `angles.yaml`, `video_spec.yaml`, `deck_spec.yaml`, `package.yaml`, `micro-demo/provenance.yaml`, and each `*-eval_verdict.yaml`.

- [ ] **Step 2: Run the manifest test**

Run: `npm test -- test/lib/artifact-manifest.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/artifact-manifest.ts
git commit -m "feat: register partnership-video artifacts in artifact-manifest

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task E3: Document the command in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (the `commands/` bullet under § Layout)

- [ ] **Step 1: Add `partnership-video` to the "Specialized flows" command list** in the `commands/` bullet, one phrase: `partnership-video` (research a prospect → propose 3 angles → produce video + deck).

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: list /ace:partnership-video in CLAUDE.md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task E4: Version bump + PR (ACE repo)

- [ ] **Step 1: Full ACE suite green**

Run: `cd /Users/jjackson/emdash/worktrees/ace/emdash/video-axlow && npm test`
Expected: PASS.

- [ ] **Step 2: Bump + push + PR**

```bash
bash scripts/version-bump.sh
git add VERSION package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump version for partnership-video

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push -u origin emdash/video-axlow
gh pr create --title "feat: /ace:partnership-video — prospect research → video + deck" \
  --body "$(cat <<'EOF'
Phase 1 of the partnership-video feature. Adds the reusable narrative
library, the connect-pitch-partnership deck bundle, six skills, the
level-0 procedure doc, and the /ace:partnership-video command.

Pairs with ace-web PR (Part A: partnership-pitch template + multi-angle
narration). Spec: docs/superpowers/specs/2026-06-06-partnership-video-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr merge --auto --merge
```
> If a version collision occurs (parallel worktrees), use `bash scripts/version-bump.sh --rebase-first` then `git push --force-with-lease` (per CLAUDE.md).

- [ ] **Step 3: After merge, update the running session**

Run: `gh pr view <pr> --json state,mergedAt` until merged, then `/ace:update` + `/reload-plugins`. (Per CLAUDE.md: MCP code didn't change, so no full restart needed — but the new command/skills/agent require the plugin update to be live.)

### Task E5: End-to-end dry run on Noora Health

**Files:** none (live exercise) — produces `ACE/partnerships/noora-health/`

- [ ] **Step 1: Confirm both PRs landed** (ace-web Part A + ACE Phase 1). The video-build step calls the deployed ace-web's `partnership-pitch` template.

- [ ] **Step 2: Propose phase**

Run: `/ace:partnership-video "in discussions with Noora Health about expanding to Nigeria"`
Expected: research runs, three grounded angles returned, run stops at the pick gate. Verify `angles.yaml` exists with 3 angles and `research/` has cited reports.

- [ ] **Step 3: Produce phase**

Run: `/ace:partnership-video --produce the-scale-gap noora-health` (or the chosen angle id)
Expected: micro-demo sourced, video rendered on ace-web, deck rendered to Slides, package published. `package.yaml` holds three URLs.

- [ ] **Step 4: Verify the guardrails held**

Manually scan the video narration + deck for: (a) no surviving `[TBD]`, (b) every stat traceable to `research/` citations, (c) Dimagi chrome + Noora name/logo (not Noora-impersonating chrome), (d) the package is HITL-gated, not auto-sent.

- [ ] **Step 5: Capture findings**

File any confirmed defects as `gh issue create` against `jjackson/ace` mid-run (per CLAUDE.md). Then repeat Steps 2-4 for **Lafiya → beyond Nigeria** as the second calibration case. Record both runs' learnings — they feed the Phase-1-step-2 narrative retro (separate plan).

---

## Self-Review

**1. Spec coverage** — every design section maps to tasks:
- §2 interaction (two-phase, flags, `--generic`) → D7 (procedure), D8 (command).
- §3 reusable narrative library → B1 (schema), B2 (3 narratives), used by D2.
- §4 Drive state model → D1–D7 write-backs + E2 (manifest registration).
- §5 pipeline (10 steps) → D1 (profile+research), D2 (ideate), D3 (microdemo), D4 (video), D5 (deck), D6 (publish), write-back throughout.
- §6 ace-web platform Phase 1 (variants, prospect, is_demo_clip, template) → A1–A4. Phase 2 explicitly deferred.
- §7 skills/files inventory → D1–D8.
- §8 guardrails → enforced in each skill's procedure + the `-eval` rubrics (D1–D5) + E5 step 4 verification.
- §9 default sub-decisions (brand safety, deck size, share surface) → D5/D6/D8 bodies + E5 verification.
- §10 phasing → this plan is Phase 1; retro + Phase 2 + `--generic` validation noted out-of-scope.

**2. Placeholder scan** — code-bearing tasks (A1–A3, B1, C1) contain full code + tests. Authoring tasks (templates, skills, procedure, command) specify exact frontmatter + section-by-section content requirements + a concrete verification command, which is the appropriate "complete content" for Markdown/YAML authoring (these aren't unit-testable; the drift detector + frontmatter parse are their gates). No "TBD"/"handle edge cases"/"similar to" placeholders.

**3. Type consistency** — `resolveActiveByBeat` named identically in A1 (definition), A3 (render use), and the tests. `NARRATIVE_BEATS` (7 beats) is consistent between `lib/partnership-narrative.ts` (B1) and the partnership-pitch template's narration beats (A4) and the deck arc (C2). Archetype string `partnership-pitch` consistent across A4 (video template id is also `partnership-pitch`), C1 (deck enum), C2 (`connect-pitch-partnership` bundle declares `archetype: partnership-pitch`). Skill names in D7's frontmatter `skills:` list match the D1–D6 directory names exactly. `active_angle` / `angle_id` consistent between A1 schema, A4 template, B-library ids, and D2/D4.

**Known coupling to flag at execution time:** Part D's `partnership-video-build` depends on Part A's template being live in the *deployed* ace-web (not just merged) — E5 step 1 gates on this. If ace-web isn't redeployed automatically on merge, deploy it (or point `ACE_WEB_BASE` at a build that has the template) before E5.
