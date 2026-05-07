/**
 * Unit tests for `scripts/run-form-walk.ts` — the released-CCZ field
 * walker that backs the `app-multimedia-coverage` SKILL's per-form
 * inventory step.
 *
 * Tests exercise the exported pure helpers (`parseSuiteFormResources`,
 * `walkFormFields`, `walkCcz`) directly — no live CCHQ, no Playwright,
 * just static fixture XMLs zipped in memory.
 *
 * Fixtures:
 *   - test/fixtures/cchq/form-walk-sample-suite.xml
 *   - test/fixtures/cchq/form-walk-sample-form.xml  (label + text + int + single + multi + date)
 *   - test/fixtures/cchq/leep-quiz-form-empty-user-score.xml  (real quiz form: trigger + 3 single-selects)
 *
 * Together they exercise the kind-inference matrix the SKILL operator-LLM
 * relies on.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import {
  parseSuiteFormResources,
  walkFormFields,
  walkCcz,
  parseDraftAppFormUids,
  mergeDraftFormUids,
} from '../../scripts/run-form-walk.js';

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'cchq');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

describe('parseSuiteFormResources', () => {
  it('maps form paths to 32-hex form_unique_id from the suite.xml fixture', () => {
    const suite = loadFixture('form-walk-sample-suite.xml');
    const map = parseSuiteFormResources(suite);
    expect(map.get('modules-0/forms-0.xml')).toBe('a'.repeat(32));
    expect(map.get('modules-0/forms-1.xml')).toBe('b'.repeat(32));
    expect(map.size).toBe(2);
  });

  it('skips resource ids that are not 32-char hex (non-form resources)', () => {
    const suite = `
      <suite>
        <xform>
          <resource id="locale">
            <location authority="local">./app_strings.txt</location>
          </resource>
          <resource id="${'a'.repeat(32)}">
            <location authority="local">./modules-0/forms-0.xml</location>
          </resource>
        </xform>
      </suite>
    `;
    const map = parseSuiteFormResources(suite);
    expect(Array.from(map.entries())).toEqual([['modules-0/forms-0.xml', 'a'.repeat(32)]]);
  });

  it('returns empty map for malformed suite.xml', () => {
    const map = parseSuiteFormResources('<suite/>');
    expect(map.size).toBe(0);
  });
});

describe('walkFormFields — sample form (kind-inference matrix)', () => {
  it('emits a row per visible body field with the right kind + label + options', () => {
    const xml = loadFixture('form-walk-sample-form.xml');
    const fields = walkFormFields(xml);

    // Fields appear in body order; calc-only fields (`calc_only`) are
    // bind-only with no body element and MUST NOT show up.
    const ids = fields.map((f) => f.field_id);
    expect(ids).toEqual([
      'intro',
      'client_name',
      'client_age',
      'main_concern',
      'symptoms',
      'next_visit_at',
    ]);

    const byId = Object.fromEntries(fields.map((f) => [f.field_id, f]));
    expect(byId.intro.kind).toBe('trigger');
    expect(byId.intro.label).toMatch(/Welcome/);
    expect(byId.intro.options).toEqual([]);

    expect(byId.client_name.kind).toBe('text');
    expect(byId.client_name.label).toBe('Client name');

    expect(byId.client_age.kind).toBe('int');
    expect(byId.client_age.label).toBe('Client age (years)');

    expect(byId.main_concern.kind).toBe('single_select');
    expect(byId.main_concern.label).toBe('Main concern today');
    expect(byId.main_concern.options).toEqual(['Fever', 'Cough', 'Other']);

    expect(byId.symptoms.kind).toBe('multi_select');
    expect(byId.symptoms.options).toEqual(['Rash', 'Vomiting']);

    expect(byId.next_visit_at.kind).toBe('datetime');
    expect(byId.next_visit_at.label).toBe('Schedule next visit');
  });

  it('does NOT emit rows for calculate-only fields (no body element)', () => {
    const xml = loadFixture('form-walk-sample-form.xml');
    const ids = walkFormFields(xml).map((f) => f.field_id);
    expect(ids).not.toContain('calc_only');
  });
});

describe('walkFormFields — real LEEP quiz form (single-select + trigger)', () => {
  it('handles markdown variant <value form="markdown"> by preferring the plain <value>', () => {
    const xml = loadFixture('leep-quiz-form-empty-user-score.xml');
    const fields = walkFormFields(xml);
    const intro = fields.find((f) => f.field_id === 'quiz_intro');
    expect(intro?.kind).toBe('trigger');
    // The plain <value> includes leading "# Quiz —" — assert it
    // round-tripped into the label exactly once (i.e. we did NOT
    // double-pull from <value form="markdown">).
    expect(intro?.label).toContain('# Quiz — Why this survey exists');
  });

  it('captures the three quiz select1 fields with their options', () => {
    const xml = loadFixture('leep-quiz-form-empty-user-score.xml');
    const fields = walkFormFields(xml);
    const q1 = fields.find((f) => f.field_id === 'q1');
    expect(q1?.kind).toBe('single_select');
    expect(q1?.options.length).toBe(3);
    expect(q1?.options[0]).toMatch(/cheaper to buy/);
  });

  it('returns at least the four body-rendered fields and not the meta+score binds', () => {
    const xml = loadFixture('leep-quiz-form-empty-user-score.xml');
    const ids = walkFormFields(xml).map((f) => f.field_id);
    expect(ids).toContain('quiz_intro');
    expect(ids).toContain('q1');
    expect(ids).toContain('q2');
    expect(ids).toContain('q3');
    // total_score / *_correct have <bind> entries but no body element →
    // must not appear.
    expect(ids).not.toContain('total_score');
    expect(ids).not.toContain('q1_correct');
    // meta children also bind-only.
    expect(ids).not.toContain('deviceID');
    expect(ids).not.toContain('username');
  });
});

describe('walkCcz — end-to-end against an in-memory CCZ', () => {
  it('produces the expected output shape with form_unique_id mapping and per-form fields', () => {
    const suite = loadFixture('form-walk-sample-suite.xml');
    const form0 = loadFixture('form-walk-sample-form.xml');
    const form1 = loadFixture('leep-quiz-form-empty-user-score.xml');

    // Build a tiny CCZ-shaped zip in memory: suite.xml + two forms.
    const zipped = zipSync({
      'suite.xml': strToU8(suite),
      'modules-0/forms-0.xml': strToU8(form0),
      'modules-0/forms-1.xml': strToU8(form1),
      // Throw in some unrelated entries that the walker must skip.
      'app_strings.txt': strToU8('# locale stub'),
      'profile.ccpr': strToU8('<profile/>'),
    });
    const cczBuf = Buffer.from(zipped);

    const result = walkCcz({
      cczBuf,
      domain: 'test-domain',
      app_id: '0'.repeat(32),
      build_id: 'b'.repeat(32),
    });

    expect(result.domain).toBe('test-domain');
    expect(result.app_id).toBe('0'.repeat(32));
    expect(result.build_id).toBe('b'.repeat(32));
    expect(result.forms.length).toBe(2);

    // Sorted by path, so forms-0 first.
    expect(result.forms[0].module).toBe(0);
    expect(result.forms[0].form).toBe(0);
    expect(result.forms[0].form_path).toBe('modules-0/forms-0.xml');
    expect(result.forms[0].form_unique_id).toBe('a'.repeat(32));
    expect(result.forms[0].fields.length).toBeGreaterThan(0);

    expect(result.forms[1].form_path).toBe('modules-0/forms-1.xml');
    expect(result.forms[1].form_unique_id).toBe('b'.repeat(32));
    // Quiz form: at least quiz_intro + q1/q2/q3 in body order.
    const ids1 = result.forms[1].fields.map((f) => f.field_id);
    expect(ids1.slice(0, 4)).toEqual(['quiz_intro', 'q1', 'q2', 'q3']);
  });

  it('emits build_id: null when caller did not supply one', () => {
    const suite = loadFixture('form-walk-sample-suite.xml');
    const form0 = loadFixture('form-walk-sample-form.xml');
    const cczBuf = Buffer.from(
      zipSync({
        'suite.xml': strToU8(suite),
        'modules-0/forms-0.xml': strToU8(form0),
      }),
    );
    const result = walkCcz({
      cczBuf,
      domain: 'd',
      app_id: '0'.repeat(32),
      build_id: null,
    });
    expect(result.build_id).toBeNull();
  });

  it('returns form_unique_id: null when suite.xml is absent (degraded mode)', () => {
    const form0 = loadFixture('form-walk-sample-form.xml');
    const cczBuf = Buffer.from(
      zipSync({
        'modules-0/forms-0.xml': strToU8(form0),
      }),
    );
    const result = walkCcz({
      cczBuf,
      domain: 'd',
      app_id: '0'.repeat(32),
      build_id: null,
    });
    expect(result.forms.length).toBe(1);
    expect(result.forms[0].form_unique_id).toBeNull();
    // Field walk still works.
    expect(result.forms[0].fields.length).toBeGreaterThan(0);
  });

  it('defaults form_unique_id_source to suite_xml (CLI overlays draft_api)', () => {
    const suite = loadFixture('form-walk-sample-suite.xml');
    const form0 = loadFixture('form-walk-sample-form.xml');
    const cczBuf = Buffer.from(
      zipSync({
        'suite.xml': strToU8(suite),
        'modules-0/forms-0.xml': strToU8(form0),
      }),
    );
    const result = walkCcz({ cczBuf, domain: 'd', app_id: '0'.repeat(32), build_id: null });
    expect(result.form_unique_id_source).toBe('suite_xml');
  });
});

describe('parseDraftAppFormUids — draft-app /api/v0.5/application/ JSON', () => {
  it('maps modules[N].forms[M].unique_id to modules-N/forms-M.xml', () => {
    const draft = {
      modules: [
        { forms: [{ unique_id: 'a'.repeat(32) }, { unique_id: 'b'.repeat(32) }] },
        { forms: [{ unique_id: 'c'.repeat(32) }] },
      ],
    };
    const map = parseDraftAppFormUids(draft);
    expect(map.get('modules-0/forms-0.xml')).toBe('a'.repeat(32));
    expect(map.get('modules-0/forms-1.xml')).toBe('b'.repeat(32));
    expect(map.get('modules-1/forms-0.xml')).toBe('c'.repeat(32));
    expect(map.size).toBe(3);
  });

  it('skips forms with missing or non-32-hex unique_id', () => {
    const draft = {
      modules: [
        {
          forms: [
            { unique_id: 'a'.repeat(32) },
            { unique_id: 'short' },
            { unique_id: undefined },
            {},
            { unique_id: 'd'.repeat(32) },
          ],
        },
      ],
    };
    const map = parseDraftAppFormUids(draft);
    expect(map.size).toBe(2);
    expect(map.get('modules-0/forms-0.xml')).toBe('a'.repeat(32));
    expect(map.get('modules-0/forms-4.xml')).toBe('d'.repeat(32));
  });

  it('returns empty map for malformed input', () => {
    expect(parseDraftAppFormUids(null).size).toBe(0);
    expect(parseDraftAppFormUids({}).size).toBe(0);
    expect(parseDraftAppFormUids({ modules: 'not-an-array' }).size).toBe(0);
    expect(parseDraftAppFormUids({ modules: [{ no_forms: true }] }).size).toBe(0);
  });
});

describe('mergeDraftFormUids — overlay draft uids onto walkCcz output', () => {
  function makeWalked(): ReturnType<typeof walkCcz> {
    const suite = loadFixture('form-walk-sample-suite.xml');
    const form0 = loadFixture('form-walk-sample-form.xml');
    const cczBuf = Buffer.from(
      zipSync({
        'suite.xml': strToU8(suite),
        'modules-0/forms-0.xml': strToU8(form0),
        'modules-0/forms-1.xml': strToU8(form0),
      }),
    );
    return walkCcz({ cczBuf, domain: 'd', app_id: '0'.repeat(32), build_id: null });
  }

  it('replaces each form_unique_id with the draft variant when present', () => {
    const walked = makeWalked();
    // suite.xml-derived uids start as 'a'×32 and 'b'×32.
    expect(walked.forms[0].form_unique_id).toBe('a'.repeat(32));
    expect(walked.forms[1].form_unique_id).toBe('b'.repeat(32));
    expect(walked.form_unique_id_source).toBe('suite_xml');

    const draftMap = new Map([
      ['modules-0/forms-0.xml', '1'.repeat(32)],
      ['modules-0/forms-1.xml', '2'.repeat(32)],
    ]);
    const merged = mergeDraftFormUids(walked, draftMap);
    expect(merged.forms[0].form_unique_id).toBe('1'.repeat(32));
    expect(merged.forms[1].form_unique_id).toBe('2'.repeat(32));
    expect(merged.form_unique_id_source).toBe('draft_api');
  });

  it('keeps form_unique_id_source as suite_xml when any form is missing from draft', () => {
    const walked = makeWalked();
    const draftMap = new Map([['modules-0/forms-0.xml', '1'.repeat(32)]]);
    const merged = mergeDraftFormUids(walked, draftMap);
    expect(merged.forms[0].form_unique_id).toBe('1'.repeat(32));
    expect(merged.forms[1].form_unique_id).toBe('b'.repeat(32)); // unchanged
    expect(merged.form_unique_id_source).toBe('suite_xml'); // partial coverage
  });

  it('returns input unchanged when draft map is empty (fallback path)', () => {
    const walked = makeWalked();
    const merged = mergeDraftFormUids(walked, new Map());
    expect(merged).toEqual(walked);
  });
});
