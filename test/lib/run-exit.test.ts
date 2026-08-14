import { describe, it, expect } from 'vitest';
import {
  classifyRunExit,
  findResultEvent,
  findSessionId,
  formatRunExit,
} from '../../lib/run-exit.js';

/** A minimal stream-json `result` event, shaped like the CLI's. */
function resultEvent(over: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 2_460_000,
    num_turns: 180,
    total_cost_usd: 12.5,
    session_id: '20260814-0357-aaaa-bbbb-cccccccccccc',
    ...over,
  };
}

function initEvent() {
  return { type: 'system', subtype: 'init', session_id: '20260814-0357-aaaa-bbbb-cccccccccccc' };
}

describe('findResultEvent / findSessionId', () => {
  it('takes the LAST result event, not the first', () => {
    const events = [resultEvent({ subtype: 'early' }), resultEvent({ subtype: 'final' })];
    expect(findResultEvent(events)?.subtype).toBe('final');
  });

  it('returns null when the stream ended before any result', () => {
    expect(findResultEvent([initEvent()])).toBeNull();
  });

  it('reads the session id off the init event', () => {
    expect(findSessionId([initEvent()])).toBe('20260814-0357-aaaa-bbbb-cccccccccccc');
  });

  it('survives non-object rows without throwing', () => {
    expect(findSessionId([null, 'garbage', 42, initEvent()])).toBe(
      '20260814-0357-aaaa-bbbb-cccccccccccc',
    );
    expect(findResultEvent([null, 'garbage'])).toBeNull();
  });
});

