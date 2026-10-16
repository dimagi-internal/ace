/**
 * ace#2693: on APK 2.64.0 the one-row day fling (`dayStepFlingYaml`, ace#2518)
 * was a silent no-op when issued straight after a constraint refusal, and
 * landed once the refusal had settled (spark-facilitator/20261004-1706:
 * no-op dispatch 1791201121968-7qzewb, pass 1791202061636-24lmor). The
 * composition guidance in app-test-cases must keep the settle + guarded retry,
 * and must not change the emitted gesture itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dayStepFlingYaml } from '../../lib/date-picker-drive';

const skill = readFileSync(
  fileURLToPath(new URL('../../skills/app-test-cases/SKILL.md', import.meta.url)),
  'utf8',
);

describe('date fling after a constraint refusal settles first and retries once (ace#2693)', () => {
  const start = skill.indexOf('**Flinging AFTER a constraint refusal');
  const section = skill.slice(start, skill.indexOf('\n\n', skill.indexOf('composition around it', start)));
  const block = section.match(/```yaml\n([\s\S]*?)```/)?.[1] ?? '';

  it('the section exists and cites the issue + passing dispatch', () => {
    expect(start).toBeGreaterThan(-1);
    expect(section).toMatch(/ace#2693/);
    expect(section).toMatch(/1791202061636-24lmor/);
  });

  it('orders: refusal assert -> settle wait -> fling -> refusal-guarded retry', () => {
    const assertIdx = block.indexOf('assertVisible');
    const settleIdx = block.indexOf('timeout: 3000');
    const flingIdx = block.indexOf('dayStepFlingYaml()');
    const retryIdx = block.indexOf('runFlow:');
    expect(assertIdx).toBeGreaterThan(-1);
    expect(settleIdx).toBeGreaterThan(assertIdx);
    expect(flingIdx).toBeGreaterThan(settleIdx);
    expect(retryIdx).toBeGreaterThan(flingIdx);
    expect(block.slice(retryIdx)).toMatch(/when:\s*\n\s*visible:/);
    expect(block.slice(retryIdx)).toMatch(/dayStepFlingYaml\(\)/);
  });

  it('the emitted gesture is unchanged (composition, not a new swipe)', () => {
    expect(dayStepFlingYaml()).toBe(
      ['- swipe:', '    start: 529, 968', '    end: 529, 818', '    duration: 600'].join('\n'),
    );
  });
});
