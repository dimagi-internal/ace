/**
 * Static QA checks for `video-spec-qa`.
 *
 * Operates on the spec.yaml produced by /ace:video-from-program-page (or
 * hand-authored) for an ace-web video program. All checks are pure
 * functions over the spec text — no LLM, no I/O. Fast (<10ms total on
 * a typical 60s spec).
 *
 * Template-specific rules (word budgets, required beats) live in the
 * TEMPLATE_RULES map below. Adding a new template means appending a
 * new entry. Specs declare their template via the `provenance.template`
 * field.
 *
 * Imported by:
 *  - scripts/qa-run.ts at runtime (skill body dispatch)
 *  - test/skills/video-spec-qa/checks.test.ts
 */

import { parse as parseYaml } from 'yaml';

import type { QACheck, QACheckResult } from '../../lib/qa-types';

// ── Template-specific rules ────────────────────────────────────────

interface WordBudget {
  min: number;
  max: number;
}

interface TemplateRules {
  /** Beats that must appear under narration.by_beat. */
  required_beats: readonly string[];
  /** Per-beat word budgets. Beats not listed have no budget check. */
  word_budgets: Readonly<Record<string, WordBudget>>;
  /** Required impact-array length. -1 disables the check. */
  required_impact_count: number;
}

const TEMPLATE_RULES: Record<string, TemplateRules> = {
  '60s-campaign-overview': {
    required_beats: [
      'hook', 'cycle', 'handoff', 'scene',
      'problem', 'product', 'impact', 'cta',
    ],
    word_budgets: {
      hook: { min: 8, max: 12 },
      cycle: { min: 18, max: 22 },
      handoff: { min: 6, max: 10 },
      scene: { min: 18, max: 22 },
      problem: { min: 23, max: 27 },
      product: { min: 28, max: 32 },
      impact: { min: 18, max: 22 },
      cta: { min: 0, max: 0 },
    },
    required_impact_count: 2,
  },
};

const REQUIRED_TOP_LEVEL_FIELDS = [
  'slug', 'workspace', 'name', 'country_focus', 'status', 'tagline',
  'program_url', 'manifest', 'scene', 'problem', 'product', 'impact',
  'narration', 'voice',
] as const;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// Connect's tagline (verbatim from _defaults.yaml). The hook narration
// must paraphrase this — we accept fuzzy matches via a token-overlap
// heuristic.
const CONNECT_TAGLINE = 'Pay for verified service delivery, not planned activity.';
const TAGLINE_KEY_TOKENS = ['pay', 'verified', 'service', 'delivery'] as const;

// Brand voice violations — substrings that never belong in a Connect
// narration. Documentary-style; not marketing.
const BANNED_VOICE_TOKENS = [
  'leverage', 'synergy', 'robust', 'comprehensive', 'transformative',
  'game-changing', 'world-class', 'best-in-class', 'cutting-edge',
] as const;

// ── Helpers ────────────────────────────────────────────────────────

function safeParseSpec(text: string): { ok: true; doc: Record<string, unknown> } | { ok: false; err: string } {
  try {
    const doc = parseYaml(text);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, err: 'parsed value is not a YAML mapping' };
    }
    return { ok: true, doc: doc as Record<string, unknown> };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

