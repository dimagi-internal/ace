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
});
