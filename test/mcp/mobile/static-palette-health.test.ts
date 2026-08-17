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

// The APK the palette is actually resolved against at RUNTIME — the default
// on `mobile_resolve_selectors` / `prepareRecipeForMaestro`, the `.env` pin,
// and what `/ace:doctor`'s `selector_map_currency` probe reports. This
// constant read `2.63.0` until 2026-08-01, i.e. one map BEHIND the live
// default, which meant a palette piece could reference a row that exists in
// the map every run uses and still fail here (ace#1138 Gap 2's case-list rows
// were live-calibrated on 2.63.2 and, per § close the loop to the source of
// truth, must NOT be back-copied into the 2.63.0 map to satisfy a test).
// Keep this in step with the runtime default when the pin moves.
const DEFAULT_APK = '2.63.2';

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

  it('guards the download-gate tap on the GATE ITSELF, not on viewJobCard (#893)', () => {
    // This invariant was INVERTED until #893. The old rule required the
    // tap to sit behind `notVisible: ${SELECTOR:deliver-home-job-card}`,
    // on the belief that viewJobCard is absent on the Learn home. It is
    // not: on connect-2.63.0 the Learn home renders viewJobCard once the
    // opp is claimed, so that guard read "already in Deliver" while we
    // were still in Learn, skipped the § 9 Download Delivery gate, never
    // installed the Deliver CCZ, and walked the Learn Pre-assessment
    // instead of the household survey. The test passed the whole time,
    // because it pinned the defect.
    //
    // Correct rule (ACE's "attempt the transition, treat the conflict as
    // the skip"): decide on the GATE element. Tap DOWNLOAD iff DOWNLOAD
    // is actually on screen.
    const guardRe = /when:\s*\n\s+visible:\s*\n\s+\$\{SELECTOR:deliver-download-button\}/;
    const m = guardRe.exec(yaml);
    expect(m, 'deliver-launch must guard the download tap on the DOWNLOAD button itself').not.toBeNull();
    const guardBlock = yaml.slice(m!.index, m!.index + 900);
    expect(guardBlock).toMatch(/tapOn:\s*\n\s*\$\{SELECTOR:deliver-download-button\}/);

    // No UNguarded tap on the download button before that guard.
    const beforeGuard = yaml.slice(0, m!.index);
    expect(beforeGuard).not.toMatch(/tapOn:\s*\n\s*\$\{SELECTOR:deliver-download-button\}/);
  });

  it('never re-introduces the viewJobCard guard around the download gate (#893)', () => {
    // Direct regression guard: viewJobCard must not gate the download
    // sequence again, under any phrasing.
    const stripped = yaml
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(
      stripped,
      'viewJobCard is not a Learn-vs-Deliver differentiator — see #893 and the selector-map note',
    ).not.toMatch(/when:\s*\n\s+notVisible:\s*\n\s+\$\{SELECTOR:deliver-home-job-card\}/);
  });

  it('asserts a REAL Deliver differentiator, not just viewJobCard (#893)', () => {
    // viewJobCard renders on the Learn home too once the opp is claimed,
    // so asserting it alone lets deliver-launch go green while sitting in
    // Learn. The delivery-quota row is the differentiator that actually
    // separates the two surfaces (live-diffed from
    // hh-poverty-targeting/20260722-1341's learn vs deliver home captures).
    expect(yaml).toMatch(/assertVisible:\s*\n\s*\$\{SELECTOR:deliver-home-daily-visits\}/);
  });

  it('keeps the download wait non-halting on the already-downloaded path (#747)', () => {
    // #747's protection must survive the #893 restructure: on a retry
    // whose prior dispatch consumed the gate, DOWNLOAD never renders, so
    // the wait has to fall through instead of halting at 30s.
    const waitRe =
      /extendedWaitUntil:\s*\n\s+visible:\s*\n\s+\$\{SELECTOR:deliver-download-button\}\s*\n\s+timeout:\s*\d+\s*\n\s+optional:\s*true/;
    expect(waitRe.test(yaml), 'the DOWNLOAD wait must be optional: true').toBe(true);
  });

  it('has an already-installed entry branch for the Deliver suite menu', () => {
    expect(yaml).toContain('${SELECTOR:deliver-suite-menu}');
  });

  it('records the Deliver home EXACTLY ONCE, unconditionally (#869)', () => {
    // Both halves of this assertion are load-bearing, and the issue's own
    // proposed fix would have broken one of them.
    //
    //   >= 1  — on the FRESH-INSTALL path the already-installed branch never
    //           fires, so the end-of-palette shot is the only Deliver-home
    //           frame in the entire run. #869 offered "drop the unconditional
    //           end-of-palette shot" as an option; taking it would have traded
    //           duplicate frames on one path for ZERO frames on the other.
    //   <= 1  — on the ALREADY-INSTALLED path a nested branch shot fires in
    //           addition to the end-of-palette one, producing two
    //           byte-identical captures. That is the defect #869 reports.
    //
    // Enforcing both at once pins the only shape that satisfies both paths:
    // one Deliver-home shot, at column 0 (outside any runFlow.commands), so
    // it fires unconditionally. As a bonus that keeps it a top-level step,
    // which is what makes it this palette's UI-dump window in default mode
    // (see recipe-splitter.test.ts's `toBe(1)`).
    const lines = yaml.split('\n').filter((l) => !l.trim().startsWith('#'));

    const homeShots = lines.filter((l) => /takeScreenshot:\s*"[^"]*home"/.test(l));
    expect(
      homeShots,
      `deliver-launch must record the Deliver home exactly once; found: ${JSON.stringify(homeShots)}`,
    ).toHaveLength(1);

    // Column 0 — a top-level list item, not indented into a runFlow's
    // `commands:` block. A nested shot is by definition conditional.
    expect(
      homeShots[0].startsWith('- takeScreenshot:'),
      'the Deliver-home shot must be top-level (unconditional), not nested inside a runFlow branch',
    ).toBe(true);
  });
});

