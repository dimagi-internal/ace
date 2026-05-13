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
  parseDeliverUnitTable,
  parseDeliverUnitFormCheckboxes,
} from '../../../../mcp/connect/backends/html-scrape.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fix = (name: string) =>
  fs.readFileSync(path.join(__dirname, '../../../fixtures/connect-html', name), 'utf8');

describe('extractFormCsrfToken', () => {
  it('extracts the value from a legacy csrfmiddlewaretoken input', () => {
    const html = '<input type="hidden" name="csrfmiddlewaretoken" value="abc123def">';
    expect(extractFormCsrfToken(html)).toBe('abc123def');
  });
  it('extracts the value from <body hx-headers> (current Connect template)', () => {
    // Connect's templates now expose the CSRF token on <body hx-headers='...'>
    // instead of as a hidden input on each form. Verified 2026-05-06 against
    // /a/<org>/opportunity/ on prod. Both quote orientations are tolerated.
    const html = `<body hx-headers='{"X-CSRFToken": "Tk1Bc-hxstyle-xyz"}' x-data="{}">`;
    expect(extractFormCsrfToken(html)).toBe('Tk1Bc-hxstyle-xyz');
  });
  it('prefers hx-headers when both patterns are present', () => {
    const html =
      `<body hx-headers='{"X-CSRFToken": "FROM_BODY"}'>` +
      `<input type="hidden" name="csrfmiddlewaretoken" value="FROM_FORM">`;
    expect(extractFormCsrfToken(html)).toBe('FROM_BODY');
  });
  it('returns undefined if neither pattern is present', () => {
    expect(extractFormCsrfToken('<div>nope</div>')).toBeUndefined();
  });
  it('finds it in the live program-init form (legacy fixture)', () => {
    expect(extractFormCsrfToken(fix('a-ai-demo-space-program-init.html'))).toMatch(/^[A-Za-z0-9]{40,}$/);
  });
  it('finds it in the live authed dashboard hx-headers fixture', () => {
    expect(extractFormCsrfToken(fix('jjackson-opportunity-htmx-csrf.html'))).toBe(
      'FAKE_HX_CSRF_TOKEN_PLACEHOLDER_FOR_TEST',
    );
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
  // "field-shift defect" that blocked three Phase 4 runs. This test pins
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

  // Live-captured 2026-05-06 from leep-paint-collection
  // (https://github.com/jjackson/ace/issues/106 finding 5). The opp had
  // 3 payment units active at scrape time. The fixture exercises:
  //   - extracting payment_unit_uuid from the row's edit href
  //     (`/payment_unit/<UUID>/edit`)
  //   - confirming `id` (cells[0]) is the display index 1/2/3, not a
  //     server integer ID (which is not rendered in this listing)
  describe('with payment_unit_uuid extraction (live 2026-05-06)', () => {
    const live2 = fix('payment_unit_table-live-2026-05-06.html');
    const out = parsePaymentUnitTable(live2);

    it('parses three rows with display-index ids', () => {
      expect(out).toHaveLength(3);
      expect(out.map((pu) => pu.id)).toEqual([1, 2, 3]);
    });

    it('extracts payment_unit_uuid from each row edit link', () => {
      // The three UUIDs from the live HTML edit hrefs.
      expect(out.map((pu) => pu.payment_unit_uuid)).toEqual([
        'aece2d58-bc28-41c0-ba77-5b4155652202',
        '519450e1-6c46-42bd-84bb-a6cdb3890791',
        'abb52212-0601-4f61-8026-731a009729a0',
      ]);
    });

    it('synthetic row without an edit href yields undefined uuid', () => {
      const html = `<table><tbody>
        <tr class="even"><td>1</td><td>NoLink</td><td>2026-01-01</td><td>2026-12-31</td><td>10</td><td>5</td><td>0</td></tr>
      </tbody></table>`;
      expect(parsePaymentUnitTable(html)[0].payment_unit_uuid).toBeUndefined();
    });
  });
});

describe('parseDeliverUnitTable', () => {
  // Live-captured 2026-05-06 from leep-paint-collection
  // (https://github.com/jjackson/ace/issues/106 finding 5). The HTML
  // for this listing genuinely does NOT expose server integer IDs —
  // no data-* attrs, no hrefs, no hidden inputs. The fixture pins
  // that observation so we don't regress to claiming `cells[0]` is
  // the server ID.
  const live = fix('deliver_unit_table-live-2026-05-06.html');

  it('parses three rows with display-index ids and slug+name', () => {
    const out = parseDeliverUnitTable(live);
    expect(out).toHaveLength(3);
    expect(out.map((du) => du.id)).toEqual([1, 2, 3]);
    expect(out.map((du) => du.slug)).toEqual([
      'shipments',
      'stage_1_market_analysis',
      'stage_2_sampling',
    ]);
    expect(out.map((du) => du.name)).toEqual([
      'Shipment',
      'Shop Registration',
      'Sample Preparation',
    ]);
  });

  it('regression: ids are display indices 1..N, NOT server integer IDs', () => {
    // Server integer IDs for these deliver units (from the create-time
    // response when they were synced) are 5355/5356/5357. The HTML
    // listing does not render them — we get back 1/2/3 instead. This
    // test pins that observation so a future "fix" doesn't silently
    // start returning real server IDs without the type signal being
    // updated. When commcare-connect ships server-side IDs in the
    // listing (data-id="5355"), update parseDeliverUnitTable AND the
    // jsdoc on DeliverUnit.id together.
    //
    // Note: from 0.13.124, `listDeliverUnits` enriches each parsed DU
    // with a separate `server_id` field via a second fetch of the
    // create-payment-unit form. `parseDeliverUnitTable` itself stays
    // unchanged — the enrichment lives one layer up in the backend.
    const out = parseDeliverUnitTable(live);
    expect(out[0].id).toBe(1);
    expect(out[0].id).not.toBe(5355);
    expect(out[0].server_id).toBeUndefined();
  });
});

describe('parseDeliverUnitFormCheckboxes', () => {
  // Live-captured 2026-05-06 from the dea88661-… opp's
  // /payment_unit/create form. The form renders one
  // `<input type="checkbox" name="(required|optional)_deliver_units"
  // value="<server_pk>">` per available DU. PKs in this fixture: 3339
  // ("Optional Delivery"), 3340 ("Optional Delivery 2"), 3341
  // ("Optional Delivery 3"), 3342 ("optional delivery unit 4"). Closes
  // jjackson/ace#106 finding 5: the create-PU form is the only HTML
  // surface where server PKs are observable, so listDeliverUnits uses
  // this parser to enrich its display-id-only output with server PKs.
  const live = fix('opportunity-dea88661-1cd6-486b-ab25-48584bf61a8e-payment_unit-create.html');

  it('extracts server PKs and labels from the live create-PU form', () => {
    const out = parseDeliverUnitFormCheckboxes(live);
    expect(out.size).toBe(4);
    expect(out.get('Optional Delivery')).toBe('3339');
    expect(out.get('Optional Delivery 2')).toBe('3340');
    expect(out.get('Optional Delivery 3')).toBe('3341');
    expect(out.get('optional delivery unit 4')).toBe('3342');
  });

  it('dedupes when the same DU appears in both required and optional groups', () => {
    // The live form renders identical checkboxes for required and
    // optional groups (same value, same label). First-seen wins so the
    // map dedupes deterministically and doesn't overwrite.
    const out = parseDeliverUnitFormCheckboxes(live);
    // 4 unique DUs across BOTH checkbox groups → 4 entries.
    expect(out.size).toBe(4);
  });

  it('returns an empty map when the form has no checkboxes (sync precondition not yet fired)', () => {
    // Synthetic — Connect's create-PU form wraps the checkbox list in
    // `<div id="div_id_required_deliver_units">` even when the
    // sync-deliver-units button hasn't fired yet. The backend uses the
    // empty result as the trigger to POST /sync_deliver_units/ and
    // re-fetch.
    const html = `<form>
      <div id="div_id_required_deliver_units"></div>
      <button hx-post="/a/x/opportunity/42/sync_deliver_units/">Sync</button>
    </form>`;
    const out = parseDeliverUnitFormCheckboxes(html);
    expect(out.size).toBe(0);
  });

  it('handles the legacy fallback shape (label outside the input)', () => {
    // Some older Connect templates rendered:
    //   <input name="required_deliver_units" value="9001"> Bare label text
    // instead of wrapping the input in a <label>…</label>. The parser
    // falls back to capturing bare text after the input.
    const html = `<input type="checkbox" name="required_deliver_units" value="9001"> Bare DU Name`;
    const out = parseDeliverUnitFormCheckboxes(html);
    expect(out.get('Bare DU Name')).toBe('9001');
  });
});
