/**
 * Write `run-exit.json` from a finished supervised run.
 *
 * The I/O half of `lib/run-exit.ts` — same split as
 * `scripts/doctor-env-freshness.ts` over `lib/env-freshness.ts`: all the
 * filesystem work lives here so the classifier stays pure and testable.
 *
 * Invoked by `bin/ace-run-supervise` after the child exits. Reads the tail of
 * the stream-json, not the whole thing — a long run's stream is large and only
 * the final `result` event plus the `init` event matter.
 *
 *   npx tsx scripts/run-exit-write.ts <run-dir> <exit-code|signal-name> [--timed-out]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { classifyRunExit, formatRunExit } from '../lib/run-exit.js';

/** Events to keep from the end of the stream. */
const TAIL_EVENTS = 200;

function readTailEvents(path: string): unknown[] {
  if (!existsSync(path)) return [];
  // Streams from a multi-hour run reach tens of MB. Read once, split, and keep
  // the head (for `init`, which carries the session id) plus the tail (for
  // `result`). Anything in between is transcript, which the classifier is
  // deliberately blind to.
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const keep = [...lines.slice(0, 5), ...lines.slice(-TAIL_EVENTS)];
  const events: unknown[] = [];
  for (const line of keep) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // A partially-written final line is normal when the process was killed.
    }
  }
  return events;
}

function readStderr(path: string): string {
  if (!existsSync(path)) return '';
  try {
    // Signatures live at the end; cap so a runaway log can't blow memory.
    return readFileSync(path, 'utf8').slice(-64_000);
  } catch {
    return '';
  }
}

function main(): void {
  const [runDir, status, ...rest] = process.argv.slice(2);
  if (!runDir || status === undefined) {
    console.error('usage: run-exit-write.ts <run-dir> <exit-code|signal-name> [--timed-out]');
    process.exit(2);
  }

  const asNumber = Number(status);
  const isSignal = !Number.isFinite(asNumber);

  const exit = classifyRunExit({
    exitCode: isSignal ? null : asNumber,
    signal: isSignal ? status : null,
    events: readTailEvents(join(runDir, 'stream.jsonl')),
    stderr: readStderr(join(runDir, 'stderr.log')),
    timedOut: rest.includes('--timed-out'),
  });

  const outPath = join(runDir, 'run-exit.json');
  writeFileSync(outPath, `${JSON.stringify(exit, null, 2)}\n`, 'utf8');
  console.log(formatRunExit(exit));
  console.log(`  → ${outPath}`);
}

main();
