import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * inbox-triage must say HOW a turn starts a run, not just that it may.
 *
 * The act-tier row of the caller table lists "start a run" as something an
 * act-tier sender may trigger, but until ace#2961 the step-2 action list
 * (Reply / Advance the run / File / Escalate / No-op) had no entry for it.
 * Turn d45e2ac0 (Sophie, "please build v0.1") had to reverse-engineer the
 * mechanism from an earlier ACE email, and every build-request turn paid the
 * same rediscovery. These assertions pin the action entry and the parts of
 * its contract that turn failed to find.
 *
 * Also pins the ace#2925 correction to the claude.ai invitation noise row:
 * accepting an invitation did NOT make the doc readable via the connector, so
 * the row must not promise that it does.
 */
describe('inbox-triage: Start a run action (ace#2961)', () => {
  const skill = readFileSync(
    join(__dirname, '../../skills/inbox-triage/SKILL.md'),
    'utf8',
  );

  const entry = (): string => {
    const start = skill.indexOf('- **Start a run** *(act tier only)*');
    expect(start, 'Start a run action entry is missing').toBeGreaterThan(-1);
    const rest = skill.slice(start + 1);
    const next = rest.search(/\n\s+- \*\*/);
    return next === -1 ? rest : rest.slice(0, next);
  };

  it('dispatches through canopy with a brief file', () => {
    expect(entry()).toMatch(/canopy agent dispatch --slug ace .*--prompt-file/);
  });

  it('the brief carries the run command, thread id, verbatim asks and reply contract', () => {
    const e = entry();
    expect(e).toContain('/ace:run <ws>/<opp>');
    expect(e).toMatch(/routing thread id/);
    expect(e).toMatch(/verbatim/);
    expect(e).toMatch(/ace-web page/);
  });

  it('verifies the queued turn and forbids a handoff ack', () => {
    const e = entry();
    expect(e).toContain('canopy agent turns --slug ace');
    expect(e).toMatch(/Send no handoff ack/);
  });
});

describe('inbox-triage: claude.ai invitation row (ace#2925)', () => {
  const skill = readFileSync(
    join(__dirname, '../../skills/inbox-triage/SKILL.md'),
    'utf8',
  );
  const row = skill.split('\n').find((l) => l.startsWith('| `no-reply-claude@mail.anthropic.com`'));

  it('does not claim that accepting the invite makes the doc readable', () => {
    expect(row, 'claude.ai invitation row missing').toBeDefined();
    expect(row).not.toMatch(/until someone .* accepts it in a browser/);
    expect(row).toMatch(/Accepting it does NOT make the doc readable/);
  });
});
