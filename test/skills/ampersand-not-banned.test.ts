/**
 * ace#2150 — the build briefs banned `&` from label text ("write them out as
 * words instead of relying on entity encoding to land"). The ban had no
 * reproducer, and it rewrote partner-published vocabulary: Spark's FCAP step
 * names ("Community Dynamics, Governance & Leadership") shipped as "... and
 * ...", which `entity_state_fidelity` correctly hard-gates as a relabelled
 * state. Verified on spark-facilitator/20260925-1536: a Deliver label carrying
 * `&` compiled to `&amp;`, HQ `make_build` succeeded (build 03ac3d27…, v8) and
 * the form XML parses. The `<` / `>` half of the rule is real and stays.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\n\s*>\s?/g, ' ').replace(/\s+/g, ' ');

describe('build briefs do not ban `&` in label text (ace#2150)', () => {
  for (const skill of ['skills/pdd-to-learn-app/SKILL.md', 'skills/pdd-to-deliver-app/SKILL.md']) {
    it(`${skill} keeps the angle-bracket ban but not an ampersand ban`, () => {
      const src = read(skill);
      expect(src).not.toMatch(/Same rule for `&`/);
      expect(src).toMatch(/`&` is NOT restricted/);
      expect(src).toMatch(/ace#2150/);
      // The real half of the rule survives.
      expect(src).toMatch(/Do NOT use literal `<` or `>`/);
    });
  }
});
