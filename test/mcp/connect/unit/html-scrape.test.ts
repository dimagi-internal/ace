import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractFormCsrfToken,
  extractUuidFromPath,
  parseDeliveryTypeOptions,
  parseProgramsList,
  parseFormErrors,
  parseFormErrorsByField,
  parsePaymentUnitTable,
} from '../../../../mcp/connect/backends/html-scrape.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fix = (name: string) =>
  fs.readFileSync(path.join(__dirname, '../../../fixtures/connect-html', name), 'utf8');

describe('extractFormCsrfToken', () => {
  it('extracts the value', () => {
    const html = '<input type="hidden" name="csrfmiddlewaretoken" value="abc123def">';
    expect(extractFormCsrfToken(html)).toBe('abc123def');
  });
  it('returns undefined if missing', () => {
    expect(extractFormCsrfToken('<div>nope</div>')).toBeUndefined();
  });
  it('finds it in the live program-init form', () => {
    expect(extractFormCsrfToken(fix('a-ai-demo-space-program-init.html'))).toMatch(/^[A-Za-z0-9]{40,}$/);
  });
});

describe('extractUuidFromPath', () => {
  it('extracts a program UUID', () => {
    expect(extractUuidFromPath('/a/dim/program/067a73b8-b65a-426c-a055-32e6cfb7efa9/', 'program'))
      .toBe('067a73b8-b65a-426c-a055-32e6cfb7efa9');
  });
  it('extracts an opportunity UUID', () => {
    expect(extractUuidFromPath('/a/dim/opportunity/067a73b8-b65a-426c-a055-32e6cfb7efa9/edit', 'opportunity'))
      .toBe('067a73b8-b65a-426c-a055-32e6cfb7efa9');
  });
  it('returns undefined for paths without a uuid', () => {
    expect(extractUuidFromPath('/a/dim/program/', 'program')).toBeUndefined();
  });
});

describe('parseDeliveryTypeOptions', () => {
  it('extracts the live delivery_type lookup', () => {
    const options = parseDeliveryTypeOptions(fix('a-ai-demo-space-program-init.html'));
    expect(options.length).toBeGreaterThanOrEqual(13);
    expect(options.find((o) => o.name === 'Nutrition')).toBeDefined();
    expect(options.find((o) => o.name === 'Infant Vaccine Promotion')).toEqual({ id: 1, name: 'Infant Vaccine Promotion' });
  });
});

