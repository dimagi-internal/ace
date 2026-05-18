/**
 * Unit tests for `simulateConnectSync` — the deterministic projection of
 * what Connect's HQ→Connect sync will create from a released CCZ.
 *
 * Direct port of `commcare-connect`'s
 * `commcare_connect/opportunity/{app_xml,tasks}.py` extract + sync logic:
 * `extract_*` walks every form XML and yields one record per
 * `<learn:deliver>` / `<learn:module>` / `<learn:task>` / `<learn:assessment>`
 * block; `sync_learn_modules_and_deliver_units` then calls
 * `get_or_create(app, slug)` (DeliverUnit/Task/Assessment) or
 * `update_or_create(app, slug)` (LearnModule). Same-slug-across-forms
 * collapses into ONE record on Connect's side, with the first-seen
 * `name` winning.
 *
 * For DeliverUnits this is a billing-correctness bug: collapsed-but-
 * non-first forms cannot be wired to a payment_unit, so submissions
 * against them go unpaid. PR-1 surfaces the projection; PR-2 hard-gates
 * `app-release` Step 6 + `pdd-to-deliver-app` Step 4a on
 * `collision_count === 0`.
 */
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { simulateConnectSync } from '../../../../mcp/connect/backends/commcare.js';

const XMLNS = 'http://commcareconnect.com/data/v1/learn';

function buildCcz(files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    entries[name] = strToU8(content);
  }
  return Buffer.from(zipSync(entries));
}

function form(blocks: string): string {
  return `<?xml version="1.0"?>\n<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns:learn="${XMLNS}">\n  <h:head><h:title>f</h:title></h:head>\n  <h:body>\n${blocks}\n  </h:body>\n</h:html>`;
}

function deliver(slug: string, name: string, description?: string): string {
  return `    <learn:deliver id="${slug}"><learn:name>${name}</learn:name>${
    description ? `<learn:description>${description}</learn:description>` : ''
  }</learn:deliver>`;
}

function moduleEl(slug: string, name: string, description?: string, time_estimate?: number): string {
  let inner = `<learn:name>${name}</learn:name>`;
  if (description) inner += `<learn:description>${description}</learn:description>`;
  if (time_estimate !== undefined) inner += `<learn:time_estimate>${time_estimate}</learn:time_estimate>`;
  return `    <learn:module id="${slug}">${inner}</learn:module>`;
}

function task(slug: string, name: string, description?: string): string {
  return `    <learn:task id="${slug}"><learn:name>${name}</learn:name>${
    description ? `<learn:description>${description}</learn:description>` : ''
  }</learn:task>`;
}

function assessment(slug: string, name: string): string {
  return `    <learn:assessment id="${slug}"><learn:name>${name}</learn:name></learn:assessment>`;
}

