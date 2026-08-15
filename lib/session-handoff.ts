/**
 * A one-screen handoff across a session boundary.
 *
 * ace#1093. Reviewing 24 ACE sessions found the single largest waste class was
 * not any one bug — it was that every session boundary (turn end,
 * restart-required halt, usage-limit kill, account switch) discards all working
 * context, and the next session re-derives it from scratch.
 *
 * The sharpest instance: session `d9eefb36` did ~30 tool calls establishing
 * context (thread + Drive + run history), then CORRECTLY halted at preflight on
 * stale MCP subprocesses. The post-restart session `f27b0189` got the identical
 * human prompt six minutes later and redid all ~30 calls — including
 * re-flailing the same gog CLI flags, one session guessing `--max` and the
 * other `--limit`. Nothing carried over.
 *
 * That halt is the ideal place to fix, because it is the one boundary ACE
 * chooses: it knows it is about to be restarted, it knows what it established,
 * and it knows the exact next command. The operator already hand-writes this
 * brief for account switches; this is the same artifact, automated.
 *
 * Deliberately NOT a general memory. It answers one question — "what did the
 * session that just died already work out?" — and it expires, because a stale
 * handoff that reads as current is worse than none.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A handoff older than this is ignored. Two hours is well past a restart or an
 * account switch and well short of "yesterday's run" — the window where the
 * context is still true.
 */
export const HANDOFF_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface SessionHandoff {
  /** ISO. */
  written_at: string;
  /** Why the session ended, in the words the next one needs. */
  reason: string;
  /** Facts already established — the ~30 calls that must not be repeated. */
  established: string[];
  /** Where the work lives: Drive ids, file paths, thread ids, branch names. */
  artifacts?: string[];
  /** The literal next command, so the next session does not re-derive it. */
  next_command?: string;
  /** Gmail thread this was about, when it was thread work. */
  thread_id?: string;
  /** `<opp>/<run-id>` when it was run work. */
  run?: string;
}

export function handoffPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.ace', 'session-handoff.json');
}

/**
 * Best-effort. A handoff that fails to write must never turn a clean halt into
 * a crash — the cost is only that the next session re-derives, which is the
 * status quo.
 */
export function writeHandoff(h: SessionHandoff, homeDir: string = os.homedir()): boolean {
  try {
    const p = handoffPath(homeDir);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(h, null, 2));
    return true;
  } catch {
    return false;
  }
}

export type HandoffRead =
  | { status: 'none' }
  | { status: 'stale'; ageMs: number; handoff: SessionHandoff }
  | { status: 'fresh'; ageMs: number; handoff: SessionHandoff };

/**
 * Read the handoff and say whether to trust it. `stale` is reported rather
 * than swallowed so the caller can say "there WAS one, it is too old" — silence
 * would leave a reader wondering whether the mechanism ran at all.
 */
export function readHandoff(
  nowMs: number = Date.now(),
  homeDir: string = os.homedir(),
): HandoffRead {
  const p = handoffPath(homeDir);
  if (!existsSync(p)) return { status: 'none' };
  let handoff: SessionHandoff;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as SessionHandoff;
    if (typeof parsed?.written_at !== 'string' || !Array.isArray(parsed?.established)) {
      return { status: 'none' };
    }
    handoff = parsed;
  } catch {
    return { status: 'none' };
  }
  const written = Date.parse(handoff.written_at);
  if (Number.isNaN(written)) return { status: 'none' };
  const ageMs = nowMs - written;
  return ageMs > HANDOFF_MAX_AGE_MS
    ? { status: 'stale', ageMs, handoff }
    : { status: 'fresh', ageMs, handoff };
}

/**
 * Consume it. The handoff is for the NEXT session only — leaving it in place
 * would have a third session act on context two boundaries old, which is the
 * failure mode the expiry exists to prevent, arriving by a different route.
 */
export function clearHandoff(homeDir: string = os.homedir()): void {
  try {
    unlinkSync(handoffPath(homeDir));
  } catch {
    // Already gone is the desired state.
  }
}

/** Render for the preflight block. One screen, no scrolling. */
export function renderHandoff(h: SessionHandoff, ageMs: number): string {
  const mins = Math.round(ageMs / 60000);
  const lines = [
    `handoff_from_previous_session: ${mins}m ago`,
    `  reason: ${h.reason}`,
  ];
  if (h.run) lines.push(`  run: ${h.run}`);
  if (h.thread_id) lines.push(`  thread: ${h.thread_id}`);
  lines.push('  already_established:');
  for (const e of h.established) lines.push(`    - ${e}`);
  if (h.artifacts?.length) {
    lines.push('  artifacts:');
    for (const a of h.artifacts) lines.push(`    - ${a}`);
  }
  if (h.next_command) lines.push(`  next_command: ${h.next_command}`);
  lines.push('  DO NOT re-derive the above. Start from next_command.');
  return lines.join('\n');
}