function getPath(doc: Record<string, unknown>, path: readonly string[]): unknown {
  let cur: unknown = doc;
  for (const seg of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function resolveTemplateRules(doc: Record<string, unknown>): TemplateRules | null {
  const tmpl = getPath(doc, ['provenance', 'template']);
  if (typeof tmpl !== 'string') return null;
  return TEMPLATE_RULES[tmpl] ?? null;
}

// ── Check implementations ──────────────────────────────────────────

const checkSpecYamlParses: QACheck = {
  id: 'spec_yaml_parses',
  type: 'static',
  description: 'spec.yaml is valid YAML and the root is a mapping.',
  run(artifact): QACheckResult {
    const r = safeParseSpec(artifact);
    if (r.ok) return { pass: true };
    return {
      pass: false,
      detail: `Spec.yaml does not parse: ${r.err}`,
      auto_fix_hint: 'Re-author the spec from the template skeleton; the substitution likely produced invalid YAML.',
    };
  },
};

const checkRequiredTopLevelFields: QACheck = {
  id: 'required_top_level_fields',
  type: 'static',
  description: 'All required top-level fields are present.',
  run(artifact): QACheckResult {
    const r = safeParseSpec(artifact);
    if (!r.ok) return { pass: false, detail: 'spec_yaml_parses failed; cannot evaluate', auto_fix_hint: 'fix yaml first' };
    const missing = REQUIRED_TOP_LEVEL_FIELDS.filter((k) => !(k in r.doc));
    if (missing.length === 0) return { pass: true };
    return {
      pass: false,
      detail: `Missing top-level fields: ${missing.join(', ')}`,
      auto_fix_hint: `Add the missing fields from the template skeleton: ${missing.join(', ')}`,
    };
  },
};

const checkSlugFormat: QACheck = {
  id: 'slug_format_valid',
  type: 'static',
  description: 'slug matches [a-z0-9][a-z0-9-]{0,63}.',
  run(artifact): QACheckResult {
    const r = safeParseSpec(artifact);
    if (!r.ok) return { pass: false, detail: 'unparseable', auto_fix_hint: 'fix yaml first' };
    const slug = r.doc.slug;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      return {
        pass: false,
        detail: `slug=${JSON.stringify(slug)} does not match ${SLUG_RE.source}`,
        auto_fix_hint: 'Use lowercase letters, digits, and hyphens; start with a letter or digit; 1-64 chars.',
      };
    }
    return { pass: true };
  },
};

const checkProvenanceBlockPresent: QACheck = {
  id: 'provenance_block_present',
  type: 'static',
  description: 'provenance block has generator, template, generated_from, generated_at.',
  run(artifact): QACheckResult {
    const r = safeParseSpec(artifact);
    if (!r.ok) return { pass: false, detail: 'unparseable', auto_fix_hint: 'fix yaml first' };
    const prov = r.doc.provenance;
    if (!prov || typeof prov !== 'object' || Array.isArray(prov)) {
      return {
        pass: false,
        detail: 'No provenance: block at the top of spec',
        auto_fix_hint: 'Add a provenance block per the template skeleton (generator/template/generated_from/generated_at).',
      };
    }
    const obj = prov as Record<string, unknown>;
    const needed = ['generator', 'template', 'generated_from', 'generated_at'];
    const missing = needed.filter((k) => typeof obj[k] !== 'string' || (obj[k] as string).trim() === '');
    if (missing.length === 0) return { pass: true };
    return {
      pass: false,
      detail: `provenance.${missing.join(', provenance.')} is empty or missing`,
      auto_fix_hint: 'Fill every provenance.* field; the skill must echo template_id and stamp generated_at.',
    };
  },
};

const checkProvenanceTimestampValid: QACheck = {
  id: 'provenance_timestamp_valid',
  type: 'static',
  description: 'provenance.generated_at parses as ISO-8601 UTC.',
  run(artifact): QACheckResult {
    const r = safeParseSpec(artifact);
    if (!r.ok) return { pass: false, detail: 'unparseable', auto_fix_hint: 'fix yaml first' };
    const ts = getPath(r.doc, ['provenance', 'generated_at']);
    if (typeof ts !== 'string' || ts === '') {
      return { pass: false, detail: 'provenance.generated_at missing', auto_fix_hint: 'Stamp ISO-8601 UTC at fill time.' };
    }
    if (!ISO_8601_RE.test(ts)) {
      return {
        pass: false,
        detail: `provenance.generated_at=${JSON.stringify(ts)} is not ISO-8601`,
        auto_fix_hint: 'Use ISO-8601 UTC (e.g. 2026-05-15T12:34:56Z).',
      };
    }
    return { pass: true };
  },
};

const checkNoUnresolvedPlaceholders: QACheck = {
  id: 'no_unresolved_placeholders',
  type: 'static',
  description: 'No {{...}} survives in the spec body (template fully filled).',
  run(artifact): QACheckResult {
    // Skip comment lines so author-time docs inside the file (if any
    // survive the loader strip) don't false-positive.
    const offending: string[] = [];
    for (const line of artifact.split('\n')) {
      if (line.trimStart().startsWith('#')) continue;
      const m = line.match(/\{\{\s*\w+\s*\}\}/g);
      if (m) offending.push(...m);
    }
    if (offending.length === 0) return { pass: true };
    const dedup = Array.from(new Set(offending));
    return {
      pass: false,
      detail: `Unfilled placeholders: ${dedup.join(', ')}`,
      auto_fix_hint: `Provide a value for: ${dedup.join(', ')}. The substitution step missed these keys.`,
    };
  },
};

const checkImpactCount: QACheck = {
  id: 'impact_count_matches_template',
  type: 'static',
  description: 'impact[] has the exact count the template requires.',
  run(artifact): QACheckResult {
    const r = safeParseSpec(artifact);
    if (!r.ok) return { pass: false, detail: 'unparseable', auto_fix_hint: 'fix yaml first' };
    const rules = resolveTemplateRules(r.doc);
    if (!rules || rules.required_impact_count < 0) return { pass: true };
    const impact = r.doc.impact;
    if (!Array.isArray(impact)) {
      return { pass: false, detail: 'impact: is not a list', auto_fix_hint: 'Provide impact as a YAML list of {big, caption} entries.' };
    }
    if (impact.length !== rules.required_impact_count) {
      return {
        pass: false,
        detail: `impact has ${impact.length} entries; template requires ${rules.required_impact_count}`,
        auto_fix_hint: `Provide exactly ${rules.required_impact_count} impact entries (use "[TBD]" for unknowns rather than dropping).`,
      };
    }
    return { pass: true };
  },
};

const checkRequiredBeatsPresent: QACheck = {
  id: 'required_beats_present',
  type: 'static',
  description: 'narration.by_beat has every beat the template declares.',
  run(artifact): QACheckResult {
    const r = safeParseSpec(artifact);
    if (!r.ok) return { pass: false, detail: 'unparseable', auto_fix_hint: 'fix yaml first' };
    const rules = resolveTemplateRules(r.doc);
    if (!rules) return { pass: true };
    const byBeat = getPath(r.doc, ['narration', 'by_beat']);
    if (!byBeat || typeof byBeat !== 'object' || Array.isArray(byBeat)) {
      return { pass: false, detail: 'narration.by_beat missing or not a mapping', auto_fix_hint: 'Add narration.by_beat per the template skeleton.' };
    }
    const present = new Set(Object.keys(byBeat as Record<string, unknown>));
    const missing = rules.required_beats.filter((b) => !present.has(b));
    if (missing.length === 0) return { pass: true };
    return {
      pass: false,
      detail: `narration.by_beat is missing beats: ${missing.join(', ')}`,
      auto_fix_hint: `Add narration for: ${missing.join(', ')} (use empty string for cta).`,
    };
  },
};

const checkWordBudgets: QACheck = {
  id: 'narration_within_word_budgets',
  type: 'static',
  description: 'Each beat\'s narration is within the template\'s per-beat min/max word budget.',
  run(artifact): QACheckResult {
    const r = safeParseSpec(artifact);
    if (!r.ok) return { pass: false, detail: 'unparseable', auto_fix_hint: 'fix yaml first' };
    const rules = resolveTemplateRules(r.doc);
    if (!rules) return { pass: true };
    const byBeat = getPath(r.doc, ['narration', 'by_beat']);
    if (!byBeat || typeof byBeat !== 'object') return { pass: true };
    const beats = byBeat as Record<string, unknown>;
    const violations: string[] = [];
    for (const [beat, budget] of Object.entries(rules.word_budgets)) {
      const text = beats[beat];
      if (typeof text !== 'string') continue;
      const n = countWords(text);
      if (n < budget.min || n > budget.max) {
        violations.push(`${beat}=${n} words (budget ${budget.min}-${budget.max})`);
      }
    }
    if (violations.length === 0) return { pass: true };
    return {
      pass: false,
      detail: `Word-budget violations: ${violations.join('; ')}`,
      auto_fix_hint: 'Trim or expand each listed beat to fit its budget. Over-budget audio is cut mid-word at render time.',
    };
  },
};

const checkNoTbdInNarration: QACheck = {
  id: 'no_tbd_in_narration',
  type: 'static',
  description: 'No "[TBD]" tokens in narration.by_beat (they\'d be read aloud).',
  run(artifact): QACheckResult {
    const r = safeParseSpec(artifact);
    if (!r.ok) return { pass: false, detail: 'unparseable', auto_fix_hint: 'fix yaml first' };
    const byBeat = getPath(r.doc, ['narration', 'by_beat']);
    if (!byBeat || typeof byBeat !== 'object') return { pass: true };
    const offending: string[] = [];
    for (const [beat, text] of Object.entries(byBeat as Record<string, unknown>)) {
      if (typeof text === 'string' && /\[TBD\]/i.test(text)) {
        offending.push(beat);
      }
    }
    if (offending.length === 0) return { pass: true };
    return {
      pass: false,
      detail: `[TBD] tokens in narration beats: ${offending.join(', ')} — these would be read aloud as audio`,
      auto_fix_hint: 'Replace [TBD] markers in narration with real text. Use [TBD] only in titles/captions/sources where they\'re visible-only.',
    };
  },
};

const checkHookParaphrasesTagline: QACheck = {
  id: 'hook_paraphrases_connect_tagline',
  type: 'static',
  description: 'narration.by_beat.hook either contains Connect\'s tagline verbatim or shares a majority of its key tokens.',
  run(artifact): QACheckResult {
    const r = safeParseSpec(artifact);
    if (!r.ok) return { pass: false, detail: 'unparseable', auto_fix_hint: 'fix yaml first' };
    const hook = getPath(r.doc, ['narration', 'by_beat', 'hook']);
    if (typeof hook !== 'string') return { pass: true };
    const norm = hook.toLowerCase();
    if (norm.includes(CONNECT_TAGLINE.toLowerCase())) return { pass: true };
    const presentKey = TAGLINE_KEY_TOKENS.filter((tok) => norm.includes(tok));
    if (presentKey.length >= 3) return { pass: true };
    return {
      pass: false,
      detail: `hook="${hook}" doesn't paraphrase Connect's tagline ("${CONNECT_TAGLINE}"). Found ${presentKey.length}/4 key tokens (need 3+ or the verbatim line).`,
      auto_fix_hint: `Rewrite hook to paraphrase or quote: "${CONNECT_TAGLINE}". Key tokens: ${TAGLINE_KEY_TOKENS.join(', ')}.`,
    };
  },
};

const checkBannedVoiceTokens: QACheck = {
  id: 'no_banned_voice_tokens',
  type: 'static',
  description: 'Narration doesn\'t contain Connect\'s banned voice words (leverage, synergy, robust, etc.).',
  run(artifact): QACheckResult {
    const r = safeParseSpec(artifact);
    if (!r.ok) return { pass: false, detail: 'unparseable', auto_fix_hint: 'fix yaml first' };
    const byBeat = getPath(r.doc, ['narration', 'by_beat']);
    if (!byBeat || typeof byBeat !== 'object') return { pass: true };
    const violations: string[] = [];
    for (const [beat, text] of Object.entries(byBeat as Record<string, unknown>)) {
      if (typeof text !== 'string') continue;
      const lower = text.toLowerCase();
      for (const tok of BANNED_VOICE_TOKENS) {
        if (new RegExp(`\\b${tok}\\b`).test(lower)) {
          violations.push(`${beat}: "${tok}"`);
        }
      }
    }
    if (violations.length === 0) return { pass: true };
    return {
      pass: false,
      detail: `Banned marketing-voice tokens found: ${violations.join('; ')}`,
      auto_fix_hint: 'Rewrite to documentary lower-third style: concrete nouns, numbers over adjectives, active voice.',
    };
  },
};

const checkVoiceConfig: QACheck = {
  id: 'voice_config_valid',
  type: 'static',
  description: 'voice.provider, voice_id, model are all set.',
  run(artifact): QACheckResult {
    const r = safeParseSpec(artifact);
    if (!r.ok) return { pass: false, detail: 'unparseable', auto_fix_hint: 'fix yaml first' };
    const v = r.doc.voice;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return { pass: false, detail: 'voice: missing or not a mapping', auto_fix_hint: 'Restore voice: {provider, voice_id, model} from the skeleton.' };
    }
    const obj = v as Record<string, unknown>;
    const missing = ['provider', 'voice_id', 'model'].filter(
      (k) => typeof obj[k] !== 'string' || (obj[k] as string).trim() === '',
    );
    if (missing.length === 0) return { pass: true };
    return {
      pass: false,
      detail: `voice.${missing.join(', voice.')} missing or empty`,
      auto_fix_hint: 'Restore voice.* fields from the template skeleton.',
    };
  },
};

