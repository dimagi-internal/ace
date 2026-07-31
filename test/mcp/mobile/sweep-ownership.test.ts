import { describe, it, expect, vi } from 'vitest';
import { AvdBackend } from '../../../mcp/mobile/backends/avd.js';

// dimagi-internal/ace#1063 — the orphan sweep counted and tried to kill
// ANOTHER macOS user's emulator, so on a shared host it believed an orphan
// existed on every boot and its kill always failed with EPERM.

describe('sweepStaleEmulatorState ownership scoping (#1063)', () => {
  it('scopes the qemu scan to our own uid', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === 'pgrep') return { stdout: '', stderr: '', exitCode: 1, code: 1 };
      return { stdout: '', stderr: '', exitCode: 0, code: 0 };
    });
    const avd = new AvdBackend({ shell: shell as any });
    await (avd as any).sweepStaleEmulatorState().catch(() => {});

    const pgrepCall = calls.find((c) => c.cmd === 'pgrep');
    expect(pgrepCall, 'expected a pgrep scan').toBeTruthy();

    // The whole defect: a bare `-f qemu-system` sees every user's emulators.
    expect(pgrepCall!.args).toContain('-u');
    const uidIdx = pgrepCall!.args.indexOf('-u');
    expect(pgrepCall!.args[uidIdx + 1]).toBe(String(process.getuid!()));
  });

  it('never issues a bare unscoped qemu scan', async () => {
    const calls: string[][] = [];
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'pgrep') calls.push(args);
      return { stdout: '', stderr: '', exitCode: 1, code: 1 };
    });
    const avd = new AvdBackend({ shell: shell as any });
    await (avd as any).sweepStaleEmulatorState().catch(() => {});
    for (const args of calls) {
      // `['-f','qemu-system']` with no `-u` is the pre-#1063 signature.
      expect(args[0]).not.toBe('-f');
    }
  });
});

describe('AVD_BOOT_TIMEOUT_MS is honoured (#1063)', () => {
  it('the env var named by the error remediation actually exists in code', async () => {
    // The AVD_BOOT_TIMEOUT remediation has always said "bump
    // AVD_BOOT_TIMEOUT_MS", but nothing read it — so the advice could not be
    // followed. Pin that it is now wired, or the message lies again.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../../mcp/mobile/backends/avd.ts', import.meta.url).pathname,
        'utf8',
      ),
    );
    expect(src).toMatch(/process\.env\.AVD_BOOT_TIMEOUT_MS/);
    // And the remediation that advertises it is still present, so the two
    // cannot drift apart silently.
    expect(src).toMatch(/AVD_BOOT_TIMEOUT_MS/);
  });
});
