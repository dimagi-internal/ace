// ============================================================================
// Training Deck Spec — Zod schemas, YAML parser, manifest resolver, builder
// ============================================================================
//
// YAML-based structured slide spec with 14 discriminated-union layout
// variants, module grouping, manifest references, and voice metadata.

import { z } from 'zod';
import yaml from 'js-yaml';
// Shared stencil geometry (lib/training-deck-stencil-geometry.ts — the
// single source of stencil text-box geometry). The mobile_flow branch
// derives its programmatic caption boxes from these so the N=4 output
// matches the stencil grid. Safe to import VALUES here: geometry imports
// only a TYPE (StencilKey) from this module, so `import type` erasure
// means there is no runtime circular import.
import {
  FONT_FAMILY,
  COLOR_GRAY,
  SLIDE_W,
  SLIDE_H,
  MARGIN,
} from './training-deck-stencil-geometry.js';

// ---------------------------------------------------------------------------
// Individual slide layout schemas
// ---------------------------------------------------------------------------

// Speaker notes are optional but recommended on every slide — the
// facilitator-facing layer that turns a self-contained deck into a
// trainable one. Talking points, timing cues, transitions, fallback
// prompts for activities, knowledge-check answers. Rendered into each
// stencil's `<id>:notes` object via Slides insertText.
//
// Pre-2026-05-25 reality: notes field didn't exist on slide schemas;
// every rendered deck had zero speaker notes (unfacilitatable). The
// malaria-rdt deck shipped this way and was the largest content-quality
// complaint from the first end-to-end review.

export const CoverSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('cover'),
  title: z.string(),
  subtitle: z.string().optional(),
  date: z.string().optional(),
  notes: z.string().optional(),
});

export const SectionSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('section'),
  title: z.string(),
  notes: z.string().optional(),
});

export const AgendaSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('agenda'),
  title: z.string(),
  items: z.array(z.object({ label: z.string(), duration: z.string() })),
  notes: z.string().optional(),
});

export const ContentSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('content'),
  title: z.string(),
  body: z.string(),
  notes: z.string().optional(),
});

export const WalkthroughSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('walkthrough'),
  title: z.string(),
  image: z.string(),
  body: z.string(),
  notes: z.string().optional(),
});

export const MobileFlowSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('mobile_flow'),
  title: z.string(),
  steps: z.array(z.object({ image: z.string(), caption: z.string() })).min(2).max(4),
  notes: z.string().optional(),
});

export const WebScreenSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('web_screen'),
  title: z.string(),
  image: z.string(),
  caption: z.string().optional(),
  notes: z.string().optional(),
});

export const MobileZoomSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('mobile_zoom'),
  title: z.string(),
  image: z.string(),
  callouts: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export const TwoColumnSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('two_column'),
  title: z.string(),
  left: z.object({ heading: z.string(), body: z.string(), image: z.string().optional() }),
  right: z.object({ heading: z.string(), body: z.string(), image: z.string().optional() }),
  notes: z.string().optional(),
});

export const StatsSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('stats'),
  title: z.string(),
  stats: z.array(z.object({ big: z.string(), label: z.string() })).min(1).max(3),
  notes: z.string().optional(),
});

export const TimelineSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('timeline'),
  title: z.string(),
  steps: z.array(z.object({ label: z.string(), detail: z.string() })).min(2).max(5),
  notes: z.string().optional(),
});

export const ChecklistSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('checklist'),
  title: z.string(),
  items: z.array(z.string()),
  notes: z.string().optional(),
});

export const ExerciseSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('exercise'),
  title: z.string(),
  duration: z.string(),
  body: z.string(),
  notes: z.string().optional(),
});