describe('static palette health — no palette re-shoots a home its caller already recorded (#869)', () => {
  // deliver-form-walk is entered ONLY from a Deliver home that the caller has
  // already captured — deliver-launch's `deliver-launch-home` on the
  // registration leg, form-submit's post-submit shot on the followup leg. An
  // opening home shot here is therefore always a duplicate of the frame
  // immediately preceding it.
  it('deliver-form-walk does not open with its own home shot', () => {
    const walk = readFileSync(`${STATIC_DIR}deliver-form-walk.yaml`, 'utf8');
    expect(walk).not.toMatch(/takeScreenshot:\s*"deliver-form-walk-home"/);
  });
});

describe('static palette health — connect-claim-opp landing classification (#863)', () => {
  // #570 taught the claim recipe exactly one already-Learn-complete surface:
  // the Deliver DOWNLOAD gate. Once the Deliver CCZ is installed there is no
  // download button left to land on, so that branch is not taken and the run
  // lands on the DELIVER home instead. `learn-home-screen` cannot catch it —
  // it resolves to `nsv_home_screen`, the generic StandardHomeActivity
  // ScrollView, which renders identically on both homes. The fresh-Learn
  // branch therefore accepted the Deliver home as "Learn is ready", and the
  // caller's Learn leg walked into the Deliver suite and died on
  // selector-not-found on a perfectly healthy opp.
  const yaml = readFileSync(`${STATIC_DIR}connect-claim-opp.yaml`, 'utf8');
  const stripped = yaml
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

  it('classifies the already-installed Deliver-home landing (#863)', () => {
    // The distinctly-named artifact is the contract: app-screenshot-capture
    // Step 2.7 reads it to record `satisfied-by-prior-completion` rather than
    // halting. Renaming it silently re-breaks that handoff.
    expect(
      stripped,
      'connect-claim-opp must capture a distinctly-named artifact for the ' +
        'Learn-complete + Deliver-installed landing (#863)',
    ).toMatch(/takeScreenshot:\s*"claim-already-learn-complete-deliver-app-installed"/);
  });

  it('branches that landing on the REAL differentiator, not viewJobCard (#863/#893)', () => {
    // The delivery-quota row is the only live-verified Learn-vs-Deliver
    // signal (#893, dcd45450). viewJobCard renders on BOTH homes once the
    // opp is claimed, and the "... - Learn app" toolbar suffix is truncated
    // behind the ellipsis on both at 1080x2400 — so neither can stand in.
    expect(stripped).toMatch(
      /when:\s*\n\s+visible:\s*\n\s+\$\{SELECTOR:deliver-home-daily-visits\}/,
    );
    expect(
      stripped,
      'viewJobCard is not a Learn-vs-Deliver differentiator — see #893',
    ).not.toMatch(/\$\{SELECTOR:deliver-home-job-card\}/);
  });

  it('classifies AFTER the home wait, not before it (#863)', () => {
    // Timing-robustness, and the reason this is not a pre-wait guard: at
    // branch time the target home may not have rendered yet (the 180s wait
    // is what waits for it), so a pre-wait test would fall through to the
    // fresh-Learn path on exactly the slow case it exists to catch.
    const waitIdx = stripped.search(
      /extendedWaitUntil:\s*\n\s+visible:\s*\n\s+id:\s*"\$\{SELECTOR:learn-home-screen\}"/,
    );
    const classifyIdx = stripped.search(
      /when:\s*\n\s+visible:\s*\n\s+\$\{SELECTOR:deliver-home-daily-visits\}/,
    );
    expect(waitIdx, 'the fresh-Learn home wait must still exist').toBeGreaterThan(-1);
    expect(classifyIdx, 'the #863 classification branch must exist').toBeGreaterThan(-1);
    expect(
      classifyIdx,
      'the Deliver-home classification must run AFTER the home wait',
    ).toBeGreaterThan(waitIdx);
  });

  it('keeps the #570 Deliver-gate surface intact', () => {
    // The new branch is additive — it must not displace the download-gate
    // landing #570 already handles.
    expect(stripped).toMatch(/takeScreenshot:\s*"claim-already-learn-complete-deliver-gate"/);
  });
});

