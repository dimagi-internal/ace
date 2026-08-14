/**
 * dimagi-internal/ace#1396 — `mobile_run_recipe` never passed a device serial
 * to Maestro, so on a host where more than one device is visible on that adb
 * server, Maestro AUTO-SELECTS.
 *
 * ACE already knows the serial it wants — `mobile_ensure_avd_running` returns
 * it, and the MCP passes it to `runRecipeWithDumps` for ui-dump capture. It
 * just was not given to the CLI.
 *
 * Observed live on bednet-check-2-visit/20260814-0856, Phase 6:
 *
 *   emulator-5554 -> avd='ACE_Pixel_API_34'   # ours
 *   emulator-5556 -> avd='ACE_Pixel_API_34'   # a sibling session's
 *
 * Both devices are registered to the SAME ${ACE_E2E_PHONE} test user, so a
 * recipe that lands on the wrong one still logs in, still finds the opp tile,
 * and can still SUBMIT A REAL DELIVER VISIT against the real opportunity. The
 * consequences are silent: screenshots of a device this run never provisioned,
 * a one-way precondition (Learn completion) or a payable-visit quota consumed
 * on another session's device, and that session's in-flight state mutated
 * underneath it.
 *
 * Same silent-wrong-target class as ace#1046 (predictable /tmp paths handing a
 * run another session's data), but on the device rather than the filesystem.
 *
 * argv construction is pure, so this needs no device.
 */
import { describe, it, expect } from 'vitest';
import { MaestroBackend } from '../../../mcp/mobile/backends/maestro.js';

/** `buildMaestroArgs` is private; exercise it the way the class does. */
function argsFor(opts: { adbPort?: number; serial?: string }): string[] {
  const b = new MaestroBackend() as unknown as {
    buildMaestroArgs: (
      adbPort: number | undefined,
      envVars: Record<string, string>,
      screenshotDir: string,
      recipePath: string,
      serial?: string,
    ) => string[];
  };
  return b.buildMaestroArgs(opts.adbPort, {}, '/tmp/shots', '/tmp/r.yaml', opts.serial);
}

describe('maestro argv pins the device (#1396)', () => {
  it('passes --device when the serial is known', () => {
    const a = argsFor({ adbPort: 5037, serial: 'emulator-5554' });
    expect(a).toContain('--device');
    expect(a[a.indexOf('--device') + 1]).toBe('emulator-5554');
  });

  it('pins the device BEFORE the `test` subcommand — it is a top-level flag', () => {
    const a = argsFor({ adbPort: 5037, serial: 'emulator-5554' });
    expect(a.indexOf('--device')).toBeLessThan(a.indexOf('test'));
  });

  it('keeps the --host/--port direct-TCP routing that dodges the dadb-1.2.10 bug', () => {
    const a = argsFor({ adbPort: 5039, serial: 'emulator-5554' });
    expect(a).toContain('--host=localhost');
    expect(a).toContain('--port=5039');
  });

  it('omits --device when no serial is known, rather than inventing one', () => {
    const a = argsFor({ adbPort: 5037 });
    expect(a).not.toContain('--device');
  });

  it('still names the recipe and output dir last', () => {
    const a = argsFor({ adbPort: 5037, serial: 'emulator-5554' });
    expect(a[a.length - 1]).toBe('/tmp/r.yaml');
    expect(a[a.length - 3]).toBe('--output');
  });
});

describe('provenance records the device (#1396 second half)', () => {
  it('carries device_serial when known', async () => {
    const { buildProvenance } = await import('../../../lib/screenshot-provenance.js');
    const p = buildProvenance({
      recipeId: 'journey-learn',
      dispatchId: 'd1',
      aceVersion: '0.13.875',
      deviceSerial: 'emulator-5554',
      writtenAtEpochMs: 1,
    });
    expect(p.device_serial).toBe('emulator-5554');
  });

  it('omits the key entirely when unknown — cloud runs and older sidecars', async () => {
    const { buildProvenance } = await import('../../../lib/screenshot-provenance.js');
    const p = buildProvenance({
      recipeId: 'journey-learn',
      dispatchId: 'd1',
      aceVersion: '0.13.875',
      writtenAtEpochMs: 1,
    });
    expect('device_serial' in p).toBe(false);
  });
});
