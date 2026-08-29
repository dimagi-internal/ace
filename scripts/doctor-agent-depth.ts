#!/usr/bin/env npx tsx
/**
 * Report ACE's declared dispatch-depth need against what this machine supplies.
 *
 * `test/lib/agent-depth.test.ts` checks ACE's graph against ACE's own
 * `MAX_SUBAGENT_SPAWN_DEPTH` constant. That is a closed loop: both sides are
 * committed to this repo, so CI is green on every machine — including one where
 * the runtime supplies less than ACE needs. The side CI cannot see is the only
 * side that can actually break, and it breaks SILENTLY: at the limit Claude Code
 * withholds the `Agent` tool and the subagent at the floor does the delegated
 * work itself and returns one summary.
 *
 * Two things make that a live risk rather than a theoretical one:
 *
 *   1. `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` is usually UNSET, and Claude Code
 *      then resolves it from a remote feature flag — so it is not guaranteed to
 *      be the same for two people on one team.
 *   2. ACE needs depth on several chains at once. Phase 7's per-scene judges and
 *      its DDD specialist fixers collapse quietly; Phase 3 never reaches the Nova
 *      architect and builds the apps itself.
 *
 * So: report what ACE needs, what is pinned, and the gap. Emitted by
 * `bin/ace-doctor`; `--format=yaml` for `--preflight`.
 */
import { MAX_SUBAGENT_SPAWN_DEPTH, allChains, formatChains, maxDepth } from '../lib/agent-depth.js';

const required = maxDepth();
const pinned = process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
const parsed = pinned === undefined ? undefined : Number.parseInt(pinned, 10);
const yaml = process.argv.includes('--format=yaml');

/** Chains that stop working if the runtime supplies `budget` levels. */
function starved(budget: number): string[] {
  return allChains()
    .filter((c) => c.depth > budget)
    .map((c) => `${c.path.join(' -> ')} (needs ${c.depth})`);
}

let status: 'pass' | 'warn' | 'fail';
let message: string;

if (parsed !== undefined && Number.isFinite(parsed)) {
  if (parsed >= required) {
    status = 'pass';
    message = `pinned at ${parsed}; ACE's deepest chain needs ${required}`;
  } else {
    status = 'fail';
    message =
      `pinned at ${parsed}, but ACE needs ${required}. These chains collapse ` +
      `SILENTLY (no error, full-looking output): ${starved(parsed).join('; ')}`;
  }
} else if (pinned !== undefined) {
  status = 'warn';
  message = `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH is set to "${pinned}", which is not an integer`;
} else {
  // Not an error: 3 is the current default and ACE needs 2. But an unpinned
  // value is decided elsewhere and can change without anyone touching this repo.
  status = required > 3 ? 'fail' : 'warn';
  message =
    `unset — resolved by Claude Code's remote feature flag, which is not ` +
    `guaranteed to match across a team. ACE needs ${required}. Pin it so the ` +
    `budget is a decision rather than an inheritance.`;
}

if (yaml) {
  console.log(`agent_depth:`);
  console.log(`  required: ${required}`);
  console.log(`  declared_budget: ${MAX_SUBAGENT_SPAWN_DEPTH}`);
  console.log(`  pinned: ${pinned ?? 'null'}`);
  console.log(`  status: ${status}`);
} else {
  console.log(`${status.toUpperCase()}|${message}`);
  if (status !== 'pass') {
    console.log(
      `FIX|add {"env": {"CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "${Math.max(required, MAX_SUBAGENT_SPAWN_DEPTH)}"}} to ~/.claude/settings.json, then restart Claude Code`,
    );
  }
  console.log(`CHAINS|`);
  console.log(formatChains());
}
