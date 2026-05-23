# Training Deck Spec System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the markdown-based training deck system (2-stencil, fragile parser, 9-15 slide output) with a YAML-spec-driven system (14 stencils, Zod-validated schema, 30-45 slide output with facilitation and platform onboarding modules).

**Architecture:** A `spec.yaml` file (Zod-validated, discriminated union per slide layout) is the source of truth. An LLM generation skill produces the spec from PDD + screenshots + a template bundle. A renderer skill reads the spec and produces a Google Slides deck via multi-stencil `duplicateObject` + `replaceAllText` + `createImage`. Common modules (platform setup, facilitation, resources) ship as reusable YAML fragments. No speaker notes.

**Tech Stack:** TypeScript, Zod, Google Slides API (`batchUpdate`), Vitest, YAML (`js-yaml`), ACE skill YAML/Markdown format.

**Design Spec:** `docs/superpowers/specs/2026-05-23-training-deck-spec-system-design.md`

---

### Task 1: Zod Schema — Slide Type Definitions

**Files:**
- Rewrite: `lib/training-deck-spec.ts` (replace lines 1-76 with new schema)
- Test: `test/lib/training-deck-spec.test.ts`

This task replaces the old markdown-based `DeckSpec`, `SlideSpec`, and `BodyBlock` types with a Zod-validated YAML schema. The old `parseDeckOutline` function and all markdown parsing code will be removed in Task 3 after the new builder is in place.

- [ ] **Step 1: Write the Zod schema test**

Create a new test file that validates the schema parses valid YAML and rejects invalid input:

```typescript
// test/lib/training-deck-spec.test.ts — prepend this new describe block

import { describe, it, expect } from 'vitest';
import { parseTrainingSpec, type TrainingDeckSpec } from '../../lib/training-deck-spec.js';
import * as yaml from 'js-yaml';

const MINIMAL_SPEC = {
  slug: 'test-opp',
  name: 'Test Opportunity',
  program: 'Test Program',
  archetype: 'atomic-visit',
  template_id: 'connect-training-atomic',
  generated_at: '2026-05-23T14:30:00Z',
  source: { pdd_doc_id: 'abc', run_id: '20260523' },
  manifest: { common: { logo: 'drive:1ABC' }, opp: { form1: 'drive:2DEF' } },
  voice: { audience: 'flw', estimated_duration_minutes: 180, language: 'en' },
  modules: [{
    id: 'welcome',
    title: 'Welcome',
    slides: [{
      id: 'cover-slide',
      layout: 'cover',
      title: 'Test Opportunity',
      subtitle: 'FLW Training',
      date: 'June 2026',
    }],
  }],
};

describe('parseTrainingSpec', () => {
  it('parses a minimal valid spec from YAML string', () => {
    const yamlStr = yaml.dump(MINIMAL_SPEC);
    const spec = parseTrainingSpec(yamlStr);
    expect(spec.slug).toBe('test-opp');
    expect(spec.modules).toHaveLength(1);
    expect(spec.modules[0].slides[0].layout).toBe('cover');
  });

  it('rejects spec with missing required field', () => {
    const bad = { ...MINIMAL_SPEC, slug: undefined };
    expect(() => parseTrainingSpec(yaml.dump(bad))).toThrow();
  });

  it('rejects slide with unknown layout', () => {
    const bad = structuredClone(MINIMAL_SPEC);
    (bad.modules[0].slides[0] as any).layout = 'nonexistent';
    expect(() => parseTrainingSpec(yaml.dump(bad))).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/lib/training-deck-spec.test.ts --reporter verbose`
Expected: FAIL — `parseTrainingSpec` does not exist yet.

- [ ] **Step 3: Install js-yaml if not present**

Run: `npm ls js-yaml 2>/dev/null || npm install js-yaml && npm install -D @types/js-yaml`

- [ ] **Step 4: Write the Zod schema and parseTrainingSpec**

Add to the TOP of `lib/training-deck-spec.ts` (above the existing code — old code stays until Task 3):

```typescript
import { z } from 'zod';
import * as yaml from 'js-yaml';

// ============================================================================
// Training Deck Spec v2 — YAML-based, Zod-validated
// ============================================================================

// --- Slide layout schemas (discriminated union on `layout`) ---

const BaseSlideFields = {
  id: z.string(),
  title: z.string(),
};

const CoverSlideSchema = z.object({
  ...BaseSlideFields,
  layout: z.literal('cover'),
  subtitle: z.string().optional(),
  date: z.string().optional(),
});

const SectionSlideSchema = z.object({
  ...BaseSlideFields,
  layout: z.literal('section'),
});

const AgendaSlideSchema = z.object({
  ...BaseSlideFields,
  layout: z.literal('agenda'),
  items: z.array(z.object({
    label: z.string(),
    duration: z.string(),
  })),
});

const ContentSlideSchema = z.object({
  ...BaseSlideFields,
  layout: z.literal('content'),
  body: z.string(),
});

const WalkthroughSlideSchema = z.object({
  ...BaseSlideFields,
  layout: z.literal('walkthrough'),
  image: z.string(),
  body: z.string(),
});

const MobileFlowStepSchema = z.object({
  image: z.string(),
  caption: z.string(),
});

const MobileFlowSlideSchema = z.object({
  ...BaseSlideFields,
  layout: z.literal('mobile_flow'),
  steps: z.array(MobileFlowStepSchema).min(2).max(4),
});

const WebScreenSlideSchema = z.object({
  ...BaseSlideFields,
  layout: z.literal('web_screen'),
  image: z.string(),
  caption: z.string().optional(),
});

const MobileZoomSlideSchema = z.object({
  ...BaseSlideFields,
  layout: z.literal('mobile_zoom'),
  image: z.string(),
  callouts: z.array(z.string()).optional(),
});

const TwoColumnSideSchema = z.object({
  heading: z.string(),
  body: z.string(),
  image: z.string().optional(),
});

const TwoColumnSlideSchema = z.object({
  ...BaseSlideFields,
  layout: z.literal('two_column'),
  left: TwoColumnSideSchema,
  right: TwoColumnSideSchema,
});

const StatEntrySchema = z.object({
  big: z.string(),
  label: z.string(),
});

const StatsSlideSchema = z.object({
  ...BaseSlideFields,
  layout: z.literal('stats'),
  stats: z.array(StatEntrySchema).min(1).max(3),
});

const TimelineStepSchema = z.object({
  label: z.string(),
  detail: z.string(),
});

const TimelineSlideSchema = z.object({
  ...BaseSlideFields,
  layout: z.literal('timeline'),
  steps: z.array(TimelineStepSchema).min(2).max(5),
});

const ChecklistSlideSchema = z.object({
  ...BaseSlideFields,
  layout: z.literal('checklist'),
  items: z.array(z.string()),
});

const ExerciseSlideSchema = z.object({
  ...BaseSlideFields,
  layout: z.literal('exercise'),
  duration: z.string(),
  body: z.string(),
});

const ClosingSlideSchema = z.object({
  ...BaseSlideFields,
  layout: z.literal('closing'),
  body: z.string(),
});

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

export type SlideSpec_v2 = z.infer<typeof SlideSpecSchema>;

const ModuleSpecSchema = z.object({
  id: z.string(),
  title: z.string(),
  common: z.boolean().optional(),
  slides: z.array(SlideSpecSchema),
});

export type ModuleSpec = z.infer<typeof ModuleSpecSchema>;

export const TrainingDeckSpecSchema = z.object({
  slug: z.string(),
  name: z.string(),
  program: z.string(),
  archetype: z.enum(['atomic-visit', 'focus-group', 'multi-stage']),
  template_id: z.string(),
  generated_at: z.string(),
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

export type TrainingDeckSpec = z.infer<typeof TrainingDeckSpecSchema>;

export function parseTrainingSpec(yamlStr: string): TrainingDeckSpec {
  const raw = yaml.load(yamlStr);
  return TrainingDeckSpecSchema.parse(raw);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/lib/training-deck-spec.test.ts --reporter verbose`
