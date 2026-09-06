/**
 * dimagi-internal/ace#1998 — CommCare's version-upgrade gate is a RECOGNISED
 * surface, and it is never again conflated with the #629 inert handoff.
 *
 * ## What broke, and why a test rather than prose
 *
 * When a released CCZ's `profile.ccpr` requires a newer CommCare than the
 * pinned APK, CommCare interposes an upgrade gate instead of opening the app.
 * The claim recipe had no branch for it, fell through to its `nsv_home_screen`
 * assertion, and captured the failure as `claim-START-HANDOFF-WEDGED-issue629`
 * — a label belonging to a DIFFERENT class (#629 is the inert `btn_start`
 * handoff, where the launch never fired at all; here the launch worked and
 * CommCare deliberately refused). Three triages were sent at the wrong system.
 *
 * Both causes present identically at the same assertion, so the only thing
 * separating them is the guard asserted below. A comment cannot enforce that;
 * this can.
 *
 * ## Evidence class
 *
 * STATIC STRUCTURE over recipe YAML + the selector map. Nothing here is sent
 * to, or matched against, a device — these assertions are about which branch
 * a guard selects and how a capture is named, not about whether a selector
 * value is correct on a given APK. Unit tests are complete evidence
 * (CLAUDE.md § "the trigger is the CLAIM, not the directory").
 *
 * The selector VALUES themselves are recorded device truth, captured from a
 * live `mobile_capture_ui_dump` / `failureForensics.uiDumpPath` on APK 2.63.2
 * in bednet-check-2-visit/20260902-1555 Phase 6 Step 1. This suite pins them
 * so a later edit cannot quietly retype a resource-id that was measured.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const REPO = path.resolve(__dirname, '../../..');
const RECIPES = path.join(REPO, 'mcp/mobile/recipes/static');
const SELECTOR_MAP = path.join(REPO, 'mcp/mobile/selectors/connect-2.63.2.yaml');

/** The three recipes that can meet the gate on a launch handoff. */
const GATED_RECIPES = ['connect-claim-opp.yaml', 'learn-launch.yaml', 'deliver-launch.yaml'] as const;

const readRecipe = (f: string) => readFileSync(path.join(RECIPES, f), 'utf8');

/** Strip `#` comments so a rule never passes on prose that merely mentions a name. */
function code(yaml: string): string {
  return yaml
    .split('\n')
    .map((l) => (l.trimStart().startsWith('#') ? '' : l))
    .join('\n');
}

/** Parse the step list out of an ACE recipe (`appId` frontmatter + `---` + steps). */
function steps(yaml: string): unknown[] {
  const idx = yaml.indexOf('\n---\n');
  expect(idx, 'recipe must carry the `---` frontmatter separator').toBeGreaterThan(-1);
  const parsed = parseYaml(yaml.slice(idx + 5));
  expect(Array.isArray(parsed)).toBe(true);
  return parsed as unknown[];
}

/**
 * Walk every `runFlow` in a step tree, reporting each node together with the
 * set of guard conditions enclosing it. That enclosing set is the whole point:
 * a capture is only correctly disambiguated if a guard ABOVE it excluded the
 * other cause.
 */
interface Guarded {
  screenshot: string;
  visible: string[];
  notVisible: string[];
}

