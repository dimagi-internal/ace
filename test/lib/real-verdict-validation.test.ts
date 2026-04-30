import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseVerdictYaml } from '../../lib/parse-verdict.js';

// Producer-side preventer for the drift turmeric exposed (verdict: blocked,
// missing weight on dimensions, off-enum mode values, etc.). The 0.10.13
// preventer covers SKILL.md examples; this one covers actual verdict YAML
// files that get checked into the repo as fixtures.
//
// On a real opp run, operators can run the same parseVerdictYaml utility
// against ACE/<opp>/verdicts/*.yaml after fetching from Drive — the test
// here pins the contract.

function findVerdictYamls(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile() && entry.name.endsWith('.yaml') && dir.endsWith('verdicts')) {
        out.push(p);
      }
    }
  }
  walk(root);
  return out.sort();
}

describe('real verdict file validation', () => {
  const fixturesRoot = join(process.cwd(), 'test', 'fixtures');
  const verdictFiles = findVerdictYamls(fixturesRoot);

  it('discovers checked-in verdict fixtures', () => {
    // Sanity: verdict-folder discovery walk works.
    expect(verdictFiles.length).toBeGreaterThan(0);
  });

  for (const file of verdictFiles) {
    const rel = file.replace(`${process.cwd()}/`, '');
    it(`${rel} parses and validates against the schema`, () => {
      const source = readFileSync(file, 'utf8');
      const r = parseVerdictYaml(source);
      if (!r.ok) {
        throw new Error(
          `Verdict drift in ${rel}:\n  ` +
            r.errors.join('\n  ') +
            `\n\nFix the producer skill (or this fixture) to conform to ` +
            `lib/verdict-schema.ts. If the schema needs to evolve, bump ` +
            `SCHEMA_VERSION and update tests.`,
        );
      }
      expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    });
  }
});

describe('parseVerdictYaml', () => {
  it('rejects an empty input', () => {
    const r = parseVerdictYaml('');
    expect(r.ok).toBe(false);
  });

  it('reports YAML parse errors with parseError field', () => {
    const r = parseVerdictYaml('skill: foo\n  invalid: indent');
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('yaml parse:'))).toBe(true);
  });

  it('catches missing weight on a dimension (the canonical drift class)', () => {
    const yaml = [
      'skill: ocs-chatbot-eval',
      'target: 12027',
      'mode: deep',
      'ran_at: 2026-04-29T22:25:00Z',
      'capture_path: qa-captures/x.md',
      'overall_score: 8.7',
      'verdict: pass',
      'dimensions:',
      '  correctness:',
      '    score: 9',
      '    notes: |',
      '      Missing weight — schema should reject this.',
    ].join('\n');
    const r = parseVerdictYaml(yaml);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /weight/.test(e))).toBe(true);
  });

  it('rejects verdict: blocked (off-enum)', () => {
    const yaml = [
      'skill: app-screenshot-capture',
      'target: turmeric',
      'ran_at: 2026-04-29T22:45:00Z',
      'capture_path: phase5-block.md',
      'overall_score: 0',
      'verdict: blocked',
      'dimensions:',
      '  coverage: { score: 0, weight: 1.0 }',
    ].join('\n');
    const r = parseVerdictYaml(yaml);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /verdict/.test(e))).toBe(true);
  });

  it('accepts a clean schema-conforming verdict', () => {
    const yaml = [
      'skill: ocs-chatbot-eval',
      'target: 12027',
      'mode: deep',
      'ran_at: 2026-04-29T22:25:00Z',
      'capture_path: qa-captures/x.md',
      'overall_score: 8.7',
      'verdict: pass',
      'dimensions:',
      '  correctness:  { score: 9.0, weight: 0.4 }',
      '  source_usage: { score: 9.0, weight: 0.3 }',
      '  tone:         { score: 9.0, weight: 0.2 }',
      '  tagging:      { score: 8.0, weight: 0.1 }',
    ].join('\n');
    const r = parseVerdictYaml(yaml);
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  });

  it('accepts opp-eval partial-coverage with null dimension scores', () => {
    const yaml = [
      'skill: opp-eval',
      'target: turmeric',
      'mode: deep',
      'ran_at: 2026-04-29T22:30:00Z',
      'capture_path: verdicts/',
      'overall_score: 8.4',
      'verdict: pass',
      'dimensions:',
      '  design:    { score: null, weight: 0.20 }',
      '  commcare:  { score: null, weight: 0.20 }',
      '  connect:   { score: null, weight: 0.15 }',
      '  ocs:       { score: 8.4,  weight: 0.20 }',
      '  operate:   { score: null, weight: 0.15 }',
      '  closeout:  { score: null, weight: 0.10 }',
    ].join('\n');
    const r = parseVerdictYaml(yaml);
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  });
});
