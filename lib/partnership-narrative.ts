// ============================================================================
// Partnership Narrative — Zod schema, YAML parser, beat constants
// ============================================================================
//
// Each narrative is a YAML file defining the seven narration beats that match
// the partnership-pitch video template (hook → cycle → handoff → scene →
// problem → product → impact). The library of reusable narratives is loaded
// at skill runtime; this module handles schema + parsing only.

import { parse } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Beat constants
// ---------------------------------------------------------------------------

/** The seven narration beats every partnership narrative must define.
 *  Matches the partnership-pitch video template's narration beats. */
export const NARRATIVE_BEATS = [
  "hook",
  "cycle",
  "handoff",
  "scene",
  "problem",
  "product",
  "impact",
] as const;

export type NarrativeBeat = (typeof NARRATIVE_BEATS)[number];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BeatSpecSchema = z.object({
  intent: z.string().min(1),
  words: z.number().int().positive(),
});

export type BeatSpec = z.infer<typeof BeatSpecSchema>;

/**
 * Schema for a single reusable partnership narrative.
 *
 * `beats` uses an explicit-literal object (rather than a dynamic
 * `Object.fromEntries` construction) so TypeScript can statically type each
 * beat key and Zod's `.strict()` correctly enforces both presence and the
 * closed-world constraint. NARRATIVE_BEATS remains the runtime source of
 * truth for the beat list.
 */
export const NarrativeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  version: z.number().int().positive(),
  thesis: z.string().min(1),
  emotional_beat: z.string().min(1),
  hero: z.string().min(1),
  primary_capability: z.string().min(1),
  beats: z
    .object({
      hook: BeatSpecSchema,
      cycle: BeatSpecSchema,
      handoff: BeatSpecSchema,
      scene: BeatSpecSchema,
      problem: BeatSpecSchema,
      product: BeatSpecSchema,
      impact: BeatSpecSchema,
    })
    .strict(),
});

export type Narrative = z.infer<typeof NarrativeSchema>;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a YAML string into a validated `Narrative`.
 * Throws a `ZodError` (whose message includes the offending field path)
 * if validation fails.
 */
export function parseNarrative(yamlText: string): Narrative {
  return NarrativeSchema.parse(parse(yamlText));
}