Expected: All 3 new tests PASS; old tests still pass (old code untouched).

- [ ] **Step 6: Add per-layout validation tests**

Add tests for each of the 14 slide layouts to confirm schema validation works correctly. Add to the same `describe('parseTrainingSpec')` block:

```typescript
describe('slide layout validation', () => {
  function specWithSlide(slide: Record<string, unknown>): string {
    const s = { ...MINIMAL_SPEC, modules: [{ id: 'm', title: 'M', slides: [slide] }] };
    return yaml.dump(s);
  }

  it('validates agenda with items', () => {
    const spec = parseTrainingSpec(specWithSlide({
      id: 'a', layout: 'agenda', title: 'Agenda',
      items: [{ label: 'Setup', duration: '60 min' }],
    }));
    const slide = spec.modules[0].slides[0];
    expect(slide.layout).toBe('agenda');
    if (slide.layout === 'agenda') expect(slide.items).toHaveLength(1);
  });

  it('validates stats with 1-3 entries', () => {
    const spec = parseTrainingSpec(specWithSlide({
      id: 's', layout: 'stats', title: 'Targets',
      stats: [{ big: '5', label: 'visits' }, { big: '$23', label: 'payment' }],
    }));
    const slide = spec.modules[0].slides[0];
    if (slide.layout === 'stats') expect(slide.stats).toHaveLength(2);
  });

  it('rejects stats with 0 entries', () => {
    expect(() => parseTrainingSpec(specWithSlide({
      id: 's', layout: 'stats', title: 'T', stats: [],
    }))).toThrow();
  });

  it('validates mobile_flow with 2-4 steps', () => {
    const spec = parseTrainingSpec(specWithSlide({
      id: 'mf', layout: 'mobile_flow', title: 'Install',
      steps: [
        { image: '@img1', caption: 'Step 1' },
        { image: '@img2', caption: 'Step 2' },
      ],
    }));
    const slide = spec.modules[0].slides[0];
    if (slide.layout === 'mobile_flow') expect(slide.steps).toHaveLength(2);
  });

  it('rejects mobile_flow with 5 steps', () => {
    expect(() => parseTrainingSpec(specWithSlide({
      id: 'mf', layout: 'mobile_flow', title: 'T',
      steps: Array(5).fill({ image: '@x', caption: 'x' }),
    }))).toThrow();
  });

  it('validates timeline with 2-5 steps', () => {
    const spec = parseTrainingSpec(specWithSlide({
      id: 'tl', layout: 'timeline', title: 'Next Steps',
      steps: [{ label: 'Now', detail: 'Training' }, { label: 'Later', detail: 'Go live' }],
    }));
    const slide = spec.modules[0].slides[0];
    if (slide.layout === 'timeline') expect(slide.steps).toHaveLength(2);
  });

  it('validates two_column', () => {
    const spec = parseTrainingSpec(specWithSlide({
      id: 'tc', layout: 'two_column', title: 'Compare',
      left: { heading: 'Do', body: 'Good' },
      right: { heading: 'Don\'t', body: 'Bad' },
    }));
    const slide = spec.modules[0].slides[0];
    if (slide.layout === 'two_column') {
      expect(slide.left.heading).toBe('Do');
      expect(slide.right.heading).toBe("Don't");
    }
  });

  it('validates exercise with duration', () => {
    const spec = parseTrainingSpec(specWithSlide({
      id: 'ex', layout: 'exercise', title: 'Practice',
      duration: '20 min', body: 'Do the thing',
    }));
    const slide = spec.modules[0].slides[0];
    if (slide.layout === 'exercise') expect(slide.duration).toBe('20 min');
  });

  it('validates walkthrough with image + body', () => {
    const spec = parseTrainingSpec(specWithSlide({
      id: 'wt', layout: 'walkthrough', title: 'Screen',
      image: '@screenshot', body: '1. Do this\n2. Do that',
    }));
    const slide = spec.modules[0].slides[0];
    if (slide.layout === 'walkthrough') expect(slide.image).toBe('@screenshot');
  });

  it('validates checklist', () => {
    const spec = parseTrainingSpec(specWithSlide({
      id: 'cl', layout: 'checklist', title: 'Ready?',
      items: ['Item 1', 'Item 2'],
    }));
    const slide = spec.modules[0].slides[0];
    if (slide.layout === 'checklist') expect(slide.items).toHaveLength(2);
  });
});
```

- [ ] **Step 7: Run full test suite**

Run: `npm test -- test/lib/training-deck-spec.test.ts --reporter verbose`
Expected: ALL tests pass (new schema tests + old markdown tests).

- [ ] **Step 8: Commit**

```bash
git add lib/training-deck-spec.ts test/lib/training-deck-spec.test.ts package.json package-lock.json
git commit -m "feat(training-deck): add Zod schema for YAML-based spec format

14-layout discriminated union replaces markdown-based types.
Old parseDeckOutline/buildSlidesRequests preserved until builder migration."
```

---

### Task 2: Manifest Resolution

**Files:**
- Modify: `lib/training-deck-spec.ts`
- Test: `test/lib/training-deck-spec.test.ts`

Add the manifest resolver that maps `@alias` references in slide specs to concrete `drive:<fileId>` values.

- [ ] **Step 1: Write manifest resolution tests**

```typescript
import { resolveManifest, type ResolvedManifest } from '../../lib/training-deck-spec.js';

describe('resolveManifest', () => {
  const manifest = {
    common: { logo: 'drive:1ABC', 'install-step1': 'drive:1DEF' },
    opp: { form1: 'drive:2GHI', logo: 'drive:2JKL' },
  };

  it('merges common + opp with opp winning on collision', () => {
    const resolved = resolveManifest(manifest);
    expect(resolved.get('logo')).toBe('drive:2JKL');
    expect(resolved.get('install-step1')).toBe('drive:1DEF');
    expect(resolved.get('form1')).toBe('drive:2GHI');
  });

  it('resolveImageRef strips @ prefix and returns fileId', () => {
    const resolved = resolveManifest(manifest);
    expect(resolved.resolveImageRef('@logo')).toBe(
      'https://drive.google.com/uc?export=view&id=2JKL',
    );
  });

  it('resolveImageRef passes https:// URLs through', () => {
    const resolved = resolveManifest(manifest);
    expect(resolved.resolveImageRef('https://example.com/img.png')).toBe(
      'https://example.com/img.png',
    );
  });

  it('resolveImageRef throws for unresolvable alias', () => {
    const resolved = resolveManifest(manifest);
    expect(() => resolved.resolveImageRef('@nonexistent')).toThrow(/unresolvable/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/lib/training-deck-spec.test.ts -t "resolveManifest" --reporter verbose`
