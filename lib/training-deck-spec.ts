// ============================================================================
// Training Deck Spec — Zod schemas, YAML parser, manifest resolver, builder
// ============================================================================
//
// YAML-based structured slide spec with 14 discriminated-union layout
// variants, module grouping, manifest references, and voice metadata.

import { z } from 'zod';
import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Individual slide layout schemas
// ---------------------------------------------------------------------------

export const CoverSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('cover'),
  title: z.string(),
  subtitle: z.string().optional(),
  date: z.string().optional(),
});

export const SectionSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('section'),
  title: z.string(),
});

export const AgendaSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('agenda'),
  title: z.string(),
  items: z.array(z.object({ label: z.string(), duration: z.string() })),
});

export const ContentSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('content'),
  title: z.string(),
  body: z.string(),
});

export const WalkthroughSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('walkthrough'),
  title: z.string(),
  image: z.string(),
  body: z.string(),
});

export const MobileFlowSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('mobile_flow'),
  title: z.string(),
  steps: z.array(z.object({ image: z.string(), caption: z.string() })).min(2).max(4),
});

export const WebScreenSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('web_screen'),
  title: z.string(),
  image: z.string(),
  caption: z.string().optional(),
});

export const MobileZoomSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('mobile_zoom'),
  title: z.string(),
  image: z.string(),
  callouts: z.array(z.string()).optional(),
});

export const TwoColumnSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('two_column'),
  title: z.string(),
  left: z.object({ heading: z.string(), body: z.string(), image: z.string().optional() }),
  right: z.object({ heading: z.string(), body: z.string(), image: z.string().optional() }),
});

export const StatsSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('stats'),
  title: z.string(),
  stats: z.array(z.object({ big: z.string(), label: z.string() })).min(1).max(3),
});

export const TimelineSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('timeline'),
  title: z.string(),
  steps: z.array(z.object({ label: z.string(), detail: z.string() })).min(2).max(5),
});

export const ChecklistSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('checklist'),
  title: z.string(),
  items: z.array(z.string()),
});

export const ExerciseSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('exercise'),
  title: z.string(),
  duration: z.string(),
  body: z.string(),
});

export const ClosingSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('closing'),
  title: z.string(),
  body: z.string(),
});

// ---------------------------------------------------------------------------
// Discriminated union of all slide layouts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Module + top-level spec
// ---------------------------------------------------------------------------

export const ModuleSpecSchema = z.object({
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
    common: z.record(z.string(), z.string()).optional(),
    opp: z.record(z.string(), z.string()).optional(),
  }),
  voice: z.object({
    audience: z.enum(['flw', 'llo', 'mixed']),
    estimated_duration_minutes: z.number(),
    language: z.string(),
  }),
  modules: z.array(ModuleSpecSchema),
});

export type TrainingDeckSpec = z.infer<typeof TrainingDeckSpecSchema>;

// ---------------------------------------------------------------------------
// YAML parser
// ---------------------------------------------------------------------------

/**
 * Parse a YAML string into a validated `TrainingDeckSpec`.
 * Throws a `ZodError` if validation fails.
 */
