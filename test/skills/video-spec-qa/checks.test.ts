/**
 * Unit tests for the static QA checks in skills/video-spec-qa/checks.ts.
 *
 * Each check is a pure function over the spec.yaml text. Tests build
 * minimal inline YAML strings + run individual checks via the
 * `CHECKS` array (each `QACheck` has a stable `id`). Fixture-based
 * end-to-end tests would go in an integration.test.ts companion.
 */

import { describe, expect, test } from 'vitest';
import { CHECKS } from '../../../skills/video-spec-qa/checks';
import type { QACheck, QACheckResult } from '../../../lib/qa-types';

function getCheck(id: string): QACheck {
  const c = CHECKS.find((x) => x.id === id);
  if (!c) throw new Error(`No check with id=${id}`);
  return c;
}

function run(id: string, artifact: string): QACheckResult {
  return getCheck(id).run(artifact) as QACheckResult;
}

/** Minimum valid 60s spec, used as a base most tests then mutate. */
const VALID_60S = `provenance:
  generator: video-from-program-page
  template: "60s-campaign-overview"
  generated_from: "https://example.org/programs/x"
  generated_at: "2026-05-15T12:00:00Z"

slug: "kmc"
workspace: "dimagi-team"
name: "KMC"
country_focus: "Uganda"
status: "Active"
tagline: "Home visits."
program_url: "https://example.org/programs/x"

manifest: {}

scene:
  clips: []
  lower_third: "Uganda · KMC"

problem:
  big: "80%"
  caption: "neonatal deaths"
  source: "src"

product:
  beats: []

impact:
- {big: "$36", caption: "per newborn"}
- {big: "40%", caption: "mortality reduction"}

narration:
  generator: manual
  prompt_version: v3
  start_seconds: 0
  by_beat:
    hook: "Pay for verified service delivery, not planned activity."
    cycle: "Workers learn, deliver care, evidence is verified through the app, and only then they are paid for the visits actually completed."
    handoff: "Here is how that works for Kangaroo Mother Care."
    scene: "A community health worker visits a mother and her small newborn at home, weighing the baby and coaching skin-to-skin Kangaroo wrapping."
    problem: "Eighty percent of neonatal deaths happen after discharge, at home, without follow-up. Small and vulnerable newborns need structured care in their first sixty days."
    product: "FLWs open the Connect app and record weight, temperature, oxygen, and breathing rate at every visit. They screen for danger signs, observe a breastfeed, and coach skin-to-skin Kangaroo positioning."
    impact: "Thirty-six dollars per newborn for the complete intervention. A potential forty percent reduction in newborn mortality with Kangaroo Mother Care."
    cta: ""
  script: ""

voice:
  provider: elevenlabs
  voice_id: "XB0fDUnXU5powFXDhCwa"
  model: eleven_turbo_v2
`;

// ── spec_yaml_parses ───────────────────────────────────────────────

describe('spec_yaml_parses', () => {
  test('passes on valid YAML', () => {
    expect(run('spec_yaml_parses', VALID_60S).pass).toBe(true);
  });
  test('fails on broken YAML', () => {
    const r = run('spec_yaml_parses', 'slug: "x\nworkspace: oops');
    expect(r.pass).toBe(false);
    expect(r.auto_fix_hint).toBeDefined();
  });
  test('fails when root is not a mapping', () => {
    const r = run('spec_yaml_parses', '- a\n- b');
    expect(r.pass).toBe(false);
  });
});

// ── required_top_level_fields ──────────────────────────────────────

describe('required_top_level_fields', () => {
  test('passes on the valid base spec', () => {
    expect(run('required_top_level_fields', VALID_60S).pass).toBe(true);
  });
  test('fails when fields are missing', () => {
    const r = run('required_top_level_fields', 'slug: "x"\nworkspace: "y"\n');
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/Missing/);
  });
});

// ── slug_format_valid ──────────────────────────────────────────────

describe('slug_format_valid', () => {
  test('passes on a-z digits hyphens', () => {
    expect(run('slug_format_valid', VALID_60S).pass).toBe(true);
  });
  test('fails on uppercase', () => {
    const bad = VALID_60S.replace('slug: "kmc"', 'slug: "KMC"');
    expect(run('slug_format_valid', bad).pass).toBe(false);
  });
  test('fails on slashes', () => {
    const bad = VALID_60S.replace('slug: "kmc"', 'slug: "a/b"');
    expect(run('slug_format_valid', bad).pass).toBe(false);
  });
});

// ── provenance_block_present ───────────────────────────────────────

describe('provenance_block_present', () => {
  test('passes when all four fields are set', () => {
    expect(run('provenance_block_present', VALID_60S).pass).toBe(true);
  });
  test('fails when provenance is missing entirely', () => {
    const r = run('provenance_block_present', 'slug: "x"\n');
    expect(r.pass).toBe(false);
  });
  test('fails when a sub-field is empty', () => {
    const bad = VALID_60S.replace('generated_from: "https://example.org/programs/x"', 'generated_from: ""');
    const r = run('provenance_block_present', bad);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/generated_from/);
  });
});

// ── provenance_timestamp_valid ─────────────────────────────────────

describe('provenance_timestamp_valid', () => {
  test('accepts ISO-8601 Z', () => {
    expect(run('provenance_timestamp_valid', VALID_60S).pass).toBe(true);
  });
  test('rejects malformed timestamp', () => {
    const bad = VALID_60S.replace('generated_at: "2026-05-15T12:00:00Z"', 'generated_at: "yesterday"');
    expect(run('provenance_timestamp_valid', bad).pass).toBe(false);
  });
});

