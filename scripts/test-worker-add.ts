/**
 * Plan the next Connect test worker for the pool (ace#2955). Read-only: it
 * computes the next slot name and the next unused +7426 number, and prints the
 * procedure — it never writes 1Password, never publishes, never touches a
 * device. The procedure itself (and which steps need the owner's approval)
 * is skills/test-worker-pool/SKILL.md.
 *
 *   npx tsx scripts/test-worker-add.ts [--avoid +7426…,+7426…] [--json]
 *
 * Reads this machine's pool exactly as the mobile MCP does (ACE's .env:
 * ACE_E2E_WORKERS + the legacy ACE_E2E_* worker-1) and the slots in
 * infra/capabilities/test-worker/capability.yaml.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { aceEnvValue } from '../lib/ace-canopy-pat.js';
import { POOL_ENV, loadTestWorkerPool, planTestWorkerAdd } from '../lib/test-worker-pool.js';
import { PUBLISH_CMD } from '../lib/test-worker-lease.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = path.join(ROOT, 'infra/capabilities/test-worker/capability.yaml');

function poolEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [POOL_ENV, 'ACE_E2E_PHONE', 'ACE_E2E_PHONE_LOCAL', 'ACE_E2E_COUNTRY_CODE', 'ACE_E2E_PIN', 'ACE_E2E_BACKUP_CODE', 'ACE_E2E_NAME']) {
    if (!env[k]) {
      const v = aceEnvValue(k);
      if (v) env[k] = v;
    }
  }
  return env;
}

function main(): void {
  const argv = process.argv.slice(2);
  const avoidArg = argv[argv.indexOf('--avoid') + 1];
  const avoid = argv.includes('--avoid') && avoidArg ? avoidArg.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const pool = [...loadTestWorkerPool(poolEnv()).values()];
  const manifest = parseYaml(fs.readFileSync(MANIFEST, 'utf8')) as { slots?: string[] };
  const plan = planTestWorkerAdd({ pool, manifestSlots: manifest.slots ?? [], avoid });
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ plan, pool: pool.map((w) => ({ slot: w.slot, phone: w.phone })), manifestSlots: manifest.slots ?? [] }));
    return;
  }
  console.log(`pool on this machine: ${pool.map((w) => `${w.slot}=${w.phone}`).join(', ') || 'none'}`);
  console.log(`manifest slots:       ${(manifest.slots ?? []).join(', ')}`);
  console.log('');
  console.log(`next worker: ${plan.slot}  phone ${plan.phone}  phoneLocal ${plan.phoneLocal}  name "${plan.name}"`);
  console.log('');
  console.log('Procedure (skills/test-worker-pool/SKILL.md § Add a worker):');
  console.log(`  1. Register it once on a device (fresh-signup path): mobile_register_test_user({phone: "${plan.phone}",`);
  console.log(`     phoneLocal: "${plan.phoneLocal}", countryCode: "${plan.countryCode}", name: "${plan.name}"}) — capture a`);
  console.log('     mobile_capture_ui_dump at the camera step; it calibrates connect-register-from-otp.yaml.');
  console.log(`  2. OWNER-APPROVED: add "${plan.slot}" to the pool-json field of the 1Password item connect-test-workers.`);
  const declared = (manifest.slots ?? []).includes(plan.slot);
  console.log(
    declared
      ? `  3. ${plan.slot} is already in infra/capabilities/test-worker/capability.yaml slots — no manifest change.`
      : `  3. Add ${plan.slot} to slots: in infra/capabilities/test-worker/capability.yaml; ship the PR.`,
  );
  console.log(`  4. OWNER-APPROVED: publish — ${PUBLISH_CMD}`);
  console.log('  5. /ace:setup --force-env, then restart Claude Code; /ace:doctor test_worker_pool must PASS.');
}

main();
