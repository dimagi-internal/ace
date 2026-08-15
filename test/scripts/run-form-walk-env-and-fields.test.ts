/**
 * ace#993 — run-form-walk.ts never loaded .env, so the command block
 * documented in `app-hq-settings § Step 2` failed verbatim as written, and
 * reported it as an unrelated issue-#108 uid halt ("falling back to suite.xml
 * ... 0 forms") while the credentials were correctly provisioned all along.
 *
 * ace#994 — `--draft-only` emits uids only. Step 3 triggers on `kind: image`,
 * so a literal reading found zero image-bearing forms on a never-built draft
 * and silently skipped the camera-only patch. Halting instead would fire on
 * EVERY first-time run (the ace#1026 trap), so the inventory is made available
 * on a draft rather than the step made to stop.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');
const script = readFileSync(join(REPO, 'scripts/run-form-walk.ts'), 'utf8');
const skill = readFileSync(join(REPO, 'skills/app-hq-settings/SKILL.md'), 'utf8');
/** Strip comments so a docstring quoting a form doesn't satisfy a check. */
const code = script.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');

describe('ace#993 — the script loads .env itself', () => {
  it('calls dotenv', () => {
    expect(code).toMatch(/dotenvConfig\(/);
  });

  it('resolves the plugin-data dir rather than assuming a path', () => {
    // An MCP subprocess gets .env injected by its bootstrap; a plain
    // `npx tsx` invocation does not, and the installed script lives under
    // the versioned plugin cache.
    expect(code).toContain('resolvePluginDataDir(import.meta.url)');
  });

  it('falls back to cwd when not running from the installed plugin', () => {
    expect(code).toMatch(/process\.cwd\(\)/);
  });

  it('loads before any credential read, or the fix does nothing', () => {
    const load = code.indexOf('dotenvConfig(');
    const firstCredRead = code.indexOf('process.env.ACE_HQ_USERNAME');
    expect(load).toBeGreaterThan(-1);
    expect(firstCredRead).toBeGreaterThan(load);
  });
});

describe('ace#994 — a draft walk declares whether it collected fields', () => {
  it('emits fields_available', () => {
    expect(code).toMatch(/fields_available:/);
  });

  it('accepts --with-fields', () => {
    expect(code).toMatch(/'--with-fields'/);
  });

  it('sets fields_available strictly from the flag, never optimistically', () => {
    expect(code).toMatch(/fields_available: args\.with_fields === true/);
  });

  it('collects the inventory through the proven draft form-source path', () => {
    // The same /apps/browse/<app>/<form>/source/ route commcare_patch_xform
    // already uses against drafts in this very skill — not a new guess at
    // some draft-API endpoint.
    expect(code).toMatch(/getFormSource\(/);
    expect(code).toMatch(/walkFormFields\(src\.xform_xml\)/);
  });

  it('advertises the flag in usage', () => {
    expect(script).toMatch(/--draft-only \[--with-fields\]/);
  });
});

describe('ace#994 — the consumer cannot read absent as empty', () => {
  it('the skill states that a plain --draft-only emits no inventory', () => {
    expect(skill).toMatch(/emits NO field inventory/);
  });

  it('it says explicitly not to conclude there are no image fields', () => {
    expect(skill).toMatch(/Do NOT conclude the\s*\n?\s*app has no image fields/);
  });

  it('Step 3 carries a pre-flight on fields_available', () => {
    const step3 = skill.slice(skill.indexOf('### Step 3'));
    expect(step3).toMatch(/fields_available: false/);
    expect(step3).toMatch(/--with-fields/);
  });

  it('records the run it shipped on', () => {
    expect(skill).toContain('spark-facilitator/20260727-1850');
  });
});
