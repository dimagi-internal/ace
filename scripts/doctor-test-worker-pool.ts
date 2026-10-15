/**
 * doctor probe: test_worker_pool — is the Connect test-worker pool lock live
 * (ace#2955)? Read-only; never checks a worker out.
 * Logic + rationale: lib/test-worker-pool-probe.ts.
 *
 *   --format=lines  PASS/WARN lines for bin/ace-doctor (default)
 *   --format=json   the verdict object
 */
import { probeTestWorkerPool } from '../lib/test-worker-pool-probe.js';

async function main(): Promise<void> {
  const format = (process.argv.find((a) => a.startsWith('--format=')) ?? '--format=lines').split('=')[1];
  const v = await probeTestWorkerPool();
  if (format === 'json') {
    console.log(JSON.stringify(v));
    return;
  }
  console.log(`${v.status === 'pass' ? 'PASS' : 'WARN'} test_worker_pool: ${v.summary}`);
  if (v.remediation) console.log(`  fix: ${v.remediation}`);
}

try {
  await main();
} catch (e) {
  console.log(`WARN test_worker_pool: probe crashed (${(e as Error).message}) — this is NOT a pass`);
}
process.exit(0);
