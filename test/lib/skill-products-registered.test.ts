import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest';

/**
 * Every run-folder path a skill declares under its OWN `## Products` heading
 * is registered in `lib/artifact-manifest.ts` (ace#2183).
 *
 * `3-commcare/app-release_summary.md` was declared by `app-release § Products`,
 * read by `app-release-eval` as the sole source for 55% of its weight and by
 * `llo-launch`'s freshness gate — and absent from the manifest, so
 * `verify_phase_artifacts(commcare)` could not see it and the Phase 3 fence
 * never noticed it missing (`poverty-graduation/20260905-1345`). ace#2142 was
 * the same class from the other side: the skill wrote `_report-<date>.md`
 * while the manifest registered `_report.md`.
 *
 * Scope: a product line of the form `` - `<N>-<phase>/<file>` `` (optionally
 * prefixed `ACE/<opp>/runs/<run-id>/`) whose path is LITERAL. Placeholder
 * paths (`<app>`, `<mode>`), `run_state.yaml.*` keys, opp-level and sweep
 * paths are out of scope — the manifest spells most placeholders out per
 * value and a literal comparison cannot match them.
 */

const SKILLS_DIR = join(__dirname, '..', '..', 'skills');

/** Literal products not registered, each with the reason it is exempt. */
const UNREGISTERED_BY_DESIGN = new Map<string, string>([
  [
    '7-synthetic/semantic-registry-author_layer1.json',
    'QA-input sidecar (ace#2883); `layer1` is not a ROLE_VOCAB role — register it with the vocabulary when a fence needs it',
  ],
  [
    '7-synthetic/synthetic-data-generate_error.md',
    'written INSTEAD of the summary on INVALID_SCHEMA — a failure record, never an expected phase product',
  ],
]);

const PRODUCTS_SECTION = /^## Products\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m;
const RUN_PREFIX = /^(ACE\/<opp(?:-name)?>\/)?runs\/<run-id>\//;

function literalProductPaths(skillMd: string): string[] {
  const m = skillMd.match(PRODUCTS_SECTION);
  if (!m) return [];
  const out: string[] = [];
  for (const line of m[1].split('\n')) {
    const lm = line.match(/^[-*] `([^`]+)`/);
    if (!lm) continue;
    const p = lm[1].replace(RUN_PREFIX, '');
    if (!/^\d+-[a-z-]+\//.test(p) || p.includes('<')) continue;
    out.push(p);
  }
  return out;
}

function unregistered(): string[] {
  const registered = new Set(ARTIFACT_MANIFEST.map((a) => a.path));
  const misses: string[] = [];
  for (const dir of readdirSync(SKILLS_DIR)) {
    const f = join(SKILLS_DIR, dir, 'SKILL.md');
    if (!existsSync(f)) continue;
    for (const p of literalProductPaths(readFileSync(f, 'utf8'))) {
      if (!registered.has(p) && !UNREGISTERED_BY_DESIGN.has(p)) misses.push(`${dir}: ${p}`);
    }
  }
  return misses;
}

describe('every literal skill product is in the artifact manifest (ace#2183)', () => {
  it('extracts only literal run-folder paths from the Products section', () => {
    const md = [
      '# x', '', '## Inputs', '- `3-commcare/not-a-product.md`', '',
      '## Products', '',
      '- `3-commcare/app-release_summary.md` — released builds',
      '- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-faq.md`',
      '- `3-commcare/thing_<app>.md` — placeholder, out of scope',
      '- `run_state.yaml.phases.x.products` — a key, out of scope',
      '', '## Process', '- `3-commcare/later.md`',
    ].join('\n');
    expect(literalProductPaths(md)).toEqual([
      '3-commcare/app-release_summary.md',
      '6-qa-and-training/training-faq.md',
    ]);
  });

  it('NEGATIVE CONTROL: the ace#2183 shape — a declared product the manifest lacks — is reported', () => {
    const registered = new Set(
      ARTIFACT_MANIFEST.map((a) => a.path).filter((p) => p !== '3-commcare/app-release_summary.md'),
    );
    const md = readFileSync(join(SKILLS_DIR, 'app-release', 'SKILL.md'), 'utf8');
    const misses = literalProductPaths(md).filter((p) => !registered.has(p));
    expect(misses).toEqual(['3-commcare/app-release_summary.md']);
  });

  it('no skill declares a literal product the manifest does not register', () => {
    expect(unregistered(), 'register the path in lib/artifact-manifest.ts (or exempt it with a reason)').toEqual([]);
  });

  it('keeps the exemption list honest — every exempt path is still declared and still unregistered', () => {
    const registered = new Set(ARTIFACT_MANIFEST.map((a) => a.path));
    const declared = new Set<string>();
    for (const dir of readdirSync(SKILLS_DIR)) {
      const f = join(SKILLS_DIR, dir, 'SKILL.md');
      if (existsSync(f)) for (const p of literalProductPaths(readFileSync(f, 'utf8'))) declared.add(p);
    }
    for (const p of UNREGISTERED_BY_DESIGN.keys()) {
      expect(declared.has(p), `${p} is no longer declared — drop the exemption`).toBe(true);
      expect(registered.has(p), `${p} is now registered — drop the exemption`).toBe(false);
    }
  });
});
