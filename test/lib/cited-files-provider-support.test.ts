import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  citedFilesSupport,
  citedFilesCapApplies,
  citedFilesPlatformNote,
  CITED_FILES_PLATFORM_MARKER,
} from '../../lib/cited-files-provider-support.js';

/**
 * ace#2027 — the empty-`cited_files` cap must key off the PROVIDER, not the
 * channel.
 *
 * The bug being pinned is not "a sentence was wrong". `ocs-chatbot-eval` scoped
 * its exemption to `capture_method = widget`, so on the `openai-compat` capture
 * method — which the same skill documents as supported — every Anthropic-backed
 * ACE bot would take an automatic `<=5` or `<=3` cap on Source usage (20% of the
 * `--deep` verdict feeding Phase 9 `llo-launch`) for a field that
 * `parse_output_for_anthropic` cannot populate on any channel.
 *
 * The two controls that matter are the POSITIVE and the NEGATIVE, and they are
 * asserted against each other rather than in isolation: a helper that returned
 * a constant would satisfy either one alone.
 */

const ANTHROPIC = 'anthropic';

/**
 * Every slug in upstream `LlmProviderTypes`
 * (`apps/service_providers/models.py:70-85`, read 2026-09-06), with the
 * service class `_build_llm_service` (:160-180) maps it to.
 *
 * `anthropic` is the only one whose class overrides `get_output_parser`, so it
 * is the only one that cannot populate `cited_files`.
 */
const UPSTREAM_SLUGS = [
  'openai',
  'azure',
  'anthropic',
  'groq',
  'perplexity',
  'deepseek',
  'minimax',
  'litellm',
  'google',
  'google_vertex_ai',
  'voyage',
] as const;

describe('citedFilesSupport — provider classification', () => {
  it('POSITIVE CONTROL: anthropic cannot populate cited_files', () => {
    expect(citedFilesSupport(ANTHROPIC)).toBe('unsupported');
  });

  it('NEGATIVE CONTROL: every other upstream provider can', () => {
    const others = UPSTREAM_SLUGS.filter((s) => s !== ANTHROPIC);
    expect(others).toHaveLength(10);
    for (const slug of others) {
      expect(citedFilesSupport(slug), `slug ${slug}`).toBe('supported');
    }
  });

  it('is not a constant — the two controls disagree', () => {
    // The assertion that makes the two above mean something. A helper stubbed
    // to any single value passes exactly one of them.
    expect(citedFilesSupport(ANTHROPIC)).not.toBe(citedFilesSupport('openai'));
  });

  it('covers every upstream slug — none falls through to unknown', () => {
    // If OCS adds a provider this list will still pass while the MAP does not
    // cover it, which is why the next case pins the unknown behaviour: an
    // uncovered provider must degrade safely, not be assumed.
    for (const slug of UPSTREAM_SLUGS) {
      expect(citedFilesSupport(slug), `slug ${slug}`).not.toBe('unknown');
    }
  });

  it('reports unknown for an absent, empty, or unrecognised slug', () => {
    expect(citedFilesSupport(undefined)).toBe('unknown');
    expect(citedFilesSupport(null)).toBe('unknown');
    expect(citedFilesSupport('')).toBe('unknown');
    expect(citedFilesSupport('   ')).toBe('unknown');
    expect(citedFilesSupport('a-provider-ocs-added-next-week')).toBe('unknown');
    // Not a string at all — a transcript field that came through as a number.
    expect(citedFilesSupport(42 as unknown as string)).toBe('unknown');
  });

  it('normalises case and surrounding whitespace', () => {
    // `provider_name` is "Antropic" (sic) in the live payload; `type` is the
    // slug. Be tolerant about the slug's shape without being tolerant about
    // its meaning.
    expect(citedFilesSupport('  Anthropic  ')).toBe('unsupported');
    expect(citedFilesSupport('ANTHROPIC')).toBe('unsupported');
    expect(citedFilesSupport(' OpenAI ')).toBe('supported');
  });
});

describe('citedFilesCapApplies — the grading consequence', () => {
  it('withholds the cap on anthropic (the ace#2027 false-fail)', () => {
    expect(citedFilesCapApplies(ANTHROPIC)).toBe(false);
  });

  it('KEEPS the cap where the field is genuinely populatable', () => {
    // The half that must NOT change. An OpenAI-backed pipeline with
    // `generate_citations: true` and an empty `cited_files` is a real defect.
    for (const slug of UPSTREAM_SLUGS.filter((s) => s !== ANTHROPIC)) {
      expect(citedFilesCapApplies(slug), `slug ${slug}`).toBe(true);
    }
  });

  it('withholds the cap on an unknown provider — the cheaper error', () => {
    // Under-penalising a broken pipeline is recoverable (body-text grounding
    // still deducts); false-failing the llo-launch gate is not.
    expect(citedFilesCapApplies(undefined)).toBe(false);
    expect(citedFilesCapApplies('something-new')).toBe(false);
  });
});

describe('citedFilesPlatformNote — the auditable trace', () => {
  it('emits a [PLATFORM] note naming the real mechanism, not the channel', () => {
    const note = citedFilesPlatformNote(ANTHROPIC);
    expect(note).not.toBeNull();
    expect(note!).toContain(CITED_FILES_PLATFORM_MARKER);
    expect(note!).toContain('parse_output_for_anthropic');
    expect(note!).toContain('ace#2027');
    // The regression this whole PR is about: the explanation must not blame
    // the capture channel.
    expect(note!).not.toMatch(/widget|channel/i);
  });

  it('says "unknown", not "unsupported", when the provider is unrecognised', () => {
    const note = citedFilesPlatformNote('brand-new-provider');
    expect(note).not.toBeNull();
    expect(note!).toContain('unknown');
    // Must not assert the anthropic mechanism about a provider it did not see.
    expect(note!).not.toContain('parse_output_for_anthropic');
  });

  it('emits nothing when the cap legitimately applies', () => {
    expect(citedFilesPlatformNote('openai')).toBeNull();
    expect(citedFilesPlatformNote('deepseek')).toBeNull();
  });
});

describe('the rubric actually consumes this', () => {
  const SKILL = readFileSync(
    resolve(__dirname, '../../skills/ocs-chatbot-eval/SKILL.md'),
    'utf8',
  );

  it('the eval skill routes the cap through the helper', () => {
    // Without this the helper is dead code and the rubric is still wrong: the
    // defect lives in prose an LLM executes, so the prose is part of the fix.
    expect(SKILL).toContain('cited-files-provider-support');
    expect(SKILL).toMatch(/citedFilesCapApplies|citedFilesSupport/);
  });

  it('no longer attributes empty cited_files to the widget/channel', () => {
    // The exact wording the issue quoted, in either of the two places it stood.
    expect(SKILL).not.toMatch(
      /cited_files.{0,80}structurally always empty regardless of bot\s+grounding/s,
    );
    expect(SKILL).not.toMatch(/empty on every widget\s+capture, and that is expected/s);
  });

  it('still caps a provider that CAN populate the field', () => {
    // Guard against over-correcting into "never cap".
    expect(SKILL).toMatch(/≤5|<=5/);
    expect(SKILL).toMatch(/≤3|<=3/);
  });
});
