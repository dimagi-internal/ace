/**
 * scripts/clone-labs-allowlist.ts
 *
 * The Labs allowlist arithmetic of `skills/clone-to-new-workspace` § 4c
 * (ace#2713). `synthetic_set_allowed_domains` REPLACES the list, so the clone
 * never sends the target domains alone.
 *
 *   npx tsx scripts/clone-labs-allowlist.ts compute --target @a.org[,@b.org] [--current @x,@y]
 *     → {"allowed_domains": [...]}   current ∪ target ∪ ACE's own mailbox domain
 *   npx tsx scripts/clone-labs-allowlist.ts reconcile --sent @x,@y --previous @x,@z
 *     → {"dropped": [...], "resend": [...] | null}   from the write's previous_allowed_domains
 *   npx tsx scripts/clone-labs-allowlist.ts seen --context-file <labs_context.json> --ids 10097,10098
 *     → {"seen": [...], "missing": [...]}   exit 1 when ACE no longer sees an opp
 *
 * Logic: lib/labs-allowlist.ts. Read-only; makes no labs call itself.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aceMailboxDomain,
  cloneLabsAllowlist,
  labsContextShowsOpportunity,
  reconcileAfterSet,
} from '../lib/labs-allowlist.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function main(): number {
  const cmd = process.argv[2];
  if (cmd === 'compute') {
    const out = cloneLabsAllowlist({
      current: list(arg('current')),
      target: list(arg('target')),
      aceDomain: aceMailboxDomain(REPO_ROOT),
    });
    console.log(JSON.stringify({ allowed_domains: out }));
    return 0;
  }
  if (cmd === 'reconcile') {
    console.log(JSON.stringify(reconcileAfterSet({ sent: list(arg('sent')), previous: list(arg('previous')) })));
    return 0;
  }
  if (cmd === 'seen') {
    const file = arg('context-file');
    if (!file) throw new Error('--context-file is required');
    const ctx = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ids = list(arg('ids'));
    const seen = ids.filter((id) => labsContextShowsOpportunity(ctx, id));
    const missing = ids.filter((id) => !seen.includes(id));
    console.log(JSON.stringify({ seen, missing }));
    return missing.length ? 1 : 0;
  }
  console.error('usage: clone-labs-allowlist.ts compute|reconcile|seen …');
  return 2;
}

try {
  process.exit(main());
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
