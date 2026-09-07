#!/usr/bin/env npx tsx
/**
 * `/ace:doctor`'s emulator temp-partition probe (dimagi-internal/ace#2092).
 *
 * REPORT ONLY. Deletion belongs to `bin/ace-mobile-reap`, which is what
 * creates the orphans in the first place (SIGKILL, by design — a killed qemu
 * never runs its own cleanup). Doctor's charter is "is this machine set up to
 * run ACE", and a boot volume filling at ~2 GiB per Phase 6 dispatch is
 * squarely that: the failure mode when it lands is an emulator that will not
 * boot for a reason nothing in ACE reports.
 *
 * Everything here is BORROWED — the collector is
 * `sweepEmulatorTempPartitions({ dryRun: true })` and every decision is
 * `planEmulatorTempSweep`. A second scanner that could disagree with the
 * reaper's would be worse than no probe at all; the operator must be able to
 * read a WARN here and trust that the reaper will act on exactly those files.
 *
 * Never exits non-zero on its own failure — a diagnostic that breaks the
 * diagnostic is worse than a missing line.
 *
 * Test seam: `ACE_EMULATOR_TEMP_DIR` points the sweep at a fixture directory,
 * and `ACE_EMULATOR_TEMP_WARN_BYTES` moves the threshold.
 */
import {
  describeEmulatorTempSweep,
  formatBytes,
} from '../lib/emulator-temp-sweep.js';
import { sweepEmulatorTempPartitions } from '../mcp/mobile/session-lock.js';

/**
 * 10 GiB ~= five leaked dispatches. Below that the leak is real but not yet
 * worth an operator's attention, and a probe that WARNs on every workstation
 * every day is a probe people learn to scroll past.
 */
const DEFAULT_WARN_BYTES = 10 * 1024 ** 3;

function main(): void {
  const warnBytes = Number(process.env.ACE_EMULATOR_TEMP_WARN_BYTES ?? DEFAULT_WARN_BYTES);

  let sweep: ReturnType<typeof sweepEmulatorTempPartitions>;
  try {
    sweep = sweepEmulatorTempPartitions({ dryRun: true });
  } catch (e: any) {
    console.log(`SKIP emulator_temp_leak: could not scan (${e?.message ?? e})`);
    return;
  }

  if (sweep.dirs.length === 0) {
    console.log('SKIP emulator_temp_leak: no emulator temp directory on this host');
    return;
  }

  const { plan } = sweep;

  if (plan.skipped) {
    // Not a failure of the machine — a failure to READ it. Say which.
    console.log(`SKIP emulator_temp_leak: ${plan.skipped}`);
    return;
  }

  if (plan.reclaimableBytes >= warnBytes) {
    console.log(
      `WARN emulator_temp_leak: ${plan.orphans.length} orphaned emulator data partition(s) ` +
        `holding ${formatBytes(plan.reclaimableBytes)} in ${sweep.dirs.join(', ')}`,
    );
    console.log('  fix: run `ace-mobile-reap` (it sweeps these; `--list` dry-runs first)');
    for (const line of describeEmulatorTempSweep(plan)) console.log(`  ${line}`);
    return;
  }

  console.log(
    `PASS emulator_temp_leak: ${formatBytes(plan.reclaimableBytes)} reclaimable across ` +
      `${plan.orphans.length} orphaned partition(s) — under the ${formatBytes(warnBytes)} threshold`,
  );
}

main();