// ── no_unresolved_placeholders ─────────────────────────────────────

describe('no_unresolved_placeholders', () => {
  test('passes on a fully-substituted spec', () => {
    expect(run('no_unresolved_placeholders', VALID_60S).pass).toBe(true);
  });
  test('flags surviving {{placeholders}} in body', () => {
    const bad = VALID_60S.replace('"kmc"', '"{{program_slug}}"');
    const r = run('no_unresolved_placeholders', bad);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/program_slug/);
  });
  test('does NOT flag placeholders inside comment lines', () => {
    const withComment = '# Author-time docs: {{program_slug}} is the slug\n' + VALID_60S;
    expect(run('no_unresolved_placeholders', withComment).pass).toBe(true);
  });
});

// ── impact_count_matches_template ──────────────────────────────────

describe('impact_count_matches_template', () => {
  test('passes when impact has 2 entries', () => {
    expect(run('impact_count_matches_template', VALID_60S).pass).toBe(true);
  });
  test('fails on 1 entry', () => {
    const bad = VALID_60S.replace(
      'impact:\n- {big: "$36", caption: "per newborn"}\n- {big: "40%", caption: "mortality reduction"}',
      'impact:\n- {big: "$36", caption: "per newborn"}',
    );
    expect(run('impact_count_matches_template', bad).pass).toBe(false);
  });
  test('no template_id => skips check', () => {
    const noTemplate = VALID_60S.replace('"60s-campaign-overview"', '"unknown-template"');
    expect(run('impact_count_matches_template', noTemplate).pass).toBe(true);
  });
});

// ── required_beats_present ─────────────────────────────────────────

describe('required_beats_present', () => {
  test('passes when all 8 beats are present', () => {
    expect(run('required_beats_present', VALID_60S).pass).toBe(true);
  });
  test('fails when a beat is missing', () => {
    const bad = VALID_60S.replace(/    impact: ".*"\n/, '');
    const r = run('required_beats_present', bad);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/impact/);
  });
});

// ── narration_within_word_budgets ──────────────────────────────────

describe('narration_within_word_budgets', () => {
  test('passes when every beat is within its budget', () => {
    expect(run('narration_within_word_budgets', VALID_60S).pass).toBe(true);
  });
  test('flags an over-budget beat', () => {
    const tooLong = 'word '.repeat(50).trim();
    const bad = VALID_60S.replace(
      /hook: "Pay for verified service delivery, not planned activity\."/,
      `hook: "${tooLong}"`,
    );
    const r = run('narration_within_word_budgets', bad);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/hook=/);
  });
  test('flags an under-budget beat', () => {
    const bad = VALID_60S.replace(
      /problem: ".*"\n/,
      'problem: "Newborns die."\n',
    );
    expect(run('narration_within_word_budgets', bad).pass).toBe(false);
  });
});

// ── no_tbd_in_narration ────────────────────────────────────────────

describe('no_tbd_in_narration', () => {
  test('passes on clean narration', () => {
    expect(run('no_tbd_in_narration', VALID_60S).pass).toBe(true);
  });
  test('fails when narration contains [TBD]', () => {
    const bad = VALID_60S.replace(/cycle: ".*"\n/, 'cycle: "[TBD] fill in the cycle later."\n');
    expect(run('no_tbd_in_narration', bad).pass).toBe(false);
  });
});

// ── hook_paraphrases_connect_tagline ───────────────────────────────

describe('hook_paraphrases_connect_tagline', () => {
  test('passes on verbatim tagline', () => {
    expect(run('hook_paraphrases_connect_tagline', VALID_60S).pass).toBe(true);
  });
  test('passes on strong paraphrase (3+ key tokens)', () => {
    const para = VALID_60S.replace(
      /hook: "Pay for verified service delivery, not planned activity\."/,
      'hook: "We pay only for delivery that has been verified as actual service work."',
    );
    expect(run('hook_paraphrases_connect_tagline', para).pass).toBe(true);
  });
  test('fails when the hook invents a new tagline', () => {
    const bad = VALID_60S.replace(
      /hook: "Pay for verified service delivery, not planned activity\."/,
      'hook: "Empowering the future of community health, today."',
    );
    expect(run('hook_paraphrases_connect_tagline', bad).pass).toBe(false);
  });
});

// ── no_banned_voice_tokens ─────────────────────────────────────────

describe('no_banned_voice_tokens', () => {
  test('passes on documentary-style narration', () => {
    expect(run('no_banned_voice_tokens', VALID_60S).pass).toBe(true);
  });
  test('catches "leverage"', () => {
    const bad = VALID_60S.replace(
      /cycle: ".*"\n/,
      'cycle: "We leverage cutting-edge tools to deliver robust service experiences."\n',
    );
    const r = run('no_banned_voice_tokens', bad);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/leverage/);
  });
});

// ── voice_config_valid ─────────────────────────────────────────────

describe('voice_config_valid', () => {
  test('passes when voice block is complete', () => {
    expect(run('voice_config_valid', VALID_60S).pass).toBe(true);
  });
  test('fails when voice block is empty', () => {
    const bad = VALID_60S.replace(
      /voice:\n  provider: elevenlabs\n  voice_id: ".*"\n  model: eleven_turbo_v2/,
      'voice:\n  provider: ""\n  voice_id: ""\n  model: ""',
    );
    expect(run('voice_config_valid', bad).pass).toBe(false);
  });
});

// ── CHECKS array shape ─────────────────────────────────────────────

describe('CHECKS array', () => {
  test('exposes 13 stable check ids', () => {
    expect(CHECKS).toHaveLength(13);
    const ids = CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
  });
});