export const ClosingSlideSchema = z.object({
  id: z.string(),
  layout: z.literal('closing'),
  title: z.string(),
  body: z.string(),
  notes: z.string().optional(),
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

/**
 * A module that defers its content to a shared template file at
 * `templates/training-deck/_common/<ref>.yaml`. Resolved by
 * `resolveModuleRefs()` before render time. The `id` is the in-spec
 * identifier (lets the spec name the slot independently of the
 * underlying template); `overrides` substitutes `{{KEY}}` tokens
 * embedded in the referenced template's text fields.
 */
export const RefModuleSchema = z.object({
  id: z.string(),
  ref: z.string(),
  overrides: z.record(z.string(), z.string()).optional(),
});

export type RefModule = z.infer<typeof RefModuleSchema>;

/**
 * Pre-resolution module type — either inline or ref-based. After
 * `resolveModuleRefs()` runs, every module is a `ModuleSpec`.
 */
export const AnyModuleSchema = z.union([RefModuleSchema, ModuleSpecSchema]);
export type AnyModule = z.infer<typeof AnyModuleSchema>;

/**
 * Fully-expanded training-deck spec — every module has inline `slides[]`
 * (no `ref` modules remain). This is what the render skill consumes.
 */
export const TrainingDeckSpecSchema = z.object({
  slug: z.string(),
  name: z.string(),
  program: z.string(),
  archetype: z.enum(['atomic-visit', 'focus-group', 'multi-stage', 'partnership-pitch']),
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
    audience: z.enum(['flw', 'llo', 'mixed', 'prospect']),
    estimated_duration_minutes: z.number(),
    language: z.string(),
  }),
  modules: z.array(ModuleSpecSchema),
});

export type TrainingDeckSpec = z.infer<typeof TrainingDeckSpecSchema>;

/**
 * Pre-resolution spec — modules may still be `ref`-style. Generate skill
 * emits this, then calls `resolveModuleRefs` to produce TrainingDeckSpec.
 */
export const UnexpandedTrainingDeckSpecSchema = TrainingDeckSpecSchema.extend({
  modules: z.array(AnyModuleSchema),
});

export type UnexpandedTrainingDeckSpec = z.infer<typeof UnexpandedTrainingDeckSpecSchema>;

// ---------------------------------------------------------------------------
// YAML parser
// ---------------------------------------------------------------------------

/**
 * Parse a YAML string into a validated `TrainingDeckSpec` (fully
 * expanded — no `ref` modules). Use AFTER `resolveModuleRefs()` has
 * inlined any ref modules.
 */
export function parseTrainingSpec(yamlStr: string): TrainingDeckSpec {
  const raw = yaml.load(yamlStr);
  return TrainingDeckSpecSchema.parse(raw);
}

/**
 * Parse a YAML string into a validated `UnexpandedTrainingDeckSpec` —
 * may contain `ref` modules awaiting expansion. Pipe through
 * `resolveModuleRefs` before passing to `buildSlidesRequestsV2`.
 */
export function parseUnexpandedTrainingSpec(yamlStr: string): UnexpandedTrainingDeckSpec {
  const raw = yaml.load(yamlStr);
  return UnexpandedTrainingDeckSpecSchema.parse(raw);
}

/**
 * Resolve all `ref` modules in a spec by loading the referenced
 * template YAML files and inlining their content. Each `RefModule`
 * becomes a `ModuleSpec` carrying the template's slides[] with any
 * `{{KEY}}` tokens substituted from the module's `overrides` map.
 *
 * - `ref: _common/platform-setup` → loads `_common/platform-setup`
 * - Module `id` from the spec wins over the template's `id`
 * - Inline modules pass through unchanged
 *
 * Override substitution is plain `{{KEY}}` → value text replacement,
 * applied recursively across every string field. Unknown tokens are
 * left in place (caller can grep for them).
 *
 * @param spec - pre-resolution spec (may contain `ref` modules)
 * @param loadModule - async loader returning YAML text for a given
 *   ref path. Async so callers can plug in fs-based loading (tests,
 *   scripts) OR Drive-backed loading (skill runtime).
 * @returns fully-expanded `TrainingDeckSpec`
 */
export async function resolveModuleRefs(
  spec: UnexpandedTrainingDeckSpec,
  loadModule: (refPath: string) => Promise<string>,
): Promise<TrainingDeckSpec> {
  const expandedModules: ModuleSpec[] = [];

  for (const m of spec.modules) {
    if ('ref' in m && typeof m.ref === 'string') {
      const refModule = m as RefModule;
      const templateYaml = await loadModule(refModule.ref);
      const loaded = yaml.load(templateYaml) as Record<string, unknown>;

      const overrides = refModule.overrides ?? {};
      const substituted = substituteOverrides(loaded, overrides) as Record<string, unknown>;

      const merged: ModuleSpec = ModuleSpecSchema.parse({
        ...substituted,
        id: refModule.id,
      });
      expandedModules.push(merged);
    } else {
      expandedModules.push(ModuleSpecSchema.parse(m));
    }
  }

  return TrainingDeckSpecSchema.parse({
    ...spec,
    modules: expandedModules,
  });
}

