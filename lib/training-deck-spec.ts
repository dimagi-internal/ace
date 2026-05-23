// ============================================================================
// YAML-based Training Deck Spec (v2) — Zod schemas + parser
// ============================================================================
//
// Added alongside the original markdown-based DeckSpec. Both coexist until
// a later migration removes the markdown path. The YAML spec adds structured
// slide layouts (14 discriminated-union variants), module grouping, manifest
// references, and voice metadata.

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

// ============================================================================
// Original markdown-based DeckSpec (v1) — preserved below
// ============================================================================

/**
 * Pure helper: turn a `training-deck-outline.md` file into a sequence of
 * Google Slides API `batchUpdate` requests.
 *
 * The skill `training-deck-build` (Phase 6 follow-up to `training-materials`)
 * uses this module to:
 *   1. Parse the deck-outline markdown emitted by `training-materials`
 *   2. Resolve referenced screenshot paths against the per-opp +
 *      `_common/connect-screenshots` manifests
 *   3. Build the Slides batchUpdate request array
 *
 * Why a separate module: the parse + request-build step is a pure
 * data-transformation that's worth a) unit-testable in isolation and
 * b) reusable from other skills (e.g., a future `qa-deck-build` for the
 * UAT walkthrough). Keep this file free of network or filesystem I/O —
 * the orchestrating skill handles those concerns.
 *
 * The deck-outline markdown contract (single source of truth for both
 * `training-materials` emit and `training-deck-build` parse):
 *
 * ```markdown
 * # <Deck Title>
 *
 * <optional subtitle text on the title slide>
 *
 * ---
 *
 * ## Slide: <slide title>
 *
 * <body content — bullet list, paragraph, or both>
 *
 * - bullet one
 * - bullet two
 *
 * ![alt text](drive:fileId)        # via Drive fileId — preferred
 * ![alt text](https://...)         # via HTTPS URL — also OK
 *
 * > Speaker notes: <what the presenter says aloud>
 *
 * ---
 *
 * ## Slide: <next title>
 * ...
 * ```
 *
 * Sections are separated by `---`. Image references support either Drive
 * fileIds (recommended — Slides resolves these via SA auth) or arbitrary
 * HTTPS URLs (works for public images). Speaker notes use the standard
 * Markdown blockquote prefix `> `; the skill strips the `Speaker notes:`
 * prefix on parse for cleanliness in the deck.
 */

export interface DeckSpec {
  /** Title of the deck (extracted from the leading `# ` heading). */
  title: string;
  /** Optional subtitle text rendered on the title slide. */
  subtitle?: string;
  /** All non-title slides, in order. */
  slides: SlideSpec[];
}

export interface SlideSpec {
  title: string;
  body: BodyBlock[];
  /** Speaker notes shown in presenter view. */
  speakerNotes?: string;
}

export type BodyBlock =
  | { kind: 'bullets'; items: string[] }
  | { kind: 'paragraph'; text: string }
  | { kind: 'image'; alt: string; ref: ImageRef };

export type ImageRef =
  | { kind: 'driveFileId'; fileId: string }
  | { kind: 'url'; url: string };

/**
 * Parse a `training-deck-outline.md` body into the structured shape above.
 *
 * Strict-but-friendly: rejects malformed input (no leading `# Title`,
 * a slide section without `## Slide:`) so producers can't silently emit
 * a deck with missing slides. Empty body sections become an empty
 * `slides[N].body` array — that's a valid section-divider slide.
 */
