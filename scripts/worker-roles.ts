#!/usr/bin/env npx tsx
/**
 * Phase 3 Step 0.95: is this run multi-role, and which role is primary?
 *
 * Reads the PDD's § Program Parameters the same way
 * `idea-to-pdd-qa § platform_constraints` does (`deriveFacts`), so the two can
 * never read a different set of roles, and prints `planWorkerRoles`
 * (`lib/worker-roles.ts`) as JSON. Contract: `skills/_worker-roles.md`.
 *
 * Usage:
 *   npx tsx scripts/worker-roles.ts --pdd /tmp/pdd.md
 *   npx tsx scripts/worker-roles.ts --pdd /tmp/pdd.md --commcare-products /tmp/p3.json
 *
 * `--commcare-products` takes `phases.commcare-setup.products` as JSON and adds
 * `owed_by_phase3` (`rolesOwedByPhase3`): the extra roles Phase 3 has not
 * recorded a deployed pair for. Non-empty at Phase 4 entry = run Phase 3 again.
 *
 * Exit 0 on a readable PDD; 1 on bad usage or a role list that does not
 * normalise (two names, one key).
 */

import { readFileSync } from 'node:fs';

import { deriveFacts } from '../lib/platform-constraints.js';
import { planWorkerRoles, rolesOwedByPhase3, WorkerRolesError } from '../lib/worker-roles.js';
import { extractArchetype, programParametersFromPdd } from '../skills/idea-to-pdd-qa/checks.js';

function main(argv: string[]): number {
  const i = argv.indexOf('--pdd');
  const path = i >= 0 ? argv[i + 1] : undefined;
  if (!path) {
    process.stderr.write('usage: worker-roles.ts --pdd <pdd.md>\n');
    return 1;
  }
  const raw = readFileSync(path, 'utf8');
  const facts = deriveFacts(programParametersFromPdd(raw), extractArchetype(raw));
  const roles = Array.isArray(facts.worker_roles) ? (facts.worker_roles as string[]) : [];
  try {
    const plan = planWorkerRoles({
      worker_roles: roles.join(', '),
      opportunity_structure: typeof facts.opportunity_structure === 'string' ? facts.opportunity_structure : undefined,
      learn_module_visibility:
        typeof facts.learn_module_visibility === 'string' ? facts.learn_module_visibility : undefined,
    });
    const implied = typeof facts.worker_role_count === 'number' ? facts.worker_role_count : roles.length;
    const warning =
      implied > roles.length
        ? `The PDD implies ${implied} worker roles (role_property / a second head-count) but worker_roles names ${roles.length}. ` +
          'Only roles listed in worker_roles are built per role — list them there to build one pair and one opportunity each.'
        : undefined;
    const j = argv.indexOf('--commcare-products');
    const owed =
      j >= 0 && argv[j + 1]
        ? { owed_by_phase3: rolesOwedByPhase3(plan, JSON.parse(readFileSync(argv[j + 1], 'utf8'))) }
        : {};
    process.stdout.write(JSON.stringify({ ...plan, ...owed, ...(warning ? { warning } : {}) }, null, 2) + '\n');
    return 0;
  } catch (e) {
    if (e instanceof WorkerRolesError) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

process.exit(main(process.argv.slice(2)));
