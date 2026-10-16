/**
 * ace#2988 — `commcare_validate_ccz` play appended child stdout/stderr with
 * unbounded `+=`. When `commcare-cli play` hits a session error it prints
 * `Press return to restart the session` and, stdin being closed, loops —
 * ~2 GB of stderr a minute on kaduna-graduation/20261015-1411. The string
 * overflowed (`RangeError: Invalid string length`) and took the whole
 * ace-connect MCP down. Capture is now bounded (head + tail), and the JVM is
 * killed on the restart-loop marker or an output ceiling.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

import {
  BoundedLog,
  CLI_LOG_HEAD_CHARS,
  CLI_LOG_TAIL_CHARS,
  CLI_OUTPUT_CEILING_CHARS,
  PLAY_RESTART_LOOP_MARKER,
  commcareCliPlayCcz,
  commcareCliValidateCcz,
  parsePlayOutput,
  type CliSpawn,
} from '../../lib/commcare-cli-validate.js';

const MB = 1_000_000;
/** More than the 500 MB the issue asks the test to survive. */
const BUDGET_CHARS = 600 * MB;

interface Script {
  stdout?: string;
  stderr?: string;
  /** Keep emitting after kill (a child that ignores SIGKILL, or a racing pipe). */
  ignoreKill?: boolean;
  /** Emit synchronously in one tick (no timers can run between chunks). */
  sync?: boolean;
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: (_s: string) => true, end: () => {} };
  kills = 0;
  emitted = 0;
  private stopped = false;
  constructor(private readonly script: Script) {
    super();
    setImmediate(() => this.run());
  }
  kill(): boolean {
    this.kills++;
    if (!this.script.ignoreKill && !this.stopped) {
      this.stopped = true;
      setImmediate(() => this.emit('close', null));
    }
    return true;
  }
  private emitOne(): boolean {
    if (this.stopped && !this.script.ignoreKill) return false;
    if (this.emitted >= BUDGET_CHARS) return false;
    for (const k of ['stdout', 'stderr'] as const) {
      const chunk = this.script[k];
      if (chunk) {
        this[k].emit('data', Buffer.from(chunk));
        this.emitted += chunk.length;
      }
    }
    return true;
  }
  private finish() {
    if (!this.stopped || this.script.ignoreKill) {
      this.stopped = true;
      this.emit('close', this.script.ignoreKill ? null : 0);
    }
  }
  private run() {
    if (this.script.sync) {
      while (this.emitOne());
      this.finish();
      return;
    }
    const step = () => {
      if (this.emitOne()) setImmediate(step);
      else this.finish();
    };
    step();
  }
}

function fakeSpawn(script: Script): { spawnImpl: CliSpawn; child: () => FakeChild } {
  let child: FakeChild | undefined;
  return {
    spawnImpl: () => {
      child = new FakeChild(script);
      return child;
    },
    child: () => child!,
  };
}

function inputs() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ace-runaway-'));
  const cczPath = path.join(dir, 'app.ccz');
  writeFileSync(cczPath, zipSync({ 'suite.xml': strToU8('<suite></suite>') }));
  const jarPath = path.join(dir, 'commcare-cli.jar');
  writeFileSync(jarPath, 'not a jar');
  return { cczPath, jarPath, javaPath: 'java-fake' };
}

/** One pass of the loop: the stack the CLI re-prints, ~1 MB per chunk. */
const LOOP_STACK = (
  'org.javarosa.xpath.XPathTypeMismatchException: Logic references /data/q1 which is not a valid question or value.\n' +
  '\tat org.javarosa.xpath.expr.XPathPathExpr.eval(XPathPathExpr.java:278)\n'
).repeat(5000);
const LOOP_STDOUT = `Error during session execution:\n${PLAY_RESTART_LOOP_MARKER}\n`.repeat(20000);

describe('BoundedLog (ace#2988)', () => {
  it('keeps the head and the tail and counts what it dropped', () => {
    const log = new BoundedLog(10, 5);
    log.push('0123456789');
    log.push('abcdefghij');
    log.push('KLMNO');
    expect(log.total).toBe(25);
    expect(log.toString()).toBe('0123456789\n... [10 chars elided] ...\nKLMNO');
  });

  it('returns the stream verbatim while it fits', () => {
    const log = new BoundedLog(10, 5);
    log.push('abc');
    log.push('def');
    expect(log.toString()).toBe('abcdef');
  });

  it('stays bounded across 600 MB of pushes', () => {
    const log = new BoundedLog();
    const chunk = 'y'.repeat(MB);
    for (let i = 0; i < 600; i++) log.push(chunk);
    expect(log.total).toBe(600 * MB);
    expect(log.toString().length).toBeLessThan(CLI_LOG_HEAD_CHARS + CLI_LOG_TAIL_CHARS + 100);
  });
});

