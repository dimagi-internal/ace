/**
 * `/ace:mobile-bootstrap --pool N` — the planning half.
 *
 * Reports what a pool of N AVDs needs on THIS host: which members are missing,
 * the exact `avdmanager create` command for each, and the tuned `config.ini`
 * keys to lift from a proven member. Report-only by default; `--apply-config`
 * writes the tuned keys into already-created members' `config.ini`.
 *
 * It deliberately does NOT create, boot, install or register anything. Those
 * are device-truth steps the command prose runs through the `ace-mobile` MCP
 * (`mobile_ensure_avd_running`, `mobile_install_apk`,
 * `mobile_register_test_user`), so they go through the same heal funnel every
 * ACE dispatch uses — and `registerTestUser` is what writes the provisioning
 * marker that makes a member eligible as a `selectAvd` fallback (ace#1047).
 * Nothing here writes that marker; provisioning stays self-certifying.
 *
 * Usage:
 *   npx tsx scripts/plan-avd-pool.ts --size 2
 *   npx tsx scripts/plan-avd-pool.ts --size 2 --apply-config
 *   npx tsx scripts/plan-avd-pool.ts --size 3 --base ACE_Pixel_API_34 --json
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import {
  applyTunedConfigDelta,
  createAvdCommand,
  planAvdPool,
  systemImagePackageFromSysdir,
  tunedConfigDelta,
  type TunedKeyDelta,
} from '../lib/avd-pool-plan.js';
import { MARKER_FILENAME } from '../mcp/mobile/avd-provisioned-marker.js';

loadPluginEnv(import.meta.url);

interface Args {
  size: number;
  base: string;
  avdHome: string;
  applyConfig: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const size = Number.parseInt(get('--size') ?? '1', 10);
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`--size must be an integer >= 1 (got ${get('--size')})`);
  }
  return {
    size,
    base: get('--base') ?? process.env.ACE_AVD_NAME ?? 'ACE_Pixel_API_34',
    avdHome:
      get('--avd-home') ??
      process.env.ANDROID_AVD_HOME ??
      path.join(os.homedir(), '.android', 'avd'),
    applyConfig: argv.includes('--apply-config'),
    json: argv.includes('--json'),
  };
}

/**
 * AVDs on this host, read from the AVD home directory rather than by shelling
 * out to `emulator -list-avds`. Same answer (the emulator reads this directory)
 * without requiring the emulator binary on PATH, which is exactly the thing a
 * bootstrap run may still be fixing.
 */
function listAvds(avdHome: string): string[] {
  if (!existsSync(avdHome)) return [];
  return readdirSync(avdHome)
    .filter((f) => f.endsWith('.ini') && !f.startsWith('.'))
    .map((f) => f.slice(0, -'.ini'.length))
    .sort();
}

const configPath = (avdHome: string, name: string): string =>
  path.join(avdHome, `${name}.avd`, 'config.ini');

const isProven = (avdHome: string, name: string): boolean =>
  existsSync(path.join(avdHome, `${name}.avd`, MARKER_FILENAME));

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const existing = listAvds(args.avdHome);
  const plan = planAvdPool(args.base, args.size, existing);

  // The reference config comes from a PROVEN member where one exists — that is
  // the AVD whose profile has actually completed an ACE bootstrap. Falling back
  // to the base member keeps a first-ever `--pool` run working on a machine
  // that has never registered a test user.
  const reference =
    plan.present.find((m) => isProven(args.avdHome, m) && existsSync(configPath(args.avdHome, m))) ??
    plan.present.find((m) => existsSync(configPath(args.avdHome, m)));

  if (!reference) {
    throw new Error(
      `No existing pool member with a readable config.ini under ${args.avdHome}. ` +
        `Bootstrap '${args.base}' first (/ace:mobile-bootstrap with no --pool), then re-run.`,
    );
  }

  const referenceIni = readFileSync(configPath(args.avdHome, reference), 'utf8');
  const sysdir = referenceIni
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('image.sysdir.1='))
    ?.slice('image.sysdir.1='.length);
  const systemImage = sysdir ? systemImagePackageFromSysdir(sysdir) : null;

  const creates = plan.missing.map((name) => ({
    name,
    command: systemImage
      ? createAvdCommand(name, systemImage)
      : `# could not derive the system image from ${reference}'s image.sysdir.1 (${sysdir ?? 'absent'}) — pass -k by hand`,
  }));

  // Tuned-key drift on members that already exist but were created outside
  // this flow (or before the reference AVD was retuned).
  const drift: { name: string; deltas: TunedKeyDelta[]; applied: boolean }[] = [];
  for (const name of plan.present) {
    if (name === reference) continue;
    const p = configPath(args.avdHome, name);
    if (!existsSync(p)) continue;
    const cloneIni = readFileSync(p, 'utf8');
    const deltas = tunedConfigDelta(referenceIni, cloneIni);
    let applied = false;
    if (deltas.length > 0 && args.applyConfig) {
      writeFileSync(p, applyTunedConfigDelta(cloneIni, deltas), 'utf8');
      applied = true;
    }
    if (deltas.length > 0) drift.push({ name, deltas, applied });
  }

  const report = {
    base: args.base,
    size: args.size,
    avd_home: args.avdHome,
    reference,
    reference_is_proven: isProven(args.avdHome, reference),
    system_image: systemImage,
    members: plan.members,
    present: plan.present,
    missing: plan.missing,
    unproven: plan.present.filter((m) => !isProven(args.avdHome, m)),
    creates,
    config_drift: drift,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`AVD pool plan — base '${args.base}', size ${args.size}`);
  console.log(`  avd home:  ${args.avdHome}`);
  console.log(`  reference: ${reference}${report.reference_is_proven ? ' (proven)' : ' (NOT proven)'}`);
  console.log(`  members:   ${plan.members.join(', ')}`);
  console.log(`  present:   ${plan.present.join(', ') || '(none)'}`);
  console.log(`  missing:   ${plan.missing.join(', ') || '(none)'}`);
  if (report.unproven.length) {
    console.log(
      `  unproven:  ${report.unproven.join(', ')} — no ${MARKER_FILENAME}; ` +
        `run mobile_register_test_user on each before selectAvd will use it as a fallback`,
    );
  }
  for (const c of creates) console.log(`\n  create ${c.name}:\n    ${c.command}`);
  for (const d of drift) {
    console.log(`\n  ${d.applied ? 'applied to' : 'config drift on'} ${d.name}:`);
    for (const k of d.deltas) console.log(`    ${k.key}: ${k.from ?? '(absent)'} -> ${k.to}`);
  }
  if (!args.applyConfig && drift.length) {
    console.log(`\n  re-run with --apply-config to write those keys.`);
  }
  if (!plan.missing.length && !drift.length) console.log('\n  nothing to do.');
}

try {
  main();
} catch (e) {
  console.error(`plan-avd-pool: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
