# Training Deck Spec System — Design Spec

**Date:** 2026-05-23
**Author:** Jonathan Jackson + Claude
**Status:** Draft
**Archetype:** System redesign

## Problem

ACE Phase 6 generates training decks that the team isn't satisfied with. The current system produces 9-15 slide "opportunity briefings" using a 2-stencil Google Slides template (title + content). The human-made Solina MBW reference deck is a 71-slide, 164-image, full-day onboarding event with facilitation scaffolding, granular screenshot walkthroughs, and interactive exercises.

**Gaps in the current system:**

| Dimension | Current ACE Output | Human Reference (Solina MBW) |
|---|---|---|
| Scale | 9-15 slides | 71 slides |
| Images | 0-6 screenshots | 164 screenshots |
| Layout variety | 1 type (title + body text) | 8+ types (walkthrough, flow, stats, comparison) |
| Platform onboarding | 1-2 bullet slides | 15 step-by-step slides with tap-by-tap screenshots |
| Facilitation | None | Ice-breakers, timed agenda, role play, practice, evaluation |
| Spec format | Markdown (fragile parsing, no typed schema) | N/A |
| Human editing | Edit raw markdown or Google Doc | N/A |

**Additional problems:**
- No rendered deck has been successfully produced yet (blocked by missing screenshots or env vars in every run).
- The markdown outline format is fragile — the parser must infer structure from heading levels and indentation.
- No separation between common (platform setup) and opp-specific content.
- No template system — the generation prompt is baked into the skill, not parameterized.

## Solution

Model the training deck system after the ace-web video product architecture: a YAML-based spec format with typed schema, template bundles with generation prompts, a multi-stencil Google Slides renderer, and a common module pool.

**Phase 1 (this spec):** Spec format + renderer + templates. No web editor.
**Phase 2 (future):** SlideEditor UI in ace-web (parallel to BeatEditor for videos).

### Architecture Parallel

| Video Product | Training Deck Product |
|---|---|
| `spec.yaml` (Zod-validated) | `spec.yaml` (Zod-validated) |
| Template bundle: `template.yaml` + `spec.template.yaml` + `generate.prompt.md` | Same structure |
| Beat = unit of content | Slide = unit of content |
| BeatEditor UI (edit narration, swap clips, adjust stats) | Future: SlideEditor UI |
| Remotion render → MP4 | Google Slides `batch_update` → Slides deck |
| Manifest: `@alias` → `gdrive:<fileId>` or `library:video/...` | Manifest: `@alias` → `drive:<fileId>` |
| Edit ops: `set-narration`, `set-stat`, `set-clip-asset` | Future: `set-slide-text`, `set-slide-image`, `set-layout` |
| Drive is source of truth | Drive is source of truth |

## Spec Format

### Top-level Schema

```yaml
slug: malaria-rdt                        # kebab-case opp identifier
name: "Malaria RDT Performance Sampling" # display name
program: "Malaria RDT Collection"        # Connect program name
archetype: atomic-visit                  # atomic-visit | focus-group | multi-stage
template_id: connect-training-atomic     # which template generated this
generated_at: "2026-05-23T14:30:00Z"
source:
  pdd_doc_id: "abc123"                   # provenance: PDD that produced this
  run_id: "20260523-1257"                # ACE run that generated it

manifest:
  common:                                # from ACE/_common/connect-screenshots/
    play-store-search: "drive:1ABC..."
    commcare-install: "drive:1DEF..."
    personal-id-step1: "drive:1GHI..."
    personal-id-step2: "drive:1JKL..."
    personal-id-step3: "drive:1MNO..."
    personal-id-done: "drive:1PQR..."
    connect-home: "drive:1STU..."
    claim-opp: "drive:1VWX..."
    sync-button: "drive:1YZA..."
  opp:                                   # from per-opp app-screenshot-capture
    learn-module-1: "drive:1BCD..."
    learn-module-2: "drive:1EFG..."
    deliver-form-main: "drive:1HIJ..."
    deliver-form-photo: "drive:1KLM..."

voice:
  audience: flw                          # flw | llo | mixed
  estimated_duration_minutes: 180        # total session length
  language: en

modules:
  - <ModuleSpec>...                      # ordered list of modules
```

