import { describe, it, expect } from 'vitest';
import {
  classifyVisitCache,
  assertSafeToRegenerate,
  type LabsOpportunityDataDescription,
} from '../../lib/labs-visit-cache.js';

/**
 * The controls are the two REAL reads taken 2026-11-18 on thread
 * 1a1691a41973d718, seconds apart, against the same opportunity — the pair that
 * proves a zero means nothing on its own (ace#3436).
 */

/** data_describe({opportunity_ids:[10174]}) — no load_missing. */
const COLD: LabsOpportunityDataDescription = {
  opportunity_id: 10174,
  opportunity_name: '[Synthetic] Inline chlorination demo',
  cached_visits: 0,
  cached_at: null,
  latest_visit_date: null,
};

/** data_describe({opportunity_ids:[10174], load_missing:true}) — same opp, same minute. */
const WARM: LabsOpportunityDataDescription = {
  opportunity_id: 10174,
  opportunity_name: '[Synthetic] Inline chlorination demo',
  cached_visits: 144,
  cached_at: '2026-11-18T15:25:52.076476+00:00',
  latest_visit_date: '2026-10-23',
};

/** An opportunity that really holds nothing, read WITH load_missing. */
const GENUINELY_EMPTY: LabsOpportunityDataDescription = {
  opportunity_id: 99999,
  opportunity_name: 'Never generated',
  cached_visits: 0,
  cached_at: null,
  latest_visit_date: null,
};

describe('classifyVisitCache', () => {
  it('calls an un-reloaded zero cache-cold, never data-absent', () => {
    const result = classifyVisitCache(COLD, false);
    expect(result.verdict).toBe('cache-cold');
    expect(result.regenerationWouldBeUnsafe).toBe(true);
    expect(result.nextStep).toContain('load_missing');
  });

  it('sees the data once the same opportunity is read with load_missing', () => {
    const result = classifyVisitCache(WARM, true);
    expect(result.verdict).toBe('data-present');
    expect(result.cachedVisits).toBe(144);
  });

  it('still calls a non-zero cache data-present when load_missing was not set', () => {
    const result = classifyVisitCache(WARM, false);
    expect(result.verdict).toBe('data-present');
  });

  it('only calls the store empty after a load_missing read returns nothing', () => {
    const result = classifyVisitCache(GENUINELY_EMPTY, true);
    expect(result.verdict).toBe('data-absent');
    expect(result.regenerationWouldBeUnsafe).toBe(false);
  });

  it('the control pair disagrees — which is the whole point', () => {
    // Same opportunity, seconds apart. If these ever classify the same way the
    // guard has stopped distinguishing a cold cache from lost data.
    expect(classifyVisitCache(COLD, false).verdict).not.toBe(
      classifyVisitCache(WARM, true).verdict,
    );
  });
});

describe('assertSafeToRegenerate', () => {
  it('refuses the 2026-11-16 regeneration: a cold cache read without load_missing', () => {
    expect(() => assertSafeToRegenerate(COLD, false)).toThrow(/cache-cold/);
    expect(() => assertSafeToRegenerate(COLD, false)).toThrow(/ace#3436/);
  });

  it('refuses to regenerate over data that is present', () => {
    expect(() => assertSafeToRegenerate(WARM, true)).toThrow(/data-present/);
  });

  it('permits a regeneration the store has actually earned', () => {
    expect(() => assertSafeToRegenerate(GENUINELY_EMPTY, true)).not.toThrow();
  });
});
