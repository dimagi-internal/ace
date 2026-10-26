#!/usr/bin/env -S npx tsx
/**
 * Phase 3 per-Nova-account lease (ace#3301). Usage:
 *   nova-account-lease.ts acquire --holder <opp>/<run-id>   # waits, says why; exit 0 once held
 *   nova-account-lease.ts release --holder <opp>/<run-id>
 * Run `acquire` before dispatching the architect; `release` on every exit.
 * A crashed holder is reclaimed by TTL. See lib/nova-account-lease.ts.
 */
import { execFileSync } from 'node:child_process';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { acquireNovaLease, isClaudeComm, novaLeasePath, releaseNovaLease } from '../lib/nova-account-lease.js';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/**
 * The nearest ancestor `claude` process — the session that holds the lease
 * for the whole phase. This script and the shell that ran it exit in seconds,
 * so neither is a usable liveness signal. Undefined if none is found; the
 * lease then falls back to its TTL backstop.
 */
function sessionPid(): number | undefined {
  let pid = process.ppid;
  for (let hop = 0; hop < 12 && pid > 1; hop++) {
    let out: string;
    try {
      out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    } catch {
      return undefined;
    }
    const m = out.match(/^(\d+)\s+(.*)$/);
    if (!m) return undefined;
    if (isClaudeComm(m[2])) return pid;
    pid = Number(m[1]);
  }
  return undefined;
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const holder = arg('holder');
  if ((cmd !== 'acquire' && cmd !== 'release') || !holder) {
    process.stderr.write('usage: nova-account-lease.ts acquire|release --holder <opp>/<run-id>\n');
    return 1;
  }
  loadPluginEnv(import.meta.url);
  const key = process.env.NOVA_API_KEY;
  if (!key) {
    process.stderr.write('NOVA_API_KEY is not set (refresh with /ace:setup --force-env)\n');
    return 1;
  }
  const path = novaLeasePath(key);
  if (cmd === 'release') {
    process.stdout.write(releaseNovaLease(path, holder) ? 'released\n' : 'not held by this holder — nothing to release\n');
    return 0;
  }
  const holderPid = sessionPid();
  if (holderPid == null) process.stderr.write('[nova-lease] no ancestor claude process found; the lease relies on its TTL backstop\n');
  const r = await acquireNovaLease(path, holder, {
    holderPid,
    onWait: (d) => process.stderr.write(`[nova-lease] ${d}\n`),
  });
  process.stdout.write(`acquired: ${r.detail}\n`);
  return 0;
}

main().then((c) => process.exit(c));
