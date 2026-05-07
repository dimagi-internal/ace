# ACE Mobile Emulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-Mac Android emulation layer to ACE that drives the Connect mobile + CommCare Android apps via Maestro, captures raw PNGs at every recipe step, and feeds them into a new `training-prep` Phase 5 alongside a relocated `training-materials` skill.

**Architecture:** New `ace-mobile` MCP server (sibling to `ace-ocs` and `ace-gdrive`) exposes 10 atomic capabilities backed by three implementation surfaces: `adb`-shelling-AVD operations, `maestro test`-shelling recipe execution, and Playwright-driven OTP fetching. A new `app-screenshot-capture` skill orchestrates them; a new `training-prep` phase agent runs that skill plus the relocated `training-materials` skill. Phase renumbering shifts `llo-manager` → 6 and `closeout` → 7 to preserve the "Phases 1–N agent-only, then LLO contact" invariant.

**Tech Stack:** TypeScript ESM (`tsx`-direct, no build step), `@modelcontextprotocol/sdk`, `zod`, `playwright`, Maestro CLI, Android SDK platform-tools (`adb`, `emulator`, `avdmanager`), Vitest. All shelling-out goes through `node:child_process`.

**Spec:** `docs/superpowers/specs/2026-04-28-ace-mobile-emulation-design.md`

---

## File Structure

### New files

```
mcp/
├── mobile-server.ts                      # MCP server entrypoint
└── mobile/
    ├── capability-map.ts                 # atom enum + backend route
    ├── types.ts                          # shared TS types
    ├── client.ts                         # composite client (atom dispatch)
    ├── errors.ts                         # structured errors
    ├── logging.ts                        # debug logger
    ├── auth/
    │   └── fetch-otp.ts                  # Playwright OTP fetcher
    ├── backends/
    │   ├── avd.ts                        # adb / emulator / avdmanager
    │   ├── maestro.ts                    # maestro test runner
    │   └── recipe-generator.ts           # LLM-driven YAML emit
    └── recipes/
        └── static/
            ├── connect-register-to-otp.yaml
            ├── connect-register-from-otp.yaml
            ├── connect-login.yaml
            └── connect-claim-opp.yaml

skills/
└── app-screenshot-capture/
    └── SKILL.md

agents/
└── training-prep/
    └── AGENT.md

commands/
└── mobile-bootstrap.md

test/
├── mcp/
│   └── mobile/
│       ├── capability-map.test.ts
│       ├── avd.test.ts
│       ├── maestro.test.ts
│       ├── recipe-generator.test.ts
│       ├── auth/
│       │   └── fetch-otp.test.ts
│       └── e2e.integration.test.ts       # MOBILE_INTEGRATION=1 only
└── eval/
    └── mobile-recipes/
        └── run-eval.ts
```

### Modified files

```
.env.tpl                                  # ACE_E2E_* + ACE_AVD_NAME
.claude-plugin/plugin.json                # register ace-mobile mcpServer
package.json                              # +mcp:mobile script (no new deps)
VERSION                                   # bump to 0.9.0
bin/ace-doctor                            # mobile section
commands/setup.md                         # mention /ace:mobile-bootstrap
commands/run.md                           # phase numbering (5→6, 6→7)
commands/step.md                          # phase numbering
commands/status.md                        # phase numbering
commands/eval.md                          # phase numbering
CLAUDE.md                                 # phase-topology table, layout
agents/ace-orchestrator/AGENT.md          # phase 5 dispatch + renumber
agents/llo-manager/AGENT.md               # remove training-materials step
skills/training-materials/SKILL.md        # consume new upstream artifacts
skills/connect-opp-setup/SKILL.md         # invite ACE test user step
lib/artifact-manifest.ts                  # register screenshots/, mobile-recipes/
```

---

## Phase 0 — Preflight

### Task 0.1: Verify worktree state

**Files:** none

- [ ] **Step 1: Confirm clean worktree**

```bash
git status
```

Expected: working tree clean, on branch `emdash/android-erui0`.

- [ ] **Step 2: Confirm spec exists**

```bash
ls -la docs/superpowers/specs/2026-04-28-ace-mobile-emulation-design.md
```

Expected: file present, ~480 lines.

- [ ] **Step 3: Verify Mac has Android SDK installed**

```bash
which adb && adb version
which emulator || echo "emulator not on PATH"
which avdmanager || echo "avdmanager not on PATH"
```

If any are missing, install via `brew install android-platform-tools` and download Android Studio for the AVD tooling. **This is a hard prerequisite for integration tests later but does not block Phases 1–8.**

- [ ] **Step 4: Verify Maestro is installed**

```bash
which maestro && maestro --version
```

If missing: `curl -Ls "https://get.maestro.mobile.dev" | bash`. Then re-source shell or restart terminal.

### Task 0.2: Bump VERSION and confirm dependencies

**Files:**
- Modify: `VERSION`

- [ ] **Step 1: Bump VERSION to 0.9.0**

```bash
echo "0.9.0" > VERSION
```

The pre-commit hook syncs `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` automatically when `VERSION` is staged.

- [ ] **Step 2: Verify package.json has playwright already (no new deps needed)**

```bash
grep '"playwright"' package.json
```

Expected: matches `"playwright": "^1.59.1"` or higher. We reuse the existing dep — no install needed for this plan's TS code (Maestro is a separate CLI tool, not an npm dep).

- [ ] **Step 3: Commit version bump**

```bash
git add VERSION package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump version to 0.9.0 for ace-mobile work"
```

---

## Phase 1 — Types and capability map

### Task 1.1: Define capability map (TDD)

**Files:**
- Create: `mcp/mobile/capability-map.ts`
- Test: `test/mcp/mobile/capability-map.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/mcp/mobile/capability-map.test.ts
import { describe, it, expect } from 'vitest';
import { CAPABILITY_MAP, type Capability } from '../../../mcp/mobile/capability-map.js';

const EXPECTED_CAPS: Capability[] = [
  'ensure_avd_running',
  'stop_avd',
  'list_avds',
  'install_apk',
  'uninstall_apk',
  'register_test_user',
  'fetch_otp',
  'run_recipe',
  'generate_recipes_from_app_summary',
  'capture_ui_dump',
];

describe('mobile capability-map', () => {
  it('declares exactly 10 capabilities', () => {
    expect(Object.keys(CAPABILITY_MAP).sort()).toEqual([...EXPECTED_CAPS].sort());
  });

  it('every capability has a backend', () => {
    for (const cap of EXPECTED_CAPS) {
      expect(CAPABILITY_MAP[cap].backend).toMatch(/^(AVD|MAESTRO|COMPOSITE)$/);
    }
  });

  it('routes register_test_user and fetch_otp through COMPOSITE', () => {
    expect(CAPABILITY_MAP.register_test_user.backend).toBe('COMPOSITE');
    expect(CAPABILITY_MAP.fetch_otp.backend).toBe('COMPOSITE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/mcp/mobile/capability-map.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement minimal capability-map**

```typescript
// mcp/mobile/capability-map.ts
export type Backend = 'MAESTRO' | 'AVD' | 'COMPOSITE';

export type Capability =
  | 'ensure_avd_running'
  | 'stop_avd'
  | 'list_avds'
  | 'install_apk'
  | 'uninstall_apk'
  | 'register_test_user'
  | 'fetch_otp'
  | 'run_recipe'
  | 'generate_recipes_from_app_summary'
  | 'capture_ui_dump';

export interface CapabilityRoute {
  backend: Backend;
  description: string;
}

export const CAPABILITY_MAP: Record<Capability, CapabilityRoute> = {
  ensure_avd_running:                { backend: 'AVD',       description: 'Boot the AVD if cold; idempotent' },
  stop_avd:                          { backend: 'AVD',       description: 'Graceful AVD shutdown' },
  list_avds:                         { backend: 'AVD',       description: 'List AVDs known to avdmanager' },
  install_apk:                       { backend: 'AVD',       description: 'adb install -r' },
  uninstall_apk:                     { backend: 'AVD',       description: 'adb uninstall' },
  register_test_user:                { backend: 'COMPOSITE', description: 'Maestro + Playwright registration flow' },
  fetch_otp:                         { backend: 'COMPOSITE', description: 'Playwright OTP scrape' },
  run_recipe:                        { backend: 'MAESTRO',   description: 'maestro test <recipe>' },
  generate_recipes_from_app_summary: { backend: 'MAESTRO',   description: 'LLM emits Maestro YAML from app summary' },
  capture_ui_dump:                   { backend: 'AVD',       description: 'adb shell uiautomator dump' },
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/mcp/mobile/capability-map.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add mcp/mobile/capability-map.ts test/mcp/mobile/capability-map.test.ts
git commit -m "feat(mobile): capability-map with 10 atoms"
```

### Task 1.2: Shared types

**Files:**
- Create: `mcp/mobile/types.ts`

- [ ] **Step 1: Define types**

```typescript
// mcp/mobile/types.ts
export interface AvdInfo {
  name: string;
  serial: string;       // adb device serial, e.g. "emulator-5554"
  status: 'booted' | 'booting' | 'offline';
  bootTimeMs?: number;
}

export interface ApkInfo {
  packageId: string;    // e.g. "org.commcare.dalvik"
  versionName: string;
  versionCode: number;
  path: string;
}

export interface RecipeRunResult {
  status: 'pass' | 'fail';
  exitCode: number;
  stdout: string;
  stderr: string;
  screenshotsDir: string;
  screenshots: ScreenshotEntry[];
}

export interface ScreenshotEntry {
  stepName: string;
  path: string;
  takenAt: string;      // ISO 8601
  bytes: number;
}

export interface OtpResult {
  phone: string;
  otp: string;
  fetchedAt: string;
}

export interface TestUserRegistrationResult {
  alreadyRegistered: boolean;
  phone: string;
  backupCode?: string;  // present only on first registration
}

export interface UiDumpResult {
  xml: string;
  elements: Array<{ id?: string; text?: string; class?: string; bounds?: string }>;
}
```

- [ ] **Step 2: Verify types compile**

```bash
npx tsc --noEmit mcp/mobile/types.ts
```

Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add mcp/mobile/types.ts
git commit -m "feat(mobile): shared TS types"
```

### Task 1.3: Structured errors

**Files:**
- Create: `mcp/mobile/errors.ts`
- Test: `test/mcp/mobile/errors.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/mcp/mobile/errors.test.ts
import { describe, it, expect } from 'vitest';
import {
  MobileError, AvdBootError, OtpFetchError, RecipeValidationError, AdbError, MaestroError
} from '../../../mcp/mobile/errors.js';

describe('mobile errors', () => {
  it('AvdBootError carries avd name + remediation', () => {
    const err = new AvdBootError('ACE_Pixel_API_34', 'timeout after 90s');
    expect(err).toBeInstanceOf(MobileError);
    expect(err.code).toBe('AVD_BOOT_FAILED');
    expect(err.remediation).toMatch(/ace:mobile-bootstrap/);
    expect(err.message).toContain('ACE_Pixel_API_34');
  });

  it('OtpFetchError distinguishes signed-out vs not-found', () => {
    const signedOut = new OtpFetchError('AUTH_REQUIRED', '+74260000001');
    expect(signedOut.code).toBe('OTP_AUTH_REQUIRED');
    expect(signedOut.remediation).toMatch(/PHASE9_HEADED|headed/i);

    const notFound = new OtpFetchError('NOT_FOUND', '+74260000099');
    expect(notFound.code).toBe('OTP_NOT_FOUND');
  });

  it('RecipeValidationError includes the offending YAML path', () => {
    const err = new RecipeValidationError('/tmp/bad.yaml', 'unknown step type');
    expect(err.code).toBe('RECIPE_INVALID');
    expect(err.message).toContain('/tmp/bad.yaml');
  });

  it('AdbError and MaestroError carry exit codes', () => {
    expect(new AdbError('install', 1, 'INSTALL_FAILED_VERSION_DOWNGRADE').exitCode).toBe(1);
    expect(new MaestroError('flow.yaml', 2, 'TIMEOUT').exitCode).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run test/mcp/mobile/errors.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement errors**

```typescript
// mcp/mobile/errors.ts
export class MobileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly remediation?: string,
  ) {
    super(message);
    this.name = 'MobileError';
  }
}

export class AvdBootError extends MobileError {
  constructor(avdName: string, reason: string) {
    super(
      'AVD_BOOT_FAILED',
      `AVD ${avdName} failed to boot: ${reason}`,
      'Run /ace:mobile-bootstrap to verify AVD setup.',
    );
  }
}

export class OtpFetchError extends MobileError {
  constructor(reason: 'AUTH_REQUIRED' | 'NOT_FOUND' | 'STALE' | 'UNKNOWN', phone: string) {
    const remediation =
      reason === 'AUTH_REQUIRED'
        ? 'Run with PHASE9_HEADED=1 to sign in to Dimagi SSO once; cookies will persist.'
        : reason === 'NOT_FOUND'
          ? 'Verify the phone is registered and within 60s of OTP issuance.'
          : 'Re-fetch; OTP may have rotated.';
    super(`OTP_${reason}`, `OTP fetch (${reason}) for ${phone}`, remediation);
  }
}