// ---------------------------------------------------------------------------
// Citation-currency ratchet (dimagi-internal/ace#972).
//
// #972 was not a code defect: `form-submit.yaml` declared the Deliver
// finalize surface UNVERIFIED while its own sibling `deliver-sync.yaml`
// documented the live observation, and `app-test-cases` named the 2.62.0
// atlas "ground truth" months after DEFAULT_APK_VERSION moved to 2.63.2.
// Both are the same class: a doc that keeps asserting a stale version's
// map is authoritative, which then reads as a device-validation blocker
// nobody can clear.
//
// This ratchet makes the class structurally impossible to re-accumulate
// on the NEXT APK bump: nothing author-facing may name a selector map
// older than the default without saying so.
// ---------------------------------------------------------------------------
describe('citation currency vs DEFAULT_APK_VERSION (#972)', () => {
  const APK_RE = /connect-(\d+\.\d+\.\d+)(?:\.yaml|\.md)/g;

  /** Compare dotted versions numerically. */
  const olderThan = (a: string, b: string): boolean => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
    }
    return false;
  };

  it('DEFAULT_APK_VERSION is readable from client.ts', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../mcp/mobile/client.ts', import.meta.url)),
      'utf8',
    );
    const m = src.match(/DEFAULT_APK_VERSION\s*=\s*'([\d.]+)'/);
    expect(m, 'DEFAULT_APK_VERSION must stay greppable — this ratchet keys on it').toBeTruthy();
  });

  it('no palette recipe cites a selector map older than the default APK', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../mcp/mobile/client.ts', import.meta.url)),
      'utf8',
    );
    const def = src.match(/DEFAULT_APK_VERSION\s*=\s*'([\d.]+)'/)![1];

    const dir = fileURLToPath(new URL('../../../mcp/mobile/recipes/static/', import.meta.url));
    const offenders: string[] = [];

    for (const f of readdirSync(dir).filter((n) => n.endsWith('.yaml'))) {
      const text = readFileSync(dir + f, 'utf8');
      for (const m of text.matchAll(APK_RE)) {
        const cited = m[1];
        if (!olderThan(cited, def)) continue;
        // A stale citation is allowed ONLY when the same line marks it as
        // historical — that is the honest form and the one #972 was missing.
        const line = text.split('\n').find((l) => l.includes(m[0])) ?? '';
        if (/historical|superseded|was written against|one minor behind|not ground truth/i.test(line)) {
          continue;
        }
        offenders.push(`${f}: cites ${m[0]} (default is ${def}) — "${line.trim().slice(0, 90)}"`);
      }
    }

    expect(
      offenders,
      `Palette recipes cite a stale selector map without marking it historical.\n` +
        `Either repoint at connect-${def}, or say on the same line that the citation is historical.\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('form-submit.yaml no longer declares the Deliver finalize surface unknown', () => {
    // The specific #972 regression: the header claimed we "don't know" whether
    // Deliver forms auto-finalize, while deliver-sync.yaml recorded that we do.
    const text = readFileSync(
      fileURLToPath(new URL('../../../mcp/mobile/recipes/static/form-submit.yaml', import.meta.url)),
      'utf8',
    );
    expect(text, 'the UNVERIFIED banner was retired by #972').not.toMatch(
      /UNVERIFIED — atlas walk hasn't passed/,
    );
    expect(text, 'Deliver post-state is no longer "(TBD)"').not.toMatch(/Deliver forms \(TBD\)/);
    expect(
      text,
      'the header must point at the recipe that actually recorded the observation',
    ).toMatch(/deliver-sync\.yaml/);
  });
});
