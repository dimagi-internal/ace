import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments, parse as parseYaml } from 'yaml';

import { lintRecipeText } from '../../../mcp/mobile/recipe-lint.js';
import { resolveSelectorsInYaml } from '../../../mcp/mobile/recipe-resolver.js';

// Whole-palette health gate. Every recipe under `mcp/mobile/recipes/
// static/` is load-bearing — generated Phase 3 recipes runFlow into
// these by name. If a palette file silently drifts (broken YAML,
// missing appId, lint violation, unresolved selector ref), every
// downstream opp would silently break at Phase 6.
//
// These per-file assertions guard the palette contract: parse, lint,
// every selector reference resolves against the default APK map.
//
// Per-file content invariants (specific recipe behavior — e.g. which
// scrollUntilVisible anchors which button) live in
// `static-recipe-invariants.test.ts`. This file is the structural
// pre-flight; that file is the semantic one.

const STATIC_DIR = fileURLToPath(
  new URL('../../../mcp/mobile/recipes/static/', import.meta.url),
);

const DEFAULT_APK = '2.63.0';

const paletteFiles: string[] = readdirSync(STATIC_DIR).filter((n) => n.endsWith('.yaml'));

describe('static palette health — file inventory', () => {
  it('palette directory is non-empty (sanity check)', () => {
    expect(paletteFiles.length).toBeGreaterThan(0);
  });

  it('includes the load-bearing core palette pieces', () => {
    // These are the pieces every generated Phase 3 recipe runFlow into.
    // If one of these gets renamed without an explicit migration, the
    // generated recipes silently break at Phase 6 with a "file not
    // found" Maestro error. Pin them by name.
    const required = [
      'connect-login.yaml',
      'connect-claim-opp.yaml',
      'learn-launch.yaml',
      'learn-tap-module.yaml',
      'form-advance.yaml',
      'form-submit.yaml',
      'content-form-finish.yaml',
      'learn-suite-reentry.yaml',
      'deliver-launch.yaml',
      'connect-resume-opp.yaml',
    ];
    for (const name of required) {
      expect(paletteFiles, `${name} must exist in mcp/mobile/recipes/static/`).toContain(name);
    }
  });
});

describe.each(paletteFiles)('static palette health — %s', (filename) => {
  const yaml = readFileSync(`${STATIC_DIR}${filename}`, 'utf8');

  it('parses as multi-document YAML (front-matter + step list)', () => {
    // Maestro recipes use two YAML documents separated by `---`:
    // the first carries `appId` (+ optional env), the second is the
    // step list (a top-level YAML array). Bad indentation or stray
    // tabs surface here as parse errors.
    const docs = parseAllDocuments(yaml);
    // Some palette files (e.g. learn-tap-module.yaml's nested runFlow
    // shape) parse as a single document; that's fine. The real
    // assertion is "no parse errors."
    for (const doc of docs) {
      expect(doc.errors, `${filename}: YAML parse errors`).toEqual([]);
    }
  });

  it('declares appId in the front-matter', () => {
    // Every static palette piece is meant to launch into / drive the
    // Connect-integrated CommCare app. Maestro requires the appId at
    // the head — omission produces a confusing "no project selected"
    // error at run time.
    expect(yaml, `${filename}: missing 'appId:' declaration`).toMatch(
      /^\s*appId:\s*\S+/m,
    );
  });

  it('passes the static lint (no inputText-scalar-with-sibling-option, etc.)', () => {
    // recipe-lint.ts catches the YAML-shape antipatterns that even
    // a clean parser will silently accept (or that Maestro rejects
    // with an unhelpful generic parse error). Every palette piece
    // must pass — they are the canonical examples generated recipes
    // model themselves on.
    const r = lintRecipeText(yaml);
    if (!r.ok) {
      const summary = r.violations
        .map((v) => `[${v.rule}] line ${v.line}: ${v.detail}`)
        .join('\n');
      throw new Error(`${filename}: lint violations:\n${summary}`);
    }
  });

  it('every ${SELECTOR:foo} reference resolves against the default APK selector map', () => {
    // Generated Phase 3 recipes inherit selector resolution from the
    // palette pieces they runFlow into. If a palette piece references
    // a logical selector that the active map does not provide, every
    // downstream recipe blocks at Phase 3's selector-resolution gate
    // (Step 3.4 of skills/app-test-cases/SKILL.md) — but ONLY at
    // recipe-write time, never at palette-edit time. This per-palette
    // assertion catches the same class at PR review.
    //
    // Palette files reference selectors directly via the same
    // `${SELECTOR:logical-name}` syntax that generated recipes use.
    // Pass each palette through `resolveSelectorsInYaml` and assert
    // `unresolved` comes back empty.
    const selectorRefs = [...yaml.matchAll(/\$\{SELECTOR:([a-z0-9-]+)\}/g)];
    if (selectorRefs.length === 0) {
      // Nothing to resolve — this palette piece uses literal selectors
      // only (form-advance.yaml is one example today). That is a
      // legitimate state, not a failure.
      return;
    }
    const result = resolveSelectorsInYaml(yaml, DEFAULT_APK);
    expect(
      result.unresolved,
      filename +
        ': unresolved ${SELECTOR:...} references — add rows to mcp/mobile/selectors/connect-' +
        DEFAULT_APK +
        '.yaml or rename the placeholder to match an existing logical name',
    ).toEqual([]);
  });
});