export class RecipeValidationError extends MobileError {
  constructor(recipePath: string, reason: string) {
    super('RECIPE_INVALID', `Invalid Maestro recipe at ${recipePath}: ${reason}`);
  }
}

export class AdbError extends MobileError {
  constructor(public readonly subcommand: string, public readonly exitCode: number, stderr: string) {
    super('ADB_ERROR', `adb ${subcommand} failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
  }
}

export class MaestroError extends MobileError {
  constructor(public readonly recipePath: string, public readonly exitCode: number, stderr: string) {
    super('MAESTRO_ERROR', `maestro test ${recipePath} failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
  }
}
```

- [ ] **Step 4: Verify pass**

```bash
npx vitest run test/mcp/mobile/errors.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add mcp/mobile/errors.ts test/mcp/mobile/errors.test.ts
git commit -m "feat(mobile): structured errors with remediation hints"
```

### Task 1.4: Logging helper

**Files:**
- Create: `mcp/mobile/logging.ts`

- [ ] **Step 1: Implement (mirror mcp/ocs/logging.ts conventions)**

```typescript
// mcp/mobile/logging.ts
const TAG = 'ace-mobile';

export function logInfo(...args: unknown[]): void {
  process.stderr.write(`[${TAG}] ${args.map(stringify).join(' ')}\n`);
}

export function logDebug(...args: unknown[]): void {
  if (process.env.ACE_MOBILE_DEBUG) {
    process.stderr.write(`[${TAG}:debug] ${args.map(stringify).join(' ')}\n`);
  }
}

export function logError(...args: unknown[]): void {
  process.stderr.write(`[${TAG}:error] ${args.map(stringify).join(' ')}\n`);
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
```

- [ ] **Step 2: Quick smoke test**

```bash
npx tsx -e 'import("./mcp/mobile/logging.js").then(m => m.logInfo("hello", {a: 1}))' 2>&1
```

Expected stderr: `[ace-mobile] hello {"a":1}`.

- [ ] **Step 3: Commit**

```bash
git add mcp/mobile/logging.ts
git commit -m "feat(mobile): stderr logging helper"
```

---

## Phase 2 — AVD backend

This phase shells out to `adb`, `emulator`, `avdmanager`, and `aapt`. Tests use a `runShell` injection seam so we don't need a real device for unit tests.

### Task 2.1: AVD backend shell-injection seam (TDD)

**Files:**
- Create: `mcp/mobile/backends/avd.ts`
- Test: `test/mcp/mobile/avd.test.ts`

- [ ] **Step 1: Write failing test for `listAvds`**

```typescript
// test/mcp/mobile/avd.test.ts
import { describe, it, expect, vi } from 'vitest';
import { AvdBackend } from '../../../mcp/mobile/backends/avd.js';

function fakeShell(scripted: Record<string, { stdout: string; stderr?: string; code?: number }>) {
  return vi.fn(async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(' ')}`;
    const r = scripted[key];
    if (!r) throw new Error(`Unscripted shell call: ${key}`);
    return { stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.code ?? 0 };
  });
}

describe('AvdBackend.listAvds', () => {
  it('parses emulator -list-avds output', async () => {
    const shell = fakeShell({
      'emulator -list-avds': { stdout: 'ACE_Pixel_API_34\nOther_AVD\n' },
    });
    const backend = new AvdBackend({ shell });
    const result = await backend.listAvds();
    expect(result).toEqual(['ACE_Pixel_API_34', 'Other_AVD']);
  });

  it('returns empty array when no AVDs', async () => {
    const shell = fakeShell({ 'emulator -list-avds': { stdout: '' } });
    const backend = new AvdBackend({ shell });
    expect(await backend.listAvds()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

```bash
npx vitest run test/mcp/mobile/avd.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement skeleton + listAvds**

```typescript
// mcp/mobile/backends/avd.ts
import { spawn } from 'node:child_process';

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ShellFn = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ShellResult>;

export const defaultShell: ShellFn = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`shell timeout: ${cmd} ${args.join(' ')}`));
        }, opts.timeoutMs)
      : null;
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
  });

export interface AvdBackendOpts {
  shell?: ShellFn;
}

export class AvdBackend {
  private shell: ShellFn;
  constructor(opts: AvdBackendOpts = {}) {
    this.shell = opts.shell ?? defaultShell;
  }

  async listAvds(): Promise<string[]> {
    const r = await this.shell('emulator', ['-list-avds']);
    return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  }
}
```

- [ ] **Step 4: Verify PASS**

```bash
npx vitest run test/mcp/mobile/avd.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add mcp/mobile/backends/avd.ts test/mcp/mobile/avd.test.ts
git commit -m "feat(mobile): AvdBackend skeleton with listAvds"
```

### Task 2.2: ensureAvdRunning + stopAvd

**Files:**
- Modify: `mcp/mobile/backends/avd.ts`
- Modify: `test/mcp/mobile/avd.test.ts`

- [ ] **Step 1: Add failing tests**

```typescript
// append to test/mcp/mobile/avd.test.ts
import { AvdBootError } from '../../../mcp/mobile/errors.js';

describe('AvdBackend.ensureAvdRunning', () => {
  it('returns existing serial if AVD already booted', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
    });
    const backend = new AvdBackend({ shell });
    const info = await backend.ensureAvdRunning('ACE_Pixel_API_34');
    expect(info).toMatchObject({ name: 'ACE_Pixel_API_34', serial: 'emulator-5554', status: 'booted' });
  });

  it('throws AvdBootError if AVD does not exist', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\n' },
      'emulator -list-avds': { stdout: 'Other_AVD\n' },
    });
    const backend = new AvdBackend({ shell });
    await expect(backend.ensureAvdRunning('ACE_Pixel_API_34')).rejects.toBeInstanceOf(AvdBootError);
  });
});

describe('AvdBackend.stopAvd', () => {
  it('shells adb emu kill against the matching device', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 emu kill': { stdout: '' },
    });
    const backend = new AvdBackend({ shell });
    await backend.stopAvd('ACE_Pixel_API_34');
    expect(shell).toHaveBeenCalledWith('adb', ['-s', 'emulator-5554', 'emu', 'kill']);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Expected: methods don't exist.

- [ ] **Step 3: Implement (append to `mcp/mobile/backends/avd.ts`)**

```typescript
// append to mcp/mobile/backends/avd.ts
import { AvdBootError } from '../errors.js';
import type { AvdInfo } from '../types.js';

const AVD_BOOT_TIMEOUT_MS = 120_000;
const AVD_BOOT_POLL_MS = 2_000;

// inside class AvdBackend:

  async ensureAvdRunning(avdName: string): Promise<AvdInfo> {
    const existing = await this.findRunningAvd(avdName);
    if (existing) return existing;

    const known = await this.listAvds();
    if (!known.includes(avdName)) {
      throw new AvdBootError(avdName, `AVD '${avdName}' not in emulator -list-avds output`);
    }

    // Boot in detached background process; do NOT await it.
    const child = spawn('emulator', ['-avd', avdName, '-no-window', '-no-snapshot-save'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    const start = Date.now();
    while (Date.now() - start < AVD_BOOT_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, AVD_BOOT_POLL_MS));
      const found = await this.findRunningAvd(avdName);
      if (found) {
        return { ...found, bootTimeMs: Date.now() - start };
      }
    }
    throw new AvdBootError(avdName, `boot timeout after ${AVD_BOOT_TIMEOUT_MS}ms`);
  }

  async stopAvd(avdName: string): Promise<void> {
    const found = await this.findRunningAvd(avdName);
    if (!found) return;
    await this.shell('adb', ['-s', found.serial, 'emu', 'kill']);
  }

  private async findRunningAvd(avdName: string): Promise<AvdInfo | null> {
    const devices = await this.shell('adb', ['devices']);
    const serials = devices.stdout
      .split('\n')
      .slice(1)
      .map((line) => line.split('\t')[0].trim())
      .filter((s) => s.startsWith('emulator-'));

    for (const serial of serials) {
      const r = await this.shell('adb', ['-s', serial, 'emu', 'avd', 'name']);
      const name = r.stdout.split('\n')[0].trim();
      if (name === avdName) return { name, serial, status: 'booted' };
    }
    return null;
  }
```

(Add `import { spawn } from 'node:child_process';` at the top if not present — note `defaultShell` already imports it.)

- [ ] **Step 4: Verify PASS**

```bash
npx vitest run test/mcp/mobile/avd.test.ts
```

Expected: PASS, 4 tests total.

- [ ] **Step 5: Commit**

```bash
git add mcp/mobile/backends/avd.ts test/mcp/mobile/avd.test.ts
git commit -m "feat(mobile): ensureAvdRunning + stopAvd via adb"
```

### Task 2.3: installApk + uninstallApk + listInstalledApk helper

**Files:**
- Modify: `mcp/mobile/backends/avd.ts`
- Modify: `test/mcp/mobile/avd.test.ts`

- [ ] **Step 1: Add failing tests**

```typescript
// append to test/mcp/mobile/avd.test.ts
describe('AvdBackend.installApk', () => {
  it('shells adb install -r and parses package info via aapt', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 install -r /tmp/foo.apk': { stdout: 'Performing Streamed Install\nSuccess\n' },
      'aapt dump badging /tmp/foo.apk': {
        stdout: `package: name='org.commcare.dalvik' versionCode='2550' versionName='2.55'\n`,
      },
    });
    const backend = new AvdBackend({ shell });
    const r = await backend.installApk('ACE_Pixel_API_34', '/tmp/foo.apk');
    expect(r).toEqual({
      packageId: 'org.commcare.dalvik',
      versionName: '2.55',
      versionCode: 2550,
      path: '/tmp/foo.apk',
    });
  });
});
```

- [ ] **Step 2: Verify FAIL**

```bash
npx vitest run test/mcp/mobile/avd.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// append to mcp/mobile/backends/avd.ts
import type { ApkInfo } from '../types.js';
import { AdbError } from '../errors.js';

// inside class:
  async installApk(avdName: string, apkPath: string): Promise<ApkInfo> {
    const avd = await this.ensureAvdRunning(avdName);
    const r = await this.shell('adb', ['-s', avd.serial, 'install', '-r', apkPath]);
    if (r.exitCode !== 0 || !r.stdout.includes('Success')) {
      throw new AdbError('install', r.exitCode, r.stderr || r.stdout);
    }
    return this.parseApkInfo(apkPath);
  }

  async uninstallApk(avdName: string, packageId: string): Promise<{ uninstalled: boolean }> {
    const avd = await this.ensureAvdRunning(avdName);
    const r = await this.shell('adb', ['-s', avd.serial, 'uninstall', packageId]);
    return { uninstalled: r.stdout.includes('Success') };
  }

  private async parseApkInfo(apkPath: string): Promise<ApkInfo> {
    const r = await this.shell('aapt', ['dump', 'badging', apkPath]);
    const m = r.stdout.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/);
    if (!m) throw new AdbError('aapt', 0, `could not parse apk metadata for ${apkPath}`);
    return { packageId: m[1], versionCode: parseInt(m[2], 10), versionName: m[3], path: apkPath };
  }
```

- [ ] **Step 4: Verify PASS**

```bash
npx vitest run test/mcp/mobile/avd.test.ts
```

Expected: PASS, 5 tests total.

- [ ] **Step 5: Commit**

```bash
git add mcp/mobile/backends/avd.ts test/mcp/mobile/avd.test.ts
git commit -m "feat(mobile): installApk + uninstallApk via adb"
```

### Task 2.4: captureUiDump

**Files:**
- Modify: `mcp/mobile/backends/avd.ts`
- Modify: `test/mcp/mobile/avd.test.ts`

- [ ] **Step 1: Add failing test**

```typescript
// append to test/mcp/mobile/avd.test.ts
describe('AvdBackend.captureUiDump', () => {
  it('runs uiautomator dump, pulls XML, parses elements', async () => {
    const xml = `<hierarchy><node resource-id="login_btn" text="Sign in" class="android.widget.Button" bounds="[0,0][100,50]"/></hierarchy>`;
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 shell uiautomator dump /sdcard/window_dump.xml': { stdout: 'UI hierarchy dumped\n' },
      'adb -s emulator-5554 exec-out cat /sdcard/window_dump.xml': { stdout: xml },
    });
    const backend = new AvdBackend({ shell });
    const r = await backend.captureUiDump('ACE_Pixel_API_34');
    expect(r.xml).toBe(xml);
    expect(r.elements).toContainEqual(
      expect.objectContaining({ id: 'login_btn', text: 'Sign in', class: 'android.widget.Button' }),
    );
  });
});
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: Implement**

