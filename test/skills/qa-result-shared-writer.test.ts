/**
 * Every skill that writes a `*-qa_result.yaml` goes through the shared writer.
 *
 * Two gates hand-rolled their result shapes — demo-data-setup-qa on
 * bednet-check-2-visit/20260908-1544 and semantic-registry-author-qa on
 * spark-facilitator/20260926-1800 — and ace-web read both as "Passed (0/0
 * checks)". ace-gdrive now refuses a non-canonical write
 * (lib/qa-result-write-guard.ts); this keeps every skill's instructions
 * pointing at the path that lands, so a new -qa skill cannot be authored
 * against a shape the guard will refuse.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest';

const SKILLS = join(__dirname, '../../skills');
const SHARED = /scripts\/qa-result\.ts|aggregateQAResult/;

function writers(): string[] {
  const out = new Set<string>();
  for (const a of ARTIFACT_MANIFEST) if (/-qa_result\.ya?ml$/.test(a.path)) out.add(a.producedBy);
  for (const d of readdirSync(SKILLS)) {
    const p = join(SKILLS, d, 'SKILL.md');
    if (d.endsWith('-qa') && existsSync(p) && /-qa_result\.ya?ml/.test(readFileSync(p, 'utf8'))) out.add(d);
  }
  return [...out].sort();
}

describe('QA results go through the shared writer', () => {
  it('finds the writers', () => {
    expect(writers()).toEqual(expect.arrayContaining(['demo-data-setup-qa', 'semantic-registry-author-qa', 'idea-to-pdd-qa']));
  });

  it('every -qa_result writer names scripts/qa-result.ts or aggregateQAResult', () => {
    const missing = writers().filter((s) => {
      const p = join(SKILLS, s, 'SKILL.md');
      return !existsSync(p) || !SHARED.test(readFileSync(p, 'utf8'));
    });
    expect(missing, 'author the result through scripts/qa-result.ts (skills/_qa-template.md § QA result YAML contract)').toEqual([]);
  });
});