describe('commcareCliPlayCcz under a restart loop (ace#2988)', () => {
  it('kills on the restart-loop marker, stays bounded, and grades the first exception', async () => {
    const fake = fakeSpawn({ stdout: LOOP_STDOUT, stderr: LOOP_STACK });
    const res = await commcareCliPlayCcz({
      ...inputs(),
      entryPath: [0, 0],
      spawnImpl: fake.spawnImpl,
      restartLoopGraceMs: 5,
    });
    expect(fake.child().kills).toBeGreaterThan(0);
    expect(fake.child().emitted).toBeLessThan(BUDGET_CHARS);
    expect(res.killed_reason).toBe('restart-loop');
    expect(res.verdict).toBe('fail');
    expect(res.parser_message).toMatch(/^XPathTypeMismatchException: Logic references \/data\/q1/);
    expect(res.stdout.length).toBeLessThan(10_000);
    expect(res.stderr.length).toBeLessThan(10_000);
  });

  it('kills at the output ceiling when there is no marker', async () => {
    const fake = fakeSpawn({ stderr: 'z'.repeat(MB), sync: true });
    const res = await commcareCliPlayCcz({ ...inputs(), spawnImpl: fake.spawnImpl });
    expect(fake.child().kills).toBeGreaterThan(0);
    expect(res.killed_reason).toBe('output-ceiling');
    expect(res.verdict).toBe('fail');
    expect(res.parser_message).toContain(String(CLI_OUTPUT_CEILING_CHARS));
    expect(res.stderr.length).toBeLessThan(10_000);
  });

  it('survives >500 MB from a child that ignores the kill (no RangeError)', async () => {
    const fake = fakeSpawn({ stdout: LOOP_STDOUT, stderr: LOOP_STACK, ignoreKill: true, sync: true });
    const res = await commcareCliPlayCcz({ ...inputs(), spawnImpl: fake.spawnImpl });
    expect(fake.child().emitted).toBeGreaterThanOrEqual(500 * MB);
    expect(fake.child().kills).toBeGreaterThan(0);
    expect(res.verdict).toBe('fail');
    expect(res.stdout.length + res.stderr.length).toBeLessThan(20_000);
  });

  it('a recognised harness class inside a restart loop still grades skipped', async () => {
    const stack =
      'org.javarosa.xpath.XPathTypeMismatchException: Logic references instance(commcaresession)/session/user/data/kgrad_role which is not a valid question or value.\n' +
      '\tat org.commcare.suite.model.MenuLoader.menuIsRelevant(MenuLoader.java:143)\n';
    const fake = fakeSpawn({ stdout: LOOP_STDOUT, stderr: stack.repeat(5000) });
    const res = await commcareCliPlayCcz({
      ...inputs(),
      restorePath: inputs().cczPath, // caller restore: no user data seeded
      spawnImpl: fake.spawnImpl,
      restartLoopGraceMs: 5,
    });
    expect(res.killed_reason).toBe('restart-loop');
    expect(res.verdict).toBe('skipped');
    expect(res.skip_reason).toBe('cli-user-data-unseeded');
  });
});

describe('commcareCliValidateCcz output ceiling (ace#2988)', () => {
  it('kills and fails a validator that will not stop printing', async () => {
    const fake = fakeSpawn({ stdout: 'v'.repeat(MB), sync: true });
    const res = await commcareCliValidateCcz({ ...inputs(), spawnImpl: fake.spawnImpl });
    expect(fake.child().kills).toBeGreaterThan(0);
    expect(res.killed_reason).toBe('output-ceiling');
    expect(res.verdict).toBe('fail');
    expect(res.stdout.length).toBeLessThan(10_000);
  });
});

describe('parsePlayOutput reads the FIRST pass (ace#2988)', () => {
  it('names the first exception, not a later pass', () => {
    const first =
      'org.javarosa.xpath.XPathTypeMismatchException: Logic references /data/first which is not a valid question or value.\n' +
      `Error during session execution:\n${PLAY_RESTART_LOOP_MARKER}\n`;
    const later =
      'org.javarosa.xpath.XPathException: something else entirely\n' +
      `Error during session execution:\n${PLAY_RESTART_LOOP_MARKER}\n`;
    const res = parsePlayOutput({
      exitCode: -1,
      stdout: first + later.repeat(3),
      stderr: '',
      timedOut: false,
      timeoutMs: 30000,
      entryPath: [0, 0],
      killedReason: 'restart-loop',
    });
    expect(res.verdict).toBe('fail');
    expect(res.unresolved_xpath).toBe('/data/first');
    expect(res.parser_message).toMatch(/XPathTypeMismatchException/);
    expect(res.stdout).not.toContain('something else entirely');
  });

  it('a killed run with no recognised exception is fail, never pass', () => {
    const res = parsePlayOutput({
      exitCode: -1,
      stdout: `Starting form entry with the following stack frame\nError during session execution:\n${PLAY_RESTART_LOOP_MARKER}\n`,
      stderr: '',
      timedOut: false,
      timeoutMs: 30000,
      entryPath: [0, 0],
      killedReason: 'restart-loop',
    });
    expect(res.verdict).toBe('fail');
    expect(res.parser_message).toContain('restart loop');
  });
});