### ModuleSpec

```yaml
id: platform-setup                       # kebab-case module identifier
title: "Connect Platform Setup"          # section divider title
common: true                             # if true, sourced from common pool
slides:
  - <SlideSpec>...                       # ordered list of slides
```

### SlideSpec

Each slide has a `layout` field that maps to a stencil in the Google Slides template. Layout-specific fields vary.

```yaml
# Common fields (all layouts)
id: install-commcare                     # unique within the deck
layout: walkthrough                      # stencil type (see catalog below)
title: "Download CommCare"

# Layout-specific fields vary — see Stencil Catalog
```

### Stencil Catalog (14 layouts)

#### 1. `cover` — Opening slide
```yaml
layout: cover
title: "Malaria RDT Performance Sampling"
subtitle: "FLW Training — June 2026"
date: "June 2026"
```
Visual: Large title left, background image right, Dimagi logo top-right, accent bar right edge. Deep indigo + amber brand colors.

#### 2. `section` — Section divider
```yaml
layout: section
title: "Your Opportunity"
```
Visual: Section title in Work Sans Medium 38pt, thin accent bar, optional background image right half. Marks module boundaries.

#### 3. `agenda` — Timed session plan
```yaml
layout: agenda
title: "Today's Agenda"
items:
  - { label: "Connect Platform Setup", duration: "60 min" }
  - { label: "Your Opportunity", duration: "90 min" }
  - { label: "Lunch Break", duration: "30 min" }
  - { label: "Practice & Role Play", duration: "60 min" }
  - { label: "Evaluation & Next Steps", duration: "30 min" }
```
Visual: Left-aligned timed list with duration badges. Total time computed and shown.

#### 4. `content` — Standard text + bullets
```yaml
layout: content
title: "What You're Doing"
body: |
  You are collecting malaria rapid diagnostic test
  samples from pharmacies and health facilities.
  
  - Visit 3-5 POCs per day
  - Collect samples and photos
  - Log results in the Deliver app
```
Visual: Title top, body text below. The existing stencil, improved with better typography.

#### 5. `walkthrough` — Single screenshot + steps
```yaml
layout: walkthrough
title: "Finding Your Opportunity"
image: "@claim-opp"                      # manifest alias
body: |
  1. Open Connect from the home screen
  2. Find your opportunity in the list
  3. Tap "Claim" to get started
```
Visual: Large mobile screenshot right (60% width), numbered steps left (40% width). The workhorse for explaining individual screens.

#### 6. `mobile_flow` — 2-4 mobile phone frames
```yaml
layout: mobile_flow
title: "Download CommCare"
steps:
  - { image: "@play-store-search", caption: "Search 'CommCare'" }
  - { image: "@commcare-install", caption: "Tap Install" }
  - { image: "@personal-id-start", caption: "Open & Sign Up" }
  - { image: "@connect-home", caption: "You're In!" }
```
Visual: 2-4 phone-shaped frames in a row (evenly spaced), step number + caption below each. Shows a tap-by-tap flow. Phone frames have subtle device bezels. The stencil has 4 frame slots; unused slots are hidden via `deleteObject` on the extra elements. Prefer 4 steps for full flows, 2-3 for shorter sequences.

#### 7. `web_screen` — Full-width web screenshot
```yaml
layout: web_screen
title: "Your Connect Dashboard"
image: "@connect-dashboard"
caption: "This is where you'll track your progress and payments."
```
Visual: Full-width browser-framed screenshot with title above and caption below. For Connect web dashboard, OCS chatbot, or any web-based screen.

#### 8. `mobile_zoom` — Large centered mobile screenshot
```yaml
layout: mobile_zoom
title: "The Delivery Form"
image: "@deliver-form-main"
callouts:
  - "Notice the GPS icon — stay within 100m of the POC"
  - "Tap the camera icon for each required photo"
```
Visual: Single large centered phone screenshot with callout annotations. For when detail matters.

