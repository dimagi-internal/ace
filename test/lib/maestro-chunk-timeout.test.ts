import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  resolveChunkTimeout, countRecipeSteps,
  FLOOR_MS, PER_STEP_MS, CEILING_MS, ENV_OVERRIDE,
} from '../../lib/maestro-chunk-timeout.js';

describe('resolveChunkTimeout', () => {
  it('never returns less than the historical flat budget', () => {
    for (const stepCount of [undefined, 0, -5, 1, 10, 30]) {
      expect(resolveChunkTimeout({ stepCount, env: {} }).timeoutMs).toBeGreaterThanOrEqual(FLOOR_MS);
    }
  });

  it('degrades to the floor when the step count is unknown or nonsense', () => {
    for (const stepCount of [undefined, 0, -1, NaN, Infinity]) {
      const r = resolveChunkTimeout({ stepCount: stepCount as number, env: {} });
      expect(r.timeoutMs).toBe(FLOOR_MS);
      expect(r.basis).toBe('floor');
    }
  });

  it('scales past the floor for a long chunk', () => {
    const r = resolveChunkTimeout({ stepCount: 97, env: {} });
    expect(r.basis).toBe('scaled');
    expect(r.timeoutMs).toBe(97 * PER_STEP_MS);
    expect(r.stepCount).toBe(97);
  });

  it('caps at the ceiling — an unbounded wait is worse than a loud failure (ace#1164)', () => {
    const r = resolveChunkTimeout({ stepCount: 100_000, env: {} });
    expect(r.basis).toBe('ceiling');
    expect(r.timeoutMs).toBe(CEILING_MS);
  });

  it('honours a well-formed env override outright', () => {
    const r = resolveChunkTimeout({ stepCount: 97, env: { [ENV_OVERRIDE]: '1234' } });
    expect(r.basis).toBe('env-override');
    expect(r.timeoutMs).toBe(1234);
  });

  it('IGNORES a malformed override rather than disarming the watchdog', () => {
    for (const bad of ['0', '-1', 'abc', '1.5', '', 'Infinity']) {
      const r = resolveChunkTimeout({ stepCount: 97, env: { [ENV_OVERRIDE]: bad } });
      expect(r.timeoutMs).toBeGreaterThanOrEqual(FLOOR_MS);
      expect(r.basis).not.toBe('env-override');
    }
  });

  // The regression this file exists for.
  it('gives a 97-step Learn journey more than the ~13 min it actually needed (ace#1570)', () => {
    // hh-poverty-targeting/20260819-1435: journey-learn ran as chunk 1/1, was
    // still advancing at ~11s/step, and was killed at exactly 600s having
    // banked 5 of 6 modules of a ONE-WAY precondition.
    const needed = 97 * 11_000; // ~17.8 min at the measured cadence
    const { timeoutMs } = resolveChunkTimeout({ stepCount: 97, env: {} });
    expect(timeoutMs).toBeGreaterThan(needed);
    expect(FLOOR_MS).toBeLessThan(needed); // the old flat budget did not
  });
});

describe('countRecipeSteps', () => {
  it('counts top-level flow steps, not header lines or nested keys', () => {
    const body = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: connect-login.yaml',
      '    env:',
      '      PIN: "111111"',
      '- takeScreenshot: "a"',
      '- tapOn:',
      '    text: "x"',
    ].join('\n');
    expect(countRecipeSteps(body)).toBe(3);
  });

  it('never throws on a malformed body — a bad count only sizes a timeout', () => {
    for (const body of ['', 'no separator here', '---', '- \n- \n']) {
      expect(() => countRecipeSteps(body)).not.toThrow();
      expect(countRecipeSteps(body)).toBeGreaterThanOrEqual(0);
    }
  });

  it('counts the real shipped palette recipes as multi-step', () => {
    const dir = path.join(process.cwd(), 'mcp/mobile/recipes/static');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(countRecipeSteps(fs.readFileSync(path.join(dir, f), 'utf8'))).toBeGreaterThan(0);
    }
  });
});
