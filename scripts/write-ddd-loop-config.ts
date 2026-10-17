/**
 * Write this run's canopy DDD loop config and print the env a `canopy:ddd`
 * dispatch must carry.
 *
 *   npx tsx scripts/write-ddd-loop-config.ts --runs-dir <CANOPY_DDD_RUNS_DIR> --workspace <ws> [--ddd-dir <DDD_DIR>]
 *
 * Writes `<DDD_DIR>/config.yaml` from `config/ddd-loop.yaml` (+ `workspace:`),
 * DDD_DIR defaulting to `~/.canopy/ddd/<key>` for runs dir `~/.canopy/ddd/runs/<key>`.
 * stdout is exactly the two `export` lines to run and to paste into the
 * dispatch prompt; the written path goes to stderr. Exit 2 on a bad argument.
 * Idempotent — run it before every dispatch. Logic and the why: lib/ddd-loop-config.ts.
 */
import { writeDddLoopConfig } from '../lib/ddd-loop-config.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const runsDir = arg('--runs-dir');
const workspace = arg('--workspace');
if (!runsDir || !workspace) {
  process.stderr.write(
    'usage: write-ddd-loop-config.ts --runs-dir <CANOPY_DDD_RUNS_DIR> --workspace <ws> [--ddd-dir <DDD_DIR>]\n',
  );
  process.exit(64);
}
try {
  const r = writeDddLoopConfig({ runsDir, workspace, dddDir: arg('--ddd-dir') });
  process.stderr.write(`wrote ${r.configPath}\n`);
  process.stdout.write(`${r.env}\n`);
} catch (e) {
  process.stderr.write(`write-ddd-loop-config: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}
