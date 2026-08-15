/**
 * ace#1093 — every session boundary discards working context and the next
 * session re-derives it. Session `d9eefb36` did ~30 context calls, correctly
 * halted at preflight on stale MCP subprocesses, and `f27b0189` six minutes
 * later redid all of them — including re-flailing the same gog CLI flags, one
 * guessing `--max` and the other `--limit`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeHandoff,
  readHandoff,
  clearHandoff,
  renderHandoff,
  handoffPath,
  HANDOFF_MAX_AGE_MS,
  type SessionHandoff,
} from '../../lib/session-handoff';

let home: string;
beforeEach(() => { home = mkdtempSync(path.join(os.tmpdir(), 'ace-handoff-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const T0 = Date.parse('2026-08-15T05:07:00.000Z');
const sample: SessionHandoff = {
  written_at: '2026-08-15T05:07:00.000Z',
  reason: 'preflight halt: stale MCP subprocesses (0.13.699 vs 0.13.700, mobile code changed)',
  established: [
    'thread 19f86579142e6ba5 read; Sophie is asking about the poverty-targeting run',
    'run state reconstructed from Drive: hh-poverty-targeting/20260722-1341',
    'gog search flag is --max, NOT --limit',
  ],
  artifacts: ['/tmp/scratch/draft-reply.md'],
  next_command: 'canopy email read 19f86579142e6ba5',
  thread_id: '19f86579142e6ba5',
  run: 'hh-poverty-targeting/20260722-1341',
};

describe('round-trip', () => {
  it('writes then reads fresh', () => {
    expect(writeHandoff(sample, home)).toBe(true);
    const r = readHandoff(T0 + 60_000, home);
    expect(r.status).toBe('fresh');
    if (r.status === 'fresh') expect(r.handoff.next_command).toBe('canopy email read 19f86579142e6ba5');
  });

  it('lands somewhere predictable, not a per-session scratchpad', () => {
    // The scratchpad is exactly where parked drafts died.
    expect(handoffPath(home)).toBe(path.join(home, '.ace', 'session-handoff.json'));
  });

  it('creates ~/.ace when it does not exist', () => {
    expect(writeHandoff(sample, home)).toBe(true);
    expect(existsSync(handoffPath(home))).toBe(true);
  });
});

describe('a stale handoff is reported, never silently trusted', () => {
  it('goes stale past the window', () => {
    writeHandoff(sample, home);
    const r = readHandoff(T0 + HANDOFF_MAX_AGE_MS + 1, home);
    expect(r.status).toBe('stale');
  });

  it('is still fresh just inside the window', () => {
    writeHandoff(sample, home);
    expect(readHandoff(T0 + HANDOFF_MAX_AGE_MS - 1, home).status).toBe('fresh');
  });

  it('returns the handoff alongside stale, so the caller can say what it was', () => {
    // Silence would read as "the mechanism never ran".
    writeHandoff(sample, home);
    const r = readHandoff(T0 + HANDOFF_MAX_AGE_MS + 1, home);
    if (r.status === 'stale') expect(r.handoff.reason).toContain('preflight halt');
    else throw new Error('expected stale');
  });
});

describe('a broken handoff never blocks a session', () => {
  const bad = (body: string) => {
    mkdirSync(path.join(home, '.ace'), { recursive: true });
    writeFileSync(handoffPath(home), body);
  };

  it('absent reads as none', () => {
    expect(readHandoff(T0, home)).toEqual({ status: 'none' });
  });

  it.each([
    ['corrupt JSON', '{not json'],
    ['missing written_at', JSON.stringify({ reason: 'x', established: [] })],
    ['missing established', JSON.stringify({ written_at: '2026-08-15T05:07:00Z', reason: 'x' })],
    ['unparseable timestamp', JSON.stringify({ written_at: 'whenever', reason: 'x', established: [] })],
  ])('%s reads as none rather than throwing', (_l, body) => {
    bad(body);
    expect(readHandoff(T0, home)).toEqual({ status: 'none' });
  });

  it('a failed write returns false rather than crashing the halt', () => {
    // A handoff that cannot be written must not turn a clean halt into a crash.
    // The parent is a FILE, so mkdir under it is ENOTDIR for every user
    // including root. A chmod-based lock would silently pass as root, and a
    // platform path like /proc makes the behaviour depend on the OS running
    // the suite — the thing under test is only "the write failed".
    const notADir = path.join(home, 'this-is-a-file');
    writeFileSync(notADir, 'x');
    expect(writeHandoff(sample, notADir)).toBe(false);
  });
});

describe('it is consumed, not left lying around', () => {
  it('clearHandoff removes it', () => {
    writeHandoff(sample, home);
    clearHandoff(home);
    expect(readHandoff(T0, home).status).toBe('none');
  });

  it('clearing a missing handoff is not an error', () => {
    expect(() => clearHandoff(home)).not.toThrow();
  });
});

describe('the rendered block tells the next session not to redo the work', () => {
  const out = renderHandoff(sample, 6 * 60 * 1000);

  it('says how old it is', () => expect(out).toContain('6m ago'));
  it('names the reason', () => expect(out).toContain('stale MCP subprocesses'));
  it('lists what was established', () => expect(out).toContain('gog search flag is --max'));
  it('carries the exact next command', () => expect(out).toContain('canopy email read 19f86579142e6ba5'));
  it('names the run and thread', () => {
    expect(out).toContain('hh-poverty-targeting/20260722-1341');
    expect(out).toContain('19f86579142e6ba5');
  });
  it('states the instruction explicitly', () => {
    expect(out).toContain('DO NOT re-derive');
  });
  it('omits optional blocks that are absent', () => {
    const bare = renderHandoff(
      { written_at: sample.written_at, reason: 'r', established: ['e'] }, 1000,
    );
    expect(bare).not.toContain('artifacts:');
    expect(bare).not.toContain('next_command:');
    expect(bare).not.toContain('run:');
  });
});

describe('the halt paths are told to use it (ace#1093)', () => {
  const read = (p: string) =>
    readFileSync(path.join(__dirname, '../..', p), 'utf8');

  it('the orchestrator writes a handoff before a restart halt', () => {
    const doc = read('agents/ace-orchestrator.md');
    expect(doc).toMatch(/write a handoff first/i);
    expect(doc).toContain('writeHandoff');
    expect(doc).toContain('lib/session-handoff.ts');
  });

  it('it tells the reader to consume the handoff, not leave it', () => {
    expect(read('agents/ace-orchestrator.md')).toContain('clearHandoff');
  });

  it('doctor preflight surfaces a handoff', () => {
    const doctor = read('bin/ace-doctor');
    expect(doctor).toContain('session-handoff.json');
    expect(doctor).toContain('renderHandoff');
  });

  it('doctor reports a stale handoff rather than hiding it', () => {
    expect(read('bin/ace-doctor')).toContain('handoff_present_but_stale');
  });

  it('inbox-triage requires a board task and a persisted parked draft', () => {
    const skill = read('skills/inbox-triage/SKILL.md');
    expect(skill).toMatch(/board task/i);
    expect(skill).toMatch(/parked draft/i);
    expect(skill).toContain('task-tracker');
    // The scratchpad is where the four drafts died.
    expect(skill).toMatch(/scratchpad does not count/i);
  });
});