export function parseDeckOutline(markdown: string): DeckSpec {
  const lines = markdown.split('\n');

  // Section split on `---` separator lines (must be on their own line).
  const sections: string[][] = [[]];
  for (const line of lines) {
    if (/^---\s*$/.test(line)) {
      sections.push([]);
    } else {
      sections[sections.length - 1].push(line);
    }
  }

  // First section is the title block: `# Title` + optional subtitle paragraph.
  const titleSection = sections.shift() ?? [];
  const titleLine = titleSection.find((l) => /^#\s+/.test(l));
  if (!titleLine) {
    throw new Error('parseDeckOutline: missing leading "# Title" heading');
  }
  const title = titleLine.replace(/^#\s+/, '').trim();

  const titleHeadingIdx = titleSection.indexOf(titleLine);
  const subtitle = titleSection
    .slice(titleHeadingIdx + 1)
    .join('\n')
    .trim() || undefined;

  const slides: SlideSpec[] = [];
  for (const section of sections) {
    const bodyText = section.join('\n').trim();
    if (!bodyText) continue;
    const slide = parseSlide(section);
    if (slide) slides.push(slide);
  }

  return { title, subtitle, slides };
}

function parseSlide(sectionLines: string[]): SlideSpec | null {
  // Drop leading blank lines.
  let i = 0;
  while (i < sectionLines.length && sectionLines[i].trim() === '') i++;
  if (i >= sectionLines.length) return null;

  const headingMatch = sectionLines[i].match(/^##\s+Slide:\s*(.+?)\s*$/);
  if (!headingMatch) {
    throw new Error(
      `parseDeckOutline: section does not start with "## Slide: <title>": got "${sectionLines[i]}"`,
    );
  }
  const title = headingMatch[1];
  i++;

  const body: BodyBlock[] = [];
  let pendingBullets: string[] = [];
  let pendingParagraph: string[] = [];
  let speakerNotes: string | undefined;

  const flushParagraph = () => {
    if (pendingParagraph.length) {
      body.push({ kind: 'paragraph', text: pendingParagraph.join(' ').trim() });
      pendingParagraph = [];
    }
  };
  const flushBullets = () => {
    if (pendingBullets.length) {
      body.push({ kind: 'bullets', items: pendingBullets });
      pendingBullets = [];
    }
  };

  while (i < sectionLines.length) {
    const line = sectionLines[i];
    const trimmed = line.trim();

    // Blank line: closes any pending paragraph but doesn't close bullets
    // (bullet lists may have blank lines between items in some markdown
    // dialects).
    if (trimmed === '') {
      flushParagraph();
      i++;
      continue;
    }

    // Speaker notes: blockquote starting with "Speaker notes:" claims the
    // rest of the section. Strips the prefix.
    const noteMatch = trimmed.match(/^>\s*Speaker notes:\s*(.*)$/i);
    if (noteMatch) {
      flushParagraph();
      flushBullets();
      const collected = [noteMatch[1]];
      i++;
      while (i < sectionLines.length) {
        const m = sectionLines[i].match(/^>\s?(.*)$/);
        if (!m) break;
        collected.push(m[1]);
        i++;
      }
      speakerNotes = collected.join('\n').trim();
      continue;
    }

    // Image: `![alt](ref)` consumes the whole line.
    const imageMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imageMatch) {
      flushParagraph();
      flushBullets();
      const alt = imageMatch[1];
      const target = imageMatch[2];
      body.push({ kind: 'image', alt, ref: parseImageRef(target) });
      i++;
      continue;
    }

    // Bullet: lines beginning with `- ` or `* `.
    const bulletMatch = line.match(/^[-*]\s+(.+?)\s*$/);
    if (bulletMatch) {
      flushParagraph();
      pendingBullets.push(bulletMatch[1]);
      i++;
      continue;
    }

    // Anything else accumulates as paragraph text.
    flushBullets();
    pendingParagraph.push(trimmed);
    i++;
  }

  flushParagraph();
  flushBullets();

  return { title, body, speakerNotes };
}

function parseImageRef(target: string): ImageRef {
  if (target.startsWith('drive:')) {
    return { kind: 'driveFileId', fileId: target.slice('drive:'.length) };
  }
  return { kind: 'url', url: target };
}

// ============================================================================
// Slides batchUpdate request builder (template-based)
// ============================================================================
//
// Strategy: the operator (or `bootstrap-training-deck-template.ts`)
// creates a Google Slides "template" deck once. The template has two
// stencil slides with known `objectId`s and `{{...}}` placeholder text
// the build code knows how to fill. To produce a per-opp deck we:
//
//   1. drive.files.copy the template into the opp folder
//   2. presentations.get the copy to discover stencil objectIds (Slides
//      preserves them on copy unless they collide — they won't here)
//   3. For the parsed `DeckSpec`, emit:
//        - one `replaceAllText` for {{TITLE}} / {{SUBTITLE}} on the
//          repurposed title slide
//        - per content slide: `duplicateObject` of stencil_content,
//          then per-slide-scoped `replaceAllText` for {{TITLE}} and
//          {{BODY}}, then `createImage` requests for any image blocks
//        - finally `deleteObject` on the unused stencils
//   4. Speaker notes: a follow-up batchUpdate after the orchestrating
//      skill resolves each new slide's `notesPage.speakerNotesObjectId`
//      via a single `slides_get` call.
//
// Why two batches: Slides assigns `notesPage.speakerNotesObjectId`
// lazily when the slide first materializes. We can only query that ID
// after the slide is created, so notes go in a second pass. Same
// pattern docs uses for tab-id discovery.
//
// All branding (fonts, colors, logo, layout) lives in the TEMPLATE deck
// — not in this code. Iterating the visual design is "edit the template
// in Slides, save", not "rebuild and ship a new plugin version". That's
// the intent of the user's "improve it over time" note.

/** Stencil slide objectIds the template MUST contain. */
export const STENCIL_TITLE_OBJECT_ID = 'ace_stencil_title';
export const STENCIL_CONTENT_OBJECT_ID = 'ace_stencil_content';

/** Placeholder tokens the template MUST contain inside the stencils. */
export const PLACEHOLDER_TITLE = '{{TITLE}}';
export const PLACEHOLDER_SUBTITLE = '{{SUBTITLE}}';
export const PLACEHOLDER_BODY = '{{BODY}}';

/**
 * Image positioning on content slides. In a 16:9 deck (914400 EMU/inch,
 * 10in × 5.625in), image sits in the lower 60% of the body area so a
 * paragraph above it is visible. Keep this in sync with the body text
 * box height in the template — adjusting one without the other will
 * cause overlap.
 */
const SLIDE_WIDTH_EMU = 9_144_000;
const SLIDE_HEIGHT_EMU = 5_143_500;
const IMAGE_X_EMU = 914_400; // 1"
const IMAGE_Y_EMU = 2_286_000; // 2.5" from top — below {{BODY}} placeholder
const IMAGE_W_EMU = SLIDE_WIDTH_EMU - 2 * IMAGE_X_EMU;
const IMAGE_H_EMU = SLIDE_HEIGHT_EMU - IMAGE_Y_EMU - 457_200; // bottom margin 0.5"

export interface SlidesBuildOpts {
  /**
   * Object IDs of the stencil slides in the COPIED template, as
   * resolved by the orchestrating skill via `slides_get`. Slides
   * normally preserves stencil objectIds across `drive.files.copy`,
   * but the skill must verify before passing them in (and surface a
   * clean error if the template was edited to remove the stencils).
   */
  stencils: {
    title: string;
    content: string;
  };
}

export interface SlidesBuildResult {
  /** Main batchUpdate requests — safe to send in one call. */
  mainRequests: Array<Record<string, unknown>>;
  /**
   * Speaker-notes follow-ups. The orchestrating skill resolves each
   * slide's `speakerNotesObjectId` via `slides_get` and dispatches a
   * second batchUpdate of `insertText` requests against those IDs.
   */
  speakerNotes: Array<{ slideObjectId: string; text: string }>;
}

/**
 * Translate a parsed `DeckSpec` into the request stream for the
 * template-copy strategy. Emits requests in the order:
 *
 *   1. replaceAllText {{TITLE}} / {{SUBTITLE}} on `stencils.title`
 *   2. for each parsed slide N: duplicateObject(content) → newId,
 *      replaceAllText({{TITLE}}, slide.title, [newId]),
 *      replaceAllText({{BODY}}, renderedBody, [newId]),
 *      createImage(s) anchored to newId
 *   3. deleteObject(stencils.content) — remove the unused stencil
 *
 * Stencil-title is NOT deleted; it's repurposed as the deck's title
 * slide via the in-place replaceAllText.
 */
export function buildSlidesRequests(
  spec: DeckSpec,
  opts: SlidesBuildOpts,
): SlidesBuildResult {
  const mainRequests: Array<Record<string, unknown>> = [];
  const speakerNotes: Array<{ slideObjectId: string; text: string }> = [];

  // 1) Title slide: scoped text replacement on the title stencil.
  mainRequests.push(replaceAllText(PLACEHOLDER_TITLE, spec.title, [opts.stencils.title]));
  mainRequests.push(
    replaceAllText(PLACEHOLDER_SUBTITLE, spec.subtitle ?? '', [opts.stencils.title]),
  );

  // 2) Content slides — duplicate stencil per parsed slide, fill placeholders.
  spec.slides.forEach((slide, idx) => {
    const newSlideId = `ace_slide_${idx + 1}`;
    mainRequests.push({
      duplicateObject: {
        objectId: opts.stencils.content,
        objectIds: { [opts.stencils.content]: newSlideId },
      },
    });
    mainRequests.push(replaceAllText(PLACEHOLDER_TITLE, slide.title, [newSlideId]));
    mainRequests.push(
      replaceAllText(PLACEHOLDER_BODY, renderBodyText(slide.body), [newSlideId]),
    );

    // Image blocks — one createImage per image block, stacked
    // top-to-bottom in the lower body area. Multi-image slides share
    // the height; single-image slides get the full image area.
    const imageBlocks = slide.body.filter((b): b is BodyBlockImage => b.kind === 'image');
    if (imageBlocks.length > 0) {
      const perImageHeight = IMAGE_H_EMU / imageBlocks.length;
      imageBlocks.forEach((block, imgIdx) => {
        const imgObjId = `ace_slide_${idx + 1}_img_${imgIdx}`;
        const url =
          block.ref.kind === 'driveFileId'
            ? `https://drive.google.com/uc?export=view&id=${block.ref.fileId}`
            : block.ref.url;
        mainRequests.push({
          createImage: {
            objectId: imgObjId,
            elementProperties: {
              pageObjectId: newSlideId,
              size: {
                height: { magnitude: perImageHeight, unit: 'EMU' },
                width: { magnitude: IMAGE_W_EMU, unit: 'EMU' },
              },
              transform: {
                scaleX: 1,
                scaleY: 1,
                translateX: IMAGE_X_EMU,
                translateY: IMAGE_Y_EMU + imgIdx * perImageHeight,
                unit: 'EMU',
              },
            },
            url,
          },
        });
      });
    }

    if (slide.speakerNotes) {
      speakerNotes.push({ slideObjectId: newSlideId, text: slide.speakerNotes });
    }
  });

  // 3) Remove the stencil_content slide so the final deck has only
  // the title slide + the duplicated per-spec content slides.
  mainRequests.push({ deleteObject: { objectId: opts.stencils.content } });

  return { mainRequests, speakerNotes };
}

interface BodyBlockImage {
  kind: 'image';
  alt: string;
  ref: ImageRef;
}

function replaceAllText(
  containsText: string,
  replaceWith: string,
  pageObjectIds: string[],
): Record<string, unknown> {
  return {
    replaceAllText: {
      containsText: { text: containsText, matchCase: true },
      replaceText: replaceWith,
      pageObjectIds,
    },
  };
}

function renderBodyText(blocks: BodyBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'paragraph') {
      parts.push(b.text);
    } else if (b.kind === 'bullets') {
      for (const item of b.items) parts.push(`• ${item}`);
    }
  }
  return parts.join('\n');
}

/**
 * Build the second-phase request stream that inserts speaker notes
 * into each slide's speakerNotes shape. Caller passes the
 * speakerNotesObjectIds it discovered via `slides_get`, keyed by the
 * slide's objectId.
 */
export function buildSpeakerNotesRequests(
  notes: Array<{ slideObjectId: string; text: string }>,
  speakerNotesObjectIds: Record<string, string>,
): Array<Record<string, unknown>> {
  return notes.map(({ slideObjectId, text }) => {
    const notesObjId = speakerNotesObjectIds[slideObjectId];
    if (!notesObjId) {
      throw new Error(
        `buildSpeakerNotesRequests: no speakerNotesObjectId for slide "${slideObjectId}". ` +
          `Did slides_get fail to enumerate the new slide?`,
      );
    }
    return {
      insertText: {
        objectId: notesObjId,
        text,
        insertionIndex: 0,
      },
    };
  });
}