#### 9. `two_column` — Side-by-side comparison
```yaml
layout: two_column
title: "Photo Protocol"
left:
  heading: "Do This"
  body: "Clear, well-lit, focused on the label text"
  image: "@good-photo"                   # optional
right:
  heading: "Not This"
  body: "Blurry, dark, cropped, or at an angle"
  image: "@bad-photo"                    # optional
```
Visual: Two equal columns with optional images. Accent color differentiates left (green/teal) from right (red/amber) for do/don't comparisons.

#### 10. `stats` — Big numbers
```yaml
layout: stats
title: "Your Targets"
stats:
  - { big: "3-5", label: "POC visits per day" }
  - { big: "$23", label: "per completed sample" }
  - { big: "81%", label: "Learn pass threshold" }
```
Visual: 1-3 large stat numbers (Work Sans 72pt) with labels below. Deep indigo numbers on white background. Stats from `run_state.yaml` quoted verbatim.

#### 11. `timeline` — Process flow
```yaml
layout: timeline
title: "What Happens Next"
steps:
  - { label: "Today", detail: "Training complete" }
  - { label: "This week", detail: "Practice period — at least 3 submissions" }
  - { label: "Next Monday", detail: "Go live — real data collection begins" }
  - { label: "Week 6", detail: "Final payment and closeout" }
```
Visual: Horizontal timeline with connected nodes (2-5 steps; stencil has 5 node slots, unused ones hidden). Step labels above, detail text below. Accent-colored nodes.

#### 12. `checklist` — Readiness gate
```yaml
layout: checklist
title: "Readiness Checklist"
items:
  - "Completed all Learn modules (81%+ score)"
  - "Can explain the 3-photo protocol"
  - "Know how to use the OCS chatbot for help"
  - "Have your LLO manager's contact saved"
  - "Phone is charged and has data/WiFi"
```
Visual: Checkbox-style list with tickable items. Clean, scannable. Used for pre-flight checklists and evaluation.

#### 13. `exercise` — Practice activity
```yaml
layout: exercise
title: "Complete Learn Module 1"
duration: "20 min"
body: |
  Open your phone and complete Learn Module 1 now.
  Raise your hand when you finish or if you need help.
```
Visual: Activity card with amber/gold accent background, duration badge top-right, activity instructions center. Distinct visual treatment so trainers can spot facilitation slides at a glance.

#### 14. `closing` — Thank you / next steps
```yaml
layout: closing
title: "Thank You"
body: |
  You're ready to make a difference.
  
  Questions? Reach out anytime:
  - OCS Chatbot: Available 24/7
  - LLO Manager: [name] at [phone]
  - Program Email: ace@dimagi-ai.com
```
Visual: Clean closing with Dimagi logo, social media icons, contact block. Matches the corporate template's thank-you slide.

## Template Bundle System

Templates live in the ACE plugin at `templates/training-deck/`:

```
templates/training-deck/
  connect-training-atomic/           # for atomic-visit archetype
    template.yaml                    # metadata
    spec.template.yaml               # skeleton with {{placeholders}}
    generate.prompt.md               # LLM generation instructions
  connect-training-fgd/              # for focus-group archetype
    template.yaml
    spec.template.yaml
    generate.prompt.md
  _common/                           # reusable module fragments
    platform-setup.yaml              # 10-12 Connect setup slides
    facilitation.yaml                # ice-breaker pool, agenda patterns
    resources.yaml                   # help/closing slides
```

### template.yaml

```yaml
id: connect-training-atomic
name: "Connect Training — Atomic Visit"
description: "Full training deck for atomic-visit opportunities (pharmacy surveys, household visits, etc.)"
archetype: atomic-visit
audience: flw
modules:
  - welcome            # from _common/facilitation.yaml + customized
  - platform-setup     # from _common/platform-setup.yaml verbatim
  - your-opportunity   # fully generated from PDD
  - practice           # from _common/facilitation.yaml + customized
  - evaluation         # generated from PDD acceptance criteria
  - resources          # from _common/resources.yaml + customized
expected_slide_count: 30-45
expected_duration_minutes: 150-240
```

