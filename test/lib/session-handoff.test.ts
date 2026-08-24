/**
 * ace#1093 — every session boundary discards working context and the next
 * session re-derives it. Session `d9eefb36` did ~30 context calls, correctly
 * halted at preflight on stale MCP subprocesses, and `f27b0189` six minutes
 * later redid all of them — including re-flailing the same gog CLI flags, one
 * guessing `--max` and the other `--limit`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parse as loadYaml } from 'yaml';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeHandoff,
  readHandoff,
  clearHandoff,
  renderHandoff,
  renderStaleHandoff,
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

describe('the rendered block is valid YAML (ace#1582)', () => {
  // bin/ace-doctor --preflight documents itself as emitting YAML, and a handoff
  // exists precisely on the post-halt path where that contract matters most.
  // The old hand-built renderer produced `handoff_from_previous_session: 4m ago`
  // with mapping keys nested under a SCALAR, a bare sentence as the last line,
  // and unquoted free text containing `: ` — three ways to fail the same parse.
  const parse = (s: string) => loadYaml(s) as Record<string, any>;

  it('round-trips through a YAML parser', () => {
    const doc = parse(renderHandoff(sample, 6 * 60 * 1000));
    expect(doc.handoff_from_previous_session).toBeTypeOf('object');
  });

  it('preserves every field through the round-trip', () => {
    const h = parse(renderHandoff(sample, 6 * 60 * 1000)).handoff_from_previous_session;

    expect(h.age).toBe('6m ago');
    expect(h.reason).toBe(sample.reason);
    expect(h.already_established).toEqual(sample.established);
    expect(h.next_command).toBe(sample.next_command);
    expect(h.run).toBe(sample.run);
    expect(h.note).toContain('DO NOT re-derive');
  });

  it('survives free text that would break hand-built YAML', () => {
    // Every one of these appears in real handoffs: a colon-space in the reason,
    // a `#`, quotes, and a leading `-`. This is the case that made quoting
    // load-bearing rather than cosmetic.
    const nasty: SessionHandoff = {
      written_at: sample.written_at,
      reason: 'ROOT CAUSE: nova returned "needs auth" — see ace#1579: not a credential bug',
      established: [
        'flag is --max: there is no --limit',
        '- a leading dash, and a trailing colon:',
        'key: value # not a comment',
      ],
      artifacts: ['path/to/file: with colon'],
      next_command: '/ace:run spark-facilitator/20260820-0817',
      run: 'spark-facilitator/20260820-0817',
      thread_id: '19f86579142e6ba5',
    };

    const h = parse(renderHandoff(nasty, 60 * 1000)).handoff_from_previous_session;

    expect(h.reason).toBe(nasty.reason);
    expect(h.already_established).toEqual(nasty.established);
    expect(h.artifacts).toEqual(nasty.artifacts);
    expect(h.next_command).toBe(nasty.next_command);
    expect(h.thread).toBe(nasty.thread_id);
  });

  it('renders the STALE notice as YAML too', () => {
    // A stale handoff is reported rather than hidden, so it has to parse as
    // well — the old `INFO handoff_present_but_stale=132m` was a bare scalar
    // line that broke the document just as thoroughly.
    const h = parse(renderStaleHandoff(132 * 60 * 1000)).handoff_from_previous_session;

    expect(h.status).toBe('stale');
    expect(h.age).toBe('132m ago');
    expect(h.note).toContain('ace#1093');
  });

  it('a bare handoff still parses with the optional blocks absent', () => {
    const h = parse(
      renderHandoff({ written_at: sample.written_at, reason: 'r', established: ['e'] }, 1000),
    ).handoff_from_previous_session;

    expect(h.reason).toBe('r');
    expect(h.artifacts).toBeUndefined();
    expect(h.next_command).toBeUndefined();
    expect(h.run).toBeUndefined();
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
    // Was an inline `handoff_present_but_stale=` echo; now goes through
    // renderStaleHandoff so the notice is valid YAML like everything else in
    // the preflight document (ace#1582). The INTENT is unchanged: a stale
    // handoff is surfaced, because silence reads as "the mechanism never ran".
    const doctor = read('bin/ace-doctor');
    expect(doctor).toContain('renderStaleHandoff');
    expect(doctor).toMatch(/status === 'stale'/);
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
