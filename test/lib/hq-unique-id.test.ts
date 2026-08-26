/**
 * dimagi-internal/ace#1644 — CCHQ `unique_id` widths.
 *
 * `commcare_patch_xform` and `commcare_get_form_source` pinned
 * `^[0-9a-f]{32}$` on `form_unique_id`. That is a PREDICTIVE GUARD: HQ itself
 * accepts the 40-hex form uid it hands back after a Nova `upload_app_to_hq`
 * (`edit_form_attr` returned 200 for `0a77a471…` on
 * hh-poverty-targeting/20260824-1404), and ACE refused it before making the
 * request. The sibling `commcare_set_menu_display` had already been widened,
 * which is what makes the two-out-of-three shape the real defect.
 *
 * The pattern has to stay a REAL constraint: the failure it guards against is
 * an `m0-f0` index or a truncated id reaching a URL path, where HQ answers
 * with a confusing 404 instead of a validation error.
 */
import { describe, it, expect } from 'vitest';
import { HQ_UNIQUE_ID_RE, HQ_UNIQUE_ID_HINT, isHqUniqueId, hqUniqueIdWidth } from '../../lib/hq-unique-id.js';

// The two ids observed on ONE form across a single upload_app_to_hq.
const UID_32 = '7467e11c9cd746b2abe85dfd6de329a8';
const UID_40 = '0a77a47110ab1265ac3d240347f2c017451c02fd';

describe('HQ_UNIQUE_ID_RE accepts both live widths', () => {
  it('accepts the 32-hex (uuid4) form uid', () => {
    expect(UID_32).toHaveLength(32);
    expect(HQ_UNIQUE_ID_RE.test(UID_32)).toBe(true);
    expect(isHqUniqueId(UID_32)).toBe(true);
    expect(hqUniqueIdWidth(UID_32)).toBe(32);
  });

  it('accepts the 40-hex (SHA-1) uid HQ hands back after a Nova re-upload', () => {
    expect(UID_40).toHaveLength(40);
    expect(HQ_UNIQUE_ID_RE.test(UID_40)).toBe(true);
    expect(isHqUniqueId(UID_40)).toBe(true);
    expect(hqUniqueIdWidth(UID_40)).toBe(40);
  });

  it('accepts a real 40-hex module uid (already-widened sibling atom)', () => {
    expect(isHqUniqueId('6f3d3ad3ed9d44e5b4107c0a1210dd10cafe1234')).toBe(true);
  });
});

describe('HQ_UNIQUE_ID_RE is still a real constraint', () => {
  const rejected: [string, string][] = [
    ['m/f index', 'm0-f0'],
    ['module/form path', 'modules-0/forms-0.xml'],
    ['31 hex (truncated)', '7467e11c9cd746b2abe85dfd6de329a'],
    ['33 hex', UID_32 + 'a'],
    ['39 hex', UID_40.slice(0, 39)],
    ['41 hex', UID_40 + 'a'],
    ['36-char dashed uuid', '7467e11c-9cd7-46b2-abe8-5dfd6de329a8'],
    ['uppercase hex', UID_32.toUpperCase()],
    ['non-hex of the right length', 'z'.repeat(32)],
    ['empty', ''],
  ];

  it.each(rejected)('rejects %s', (_label, value) => {
    expect(HQ_UNIQUE_ID_RE.test(value)).toBe(false);
    expect(isHqUniqueId(value)).toBe(false);
    expect(hqUniqueIdWidth(value)).toBeNull();
  });

  it('rejects arbitrary intermediate widths — 32 or 40, nothing between', () => {
    for (let n = 33; n < 40; n++) {
      expect(isHqUniqueId('a'.repeat(n)), `${n} hex chars must not be accepted`).toBe(false);
    }
  });

  it('rejects non-strings', () => {
    for (const v of [null, undefined, 32, {}, []]) {
      expect(isHqUniqueId(v)).toBe(false);
      expect(hqUniqueIdWidth(v)).toBeNull();
    }
  });
});

describe('the error message describes BOTH shapes and their origins', () => {
  it('names each width and where it comes from', () => {
    expect(HQ_UNIQUE_ID_HINT).toMatch(/32-hex/);
    expect(HQ_UNIQUE_ID_HINT).toMatch(/40-hex/);
    expect(HQ_UNIQUE_ID_HINT).toMatch(/suite\.xml|delete_form/);
    expect(HQ_UNIQUE_ID_HINT).toMatch(/upload_app_to_hq/);
  });
});