Expected: FAIL — `resolveManifest` does not exist.

- [ ] **Step 3: Implement resolveManifest**

Add to `lib/training-deck-spec.ts` after the `parseTrainingSpec` function:

```typescript
export interface ResolvedManifest {
  get(alias: string): string | undefined;
  resolveImageRef(ref: string): string;
}

export function resolveManifest(manifest: TrainingDeckSpec['manifest']): ResolvedManifest {
  const merged = new Map<string, string>();
  if (manifest.common) {
    for (const [k, v] of Object.entries(manifest.common)) merged.set(k, v);
  }
  if (manifest.opp) {
    for (const [k, v] of Object.entries(manifest.opp)) merged.set(k, v);
  }

  return {
    get(alias: string) { return merged.get(alias); },
    resolveImageRef(ref: string): string {
      if (ref.startsWith('https://')) return ref;
      const alias = ref.startsWith('@') ? ref.slice(1) : ref;
      const value = merged.get(alias);
      if (!value) throw new Error(`Unresolvable image alias: "${ref}"`);
      if (value.startsWith('drive:')) {
        const fileId = value.slice('drive:'.length);
        return `https://drive.google.com/uc?export=view&id=${fileId}`;
      }
      return value;
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/lib/training-deck-spec.test.ts --reporter verbose`
Expected: ALL pass.

- [ ] **Step 5: Commit**

```bash
git add lib/training-deck-spec.ts test/lib/training-deck-spec.test.ts
git commit -m "feat(training-deck): add manifest resolver for @alias image refs"
```

---

### Task 3: Builder Functions — Per-Layout Request Generators

**Files:**
- Modify: `lib/training-deck-spec.ts` (add new builder, keep old until Task 6)
- Test: `test/lib/training-deck-spec.test.ts`

Build the new `buildSlidesRequestsV2` function that generates Slides API requests for all 14 layouts. This replaces the old `buildSlidesRequests` which only handled `content` stencils.

- [ ] **Step 1: Define stencil constants and builder interface**

Add to `lib/training-deck-spec.ts`:

```typescript
// ============================================================================
// v2 Slides batchUpdate builder (multi-stencil, no speaker notes)
// ============================================================================