```typescript
// append to mcp/mobile/backends/avd.ts
import type { UiDumpResult } from '../types.js';

  async captureUiDump(avdName: string): Promise<UiDumpResult> {
    const avd = await this.ensureAvdRunning(avdName);
    await this.shell('adb', ['-s', avd.serial, 'shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml']);
    const xmlR = await this.shell('adb', ['-s', avd.serial, 'exec-out', 'cat', '/sdcard/window_dump.xml']);
    return { xml: xmlR.stdout, elements: this.parseHierarchy(xmlR.stdout) };
  }

  private parseHierarchy(xml: string): UiDumpResult['elements'] {
    const out: UiDumpResult['elements'] = [];
    const nodeRe = /<node\s+([^>]*?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = nodeRe.exec(xml)) !== null) {
      const attrs = m[1];
      const get = (k: string) => {
        const am = attrs.match(new RegExp(`${k}="([^"]*)"`));
        return am ? am[1] : undefined;
      };
      out.push({
        id: get('resource-id') || undefined,
        text: get('text') || undefined,
        class: get('class') || undefined,
        bounds: get('bounds') || undefined,
      });
    }
    return out;
  }
```

- [ ] **Step 4: Verify PASS**

```bash
npx vitest run test/mcp/mobile/avd.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add mcp/mobile/backends/avd.ts test/mcp/mobile/avd.test.ts
git commit -m "feat(mobile): captureUiDump for recipe debugging"
```

---

## Phase 3 — Maestro backend

### Task 3.1: runRecipe primitive (TDD)

**Files:**
- Create: `mcp/mobile/backends/maestro.ts`
- Test: `test/mcp/mobile/maestro.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/mcp/mobile/maestro.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MaestroBackend } from '../../../mcp/mobile/backends/maestro.js';

function fakeShell(scripted: Record<string, { stdout: string; stderr?: string; code?: number }>) {
  return vi.fn(async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(' ')}`;
    const r = scripted[key];
    if (!r) throw new Error(`Unscripted shell call: ${key}`);
    return { stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.code ?? 0 };
  });
}

describe('MaestroBackend.runRecipe', () => {
  it('passes env vars as -e flags and collects screenshots', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    fs.writeFileSync(path.join(tmp, 'step-01-home.png'), 'fake');
    fs.writeFileSync(path.join(tmp, 'step-02-login.png'), 'fake');
    const recipePath = path.join(tmp, 'flow.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n');

    const shell = fakeShell({
      [`maestro test --no-ansi -e PHONE=+74260000001 -e PIN=123456 --output ${tmp} ${recipePath}`]: {
        stdout: 'OK\n', code: 0,
      },
    });
    const backend = new MaestroBackend({ shell });
    const r = await backend.runRecipe(recipePath, { PHONE: '+74260000001', PIN: '123456' }, tmp);
    expect(r.status).toBe('pass');
    expect(r.screenshots.length).toBeGreaterThanOrEqual(2);
    expect(r.screenshots.map((s) => s.stepName)).toEqual(
      expect.arrayContaining(['step-01-home', 'step-02-login']),
    );
  });

  it('returns fail status with non-zero exit code', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    const recipePath = path.join(tmp, 'flow.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n');

    const shell = fakeShell({
      [`maestro test --no-ansi --output ${tmp} ${recipePath}`]: {
        stdout: '', stderr: 'TIMEOUT', code: 1,
      },
    });
    const backend = new MaestroBackend({ shell });
    const r = await backend.runRecipe(recipePath, {}, tmp);
    expect(r.status).toBe('fail');
    expect(r.exitCode).toBe(1);
  });
});

describe('MaestroBackend.validateRecipe', () => {
  it('rejects YAML with unknown step keys', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    const recipePath = path.join(tmp, 'bad.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- bogusStep: hi\n');
    const backend = new MaestroBackend({ shell: vi.fn() });
    await expect(backend.validateRecipe(recipePath)).rejects.toThrow(/RECIPE_INVALID|unknown/i);
  });

  it('accepts valid Maestro YAML', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    const recipePath = path.join(tmp, 'good.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- launchApp\n- takeScreenshot: home\n');
    const backend = new MaestroBackend({ shell: vi.fn() });
    await expect(backend.validateRecipe(recipePath)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Verify FAIL**

```bash
npx vitest run test/mcp/mobile/maestro.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// mcp/mobile/backends/maestro.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MaestroError, RecipeValidationError } from '../errors.js';
import type { ShellFn } from './avd.js';
import { defaultShell } from './avd.js';
import type { RecipeRunResult, ScreenshotEntry } from '../types.js';

const ALLOWED_STEP_KEYS = new Set([
  'launchApp',
  'tapOn',
  'inputText',
  'takeScreenshot',
  'assertVisible',
  'assertNotVisible',
  'extendedWaitUntil',
  'waitForAnimationToEnd',
  'eraseText',
  'swipe',
  'pressKey',
  'back',
  'scroll',
  'hideKeyboard',
  'copyTextFrom',
  'pasteText',
  'runFlow',
]);

export interface MaestroBackendOpts {
  shell?: ShellFn;
}

export class MaestroBackend {
  private shell: ShellFn;
  constructor(opts: MaestroBackendOpts = {}) {
    this.shell = opts.shell ?? defaultShell;
  }

  async runRecipe(
    recipePath: string,
    envVars: Record<string, string>,
    screenshotDir: string,
  ): Promise<RecipeRunResult> {
    fs.mkdirSync(screenshotDir, { recursive: true });
    const args = ['test', '--no-ansi'];
    for (const [k, v] of Object.entries(envVars)) {
      args.push('-e', `${k}=${v}`);
    }
    args.push('--output', screenshotDir, recipePath);
    const r = await this.shell('maestro', args, { timeoutMs: 10 * 60 * 1000 });
    const screenshots = this.collectScreenshots(screenshotDir);
    return {
      status: r.exitCode === 0 ? 'pass' : 'fail',
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      screenshotsDir: screenshotDir,
      screenshots,
    };
  }

  /**
   * Lightweight YAML structural validation. Maestro doesn't ship a public
   * --validate flag we can rely on across versions, so we parse the YAML
   * ourselves and reject unknown step keys early.
   */
  async validateRecipe(recipePath: string): Promise<void> {
    const content = fs.readFileSync(recipePath, 'utf8');
    const docs = content.split(/^---\s*$/m);
    if (docs.length < 2) throw new RecipeValidationError(recipePath, 'missing --- separator');

    const flow = docs[1];
    const stepLines = flow.split('\n').filter((l) => l.trim().startsWith('- '));
    for (const line of stepLines) {
      const keyMatch = line.match(/^\s*-\s+([a-zA-Z]+)/);
      if (!keyMatch) continue;
      const key = keyMatch[1];
      if (!ALLOWED_STEP_KEYS.has(key)) {
        throw new RecipeValidationError(recipePath, `unknown step key: ${key}`);
      }
    }
  }

  private collectScreenshots(dir: string): ScreenshotEntry[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .sort()
      .map((f) => {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        return {
          stepName: f.replace(/\.png$/, ''),
          path: full,
          takenAt: stat.mtime.toISOString(),
          bytes: stat.size,
        };
      });
  }
}
```

- [ ] **Step 4: Verify PASS**

```bash
npx vitest run test/mcp/mobile/maestro.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add mcp/mobile/backends/maestro.ts test/mcp/mobile/maestro.test.ts
git commit -m "feat(mobile): MaestroBackend.runRecipe + validateRecipe"
```

---

## Phase 4 — OTP fetcher (Playwright)

### Task 4.1: fetch-otp.ts skeleton (TDD with Playwright mocked)

**Files:**
- Create: `mcp/mobile/auth/fetch-otp.ts`
- Test: `test/mcp/mobile/auth/fetch-otp.test.ts`

- [ ] **Step 1: Write failing test (mocks `chromium.launchPersistentContext`)**

```typescript
// test/mcp/mobile/auth/fetch-otp.test.ts
import { describe, it, expect, vi } from 'vitest';
import { fetchOtp, type ChromiumLike } from '../../../../mcp/mobile/auth/fetch-otp.js';
import { OtpFetchError } from '../../../../mcp/mobile/errors.js';

function mockChromium(html: string, signedIn = true): ChromiumLike {
  const page = {
    goto: vi.fn().mockResolvedValue({ ok: () => true }),
    url: vi.fn().mockReturnValue(
      signedIn
        ? 'https://connect.dimagi.com/users/connect_user_otp/'
        : 'https://connect.dimagi.com/sso/login',
    ),
    content: vi.fn().mockResolvedValue(html),
  };
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    launchPersistentContext: vi.fn().mockResolvedValue(context),
  } as unknown as ChromiumLike;
}

describe('fetchOtp', () => {
  it('parses 6-digit OTP for the given phone from page HTML', async () => {
    const html = `
      <table>
        <tr><td>+74260000001</td><td>123456</td><td>2026-04-28 12:00</td></tr>
        <tr><td>+74260000002</td><td>654321</td><td>2026-04-28 12:01</td></tr>
      </table>`;
    const r = await fetchOtp('+74260000002', {
      chromium: mockChromium(html),
      userDataDir: '/tmp/userdata',
    });
    expect(r.otp).toBe('654321');
    expect(r.phone).toBe('+74260000002');
  });

  it('throws OtpFetchError(AUTH_REQUIRED) when redirected to SSO', async () => {
    await expect(
      fetchOtp('+74260000002', {
        chromium: mockChromium('', false),
        userDataDir: '/tmp/userdata',
      }),
    ).rejects.toMatchObject({ code: 'OTP_AUTH_REQUIRED' });
  });

  it('throws OtpFetchError(NOT_FOUND) when phone has no row', async () => {
    const html = `<table><tr><td>+74260000999</td><td>111111</td></tr></table>`;
    await expect(
      fetchOtp('+74260000001', {
        chromium: mockChromium(html),
        userDataDir: '/tmp/userdata',
      }),
    ).rejects.toMatchObject({ code: 'OTP_NOT_FOUND' });
  });
});
```

- [ ] **Step 2: Verify FAIL**

```bash
npx vitest run test/mcp/mobile/auth/fetch-otp.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// mcp/mobile/auth/fetch-otp.ts
import { chromium as defaultChromium, type BrowserContext } from 'playwright';
import { OtpFetchError } from '../errors.js';
import type { OtpResult } from '../types.js';

export interface ChromiumLike {
  launchPersistentContext(userDataDir: string, opts: { headless: boolean }): Promise<BrowserContext>;
}

export interface FetchOtpOpts {
  chromium?: ChromiumLike;
  userDataDir: string;
  url?: string;
  headed?: boolean;
}

const DEFAULT_URL = 'https://connect.dimagi.com/users/connect_user_otp/';

export async function fetchOtp(phone: string, opts: FetchOtpOpts): Promise<OtpResult> {
  const browser = (opts.chromium ?? defaultChromium) as ChromiumLike;
  const url = opts.url ?? DEFAULT_URL;
  const headed = opts.headed ?? false;

  const context = await browser.launchPersistentContext(opts.userDataDir, { headless: !headed });
  try {
    const page = await context.newPage();
    await page.goto(url);

    if (!page.url().startsWith('https://connect.dimagi.com/users/connect_user_otp/')) {
      throw new OtpFetchError('AUTH_REQUIRED', phone);
    }

    const html = await page.content();
    const otp = extractOtp(html, phone);
    if (!otp) throw new OtpFetchError('NOT_FOUND', phone);

    return { phone, otp, fetchedAt: new Date().toISOString() };
  } finally {
    await context.close();
  }
}

function extractOtp(html: string, phone: string): string | null {
  // Find a <tr> that contains the phone, then the next 6-digit run inside that <tr>.
  const escaped = phone.replace(/[+]/g, '\\+');
  const rowRe = new RegExp(`<tr[^>]*>[^]*?${escaped}[^]*?</tr>`, 'i');
  const m = html.match(rowRe);
  if (!m) return null;
  const otpMatch = m[0].match(/\b(\d{6})\b/);
  return otpMatch ? otpMatch[1] : null;
}
```

- [ ] **Step 4: Verify PASS**

```bash
npx vitest run test/mcp/mobile/auth/fetch-otp.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add mcp/mobile/auth/fetch-otp.ts test/mcp/mobile/auth/fetch-otp.test.ts
git commit -m "feat(mobile): Playwright OTP fetcher (TS reimplementation)"
```

### Task 4.2: Validate against the live page structure

**Files:** none new

This is a **discovery task** that runs against live infrastructure. It produces no code changes if the test passes; it produces an `extractOtp` adjustment if the live HTML structure is different from what was assumed.

- [ ] **Step 1: First-time headed login (manual, one-time per workstation)**

```bash
# from the repo root, in a fresh shell
mkdir -p ~/.ace/playwright-userdata
ACE_PLAYWRIGHT_USER_DATA_DIR=~/.ace/playwright-userdata \
  PHASE9_HEADED=1 \
  npx tsx -e '
    import { fetchOtp } from "./mcp/mobile/auth/fetch-otp.ts";
    fetchOtp("+74260000042", {
      userDataDir: process.env.ACE_PLAYWRIGHT_USER_DATA_DIR!,
      headed: true,
    }).then(r => console.log(r)).catch(e => console.error(e));
  '