/**
 * Recursively substitute `{{KEY}}` tokens in every string leaf of a
 * plain-object / array tree. Unknown tokens (no matching key) are
 * left as-is for the caller to flag.
 */
function substituteOverrides(
  value: unknown,
  overrides: Record<string, string>,
): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      const sub = overrides[key];
      return sub !== undefined ? sub : match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteOverrides(v, overrides));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteOverrides(v, overrides);
    }
    return out;
  }
  return value;
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
 * Normalize any Google Drive image URL to the embeddable
 * `uc?export=view&id=<id>` form that the Slides API's `createImage`
 * accepts. Non-Drive URLs pass through unchanged.
 *
 * Slides `createImage` REJECTS the share/view URL shapes Drive hands
 * back from `webViewLink` / the file picker — `…/file/d/<id>/view`,
 * `…/file/d/<id>/edit`, `…/open?id=<id>` — with an "invalid image URL"
 * error. Only the `uc?export=view&id=<id>` (and `…/uc?id=<id>`) form
 * loads. Before this, `resolveImageRef` only produced the right form
 * from the `drive:<id>` alias-prefix path; a raw Drive https URL in a
 * manifest value or `slide.image` passed straight through and the deck
 * render failed. (jjackson/ace#630)
 *
 * Idempotent: a `uc?export=view&id=<id>` input re-extracts the same id
 * and rebuilds the same URL.
 */
export function normalizeDriveImageUrl(url: string): string {
  // Only touch Google Drive/Docs hosted URLs; everything else is left as-is.
  if (!/(?:drive|docs)\.google\.com/.test(url)) return url;
  // Forms: /file/d/<id>/{view,edit,preview} ; ?id=<id> / &id=<id> (open?id=, uc?id=, uc?export=view&id=)
  let m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (!m) return url; // unrecognized Drive URL shape — leave untouched
  return `https://drive.google.com/uc?export=view&id=${m[1]}`;
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
      // HTTPS URLs pass through — but rewrite Drive share/view URLs to
      // the createImage-embeddable form first (#630).
      if (ref.startsWith('https://')) {
        return normalizeDriveImageUrl(ref);
      }

      // Direct `drive:<fileId>` reference (a slide.image set straight to
      // the alias VALUE, not via `@alias`). Without this, it falls to the
      // bare-ref fallback below, where normalizeDriveImageUrl doesn't
      // recognize the `drive:` scheme (no `drive.google.com` host) and
      // returns it unchanged — so the literal `drive:<id>` reaches the
      // Slides API `createImage`, which rejects it. (jjackson/ace#724)
      if (ref.startsWith('drive:')) {
        const fileId = ref.slice('drive:'.length);
        return `https://drive.google.com/uc?export=view&id=${fileId}`;
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
        // A manifest value may itself be a raw Drive share/view URL —
        // normalize it the same way (#630).
        return normalizeDriveImageUrl(value);
      }

      // Fallback: bare URLs / relative paths. Still normalize a bare
      // Drive URL; non-Drive refs pass through.
      return normalizeDriveImageUrl(ref);
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

// Caption styling mirrors the stencil's caption boxes
// (lib/training-deck-stencil-geometry.ts § buildMobileFlowTextBoxes):
// Work Sans 11pt, gray #5F6A7D, left-aligned. Font family + color come
// straight from the geometry module; 11pt matches the stencil builder's
// caption fontSize.
const CAPTION_FONT_SIZE_PT = 11;

/**
 * Create a styled caption text box at an explicit position. Used by
 * mobile_flow instead of the stencil's four FIXED caption boxes: the stencil
 * grid was laid out for the 4-phone case, but the builder centers N phones
 * dynamically — at N<4 the fixed boxes drift up to ~82pt left of their
 * phones (at N=2 the second caption sat under the FIRST phone; caught by
 * operator review of hh-poverty-targeting/20260702-1456 slides 26+28).
 * The builder now blanks the stencil boxes and creates these instead,
 * centered under each phone.
 */
function createCaptionBox(
  objectId: string,
  pageObjectId: string,
  text: string,
  pos: { x: number; y: number; w: number; h: number },
): Array<Record<string, unknown>> {
  return [
    {
      createShape: {
        objectId,
        shapeType: 'TEXT_BOX',
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
      },
    },
    { insertText: { objectId, text, insertionIndex: 0 } },
    {
      updateTextStyle: {
        objectId,
        textRange: { type: 'ALL' },
        style: {
          fontSize: { magnitude: CAPTION_FONT_SIZE_PT, unit: 'PT' },
          fontFamily: FONT_FAMILY,
          foregroundColor: { opaqueColor: { rgbColor: COLOR_GRAY } },
        },
        fields: 'fontSize,fontFamily,foregroundColor',
      },
    },
  ];
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
      // Prefix each item with a bullet marker (•) and keep "label  —  duration"
      // — v5.3 fix; previously rendered as flat lines with no visual hierarchy.
      r(
        '{{BODY}}',
        slide.items.map((i) => `•  ${i.label}  —  ${i.duration}`).join('\n'),
      );
      break;
    case 'content':
      r('{{BODY}}', slide.body);
      break;
    case 'walkthrough':
      r('{{BODY}}', slide.body);
      // v5.3 walkthrough geometry: body widened to ~45% (vs 35% in v5.2)
      // so longer body sentences don't wrap mid-phrase. Image area
      // correspondingly starts at 45% from left and is 50% wide.
      reqs.push(
        createImage(
          `${pageId}_img_0`,
          pageId,
          manifest.resolveImageRef(slide.image),
          { x: 4343400, y: 457200, w: 4343400, h: 4229100 },
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
      const startX = (SLIDE_W - groupWidth) / 2;
      // Captions are created programmatically, centered under each phone —
      // the stencil's four fixed caption boxes only line up at N=4, so they
      // are blanked below and never receive text. Same width/y as the
      // stencil boxes (buildMobileFlowTextBoxes in the geometry module) so
      // the N=4 output is visually unchanged.
      const captionW =
        Math.round((SLIDE_W - MARGIN * 2) / 4) - 50_000;
      const captionY = SLIDE_H - 700_000;

      for (let i = 0; i < 4; i++) {
        // Blank ALL stencil caption tokens regardless of step count.
        r(`{{STEP_${i}_CAPTION}}`, '');
        if (i < totalSteps) {
          const x = startX + i * (phoneWidth + phoneGap);
          reqs.push(
            createImage(
              `${pageId}_img_${i}`,
              pageId,
              manifest.resolveImageRef(slide.steps[i].image),
              { x, y: phoneY, w: phoneWidth, h: phoneHeight },
            ),
          );
          reqs.push(
            ...createCaptionBox(
              `${pageId}_cap_${i}`,
              pageId,
              slide.steps[i].caption,
              {
                x: Math.round(x + (phoneWidth - captionW) / 2),
                y: captionY,
                w: captionW,
                h: 500000,
              },
            ),
          );
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

  // Speaker notes — fill any {{NOTES}} placeholder in the duplicated
  // slide's notes page. Each stencil's notes page is auto-created by
  // Slides at `<stencilId>:notes` and the duplicate inherits the
  // `<newSlideId>:notes` ID via duplicateObject's child remapping.
  //
  // For this to actually surface notes in the rendered deck, the
  // template stencils must have `{{NOTES}}` as placeholder text in
  // their notes page body. The bootstrap script that creates the
  // stencils SHOULD add this — tracked separately as part of the
  // template rebrand work (task #31). Until that lands, this request
  // is a no-op (replaceAllText silently matches nothing) and
  // `slide.notes` is effectively dropped at render time. Schema
  // validation still accepts `notes` so generation can populate it
  // without breaking — the renderer side catches up when the bootstrap
  // is updated.
  if (slide.notes !== undefined && slide.notes !== '') {
    reqs.push(replaceAllTextV2('{{NOTES}}', slide.notes, [`${pageId}:notes`]));
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
