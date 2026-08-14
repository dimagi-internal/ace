/**
 * dimagi-internal/ace#1111 (2026-07-31 security audit, MCP finding F3, high)
 * — `mobile_run_recipe`'s `screenshotDir` could wipe a near-arbitrary
 * directory.
 *
 * `resetScreenshotDir` deletes every non-preserved entry under its `dir`
 * argument, and it is reached UNCONDITIONALLY from `mobile_run_recipe` with
 * the caller-supplied `screenshotDir`. The pre-existing guard refuses only the
 * filesystem root, single-segment paths, `$HOME` exactly, and `cwd` exactly —
 * so everything with >= 2 path segments was wiped:
 *
 *   mobile_run_recipe(recipePath: "<any bundled palette recipe>",
 *                     screenshotDir: "/Users/op/Documents")
 *
 * destroys `~/Documents`. `~/emdash/repositories`, `~/.ssh`, `~/Library`,
 * `/Users/op/code` all passed. `recipePath` can be any recipe already shipped
 * in `mcp/mobile/recipes/`, so no prior write is needed — and the delete
 * happens BEFORE the recipe runs, so no device even has to be present.
 * Unrecoverable: `force: true`, no trash.
 *
 * Threat model: `mobile_run_recipe` args are LLM-controlled, and ACE ingests
 * untrusted content that can prompt-inject the agent.
 *
 * The fix is containment under a dedicated root rather than a denylist of
 * shapes — a denylist can only ever enumerate the paths someone thought of.
 *
 * ## Classification: unit-test, not device-truth
 *
 * Per CLAUDE.md the trigger is the CLAIM, not the directory: this changes
 * nothing that is sent to, or matched against, the device — no selector, no
 * recipe step, no wait. It is path handling upstream of any device
 * interaction, in the same class as "screenshot naming and collection". The
 * cloud backend downloads S3 artifacts into the SAME caller-supplied dir
 * (`backends/cloud.ts:645`), so there is no second root to reconcile — which
 * was the open question that had this filed-not-fixed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  allowedScreenshotRoots,
  resetScreenshotDir,
  dispatchOutputDir,
} from '../../../mcp/mobile/screenshot-dir.js';

const ORIGINAL = process.env.ACE_SCREENSHOT_ROOT;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ACE_SCREENSHOT_ROOT;
  else process.env.ACE_SCREENSHOT_ROOT = ORIGINAL;
});

describe('screenshotDir containment (#1111)', () => {
  it('allows the documented convention every skill actually passes', () => {
    delete process.env.ACE_SCREENSHOT_ROOT;
    expect(allowedScreenshotRoots()).toContain('/tmp/ace-screenshots');
    expect(allowedScreenshotRoots()).toContain(path.join(os.tmpdir(), 'ace-screenshots'));
  });

  it('honours ACE_SCREENSHOT_ROOT as the single override', () => {
    process.env.ACE_SCREENSHOT_ROOT = '/opt/shots';
    expect(allowedScreenshotRoots()).toEqual(['/opt/shots']);
  });

  it.each([
    '/Users/op/Documents',
    '/Users/op/emdash/repositories',
    '/Users/op/.ssh',
    '/Users/op/Library',
    '/Users/op/code',
  ])('refuses %s — every one of these passed the old guard', (dir) => {
    delete process.env.ACE_SCREENSHOT_ROOT;
    expect(() => resetScreenshotDir(dir)).toThrow(/must be under/i);
  });

  it('names the allowed roots and the override in the refusal', () => {
    delete process.env.ACE_SCREENSHOT_ROOT;
    expect(() => resetScreenshotDir('/Users/op/Documents')).toThrow(/ACE_SCREENSHOT_ROOT/);
  });

  it('refuses a traversal that resolves outside the root', () => {
    delete process.env.ACE_SCREENSHOT_ROOT;
    expect(() => resetScreenshotDir('/tmp/ace-screenshots/../../Users/op/Documents')).toThrow(
      /must be under/i,
    );
  });

  it('refuses a sibling that merely shares the root as a PREFIX', () => {
    delete process.env.ACE_SCREENSHOT_ROOT;
    expect(() => resetScreenshotDir('/tmp/ace-screenshots-evil/x')).toThrow(/must be under/i);
  });

  it('still refuses the root itself — the wipe must be run-scoped', () => {
    delete process.env.ACE_SCREENSHOT_ROOT;
    expect(() => resetScreenshotDir('/tmp/ace-screenshots')).toThrow();
  });

  it('dispatchOutputDir is contained too, so namespacing cannot smuggle a path in', () => {
    delete process.env.ACE_SCREENSHOT_ROOT;
    expect(() => dispatchOutputDir('/Users/op/Documents', 'journey-learn')).toThrow(/must be under/i);
    expect(dispatchOutputDir('/tmp/ace-screenshots/opp/run-1', 'journey-learn')).toBe(
      '/tmp/ace-screenshots/opp/run-1/journey-learn',
    );
  });
});