```

A headed Chromium opens. Sign in via Dimagi SSO. The script then proceeds to scrape the OTP for `+74260000042` (commcare-ios's existing test number — known to be on the page). Note the structure of the HTML it parses.

- [ ] **Step 2: If the OTP is found, no code change needed**

You'll see something like `{ phone: '+74260000042', otp: '123456', fetchedAt: '...' }`. Move on.

- [ ] **Step 3: If `OTP_NOT_FOUND` is thrown, inspect the page HTML and adjust `extractOtp`**

Most likely culprits: the row layout uses `<div>` instead of `<tr>`, or the phone format on the page doesn't match what we sent in (e.g., page uses `74260000042` without the `+`). Save a snapshot of the page HTML to `test/mcp/mobile/auth/fixtures/connect_user_otp_real.html` (gitignored — contains real phone numbers) and rewrite the regex against the actual structure. Add an additional test case that uses a sanitized minimal version of that fixture.

- [ ] **Step 4: Confirm headless run works**

```bash
ACE_PLAYWRIGHT_USER_DATA_DIR=~/.ace/playwright-userdata \
  npx tsx -e '
    import { fetchOtp } from "./mcp/mobile/auth/fetch-otp.ts";
    fetchOtp("+74260000042", {
      userDataDir: process.env.ACE_PLAYWRIGHT_USER_DATA_DIR!,
    }).then(r => console.log(r));
  '
```

Expected: prints OTP within a few seconds, no browser window.

- [ ] **Step 5: Commit any fixture and code adjustments**

```bash
git add mcp/mobile/auth/fetch-otp.ts test/mcp/mobile/auth/fetch-otp.test.ts
git commit -m "fix(mobile): adjust OTP scraper to match live page structure"
```

---

## Phase 5 — Composite client and `register_test_user`

### Task 5.1: Composite client skeleton

**Files:**
- Create: `mcp/mobile/client.ts`

- [ ] **Step 1: Implement**

```typescript
// mcp/mobile/client.ts
import * as path from 'node:path';
import { AvdBackend } from './backends/avd.js';
import { MaestroBackend } from './backends/maestro.js';
import { fetchOtp } from './auth/fetch-otp.js';
import type {
  AvdInfo, ApkInfo, RecipeRunResult, OtpResult, TestUserRegistrationResult, UiDumpResult,
} from './types.js';
import { logInfo } from './logging.js';

export interface MobileClientOpts {
  avd?: AvdBackend;
  maestro?: MaestroBackend;
  staticRecipesDir?: string;
  playwrightUserDataDir?: string;
}

const DEFAULT_STATIC_DIR = new URL('./recipes/static/', import.meta.url).pathname;
const DEFAULT_PLAYWRIGHT_DIR =
  process.env.ACE_PLAYWRIGHT_USER_DATA_DIR ||
  path.join(process.env.HOME ?? '', '.ace', 'playwright-userdata');

export class MobileClient {
  readonly avd: AvdBackend;
  readonly maestro: MaestroBackend;
  readonly staticRecipesDir: string;
  readonly playwrightUserDataDir: string;

  constructor(opts: MobileClientOpts = {}) {
    this.avd = opts.avd ?? new AvdBackend();
    this.maestro = opts.maestro ?? new MaestroBackend();
    this.staticRecipesDir = opts.staticRecipesDir ?? DEFAULT_STATIC_DIR;
    this.playwrightUserDataDir = opts.playwrightUserDataDir ?? DEFAULT_PLAYWRIGHT_DIR;
  }

  // ---- Atom-level methods (one per capability) ----

  ensureAvdRunning(name: string): Promise<AvdInfo> { return this.avd.ensureAvdRunning(name); }
  stopAvd(name: string): Promise<void> { return this.avd.stopAvd(name); }
  listAvds(): Promise<string[]> { return this.avd.listAvds(); }
  installApk(avdName: string, apk: string): Promise<ApkInfo> { return this.avd.installApk(avdName, apk); }
  uninstallApk(avdName: string, pkg: string): Promise<{ uninstalled: boolean }> {
    return this.avd.uninstallApk(avdName, pkg);
  }
  captureUiDump(avdName: string): Promise<UiDumpResult> { return this.avd.captureUiDump(avdName); }

  fetchOtp(phone: string, headed = false): Promise<OtpResult> {
    return fetchOtp(phone, { userDataDir: this.playwrightUserDataDir, headed });
  }

  runRecipe(recipePath: string, env: Record<string, string>, screenshotDir: string): Promise<RecipeRunResult> {
    return this.maestro.runRecipe(recipePath, env, screenshotDir);
  }

  // register_test_user and generate_recipes_from_app_summary added in later tasks.
  registerTestUser(_args: {
    avdName: string; phone: string; phoneLocal: string; countryCode: string;
    pin: string; backupCode: string; name: string;
  }): Promise<TestUserRegistrationResult> {
    throw new Error('not implemented yet');
  }
}
```

- [ ] **Step 2: Smoke test compile**

```bash
npx tsc --noEmit
```

Expected: no errors. (May surface latent issues — fix any.)

- [ ] **Step 3: Commit**

```bash
git add mcp/mobile/client.ts
git commit -m "feat(mobile): composite MobileClient with atom-level methods"
```

### Task 5.2: register_test_user composite (TDD with backend mocks)

**Files:**
- Modify: `mcp/mobile/client.ts`
- Create: `test/mcp/mobile/client.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/mcp/mobile/client.test.ts
import { describe, it, expect, vi } from 'vitest';
import { MobileClient } from '../../../mcp/mobile/client.js';

function fakeMaestroAndAvd(opts: {
  registerToOtp: 'pass' | 'fail';
  registerFromOtp: 'pass' | 'fail' | 'already';
  otp: string;
}) {
  const avd = {
    ensureAvdRunning: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
  } as any;
  const runRecipe = vi.fn().mockImplementation(async (recipePath: string) => {
    if (recipePath.endsWith('connect-register-to-otp.yaml')) {
      return { status: opts.registerToOtp, exitCode: opts.registerToOtp === 'pass' ? 0 : 1, screenshots: [], stdout: '', stderr: '', screenshotsDir: '/tmp' };
    }
    if (recipePath.endsWith('connect-register-from-otp.yaml')) {
      if (opts.registerFromOtp === 'already') {
        return { status: 'fail', exitCode: 2, screenshots: [], stdout: 'PHONE_ALREADY_REGISTERED', stderr: '', screenshotsDir: '/tmp' };
      }
      return { status: opts.registerFromOtp, exitCode: opts.registerFromOtp === 'pass' ? 0 : 1, screenshots: [], stdout: '', stderr: '', screenshotsDir: '/tmp' };
    }
    throw new Error(`unexpected recipe: ${recipePath}`);
  });
  const maestro = { runRecipe } as any;
  return { avd, maestro };
}

describe('MobileClient.registerTestUser', () => {
  it('runs to-otp, fetches OTP, runs from-otp, returns success', async () => {
    const { avd, maestro } = fakeMaestroAndAvd({ registerToOtp: 'pass', registerFromOtp: 'pass', otp: '123456' });
    const client = new MobileClient({ avd, maestro, staticRecipesDir: '/static', playwrightUserDataDir: '/ud' });
    (client as any).fetchOtp = vi.fn().mockResolvedValue({ phone: '+74260000001', otp: '123456', fetchedAt: 't' });

    const r = await client.registerTestUser({
      avdName: 'AVD', phone: '+74260000001', phoneLocal: '4260000001', countryCode: '+7',
      pin: '111111', backupCode: '222222', name: 'ACE Test',
    });
    expect(r.alreadyRegistered).toBe(false);
    expect(r.phone).toBe('+74260000001');
  });

  it('detects PHONE_ALREADY_REGISTERED and returns alreadyRegistered=true', async () => {
    const { avd, maestro } = fakeMaestroAndAvd({ registerToOtp: 'pass', registerFromOtp: 'already', otp: '123456' });
    const client = new MobileClient({ avd, maestro, staticRecipesDir: '/static', playwrightUserDataDir: '/ud' });
    (client as any).fetchOtp = vi.fn().mockResolvedValue({ phone: '+74260000001', otp: '123456', fetchedAt: 't' });

    const r = await client.registerTestUser({
      avdName: 'AVD', phone: '+74260000001', phoneLocal: '4260000001', countryCode: '+7',
      pin: '111111', backupCode: '222222', name: 'ACE Test',
    });
    expect(r.alreadyRegistered).toBe(true);
  });
});
```

- [ ] **Step 2: Verify FAIL**

```bash
npx vitest run test/mcp/mobile/client.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// replace registerTestUser in mcp/mobile/client.ts
import * as fs from 'node:fs';
import * as os from 'node:os';

  async registerTestUser(args: {
    avdName: string;
    phone: string;
    phoneLocal: string;
    countryCode: string;
    pin: string;
    backupCode: string;
    name: string;
  }): Promise<TestUserRegistrationResult> {
    await this.avd.ensureAvdRunning(args.avdName);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mobile-reg-'));
    const toOtpRecipe = path.join(this.staticRecipesDir, 'connect-register-to-otp.yaml');
    const fromOtpRecipe = path.join(this.staticRecipesDir, 'connect-register-from-otp.yaml');

    logInfo('register_test_user: part A (to OTP)');
    const partA = await this.maestro.runRecipe(toOtpRecipe, {
      PHONE_LOCAL: args.phoneLocal,
      COUNTRY_CODE: args.countryCode,
      PIN: args.pin,
    }, path.join(tmp, 'to-otp'));
    if (partA.status !== 'pass') {
      // Detect "already registered" early via a sentinel string the recipe writes on duplicate.
      if (partA.stdout.includes('PHONE_ALREADY_REGISTERED')) {
        return { alreadyRegistered: true, phone: args.phone };
      }
      throw new Error(`register_test_user part A failed: ${partA.stderr || partA.stdout}`);
    }

    logInfo('register_test_user: fetching OTP');
    const otpResult = await this.fetchOtp(args.phone);

    logInfo('register_test_user: part B (from OTP)');
    const partB = await this.maestro.runRecipe(fromOtpRecipe, {
      OTP: otpResult.otp,
      NAME: args.name,
      BACKUP_CODE: args.backupCode,
    }, path.join(tmp, 'from-otp'));
    if (partB.status !== 'pass') {
      if (partB.stdout.includes('PHONE_ALREADY_REGISTERED')) {
        return { alreadyRegistered: true, phone: args.phone };
      }
      throw new Error(`register_test_user part B failed: ${partB.stderr || partB.stdout}`);
    }

    return { alreadyRegistered: false, phone: args.phone, backupCode: args.backupCode };
  }
```

- [ ] **Step 4: Verify PASS**

```bash
npx vitest run test/mcp/mobile/client.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add mcp/mobile/client.ts test/mcp/mobile/client.test.ts
git commit -m "feat(mobile): register_test_user composite (Maestro+OTP)"
```

---

## Phase 7 — Static recipes

### Task 6.1: Author the four static Maestro YAMLs against the Connect Android app

**Files:**
- Create: `mcp/mobile/recipes/static/connect-register-to-otp.yaml`
- Create: `mcp/mobile/recipes/static/connect-register-from-otp.yaml`
- Create: `mcp/mobile/recipes/static/connect-login.yaml`
- Create: `mcp/mobile/recipes/static/connect-claim-opp.yaml`

This is a **discovery + authoring** task. Element IDs come from `maestro studio`, an interactive REPL.

- [ ] **Step 1: Boot a clean AVD with Connect mobile installed**

```bash
emulator -avd ACE_Pixel_API_34 -no-window -no-snapshot-save &
adb wait-for-device
adb install -r ~/Downloads/connect-mobile-debug.apk   # path TBD per spec open question 1
```

If the Connect APK is not yet sourced, **stop here** and resolve spec open question 1 (APK source URL). Do not proceed without it.

- [ ] **Step 2: Open `maestro studio` and discover selectors**

```bash
maestro studio
```

A web UI opens at `http://localhost:9999`. Drive the app manually through these flows:

1. **Register flow:** From the splash → Sign up → phone entry → PIN → OTP screen. At each screen, copy the resource-id of every input + button used.
2. **Login flow:** Sign in → phone entry → PIN → home.
3. **Claim opp flow:** Home → opportunities list → opp by name → accept invite → handoff to CommCare.

Record selectors in a scratch file (`mcp/mobile/recipes/static/SELECTORS.md`, gitignored — contains internal app structure).

- [ ] **Step 3: Author `connect-register-to-otp.yaml` (template; replace selectors with discovered IDs)**