export function parseTrainingSpec(yamlStr: string): TrainingDeckSpec {
  const raw = yaml.load(yamlStr);
  return TrainingDeckSpecSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Manifest resolver — merges common + opp entries, resolves @alias image refs
// ---------------------------------------------------------------------------

/**
 * A resolved manifest that supports raw alias lookups and `@alias` image
 * reference resolution (converting `drive:<fileId>` to a public-view URL).
 */
export interface ResolvedManifest {
  /** Raw lookup by alias key. Returns undefined if the alias is not in the manifest. */
  get(alias: string): string | undefined;

  /**
   * Resolve an image reference to a usable URL.
   *
   * - `https://...` — returned as-is (passthrough)
   * - `@alias` — strips the `@`, looks up the alias in the merged manifest:
   *   - `drive:<fileId>` values are converted to `https://drive.google.com/uc?export=view&id=<fileId>`
   *   - all other values are returned as-is
   * - Throws if the alias is not found in the manifest.
   */
  resolveImageRef(ref: string): string;
}

/**
 * Merge `manifest.common` and `manifest.opp` into a single `ResolvedManifest`.
 * Opp entries win on key collision.
 */
export function resolveManifest(manifest: {
  common?: Record<string, string>;
  opp?: Record<string, string>;
}): ResolvedManifest {
  const merged = new Map<string, string>();

  // Common entries first — opp entries overwrite on collision.
  if (manifest.common) {
    for (const [key, value] of Object.entries(manifest.common)) {
      merged.set(key, value);
    }
  }
  if (manifest.opp) {
    for (const [key, value] of Object.entries(manifest.opp)) {
      merged.set(key, value);
    }
  }

  return {
    get(alias: string): string | undefined {
      return merged.get(alias);
    },

    resolveImageRef(ref: string): string {
      // HTTPS URLs pass through unchanged.
      if (ref.startsWith('https://')) {
        return ref;
      }

      // @alias references: strip the prefix, look up, resolve.
      if (ref.startsWith('@')) {
        const alias = ref.slice(1);
        const value = merged.get(alias);
        if (value === undefined) {
          throw new Error(
            `resolveImageRef: unresolvable alias "@${alias}" — not found in manifest`,
          );
        }
        if (value.startsWith('drive:')) {
          const fileId = value.slice('drive:'.length);
          return `https://drive.google.com/uc?export=view&id=${fileId}`;
        }
        return value;
      }

      // Fallback: return as-is (bare URLs, relative paths, etc.).
      return ref;
    },
  };
}

// ---------------------------------------------------------------------------
// V2 stencil constants + builder
// ---------------------------------------------------------------------------

export const STENCILS = {
  cover: 'ace_stencil_cover',
  section: 'ace_stencil_section',
  agenda: 'ace_stencil_agenda',
  content: 'ace_stencil_content_v2',
  walkthrough: 'ace_stencil_walkthrough',
  mobile_flow: 'ace_stencil_mobile_flow',
  web_screen: 'ace_stencil_web_screen',
  mobile_zoom: 'ace_stencil_mobile_zoom',
  two_column: 'ace_stencil_two_column',
  stats: 'ace_stencil_stats',
  timeline: 'ace_stencil_timeline',
  checklist: 'ace_stencil_checklist',
  exercise: 'ace_stencil_exercise',
  closing: 'ace_stencil_closing',
} as const;
export type StencilKey = keyof typeof STENCILS;

export interface BuildOptsV2 {
  stencils: Record<StencilKey, string>;
  manifest: ResolvedManifest;
}

// ---------------------------------------------------------------------------
// Internal helpers for the v2 builder
// ---------------------------------------------------------------------------

function replaceAllTextV2(
  token: string,
  value: string,
  pageIds: string[],
): Record<string, unknown> {
  return {
    replaceAllText: {
      containsText: { text: token, matchCase: true },
      replaceText: value,
      pageObjectIds: pageIds,
    },
  };
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

function buildLayoutRequests(
  slide: SlideSpec_v2,
  pageId: string,
  manifest: ResolvedManifest,
): Array<Record<string, unknown>> {
  const reqs: Array<Record<string, unknown>> = [];
  const r = (token: string, value: string) =>
    reqs.push(replaceAllTextV2(token, value, [pageId]));

  // All layouts get title
  r('{{TITLE}}', slide.title);

  switch (slide.layout) {
    case 'cover':
      r('{{SUBTITLE}}', slide.subtitle ?? '');
      r('{{DATE}}', slide.date ?? '');
      break;
    case 'section':
      // Title only — nothing extra
      break;
    case 'agenda':
      r(
        '{{BODY}}',
        slide.items.map((i) => `${i.label}  —  ${i.duration}`).join('\n'),
      );
      break;
    case 'content':
      r('{{BODY}}', slide.body);
      break;
    case 'walkthrough':
      r('{{BODY}}', slide.body);
      reqs.push(
        createImage(
          `${pageId}_img_0`,
          pageId,
          manifest.resolveImageRef(slide.image),
          { x: 4572000, y: 914400, w: 4114800, h: 3771900 },
        ),
      );
      break;
    case 'mobile_flow': {
      const phoneWidth = 1828800;
      const phoneGap = 228600;
      const phoneHeight = 3200400;
      const phoneY = 914400;
      const totalSteps = slide.steps.length;
      const groupWidth =
        totalSteps * phoneWidth + (totalSteps - 1) * phoneGap;
      const slideWidth = 9144000;
      const startX = (slideWidth - groupWidth) / 2;

      for (let i = 0; i < 4; i++) {
        if (i < totalSteps) {
          r(`{{STEP_${i}_CAPTION}}`, slide.steps[i].caption);
          const x = startX + i * (phoneWidth + phoneGap);
          reqs.push(
            createImage(
              `${pageId}_img_${i}`,
              pageId,
              manifest.resolveImageRef(slide.steps[i].image),
              { x, y: phoneY, w: phoneWidth, h: phoneHeight },
            ),
          );
        } else {
          r(`{{STEP_${i}_CAPTION}}`, '');
        }
      }
      break;
    }
    case 'web_screen':
      r('{{CAPTION}}', slide.caption ?? '');
      reqs.push(
        createImage(
          `${pageId}_img_0`,
          pageId,
          manifest.resolveImageRef(slide.image),
          { x: 457200, y: 1143000, w: 8229600, h: 3429000 },
        ),
      );
      break;
    case 'mobile_zoom':
      r(
        '{{CALLOUTS}}',
        (slide.callouts ?? []).map((c) => `• ${c}`).join('\n'),
      );
      reqs.push(
        createImage(
          `${pageId}_img_0`,
          pageId,
          manifest.resolveImageRef(slide.image),
          { x: 2286000, y: 685800, w: 2743200, h: 4000500 },
        ),
      );
      break;
    case 'two_column':
      r('{{LEFT_HEADING}}', slide.left.heading);
      r('{{LEFT_BODY}}', slide.left.body);
      r('{{RIGHT_HEADING}}', slide.right.heading);
      r('{{RIGHT_BODY}}', slide.right.body);
      if (slide.left.image) {
        reqs.push(
          createImage(
            `${pageId}_img_left`,
            pageId,
            manifest.resolveImageRef(slide.left.image),
            { x: 457200, y: 2743200, w: 3886200, h: 1943100 },
          ),
        );
      }
      if (slide.right.image) {
        reqs.push(
          createImage(
            `${pageId}_img_right`,
            pageId,
            manifest.resolveImageRef(slide.right.image),
            { x: 4800600, y: 2743200, w: 3886200, h: 1943100 },
          ),
        );
      }
      break;
    case 'stats':
      for (let i = 0; i < 3; i++) {
        if (i < slide.stats.length) {
          r(`{{STAT${i + 1}}}`, slide.stats[i].big);
          r(`{{STAT${i + 1}_LABEL}}`, slide.stats[i].label);
        } else {
          r(`{{STAT${i + 1}}}`, '');
          r(`{{STAT${i + 1}_LABEL}}`, '');
        }
      }
      break;
    case 'timeline':
      for (let i = 0; i < 5; i++) {
        if (i < slide.steps.length) {
          r(`{{STEP${i + 1}_LABEL}}`, slide.steps[i].label);
          r(`{{STEP${i + 1}_DETAIL}}`, slide.steps[i].detail);
        } else {
          r(`{{STEP${i + 1}_LABEL}}`, '');
          r(`{{STEP${i + 1}_DETAIL}}`, '');
        }
      }
      break;
    case 'checklist':
      r('{{BODY}}', slide.items.map((item) => `☐ ${item}`).join('\n'));
      break;
    case 'exercise':
      r('{{DURATION}}', slide.duration);
      r('{{BODY}}', slide.body);
      break;
    case 'closing':
      r('{{BODY}}', slide.body);
      break;
  }

  return reqs;
}

/**
 * Build Slides API `batchUpdate` requests from a v2 `TrainingDeckSpec`.
 *
 * For each module → each slide: duplicates the matching stencil, emits
 * layout-specific `replaceAllText` and `createImage` requests. After all
 * slides, emits `deleteObject` for all 14 stencils.
 */
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
      const stencilKey = slide.layout as StencilKey;
      const stencilId = opts.stencils[stencilKey];
      if (!stencilId) {
        throw new Error(
          `buildSlidesRequestsV2: no matching stencil for layout "${slide.layout}"`,
        );
      }

      // Duplicate the stencil slide
      requests.push({
        duplicateObject: {
          objectId: stencilId,
          objectIds: { [stencilId]: newSlideId },
        },
      });

      // Emit layout-specific replacements and images
      requests.push(
        ...buildLayoutRequests(slide, newSlideId, opts.manifest),
      );
    }
  }

  // Reorder slides: duplicateObject inserts each duplicate adjacent to its
  // source stencil, so slides from different stencils interleave randomly.
  // Move each slide to its correct sequential position (after all stencils).
  const stencilCount = Object.keys(STENCILS).length;
  for (let i = 0; i < slideCounter; i++) {
    requests.push({
      updateSlidesPosition: {
        slideObjectIds: [`ace_slide_${i + 1}`],
        insertionIndex: stencilCount + i,
      },
    });
  }

  // Delete all 14 stencils
  for (const stencilId of Object.values(STENCILS)) {
    requests.push({ deleteObject: { objectId: stencilId } });
  }

  return requests;
}
