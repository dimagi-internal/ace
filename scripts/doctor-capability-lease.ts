/**
 * doctor probe: capability_lease — can THIS machine lease ACE's
 * `android-emulator` from canopy-web? Read-only; never acquires.
 * Logic + rationale: lib/capability-lease-probe.ts.
 *
 *   --format=lines  PASS/WARN/INFO lines for bin/ace-doctor (default)
 *   --format=json   the verdict object
 */
import { defaultBackendLine, leaseIsDefaultHere, probeCapabilityLease } from '../lib/capability-lease-probe.js';

async function main(): Promise<void> {
  const format = (process.argv.find((a) => a.startsWith('--format=')) ?? '--format=lines').split('=')[1];
  const v = await probeCapabilityLease();
  if (format === 'json') {
    console.log(JSON.stringify(v));
    return;
  }
  // A lease problem only blocks a run that will lease: where the default is
  // the local AVD (and nothing pins lease), it is information, not a warning.
  const label = v.status === 'pass' ? 'PASS' : leaseIsDefaultHere() ? 'WARN' : 'INFO';
  console.log(`${label} capability_lease: ${v.summary}${label === 'INFO' ? ' (not the default backend here)' : ''}`);
  if (v.remediation) console.log(`  fix: ${v.remediation}`);
  console.log(defaultBackendLine());
}

try {
  await main();
} catch (e) {
  console.log(`WARN capability_lease: probe crashed (${(e as Error).message}) — this is NOT a pass`);
}
process.exit(0);
