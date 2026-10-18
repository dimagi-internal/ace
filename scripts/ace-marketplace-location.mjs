#!/usr/bin/env node
// ace-marketplace-location — where is THIS machine's ACE marketplace, and who owns it?
//
// `/ace:update` used to hard-code `~/.claude/plugins/marketplaces/ace`. That is only
// where Claude Code puts a marketplace it CLONED (`/plugin marketplace add
// dimagi-internal/ace` → source "github"/"git"). A canopy cloud runner registers ACE
// as a DIRECTORY source instead — `known_marketplaces.json` says
//   "ace": {"source": {"source": "directory", "path": "/opt/agents/ace"},
//           "installLocation": "/opt/agents/ace"}
// and `~/.claude/plugins/marketplaces/` holds only `canopy`. So Step 1 reported
// `marketplace_missing` and told the operator to re-add a marketplace the runner
// already manages (ace#3143).
//
// The registry is the source of truth, so read it — the same resolution canopy's
// fleet session-start updater uses (`installLocation`, else the conventional clone
// path). A directory source is a checkout ACE did not create and does not own:
// on a runner, canopy's fleet hook resets it to origin/main and re-syncs the
// plugin cache at session start. `/ace:update` therefore reports on it and never
// pulls into it.
//
// Pure Node stdlib, no tsx: on runners the cache's `node_modules/.bin/tsx` is a
// plain file, not a symlink, and fails with ERR_MODULE_NOT_FOUND.
//
// CLI: prints shell-safe `KEY='value'` lines for `eval`:
//   MARKETPLACE='<path>'  SOURCE_TYPE='<github|git|directory|...|unregistered>'
//   MODE='clone'|'directory'

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKETPLACE_NAME = 'ace';

/**
 * @param {{ known: unknown, home: string }} args  `known` = parsed known_marketplaces.json (or null)
 * @returns {{ path: string, sourceType: string, mode: 'clone' | 'directory' }}
 */
export function resolveAceMarketplace({ known, home }) {
  const fallback = join(home, '.claude', 'plugins', 'marketplaces', MARKETPLACE_NAME);
  const entry =
    known && typeof known === 'object' ? /** @type {any} */ (known)[MARKETPLACE_NAME] : undefined;
  if (!entry || typeof entry !== 'object') {
    return { path: fallback, sourceType: 'unregistered', mode: 'clone' };
  }
  const source = entry.source && typeof entry.source === 'object' ? entry.source : {};
  const sourceType = typeof source.source === 'string' && source.source ? source.source : 'unknown';
  const path =
    (typeof entry.installLocation === 'string' && entry.installLocation) ||
    (sourceType === 'directory' && typeof source.path === 'string' && source.path) ||
    fallback;
  return { path, sourceType, mode: sourceType === 'directory' ? 'directory' : 'clone' };
}

function shq(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

export function formatShell(res) {
  return [
    `MARKETPLACE=${shq(res.path)}`,
    `SOURCE_TYPE=${shq(res.sourceType)}`,
    `MODE=${shq(res.mode)}`,
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const home = process.env.HOME || homedir();
  let known = null;
  try {
    known = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), 'utf8'));
  } catch {
    known = null;
  }
  process.stdout.write(formatShell(resolveAceMarketplace({ known, home })) + '\n');
}