describe('connect-2.63.0 camera selectors — live-calibrated (jjackson/ace#593)', () => {
  // The camera-* logical selectors were live-calibrated on 2026-05-31
  // against the malaria-rdt RDT Sample photo walk (ACE_Pixel_API_34,
  // CommCare 2.63.0): "TAKE PICTURE" → AOSP camera → shutter →
  // intent-review tray → "Done". The resource-ids below were transcribed
  // from mobile_capture_ui_dump output at each surface, NOT guessed.
  // This block locks that close-the-loop result so a future edit can't
  // silently revert to the old wrong-package guesses
  // (org.commcare.dalvik:id/camera_shutter_button / save_photo_button).
  const MAP_PATH = fileURLToPath(
    new URL('../../../mcp/mobile/selectors/connect-2.63.0.yaml', import.meta.url),
  );
  const map = parseYaml(readFileSync(MAP_PATH, 'utf8')) as {
    selectors: Record<string, { type: string; value: string; unverified?: boolean }>;
  };

  const expected: Record<string, { type: string; value: string }> = {
    'camera-take-photo': { type: 'text', value: 'TAKE PICTURE' },
    'camera-shutter-button': { type: 'id', value: 'com.android.camera2:id/shutter_button' },
    'camera-save-photo': { type: 'id', value: 'com.android.camera2:id/done_button' },
    'camera-retake-photo': { type: 'id', value: 'com.android.camera2:id/retake_button' },
    'camera-cancel-photo': { type: 'id', value: 'com.android.camera2:id/cancel_button' },
  };

  it.each(Object.entries(expected))(
    '%s resolves to the live-dumped matcher and is not flagged unverified',
    (name, want) => {
      const entry = map.selectors[name];
      expect(entry, `${name} missing from connect-2.63.0.yaml`).toBeDefined();
      expect(entry.type).toBe(want.type);
      expect(entry.value).toBe(want.value);
      // These are live-verified — the unverified flag must be absent.
      expect(entry.unverified ?? false, `${name} must not be unverified after live calibration`).toBe(
        false,
      );
    },
  );

  it('the camera controls live in the com.android.camera2 package, not org.commcare.dalvik', () => {
    // The titled #593 defect: the old guesses pointed the shutter/save
    // controls at org.commcare.dalvik ids that do not exist. The camera
    // app is a separate package; assert no camera control regresses to
    // the in-app package id-namespace.
    for (const name of ['camera-shutter-button', 'camera-save-photo', 'camera-retake-photo', 'camera-cancel-photo']) {
      expect(map.selectors[name].value).toMatch(/^com\.android\.camera2:id\//);
    }
  });
});

describe('static palette health — palette/lint round-trip on selector substitution', () => {
  it('every palette file with selectors still parses + lints after substitution', () => {
    // The substituted YAML (what Maestro actually consumes at runtime)
    // is where any text-anchor selector lands as a literal string. If
    // the selector map has a row that produces a malformed `id:` or
    // `text:` line, the post-substitution YAML breaks even though the
    // raw palette file looks fine. Catch it here.
    for (const filename of paletteFiles) {
      const yaml = readFileSync(`${STATIC_DIR}${filename}`, 'utf8');
      const hasRefs = /\$\{SELECTOR:[a-z0-9-]+\}/.test(yaml);
      if (!hasRefs) continue;
      const result = resolveSelectorsInYaml(yaml, DEFAULT_APK);
      // Post-substitution YAML must still parse and still lint clean.
      const docs = parseAllDocuments(result.yaml);
      for (const doc of docs) {
        expect(doc.errors, `${filename}: post-substitution YAML parse errors`).toEqual([]);
      }
      const lint = lintRecipeText(result.yaml);
      if (!lint.ok) {
        throw new Error(
          `${filename}: lint violations AFTER selector substitution:\n` +
            lint.violations.map((v) => `[${v.rule}] line ${v.line}: ${v.detail}`).join('\n'),
        );
      }
    }
  });
});

describe('static palette health — deliver-launch retry-proofing invariant (#747)', () => {
  // A Phase 6 retry whose prior dispatch consumed the Download Delivery gate
  // resumes directly inside the Deliver app — the gate never renders, and an
  // UNCONDITIONAL wait on the download button halts the recipe at 30s
  // (bednet-spot-check/20260609-0909 retry). These invariants pin the fix:
  // the download-gate sequence must stay guarded on NOT-already-in-Deliver,
  // and the already-installed surfaces must have entry branches.
  const yaml = readFileSync(`${STATIC_DIR}deliver-launch.yaml`, 'utf8');

  it('guards the download-gate tap behind notVisible: deliver-home-job-card', () => {
    // The tap must appear only INSIDE a guarded runFlow body, after a
    // structural `when: / notVisible: / ${SELECTOR:deliver-home-job-card}`
    // guard (NOT a mention of the word in a comment).
    const guardRe = /when:\s*\n\s+notVisible:\s*\n\s+\$\{SELECTOR:deliver-home-job-card\}/;
    const m = guardRe.exec(yaml);
    expect(m, 'deliver-launch must carry the structural notVisible guard').not.toBeNull();
    const guardBlock = yaml.slice(m!.index, m!.index + 900);
    expect(guardBlock).toContain('${SELECTOR:deliver-download-button}');
    // No UNguarded tap on the download button anywhere before the guard.
    const beforeGuard = yaml.slice(0, m!.index);
    expect(beforeGuard).not.toMatch(/tapOn:\s*\n\s*\$\{SELECTOR:deliver-download-button\}/);
  });

  it('has an already-installed entry branch for the Deliver suite menu', () => {
    expect(yaml).toContain('${SELECTOR:deliver-suite-menu}');
  });
});
