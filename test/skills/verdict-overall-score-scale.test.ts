/**
 * Every verdict's `overall_score` (and dimension score) is on 0–10 —
 * lib/verdict-schema.ts `overall_score: z.number().min(0).max(10)` — because
 * ace-web and opp-eval read one uniform shape and render ×10 as /100.
 *
 * Two skills documented their shallow/quick verdict with a 0–3 judge mean
 * written straight into overall_score. spark-facilitator/20260925-1536's
 * shallow smoke (learn 3, deliver 2 → 2.5/3, good) showed on the Workbench
 * as a red "25/100" (ace#2563). Judges may rate 0–3; per_item scores may stay there;
 * the rolled-up fields may not.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS = join(__dirname, '..', '..', 'skills');

describe('verdict overall_score is documented on the 0–10 scale', () => {
  for (const dir of readdirSync(SKILLS)) {
    let text: string;
    try { text = readFileSync(join(SKILLS, dir, 'SKILL.md'), 'utf8'); } catch { continue; }
    const offenders = text
      .split('\n')
      .filter((l) => /^\s*overall_score:/.test(l) && /\b0\s*[-–]\s*3\b/.test(l) && !/normali[sz]ed/i.test(l));
    it(`${dir}: no overall_score documented on a 0–3 scale`, () => {
      expect(offenders).toEqual([]);
    });
  }
});
