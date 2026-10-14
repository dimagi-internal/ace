import { describe, it, expect } from 'vitest';
import {
  planLevelsPayload,
  classifyLevelReadback,
  apiParentCode,
  buildLocationAssignment,
  type PageLevel,
  type WantedLevel,
} from '../../lib/hq-location-types.js';

const page = (over: Partial<PageLevel> & { pk: number; code: string; name: string }): PageLevel => ({
  parent_type: null,
  administrative: true,
  shares_cases: false,
  view_descendants: false,
  expand_from: null,
  expand_from_root: false,
  expand_to: null,
  expand_view_child_data_to: null,
  has_users_setting: true,
  include_without_expanding: null,
  include_only: [],
  ...over,
});

const AREA: WantedLevel = { code: 'area', name: 'Area', parent_code: null, owns_cases: false, view_descendants: true };
const FLW: WantedLevel = { code: 'flw_place', name: 'FLW place', parent_code: 'area', owns_cases: true, view_descendants: false };

describe('planLevelsPayload — HQ\'s level POST is a full replace', () => {
  it('never drops a level that is already on the space (it would be deleted)', () => {
    const existing = [
      page({ pk: 7, code: 'district', name: 'District', shares_cases: true, expand_to: 7, include_only: [7] }),
    ];
    const plan = planLevelsPayload(existing, [AREA, FLW]);
    const district = plan.payload.loc_types.find((l) => l.code === 'district')!;
    expect(district).toBeDefined();
    expect(district.pk).toBe(7);
    expect(district.shares_cases).toBe(true);
    expect(district.expand_to).toBe(7); // sync boundary round-tripped, not reset
    expect(plan.preserved).toEqual(['district']);
    expect(plan.created.sort()).toEqual(['area', 'flw_place']);
  });

  it('renames page `has_users_setting` to the POST\'s `has_users`', () => {
    const plan = planLevelsPayload([page({ pk: 1, code: 'x', name: 'X', has_users_setting: false })], [AREA]);
    const x = plan.payload.loc_types.find((l) => l.code === 'x')!;
    expect(x.has_users).toBe(false);
    expect('has_users_setting' in x).toBe(false);
  });

  it('gives new levels fake pks and points a new child at its new parent', () => {
    const plan = planLevelsPayload([], [AREA, FLW]);
    const [area, flw] = [
      plan.payload.loc_types.find((l) => l.code === 'area')!,
      plan.payload.loc_types.find((l) => l.code === 'flw_place')!,
    ];
    expect(String(area.pk)).toMatch(/^fake-pk-/);
    expect(flw.parent_type).toBe(area.pk);
    expect(flw.shares_cases).toBe(true);
    expect(area.view_descendants).toBe(true);
    expect(area.has_users).toBe(true);
  });

  it('amends an existing level in place and reports unchanged ones', () => {
    const existing = [
      page({ pk: 1, code: 'area', name: 'Area', view_descendants: true }),
      page({ pk: 2, code: 'flw_place', name: 'FLW place', parent_type: 1, shares_cases: false }),
    ];
    const plan = planLevelsPayload(existing, [AREA, FLW]);
    expect(plan.updated).toEqual(['flw_place']);
    expect(plan.unchanged).toEqual(['area']);
    expect(plan.created).toEqual([]);
    expect(plan.payload.loc_types.find((l) => l.code === 'flw_place')!.pk).toBe(2);
  });

  it('bounds child data at a strict descendant, and refuses one that is not', () => {
    const lv3: WantedLevel = { code: 'site', name: 'Site', parent_code: 'flw_place', owns_cases: true, view_descendants: false };
    const ok = planLevelsPayload([], [{ ...AREA, view_descendants_down_to_code: 'flw_place' }, FLW, lv3]);
    const area = ok.payload.loc_types.find((l) => l.code === 'area')!;
    const flw = ok.payload.loc_types.find((l) => l.code === 'flw_place')!;
    expect(area.expand_view_child_data_to).toBe(flw.pk);
    expect(() =>
      planLevelsPayload([], [{ ...FLW, view_descendants: true, view_descendants_down_to_code: 'area' }, AREA]),
    ).toThrow(/not below it/);
  });

  it('refuses a name the space already uses for another code (HQ names are unique)', () => {
    expect(() => planLevelsPayload([page({ pk: 1, code: 'region', name: 'Area' })], [AREA])).toThrow(/already uses/);
  });

  it('refuses unknown parents, duplicate codes, bad slugs and cycles', () => {
    expect(() => planLevelsPayload([], [{ ...FLW, parent_code: 'nope' }])).toThrow(/neither wanted nor already/);
    expect(() => planLevelsPayload([], [AREA, AREA])).toThrow(/duplicate/);
    expect(() => planLevelsPayload([], [{ ...AREA, code: '1bad' }])).toThrow(/slug/);
    expect(() =>
      planLevelsPayload([], [
        { ...AREA, parent_code: 'flw_place' },
        { ...FLW, parent_code: 'area' },
      ]),
    ).toThrow(/cycle/);
  });
});

describe('classifyLevelReadback — the POST status proves nothing', () => {
  const api = [
    { id: 1, name: 'Area', code: 'area', parent: null, shares_cases: false, view_descendants: true },
    { id: 2, name: 'FLW place', code: 'flw_place', parent: '/a/d/api/v0.5/location_type/1/', shares_cases: true, view_descendants: false },
  ];
  it('is empty when every wanted level matches', () => {
    expect(classifyLevelReadback([AREA, FLW], api)).toEqual([]);
  });
  it('names an absent level, a wrong parent and a wrong flag', () => {
    const bad = [{ ...api[0] }, { ...api[1], parent: null, shares_cases: false }];
    const p = classifyLevelReadback([AREA, FLW, { ...AREA, code: 'ghost', name: 'Ghost' }], bad);
    expect(p.join('\n')).toMatch(/flw_place: parent is none/);
    expect(p.join('\n')).toMatch(/flw_place: shares_cases is false/);
    expect(p.join('\n')).toMatch(/ghost: absent/);
  });
  it('resolves a parent code from the resource URI', () => {
    expect(apiParentCode(api[1], api)).toBe('area');
    expect(apiParentCode(api[0], api)).toBeNull();
  });
});

describe('buildLocationAssignment — HQ wants the pair together; an empty pair wipes', () => {
  it('always includes the primary in the list, de-duplicated', () => {
    expect(buildLocationAssignment('a', ['b', 'a'])).toEqual({ primary_location: 'a', locations: ['a', 'b'] });
    expect(buildLocationAssignment('a')).toEqual({ primary_location: 'a', locations: ['a'] });
  });
  it('refuses an empty primary rather than sending the wipe', () => {
    expect(() => buildLocationAssignment('')).toThrow(/REMOVE/);
  });
});
