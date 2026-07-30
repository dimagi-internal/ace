import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MaestroBackend, ALLOWED_STEP_KEYS } from '../../../mcp/mobile/backends/maestro.js';

// Class-level preventer for dimagi-internal/ace#1008.
//
// `mobile_validate_recipe` gates AGENT-authored journey recipes against
// `ALLOWED_STEP_KEYS`, but the shipped static palette under
// `mcp/mobile/recipes/static/` never passes through the validator. When the two
// drift, agent-authored recipes are silently held to a narrower Maestro dialect
// than the palette they compose — `scrollUntilVisible` was used by
// `connect-resume-opp.yaml` and `connect-claim-opp.yaml` for months while the
// validator rejected it, forcing `app-test-cases` to either drop legitimate
// scroll-into-view behaviour or ship an unvalidated recipe.
//
// The allowlist edit is the instance fix; this test is the preventer.

const STATIC_DIR = fileURLToPath(
  new URL('../../../mcp/mobile/recipes/static/', import.meta.url),
);

function paletteFiles(): string[] {
  return readdirSync(STATIC_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort();
}

/**
 * Extract step keys exactly the way `MaestroBackend.validateRecipe` does:
 * split on the `---` separator, then match every `- <key>` list item in the
 * flow document. Keeping the extraction identical is the point — a divergent
 * parser here would test something the validator does not enforce.
 */
function stepKeysIn(yaml: string): string[] {
  const docs = yaml.split(/^---\s*$/m);
  const flow = docs[1] ?? '';
  return flow
    .split('\n')
    .filter((l) => l.trim().startsWith('- '))
    .map((l) => l.match(/^\s*-\s+([a-zA-Z]+)/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1]);
}

describe('static palette ↔ mobile_validate_recipe allowlist (ace#1008)', () => {
  const files = paletteFiles();

  it('finds the shipped palette', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('allowlists every step key the shipped static palette uses', () => {
    const offenders: Array<{ file: string; key: string }> = [];
    for (const file of files) {
      const yaml = readFileSync(`${STATIC_DIR}${file}`, 'utf8');
      for (const key of stepKeysIn(yaml)) {
        if (!ALLOWED_STEP_KEYS.has(key)) offenders.push({ file, key });
      }
    }
    expect(
      offenders,
      'a step key used by the static palette is not in ALLOWED_STEP_KEYS — ' +
        'agent-authored recipes would be rejected for a step ACE itself ships. ' +
        'Add it to ALLOWED_STEP_KEYS in mcp/mobile/backends/maestro.ts.',
    ).toEqual([]);
  });

  it('validateRecipe accepts every shipped palette recipe end-to-end', async () => {
    const backend = new MaestroBackend();
    for (const file of files) {
      await expect(
        backend.validateRecipe(`${STATIC_DIR}${file}`),
        `mobile_validate_recipe rejects the shipped palette recipe ${file}`,
      ).resolves.toBeUndefined();
    }
  });

  it('scrollUntilVisible specifically is allowlisted (the ace#1008 instance)', () => {
    expect(ALLOWED_STEP_KEYS.has('scrollUntilVisible')).toBe(true);
  });
});

// Third leg of the invariant — dimagi-internal/ace#1070.
//
// #1008 fixed ALLOWED_STEP_KEYS and pinned palette ⊆ Set (above). It left
// untouched the one artefact a recipe-AUTHORING agent actually reads: the
// `.describe()` string on `mobile_validate_recipe`, which restated the
// allowlist as a hardcoded literal. It kept advertising the pre-#1008 dialect
// (no `scrollUntilVisible`, `copyTextFrom`, `pasteText`) long after the Set
// was correct, so `app-test-cases` went on believing scroll steps were
// forbidden and emitted option taps with no scroll-into-view. Live cost:
// spark-facilitator/20260728-1338 Phase 6 halted on a below-the-fold answer
// option in the Learn pre-test.
//
// Restating a set is the bug. This pins that it stays DERIVED.
describe('mobile_validate_recipe description ↔ allowlist (ace#1070)', () => {
  const SERVER_SRC = fileURLToPath(
    new URL('../../../mcp/mobile-server.ts', import.meta.url),
  );
  const src = readFileSync(SERVER_SRC, 'utf8');

  it('derives the advertised allowlist from ALLOWED_STEP_KEYS', () => {
    expect(
      /\[\s*\.\.\.ALLOWED_STEP_KEYS\s*\]\s*\.join\(/.test(src),
      'the mobile_validate_recipe description must interpolate ALLOWED_STEP_KEYS, ' +
        'not restate it. A hardcoded list silently advertises a stale Maestro ' +
        'dialect to every recipe-authoring agent (ace#1070).',
    ).toBe(true);
  });

  it('does not restate the step keys as a hardcoded literal', () => {
    // The exact prefix the pre-#1070 literal opened with. Any reappearance
    // means someone inlined the list again.
    expect(
      src.includes('launchApp, tapOn, inputText'),
      'found a hardcoded step-key enumeration in mcp/mobile-server.ts — ' +
        'this is how the description drifted from ALLOWED_STEP_KEYS (ace#1070). ' +
        'Interpolate the Set instead.',
    ).toBe(false);
  });

  it('every allowlisted key reaches the description once interpolated', () => {
    const advertised = [...ALLOWED_STEP_KEYS].join(', ');
    for (const key of ALLOWED_STEP_KEYS) {
      expect(advertised).toContain(key);
    }
  });
});
