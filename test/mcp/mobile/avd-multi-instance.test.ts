import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static invariants on the cold-boot emulator argv (dimagi-internal/ace#1047).
 *
 * These are source-level assertions rather than unit tests because the
 * cold-boot spawn is `detached: true` + `unref()`, which `avd.test.ts` itself
 * documents as impractical to mock ("We can't easily mock the detached
 * `emulator` spawn from a unit test"). The same pattern ACE already uses for
 * `static-recipe-invariants` and `static-palette-health`: when the behavior
 * can't be exercised in-process, pin the source that produces it.
 *
 * WHY THIS EXISTS
 *
 * Ports are allocated per session (`port-allocator.ts`), but the AVD *name* is
 * not. Two ACE sessions on one workstation therefore both resolve to the
 * single provisioned AVD, and the second one dies with:
 *
 *   FATAL | Running multiple emulators with the same AVD is an
 *           experimental feature.
 *
 * `-read-only` is the supported way to run several instances of one AVD. Its
 * only documented cost is "cannot save snapshot" — which costs ACE nothing,
 * because the heal funnel already passes `-no-snapshot-save` and
 * `-no-snapshot-load` on every dispatch by design.
 *
 * NOTE: "snapshot" here means a QEMU VM-state save, NOT the screenshots Phase
 * 6 captures. Those are Maestro `takeScreenshot` steps and
 * `mobile_capture_ui_dump`, and `-read-only` does not touch them.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const avdSource = fs.readFileSync(
  path.resolve(here, '../../../mcp/mobile/backends/avd.ts'),
  'utf8',
);

/** The cold-boot argv literal — from `const args = [` to its closing `];`. */
function coldBootArgv(): string {
  const start = avdSource.indexOf("const args = [\n      '-avd',");
  expect(
    start,
    'could not locate the cold-boot argv literal in avd.ts — if it was refactored, update this test rather than deleting it',
  ).toBeGreaterThan(-1);
  const end = avdSource.indexOf('];', start);
  return avdSource.slice(start, end);
}

describe('cold-boot emulator argv (#1047)', () => {
  it("passes -read-only so a second session can run the SAME AVD concurrently", () => {
    expect(
      coldBootArgv(),
      'the cold-boot argv lost -read-only. Without it, a second ACE session on the same ' +
        'workstation dies with "Running multiple emulators with the same AVD is an ' +
        'experimental feature" and Phase 6 cannot walk the device (ace#1047).',
    ).toContain("'-read-only'");
  });

  it('still passes -no-snapshot-save / -no-snapshot-load, which is what makes -read-only free', () => {
    const argv = coldBootArgv();
    // If someone ever re-enables snapshot saving, -read-only stops being a
    // no-cost change and this pairing needs a deliberate decision.
    expect(
      argv,
      '-read-only forbids snapshot saving. That is only acceptable while the funnel ' +
        'cold-boots every dispatch. If -no-snapshot-save was removed, reconcile it with ' +
        '-read-only rather than silently keeping both.',
    ).toContain("'-no-snapshot-save'");
    expect(argv).toContain("'-no-snapshot-load'");
    expect(argv).toContain("'-wipe-data'");
  });

  it('captures emulator stderr instead of discarding it unconditionally', () => {
    // `stdio: 'ignore'` threw away the emulator's own fatal line, leaving the
    // operator with an opaque adb-register timeout 60s later. The fallback to
    // 'ignore' when the log file can't be opened is fine; an unconditional
    // 'ignore' is the regression.
    expect(
      avdSource,
      "the cold-boot spawn went back to an unconditional stdio: 'ignore'. That discards " +
        'the emulator fatal line and turns every launch failure into an opaque ' +
        'adb-register timeout (ace#1047).',
    ).not.toMatch(/spawn\('emulator', args, \{\s*\n\s*detached: true,\s*\n\s*stdio: 'ignore',/);
    expect(avdSource).toContain('bootLogPath');
  });

  it('surfaces the captured stderr on the boot-failure path', () => {
    expect(
      avdSource,
      'the boot-failure catch no longer reads the emulator log, so the captured stderr ' +
        'never reaches the operator — which defeats the point of capturing it.',
    ).toContain('emulator stderr');
  });
});