describe('simulateConnectSync', () => {
  it('clean Deliver: 5 modules × 5 forms × unique deliver slugs → 5 units, 0 collisions', () => {
    const ccz = buildCcz({
      'modules-0/forms-0.xml': form(deliver('shop_registration', 'Shop registration')),
      'modules-1/forms-0.xml': form(deliver('market_interview', 'Market interview')),
      'modules-2/forms-0.xml': form(deliver('paint_inventory', 'Paint inventory')),
      'modules-3/forms-0.xml': form(deliver('sample_preparation', 'Sample preparation')),
      'modules-4/forms-0.xml': form(deliver('shipment', 'Shipment')),
    });
    const proj = simulateConnectSync(ccz);
    expect(proj.deliver_units.map((u) => u.slug)).toEqual([
      'shop_registration',
      'market_interview',
      'paint_inventory',
      'sample_preparation',
      'shipment',
    ]);
    expect(proj.collision_count).toBe(0);
    expect(proj.collisions.deliver_units).toEqual([]);
  });

  it('broken Deliver: 5 forms in 1 module sharing id="paint_shops" → 1 unit, 1 collision-group, 4 dropped', () => {
    // The actual v1 LEEP failure mode: Nova compile_app reused the
    // module slug as `<learn:deliver id>` for every form.
    const ccz = buildCcz({
      'modules-0/forms-0.xml': form(deliver('paint_shops', 'Shop registration')),
      'modules-0/forms-1.xml': form(deliver('paint_shops', 'Market interview')),
      'modules-0/forms-2.xml': form(deliver('paint_shops', 'Paint inventory')),
      'modules-0/forms-3.xml': form(deliver('paint_shops', 'Sample preparation')),
      'modules-0/forms-4.xml': form(deliver('paint_shops', 'Shipment')),
    });
    const proj = simulateConnectSync(ccz);
    expect(proj.deliver_units).toHaveLength(1);
    expect(proj.deliver_units[0].slug).toBe('paint_shops');
    expect(proj.deliver_units[0].name).toBe('Shop registration');
    expect(proj.deliver_units[0].first_seen_in).toBe('modules-0/forms-0.xml');
    expect(proj.collision_count).toBe(1);
    expect(proj.collisions.deliver_units).toHaveLength(1);
    const c = proj.collisions.deliver_units[0];
    expect(c.slug).toBe('paint_shops');
    expect(c.kept).toEqual({ name: 'Shop registration', form: 'modules-0/forms-0.xml' });
    expect(c.dropped).toEqual([
      { name: 'Market interview', form: 'modules-0/forms-1.xml' },
      { name: 'Paint inventory', form: 'modules-0/forms-2.xml' },
      { name: 'Sample preparation', form: 'modules-0/forms-3.xml' },
      { name: 'Shipment', form: 'modules-0/forms-4.xml' },
    ]);
    expect(c.forms).toHaveLength(5);
  });

  it('clean Learn: 8 modules + 2 assessments, all unique → 8 + 2, 0 collisions', () => {
    const ccz = buildCcz({
      'modules-0/forms-0.xml': form(moduleEl('study_overview', 'Study overview', 'intro', 5)),
      'modules-1/forms-0.xml': form(moduleEl('market_analysis', 'Market analysis')),
      'modules-2/forms-0.xml': form(moduleEl('paint_id', 'Paint identification')),
      'modules-3/forms-0.xml': form(moduleEl('sample_priority', 'Sample priority')),
      'modules-4/forms-0.xml': form(moduleEl('equipment_safety', 'Equipment')),
      'modules-4/forms-1.xml': form(assessment('equipment_safety_quiz', 'Equipment quiz')),
      'modules-5/forms-0.xml': form(moduleEl('unique_id', 'Unique ID')),
      'modules-5/forms-1.xml': form(assessment('unique_id_quiz', 'Unique ID quiz')),
      'modules-6/forms-0.xml': form(moduleEl('sampling_method', 'Sampling')),
      'modules-7/forms-0.xml': form(moduleEl('shipment', 'Shipment')),
    });
    const proj = simulateConnectSync(ccz);
    expect(proj.learn_modules).toHaveLength(8);
    expect(proj.assessments).toHaveLength(2);
    expect(proj.deliver_units).toHaveLength(0);
    expect(proj.task_units).toHaveLength(0);
    expect(proj.collision_count).toBe(0);
    // Module description + time_estimate preserved.
    const m0 = proj.learn_modules.find((m) => m.slug === 'study_overview');
    expect(m0?.description).toBe('intro');
    expect(m0?.time_estimate).toBe(5);
  });

  it('rename footgun: same slug, two different names → first-seen name wins (matches get_or_create)', () => {
    // DeliverUnit uses get_or_create — once a row exists, subsequent
    // uploads with the same slug NEVER update the name. This is a
    // separate footgun from the per-module collision: even single-form
    // modules get stuck with their first-ever-uploaded name.
    const ccz = buildCcz({
      'modules-0/forms-0.xml': form(deliver('shop', 'Old name')),
      'modules-1/forms-0.xml': form(deliver('shop', 'Renamed in v2')),
    });
    const proj = simulateConnectSync(ccz);
    expect(proj.deliver_units).toHaveLength(1);
    expect(proj.deliver_units[0].name).toBe('Old name');
    expect(proj.collisions.deliver_units[0].dropped[0]).toEqual({
      name: 'Renamed in v2',
      form: 'modules-1/forms-0.xml',
    });
  });

  it('mixed deliver + task in same forms: dedup is independent per type', () => {
    // The actual v1 LEEP CCZ — `<learn:task id>` was per-form unique
    // (`paint_shops_<form>`), but `<learn:deliver id>` reused the
    // module slug. Connect dedups each type independently.
    const ccz = buildCcz({
      'modules-0/forms-0.xml': form(
        deliver('paint_shops', 'Shop registration') +
          '\n' +
          task('paint_shops_shop_registration', 'Register shop'),
      ),
      'modules-0/forms-1.xml': form(
        deliver('paint_shops', 'Market interview') +
          '\n' +
          task('paint_shops_market_interview', 'Interview seller'),
      ),
    });
    const proj = simulateConnectSync(ccz);
    expect(proj.deliver_units).toHaveLength(1);
    expect(proj.task_units).toHaveLength(2);
    expect(proj.collisions.deliver_units).toHaveLength(1);
    expect(proj.collisions.task_units).toHaveLength(0);
    expect(proj.collision_count).toBe(1);
  });

  it('default-namespace shape (no learn: prefix) is also handled — Nova autobuild output', () => {
    // Some Nova builds emit `<deliver xmlns="...connect..." id="X">`
    // instead of `<learn:deliver id="X">`. Both must work.
    const ccz = buildCcz({
      'modules-0/forms-0.xml':
        '<h:head><deliver xmlns="http://commcareconnect.com/data/v1/learn" id="shop_visits"><name>Paint shop visit</name></deliver></h:head>',
      'modules-1/forms-0.xml':
        '<h:head><deliver xmlns="http://commcareconnect.com/data/v1/learn" id="sample_drop"><name>Sample drop-off</name></deliver></h:head>',
      'suite.xml': '<suite></suite>',
    });
    const proj = simulateConnectSync(ccz);
    expect(proj.deliver_units).toHaveLength(2);
    expect(proj.deliver_units.map((u) => u.slug).sort()).toEqual(['sample_drop', 'shop_visits']);
    expect(proj.collision_count).toBe(0);
  });

  it('non-zip buffer returns empty projection (no throw)', () => {
    const proj = simulateConnectSync(Buffer.from('not a zip', 'utf8'));
    expect(proj.collision_count).toBe(0);
    expect(proj.deliver_units).toEqual([]);
    expect(proj.learn_modules).toEqual([]);
  });

  it('only walks form XMLs (suite.xml, app_strings.txt, etc. are ignored)', () => {
    const ccz = buildCcz({
      'modules-0/forms-0.xml': form(deliver('a', 'A')),
      // These files contain `<learn:deliver>` markers but should not
      // contribute records — Connect's `extract_deliver_unit` only
      // walks form XMLs, never suite/strings/profile.
      'suite.xml': '<learn:deliver xmlns:learn="http://commcareconnect.com/data/v1/learn" id="ignored"><learn:name>Should not appear</learn:name></learn:deliver>',
      'default/app_strings.txt': '<learn:deliver xmlns:learn="http://commcareconnect.com/data/v1/learn" id="also_ignored"></learn:deliver>',
    });
    const proj = simulateConnectSync(ccz);
    expect(proj.deliver_units).toHaveLength(1);
    expect(proj.deliver_units[0].slug).toBe('a');
  });

  // Slug-length boundary probe. Connect's `LearnModule.slug` /
  // `DeliverUnit.slug` are `SlugField()` with the Django default
  // `max_length=50`. A slug > 50 chars causes Postgres `DataError:
  // value too long for type character varying(50)` at sync time,
  // uncaught → HTTP 500 with empty body from `/opportunity/init/`.
  // Reproducer: leep-paint-collection run 20260517-1515 Phase 4 —
  // module name "Stage 2: Sample Preparation, Drying, Bagging, Shipment"
  // produced slug `module_6_stage_2_sample_prep_drying_bagging_shipment`
  // (52 chars) and 500'd Connect with no diagnostic.
  describe('slug-length boundary probe (Connect SlugField() max_length=50)', () => {
    it('exposes slug_length_limit + max_slug_length on every projection', () => {
      const ccz = buildCcz({
        'modules-0/forms-0.xml': form(deliver('shop_visit', 'Shop visit')),
      });
      const proj = simulateConnectSync(ccz);
      expect(proj.slug_length_limit).toBe(50);
      expect(proj.max_slug_length).toBe('shop_visit'.length);
      expect(proj.oversized_slugs.deliver_units).toEqual([]);
      expect(proj.oversized_slugs.learn_modules).toEqual([]);
    });

    it('flags learn_module slugs > 50 chars (the leep-paint regression)', () => {
      const oversized = 'module_6_stage_2_sample_prep_drying_bagging_shipment'; // 52
      expect(oversized.length).toBeGreaterThan(50);
      const ccz = buildCcz({
        'modules-5/forms-0.xml': form(
          moduleEl(oversized, 'Stage 2: Sample Preparation, Drying, Bagging, Shipment', 'desc', 20),
        ),
      });
      const proj = simulateConnectSync(ccz);
      expect(proj.max_slug_length).toBe(52);
      expect(proj.oversized_slugs.learn_modules.map((r) => r.slug)).toEqual([oversized]);
      expect(proj.oversized_slugs.deliver_units).toEqual([]);
    });

    it('flags deliver_unit slugs > 50 chars too', () => {
      const oversized = 'deliver_unit_stage_2_sample_prep_drying_bagging_shipment'; // 56
      expect(oversized.length).toBeGreaterThan(50);
      const ccz = buildCcz({
        'modules-0/forms-0.xml': form(deliver(oversized, 'long')),
      });
      const proj = simulateConnectSync(ccz);
      expect(proj.oversized_slugs.deliver_units.map((r) => r.slug)).toEqual([oversized]);
      expect(proj.max_slug_length).toBe(56);
    });

    it('empty projection sets max_slug_length=0 and slug_length_limit=50', () => {
      const proj = simulateConnectSync(Buffer.from('not a zip', 'utf8'));
      expect(proj.slug_length_limit).toBe(50);
      expect(proj.max_slug_length).toBe(0);
      expect(proj.oversized_slugs.learn_modules).toEqual([]);
    });

    it('slugs exactly 50 chars do NOT trigger oversized (boundary inclusive)', () => {
      const exactly50 = 'a'.repeat(50);
      const ccz = buildCcz({
        'modules-0/forms-0.xml': form(deliver(exactly50, 'edge case')),
      });
      const proj = simulateConnectSync(ccz);
      expect(proj.oversized_slugs.deliver_units).toEqual([]);
      expect(proj.max_slug_length).toBe(50);
    });
  });
});
