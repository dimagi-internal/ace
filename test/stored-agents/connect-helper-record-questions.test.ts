/**
 * connect-helper must READ a worker's own record before answering a record
 * question, and must tell an empty record apart from a missing tool.
 *
 * Origin: labs thread 7, 2026-11-25. "how do I check my payments?" (msg 15)
 * and "When was my last payment?" (msg 21) were both answered "I can't see
 * your payment record from here", with no site_call to worker_payments and
 * no thread_handoff (needs_attention=false). connect-labs host-site traffic
 * showed no site_call, successful or refused, in either turn. In the laptop
 * session for that thread the model read its skills and replied, with no
 * ToolSearch for site_tools/site_call. worker-chat § 3 allowed that: "A tool
 * that is not offered, or that fails: answer from what you have."
 *
 * The source of truth for connect-helper is its STORED definition on
 * canopy-web. `stored-agents/connect-helper/` is ace's working copy (ace
 * administers it, and publishes it from here). This test pins the rule in
 * that copy, so a later edit cannot quietly bring the old way out back.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', 'stored-agents', 'connect-helper');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function section(md: string, heading: string): string {
  const start = md.indexOf(heading);
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const rest = md.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('connect-helper worker-chat § 3: record questions are read, never waved off', () => {
  const s3 = section(read('skills/worker-chat/SKILL.md'), '## 3. Read more only when the reply needs it');

  it('requires the record read before replying', () => {
    expect(s3).toMatch(/OWN record \(payments, visits, tasks, Learn\)/);
    expect(s3).toMatch(/MUST be read before you reply/);
    expect(s3).toMatch(/ToolSearch/);
    expect(s3).toMatch(/then `site_call`\s+the narrowest tool the brief's worker tools line names/);
    // The brief already names the granted tools: site_tools first is a wasted step.
    expect(s3).toMatch(/do not call `site_tools` first/);
    expect(s3).not.toMatch(/call `site_tools`, then `site_call`/);
  });

  it('loads site_call in the same step as the approach skill', () => {
    const s2 = section(read('skills/worker-chat/SKILL.md'), '## 2. Find the thread and the approach');
    expect(s2).toMatch(/ToolSearch that loads\s+`site_call` in the \*\*same step\*\* as the Skill call/);
  });

  it('forbids "cannot see your record" without the call', () => {
    expect(s3).toMatch(/Never tell a worker you cannot see their\s+record without having made that call this turn/);
  });

  it('gives rows, no rows and no tool three different outcomes', () => {
    expect(s3).toMatch(/\(a\) rows came back/);
    expect(s3).toMatch(/\(b\) the tool answered with no rows/);
    expect(s3).toMatch(/\(c\) the tool could not be read/);
    expect(s3).toMatch(/`thread_handoff` with reason `cannot_do`/);
    expect(s3).toMatch(/record tool unavailable: <tool> <not listed\|refused\|error: …>/);
  });

  it('keeps the old "answer from what you have" exit away from record questions', () => {
    // The exit may survive only for OTHER tools, and only after the record rule.
    const exitAt = s3.indexOf('answer from what you have');
    const ruleAt = s3.indexOf('MUST be read before you reply');
    expect(ruleAt).toBeGreaterThan(-1);
    if (exitAt >= 0) {
      expect(exitAt).toBeGreaterThan(ruleAt);
      expect(s3).toMatch(/Any other tool that is not offered, or that fails: answer from what you have/);
      expect(s3).not.toMatch(/\n- A tool that is not offered, or that fails: answer from what you have/);
    }
  });

  it('names the site the turn is on, not the retired connect-messaging site', () => {
    expect(s3).not.toMatch(/on the site\s+`connect-messaging`/);
    expect(s3).toMatch(/`connect-labs`; `site_call` takes no site argument/);
  });
});

describe('connect-helper general-help and persona point record questions at the tool', () => {
  it('general-help says "I can\'t see your record" is never an answer', () => {
    const where = section(read('skills/general-help/SKILL.md'), '## Where answers come from');
    expect(where).toMatch(/A record question is always read\s+through the tool before you answer/);
    expect(where).toMatch(/"I can't see your record" is never an\s+answer/);
  });

  it('persona keeps "I do not have that here" for figures that are not on the record', () => {
    const persona = read('persona.md');
    expect(persona).not.toMatch(/With neither, say you do not have it here\./);
    expect(persona).toMatch(/A figure from the worker's own record is\s+read with the tool before you reply/);
  });
});

describe('connect-helper scenarios cover both record outcomes', () => {
  const dir = join(ROOT, 'tests', 'scenarios');
  const load = (id: string) => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));

  it('every scenario parses and names its id after its file', () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const sc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      expect(sc.agent).toBe('connect-helper');
      expect(`${sc.id}.json`).toBe(f);
    }
  });

  it('record-question-reads-tool: worker_payments is called and its date quoted', () => {
    const sc = load('record-question-reads-tool');
    expect(sc.turns[0].worker).toBe('When was my last payment?');
    expect(sc.site_tools).toContain('worker_payments');
    expect(sc.brief).toMatch(/Your worker tools here: .*worker_payments/);
    expect(sc.tools_expected).toContain('worker_payments');
    expect(sc.tools_forbidden).toContain('site_tools');
    expect(sc.must.join('\n')).toMatch(/18 November/);
    expect(sc.must_not.join('\n')).toMatch(/cannot see/);
  });

  it('record-tool-unavailable-hands-off: no worker_payments means a cannot_do handoff', () => {
    const sc = load('record-tool-unavailable-hands-off');
    expect(sc.turns[0].worker).toBe('When was my last payment?');
    expect(sc.site_tools).not.toContain('worker_payments');
    expect(sc.brief).toMatch(/Your worker tools here: /);
    expect(sc.brief).not.toMatch(/worker_payments/);
    expect(sc.tools_expected).toContain('thread_handoff');
    const must = sc.must.join('\n');
    expect(must).toMatch(/cannot_do/);
    expect(must).toMatch(/record tool unavailable/);
    expect(must).toMatch(/a person from the program team will reply/);
    expect(sc.must_not.join('\n')).toMatch(/cannot see the worker's record/);
  });
});