### generate.prompt.md

The generation prompt instructs the LLM how to fill the skeleton. Key sections:

1. **Input context** — what PDD fields, app summaries, and screenshot manifests to read
2. **Module instructions** — per-module guidance on content selection
3. **Layout selection rules** — when to use each stencil type
4. **Word budgets** — per-slide text limits to prevent wall-of-text slides
5. **Screenshot integration** — how to resolve `@alias` references from the manifest
6. **Archetype-specific rules** — how atomic-visit differs from focus-group
7. **Facilitation element selection** — which ice-breaker to pick, how to structure practice exercises
8. **Tone and audience** — high-school reading level, concrete button names, no jargon

### Common Module Pool (`_common/`)

#### platform-setup.yaml

Pre-built module with ~10-12 slides covering:

| Slide | Layout | Content |
|---|---|---|
| What is CommCare Connect? | content | Platform overview, Learn/Deliver/Verify/Pay |
| Download CommCare | mobile_flow | Play Store → Install → Open → Welcome (4 screenshots) |
| Create Your PersonalID | mobile_flow | Start → Name → Phone → Verify (4 screenshots) |
| PersonalID Details | mobile_flow | Photo → ID → Location → Done (4 screenshots) |
| The Connect Home Screen | walkthrough | Screenshot + navigation guide |
| Finding & Claiming Your Opportunity | walkthrough | Screenshot + step-by-step |
| Installing the Learn App | walkthrough | Screenshot + instructions |
| How Syncing Works | content | When to sync, connectivity tips |
| Switching Between Opportunities | walkthrough | For multi-opp FLWs |

Screenshots sourced from `ACE/_common/connect-screenshots/<version>/manifest.yaml`.

This module ships verbatim with every deck. The generation prompt does NOT regenerate it — it includes it by reference. Updates to the common module propagate to all future decks automatically.

#### facilitation.yaml

Pool of facilitation elements:

```yaml
icebreakers:
  - id: two-truths
    title: "Two Truths and a Lie"
    duration: "10 min"
    body: "Each person shares three statements about themselves..."
  - id: one-word
    title: "One-Word Check-In"
    duration: "5 min"
    body: "Go around the room. Each person shares one word..."
  - id: common-ground
    title: "Common Ground"
    duration: "10 min"
    body: "Find three things everyone in the group has in common..."
  - id: human-bingo
    title: "Human Bingo"
    duration: "15 min"
    body: "Each person gets a bingo card with prompts..."

practice_patterns:
  - id: guided-learn
    title: "Complete Learn Module {{N}}"
    layout: exercise
    duration: "20 min"
    body: "Open your phone and complete Learn Module {{N}} now..."
  - id: form-practice
    title: "Fill Out a Sample Form"
    layout: exercise
    duration: "15 min"
    body: "Working with a partner, fill out the {{FORM_NAME}}..."
  - id: role-play
    title: "Simulated {{VISIT_TYPE}}"
    layout: exercise
    duration: "20 min"
    body: "Pair up. One person plays the {{ROLE}}..."
```

The generation prompt selects appropriate elements based on the opportunity context.

## Renderer

The renderer is a skill (`training-deck-render`) that reads `spec.yaml` and produces a Google Slides deck.

### Render Pipeline

1. **Load spec** — Read `spec.yaml` from Drive, validate against Zod schema
2. **Resolve manifest** — Scan all slides for `@alias` references (prefixed with `@` in slide specs, keyed without `@` in the manifest). Merge `manifest.common` and `manifest.opp` (opp wins on collision). Map each alias to its concrete `drive:<fileId>` value. Verify each fileId is shared `anyone-with-link` (required for Slides image import). Log warnings for missing aliases; halt if any image in a `mobile_flow` or `walkthrough` slide is unresolvable.
3. **Copy template** — `slides_copy_template` with `ACE_TRAINING_DECK_TEMPLATE_ID`
4. **Discover stencils** — `slides_get` to find all stencil objectIds (`ace_stencil_cover`, `ace_stencil_content`, etc.)
5. **Build main batch** — For each module → for each slide:
   - `duplicateObject` of the matching stencil (keyed by `slide.layout`)
   - `replaceAllText` for all placeholder tokens specific to that layout
   - `createImage` for image references (resolved from manifest)
   - Layout-specific element creation (stat cards, timeline nodes, checklist items)