```yaml
# mcp/mobile/recipes/static/connect-register-to-otp.yaml
# Drive Connect mobile from splash through to the OTP screen.
# On duplicate-phone, prints "PHONE_ALREADY_REGISTERED" so the composite caller
# can short-circuit. Selectors discovered via `maestro studio` 2026-04-XX.
appId: com.dimagi.connect
---
- launchApp:
    appId: com.dimagi.connect
    clearState: true
- extendedWaitUntil:
    visible:
      id: "REPLACE_signup_button"
    timeout: 30000
- tapOn:
    id: "REPLACE_signup_button"

- extendedWaitUntil:
    visible:
      id: "REPLACE_phone_entry"
    timeout: 10000
- tapOn:
    id: "REPLACE_country_code"
- eraseText: 10
- inputText: ${COUNTRY_CODE}
- tapOn:
    id: "REPLACE_phone_entry"
- inputText: ${PHONE_LOCAL}
- tapOn:
    id: "REPLACE_continue_button"

# If the phone is already registered, Connect shows an error toast — assert
# its presence and emit a sentinel for the composite caller to detect.
- runFlow:
    when:
      visible:
        text: "Phone already registered"
    commands:
      - evalScript: ${output.stdout = 'PHONE_ALREADY_REGISTERED'}
      - stopApp

- extendedWaitUntil:
    visible:
      id: "REPLACE_pin_entry"
    timeout: 10000
- tapOn:
    id: "REPLACE_pin_entry"
- inputText: ${PIN}
- tapOn:
    id: "REPLACE_pin_continue"

- extendedWaitUntil:
    visible:
      id: "REPLACE_otp_entry"
    timeout: 15000
# Recipe stops here. The composite caller (registerTestUser) fetches the OTP
# via Playwright and runs connect-register-from-otp.yaml next.
```

- [ ] **Step 4: Author `connect-register-from-otp.yaml`**

```yaml
# mcp/mobile/recipes/static/connect-register-from-otp.yaml
# Drive Connect mobile from the OTP entry screen through to home.
appId: com.dimagi.connect
---
- assertVisible:
    id: "REPLACE_otp_entry"
- tapOn:
    id: "REPLACE_otp_entry"
- inputText: ${OTP}
- tapOn:
    id: "REPLACE_otp_verify"

- extendedWaitUntil:
    visible:
      id: "REPLACE_name_entry"
    timeout: 15000
- tapOn:
    id: "REPLACE_name_entry"
- inputText: ${NAME}
- tapOn:
    id: "REPLACE_name_continue"

- extendedWaitUntil:
    visible:
      id: "REPLACE_backup_code_entry"
    timeout: 10000
- tapOn:
    id: "REPLACE_backup_code_entry"
- inputText: ${BACKUP_CODE}
- tapOn:
    id: "REPLACE_backup_code_continue"

- extendedWaitUntil:
    visible:
      id: "REPLACE_home_screen_root"
    timeout: 30000
```

- [ ] **Step 5: Author `connect-login.yaml`**

```yaml
# mcp/mobile/recipes/static/connect-login.yaml
appId: com.dimagi.connect
---
- launchApp:
    appId: com.dimagi.connect
    clearState: false
- extendedWaitUntil:
    visible:
      id: "REPLACE_signin_or_home"
    timeout: 30000

- runFlow:
    when:
      visible:
        id: "REPLACE_home_screen_root"
    commands:
      - takeScreenshot: "connect-login-already-signed-in"
      - stopApp

- tapOn:
    id: "REPLACE_signin_button"
- tapOn:
    id: "REPLACE_phone_entry"
- inputText: ${PHONE_LOCAL}
- tapOn:
    id: "REPLACE_continue_button"
- tapOn:
    id: "REPLACE_pin_entry"
- inputText: ${PIN}
- tapOn:
    id: "REPLACE_pin_continue"

- extendedWaitUntil:
    visible:
      id: "REPLACE_home_screen_root"
    timeout: 30000
- takeScreenshot: "connect-login-home"
```

- [ ] **Step 6: Author `connect-claim-opp.yaml`**

```yaml
# mcp/mobile/recipes/static/connect-claim-opp.yaml
# Assumes Connect mobile is already signed in and at the home screen.
appId: com.dimagi.connect
---
- assertVisible:
    id: "REPLACE_home_screen_root"
- tapOn:
    id: "REPLACE_opportunities_tab"
- extendedWaitUntil:
    visible:
      text: ${OPP_NAME}
    timeout: 15000
- takeScreenshot: "claim-opp-list"
- tapOn:
    text: ${OPP_NAME}
- extendedWaitUntil:
    visible:
      id: "REPLACE_accept_invite_button"
    timeout: 10000
- takeScreenshot: "claim-opp-detail"
- tapOn:
    id: "REPLACE_accept_invite_button"
- extendedWaitUntil:
    visible:
      id: "REPLACE_commcare_handoff_or_learn_root"
    timeout: 30000
- takeScreenshot: "claim-opp-handoff"
```

- [ ] **Step 7: Replace every `REPLACE_` placeholder with real IDs from your `SELECTORS.md`, then validate every recipe**

```bash
for f in mcp/mobile/recipes/static/*.yaml; do
  npx tsx -e "
    import { MaestroBackend } from './mcp/mobile/backends/maestro.ts';
    new MaestroBackend().validateRecipe('$f').then(() => console.log('$f OK')).catch(e => { console.error('$f', e.message); process.exit(1); });
  "
done
```

Expected: all four print `OK`.

- [ ] **Step 8: Commit**

```bash
git add mcp/mobile/recipes/static/
git commit -m "feat(mobile): four static Maestro recipes (register, login, claim-opp)"
```

---

## Phase 8 — Recipe generator

### Task 7.1: LLM-driven recipe generator (TDD with mock LLM)

**Files:**
- Create: `mcp/mobile/backends/recipe-generator.ts`
- Test: `test/mcp/mobile/recipe-generator.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/mcp/mobile/recipe-generator.test.ts
import { describe, it, expect, vi } from 'vitest';
import { RecipeGenerator, type LlmFn } from '../../../mcp/mobile/backends/recipe-generator.js';

const APP_SUMMARY = `
## Module 1 — Pre-test

### Form 1.1: Identification
- Q1: First name (text)
- Q2: Last name (text)
- Q3: Age (integer)
`;

const MOCK_YAML = `appId: org.commcare.dalvik
---
- launchApp: { clearState: false }
- assertVisible: { id: "home_screen_root" }
- tapOn: "Module 1 — Pre-test"
- takeScreenshot: "module-1-landing"
- tapOn: "Form 1.1: Identification"
- takeScreenshot: "form-1-1-q1-first-name"
- inputText: "Test"
- tapOn: { id: "form_next" }
- takeScreenshot: "form-1-1-q2-last-name"
- inputText: "Worker"
- tapOn: { id: "form_next" }
- takeScreenshot: "form-1-1-q3-age"
- inputText: "30"
- tapOn: { id: "form_finish" }
- assertVisible: "Module 1 complete"
`;

describe('RecipeGenerator.generateForModule', () => {
  it('calls the LLM with the summary + module name and returns validated YAML', async () => {
    const llm: LlmFn = vi.fn().mockResolvedValue(MOCK_YAML);
    const gen = new RecipeGenerator({ llm });
    const yaml = await gen.generateForModule({
      summary: APP_SUMMARY,
      moduleName: 'Module 1 — Pre-test',
      appKind: 'learn',
    });
    expect(yaml).toContain('appId: org.commcare.dalvik');
    expect(yaml).toContain('takeScreenshot');
    expect(llm).toHaveBeenCalledOnce();
  });

  it('rejects YAML with steps not in the allowed Maestro vocabulary', async () => {
    const badYaml = MOCK_YAML.replace('takeScreenshot', 'bogusStep');
    const llm: LlmFn = vi.fn().mockResolvedValue(badYaml);
    const gen = new RecipeGenerator({ llm });
    await expect(
      gen.generateForModule({ summary: APP_SUMMARY, moduleName: 'Module 1 — Pre-test', appKind: 'learn' }),
    ).rejects.toThrow(/RECIPE_INVALID|unknown/i);
  });
});

describe('RecipeGenerator.parseSummary', () => {
  it('extracts module names from app summary markdown', () => {
    const gen = new RecipeGenerator({ llm: vi.fn() });
    const modules = gen.parseSummary(APP_SUMMARY);
    expect(modules).toEqual(['Module 1 — Pre-test']);
  });

  it('handles multiple modules', () => {
    const summary = `## Module 1 — A\n\n## Module 2 — B\n\n## Module 3 — C\n`;
    const gen = new RecipeGenerator({ llm: vi.fn() });
    expect(gen.parseSummary(summary)).toEqual(['Module 1 — A', 'Module 2 — B', 'Module 3 — C']);
  });
});
```

- [ ] **Step 2: Verify FAIL**

```bash
npx vitest run test/mcp/mobile/recipe-generator.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// mcp/mobile/backends/recipe-generator.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MaestroBackend } from './maestro.js';
import type { ShellFn } from './avd.js';

export type LlmFn = (system: string, user: string) => Promise<string>;

export interface RecipeGeneratorOpts {
  llm: LlmFn;
  maestro?: MaestroBackend;
  shell?: ShellFn;
}

const SYSTEM_PROMPT = `You generate Maestro mobile-test YAML for the CommCare Android app
(appId: org.commcare.dalvik). Use only these step types:

- launchApp
- tapOn (with id, text, or a string)
- inputText
- takeScreenshot (always pair with a kebab-case step name)
- assertVisible
- assertNotVisible
- extendedWaitUntil
- waitForAnimationToEnd
- eraseText
- swipe
- pressKey
- back
- scroll
- hideKeyboard

For every form question in the module, emit:
  - tapOn (the question's input field, by id or text)
  - takeScreenshot (named like "form-N-M-qK-<short-slug>")
  - inputText (a plausible answer matching the question type)
  - tapOn next/finish button

End every module recipe with assertVisible of an end-state element.
Output the YAML and nothing else. No code fences, no commentary.`;

export class RecipeGenerator {
  private llm: LlmFn;
  private maestro: MaestroBackend;

  constructor(opts: RecipeGeneratorOpts) {
    this.llm = opts.llm;
    this.maestro = opts.maestro ?? new MaestroBackend({ shell: opts.shell });
  }