export const STENCILS = {
  cover:       'ace_stencil_cover',
  section:     'ace_stencil_section',
  agenda:      'ace_stencil_agenda',
  content:     'ace_stencil_content_v2',
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

export type StencilKey = keyof typeof STENCILS;

export interface BuildOptsV2 {
  stencils: Record<StencilKey, string>;
  manifest: ResolvedManifest;
}

export function buildSlidesRequestsV2(
  spec: TrainingDeckSpec,
  opts: BuildOptsV2,
): Array<Record<string, unknown>> {
  const requests: Array<Record<string, unknown>> = [];
  let slideCounter = 0;

  for (const mod of spec.modules) {
    for (const slide of mod.slides) {
      slideCounter++;
      const newSlideId = `ace_slide_${slideCounter}`;
      const stencilId = opts.stencils[slide.layout as StencilKey];
      if (!stencilId) {
        throw new Error(`No stencil found for layout "${slide.layout}"`);
      }

      // Duplicate the matching stencil
      requests.push({
        duplicateObject: {
          objectId: stencilId,
          objectIds: { [stencilId]: newSlideId },
        },
      });

      // Layout-specific placeholder replacements + images
      requests.push(...buildLayoutRequests(slide, newSlideId, opts.manifest));
    }
  }

  // Delete all stencil slides
  for (const stencilId of Object.values(opts.stencils)) {
    requests.push({ deleteObject: { objectId: stencilId } });
  }

  return requests;
}
```

- [ ] **Step 2: Implement per-layout request builders**

Add the `buildLayoutRequests` function and helpers:

```typescript
function buildLayoutRequests(
  slide: SlideSpec_v2,
  pageId: string,
  manifest: ResolvedManifest,
): Array<Record<string, unknown>> {
  const reqs: Array<Record<string, unknown>> = [];
  const replace = (token: string, value: string) =>
    replaceAllText(token, value, [pageId]);

  reqs.push(replace('{{TITLE}}', slide.title));

  switch (slide.layout) {
    case 'cover':
      reqs.push(replace('{{SUBTITLE}}', slide.subtitle ?? ''));
      reqs.push(replace('{{DATE}}', slide.date ?? ''));
      break;

    case 'section':
      break;

    case 'agenda':
      reqs.push(replace('{{BODY}}', slide.items
        .map(i => `${i.label}  —  ${i.duration}`)
        .join('\n')));
      break;

    case 'content':
      reqs.push(replace('{{BODY}}', slide.body));
      break;

    case 'walkthrough':
      reqs.push(replace('{{BODY}}', slide.body));
      reqs.push(createImage(
        `${pageId}_img`,
        pageId,
        manifest.resolveImageRef(slide.image),
        { x: 4_572_000, y: 914_400, w: 4_114_800, h: 3_771_900 },
      ));
      break;

    case 'mobile_flow':
      slide.steps.forEach((step, i) => {
        reqs.push(replace(`{{STEP_${i + 1}_CAPTION}}`, step.caption));
        const frameWidth = 1_828_800;
        const gap = 228_600;
        const totalWidth = slide.steps.length * frameWidth + (slide.steps.length - 1) * gap;
        const startX = (9_144_000 - totalWidth) / 2;
        reqs.push(createImage(
          `${pageId}_phone_${i}`,
          pageId,
          manifest.resolveImageRef(step.image),
          { x: startX + i * (frameWidth + gap), y: 914_400, w: frameWidth, h: 3_200_400 },
        ));
      });
      // Hide unused step placeholders (stencil has 4 slots)
      for (let i = slide.steps.length; i < 4; i++) {
        reqs.push(replace(`{{STEP_${i + 1}_CAPTION}}`, ''));
      }
      break;

    case 'web_screen':
      reqs.push(replace('{{CAPTION}}', slide.caption ?? ''));
      reqs.push(createImage(
        `${pageId}_img`,
        pageId,
        manifest.resolveImageRef(slide.image),
        { x: 457_200, y: 1_143_000, w: 8_229_600, h: 3_429_000 },
      ));
      break;

    case 'mobile_zoom':
      reqs.push(replace('{{CALLOUTS}}',
        (slide.callouts ?? []).map(c => `• ${c}`).join('\n')));
      reqs.push(createImage(
        `${pageId}_img`,
        pageId,
        manifest.resolveImageRef(slide.image),
        { x: 2_286_000, y: 685_800, w: 2_743_200, h: 4_000_500 },
      ));
      break;

    case 'two_column':
      reqs.push(replace('{{LEFT_HEADING}}', slide.left.heading));
      reqs.push(replace('{{LEFT_BODY}}', slide.left.body));
      reqs.push(replace('{{RIGHT_HEADING}}', slide.right.heading));
      reqs.push(replace('{{RIGHT_BODY}}', slide.right.body));
      if (slide.left.image) {
        reqs.push(createImage(
          `${pageId}_img_left`,
          pageId,
          manifest.resolveImageRef(slide.left.image),
          { x: 457_200, y: 2_743_200, w: 3_886_200, h: 1_943_100 },
        ));
      }
      if (slide.right.image) {
        reqs.push(createImage(
          `${pageId}_img_right`,
          pageId,
          manifest.resolveImageRef(slide.right.image),
          { x: 4_800_600, y: 2_743_200, w: 3_886_200, h: 1_943_100 },
        ));
      }
      break;

    case 'stats':
      slide.stats.forEach((s, i) => {
        reqs.push(replace(`{{STAT${i + 1}}}`, s.big));
        reqs.push(replace(`{{STAT${i + 1}_LABEL}}`, s.label));
      });
      for (let i = slide.stats.length; i < 3; i++) {
        reqs.push(replace(`{{STAT${i + 1}}}`, ''));
        reqs.push(replace(`{{STAT${i + 1}_LABEL}}`, ''));
      }
      break;

    case 'timeline':
      slide.steps.forEach((s, i) => {
        reqs.push(replace(`{{STEP${i + 1}_LABEL}}`, s.label));
        reqs.push(replace(`{{STEP${i + 1}_DETAIL}}`, s.detail));
      });
      for (let i = slide.steps.length; i < 5; i++) {
        reqs.push(replace(`{{STEP${i + 1}_LABEL}}`, ''));
        reqs.push(replace(`{{STEP${i + 1}_DETAIL}}`, ''));
      }
      break;

    case 'checklist':
      reqs.push(replace('{{BODY}}', slide.items.map(i => `☐ ${i}`).join('\n')));
      break;

    case 'exercise':
      reqs.push(replace('{{DURATION}}', slide.duration));
      reqs.push(replace('{{BODY}}', slide.body));
      break;

    case 'closing':
      reqs.push(replace('{{BODY}}', slide.body));
      break;
  }

  return reqs;
}

function createImage(
  objectId: string,
  pageObjectId: string,
  url: string,
  pos: { x: number; y: number; w: number; h: number },
): Record<string, unknown> {
  return {
    createImage: {
      objectId,
      elementProperties: {
        pageObjectId,
        size: {
          height: { magnitude: pos.h, unit: 'EMU' },
          width: { magnitude: pos.w, unit: 'EMU' },
        },
        transform: {
          scaleX: 1,
          scaleY: 1,
          translateX: pos.x,
          translateY: pos.y,
          unit: 'EMU',
        },
      },
      url,
    },
  };
}
```

- [ ] **Step 3: Write builder tests**

```typescript
describe('buildSlidesRequestsV2', () => {
  const manifest = resolveManifest({
    common: { logo: 'drive:1ABC' },
    opp: { form1: 'drive:2DEF', screenshot: 'drive:3GHI' },
  });

  function buildFromSlides(slides: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const spec = parseTrainingSpec(yaml.dump({
      ...MINIMAL_SPEC,
      modules: [{ id: 'm', title: 'M', slides }],
    }));
    return buildSlidesRequestsV2(spec, {
      stencils: Object.fromEntries(
        Object.entries(STENCILS).map(([k, v]) => [k, v]),
      ) as Record<StencilKey, string>,
      manifest,
    });
  }

  it('emits duplicateObject for cover stencil', () => {
    const reqs = buildFromSlides([{
      id: 'c', layout: 'cover', title: 'Test', subtitle: 'Sub', date: 'June',
    }]);
    const dup = reqs.find((r: any) => r.duplicateObject?.objectId === STENCILS.cover);
    expect(dup).toBeTruthy();
  });

  it('emits replaceAllText for content body', () => {
    const reqs = buildFromSlides([{
      id: 'c', layout: 'content', title: 'T', body: 'Hello world',
    }]);
    const bodyRepl = reqs.find((r: any) =>
      r.replaceAllText?.containsText?.text === '{{BODY}}' &&
      r.replaceAllText?.replaceText === 'Hello world',
    );
    expect(bodyRepl).toBeTruthy();
  });

  it('emits createImage for walkthrough', () => {
    const reqs = buildFromSlides([{
      id: 'w', layout: 'walkthrough', title: 'T',
      image: '@screenshot', body: 'Steps here',
    }]);
    const img = reqs.find((r: any) => r.createImage);
    expect((img as any).createImage.url).toBe(
      'https://drive.google.com/uc?export=view&id=3GHI',
    );
  });

  it('emits 4 createImage for mobile_flow with 4 steps', () => {
    const reqs = buildFromSlides([{
      id: 'mf', layout: 'mobile_flow', title: 'Install',
      steps: [
        { image: '@logo', caption: 'S1' },
        { image: '@form1', caption: 'S2' },
        { image: '@screenshot', caption: 'S3' },
        { image: '@logo', caption: 'S4' },
      ],
    }]);
    const imgs = reqs.filter((r: any) => r.createImage);
    expect(imgs).toHaveLength(4);
  });

  it('emits stats replacements with unused slots cleared', () => {
    const reqs = buildFromSlides([{
      id: 's', layout: 'stats', title: 'Targets',
      stats: [{ big: '5', label: 'visits' }],
    }]);
    const stat1 = reqs.find((r: any) =>
      r.replaceAllText?.containsText?.text === '{{STAT1}}' &&
      r.replaceAllText?.replaceText === '5',
    );
    expect(stat1).toBeTruthy();
    const stat2 = reqs.find((r: any) =>
      r.replaceAllText?.containsText?.text === '{{STAT2}}' &&
      r.replaceAllText?.replaceText === '',
    );
    expect(stat2).toBeTruthy();
  });

  it('emits deleteObject for all 14 stencils at the end', () => {
    const reqs = buildFromSlides([{
      id: 'c', layout: 'content', title: 'T', body: 'B',
    }]);
    const deletes = reqs.filter((r: any) => r.deleteObject);
    expect(deletes).toHaveLength(14);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/lib/training-deck-spec.test.ts --reporter verbose`
Expected: ALL pass.

- [ ] **Step 5: Commit**

```bash
git add lib/training-deck-spec.ts test/lib/training-deck-spec.test.ts
git commit -m "feat(training-deck): add v2 builder for 14-stencil layouts"
```

---

### Task 4: Remove Legacy Markdown System

**Files:**
- Modify: `lib/training-deck-spec.ts` (remove old types, parser, builder)
- Modify: `test/lib/training-deck-spec.test.ts` (remove old tests)

- [ ] **Step 1: Remove old types and functions**

In `lib/training-deck-spec.ts`, delete:
- Lines 1-51 (the old module doc comment)
- The old `DeckSpec`, `SlideSpec`, `BodyBlock`, `ImageRef` interfaces
- `parseDeckOutline` function
- `parseSlide` helper
- `parseImageRef` helper
- Old stencil constants: `STENCIL_TITLE_OBJECT_ID`, `STENCIL_CONTENT_OBJECT_ID`
- Old placeholder constants: `PLACEHOLDER_TITLE`, `PLACEHOLDER_SUBTITLE`, `PLACEHOLDER_BODY` (keep the new inline `'{{TITLE}}'` etc. in the builder)
- Old `SlidesBuildOpts`, `SlidesBuildResult` interfaces
- Old `buildSlidesRequests` function
- Old `renderBodyText` helper
- `buildSpeakerNotesRequests` function
- Image positioning constants (`SLIDE_WIDTH_EMU` etc. — new builder has its own positioning)

- [ ] **Step 2: Remove old tests**

In `test/lib/training-deck-spec.test.ts`, delete:
- `describe('parseDeckOutline', ...)` block and all its `it(...)` tests
- `describe('buildSlidesRequests (template-based)', ...)` block
- `describe('buildSpeakerNotesRequests', ...)` block
- Old imports: `parseDeckOutline`, `buildSlidesRequests`, `buildSpeakerNotesRequests`, `STENCIL_TITLE_OBJECT_ID`, `STENCIL_CONTENT_OBJECT_ID`

- [ ] **Step 3: Verify no remaining references to old code**

Run: `grep -rn 'parseDeckOutline\|STENCIL_TITLE_OBJECT_ID\|STENCIL_CONTENT_OBJECT_ID\|buildSpeakerNotesRequests' lib/ test/`
Expected: No matches.

- [ ] **Step 4: Run tests**

Run: `npm test -- test/lib/training-deck-spec.test.ts --reporter verbose`
Expected: ALL pass (only new v2 tests remain).

- [ ] **Step 5: Commit**

```bash
git add lib/training-deck-spec.ts test/lib/training-deck-spec.test.ts
git commit -m "refactor(training-deck): remove legacy markdown parser and old builder"
```

---

### Task 5: Bootstrap Script — 14 Stencils

**Files:**
- Rewrite: `scripts/bootstrap-training-deck-template.ts`

This task expands the bootstrap script from creating 2 stencil slides to 14, with Dimagi brand styling (Work Sans, indigo #24117D, amber #FDAE31). The script is run once to create the template in Google Drive.

- [ ] **Step 1: Rewrite the bootstrap script**

Rewrite `scripts/bootstrap-training-deck-template.ts`. The structure stays the same (idempotency check → `drive.files.create` → `slides.presentations.batchUpdate`), but the `batchUpdate` requests now create 14 stencils instead of 2.

Import the new `STENCILS` constant from `lib/training-deck-spec.ts` and build all 14 stencil slides. Each stencil:
- Uses `createSlide` with `objectId` from `STENCILS[key]` and `predefinedLayout: 'BLANK'`
- Gets `createShape` calls for each text box with the right placeholder tokens
- Gets `updateTextStyle` calls for Work Sans font family and appropriate sizes
- Gets `updateShapeProperties` for accent colors where appropriate (exercise: amber background)

Key positioning constants (all EMU):
- Slide: 9,144,000 × 5,143,500
- Standard margins: 457,200 (0.5")
- Title: 685,800 tall, y=457,200
- Body: starts at y=1,371,600 (below title)
- Work Sans font sizes: title=28pt, body=14pt, stat=72pt, section=38pt, cover=36pt

Update the template name to `'ACE Training Deck Template (v2)'` and the env var docs to note this is the 14-stencil version.

- [ ] **Step 2: Verify the script compiles**

Run: `npx tsx --no-execute scripts/bootstrap-training-deck-template.ts 2>&1 || echo "compile check"`
(Or simply `npx tsc --noEmit scripts/bootstrap-training-deck-template.ts` if tsconfig covers it)

- [ ] **Step 3: Commit**

```bash
git add scripts/bootstrap-training-deck-template.ts
git commit -m "feat(training-deck): expand bootstrap script to create 14-stencil template v2"
```

Note: Actually running the script against Google Drive is a manual step (requires `ACE_DRIVE_ROOT_FOLDER_ID` and Slides API enabled). The script will be executed once after merge, and the resulting template ID stored in 1Password.

---

### Task 6: Template Bundles — Common Modules + Archetype Templates

**Files:**
- Create: `templates/training-deck/_common/platform-setup.yaml`
- Create: `templates/training-deck/_common/facilitation.yaml`
- Create: `templates/training-deck/_common/resources.yaml`
- Create: `templates/training-deck/connect-training-atomic/template.yaml`
- Create: `templates/training-deck/connect-training-atomic/spec.template.yaml`
- Create: `templates/training-deck/connect-training-atomic/generate.prompt.md`

- [ ] **Step 1: Create directory structure**

Run: `mkdir -p templates/training-deck/_common templates/training-deck/connect-training-atomic`

- [ ] **Step 2: Write platform-setup.yaml**

Write `templates/training-deck/_common/platform-setup.yaml`:

```yaml
id: platform-setup
title: "Connect Platform Setup"
common: true
slides:
  - id: what-is-connect
    layout: content
    title: "What is CommCare Connect?"
    body: |
      CommCare Connect matches you with paid work opportunities:
      - Learn: Complete training modules on your phone
      - Deliver: Do field work using guided forms
      - Verify: Your work is checked for quality
      - Pay: Get paid for verified, quality work

  - id: install-commcare
    layout: mobile_flow
    title: "Step 1: Download CommCare"
    steps:
      - { image: "@play-store-search", caption: "Open Play Store, search 'CommCare'" }
      - { image: "@commcare-install", caption: "Tap 'Install'" }
      - { image: "@commcare-open", caption: "Tap 'Open'" }
      - { image: "@commcare-welcome", caption: "CommCare is ready" }

  - id: personal-id-start
    layout: mobile_flow
    title: "Step 2: Create Your PersonalID"
    steps:
      - { image: "@personal-id-start", caption: "Tap 'Sign Up'" }
      - { image: "@personal-id-name", caption: "Enter your name" }
      - { image: "@personal-id-phone", caption: "Enter your phone number" }
      - { image: "@personal-id-verify", caption: "Enter the code you received" }

  - id: personal-id-details
    layout: mobile_flow
    title: "Step 2 (continued): Complete Your Profile"
    steps:
      - { image: "@personal-id-photo", caption: "Take your photo" }
      - { image: "@personal-id-id", caption: "Scan your ID" }
      - { image: "@personal-id-location", caption: "Allow location access" }
      - { image: "@personal-id-done", caption: "Profile complete!" }

  - id: connect-home
    layout: walkthrough
    title: "The Connect Home Screen"
    image: "@connect-home"
    body: |
      1. Your name and profile appear at the top
      2. "New Opportunities" shows available work
      3. "My Opportunities" shows work you've claimed
      4. Tap the menu icon for settings and help

  - id: claim-opportunity
    layout: walkthrough
    title: "Claiming Your Opportunity"
    image: "@claim-opp"
    body: |
      1. Find your opportunity in the list
      2. Read the description and requirements
      3. Tap "Claim" to get started
      4. The opportunity moves to "My Opportunities"

  - id: install-learn
    layout: walkthrough
    title: "Installing the Learn App"
    image: "@learn-install"
    body: |
      1. After claiming, tap "Start Learning"
      2. CommCare will download the Learn app
      3. Wait for the download to complete
      4. The Learn modules will appear on your screen

  - id: syncing
    layout: content
    title: "Keeping Your Data in Sync"
    body: |
      Your phone sends data to the server when you have internet.

      - Always sync before starting work (pull latest updates)
      - Sync after completing each form (push your data)
      - If offline, your data is saved locally and syncs when you reconnect
      - Look for the green check mark — it means sync is complete
```

- [ ] **Step 3: Write facilitation.yaml**

Write `templates/training-deck/_common/facilitation.yaml`:

```yaml
icebreakers:
  - id: two-truths
    title: "Two Truths and a Lie"
    duration: "10 min"
    body: |
      Each person shares three statements about themselves — two true, one false.
      The group guesses which one is the lie.
      Go around the room until everyone has had a turn.

  - id: one-word
    title: "One-Word Check-In"
    duration: "5 min"
    body: |
      Go around the room.
      Each person shares one word that describes how they feel right now.
      No explanation needed — just the word.

  - id: common-ground
    title: "Common Ground"
    duration: "10 min"
    body: |
      Find three things everyone in the group has in common.
      They cannot be obvious (like "we all have phones").
      Share your findings with the room.

practice_patterns:
  - id: guided-learn
    layout: exercise
    title: "Complete Learn Module {{N}}"
    duration: "20 min"
    body: |
      Open your phone and complete Learn Module {{N}} now.
      Raise your hand when you finish or if you need help.

  - id: form-practice
    layout: exercise
    title: "Fill Out a Sample Form"
    duration: "15 min"
    body: |
      Working with a partner, fill out the {{FORM_NAME}} form.
      Use the practice data provided.
      Compare your answers when you're done.

  - id: role-play
    layout: exercise
    title: "Simulated {{VISIT_TYPE}}"
    duration: "20 min"
    body: |
      Pair up. One person plays the {{ROLE}}, the other is the worker.
      Complete the full visit workflow from introduction to submission.
      Switch roles and repeat.
```

- [ ] **Step 4: Write resources.yaml**

Write `templates/training-deck/_common/resources.yaml`:

```yaml
id: resources
title: "Resources & Help"
slides:
  - id: where-to-get-help
    layout: content
    title: "Where to Get Help"
    body: |
      - OCS Chatbot: Available 24/7 in the Connect app — ask any question about your work
      - Your LLO Manager: {{LLO_CONTACT}} — for scheduling, logistics, and urgent issues
      - Quick Reference Card: Keep it with you in the field
      - FAQ Document: Answers to the most common questions

  - id: closing
    layout: closing
    title: "Thank You"
    body: |
      You are ready to make a difference.

      Remember:
      - Complete your Learn modules before going into the field
      - Use the chatbot whenever you have questions
      - Your LLO manager is here to support you

      Good luck!
```

- [ ] **Step 5: Write atomic template bundle**

Write `templates/training-deck/connect-training-atomic/template.yaml`:

```yaml
id: connect-training-atomic
name: "Connect Training — Atomic Visit"
description: >
  Full training deck for atomic-visit opportunities (pharmacy surveys,
  household visits, sample collection, etc.). Produces a 30-45 slide deck
  covering platform setup, opportunity walkthrough, practice, and evaluation.
archetype: atomic-visit
audience: flw
modules:
  - welcome
  - platform-setup
  - your-opportunity
  - practice
  - evaluation
  - resources
expected_slide_count: "30-45"
expected_duration_minutes: "150-240"
```

- [ ] **Step 6: Write spec.template.yaml skeleton**

Write `templates/training-deck/connect-training-atomic/spec.template.yaml`:

```yaml
slug: "{{OPP_SLUG}}"
name: "{{OPP_NAME}}"
program: "{{PROGRAM_NAME}}"
archetype: atomic-visit
template_id: connect-training-atomic
generated_at: "{{GENERATED_AT}}"
source:
  pdd_doc_id: "{{PDD_DOC_ID}}"
  run_id: "{{RUN_ID}}"

manifest:
  common: "{{COMMON_MANIFEST}}"
  opp: "{{OPP_MANIFEST}}"

voice:
  audience: flw
  estimated_duration_minutes: "{{DURATION}}"
  language: "{{LANGUAGE}}"

modules:
  - id: welcome
    title: "Welcome & Introductions"
    slides:
      - id: cover
        layout: cover
        title: "{{OPP_NAME}}"
        subtitle: "FLW Training — {{DATE}}"
        date: "{{DATE}}"
      - id: agenda
        layout: agenda
        title: "Today's Agenda"
        items: "{{AGENDA_ITEMS}}"
      - id: icebreaker
        layout: exercise
        title: "{{ICEBREAKER_TITLE}}"
        duration: "{{ICEBREAKER_DURATION}}"
        body: "{{ICEBREAKER_BODY}}"

  # platform-setup module included by reference from _common/platform-setup.yaml

  - id: your-opportunity
    title: "Your Opportunity"
    slides: "{{OPP_SLIDES}}"

  - id: practice
    title: "Practice & Hands-On"
    slides: "{{PRACTICE_SLIDES}}"

  - id: evaluation
    title: "Evaluation & Next Steps"
    slides: "{{EVALUATION_SLIDES}}"

  # resources module included by reference from _common/resources.yaml
```

- [ ] **Step 7: Write generate.prompt.md**

Write `templates/training-deck/connect-training-atomic/generate.prompt.md`:

```markdown
# Training Deck Generation — Atomic Visit

You are generating a training deck spec.yaml for a Connect opportunity.
The deck will be rendered into a Google Slides presentation used for
in-person FLW training sessions.

## Inputs Available

1. **PDD** — the Program Design Document with full opportunity description
2. **App summaries** — Learn and Deliver app structure from Phase 3
3. **Screenshot manifests** — common (platform) + per-opp (app) screenshots
4. **run_state.yaml** — opportunity metadata, payment info, verification rules

## Module Instructions

### welcome (generate)
- Cover slide: use opp name + "FLW Training — [month year]"
- Agenda: allocate time proportional to content. Typical:
  - Platform Setup: 60 min (skip if audience is experienced)
  - Your Opportunity: 60-90 min
  - Lunch: 30 min (include if total > 3 hours)
  - Practice: 45-60 min
  - Evaluation: 30 min
- Ice-breaker: pick from facilitation.yaml pool based on group size hint in PDD

### platform-setup (include by reference)
- Include `_common/platform-setup.yaml` verbatim. Do NOT regenerate.
- Merge common manifest screenshots into the spec's manifest.common

### your-opportunity (generate — this is the core content)
Layout selection rules:
- Start with a `content` slide: "What You're Doing" — mission framing from PDD
- Use `stats` for quantitative targets (daily targets, payment, pass threshold)
- Use `walkthrough` for each key app screen (Learn module, Deliver form)
- Use `mobile_flow` for multi-step workflows (claim → learn → deliver → submit)
- Use `two_column` for do/don't comparisons (photo quality, data entry)
- Use `mobile_zoom` for complex forms with callouts
- Use `content` for process explanations, tips, common pitfalls

Word budgets per slide:
- `content` body: 40-80 words max
- `walkthrough` body: 30-50 words (steps only, no prose)
- `stats` labels: 5-10 words each
- `two_column` body per side: 20-40 words

### practice (generate from PDD + app structure)
- One exercise per key skill: Learn completion, form filling, role play
- Duration: 15-20 min each
- Instructions must be concrete: "Open Module 1" not "Review the training"

### evaluation (generate from PDD acceptance criteria)
- `checklist` slide with readiness items derived from Learn pass criteria + key skills
- `timeline` slide with the path from training to go-live

### resources (include by reference)
- Include `_common/resources.yaml`. Replace {{LLO_CONTACT}} with "your LLO manager" (actual contact filled at Phase 9).

## Tone & Audience
- High-school reading level
- Use concrete button names from app summaries ("Tap 'Submit'", not "submit the form")
- No jargon: say "phone" not "device", "work" not "opportunity"
- No speaker notes (removed from spec format)

## Image References
- Use `@alias` format referencing manifest keys
- Every `walkthrough` and `mobile_flow` slide MUST have images
- `content`, `stats`, `timeline`, `checklist`, `exercise` slides do NOT need images
```

- [ ] **Step 8: Commit**

```bash
git add templates/training-deck/
git commit -m "feat(training-deck): add template bundles — common modules + atomic archetype"
```

---

### Task 7: Generate Skill (SKILL.md)

**Files:**
- Create: `skills/training-deck-generate/SKILL.md`
- Delete: `skills/training-deck-outline/SKILL.md` (and its directory)

- [ ] **Step 1: Write the generate skill**

Write `skills/training-deck-generate/SKILL.md` — this is the skill that reads PDD + app summaries + screenshot manifests + a template bundle, then generates a `spec.yaml` file. Follow the existing skill author contract from `skills/README.md`.

Key sections:
- Frontmatter: `name: training-deck-generate`, `description: Generate training deck spec.yaml from PDD + screenshots + template bundle`
- Inputs: PDD, app summaries, screenshot manifests, run_state.yaml, template bundle
- Process: Read template bundle → read inputs → merge manifests → fill skeleton → validate with Zod schema → write spec.yaml to Drive
- Self-eval: coverage (all modules present), concreteness (no placeholder text), image refs valid, slide count in range

- [ ] **Step 2: Delete old outline skill**

Run: `rm -rf skills/training-deck-outline/`

- [ ] **Step 3: Commit**

```bash
git add skills/training-deck-generate/ && git rm -r skills/training-deck-outline/
git commit -m "feat(training-deck): add generate skill, remove legacy outline skill"
```

---

### Task 8: Render Skill (SKILL.md)

**Files:**
- Create: `skills/training-deck-render/SKILL.md`
- Delete: `skills/training-deck-build/SKILL.md` (and its directory)

- [ ] **Step 1: Write the render skill**

Write `skills/training-deck-render/SKILL.md` — reads `spec.yaml` from Drive, validates it, resolves the manifest, copies the template, and executes the Slides batchUpdate pipeline.

Key sections:
- Frontmatter: `name: training-deck-render`, `description: Render spec.yaml into Google Slides deck via 14-stencil template`
- Inputs: `training-deck-spec.yaml` from Drive (produced by `training-deck-generate`)
- Process:
  1. Read spec.yaml, validate with `parseTrainingSpec`
  2. Resolve manifest via `resolveManifest` — halt if any image in walkthrough/mobile_flow is unresolvable
  3. Verify all Drive fileIds are shared `anyone-with-link` via `drive_set_anyone_with_link`
  4. `slides_copy_template` with `ACE_TRAINING_DECK_TEMPLATE_ID`
  5. `slides_get` to discover stencil objectIds — verify all 14 present
  6. `buildSlidesRequestsV2` to produce the request array
  7. `slides_batch_update` — single call with all requests
  8. Write deck handoff to `run_state.yaml.phases.qa-and-training.products.training.deck`
- Self-eval: slide count matches spec, all images rendered, no API errors

- [ ] **Step 2: Delete old build skill**

Run: `rm -rf skills/training-deck-build/`

- [ ] **Step 3: Commit**

```bash
git add skills/training-deck-render/ && git rm -r skills/training-deck-build/
git commit -m "feat(training-deck): add render skill, remove legacy build skill"
```

---

### Task 9: Common Screenshot Skill

**Files:**
- Create: `skills/common-screenshot-capture/SKILL.md`

This skill captures Connect platform screenshots (install, PersonalID, navigation) for the common module. Manually triggered, not part of `/ace:run`.

- [ ] **Step 1: Write the skill**

Write `skills/common-screenshot-capture/SKILL.md`:

Key sections:
- Frontmatter: `name: common-screenshot-capture`, `description: Capture and publish common Connect platform screenshots for training deck common modules. Manual trigger only.`
- Process:
  1. Ensure AVD is running via `mobile_ensure_avd_running`
  2. Run baseline recipes (install CommCare, PersonalID signup, Connect navigation) via `mobile_run_recipe`
  3. Capture screenshots at each step
  4. Upload PNGs to `ACE/_common/connect-screenshots/<version>/` via `drive_upload_binary`
  5. Set `anyone-with-link` on each file via `drive_set_anyone_with_link`
  6. Write `manifest.yaml` with `{ alias → drive:<fileId> }` mappings
  7. Upload manifest to the same folder
- Aliases must match the keys used in `_common/platform-setup.yaml`: `play-store-search`, `commcare-install`, `commcare-open`, `commcare-welcome`, `personal-id-start`, `personal-id-name`, `personal-id-phone`, `personal-id-verify`, `personal-id-photo`, `personal-id-id`, `personal-id-location`, `personal-id-done`, `connect-home`, `claim-opp`, `learn-install`

- [ ] **Step 2: Commit**

```bash
git add skills/common-screenshot-capture/
git commit -m "feat(training-deck): add common-screenshot-capture skill"
```

---

### Task 10: Artifact Manifest + Phase 6 Agent + Cleanup

**Files:**
- Modify: `lib/artifact-manifest.ts` (lines 645-670)
- Modify: `agents/qa-and-training.md` (lines 19-20, 258, 268-270, 307, 321)

- [ ] **Step 1: Update artifact manifest**

In `lib/artifact-manifest.ts`, replace the training-deck entries (around lines 645-670):

Replace:
```typescript
  {
    path: '6-qa-and-training/training-deck-outline.md',
    producedBy: 'training-deck-outline',
    consumedBy: ['training-deck-build'],
    ...
  },
  {
    path: '6-qa-and-training/training-deck-build_verdict.yaml',
    producedBy: 'training-deck-build',
    ...
  },
  {
    path: '6-qa-and-training/training-deck-outline-eval_verdict.yaml',
    producedBy: 'training-deck-outline-eval',
    ...
  },
```

With:
```typescript
  {
    path: '6-qa-and-training/training-deck-spec.yaml',
    producedBy: 'training-deck-generate',
    consumedBy: ['training-deck-render'],
    phase: 'qa-and-training',
    required: false,
    description: 'YAML spec for the training deck. Validated by Zod schema in `lib/training-deck-spec.ts`. Rendered to Google Slides by `training-deck-render`.',
  },
  {
    path: '6-qa-and-training/training-deck-render_verdict.yaml',
    producedBy: 'training-deck-render',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: false,
    description: 'Self-emitted verdict from training-deck-render — slide count, image resolution, API success.',
  },
  {
    path: '6-qa-and-training/training-deck-generate-eval_verdict.yaml',
    producedBy: 'training-deck-generate-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: false,
    description: 'Companion-eval verdict for training-deck-generate. Grades module coverage, content concreteness, image ref validity, slide count.',
  },
```

- [ ] **Step 2: Update Phase 6 agent**

In `agents/qa-and-training.md`, update all references:
- Line 19: `training-deck-outline` → `training-deck-generate`
- Line 20: `training-deck-build` → `training-deck-render`
- Line 258: artifact path `training-deck-outline.md` → `training-deck-spec.yaml`
- Line 268: section header mentioning `training-deck-outline` → `training-deck-generate`
- Line 270: `training-deck-build reads training-deck-outline.md` → `training-deck-render reads training-deck-spec.yaml`
- Line 307: file path `training-deck-outline.md` → `training-deck-spec.yaml`
- Line 321: output mapping for `training-deck-build` → `training-deck-render`

- [ ] **Step 3: Update eval skill references if they exist**

Run: `ls skills/training-deck-outline-eval/ 2>/dev/null && echo "EXISTS" || echo "NO EVAL"`

If the eval skill exists, rename it to `training-deck-generate-eval` and update its internal references.

- [ ] **Step 4: Run artifact manifest tests**

Run: `npm test -- test/fixtures/ --reporter verbose`
Expected: Tests may need fixture updates for the renamed artifacts.

- [ ] **Step 5: Verify no remaining references to old skill names**

Run: `grep -rn 'training-deck-outline\|training-deck-build' skills/ agents/ lib/ --include='*.ts' --include='*.md' --include='*.yaml'`
Expected: No matches (except in the design spec and this plan).

- [ ] **Step 6: Commit**

```bash
git add lib/artifact-manifest.ts agents/qa-and-training.md
git add skills/training-deck-generate-eval/ 2>/dev/null
git commit -m "refactor(training-deck): update artifact manifest and Phase 6 agent for spec system"
```

---

### Task 11: Integration Smoke Test

**Files:**
- Create: `test/lib/training-deck-integration.test.ts`

An end-to-end test that generates a spec from YAML, resolves manifest, builds Slides requests, and verifies the output structure.

- [ ] **Step 1: Write integration test**

```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  parseTrainingSpec,
  resolveManifest,
  buildSlidesRequestsV2,
  STENCILS,
  type StencilKey,
} from '../../lib/training-deck-spec.js';

describe('training-deck integration', () => {
  it('generates valid Slides requests from a full spec', () => {
    const specYaml = yaml.dump({
      slug: 'integration-test',
      name: 'Integration Test Opp',
      program: 'Test Program',
      archetype: 'atomic-visit',
      template_id: 'connect-training-atomic',
      generated_at: '2026-05-23T00:00:00Z',
      source: { pdd_doc_id: 'pdd1', run_id: 'run1' },
      manifest: {
        common: {
          'play-store-search': 'drive:common1',
          'commcare-install': 'drive:common2',
          'connect-home': 'drive:common3',
          'claim-opp': 'drive:common4',
        },
        opp: {
          'learn-m1': 'drive:opp1',
          'deliver-form': 'drive:opp2',
        },
      },
      voice: { audience: 'flw', estimated_duration_minutes: 180, language: 'en' },
      modules: [
        {
          id: 'welcome',
          title: 'Welcome',
          slides: [
            { id: 'cover', layout: 'cover', title: 'Test Opp', subtitle: 'Training', date: 'June 2026' },
            { id: 'agenda', layout: 'agenda', title: 'Agenda', items: [
              { label: 'Setup', duration: '60 min' },
              { label: 'Training', duration: '90 min' },
            ]},
          ],
        },
        {
          id: 'setup',
          title: 'Platform Setup',
          common: true,
          slides: [
            { id: 'install', layout: 'mobile_flow', title: 'Install', steps: [
              { image: '@play-store-search', caption: 'Search' },
              { image: '@commcare-install', caption: 'Install' },
              { image: '@connect-home', caption: 'Open' },
              { image: '@claim-opp', caption: 'Claim' },
            ]},
          ],
        },
        {
          id: 'opp',
          title: 'Your Opportunity',
          slides: [
            { id: 'mission', layout: 'content', title: 'What You Do', body: 'Collect samples.' },
            { id: 'targets', layout: 'stats', title: 'Targets', stats: [
              { big: '5', label: 'visits/day' },
              { big: '$23', label: 'per sample' },
            ]},
            { id: 'screen', layout: 'walkthrough', title: 'The Form', image: '@deliver-form', body: '1. Open form\n2. Fill data' },
          ],
        },
        {
          id: 'eval',
          title: 'Evaluation',
          slides: [
            { id: 'ready', layout: 'checklist', title: 'Ready?', items: ['Learn done', 'Form practiced'] },
            { id: 'timeline', layout: 'timeline', title: 'Next', steps: [
              { label: 'Today', detail: 'Training' },
              { label: 'Monday', detail: 'Go live' },
            ]},
          ],
        },
        {
          id: 'close',
          title: 'Resources',
          slides: [
            { id: 'closing', layout: 'closing', title: 'Thank You', body: 'Good luck!' },
          ],
        },
      ],
    });

    const spec = parseTrainingSpec(specYaml);
    expect(spec.modules).toHaveLength(5);

    const totalSlides = spec.modules.reduce((sum, m) => sum + m.slides.length, 0);
    expect(totalSlides).toBe(9);

    const manifest = resolveManifest(spec.manifest);
    const stencilMap = Object.fromEntries(
      Object.entries(STENCILS).map(([k, v]) => [k, v]),
    ) as Record<StencilKey, string>;

    const requests = buildSlidesRequestsV2(spec, { stencils: stencilMap, manifest });

    // Should have: 9 duplicateObject + per-slide replacements + 14 deleteObject
    const duplicates = requests.filter((r: any) => r.duplicateObject);
    expect(duplicates).toHaveLength(9);

    const deletes = requests.filter((r: any) => r.deleteObject);
    expect(deletes).toHaveLength(14);

    // mobile_flow slide should produce 4 createImage
    const images = requests.filter((r: any) => r.createImage);
    expect(images.length).toBeGreaterThanOrEqual(5); // 4 from mobile_flow + 1 from walkthrough

    // Verify image URLs resolve correctly
    const walkImg = images.find((r: any) => r.createImage.url.includes('opp2'));
    expect(walkImg).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npm test -- test/lib/training-deck-integration.test.ts --reporter verbose`
Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run: `npm test --reporter verbose`
Expected: ALL pass.

- [ ] **Step 4: Commit**

```bash
git add test/lib/training-deck-integration.test.ts
git commit -m "test(training-deck): add integration smoke test for spec → requests pipeline"
```

---

## Summary

| Task | What | Files | Depends On |
|------|------|-------|-----------|
| 1 | Zod schema + parseTrainingSpec | lib/training-deck-spec.ts, test/ | — |
| 2 | Manifest resolver | lib/training-deck-spec.ts, test/ | Task 1 |
| 3 | Builder v2 (14 layouts) | lib/training-deck-spec.ts, test/ | Tasks 1, 2 |
| 4 | Remove legacy markdown code | lib/training-deck-spec.ts, test/ | Task 3 |
| 5 | Bootstrap script (14 stencils) | scripts/bootstrap-training-deck-template.ts | Task 3 |
| 6 | Template bundles | templates/training-deck/ | — |
| 7 | Generate skill | skills/training-deck-generate/ | Tasks 1, 6 |
| 8 | Render skill | skills/training-deck-render/ | Tasks 3, 5 |
| 9 | Common screenshot skill | skills/common-screenshot-capture/ | — |
| 10 | Artifact manifest + agent | lib/artifact-manifest.ts, agents/ | Tasks 7, 8 |
| 11 | Integration test | test/lib/ | Tasks 1-4 |

**Parallelizable:** Tasks 5, 6, 9 can run in parallel with Tasks 1-4. Tasks 7 and 8 can run in parallel after their deps complete.
