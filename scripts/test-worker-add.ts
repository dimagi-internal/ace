/**
 * Plan the next Connect test worker for the pool (ace#2955). Read-only: it
 * computes the next slot name and the next unused +7426 number and prints the
 * procedure — it never writes slot data, never publishes, never touches a
 * device. The procedure itself is skills/test-worker-pool/SKILL.md.
 *
 *   npx tsx scripts/test-worker-add.ts [--avoid +7426…,+7426…] [--json] [--offline]
 *
 * Knows the pool from canopy-web's MASKED slot list (public phones only — no
 * secret is ever fetched), the slots in infra/capabilities/test-worker/
 * capability.yaml, and this machine's legacy ACE_E2E_PHONE. If the list
 * cannot be read it refuses (the next number would be a guess) unless
 * --offline, which plans from the manifest + legacy worker + --avoid alone.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { LEGACY_SLOT, planTestWorkerAdd, type TestWorkerAddPlan } from '../lib/test-worker-pool.js';
import { PUBLISH_CMD } from '../lib/test-worker-lease.js';
import { listSlots, slotHttpConfig, type SlotRow } from '../lib/test-worker-slots.js';

// Bash-reachable (skills/test-worker-pool): load ACE's .env before reading ACE_E2E_PHONE.
loadPluginEnv(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = path.join(ROOT, 'infra/capabilities/test-worker/capability.yaml');

/**
 * Pure: the plan from the slot list, the manifest and the legacy phone. A
 * slot counts as "backed" only when it has a phone on canopy-web; a
 * declared slot without one is filled first.
 */
export function planFromSlots(args: {
  rows: SlotRow[];
  manifestSlots: string[];
  legacyPhone?: string | null;
  avoid?: string[];
}): TestWorkerAddPlan {
  const pool = args.rows
    .filter((r) => typeof r.public.phone === 'string' && r.public.phone)
    .map((r) => ({ slot: r.slot, phone: String(r.public.phone) }));
  // worker-1 IS the legacy ACE_E2E_* worker: until its data is stored
  // (test-worker-set.ts --from-legacy-env) it is still taken, by that number.
  if (args.legacyPhone && !pool.some((w) => w.slot === LEGACY_SLOT)) pool.push({ slot: LEGACY_SLOT, phone: args.legacyPhone });
  return planTestWorkerAdd({ pool, manifestSlots: args.manifestSlots, avoid: args.avoid ?? [] });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const avoidArg = argv[argv.indexOf('--avoid') + 1];
  const avoid = argv.includes('--avoid') && avoidArg ? avoidArg.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const manifest = parseYaml(fs.readFileSync(MANIFEST, 'utf8')) as { slots?: string[] };
  const manifestSlots = manifest.slots ?? [];
  const legacyPhone = (process.env.ACE_E2E_PHONE ?? '').startsWith('op://') ? null : process.env.ACE_E2E_PHONE || null;
  let rows: SlotRow[] = [];
  let listNote: string | null = null;
  try {
    const cfg = slotHttpConfig();
    if (!cfg) listNote = "no canopy-web PAT (CANOPY_WEB_PAT in ACE's .env) — planned without canopy-web's slot list";
    else rows = await listSlots(cfg);
  } catch (e) {
    // Without the list, the next number is a guess about a namespace canopy-web
    // owns — refuse rather than hand out a number another slot may hold.
    if (!argv.includes('--offline')) {
      console.error(`test-worker-add: could not read canopy-web's slot list (${(e as Error).message}).`);
      console.error('  Re-run when canopy-web answers, or pass --offline --avoid <every known +7426 number> to plan without it.');
      process.exitCode = 1;
      return;
    }
    listNote = `could not read canopy-web's slot list (${(e as Error).message}) — planned OFFLINE`;
  }
  const plan = planFromSlots({ rows, manifestSlots, legacyPhone, avoid });
  if (argv.includes('--json')) {
    console.log(
      JSON.stringify({
        plan,
        slots: rows.map((r) => ({ slot: r.slot, phone: r.public.phone ?? null, secret_keys: r.secretKeys })),
        manifestSlots,
        note: listNote,
      }),
    );
    return;
  }
  if (listNote) console.log(`NOTE: ${listNote}. Pass --avoid for numbers you know are taken.`);
  if (!listNote && legacyPhone && !rows.some((r) => r.slot === LEGACY_SLOT && r.public.phone)) {
    console.log(`NOTE: ${LEGACY_SLOT} has no data on canopy-web yet — seed it first: npx tsx scripts/test-worker-set.ts --from-legacy-env`);
  }
  console.log(`slot data on canopy-web: ${rows.map((r) => `${r.slot}=${r.public.phone ?? '(no phone)'}`).join(', ') || 'none'}`);
  console.log(`manifest slots:          ${manifestSlots.join(', ')}`);
  if (legacyPhone) console.log(`legacy ACE_E2E worker:   ${legacyPhone} (${LEGACY_SLOT})`);
  console.log('');
  console.log(`next worker: ${plan.slot}  phone ${plan.phone}  phoneLocal ${plan.phoneLocal}  name "${plan.name}"`);
  console.log('');
  console.log('Procedure (skills/test-worker-pool/SKILL.md § Add a worker):');
  console.log(`  1. Invite ${plan.phone} to an active ACE test opportunity (connect_send_flw_invite) — PersonalID only skips its`);
  console.log('     device-integrity check for a number Connect holds an invite for; without one the emulator sign-up is refused.');
  console.log(`  2. Register it once on a device (fresh-signup path): mobile_register_test_user({phone: "${plan.phone}",`);
  console.log(`     phoneLocal: "${plan.phoneLocal}", countryCode: "${plan.countryCode}", name: "${plan.name}"}) — no pin/backupCode`);
  console.log('     args, so the legacy ACE_E2E_* values are used and no secret enters the transcript. Capture a');
  console.log('     mobile_capture_ui_dump at the camera step; it calibrates connect-register-from-otp.yaml.');
  console.log(`  3. Store it on canopy-web: npx tsx scripts/test-worker-set.ts --slot ${plan.slot} --phone ${plan.phone} \\`);
  console.log(`       --phone-local ${plan.phoneLocal} --country-code ${plan.countryCode} --name "${plan.name}" --secrets-from-legacy-env`);
  const declared = manifestSlots.includes(plan.slot);
  console.log(
    declared
      ? `  4. ${plan.slot} is already in infra/capabilities/test-worker/capability.yaml slots — no manifest change.`
      : `  4. Add ${plan.slot} to slots: in infra/capabilities/test-worker/capability.yaml; ship the PR, then publish: ${PUBLISH_CMD}`,
  );
  console.log('  5. Verify: npx tsx scripts/test-worker-set.ts --list shows the slot with no gaps; /ace:doctor test_worker_pool;');
  console.log(`     then mobile_checkout_test_workers + mobile_register_test_user({slot: "${plan.slot}"}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