function collectScreenshots(node: unknown, visible: string[] = [], notVisible: string[] = []): Guarded[] {
  const out: Guarded[] = [];
  if (Array.isArray(node)) {
    for (const child of node) out.push(...collectScreenshots(child, visible, notVisible));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const rec = node as Record<string, unknown>;

  if (typeof rec.takeScreenshot === 'string') {
    out.push({ screenshot: rec.takeScreenshot, visible: [...visible], notVisible: [...notVisible] });
  }

  if (rec.runFlow && typeof rec.runFlow === 'object') {
    const flow = rec.runFlow as Record<string, unknown>;
    const when = (flow.when ?? {}) as Record<string, unknown>;
    const idOf = (c: unknown): string[] => {
      if (!c || typeof c !== 'object') return typeof c === 'string' ? [c] : [];
      const v = (c as Record<string, unknown>).id;
      return typeof v === 'string' ? [v] : [];
    };
    out.push(
      ...collectScreenshots(
        flow.commands,
        [...visible, ...idOf(when.visible)],
        [...notVisible, ...idOf(when.notVisible)],
      ),
    );
  }

  for (const [k, v] of Object.entries(rec)) {
    if (k === 'runFlow' || k === 'takeScreenshot') continue;
    if (v && typeof v === 'object') out.push(...collectScreenshots(v, visible, notVisible));
  }
  return out;
}

const TITLE = '${SELECTOR:commcare-version-prompt-title}';

describe('ace#1998 — the version gate is mapped', () => {
  const map = parseYaml(readFileSync(SELECTOR_MAP, 'utf8')) as {
    apk_version: string;
    selectors: Record<string, { type: string; value: string; purpose?: string }>;
  };

  // Recorded device truth — the exact resource-ids observed in the live
  // ui-dump. Pinned so a retype is a test failure, not a silent regression.
  it.each([
    ['commcare-version-prompt-title', 'org.commcare.dalvik:id/prompt_title'],
    ['commcare-version-update-later', 'org.commcare.dalvik:id/do_later_button'],
    ['commcare-version-update-now', 'org.commcare.dalvik:id/action_button'],
  ])('maps %s to its recorded resource-id', (name, value) => {
    const row = map.selectors[name];
    expect(row, `${name} missing from connect-${map.apk_version}.yaml`).toBeDefined();
    expect(row.type).toBe('id');
    expect(row.value).toBe(value);
  });

  it('cites the run the ids were captured from, so the evidence is auditable', () => {
    expect(map.selectors['commcare-version-prompt-title'].purpose).toMatch(/ace#1998/);
  });
});

describe('ace#1998 — every launch handoff recognises the gate', () => {
  it.each(GATED_RECIPES)('%s guards on the version-prompt title', (f) => {
    expect(code(readRecipe(f))).toContain(TITLE);
  });

  it.each(GATED_RECIPES)('%s captures the gate under its own distinct label', (f) => {
    const found = collectScreenshots(steps(readRecipe(f)))
      .filter((s) => s.visible.includes(TITLE))
      .map((s) => s.screenshot);
    expect(found.length, `${f} has no capture guarded on the version prompt`).toBeGreaterThan(0);
    for (const label of found) {
      expect(label).toMatch(/commcare-version-gate/);
      // The whole bug was a shared label. This is the regression.
      expect(label).not.toMatch(/issue629/);
    }
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * `claim-START-HANDOFF-WEDGED-issue629` must be unreachable while the
   * version prompt is on screen. Before ace#1998 it was reached by exactly
   * that path, which is how the gate was mislabelled.
   */
  it('never emits the #629 label while the version gate is on screen', () => {
    const shots = collectScreenshots(steps(readRecipe('connect-claim-opp.yaml')));
    const wedge = shots.filter((s) => s.screenshot.includes('issue629'));
    expect(wedge.length, 'the #629 diagnostic capture should still exist').toBe(1);
    expect(
      wedge[0].notVisible,
      'the #629 capture must be excluded when the version prompt is visible',
    ).toContain(TITLE);
  });

  /**
   * A deliberate product decision, locked so changing it is a conscious act.
   *
   * That `do_later_button` EXISTS is recorded device evidence. What dismissing
   * it then PERMITS has never been observed on any ACE run. Tapping it would
   * either be a no-op or would let Phase 6 proceed on a runtime the CCZ
   * declares unsupported — minting false-green screenshots, QA verdicts and a
   * training deck. See connect-claim-opp.yaml § the version-gate branch.
   */
  it.each(GATED_RECIPES)('%s recognises the gate but does not dismiss it', (f) => {
    expect(code(readRecipe(f))).not.toContain('${SELECTOR:commcare-version-update-later}');
  });
});
