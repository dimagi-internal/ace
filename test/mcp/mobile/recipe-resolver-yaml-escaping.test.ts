/**
 * ace#2963 — selector values are spliced into a recipe as YAML
 * double-quoted scalars, so they must be escaped. The 2.64.0
 * `geopoint-captured-readout` row is the regex `[\s\S]*Accuracy: [\s\S]*`;
 * splicing it raw produced `text: "[\s\S]*..."`, which is invalid YAML
 * (`\s` is not a legal escape) and Maestro rejected the chunk with
 * "Parsing Failed" on noora-health/20261015-1129 Phase 6.
 */
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  resolveSelectorsInYaml,
  yamlQuote,
} from '../../../mcp/mobile/recipe-resolver.js';

const READOUT = '[\\s\\S]*Accuracy: [\\s\\S]*';

describe('selector values are YAML-escaped when spliced (ace#2963)', () => {
  it('key position: geopoint-captured-readout round-trips through yaml.parse', () => {
    const recipe = `
- extendedWaitUntil:
    visible:
      \${SELECTOR:geopoint-captured-readout}
    timeout: 30000
`;
    const r = resolveSelectorsInYaml(recipe, '2.64.0');
    expect(r.unresolved).toEqual([]);
    const parsed = parseYaml(r.yaml) as Array<{
      extendedWaitUntil: { visible: { text: string } };
    }>;
    expect(parsed[0].extendedWaitUntil.visible.text).toBe(READOUT);
  });

  it('value position: geopoint-captured-readout round-trips through yaml.parse', () => {
    const recipe = `
- extendedWaitUntil:
    visible:
      text: "\${SELECTOR:geopoint-captured-readout}"
    timeout: 30000
`;
    const r = resolveSelectorsInYaml(recipe, '2.64.0');
    expect(r.unresolved).toEqual([]);
    const parsed = parseYaml(r.yaml) as Array<{
      extendedWaitUntil: { visible: { text: string } };
    }>;
    expect(parsed[0].extendedWaitUntil.visible.text).toBe(READOUT);
  });

  it('a value with an embedded double quote round-trips', () => {
    const value = 'Latitude: N 12°0\'7" [\\s\\S]*';
    const doc = `text: ${yamlQuote(value)}`;
    expect((parseYaml(doc) as { text: string }).text).toBe(value);
  });

  it('plain values render exactly as before', () => {
    expect(yamlQuote('org.commcare.dalvik:id/nav_btn_next')).toBe(
      '"org.commcare.dalvik:id/nav_btn_next"',
    );
  });
});