6. **Delete stencils** — `deleteObject` on all 14 stencil slides (they're scaffolding, not content)
7. *(Speaker notes pass removed — no speaker notes in this version)*
8. **Section dividers** — Insert `section` slides between modules
9. **Write handoff** — Write deck URL + slide count to `run_state.yaml`

### Stencil-to-Slides Mapping

Each stencil layout maps to specific Slides API operations:

| Layout | Stencil Elements | API Operations |
|---|---|---|
| `cover` | Title textbox, subtitle textbox, date textbox, logo image, accent bar | `replaceAllText` ×3, logo already in stencil |
| `section` | Title textbox, accent bar | `replaceAllText` ×1 |
| `agenda` | Title textbox, body textbox | `replaceAllText` ×2, body formatted as bullet list with duration right-aligned |
| `content` | Title textbox, body textbox | `replaceAllText` ×2 |
| `walkthrough` | Title textbox, body textbox, image placeholder | `replaceAllText` ×2, `createImage` ×1 (positioned right) |
| `mobile_flow` | Title textbox, 4 image placeholders, 4 caption textboxes | `replaceAllText` ×5, `createImage` ×4 (positioned in device frames) |
| `web_screen` | Title textbox, image placeholder, caption textbox | `replaceAllText` ×2, `createImage` ×1 (full width in browser frame) |
| `mobile_zoom` | Title textbox, image placeholder, callout textbox | `replaceAllText` ×2, `createImage` ×1 (centered large) |
| `two_column` | Title textbox, left heading/body, right heading/body, 2 image placeholders | `replaceAllText` ×5, `createImage` ×0-2 |
| `stats` | Title textbox, 3 stat number textboxes, 3 label textboxes | `replaceAllText` ×7, unused stats hidden |
| `timeline` | Title textbox, step nodes (shapes + text) | `replaceAllText` + shape positioning per step count |
| `checklist` | Title textbox, body textbox | `replaceAllText` ×2, body formatted with checkbox characters |
| `exercise` | Title textbox, body textbox, duration badge | `replaceAllText` ×3, accent background color |
| `closing` | Title textbox, body textbox, logo, social icons | `replaceAllText` ×2, logo/icons already in stencil |

### lib/training-deck-spec.ts Changes

Replace the markdown parser with:

```typescript
// Zod schema for spec.yaml
export const TrainingDeckSpecSchema = z.object({
  slug: z.string(),
  name: z.string(),
  program: z.string(),
  archetype: z.enum(['atomic-visit', 'focus-group', 'multi-stage']),
  template_id: z.string(),
  generated_at: z.string().datetime(),
  source: z.object({
    pdd_doc_id: z.string(),
    run_id: z.string(),
  }),
  manifest: z.object({
    common: z.record(z.string()).optional(),
    opp: z.record(z.string()).optional(),
  }),
  voice: z.object({
    audience: z.enum(['flw', 'llo', 'mixed']),
    estimated_duration_minutes: z.number(),
    language: z.string(),
  }),
  modules: z.array(ModuleSpecSchema),
});

// Layout-specific slide schemas via discriminated union
export const SlideSpecSchema = z.discriminatedUnion('layout', [
  CoverSlideSchema,
  SectionSlideSchema,
  AgendaSlideSchema,
  ContentSlideSchema,
  WalkthroughSlideSchema,
  MobileFlowSlideSchema,
  WebScreenSlideSchema,
  MobileZoomSlideSchema,
  TwoColumnSlideSchema,
  StatsSlideSchema,
  TimelineSlideSchema,
  ChecklistSlideSchema,
  ExerciseSlideSchema,
  ClosingSlideSchema,
]);
```

Stencil constants expanded from 2 to 14:

```typescript
export const STENCILS = {
  cover:       'ace_stencil_cover',
  section:     'ace_stencil_section',
  agenda:      'ace_stencil_agenda',
  content:     'ace_stencil_content',
  walkthrough: 'ace_stencil_walkthrough',
  mobile_flow: 'ace_stencil_mobile_flow',
  web_screen:  'ace_stencil_web_screen',
  mobile_zoom: 'ace_stencil_mobile_zoom',
  two_column:  'ace_stencil_two_column',
  stats:       'ace_stencil_stats',
  timeline:    'ace_stencil_timeline',
  checklist:   'ace_stencil_checklist',
  exercise:    'ace_stencil_exercise',
  closing:     'ace_stencil_closing',
} as const;
```

## What Changes in ACE

### Skills

| Current Skill | Action | New Skill |
|---|---|---|
| `training-deck-outline` | **Replace** | `training-deck-generate` — generates `spec.yaml` from PDD + screenshots + template bundle |
| `training-deck-build` | **Replace** | `training-deck-render` — renders `spec.yaml` to Google Slides via multi-stencil `batch_update` |

Both old skills are deleted. The new skills use the same phase slot in `artifact-manifest.ts`.

### Template (Google Slides)

| Current | New |
|---|---|
| 2 stencil slides (`ace_stencil_title`, `ace_stencil_content`) | 14 stencil slides (see catalog) |
| Bootstrapped by `scripts/bootstrap-training-deck-template.ts` | Same script, expanded to create all 14 stencils |
| Branding: minimal (just placeholder text boxes) | Branding: full Dimagi brand (Work Sans, indigo + amber, device frames, accent shapes) |

The bootstrap script creates each stencil with:
- Well-known objectId (e.g., `ace_stencil_mobile_flow`)
- Placeholder tokens (e.g., `{{STEP_1_CAPTION}}`)
- Layout-appropriate element positioning
- Dimagi brand styling (colors, fonts, shapes)

### Parser (lib/training-deck-spec.ts)

| Current | New |
|---|---|
| `parseDeckOutline(markdown)` → `DeckSpec` | `parseTrainingSpec(yaml)` → `TrainingDeckSpec` (Zod-validated) |
| `buildSlidesRequests(spec, stencils)` → `{main, notes}` | `buildSlidesRequests(spec, stencils)` → `requests[]` (single pass, no speaker notes; expanded for 14 layouts) |
| 2 stencil constants | 14 stencil constants |

### Artifact Manifest

Phase 6 artifacts change:
- `training-deck-outline.md` → `training-deck-spec.yaml`
- `training-deck-build_verdict.yaml` → `training-deck-render_verdict.yaml`

### Common Screenshots

The `ACE/_common/connect-screenshots/` pool must include the platform setup screenshots referenced by `_common/platform-setup.yaml`. These are captured once per Connect app version (not per-opp) and shared across all decks.

Required common screenshots (minimum):
- Play Store search result for CommCare
- CommCare app install screen
- CommCare welcome/first-open screen
- PersonalID signup flow (4-6 screens)
- Connect home screen (empty state)
- Opportunity claim screen
- Learn app launch
- Sync button / sync indicator
- Offline indicator

## Archetype Variations

### atomic-visit (default)

Full 6-module deck. Module 3 ("Your Opportunity") focuses on the visit workflow: arrive → interview → collect data → photos → submit. Practice exercises simulate a visit.

### focus-group

Module 3 restructured around FGD facilitation:
- FGD framing and purpose (instead of visit workflow)
- Sentinel readiness form (the only CommCare form FLWs fill)
- Running the session (consent, questions, probes)
- 24-hour attestation submission
- 72-hour gdoc writing via OCS chatbot guidance

Module 4 practice restructured:
- Consent script read-aloud practice
- Mock FGD with role-play participants
- Gdoc writing exercise with OCS chatbot

### multi-stage

Per-stage modules within Module 3. Each stage gets its own slide set. If any stage is focus-group, that stage uses the FGD structure.

## Future: ace-web SlideEditor

Not in scope for Phase 1 but the spec format is designed for it. The editor would follow the BeatEditor pattern:

- **SlideList** renders one **SlideCard** per slide (collapsible, shows thumbnail)
- Click a widget → opens **EditDrawer** with the appropriate panel:
  - `TextPanel` — edit title, body
  - `ImagePanel` — swap screenshot from manifest or library
  - `StatsPanel` — edit big/label pairs
  - `LayoutPanel` — change slide layout type
  - `AgendaPanel` — edit timed items
  - `TimelinePanel` — edit step labels
- Optimistic preview via `applyOps`
- Save → `POST /edit-batch` → Drive write
- Re-render → trigger Slides `batch_update`

The spec.yaml schema already supports this — every field is individually addressable by `module.id + slide.id + field`.

## Implementation Order

1. **Template bundles** — Write `_common/platform-setup.yaml`, `facilitation.yaml`, `resources.yaml` + archetype-specific `spec.template.yaml` and `generate.prompt.md`
2. **Zod schema** — Implement `TrainingDeckSpecSchema` and all slide type schemas in `lib/training-deck-spec.ts`
3. **Bootstrap script** — Expand `scripts/bootstrap-training-deck-template.ts` to create all 14 stencils with Dimagi branding
4. **Common screenshot skill** — Write `skills/common-screenshot-capture/SKILL.md` — manually-triggered skill that drives the emulator through the full Connect platform onboarding flow (install CommCare, PersonalID signup, Connect navigation, claim an opp, sync) capturing screenshots at each step, publishes to `ACE/_common/connect-screenshots/<version>/`, and writes `manifest.yaml`. Improvable over time as the Connect UI evolves.
5. **Generate skill** — Write `skills/training-deck-generate/SKILL.md` replacing `training-deck-outline`
6. **Render skill** — Write `skills/training-deck-render/SKILL.md` replacing `training-deck-build`
7. **Builder functions** — Expand `buildSlidesRequests` in `lib/training-deck-spec.ts` for all 14 layouts (single-pass, no speaker notes)
8. **Integration test** — End-to-end: generate spec → render to Slides → verify slide count and images
9. **Artifact manifest** — Update `lib/artifact-manifest.ts` for new file names
10. **Phase 6 agent** — Update `agents/qa-and-training/AGENT.md` to use new skills

## Design Decisions

1. **YAML over markdown** — Typed schema with discriminated unions per layout. Eliminates fragile markdown parsing. Matches the video product pattern.

2. **14 stencils, not 2** — Each layout type gets its own stencil with pre-positioned elements and brand styling. Designers iterate in Slides UI; code just fills placeholders.

3. **Common module pool** — Platform setup slides ship verbatim with every deck. Updates propagate automatically. Decoupled from per-opp generation.

4. **Template bundles** — Generation logic lives in `generate.prompt.md`, not in skill code. New archetypes are purely additive (new template bundle, no code changes).

5. **Manifest-based image resolution** — Screenshots are aliased (`@claim-opp`), not hardcoded fileIds. Common and opp-specific manifests merge with opp winning on collision.

6. **Spec-first, render-second** — The spec is the source of truth. The rendered deck is a derived artifact. Humans edit the spec (today: YAML in Drive; future: SlideEditor UI); the renderer produces a fresh deck from the spec on demand.

7. **No backward compatibility with markdown outlines** — Clean break. Old outlines remain in Drive for reference but are not consumed by new skills.

## Resolved Questions

1. **Common screenshot capture cadence** — Manual trigger only. A dedicated `common-screenshot-capture` skill bootstraps and refreshes the common screenshot pool on demand. Improvable over time.
2. **Slide count targets per archetype** — TBD. Will iterate as we produce real decks and calibrate.
3. **Speaker notes** — No speaker notes. Removed from the spec format. Facilitation guidance lives in the LLO Manager Guide and FLW Guide, not in the deck.
4. **Print-friendly variant** — Not needed now. Google Slides native export covers this if needed later.
