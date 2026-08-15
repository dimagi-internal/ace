/**
 * A doc must not prescribe a CLI flag the script does not parse — nor, for the
 * flags a script REQUIRES, omit them.
 *
 * ace#1437. #971 fixed `run-form-walk.ts` to take `--draft-only` and never
 * updated `app-hq-settings § Step 2`, so at the same installed version
 * (0.13.885) the script had the flag 6 times and the skill had it zero. An
 * agent following the doc literally got `download_ccz failed: status=404` on
 * every first-time run.
 *
 * That 404 did not stay quiet: the skill is fail-soft, so the run proceeded
 * with grid menu display never applied, and `app-release-qa` BLOCKER-gates all
 * three grid fields — a Phase 3 halt two steps later whose cause was three
 * steps upstream and disguised as a release-QA failure. Recovery on the live
 * run depended on the executing agent going and reading the script; an agent
 * that trusted the doc would have skipped.
 *
 * The class is mechanically detectable and has cost two runs, which is what
 * this file is for.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');

/** Long flags the script's own arg parser compares against. */
function flagsParsedBy(scriptRel: string): Set<string> {
  const src = readFileSync(join(REPO, scriptRel), 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/a === '(--[a-z0-9-]+)'/g)) out.add(m[1]);
  return out;
}

/** Long flags a doc hands to that script, from its invocation lines. */
function flagsPrescribedFor(docText: string, scriptBase: string): Set<string> {
  const out = new Set<string>();
  for (const line of docText.split('\n')) {
    if (!line.includes(scriptBase)) continue;
    for (const m of line.matchAll(/(--[a-z0-9-]+)/g)) out.add(m[1]);
  }
  return out;
}

function allDocs(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(REPO, dir))) {
    const rel = `${dir}/${e}`;
    if (statSync(join(REPO, rel)).isDirectory()) allDocs(rel, acc);
    else if (e.endsWith('.md')) acc.push(rel);
  }
  return acc;
}

const SCRIPTS = ['scripts/run-form-walk.ts'];
const DOCS = [...allDocs('skills'), ...allDocs('agents'), ...allDocs('commands')];

describe('no doc prescribes a flag its script does not parse (ace#1437)', () => {
  it.each(SCRIPTS)('%s', (scriptRel) => {
    const base = scriptRel.split('/').pop()!;
    const parsed = flagsParsedBy(scriptRel);
    expect(parsed.size, `no flags parsed out of ${scriptRel} — the extractor drifted`)
      .toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const doc of DOCS) {
      const text = readFileSync(join(REPO, doc), 'utf8');
      for (const flag of flagsPrescribedFor(text, base)) {
        // `--prefix` belongs to npx, not the script.
        if (flag === '--prefix') continue;
        if (!parsed.has(flag)) offenders.push(`${doc} prescribes ${flag}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('app-hq-settings Step 2 carries the flags its position requires', () => {
  const skill = readFileSync(join(REPO, 'skills/app-hq-settings/SKILL.md'), 'utf8');
  const invocation = skill
    .split('\n')
    .find((l) => l.includes('run-form-walk.ts') && l.includes('WALK_OUT'));

  it('has an invocation at all', () => {
    expect(invocation).toBeTruthy();
  });

  it('passes --draft-only — the draft has never been built at Step 2.65', () => {
    expect(invocation).toContain('--draft-only');
  });

  it('passes --with-fields — Step 3 triggers on kind: image', () => {
    expect(invocation).toContain('--with-fields');
  });

  it('explains WHY, so the flag is not dropped again as noise', () => {
    expect(skill).toMatch(/REQUIRED at this pipeline position/);
    expect(skill).toContain('status=404');
  });

  it('the tool-signature line matches the real usage string', () => {
    const sig = skill.split('\n').find((l) => l.includes('`scripts/run-form-walk.ts <domain>'));
    expect(sig).toContain('--draft-only');
    expect(sig).toContain('--out-scratch');
  });
});
