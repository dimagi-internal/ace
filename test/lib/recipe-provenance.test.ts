/**
 * Tests for `lib/recipe-provenance.ts` — generated Phase 3 journey
 * recipes carry an `ace_version` + `selector_map_sha` header so
 * Phase 6 can detect stale Drive artifacts before AVD wall-clock
 * burns.
 *
 * The class-level finding from `docs/learnings/2026-05-14-phase6-
 * validation-arc.md` was "stale Drive recipes can ship to Phase 6 when
 * the selector map changes." This module makes that detectable.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRecipeProvenanceHeader,
  computeSelectorMapSha,
  parseRecipeProvenance,
  validateRecipeFreshness,
  type RecipeProvenance,
} from '../../lib/recipe-provenance.js';

const SAMPLE: RecipeProvenance = {
  ace_version: '0.13.444',
  selector_map_sha: 'abc123def456',
  selector_map_apk_version: '2.63.0',
  generated_at: '2026-05-26T19:00:00.000Z',
};

describe('buildRecipeProvenanceHeader → parseRecipeProvenance roundtrip', () => {
  it('round-trips a full header through parse', () => {
    const header = buildRecipeProvenanceHeader(SAMPLE);
    const yaml = `${header}appId: org.commcare.dalvik\n---\n- launchApp: x\n`;
    expect(parseRecipeProvenance(yaml)).toEqual(SAMPLE);
  });

  it('parseRecipeProvenance returns undefined when no header present (legacy recipes)', () => {
    expect(parseRecipeProvenance('appId: x\n---\n- launchApp: x\n')).toBeUndefined();
  });

  it('parseRecipeProvenance returns undefined when header is partial / corrupt', () => {
    expect(
      parseRecipeProvenance('# ACE Recipe Provenance — do not edit by hand\n# foo: bar\n'),
    ).toBeUndefined();
  });

  it('parseRecipeProvenance tolerates extra whitespace in values', () => {
    const yaml = [
      '# ACE Recipe Provenance — do not edit by hand',
      '# ace_version:   0.13.444  ',
      '# selector_map_sha: abc123def456',
      '# selector_map_apk_version: 2.63.0',
      '# generated_at: 2026-05-26T19:00:00.000Z',
      '',
      'appId: x',
    ].join('\n');
    expect(parseRecipeProvenance(yaml)).toEqual(SAMPLE);
  });
});

describe('computeSelectorMapSha', () => {
  it('is deterministic for the same input', () => {
    const sha1 = computeSelectorMapSha('foo: bar\nbaz: qux\n');
    const sha2 = computeSelectorMapSha('foo: bar\nbaz: qux\n');
    expect(sha1).toBe(sha2);
  });

  it('changes when input changes by even one character', () => {
    const a = computeSelectorMapSha('foo: bar\n');
    const b = computeSelectorMapSha('foo: baz\n');
    expect(a).not.toBe(b);
  });

  it('returns a hex string of expected length (12 chars)', () => {
    const sha = computeSelectorMapSha('anything');
    expect(sha).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('validateRecipeFreshness', () => {
  const currentSha = 'abc123def456';

  it('returns ok=true when SHA matches', () => {
    const yaml = buildRecipeProvenanceHeader(SAMPLE) + 'appId: x\n';
    const r = validateRecipeFreshness({
      recipeText: yaml,
      currentSelectorMapSha: currentSha,
      currentApkVersion: '2.63.0',
    });
    expect(r.ok).toBe(true);
  });

  it('returns ok=false with reason when SHA mismatches', () => {
    const yaml = buildRecipeProvenanceHeader(SAMPLE) + 'appId: x\n';
    const r = validateRecipeFreshness({
      recipeText: yaml,
      currentSelectorMapSha: 'STALE_SHA_XX',
      currentApkVersion: '2.63.0',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/selector_map_sha mismatch/);
      expect(r.provenance).toEqual(SAMPLE);
    }
  });

  it('returns ok=false when APK version mismatches', () => {
    const yaml = buildRecipeProvenanceHeader(SAMPLE) + 'appId: x\n';
    const r = validateRecipeFreshness({
      recipeText: yaml,
      currentSelectorMapSha: currentSha,
      currentApkVersion: '2.62.0',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/apk_version mismatch/);
    }
  });

  it('returns ok=true when no provenance header present (legacy recipes — do not break)', () => {
    // Static palette recipes and any pre-provenance journey recipes
    // must keep running. Pre-flight is opt-in based on header presence.
    const r = validateRecipeFreshness({
      recipeText: 'appId: x\n---\n- launchApp: x\n',
      currentSelectorMapSha: currentSha,
      currentApkVersion: '2.63.0',
    });
    expect(r.ok).toBe(true);
  });
});

describe('header is YAML-comment-safe (doesn\'t break Maestro parse)', () => {
  it('header is entirely # comment lines + a blank line', () => {
    const header = buildRecipeProvenanceHeader(SAMPLE);
    const nonEmpty = header.split('\n').filter((l) => l.length > 0);
    for (const line of nonEmpty) {
      expect(line.startsWith('#')).toBe(true);
    }
  });

  it('header ends with a blank line so user content lands cleanly below', () => {
    const header = buildRecipeProvenanceHeader(SAMPLE);
    expect(header.endsWith('\n')).toBe(true);
    expect(header.split('\n').slice(-2)[0]).toBe(''); // penultimate is blank
  });
});

describe('end-to-end stale-recipe detection scenario', () => {
  it('a recipe generated against an old map gets caught on a fresh map', () => {
    // Run 1 generates a recipe with selector_map_sha = oldSha.
    const oldMap = 'foo: bar\n';
    const oldSha = computeSelectorMapSha(oldMap);
    const generatedAt = '2026-05-25T00:00:00.000Z';
    const recipeYaml =
      buildRecipeProvenanceHeader({
        ace_version: '0.13.300',
        selector_map_sha: oldSha,
        selector_map_apk_version: '2.63.0',
        generated_at: generatedAt,
      }) + 'appId: org.commcare.dalvik\n---\n- launchApp: x\n';

    // Run 2 happens after the selector map evolved.
    const newMap = 'foo: bar\nbaz: qux\n';
    const newSha = computeSelectorMapSha(newMap);
    expect(newSha).not.toBe(oldSha);

    const verdict = validateRecipeFreshness({
      recipeText: recipeYaml,
      currentSelectorMapSha: newSha,
      currentApkVersion: '2.63.0',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      // The reason names the gap so the operator knows what to do.
      expect(verdict.reason).toContain('selector_map_sha mismatch');
      expect(verdict.reason).toContain(oldSha);
      expect(verdict.reason).toContain(newSha);
    }
  });
});