  parseSummary(summary: string): string[] {
    const out: string[] = [];
    for (const line of summary.split('\n')) {
      const m = line.match(/^##\s+(.+?)\s*$/);
      if (m) out.push(m[1].trim());
    }
    return out;
  }

  async generateForModule(args: {
    summary: string;
    moduleName: string;
    appKind: 'learn' | 'deliver';
  }): Promise<string> {
    const userPrompt = `App kind: ${args.appKind}\n\nModule to walk through: ${args.moduleName}\n\nFull app summary:\n${args.summary}`;
    const yaml = await this.llm(SYSTEM_PROMPT, userPrompt);

    // Validate by writing to a temp file and running validateRecipe.
    const tmp = path.join(os.tmpdir(), `mob-gen-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
    fs.writeFileSync(tmp, yaml);
    try {
      await this.maestro.validateRecipe(tmp);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
    return yaml;
  }
}
```

- [ ] **Step 4: Verify PASS**

```bash
npx vitest run test/mcp/mobile/recipe-generator.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add mcp/mobile/backends/recipe-generator.ts test/mcp/mobile/recipe-generator.test.ts
git commit -m "feat(mobile): LLM-driven recipe generator with vocabulary validation"
```

### Task 7.2: Wire generateRecipesFromAppSummary into MobileClient

**Files:**
- Modify: `mcp/mobile/client.ts`

This method reads from Drive (via the existing google-drive MCP tooling), generates per-module recipes, and writes them back to Drive. To avoid coupling the mobile client to Drive at the type level, this method takes a `driveClient` adapter as an arg.

- [ ] **Step 1: Add the method to MobileClient**

```typescript
// add to mcp/mobile/client.ts
import { RecipeGenerator, type LlmFn } from './backends/recipe-generator.js';

export interface DriveAdapter {
  readFile(driveId: string, filePath: string): Promise<string>;
  writeFile(driveId: string, filePath: string, content: string): Promise<void>;
  listFolder(driveId: string, folderPath: string): Promise<string[]>;
}

  async generateRecipesFromAppSummary(args: {
    oppName: string;
    appKind: 'learn' | 'deliver';
    drive: DriveAdapter;
    driveRootId: string;
    llm: LlmFn;
  }): Promise<{ recipePaths: string[]; manifestPath: string }> {
    const summaryPath = `ACE/${args.oppName}/app-summaries/${args.appKind}-app-summary.md`;
    const summary = await args.drive.readFile(args.driveRootId, summaryPath);

    const generator = new RecipeGenerator({ llm: args.llm });
    const moduleNames = generator.parseSummary(summary);

    const recipePaths: string[] = [];
    const manifestEntries: { module: string; path: string }[] = [];
    for (let i = 0; i < moduleNames.length; i++) {
      const moduleName = moduleNames[i];
      const yaml = await generator.generateForModule({ summary, moduleName, appKind: args.appKind });
      const recipePath = `ACE/${args.oppName}/mobile-recipes/${args.appKind}/module-${i + 1}.yaml`;
      await args.drive.writeFile(args.driveRootId, recipePath, yaml);
      recipePaths.push(recipePath);
      manifestEntries.push({ module: moduleName, path: recipePath });
    }

    const manifestPath = `ACE/${args.oppName}/mobile-recipes/${args.appKind}/manifest.yaml`;
    const manifestYaml =
      `# auto-generated by ace-mobile recipe-generator\n` +
      `app_kind: ${args.appKind}\n` +
      `generated_at: ${new Date().toISOString()}\n` +
      `recipes:\n` +
      manifestEntries.map((e) => `  - module: "${e.module.replace(/"/g, '\\"')}"\n    path: ${e.path}`).join('\n') +
      `\n`;
    await args.drive.writeFile(args.driveRootId, manifestPath, manifestYaml);

    return { recipePaths, manifestPath };
  }
```

- [ ] **Step 2: Verify compile**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add mcp/mobile/client.ts
git commit -m "feat(mobile): generateRecipesFromAppSummary writes per-module YAMLs to Drive"
```

---

## Phase 9 — MCP server wiring

### Task 8.1: Create mobile-server.ts

**Files:**
- Create: `mcp/mobile-server.ts`

- [ ] **Step 1: Implement (mirroring mcp/ocs-server.ts)**

```typescript
// mcp/mobile-server.ts
/**
 * ACE Mobile MCP Server
 *
 * Exposes 10 atomic mobile capabilities backed by Maestro + adb + Playwright.
 * See docs/superpowers/specs/2026-04-28-ace-mobile-emulation-design.md
 */

import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
import { resolvePluginDataDir, logPluginDataDirDiag } from '../lib/plugin-data-dir.js';
logPluginDataDirDiag('ace-mobile', import.meta.url);
const __pluginDataDir = resolvePluginDataDir(import.meta.url);
dotenvConfig({
  path: __pluginDataDir
    ? path.join(__pluginDataDir, '.env')
    : path.join(process.cwd(), '.env'),
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { MobileClient } from './mobile/client.js';
import { logInfo, logError } from './mobile/logging.js';

const client = new MobileClient();

const server = new McpServer({ name: 'ace-mobile', version: '0.9.0' });

server.tool(
  'mobile_ensure_avd_running',
  { avdName: z.string().default(process.env.ACE_AVD_NAME ?? 'ACE_Pixel_API_34') },
  async ({ avdName }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.ensureAvdRunning(avdName), null, 2) }],
  }),
);

server.tool(
  'mobile_stop_avd',
  { avdName: z.string() },
  async ({ avdName }) => {
    await client.stopAvd(avdName);
    return { content: [{ type: 'text', text: `stopped ${avdName}` }] };
  },
);

server.tool(
  'mobile_list_avds',
  {},
  async () => ({ content: [{ type: 'text', text: JSON.stringify(await client.listAvds(), null, 2) }] }),
);

server.tool(
  'mobile_install_apk',
  { avdName: z.string(), apkPath: z.string() },
  async ({ avdName, apkPath }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.installApk(avdName, apkPath), null, 2) }],
  }),
);

server.tool(
  'mobile_uninstall_apk',
  { avdName: z.string(), packageId: z.string() },
  async ({ avdName, packageId }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.uninstallApk(avdName, packageId), null, 2) }],
  }),
);

server.tool(
  'mobile_register_test_user',
  {
    avdName: z.string(),
    phone: z.string(),
    phoneLocal: z.string(),
    countryCode: z.string(),
    pin: z.string(),
    backupCode: z.string(),
    name: z.string().default('ACE Test'),
  },
  async (args) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.registerTestUser(args), null, 2) }],
  }),
);

server.tool(
  'mobile_fetch_otp',
  { phone: z.string(), headed: z.boolean().default(false) },
  async ({ phone, headed }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.fetchOtp(phone, headed), null, 2) }],
  }),
);

server.tool(
  'mobile_run_recipe',
  {
    recipePath: z.string(),
    envVars: z.record(z.string()).default({}),
    screenshotDir: z.string(),
  },
  async ({ recipePath, envVars, screenshotDir }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.runRecipe(recipePath, envVars, screenshotDir), null, 2) }],
  }),
);

// generate_recipes_from_app_summary is intentionally NOT exposed as an MCP tool —
// it requires a DriveAdapter + LlmFn that ACE skills inject directly. Skills call
// MobileClient programmatically when they need it.

server.tool(
  'mobile_capture_ui_dump',
  { avdName: z.string() },
  async ({ avdName }) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.captureUiDump(avdName), null, 2) }],
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo('ace-mobile MCP server listening on stdio');
}

main().catch((e) => {
  logError('fatal', e);
  process.exit(1);
});
```

- [ ] **Step 2: Smoke run**

```bash
npx tsx mcp/mobile-server.ts &
SRV=$!
sleep 1
kill $SRV
```

Expected: stderr shows `ace-mobile MCP server listening on stdio` and exits cleanly when killed.

- [ ] **Step 3: Add npm script**

```bash
# in package.json scripts:
#   "mcp:mobile": "npx tsx mcp/mobile-server.ts"
```

Edit `package.json` to add the script.

- [ ] **Step 4: Register in plugin.json**

Read `.claude-plugin/plugin.json`, locate the `mcpServers` block, add:

```json
"ace-mobile": {
  "command": "npx",
  "args": ["tsx", "${CLAUDE_PLUGIN_ROOT}/mcp/mobile-server.ts"]
}
```

- [ ] **Step 5: Commit**

```bash
git add mcp/mobile-server.ts package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "feat(mobile): MCP server with 9 atomic tools"
```

---

## Phase 9 — `/ace:mobile-bootstrap` slash command

### Task 9.1: Author the slash command

**Files:**
- Create: `commands/mobile-bootstrap.md`

- [ ] **Step 1: Author the command**

```markdown
---
name: mobile-bootstrap
description: One-time per-machine setup for ACE mobile emulation (Maestro, AVD, Playwright cookies, ACE test user).
---

# `/ace:mobile-bootstrap`

Run this **once per workstation** before the `training-prep` phase can capture screenshots.

This command is idempotent — re-run any time you suspect drift.

## Steps the agent should execute, in order

1. **Check Maestro is installed.**
   - Run: `which maestro && maestro --version`
   - If missing: tell the user to run `curl -Ls "https://get.maestro.mobile.dev" | bash` and stop.

2. **Check `adb` is on PATH.**
   - Run: `which adb && adb version`
   - If missing: tell the user to run `brew install android-platform-tools` and stop.

3. **Confirm `${ACE_AVD_NAME}` (default `ACE_Pixel_API_34`) exists.**
   - Run: `emulator -list-avds`
   - If not present: print this guidance and stop —
     ```
     Create the AVD via Android Studio's AVD Manager:
       Device: Pixel 7
       System Image: API 34, ARM64 (or x86_64 if Intel Mac)
       Name: ACE_Pixel_API_34
     ```

4. **Boot the AVD using `mobile_ensure_avd_running`.**
   - Tool: `mcp__ace_mobile__mobile_ensure_avd_running`
   - Args: `{ "avdName": "${ACE_AVD_NAME}" }`

5. **Check Connect mobile + CommCare Android APKs are installed on the AVD.**
   - Run: `adb shell pm list packages com.dimagi.connect`
   - Run: `adb shell pm list packages org.commcare.dalvik`
   - If either is missing, prompt the user for an APK path (or HQ download URL) and call `mobile_install_apk` for each.

6. **Verify Playwright cookies for connect.dimagi.com.**
   - Check `${HOME}/.ace/playwright-userdata/` exists and contains a `Cookies` file.
   - If not: walk the user through the headed-login one-liner:
     ```
     ACE_PLAYWRIGHT_USER_DATA_DIR=~/.ace/playwright-userdata \
       PHASE9_HEADED=1 \
       npx tsx -e 'import { fetchOtp } from "ACE_PLUGIN_ROOT/mcp/mobile/auth/fetch-otp.ts"; fetchOtp("+74260000042", { userDataDir: process.env.ACE_PLAYWRIGHT_USER_DATA_DIR, headed: true });'
     ```
     The user signs in to Dimagi SSO; cookies persist.

7. **Verify all `ACE_E2E_*` env vars are populated.**
   - Read each from `process.env`. Any missing → tell the user to update 1Password and re-run `op inject -i .env.tpl -o .env`, then stop.

8. **Register the ACE test user (if not already).**
   - Tool: `mcp__ace_mobile__mobile_register_test_user`
   - Args: `{ "avdName": "${ACE_AVD_NAME}", "phone": "${ACE_E2E_PHONE}", "phoneLocal": "${ACE_E2E_PHONE_LOCAL}", "countryCode": "${ACE_E2E_COUNTRY_CODE}", "pin": "${ACE_E2E_PIN}", "backupCode": "${ACE_E2E_BACKUP_CODE}", "name": "${ACE_E2E_NAME}" }`
   - If `alreadyRegistered: true`, fine.

9. **Print success summary.**
   - Echo: AVD name, test-user phone, Playwright user-data dir, all ACE_E2E_* var presence.
```

- [ ] **Step 2: Commit**

```bash
git add commands/mobile-bootstrap.md
git commit -m "feat(mobile): /ace:mobile-bootstrap one-time setup command"
```

---

## Phase 10 — `app-screenshot-capture` skill

### Task 10.1: Author the skill

**Files:**
- Create: `skills/app-screenshot-capture/SKILL.md`

- [ ] **Step 1: Author**

```markdown
---
name: app-screenshot-capture
description: >
  Drive the Connect mobile and CommCare Android apps through scripted Maestro
  flows on a local AVD and capture one PNG per recipe step into Drive. First
  step of Phase 5 (training-prep). Produces ACE/<opp>/screenshots/ + manifest.yaml.
---

# App Screenshot Capture

Run scripted Maestro flows against a local AVD, capture PNGs at every step, and upload them to Drive.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/pdd.md` | archetype branching only |
| Phase 2 | `ACE/<opp>/app-summaries/learn-app-summary.md` | recipe generation |
| Phase 2 | `ACE/<opp>/app-summaries/deliver-app-summary.md` | recipe generation |
| Phase 2 | `ACE/<opp>/deployment-summary.md` | HQ domain for `${HQ_DOMAIN}` env var |
| Phase 3 | `ACE/<opp>/connect-state.yaml` | `opportunity_name` + `ace_test_user_invite_url` |

## Process

1. **Read upstream artifacts** from Drive. If any are missing, exit with a structured error pointing at the upstream phase.

2. **Generate per-module recipes**:
   - Call `MobileClient.generateRecipesFromAppSummary` for Learn (`'learn'`) and Deliver (`'deliver'`).
   - Output: `ACE/<opp>/mobile-recipes/{learn,deliver}/module-N.yaml` + `manifest.yaml`.

3. **Boot AVD + ensure apps installed** via `mobile_ensure_avd_running` and `mobile_install_apk` (no-op if cached).

4. **Run static recipes**:
   - `connect-login.yaml` with `${ACE_E2E_PHONE_LOCAL}`, `${ACE_E2E_PIN}`.
   - `connect-claim-opp.yaml` with `${OPP_NAME}` from `connect-state.yaml`.

5. **Run generated recipes**, in order:
   - For each `module-N.yaml` under `mobile-recipes/learn/`, then `mobile-recipes/deliver/`.
   - Each `mobile_run_recipe` returns a list of screenshots; upload each to `ACE/<opp>/screenshots/<recipe-stem>/<step-name>.png`.

6. **Write `ACE/<opp>/screenshots/manifest.yaml`** listing every recipe, every step name, every Drive path, every step label (the `takeScreenshot:` argument).

7. **Self-evaluate (LLM-as-Judge):**
   - Did every recipe complete (status: pass)?
   - Are screenshots of expected count produced (≥ 1 per `takeScreenshot` step)?
   - Are all screenshots non-zero bytes?

8. **Write verdict** to `verdicts/app-screenshot-capture.yaml` with status pass/fail and per-recipe breakdown so `opp-eval` can aggregate.

## MCP Tools Used

- `ace-gdrive`: `drive_read_file`, `drive_create_file`, `drive_list_folder`.
- `ace-mobile`: `mobile_ensure_avd_running`, `mobile_install_apk`, `mobile_run_recipe`. (`generate_recipes_from_app_summary` is invoked programmatically inside the skill, not as an MCP tool.)

## Mode Behavior

- **Auto:** Run end-to-end, write artifacts, proceed.
- **Review:** Pause after generating recipes for human inspection of `mobile-recipes/`; resume on approval.

## Dry-Run Behavior

- Generate recipes and write to Drive normally.
- Skip AVD boot and `mobile_run_recipe` calls.
- Write empty manifest with `dry_run: true` flag.
- State tracks as `dry-run-success`.

## LLM-as-Judge Rubric

| Dimension | Pass criteria |
|---|---|
| Coverage | every Learn module + every Deliver form has a generated recipe |
| Execution | every recipe status: pass |
| Artifact quality | every screenshot is a valid PNG with non-zero bytes |
| Manifest integrity | manifest.yaml lists every screenshot path actually present in Drive |

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-04-28 | Initial version (mobile-emulation work) | ACE team |
```

- [ ] **Step 2: Commit**

```bash
git add skills/app-screenshot-capture/SKILL.md
git commit -m "feat(skill): app-screenshot-capture for training-prep phase"
```

---

## Phase 11 — `training-prep` phase agent + renumbering

### Task 11.1: Author the new phase agent

**Files:**
- Create: `agents/training-prep/AGENT.md`

- [ ] **Step 1: Look at an existing subagent for format**

```bash
ls agents/
cat agents/connect-setup/AGENT.md | head -40
```

(Use whichever subagent file exists as the format template — adopt its frontmatter shape exactly.)

- [ ] **Step 2: Author `agents/training-prep/AGENT.md`**

```markdown
---
name: training-prep
description: >
  Phase 5 of the CRISPR-Connect lifecycle: generate per-opp training material
  artifacts (screenshots + guides) without LLO contact. Runs after ocs-setup
  (Phase 4) and before llo-manager (Phase 7).
---

# Phase 5 — Training Prep

This phase synthesizes everything Phases 1–4 produced into training material
that Phase 7 (`llo-manager`) hands to LLOs and FLWs. **No LLO contact happens
here.**

## Upstream artifacts read

See `skills/app-screenshot-capture/SKILL.md` § Inputs and `skills/training-materials/SKILL.md` § Inputs.

## Steps

1. **`app-screenshot-capture`** — drive Connect mobile + CommCare Android on a local AVD, capture PNGs per recipe step, write `ACE/<opp>/screenshots/` and `manifest.yaml`.

2. **`training-materials`** — read every upstream artifact + the new screenshots manifest, write `ACE/<opp>/training-materials/{llo-manager-guide,flw-training-guide,quick-reference,faq}.md`.

If either skill returns a non-pass verdict, halt — Phase 7 must not start.

## Outputs

- `ACE/<opp>/mobile-recipes/{learn,deliver}/module-N.yaml` + `manifest.yaml`
- `ACE/<opp>/screenshots/<recipe>/<step>.png` + `manifest.yaml`
- `ACE/<opp>/training-materials/{llo-manager-guide,flw-training-guide,quick-reference,faq}.md`
- `verdicts/app-screenshot-capture.yaml`
- `verdicts/training-materials.yaml`

## Topology note

This is a subagent (no nested `Agent` dispatches). It runs the two child skills inline using their respective MCP tools. Dispatched from level 0 by `ace-orchestrator`.
```

- [ ] **Step 3: Commit**

```bash
git add agents/training-prep/AGENT.md
git commit -m "feat(agent): training-prep phase agent (new Phase 5)"
```

### Task 11.2: Renumber phases in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Read the existing topology table**

```bash
grep -n "Phase\|phase" CLAUDE.md | head -30
```

Locate the phase-topology table (under `## Agent topology`) and the prose mention of phases under `## Current state` (specifically the line "Orchestration restructured into 6 phases").

- [ ] **Step 2: Update the topology table**

Replace the phase rows in the topology table with:

```markdown
| `ace-orchestrator` | yes (dispatches phases + Nova) | procedure doc | `/ace:run` reads it and executes inline |
| `commcare-setup` (Phase 2) | yes — `/nova:autobuild` is a hidden Agent dispatch | procedure doc | orchestrator reads it and executes inline |
| `design-review` (Phase 1) | no | subagent | `Agent(design-review)` from level 0 |
| `connect-setup` (Phase 3) | no | subagent | `Agent(connect-setup)` from level 0 |
| `ocs-setup` (Phase 4) | no | subagent | `Agent(ocs-setup)` from level 0 |
| `training-prep` (Phase 5) | no | subagent | `Agent(training-prep)` from level 0 |
| `llo-manager` (Phase 7) | no | subagent | `Agent(llo-manager)` from level 0 |
| `closeout` (Phase 8) | no | subagent | `Agent(closeout)` from level 0 |
| `ocs-tester` | no — leaf qa+eval pair | subagent | `Agent(ocs-tester)` ad-hoc |
```

- [ ] **Step 3: Update the "Current state" prose**

Replace `**Orchestration restructured into 6 phases (0.2.0).**` with `**Orchestration runs 7 phases as of 0.9.0.**` and update the listed order to:

```
(1) design-review → (2) commcare-setup → (3) connect-setup → (4) ocs-setup → (5) training-prep → (6) llo-manager → (7) closeout.
```

Append: `Phase 5 training-prep (added 0.9.0) owns the relocated training-materials skill plus the new app-screenshot-capture skill, restoring the "Phases 1-N agent-only" invariant — Phase 7 is now the first LLO contact.`

- [ ] **Step 4: Verify the layout section**

In the `## Layout` section, the agents/ bullet says "8 agents total" — change to "9 agents total" and add `training-prep` to the subagent list.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: renumber phases for new training-prep Phase 5"
```

### Task 11.3: Update the orchestrator procedure doc

**Files:**
- Modify: `agents/ace-orchestrator/AGENT.md` (path may differ — search for it)

- [ ] **Step 1: Find the orchestrator file**

```bash
find agents -name '*.md' -exec grep -l "design-review\|connect-setup\|llo-manager" {} \;
```

- [ ] **Step 2: Insert the training-prep dispatch between Phase 4 and current Phase 5**

Add a new section in the orchestrator's procedure list:

```markdown
### Phase 5: Training prep

Dispatch `Agent(training-prep)` with the opp name. The agent runs:
1. `app-screenshot-capture`
2. `training-materials`

If either child skill emits a non-pass verdict, halt; do not dispatch Phase 7.
```

Renumber the existing "Phase 5: LLO management" → "Phase 7: LLO management" and "Phase 7: Closeout" → "Phase 8: Closeout".

- [ ] **Step 3: Commit**

```bash
git add agents/ace-orchestrator/AGENT.md
git commit -m "feat(orchestrator): dispatch training-prep as new Phase 5"
```

### Task 11.4: Remove `training-materials` from `llo-manager` agent

**Files:**
- Modify: `agents/llo-manager/AGENT.md`

- [ ] **Step 1: Locate the training-materials reference**

```bash
grep -n "training-materials" agents/llo-manager/AGENT.md
```

- [ ] **Step 2: Remove the step**

Delete the step that invokes `training-materials`. Add a one-line note:

```markdown
> **Phase 7 note:** training materials are now produced upstream in Phase 5 (`training-prep`). This phase consumes them but does not generate them.
```

- [ ] **Step 3: Commit**

```bash
git add agents/llo-manager/AGENT.md
git commit -m "feat(llo-manager): remove training-materials step (moved to Phase 5)"
```

### Task 11.5: Update `/ace:status`, `/ace:eval`, `/ace:run`, `/ace:step`

**Files:**
- Modify: `commands/run.md`, `commands/step.md`, `commands/status.md`, `commands/eval.md`

- [ ] **Step 1: Locate phase-name references**

```bash
grep -n "Phase\|phase 5\|phase 6\|llo-manager\|closeout" commands/*.md
```

- [ ] **Step 2: Insert `training-prep` and renumber**

For each command, find the phase listing/enumeration and update:
- Add `training-prep` as Phase 5
- Renumber `llo-manager` to Phase 7
- Renumber `closeout` to Phase 8

- [ ] **Step 3: Commit**

```bash
git add commands/run.md commands/step.md commands/status.md commands/eval.md
git commit -m "chore(commands): renumber phases for training-prep insertion"
```

---

## Phase 12 — Update `training-materials` skill

### Task 12.1: Teach training-materials to consume new upstream artifacts

**Files:**
- Modify: `skills/training-materials/SKILL.md`

- [ ] **Step 1: Read current SKILL.md**

```bash
cat skills/training-materials/SKILL.md
```

- [ ] **Step 2: Update the skill's input section**

Replace the existing inputs list with:

```markdown
## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/pdd.md` | overall framing, opp goals, archetype |
| Phase 1 | `ACE/<opp>/test-prompts.md` | seed FAQ entries |
| Phase 2 | `ACE/<opp>/app-summaries/learn-app-summary.md` | content + form names in FLW guide |
| Phase 2 | `ACE/<opp>/app-summaries/deliver-app-summary.md` | content + form names in FLW guide |
| Phase 2 | `ACE/<opp>/deployment-summary.md` | HQ domain quoted in LLO Manager Guide |
| Phase 3 | `ACE/<opp>/connect-state.yaml` (`opportunity_name`, `payment_units`, `delivery_types`) | payment + verification details in LLO Manager Guide |
| Phase 4 | `ACE/<opp>/ocs-state.yaml` (`chatbot_widget_url`) | "where to ask questions" link in FLW Training Guide and Quick Reference |
| Phase 5 (this phase, prior step) | `ACE/<opp>/screenshots/manifest.yaml` + the PNGs it points to | embed step-by-step screenshots in FLW Training Guide |
```

- [ ] **Step 3: Update the process section**

Add a step explicitly covering the new screenshot integration:

```markdown
3. **Embed step-by-step screenshots** in `flw-training-guide.md`. For each entry in `screenshots/manifest.yaml`, render the screenshot inline with its step label and a 1–2 sentence caption derived from the recipe step name + the corresponding form question / module heading.
```

- [ ] **Step 4: Append a change log entry**

```markdown
| 2026-04-28 | Move skill from Phase 5 (llo-manager) to Phase 5 (training-prep). Add upstream-input contract: read connect-state.yaml, ocs-state.yaml, screenshots/manifest.yaml. Embed real screenshots in flw-training-guide. | ACE team (mobile-emulation) |
```

- [ ] **Step 5: Commit**

```bash
git add skills/training-materials/SKILL.md
git commit -m "feat(training-materials): consume connect-state, ocs-state, screenshots/"
```

### Task 12.2: Register new artifacts in lib/artifact-manifest.ts

**Files:**
- Modify: `lib/artifact-manifest.ts`

- [ ] **Step 1: Read current manifest**

```bash
grep -n "training-materials\|screenshots\|mobile-recipes" lib/artifact-manifest.ts
```

- [ ] **Step 2: Add entries**

Append new artifact records (mirror the existing entry shape):
- `mobile-recipes/learn/manifest.yaml` — produced by `app-screenshot-capture`, consumed by `app-screenshot-capture` (self-only for v1)
- `mobile-recipes/deliver/manifest.yaml` — same
- `screenshots/manifest.yaml` — produced by `app-screenshot-capture`, consumed by `training-materials`
- `screenshots/<recipe>/<step>.png` (glob pattern) — produced by `app-screenshot-capture`, consumed by `training-materials`

- [ ] **Step 3: Run fixture validation tests**

```bash
npx vitest run test/fixtures/artifact-manifest.test.ts
```

Expected: PASS (existing tests don't assert on new artifacts; new ones use the registered shapes).

- [ ] **Step 4: Commit**

```bash
git add lib/artifact-manifest.ts
git commit -m "feat(artifacts): register mobile-recipes/ and screenshots/ artifacts"
```

---

## Phase 13 — `connect-setup` ACE-test-user invite step

### Task 13.1: Add invite step to connect-opp-setup skill

**Files:**
- Modify: `skills/connect-opp-setup/SKILL.md`

- [ ] **Step 1: Locate where the opp-creation flow ends**

```bash
grep -n "send_llo_invite\|connect-state.yaml\|## Process" skills/connect-opp-setup/SKILL.md
```

- [ ] **Step 2: Append a new final step**

```markdown
N. **Invite the ACE test user.**

   - Tool: `mcp__connect_labs__connect_send_llo_invite` (or whichever MCP tool the connect-setup phase already uses for LLO invites).
   - Recipient: `${ACE_E2E_PHONE}`.
   - Persist the resulting invite URL to `ACE/<opp>/connect-state.yaml` under `ace_test_user_invite_url`.
   - Mark the invitee internally with `is_ace_test_user: true` so analytics filters can exclude it later.

   **Why:** Phase 5's `app-screenshot-capture` skill drives Connect mobile through the claim-opp flow as this user. Without the invite, the opp won't appear in the mobile app's opportunity list for the test user.
```

- [ ] **Step 3: Commit**

```bash
git add skills/connect-opp-setup/SKILL.md
git commit -m "feat(connect-setup): invite ACE test user, persist invite URL"
```

---

## Phase 14 — `.env.tpl`, `/ace:setup`, `/ace:doctor` updates

### Task 14.1: Extend `.env.tpl`

**Files:**
- Modify: `.env.tpl`

- [ ] **Step 1: Read current .env.tpl**

```bash
cat .env.tpl
```

- [ ] **Step 2: Append a "Mobile emulation" block**

```bash
cat >> .env.tpl <<'EOF'

# ─── ACE Mobile Emulation ──────────────────────────────────────────
# Local-Mac-only. Populated once via /ace:mobile-bootstrap.
ACE_E2E_PHONE=op://ace/connect-test-user/phone
ACE_E2E_PHONE_LOCAL=op://ace/connect-test-user/phone-local
ACE_E2E_COUNTRY_CODE=op://ace/connect-test-user/country-code
ACE_E2E_PIN=op://ace/connect-test-user/pin
ACE_E2E_BACKUP_CODE=op://ace/connect-test-user/backup-code
ACE_E2E_NAME="ACE Test"
ACE_AVD_NAME=ACE_Pixel_API_34
EOF
```

- [ ] **Step 3: Commit**

```bash
git add .env.tpl
git commit -m "feat(env): ACE_E2E_* + ACE_AVD_NAME for mobile emulation"
```

### Task 14.2: Extend `/ace:setup`

**Files:**
- Modify: `commands/setup.md`

- [ ] **Step 1: Locate the setup command**

```bash
cat commands/setup.md
```

- [ ] **Step 2: Add a "Mobile (optional)" section**

After the existing setup steps, append:

```markdown
## Mobile emulation (optional, Mac only)

If you plan to use Phase 5 `training-prep` end-to-end (screenshot capture + training docs):

1. Install Maestro: `curl -Ls "https://get.maestro.mobile.dev" | bash`
2. Install `adb`: `brew install android-platform-tools`
3. Create the AVD `ACE_Pixel_API_34` via Android Studio.
4. Run `/ace:mobile-bootstrap` to register the ACE test user and seed Playwright cookies.

If you skip this, Phase 5 will fail; Phases 1–4 still work without mobile.
```

- [ ] **Step 3: Commit**

```bash
git add commands/setup.md
git commit -m "feat(setup): mobile emulation setup hints"
```

### Task 14.3: Extend `/ace:doctor`

**Files:**
- Modify: `bin/ace-doctor`

- [ ] **Step 1: Locate the doctor script**

```bash
head -50 bin/ace-doctor
```

- [ ] **Step 2: Append a "Mobile" section**

Add after the existing checks (use the same shell-driven check style as the OCS section):

```bash
echo ""
echo "[Mobile]"

if command -v maestro >/dev/null 2>&1; then
  echo "  Maestro:                $(which maestro)    $(maestro --version 2>/dev/null | head -1)    OK"
else
  echo "  Maestro:                MISSING — install with curl -Ls 'https://get.maestro.mobile.dev' | bash"
fi

if command -v adb >/dev/null 2>&1; then
  echo "  adb:                    $(which adb)    $(adb version | head -1)    OK"
else
  echo "  adb:                    MISSING — install with brew install android-platform-tools"
fi

AVD_NAME="${ACE_AVD_NAME:-ACE_Pixel_API_34}"
if command -v emulator >/dev/null 2>&1 && emulator -list-avds 2>/dev/null | grep -q "^${AVD_NAME}$"; then
  if adb devices 2>/dev/null | grep -q "^emulator-"; then
    echo "  AVD:                    ${AVD_NAME}    booted    OK"
  else
    echo "  AVD:                    ${AVD_NAME}    not booted    INFO"
  fi
else
  echo "  AVD:                    ${AVD_NAME}    MISSING — create via Android Studio AVD Manager"
fi

PLAYWRIGHT_DIR="${ACE_PLAYWRIGHT_USER_DATA_DIR:-${HOME}/.ace/playwright-userdata}"
if [ -d "${PLAYWRIGHT_DIR}" ] && find "${PLAYWRIGHT_DIR}" -name 'Cookies' -type f -size +0c | grep -q .; then
  echo "  Playwright cookies:     ${PLAYWRIGHT_DIR}    valid    OK"
else
  echo "  Playwright cookies:     MISSING — run /ace:mobile-bootstrap"
fi

for v in ACE_E2E_PHONE ACE_E2E_PIN ACE_E2E_BACKUP_CODE ACE_AVD_NAME; do
  if [ -n "${!v:-}" ]; then
    echo "  ${v}:    set    OK"
  else
    echo "  ${v}:    MISSING — populate via 1Password + op inject"
  fi
done
```

- [ ] **Step 3: Run doctor and confirm output**

```bash
./bin/ace-doctor
```

Expected: Mobile section appears, status reflects machine reality.

- [ ] **Step 4: Commit**

```bash
git add bin/ace-doctor
git commit -m "feat(doctor): mobile emulation health checks"
```

---

## Phase 15 — Integration test + recipe-gen evals

### Task 15.1: Gated integration test

**Files:**
- Create: `test/mcp/mobile/e2e.integration.test.ts`

- [ ] **Step 1: Author the integration test**

```typescript
// test/mcp/mobile/e2e.integration.test.ts
/**
 * MOBILE_INTEGRATION=1 npm run test:integration
 *
 * Requires: Mac with Android SDK, ACE_Pixel_API_34 AVD, registered ACE test user,
 * seeded Playwright cookies. Skipped without env flag.
 */
import { describe, it, expect } from 'vitest';
import { MobileClient } from '../../../mcp/mobile/client.js';

const RUN = process.env.MOBILE_INTEGRATION === '1';
const describeIfRun = RUN ? describe : describe.skip;

describeIfRun('mobile e2e', () => {
  it('boots AVD and runs connect-login.yaml', async () => {
    const client = new MobileClient();
    const avdName = process.env.ACE_AVD_NAME || 'ACE_Pixel_API_34';
    const avd = await client.ensureAvdRunning(avdName);
    expect(avd.status).toBe('booted');

    const tmp = `/tmp/mobile-e2e-${Date.now()}`;
    const result = await client.runRecipe(
      `${client.staticRecipesDir}/connect-login.yaml`,
      {
        PHONE_LOCAL: process.env.ACE_E2E_PHONE_LOCAL!,
        PIN: process.env.ACE_E2E_PIN!,
      },
      tmp,
    );
    expect(result.status).toBe('pass');
    expect(result.screenshots.length).toBeGreaterThan(0);
  }, 5 * 60 * 1000); // 5min timeout
});
```

- [ ] **Step 2: Update package.json test:integration script**

```json
"test:integration": "OCS_INTEGRATION=${OCS_INTEGRATION:-0} MOBILE_INTEGRATION=${MOBILE_INTEGRATION:-0} vitest run"
```

- [ ] **Step 3: Manual integration verification**

```bash
MOBILE_INTEGRATION=1 npm run test:integration -- test/mcp/mobile/e2e.integration.test.ts
```

Expected: PASS within 2–3 minutes. AVD boots, login flow completes, screenshots produced.

- [ ] **Step 4: Commit**

```bash
git add test/mcp/mobile/e2e.integration.test.ts package.json
git commit -m "test(mobile): gated e2e integration (MOBILE_INTEGRATION=1)"
```

### Task 15.2: Recipe-generation evals

**Files:**
- Create: `test/eval/mobile-recipes/run-eval.ts`

- [ ] **Step 1: Author**

```typescript
// test/eval/mobile-recipes/run-eval.ts
/**
 * Recipe-generation evals: run RecipeGenerator against existing fixtures and
 * assert the output is structurally valid.
 *
 * Run via: npx tsx test/eval/mobile-recipes/run-eval.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RecipeGenerator } from '../../../mcp/mobile/backends/recipe-generator.js';
import { MaestroBackend } from '../../../mcp/mobile/backends/maestro.js';

// Stub LLM that emits a structurally-valid template per module name.
async function stubLlm(_system: string, user: string): Promise<string> {
  const moduleMatch = user.match(/Module to walk through: (.+?)\n/);
  const moduleName = moduleMatch ? moduleMatch[1] : 'Module';
  return `appId: org.commcare.dalvik
---
- launchApp: { clearState: false }
- assertVisible: { id: "home_screen_root" }
- tapOn: "${moduleName}"
- takeScreenshot: "module-landing"
- assertVisible: "Module complete"
`;
}

async function evaluate(fixtureDir: string): Promise<{ pass: boolean; details: string[] }> {
  const summaryPath = path.join(fixtureDir, 'app-summaries', 'learn-app-summary.md');
  if (!fs.existsSync(summaryPath)) {
    return { pass: false, details: [`missing ${summaryPath}`] };
  }
  const summary = fs.readFileSync(summaryPath, 'utf8');
  const gen = new RecipeGenerator({ llm: stubLlm, maestro: new MaestroBackend() });
  const modules = gen.parseSummary(summary);
  const details: string[] = [];
  let pass = true;
  for (const m of modules) {
    try {
      const yaml = await gen.generateForModule({ summary, moduleName: m, appKind: 'learn' });
      if (!yaml.includes('takeScreenshot')) {
        pass = false;
        details.push(`module "${m}" emitted no screenshots`);
      }
      if (!yaml.includes('assertVisible')) {
        pass = false;
        details.push(`module "${m}" missing trailing assertVisible`);
      }
      details.push(`module "${m}" OK`);
    } catch (e) {
      pass = false;
      details.push(`module "${m}" failed: ${(e as Error).message}`);
    }
  }
  return { pass, details };
}

async function main() {
  const fixtures = ['CRISPR-Test-001', 'CRISPR-Test-002'];
  let allPass = true;
  for (const f of fixtures) {
    const dir = path.join('test', 'fixtures', f);
    const r = await evaluate(dir);
    console.log(`\n=== ${f} ===`);
    for (const d of r.details) console.log(`  ${d}`);
    console.log(`  → ${r.pass ? 'PASS' : 'FAIL'}`);
    allPass = allPass && r.pass;
  }
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
```

- [ ] **Step 2: Run eval**

```bash
npx tsx test/eval/mobile-recipes/run-eval.ts
```

Expected: PASS for all configured fixtures. (If a fixture lacks `app-summaries/learn-app-summary.md`, the eval correctly reports it.)

- [ ] **Step 3: Wire into existing npm run eval (optional)**

```bash
grep '"eval"' package.json
```

If desired, append `&& npx tsx test/eval/mobile-recipes/run-eval.ts` to the eval script. (Skip if existing eval has its own structure — leave as a separate command.)

- [ ] **Step 4: Commit**

```bash
git add test/eval/mobile-recipes/run-eval.ts
git commit -m "test(mobile): recipe-generation evals against test fixtures"
```

---

## Phase 16 — CHANGELOG, /ace:update, ship

### Task 16.1: Update CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read existing CHANGELOG**

```bash
head -30 CHANGELOG.md
```

- [ ] **Step 2: Add 0.9.0 entry**

```markdown
## 0.9.0 (2026-04-28)

**New: Phase 5 `training-prep` + ACE mobile emulation**

- New `ace-mobile` MCP server (10 atomic capabilities) drives a local Mac AVD via Maestro, captures raw PNGs at every recipe step.
- New `app-screenshot-capture` skill produces `ACE/<opp>/screenshots/` + manifest.
- New `training-prep` phase agent (Phase 5) runs `app-screenshot-capture` + relocated `training-materials`. Phases renumbered: `llo-manager` → 6, `closeout` → 7.
- New `/ace:mobile-bootstrap` slash command for one-time per-machine setup (Maestro, AVD, Playwright cookies, ACE test user registration).
- `connect-setup` now invites the ACE test user to each new opp; invite URL persisted to `connect-state.yaml`.
- `training-materials` now consumes screenshots manifest, `connect-state.yaml`, and `ocs-state.yaml` so generated docs include real URLs and step-by-step screenshots.
- Mac-only, local-AVD-only. No cloud device farms in this release.

See `docs/superpowers/specs/2026-04-28-ace-mobile-emulation-design.md` and `docs/superpowers/plans/2026-04-28-ace-mobile-emulation.md`.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: 0.9.0 changelog entry"
```

### Task 16.2: Final verification — full test run

**Files:** none

- [ ] **Step 1: Run full unit suite**

```bash
npm test
```

Expected: all green.

- [ ] **Step 2: Lint check (if project has one — skip if not)**

```bash
grep '"lint"' package.json && npm run lint || echo "no lint script"
```

- [ ] **Step 3: Doctor sanity**

```bash
./bin/ace-doctor
```

Expected: every section reports OK (or appropriate setup-needed status for mobile bits).

### Task 16.3: Merge to main and update plugin

**Files:** none

- [ ] **Step 1: Merge to main**

```bash
cd ~/emdash-projects/ace
[ "$(git branch --show-current)" = "main" ] || git checkout main
git pull --ff-only
git merge emdash/android-erui0 --no-ff
git push
```

- [ ] **Step 2: Run /ace:update in this session**

This step happens via Claude Code's `/ace:update` slash command, not the shell. After running it, confirm the cache directory updates to `~/.claude/plugins/cache/ace/ace/0.9.0/`.

- [ ] **Step 3: New session smoke test**

Open a fresh Claude Code session and run:

```
/ace:doctor
```

Expected: Mobile section appears, version 0.9.0 confirmed.

---

## Self-Review Checklist (run before handing off)

The plan author runs this checklist. Tick when verified.

- [ ] **Spec coverage:** every Goal in the spec maps to at least one task.
  - Goal 1 (10-atom MCP) → Phases 1–8. ✓
  - Goal 2 (4 static recipes + LLM generator) → Phases 6, 7. ✓
  - Goal 3 (Phase 5 `training-prep` + renumber) → Phase 11. ✓
  - Goal 4 (upstream-input contract) → Tasks 10.1, 12.1. ✓
  - Goal 5 (TS reimplementation, no commcare-ios dep) → Phase 4. ✓
  - Goal 6 (`/ace:doctor` introspection) → Task 14.3. ✓
  - Goal 7 (capability-map stable interface) → Task 1.1. ✓
- [ ] **No placeholders:** no `TBD`, `TODO`, `implement later`, "appropriate error handling" in any task. Selectors in static recipes use `REPLACE_*` markers explicitly to be filled during the discovery task — not hidden.
- [ ] **Type consistency:** `ApkInfo`, `AvdInfo`, `RecipeRunResult`, etc., used identically in `types.ts`, `client.ts`, and tests.
- [ ] **No undefined references:** every method called in tests is defined by the same task or earlier.
- [ ] **Bite-sized steps:** each task's steps are 2–5 minutes. Phase 7 Task 6.1 is the largest by content (4 YAML files in one task) — accepted because they share discovery context.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-28-ace-mobile-emulation.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
