/**
 * The APK pin-site enumeration, machine-checked.
 *
 * Jonathan, 2026-09-05: *"we had a lot of gotchas last time we upgraded because
 * I didn't do an explicit update-version step."* A checklist fixes that once.
 * This test is what stops it rotting the first time someone adds a fourth pin
 * site — the failure the operator actually described is "I forgot a knob", and
 * a knob nobody wrote down is invisible until a device walk burns wall-clock.
 *
 * Three obligations, in increasing order of how easy they are to miss:
 *
 *  1. every `pin` agrees with every other `pin`  (a half-flip is invisible —
 *     `mobile_resolve_selectors` would read a different map than the runtime
 *     loads, and nothing surfaces it until a walk fails);
 *  2. every discovered site is NAMED in `skills/connect-apk-upgrade/SKILL.md`
 *     (the checklist cannot silently go stale);
 *  3. no APK-shaped version literal exists that the scanner failed to classify
 *     (a pin in a NEW syntax fails here, naming the two files to edit).
 *
 * Evidence class: STATIC. Nothing here is sent to or matched against a device.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PIN_FORMS,
  VERSION_KEYED_ARTIFACT_DIRS,
  findPinSitesInText,
  findPinSuspectsInText,
  scanApkPinSites,
  mustFlipSites,
  filesRequiringChecklistMention,
} from '../../lib/apk-pin-sites.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILL_PATH = 'skills/connect-apk-upgrade/SKILL.md';
const skill = () => readFileSync(new URL(`../../${SKILL_PATH}`, import.meta.url), 'utf-8');

describe('pin-form classification (unit)', () => {
  const cases: [string, string, string][] = [
    ['code-default-const', "export const DEFAULT_APK_VERSION = '2.63.2';", '2.63.2'],
    ['default-parameter', "  apkVersion: string = '2.63.2',", '2.63.2'],
    ['zod-schema-default', "    apkVersion: z.string().default('2.63.2').describe('...'),", '2.63.2'],
    ['env-fallback', "const D = process.env.ACE_CONNECT_APK_VERSION || '2.63.2';", '2.63.2'],
    ['env-tpl-pin', 'ACE_CONNECT_APK_VERSION=2.63.2', '2.63.2'],
    ['selector-map-self-declaration', 'apk_version: "2.63.2"', '2.63.2'],
    ['prose-default-apk', 'the `${SELECTOR:...}` map (default APK 2.63.2) plus lint', '2.63.2'],
    ['prose-default-paren', 'and `ACE_CONNECT_APK_VERSION` (default 2.63.2).', '2.63.2'],
    ['manifest-example', 'connect_apk_version: "2.63.0"', '2.63.0'],
  ];

  it.each(cases)('classifies %s', (form, line, version) => {
    const hits = findPinSitesInText('probe.ts', line);
    expect(hits.map((h) => h.form)).toContain(form);
    expect(hits.find((h) => h.form === form)!.version).toBe(version);
  });

  it('every declared form is exercised above', () => {
    // A form nobody tests is a form that can silently stop matching.
    expect(new Set(cases.map((c) => c[0]))).toEqual(new Set(PIN_FORMS.map((f) => f.name)));
  });

  it('does not classify a version that merely appears in prose', () => {
    expect(findPinSitesInText('x.md', 'Live-verified 2026-06-01 against 2.63.2 on a device.')).toEqual([]);
    expect(findPinSuspectsInText('x.md', 'Live-verified 2026-06-01 against 2.63.2 on a device.')).toEqual([]);
  });

  it('flags a pin written in a NEW syntax as an unclassified suspect', () => {
    // This is the whole point: the next pin site will not look like any of the
    // nine forms above, and the checklist must not be allowed to miss it.
    const invented = "const FALLBACK_APK_VERSION = '2.64.0';";
    expect(findPinSitesInText('mcp/mobile/new.ts', invented)).toEqual([]);
    const suspects = findPinSuspectsInText('mcp/mobile/new.ts', invented);
    expect(suspects).toHaveLength(1);
    expect(suspects[0].version).toBe('2.64.0');
  });

  it('a classified line is never also reported as a suspect', () => {
    const line = "    apkVersion: z.string().default('2.63.2').describe('Defaults to 2.63.2; bump when re-baselining.'),";
    expect(findPinSitesInText('mcp/mobile-server.ts', line)).toHaveLength(1);
    expect(findPinSuspectsInText('mcp/mobile-server.ts', line)).toEqual([]);
  });
});

describe('the live repo scan', () => {
  const scan = scanApkPinSites(REPO_ROOT);

  it('finds the known pin sites (a scanner that finds nothing is broken, not clean)', () => {
    const pinPaths = new Set(scan.sites.filter((s) => s.kind === 'pin').map((s) => s.path));
    for (const p of [
      'mcp/mobile/client.ts',
      'mcp/mobile-server.ts',
      'mcp/mobile/recipe-resolver.ts',
      'scripts/probe-atlas-drift.ts',
      '.env.tpl',
    ]) {
      expect(pinPaths, `expected a pin site in ${p}`).toContain(p);
    }
  });

  it('every `pin` site holds the same version', () => {
    const pins = scan.sites.filter((s) => s.kind === 'pin');
    const distinct = [...new Set(pins.map((p) => p.version))];
    expect(
      distinct,
      `APK pins disagree — a half-flipped upgrade. Sites:\n` +
        pins.map((p) => `  ${p.version}  ${p.path}:${p.line}  (${p.form})`).join('\n') +
        `\nFlip them together per ${SKILL_PATH} § Step 5.`,
    ).toHaveLength(1);
  });

  it('every `doc-claim` states the same version the code pins', () => {
    const pinned = scan.sites.find((s) => s.kind === 'pin')!.version;
    for (const claim of scan.sites.filter((s) => s.kind === 'doc-claim')) {
      expect(
        claim.version,
        `${claim.path}:${claim.line} claims the default APK is ${claim.version}, but the code pins ` +
          `${pinned}. Prose that asserts a default is a pin site — flip it (${SKILL_PATH} § Step 5).`,
      ).toBe(pinned);
    }
  });

  it('each selector map declares its own filename version', () => {
    for (const decl of scan.sites.filter((s) => s.kind === 'map-self-declaration')) {
      const fromName = /connect-([\d.]+)\.yaml$/.exec(decl.path)?.[1];
      expect(fromName, `${decl.path} is not a connect-<version>.yaml`).toBeTruthy();
      expect(
        decl.version,
        `${decl.path} declares apk_version ${decl.version} — an upgrade ADDS a map, it never ` +
          `rewrites an older one.`,
      ).toBe(fromName);
    }
  });

  it('finds no unclassified APK pin suspect', () => {
    expect(
      scan.suspects,
      scan.suspects.length === 0
        ? ''
        : `An APK version is pinned in a syntax lib/apk-pin-sites.ts does not know:\n` +
          scan.suspects.map((s) => `  ${s.path}:${s.line}  ${s.snippet}`).join('\n') +
          `\nAdd a form to PIN_FORMS *and* a row to ${SKILL_PATH} § Step 5 — otherwise the next ` +
          `upgrade misses this knob, which is the exact failure that skill exists to prevent.`,
    ).toEqual([]);
  });

  it('the upgrade checklist names every file the scan found', () => {
    const body = skill();
    const missing = filesRequiringChecklistMention(scan).filter((f) => !body.includes(f));
    expect(
      missing,
      `${SKILL_PATH} does not name these pin sites:\n` +
        missing.map((f) => `  ${f}`).join('\n') +
        `\nThe checklist is only trustworthy if it is complete. Add each under § Step 5 with the ` +
        `right kind (pin / doc-claim / doc-example).`,
    ).toEqual([]);
  });

  it('does not demand the checklist list every historical map', () => {
    // The families grow by one member per upgrade; naming each would make the
    // checklist longer and less true every time it is used.
    expect(filesRequiringChecklistMention(scan).some((f) => f.startsWith('mcp/mobile/selectors/'))).toBe(
      false,
    );
    expect(scan.sites.some((s) => s.kind === 'map-self-declaration')).toBe(true);
  });

  it('the upgrade checklist names every version-keyed artifact family', () => {
    const body = skill();
    for (const dir of VERSION_KEYED_ARTIFACT_DIRS) {
      expect(body, `${SKILL_PATH} must name the ${dir} family`).toContain(dir);
    }
  });

  it('names the must-flip sites distinctly from the ones that may lag', () => {
    // A checklist that lumps an illustrative snippet in with a runtime pin
    // invites the whole-repo sed that rewrites the historical maps.
    const kinds = new Set(scan.sites.map((s) => s.kind));
    expect(kinds.has('pin')).toBe(true);
    expect(mustFlipSites(scan).every((s) => s.kind === 'pin' || s.kind === 'doc-claim')).toBe(true);
  });
});

describe('the skill is wired into the places an operator would look', () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf-8');

  it('is cross-linked from the mobile playbook', () => {
    expect(read('playbook/integrations/mobile-integration.md')).toContain('connect-apk-upgrade');
  });

  it('is cross-linked from selector-map-calibrate', () => {
    // Calibration is a STEP of an upgrade; someone who lands there first must
    // be told the pin flip exists, or they calibrate a map nothing loads.
    expect(read('skills/selector-map-calibrate/SKILL.md')).toContain('connect-apk-upgrade');
  });

  it('names the activation ORDER, not just the two commands', () => {
    const body = skill();
    expect(body).toContain('/ace:setup --force-env');
    const setupAt = body.indexOf('/ace:setup --force-env');
    const restartAt = body.indexOf('quit and reopen Claude Code');
    expect(restartAt, 'the skill must tell the operator to restart Claude Code').toBeGreaterThan(-1);
    expect(setupAt, 'setup --force-env must be documented BEFORE the restart (ace#880)').toBeLessThan(restartAt);
  });

  it('carries a rollback procedure and a verification checklist', () => {
    const body = skill();
    expect(body).toMatch(/##\s+Rollback/);
    expect(body).toMatch(/##\s+Verification checklist/);
  });
});