describe('classifyRunExit', () => {
  it('a clean finish is ok and counts', () => {
    const e = classifyRunExit({ exitCode: 0, events: [initEvent(), resultEvent()] });
    expect(e.reason).toBe('ok');
    expect(e.countsAsIteration).toBe(true);
    expect(e.sessionId).toBe('20260814-0357-aaaa-bbbb-cccccccccccc');
    expect(e.totalCostUsd).toBe(12.5);
    expect(e.numTurns).toBe(180);
  });

  // THE REGRESSION ANCHOR — bednet-check-2-visit/20260814-0357 attempt 1,
  // verbatim. 41 minutes of healthy work (both Nova apps built, both evals
  // banked at 9.6 / 9.2), then stdout carrying the 15-byte string
  // "Execution error" and nothing else.
  //
  // ace#1276 recovered the real cause by hand afterwards, by hunting
  // ~/.claude/projects/*.jsonl by mtime and reading the last event: an
  // EXTERNAL INTERRUPT right after an `Agent` dispatch. Not an ACE failure at
  // all. The supervisor gets there without the archaeology, because it
  // pre-assigned the session id and kept the stream.
  it('the bednet 41-minute death is named, not a mystery', () => {
    const e = classifyRunExit({
      exitCode: 1,
      stderr: 'Execution error',
      events: [
        initEvent(),
        { type: 'user', message: { content: '[Request interrupted by user for tool use]' } },
      ],
    });
    expect(e.reason).toBe('external_kill');
    // And critically: it did NOT fail, so it must not move the pass rate.
    expect(e.countsAsIteration).toBe(false);
    expect(e.sessionId).toBe('20260814-0357-aaaa-bbbb-cccccccccccc');
  });

  it('without the interrupt marker the same exit stays honestly unknown', () => {
    // The classifier must not INVENT a cause. An opaque death with no
    // signature is `unknown` — but even then it recovers the two facts the
    // old redirect discarded: which transcript to read, and that it ended
    // early. That is the difference between "no answer" and "no evidence".
    const e = classifyRunExit({
      exitCode: 1,
      stderr: 'Execution error',
      events: [initEvent()],
    });
    expect(e.reason).toBe('unknown');
    expect(e.sessionId).toBe('20260814-0357-aaaa-bbbb-cccccccccccc');
    expect(e.detail).toMatch(/stream ended early/);
  });

  it('an interrupt far back in a long stream is NOT the cause of this exit', () => {
    // A run can be interrupted, resumed, and then die of something else. Only
    // the tail is scanned, so a stale marker cannot mask the real ending.
    const filler = Array.from({ length: 30 }, (_, i) => ({ type: 'assistant', i }));
    const e = classifyRunExit({
      exitCode: 0,
      events: [
        initEvent(),
        { type: 'user', message: { content: '[Request interrupted by user for tool use]' } },
        ...filler,
        resultEvent(),
      ],
    });
    expect(e.reason).toBe('ok');
  });

  it('a session limit does NOT count as an iteration', () => {
    const e = classifyRunExit({
      exitCode: 1,
      stderr: "You've hit your session limit · resets 2:10am (America/Denver)",
      events: [initEvent()],
    });
    expect(e.reason).toBe('session_limit');
    expect(e.countsAsIteration).toBe(false);
  });

  it('catches the limit even when the CLI exits 0', () => {
    // Observed live: the notice is printed and the process still exits clean.
    const e = classifyRunExit({
      exitCode: 0,
      events: [initEvent(), resultEvent({ result: "You've hit your usage limit" })],
    });
    expect(e.reason).toBe('session_limit');
    expect(e.countsAsIteration).toBe(false);
  });

  it('an MCP crash is a restart, not a code defect', () => {
    const e = classifyRunExit({
      exitCode: 1,
      stderr: `MCP server "ace-mobile" crashed`,
      events: [initEvent()],
    });
    expect(e.reason).toBe('mcp_crash');
    expect(e.countsAsIteration).toBe(false);
  });

  it('recognises the pruned-plugin-cache signature from lib/plugin-cache-freshness', () => {
    const e = classifyRunExit({
      exitCode: 1,
      stderr: `Cannot find module './../../../package.json'`,
      events: [initEvent()],
    });
    expect(e.reason).toBe('mcp_crash');
  });

  it('a deliberate phase halt IS a verdict and counts', () => {
    const e = classifyRunExit({
      exitCode: 1,
      events: [initEvent(), resultEvent({ is_error: true, result: 'status: blocked' })],
    });
    expect(e.reason).toBe('phase_halt');
    expect(e.countsAsIteration).toBe(true);
  });

  it('a signal is killed, not a failure', () => {
    const e = classifyRunExit({ exitCode: null, signal: 'SIGKILL', events: [initEvent()] });
    expect(e.reason).toBe('killed');
    expect(e.countsAsIteration).toBe(false);
    expect(e.detail).toContain('SIGKILL');
  });

  it('the supervisor cap wins over every other signature', () => {
    // A timed-out run often ALSO shows a crash signature on the way down;
    // reporting that as the cause would send the loop chasing a symptom.
    const e = classifyRunExit({
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: true,
      stderr: `MCP server "ace-mobile" crashed`,
      events: [initEvent()],
    });
    expect(e.reason).toBe('timeout');
  });

  it('an error result with no specific signature is execution_error and counts', () => {
    const e = classifyRunExit({
      exitCode: 1,
      events: [initEvent(), resultEvent({ is_error: true, subtype: 'error_during_execution' })],
    });
    expect(e.reason).toBe('execution_error');
    expect(e.countsAsIteration).toBe(true);
    expect(e.detail).toContain('error_during_execution');
  });

  // The classifier must read signatures from the RESULT and stderr only. A run
  // whose transcript merely discusses limits (an ACE review, say) is not a run
  // that hit one.
  it('does not classify from transcript chatter', () => {
    const e = classifyRunExit({
      exitCode: 0,
      events: [
        initEvent(),
        { type: 'assistant', message: { content: "we hit your session limit yesterday" } },
        resultEvent(),
      ],
    });
    expect(e.reason).toBe('ok');
  });
});

describe('formatRunExit', () => {
  it('leads with the reason and says whether it counts', () => {
    const line = formatRunExit(
      classifyRunExit({ exitCode: 0, events: [initEvent(), resultEvent()] }),
    );
    expect(line).toMatch(/^reason=ok/);
    expect(line).toContain('counts-as-iteration');
    expect(line).toContain('$12.50');
  });

  it('marks a non-counting exit explicitly', () => {
    const line = formatRunExit(
      classifyRunExit({ exitCode: 1, stderr: "You've hit your session limit", events: [] }),
    );
    expect(line).toContain('does-not-count');
  });
});