describe('parseProgramsList', () => {
  it('parses the live programs list with one program', () => {
    const programs = parseProgramsList(fix('programs-list-with-data.html'));
    expect(programs.length).toBeGreaterThanOrEqual(1);
    const probe = programs.find((p) => p.name.startsWith('ACE-Probe-'));
    expect(probe).toBeDefined();
    expect(probe!.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(probe!.description).toBe('Created by ace-connect probe script');
  });
});

describe('parseFormErrors', () => {
  it('returns [] for a clean form', () => {
    expect(parseFormErrors('<form>...</form>')).toEqual([]);
  });
  it('extracts text from errorlist', () => {
    const html = '<ul class="errorlist"><li>Name is required</li><li>Budget must be positive</li></ul>';
    expect(parseFormErrors(html)).toEqual(['Name is required', 'Budget must be positive']);
  });
  it('extracts text from crispy-tailwind <p id="error_N_id_FIELD"> markup (live FLW invite shape)', () => {
    const html = `<p id="error_1_id_users" class="text-red-500 text-xs italic"><strong>Please finish setting up the opportunity before inviting users.</strong></p>`;
    expect(parseFormErrors(html)).toEqual(['Please finish setting up the opportunity before inviting users.']);
  });
});

describe('parseFormErrorsByField', () => {
  it('returns {} for a clean form (no errorlist)', () => {
    expect(parseFormErrorsByField('<form><input name="x"></form>')).toEqual({});
  });

  it('keys errors by Django field name from div_id_<field>', () => {
    const html = `
      <form>
        <div id="div_id_api_key" class="mb-3">
          <label>API key</label>
          <ul class="errorlist"><li>Select a valid choice.</li></ul>
          <select name="api_key"></select>
        </div>
        <div id="div_id_hq_server" class="mb-3">
          <ul class="errorlist"><li>This field is required.</li></ul>
          <select name="hq_server"></select>
        </div>
      </form>
    `;
    expect(parseFormErrorsByField(html)).toEqual({
      api_key: ['Select a valid choice.'],
      hq_server: ['This field is required.'],
    });
  });

  it('puts non-field (form-level) errors under __all__', () => {
    const html = `
      <form>
        <ul class="errorlist nonfield"><li>Duplicate name.</li></ul>
        <div id="div_id_name"><input name="name"></div>
      </form>
    `;
    expect(parseFormErrorsByField(html)).toEqual({ __all__: ['Duplicate name.'] });
  });

  it('parses multiple errors per field', () => {
    const html = `
      <div id="div_id_learn_app">
        <ul class="errorlist">
          <li>Enter a valid JSON.</li>
          <li>This field is required.</li>
        </ul>
      </div>
    `;
    expect(parseFormErrorsByField(html)).toEqual({
      learn_app: ['Enter a valid JSON.', 'This field is required.'],
    });
  });

  it('keys errors by field for crispy-tailwind <p id="error_N_id_FIELD"> markup', () => {
    const html = `
      <div id="div_id_users" class="mb-3">
        <textarea name="users"></textarea>
        <p id="error_1_id_users" class="text-red-500 text-xs italic"><strong>Please finish setting up the opportunity before inviting users.</strong></p>
      </div>
    `;
    expect(parseFormErrorsByField(html)).toEqual({
      users: ['Please finish setting up the opportunity before inviting users.'],
    });
  });

  it('handles mixed errorlist + crispy-tailwind markup in the same response', () => {
    const html = `
      <div id="div_id_api_key">
        <ul class="errorlist"><li>Select a valid choice.</li></ul>
      </div>
      <div id="div_id_users">
        <p id="error_1_id_users" class="text-red-500"><strong>Phone numbers must contain only digits.</strong></p>
      </div>
    `;
    expect(parseFormErrorsByField(html)).toEqual({
      api_key: ['Select a valid choice.'],
      users: ['Phone numbers must contain only digits.'],
    });
  });

  it('matches the live opportunity-init validation-error fixture', () => {
    const fields = parseFormErrorsByField(fix('opportunity-init-validation-errors.html'));
    expect(fields.api_key).toEqual([
      'Select a valid choice. abcdef0123456789abcdef0123456789abcdef01 is not one of the available choices.',
    ]);
    expect(fields.hq_server).toEqual([
      'Select a valid choice. That choice is not one of the available choices.',
    ]);
    expect(fields.learn_app).toEqual([
      'Enter a valid JSON.',
      'This field is required.',
    ]);
    expect(fields.__all__).toEqual([
      'An opportunity with this name already exists for this organization.',
    ]);
    // Fields without errors must NOT appear in the map.
    expect(fields.name).toBeUndefined();
    expect(fields.short_description).toBeUndefined();
    expect(fields.deliver_app).toBeUndefined();
  });
});

describe('parsePaymentUnitTable', () => {
  // Live-captured 2026-05-05 from connect.dimagi.com against an active opp.
  // The opp's PU was created with `amount=2, max_total=100, max_daily=20,
  // required_deliver_units=[1]` (verified via the per-PU /edit page). The
  // fixture is the table view for the SAME PU. Until 0.13.2 the parser
  // mis-aligned columns and produced `amount=100, max_total=20` — the
  // "field-shift defect" that blocked three Phase 3 runs. This test pins
  // the corrected mapping against real Connect HTML.
  const live = fix('payment_unit_table-live-2026-05-05.html');

  it('parses 7-column live HTML with correct column→field mapping', () => {
    const out = parsePaymentUnitTable(live);
    expect(out).toHaveLength(1);
    const pu = out[0];
    expect(pu.id).toBe(1);
    expect(pu.name).toBe('Vendor Visit (consented)');
    expect(pu.start_date).toBe('05/19/2026');
    expect(pu.end_date).toBe('07/14/2026');
    // "Total Deliveries" column → max_total (server stored 100)
    expect(pu.max_total).toBe(100);
    // "Max daily" column → max_daily (server stored 20)
    expect(pu.max_daily).toBe(20);
    // amount is NOT rendered in the table — listPaymentUnits cannot
    // round-trip it. Producers (createPaymentUnit) must echo args.amount.
    expect(pu.amount).toBeUndefined();
    // description / required_deliver_units are also unparseable from the
    // table; callers needing those must hit the per-PU edit form or REST.
    expect(pu.description).toBe('');
    expect(pu.required_deliver_units).toEqual([]);
    expect(pu.optional_deliver_units).toEqual([]);
  });

  it('regression: rejects pre-0.13.2 reading where cells[4] was treated as amount', () => {
    // The old parser would have returned amount=100 (from cells[4], the
    // "Total Deliveries" column) and max_total=20 (from cells[5], the
    // "Max daily" column), incorrectly identifying the column meanings.
    // The new mapping must NOT produce those values.
    const out = parsePaymentUnitTable(live);
    expect(out[0].amount).not.toBe(100);
    // max_total should be 100 (the actual Total Deliveries cap), not 20.
    expect(out[0].max_total).toBe(100);
  });

  it('handles synthetic 7-column rows (no <thead>)', () => {
    const html = `<table><tbody>
      <tr class="even"><td>3</td><td>Probe</td><td>2026-01-01</td><td>2026-12-31</td><td>500</td><td>50</td><td>2</td></tr>
    </tbody></table>`;
    const out = parsePaymentUnitTable(html);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 3,
      name: 'Probe',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      max_total: 500,
      max_daily: 50,
    });
    expect(out[0].amount).toBeUndefined();
  });

  it('skips rows without a numeric id', () => {
    const html = `<table><tbody>
      <tr class="even"><td>—</td><td>Header</td><td></td><td></td><td>0</td><td>0</td><td>0</td></tr>
    </tbody></table>`;
    expect(parsePaymentUnitTable(html)).toEqual([]);
  });
});
