/**
 * `nova-app-snapshot` — read the Phase 3 Nova app snapshot instead of Nova.
 *
 *   npx tsx "$ACE_ROOT/scripts/nova-app-snapshot.ts" --snapshot <snapshot.json> --app <nova_app_id> --check
 *   npx tsx "$ACE_ROOT/scripts/nova-app-snapshot.ts" --snapshot <snapshot.json> --outline
 *   npx tsx "$ACE_ROOT/scripts/nova-app-snapshot.ts" --snapshot <snapshot.json> --form <formUuid|form name>
 *   npx tsx "$ACE_ROOT/scripts/nova-app-snapshot.ts" --snapshot <snapshot.json> --forms
 *
 * The snapshot is written by Step 1.4's `nova-app-lint --snapshot-out`
 * (`lib/nova-app-snapshot.ts` has the why, ace#3132).
 *
 * - `--check` makes ONE Nova call (`search_apps`) and compares the app's
 *   `updated_at` against the one the snapshot recorded.
 *   Exit 0 = fresh, read from the snapshot. Exit 4 = stale (the app changed or
 *   the snapshot is partial): re-run `nova-app-lint --snapshot-out` and use the
 *   new file. Exit 3 = unknown (could not tell): read live, as if no snapshot.
 * - `--outline` prints the `(module, form) -> uuid` map with field counts and
 *   Connect blocks. It replaces the `get_app` uuid-resolution read.
 * - `--form` prints one form's `get_form` response exactly as Nova returned
 *   it. It replaces one `get_form({app_id, moduleUuid, formUuid})`.
 * - `--forms` prints every form's response, in app order.
 *
 * Exit 1 = usage error, or a missing/ambiguous form.
 */
import { readFileSync } from 'node:fs';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { novaCall } from '../lib/nova-rpc.js';
import { withNovaRetry } from './nova-app-lint.js';
import {
  readAppUpdatedAt,
  snapshotForm,
  snapshotFreshness,
  snapshotOutline,
  type SnapshotBundle,
} from '../lib/nova-app-snapshot.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  const path = arg('snapshot');
  if (!path) {
    process.stderr.write('usage: nova-app-snapshot.ts --snapshot <json> (--check --app <id> | --outline | --form <uuid|name> | --forms)\n');
    return 1;
  }
  const bundle: SnapshotBundle = JSON.parse(readFileSync(path, 'utf8'));

  if (flag('check')) {
    const appId = arg('app') ?? bundle.appId;
    loadPluginEnv(import.meta.url);
    const call = withNovaRetry((tool, args) => novaCall(tool, args));
    const live = await readAppUpdatedAt(appId, bundle.app?.name, call);
    const f = snapshotFreshness(bundle, appId, live);
    process.stdout.write(f.state === 'fresh' ? `FRESH ${appId} (updated_at ${live})\n` : `${f.state.toUpperCase()} ${appId}: ${f.reason}\n`);
    return f.state === 'fresh' ? 0 : f.state === 'stale' ? 4 : 3;
  }
  if (flag('outline')) {
    process.stdout.write(JSON.stringify({ appId: bundle.appId, name: bundle.app?.name, connect: bundle.app?.connect, forms: snapshotOutline(bundle) }, null, 1) + '\n');
    return 0;
  }
  const form = arg('form');
  if (form) {
    process.stdout.write(JSON.stringify(snapshotForm(bundle, form), null, 1) + '\n');
    return 0;
  }
  if (flag('forms')) {
    process.stdout.write(JSON.stringify(bundle.forms, null, 1) + '\n');
    return 0;
  }
  process.stderr.write('nothing to do: pass --check, --outline, --form or --forms\n');
  return 1;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`nova-app-snapshot: ${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
