import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Who may steer ACE is canopy-web's decision — never a file in this repo.
 *
 * canopy routes every inbound turn and hands the session a caller envelope;
 * `canopy caller tier` (canopy `src/orchestrator/caller.py`) reads `granted_by`
 * and consults a repo `config/allowlist.txt` ONLY for an agent with no declared
 * interface. ACE has one, so the allowlist granted nothing: Sophie Feintuch's
 * 2026-09-11 act-tier grant sat in it while every mail she sent was confined
 * to `/ace:ask` (ace@ thread 1a10d0eb3419ae9f, 2026-10-07). The confined session
 * then promised "the ACE team will pick this up" — a team that has no queue.
 *
 * Pinned here: the allowlist stays gone, nothing names it as an authority, the
 * triage skill says canopy-web decides, and answer-caller commits nobody.
 *
 * ace#2389 (allowlist had no enforcement); dimagi-internal/canopy-web#1265
 * (member mail from an unaligned domain is silently demoted to contact).
 */

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(md|ts|py|sh|json|ya?ml)$/.test(name) || !name.includes('.')) out.push(rel);
  }
  return out;
}

describe('canopy-web decides who may steer ACE', () => {
  it('the repo allowlist stays retired', () => {
    expect(existsSync(join(ROOT, 'config/allowlist.txt'))).toBe(false);
  });

  it('no live doc or code names config/allowlist.txt as an authority', () => {
    const files = ['persona.md', ...['skills', 'agents', 'commands', 'lib', 'bin', 'hooks'].flatMap((d) => walk(d))];
    const hits = files.filter((f) => read(f).includes('config/allowlist.txt'));
    expect(hits.map((f) => relative(ROOT, join(ROOT, f)))).toEqual([]);
    // CLAUDE.md may name it once, as retired.
    const claude = read('CLAUDE.md');
    for (const line of claude.split('\n').filter((l) => l.includes('config/allowlist.txt'))) {
      expect(line).toMatch(/retired/);
    }
  });

  it('inbox-triage § Counterpart tiers says canopy-web decides and keeps correspond derived', () => {
    const doc = read('skills/inbox-triage/SKILL.md');
    const t = flat(doc.slice(doc.indexOf('## Counterpart tiers'), doc.indexOf('## Noise classification')));
    expect(t).toMatch(/canopy-web decides who may steer ACE/);
    expect(t).toContain('canopy caller tier --caller <path> --repo .');
    expect(t).toMatch(/granted_by/);
    expect(t).toMatch(/\*\*Never\*\* run-state mutations/);
    expect(t).toMatch(/correspond-tier sender is \*derived, not maintained\*/);
    expect(t).toMatch(/this_message_grade/);
  });
});

describe('answer-caller commits nobody to future work', () => {
  const body = () => read('skills/answer-caller/SKILL.md');

  it('never prescribes handing off to a team', () => {
    expect(body()).not.toMatch(/will pick (this|it) up/i);
    expect(body()).not.toMatch(/ACE team (will|can)/i);
  });

  it('requires a real review, not just the receipt', () => {
    expect(flat(body())).toMatch(/Review the draft yourself first/);
  });

  it('names the unproven-member case', () => {
    expect(flat(body())).toMatch(/already a member who couldn't be proven/);
  });
});
