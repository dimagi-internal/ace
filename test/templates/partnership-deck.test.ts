// Test: connect-pitch-partnership deck template skeleton parses against
// TrainingDeckSpecSchema once all {{TOKENS}} are substituted with valid
// placeholder values. Goal: prove the shipped skeleton produces a
// schema-valid spec when the build skill fills it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTrainingSpec } from "../../lib/training-deck-spec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(
  __dirname,
  "..",
  "..",
  "templates",
  "training-deck",
  "connect-pitch-partnership",
);

/**
 * Load the spec.template.yaml and substitute every {{TOKEN}} with a
 * valid placeholder value that satisfies the TrainingDeckSpecSchema.
 *
 * Scalar string tokens → "x" (a non-empty string placeholder).
 * Special-cased tokens:
 *   - {{DURATION}} → "12" so estimated_duration_minutes parses as a number
 *   - {{LANGUAGE}} → "en"
 *   - {{COMMON_MANIFEST}} / {{OPP_MANIFEST}} → "{}" so manifest fields
 *     parse as empty records (the schema accepts optional empty records)
 *   - {{DEMO_IMAGE}} → "https://example.com/demo.png" (a valid image URL
 *     for the walkthrough layout's required image field)
 *   - {{DATE}} → "June 2026"
 *   - {{GENERATED_AT}} → "2026-06-06T00:00:00Z"
 */
function substituteTokens(template: string): string {
  return (
    template
      // Manifest tokens — must be YAML mappings, not plain strings
      .replace(/"{{COMMON_MANIFEST}}"/g, "{}")
      .replace(/"{{OPP_MANIFEST}}"/g, "{}")
      // duration must be a bare number (no quotes) for YAML to parse as number
      .replace(/"{{DURATION}}"/g, "12")
      // image for walkthrough — must be a non-empty string (URL or alias)
      .replace(/"{{DEMO_IMAGE}}"/g, '"https://example.com/demo.png"')
      // ISO timestamp
      .replace(/"{{GENERATED_AT}}"/g, '"2026-06-06T00:00:00Z"')
      // All remaining {{...}} tokens → "x"
      .replace(/"{{[A-Z0-9_]+}}"/g, '"x"')
      // Also replace unquoted tokens that appear as YAML values
      .replace(/{{[A-Z0-9_]+}}/g, "x")
  );
}

describe("connect-pitch-partnership deck template", () => {
  it("spec.template.yaml is loadable from disk", () => {
    const templatePath = join(TEMPLATE_DIR, "spec.template.yaml");
    const raw = readFileSync(templatePath, "utf8");
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).toContain("archetype: partnership-pitch");
    expect(raw).toContain("audience: prospect");
  });

  it("parses against TrainingDeckSpecSchema after token substitution", () => {
    const templatePath = join(TEMPLATE_DIR, "spec.template.yaml");
    const raw = readFileSync(templatePath, "utf8");
    const substituted = substituteTokens(raw);

    // This is the load-bearing assertion: the skeleton must produce a
    // schema-valid spec once all tokens are filled.
    const spec = parseTrainingSpec(substituted);

    expect(spec.archetype).toBe("partnership-pitch");
    expect(spec.voice.audience).toBe("prospect");
    expect(spec.template_id).toBe("connect-pitch-partnership");
  });

  it("spec has the expected 7 modules", () => {
    const templatePath = join(TEMPLATE_DIR, "spec.template.yaml");
    const raw = readFileSync(templatePath, "utf8");
    const spec = parseTrainingSpec(substituteTokens(raw));

    const moduleIds = spec.modules.map((m) => m.id);
    expect(moduleIds).toEqual([
      "opening",
      "their-world",
      "the-thesis",
      "how-connect-works",
      "proof",
      "business-case",
      "the-ask",
    ]);
  });

  it("slide count is within the expected 10-12 range", () => {
    const templatePath = join(TEMPLATE_DIR, "spec.template.yaml");
    const raw = readFileSync(templatePath, "utf8");
    const spec = parseTrainingSpec(substituteTokens(raw));

    const totalSlides = spec.modules.reduce(
      (sum, m) => sum + m.slides.length,
      0,
    );
    expect(totalSlides).toBeGreaterThanOrEqual(10);
    expect(totalSlides).toBeLessThanOrEqual(12);
  });

  it("every slide has a non-empty id, title, and a valid layout", () => {
    const validLayouts = new Set([
      "cover", "section", "agenda", "content", "walkthrough",
      "mobile_flow", "web_screen", "mobile_zoom", "two_column",
      "stats", "timeline", "checklist", "exercise", "closing",
    ]);

    const templatePath = join(TEMPLATE_DIR, "spec.template.yaml");
    const raw = readFileSync(templatePath, "utf8");
    const spec = parseTrainingSpec(substituteTokens(raw));

    for (const mod of spec.modules) {
      for (const slide of mod.slides) {
        expect(slide.id).toBeTruthy();
        expect(slide.title).toBeTruthy();
        expect(validLayouts.has(slide.layout)).toBe(true);
      }
    }
  });

  it("template.yaml declares archetype partnership-pitch and audience prospect", () => {
    const raw = readFileSync(join(TEMPLATE_DIR, "template.yaml"), "utf8");
    expect(raw).toContain("archetype: partnership-pitch");
    expect(raw).toContain("audience: prospect");
  });

  it("generate.prompt.md exists and references the research doc token", () => {
    const raw = readFileSync(join(TEMPLATE_DIR, "generate.prompt.md"), "utf8");
    expect(raw).toContain("RESEARCH_DOC_ID");
    expect(raw).toContain("pdd_doc_id");
  });
});