const checkSpecHasRenderableClips: QACheck = {
  id: 'spec_has_renderable_clips',
  type: 'static',
  description: 'spec references at least one clip in either scene.clips or product.beats (Remotion requires non-empty arrays).',
  run(artifact): QACheckResult {
    const r = safeParseSpec(artifact);
    if (!r.ok) return { pass: false, detail: 'unparseable', auto_fix_hint: 'fix yaml first' };
    const sceneClips = getPath(r.doc, ['scene', 'clips']);
    const productBeats = getPath(r.doc, ['product', 'beats']);
    const sceneCount = Array.isArray(sceneClips) ? sceneClips.length : 0;
    const productCount = Array.isArray(productBeats) ? productBeats.length : 0;
    if (sceneCount > 0 || productCount > 0) return { pass: true };
    return {
      pass: false,
      detail: 'Both scene.clips and product.beats are empty — the Remotion render aborts on empty clip arrays.',
      auto_fix_hint: 'Either attach footage to manifest: + reference it from scene.clips[] and/or product.beats[], OR populate manifest_todo: with proposed aliases for the operator to hand-attach before render.',
    };
  },
};

const checkSpecManifestRefsResolvable: QACheck = {
  id: 'spec_manifest_refs_resolvable',
  type: 'static',
  description: 'Every @alias used in scene.clips or product.beats has a matching entry in manifest:.',
  run(artifact): QACheckResult {
    const r = safeParseSpec(artifact);
    if (!r.ok) return { pass: false, detail: 'unparseable', auto_fix_hint: 'fix yaml first' };
    const manifest = r.doc.manifest;
    const manifestKeys = new Set(
      manifest && typeof manifest === 'object' && !Array.isArray(manifest)
        ? Object.keys(manifest as Record<string, unknown>)
        : [],
    );
    const sceneClips = getPath(r.doc, ['scene', 'clips']);
    const productBeats = getPath(r.doc, ['product', 'beats']);
    const referenced: string[] = [];
    if (Array.isArray(sceneClips)) {
      for (const c of sceneClips) {
        if (typeof c === 'string' && c.startsWith('@')) referenced.push(c.slice(1));
      }
    }
    if (Array.isArray(productBeats)) {
      for (const b of productBeats) {
        const asset = (b as Record<string, unknown>)?.asset;
        if (typeof asset === 'string' && asset.startsWith('@')) referenced.push(asset.slice(1));
      }
    }
    const missing = Array.from(new Set(referenced.filter((alias) => !manifestKeys.has(alias))));
    if (missing.length === 0) return { pass: true };
    return {
      pass: false,
      detail: `@aliases referenced but not in manifest: ${missing.map((m) => '@' + m).join(', ')}`,
      auto_fix_hint: `Add manifest entries for: ${missing.join(', ')}. Format: <alias>: gdrive:<file-id>.<ext>`,
    };
  },
};

// ── Canonical CHECKS array ─────────────────────────────────────────

export const CHECKS: QACheck[] = [
  checkSpecYamlParses,
  checkRequiredTopLevelFields,
  checkSlugFormat,
  checkProvenanceBlockPresent,
  checkProvenanceTimestampValid,
  checkNoUnresolvedPlaceholders,
  checkImpactCount,
  checkRequiredBeatsPresent,
  checkWordBudgets,
  checkNoTbdInNarration,
  checkHookParaphrasesTagline,
  checkBannedVoiceTokens,
  checkVoiceConfig,
  checkSpecHasRenderableClips,
  checkSpecManifestRefsResolvable,
];
