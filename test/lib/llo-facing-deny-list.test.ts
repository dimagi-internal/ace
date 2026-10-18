import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { checkTextAgainstDenyList, parseConfidentialityYaml } from '../../lib/llo-facing-deny-list';

// Real artifacts from connect-fi/20261018-1440, the run that surfaced ace#3190.
// Provenance: test/fixtures/llo-deny-list/connect-fi-20261018-1440/README.md
const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'llo-deny-list', 'connect-fi-20261018-1440');
const CONF = readFileSync(join(FIX, 'confidentiality.yaml'), 'utf8');
const WORK_ORDER = readFileSync(join(FIX, 'work-order.txt'), 'utf8');
const PDD_PARAGRAPH = readFileSync(join(FIX, 'pdd-confidentiality-paragraph.md'), 'utf8');
const LIST = parseConfidentialityYaml(CONF);

describe('parseConfidentialityYaml', () => {
  test('reads the real Drive export (CRLF, comments) through normalizeDenyList', () => {
    expect(LIST).toEqual(['GiveDirectly', 'Give Directly', 'GD']);
  });
  test('absent, empty, or keyless → []', () => {
    expect(parseConfidentialityYaml(undefined)).toEqual([]);
    expect(parseConfidentialityYaml('')).toEqual([]);
    expect(parseConfidentialityYaml('other_key: 1\n')).toEqual([]);
  });
  test('a malformed list throws rather than silently passing', () => {
    expect(() => parseConfidentialityYaml('llo_facing_deny_list: GiveDirectly\n')).toThrow();
    expect(() => parseConfidentialityYaml('- a\n- b\n')).toThrow();
  });
});

describe('checkTextAgainstDenyList', () => {
  test('positive control: the real rendered work order passes', () => {
    const r = checkTextAgainstDenyList(WORK_ORDER, LIST, 'The work order');
    expect(r.pass, r.detail).toBe(true);
  });
  test('negative control: the real work order with the PDD funder paragraph lifted in fails', () => {
    const r = checkTextAgainstDenyList(`${WORK_ORDER}\n${PDD_PARAGRAPH}`, LIST, 'The work order');
    expect(r.pass).toBe(false);
    for (const term of LIST) expect(r.detail).toContain(`"${term}"`);
    expect(r.detail).toContain('The funder is GiveDirectly');
    expect(r.auto_fix_hint).toBeTruthy();
  });
  test('negative control: case-insensitive, and the short token GD fires as a whole word', () => {
    expect(checkTextAgainstDenyList('funded by givedirectly.', LIST, 'x').pass).toBe(false);
    const r = checkTextAgainstDenyList("Builds on GD's 2024 pilot.", LIST, 'x');
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('"GD"');
  });
  test('positive control: GD inside a longer word does not match', () => {
    const r = checkTextAgainstDenyList('The budget is fixed. GDP per capita is low. Use the GDPR clause.', LIST, 'x');
    expect(r.pass).toBe(true);
  });
  test('no confidentiality.yaml (null) is a no-op pass that says so', () => {
    const r = checkTextAgainstDenyList(PDD_PARAGRAPH, null, 'The work order');
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/not applicable/);
  });
  test('an empty declared list passes', () => {
    expect(checkTextAgainstDenyList(PDD_PARAGRAPH, [], 'The work order').pass).toBe(true);
  });
});
