/**
 * Pins the Phase 3 ordering the lint gate depends on (workstream B,
 * 2026-10-16): build → `nova-app-lint` → `app-connect-coverage` → re-lint →
 * LLM evals, with the repair policy stated where the agent reads it. Prose
 * order is the only thing that dispatches these steps, so a reorder that puts
 * the evals back at Step 1 would silently reinstate the eval-found-blocker
 * loop (three ~15-min Deliver passes on smallholder-seasonal/20261015-1402).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const agent = read('agents/commcare-setup.md');

describe('Phase 3 lint gate ordering', () => {
  it('Step 1.4 (lint) precedes Step 1.5 (coverage) precedes Step 1.6 (evals) precedes Step 1.7', () => {
    const i14 = agent.indexOf('### Step 1.4: Deterministic lint gate');
    const i15 = agent.indexOf('### Step 1.5: Connect-marker coverage');
    const i16 = agent.indexOf('### Step 1.6: LLM evals');
    const i17 = agent.indexOf('### Step 1.7: Media coverage');
    expect(i14).toBeGreaterThan(0);
    expect(i14).toBeLessThan(i15);
    expect(i15).toBeLessThan(i16);
    expect(i16).toBeLessThan(i17);
  });

  it('Step 1 no longer dispatches the evals itself', () => {
    const step1 = agent.slice(agent.indexOf('### Step 1: PDD to Apps'), agent.indexOf('### Step 1.4'));
    expect(step1).not.toMatch(/dispatch\s+`pdd-to-learn-app-eval` after the Learn build/);
    expect(step1).toContain('Step 1.6');
  });

  it('the gate, the re-lint after coverage, and the repair policy are stated', () => {
    const s14 = agent.slice(agent.indexOf('### Step 1.4'), agent.indexOf('### Step 1.5'));
    expect(s14).toContain('scripts/nova-app-lint.ts');
    expect(s14).toMatch(/No LLM eval .* is dispatched for an app\s+until its lint exits 0/);
    expect(s14).toMatch(/Never run a repair round on a warn/);
    expect(s14).toMatch(/re-lint instead of\s+re-running the LLM eval/);
    const s15 = agent.slice(agent.indexOf('### Step 1.5'), agent.indexOf('### Step 1.6'));
    expect(s15).toMatch(/re-run the Step 1.4 lint after it/);
  });

  it('both evals run the lint first and both builders gate on it', () => {
    for (const p of ['skills/pdd-to-deliver-app-eval/SKILL.md', 'skills/pdd-to-learn-app-eval/SKILL.md']) {
      expect(read(p)).toMatch(/Run the deterministic lint FIRST/);
    }
    expect(read('skills/pdd-to-deliver-app/SKILL.md')).toMatch(/Exit gate — `nova-app-lint` must exit 0/);
    expect(read('skills/pdd-to-learn-app/SKILL.md')).toMatch(/Exit gate — `nova-app-lint` must exit 0/);
  });

  it('the script the prose names exists', () => {
    expect(existsSync(join(ROOT, 'scripts/nova-app-lint.ts'))).toBe(true);
  });
});
