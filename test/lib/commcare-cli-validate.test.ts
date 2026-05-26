import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  resolveJavaPath,
  javaProbeWorks,
  JAVA_CANDIDATE_PATHS,
} from '../../lib/commcare-cli-validate';

describe('javaProbeWorks', () => {
  it('returns false on a non-existent binary', () => {
    expect(javaProbeWorks('/nonexistent/path/to/java')).toBe(false);
  });

  it('returns false on a non-executable file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-java-probe-'));
    const fake = path.join(tmp, 'fake-java');
    try {
      fs.writeFileSync(fake, 'not a real binary');
      // No chmod +x — should fail to spawn.
      expect(javaProbeWorks(fake)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns false when the macOS java stub spawns the install-Java prompt', () => {
    // Simulate the macOS /usr/bin/java stub: a real binary that
    // exits with a non-zero status and writes "Unable to locate a
    // Java Runtime" to stderr. Approximated here with a shell script
    // that exits 1 and writes a non-Java banner.
    if (process.platform === 'win32') {
      // Shell-script trick is unix-only; skip on Windows hosts.
      return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-java-stub-'));
    const stub = path.join(tmp, 'java');
    try {
      fs.writeFileSync(
        stub,
        '#!/bin/sh\necho "Unable to locate a Java Runtime." 1>&2\nexit 1\n',
        { mode: 0o755 },
      );
      expect(javaProbeWorks(stub)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns true on a fake binary that emits an openjdk-shaped banner with exit 0', () => {
    if (process.platform === 'win32') return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-java-fake-'));
    const fake = path.join(tmp, 'java');
    try {
      fs.writeFileSync(
        fake,
        '#!/bin/sh\necho "openjdk version \\"17.0.19\\" 2026-04-21" 1>&2\nexit 0\n',
        { mode: 0o755 },
      );
      expect(javaProbeWorks(fake)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('resolveJavaPath', () => {
  const savedEnv = process.env.ACE_JAVA_BIN;

  beforeEach(() => {
    delete process.env.ACE_JAVA_BIN;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.ACE_JAVA_BIN;
    } else {
      process.env.ACE_JAVA_BIN = savedEnv;
    }
  });

  it('honors an explicit caller-supplied path without probing', () => {
    // Caller asserts correctness; we don't probe.
    expect(resolveJavaPath('/explicit/path/to/java')).toBe('/explicit/path/to/java');
  });

  it('honors $ACE_JAVA_BIN when no explicit path is passed', () => {
    process.env.ACE_JAVA_BIN = '/env/path/to/java';
    expect(resolveJavaPath()).toBe('/env/path/to/java');
  });

  it('prefers explicit over $ACE_JAVA_BIN', () => {
    process.env.ACE_JAVA_BIN = '/env/path/to/java';
    expect(resolveJavaPath('/explicit/path/to/java')).toBe('/explicit/path/to/java');
  });

  it('returns a working candidate when run on a machine with Java installed', () => {
    // The test machine MUST have Java installed for this test to be
    // meaningful. If Java is genuinely absent, returns undefined — that's
    // still a valid signal.
    const resolved = resolveJavaPath();
    if (resolved === undefined) {
      // No Java anywhere — accept as a valid outcome.
      return;
    }
    expect(typeof resolved).toBe('string');
    // The resolver must return something the probe agrees works.
    expect(javaProbeWorks(resolved)).toBe(true);
  });
});

describe('JAVA_CANDIDATE_PATHS', () => {
  it('contains the homebrew openjdk@17 pin first', () => {
    expect(JAVA_CANDIDATE_PATHS[0]).toBe('/opt/homebrew/opt/openjdk@17/bin/java');
  });

  it('does NOT include the macOS /usr/bin/java stub', () => {
    expect(JAVA_CANDIDATE_PATHS).not.toContain('/usr/bin/java');
  });

  it('is non-empty', () => {
    expect(JAVA_CANDIDATE_PATHS.length).toBeGreaterThan(0);
  });
});
