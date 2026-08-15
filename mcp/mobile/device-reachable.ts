/**
 * Assert a device actually answers before driving recipes at it.
 *
 * ace#1357 fix 3. `registerTestUser` deliberately calls `requireRunningAvd`
 * rather than `ensureAvdRunning` — the orchestrator has already cold-booted,
 * and a second cold boot here would wipe the just-installed CommCare APK and
 * loop forever. The consequence is that `requireRunningAvd` can hand back an
 * `AvdInfo` for a serial that adb lists but nothing can reach: Maestro then
 * fails installing its driver apk with `Connection refused`, and the operator
 * gets a dadb stack trace against a device that never really existed.
 *
 * The informative diagnostic was there the whole time. #1047's stderr capture
 * writes `${TMPDIR}/ace-emulator-<port>.log` and it contained the real fatal
 * line — but the attach block only decorates errors thrown from the boot-wait
 * path, and this failure surfaced from `registerTestUser`. So the named cause
 * was dropped and replaced by a broken pipe.
 *
 * This closes that: one cheap `adb shell echo` before part A, and on failure an
 * error that carries the boot log's fatal line instead of a transport trace.
 * The classification is pure so it unit-tests without a device; the caller owns
 * running adb.
 */

/** Echoed by the probe. Distinctive so a truncated or noisy read is not mistaken for success. */
export const REACHABILITY_TOKEN = 'ace-device-ok';

export interface AdbEchoResult {
  stdout: string;
  stderr: string;
  /** Undefined when the call threw before producing an exit code (timeout, ENOENT). */
  exitCode?: number;
  /** Set when invoking adb threw outright. */
  error?: string;
}

export interface ReachabilityVerdict {
  reachable: boolean;
  /** Present when unreachable — a short operator-facing cause. */
  reason?: string;
}

/**
 * `adb shell` is cheerfully unhelpful about a half-dead emulator: it can exit 0
 * with an error on stdout, or print `device offline` to stderr, so the token
 * round-trip is the only signal worth trusting.
 */
export function classifyAdbEcho(r: AdbEchoResult): ReachabilityVerdict {
  if (r.error) return { reachable: false, reason: `adb invocation failed: ${r.error}` };
  if (r.stdout.includes(REACHABILITY_TOKEN)) return { reachable: true };

  const noise = `${r.stderr}\n${r.stdout}`.toLowerCase();
  for (const [needle, reason] of [
    ['device offline', 'adb reports the device offline'],
    ['device not found', 'adb no longer lists this serial'],
    ['no devices/emulators found', 'adb sees no devices at all'],
    ['connection refused', 'nothing is listening on the device port'],
    ['device unauthorized', 'adb is not authorised for this device'],
    ['closed', 'the adb connection closed mid-call'],
  ] as const) {
    if (noise.includes(needle)) return { reachable: false, reason };
  }
  return {
    reachable: false,
    reason:
      `adb shell returned no ${REACHABILITY_TOKEN} token` +
      (r.exitCode != null ? ` (exit ${r.exitCode})` : ''),
  };
}

export interface UnreachableContext {
  serial: string;
  avdName: string;
  reason: string;
  /** Path to the emulator log #1047's stderr capture wrote, when one was found. */
  bootLogPath?: string;
  /** The single FATAL/ERROR line, when one could be identified. */
  fatalLine?: string;
  /** Tail of the boot log, as a fallback when no single line stands out. */
  tail?: string;
}

/**
 * Build the message. The whole point of #1357 is that the cause is already on
 * disk, so this leads with it rather than with the transport symptom.
 */
export function buildUnreachableMessage(ctx: UnreachableContext): string {
  const lines = [
    `Device ${ctx.serial} (AVD '${ctx.avdName}') is listed by adb but does not respond: ${ctx.reason}.`,
    '',
    'Not a registration failure — the recipes never got a device to drive.',
  ];
  if (ctx.fatalLine) {
    lines.push('', `The emulator said why when it started:`, `  ${ctx.fatalLine}`);
  } else if (ctx.tail) {
    lines.push('', 'Last lines of the emulator boot log:', ctx.tail);
  }
  if (ctx.bootLogPath) lines.push('', `Full boot log: ${ctx.bootLogPath}`);
  if (!ctx.fatalLine && !ctx.tail) {
    lines.push(
      '',
      'No emulator boot log was found for this session, so the cause is not recorded.',
      'Re-run the cold boot and check for a FATAL line before the adb-register wait.',
    );
  }
  lines.push(
    '',
    'If the AVD lost its system images, /ace:mobile-bootstrap re-provisions it.',
  );
  return lines.join('\n');
}
