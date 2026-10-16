import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

// ace#3043. Nova's upload_app_to_hq refuses an HQ space missing from Nova's
// stored domain list (`domain_not_authorized`), and a fresh space is missing
// by construction. `app-case-sharing` authored in Nova first and only found
// out at its upload step — case-sharing test run 20261016-0618 (cloud runner),
// where the refresh then stopped on Google 2FA after the build was spent.
//
// Rule: an entry point that both AUTHORS in Nova and UPLOADS to HQ must run
// the `get_hq_connection` → `scripts/nova-refresh-hq-domains.ts` gate BEFORE
// its first authoring call. Phase 3 skills dispatched by
// agents/commcare-setup.md inherit that agent's Step 0, and an agent that
// dispatches `Agent(commcare-setup)` inherits it too — both are exempt.
const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const UPLOAD = /upload_app_to_hq|nova:upload_to_hq/;
const REFRESH = 'nova-refresh-hq-domains';

function firstAuthoringIndex(text: string): number {
  const bw = text.indexOf('begin_work');
  if (bw >= 0) return bw;
  return text.indexOf('/nova:autobuild');
}

/** null = compliant; otherwise the reason it is not. */
export function refreshGateViolation(text: string): string | null {
  if (!UPLOAD.test(text)) return null;
  const author = firstAuthoringIndex(text);
  if (author < 0) return null;
  const refresh = text.indexOf(REFRESH);
  if (refresh < 0) return 'uploads to HQ and authors in Nova but never runs nova-refresh-hq-domains';
  if (refresh > author) return 'runs nova-refresh-hq-domains only AFTER its first Nova authoring call';
  return null;
}

function entryPoints(): string[] {
  const skills = readdirSync(join(root, 'skills'))
    .filter((d) => !d.startsWith('_') && existsSync(join(root, 'skills', d, 'SKILL.md')))
    .map((d) => `skills/${d}/SKILL.md`);
  const agents = readdirSync(join(root, 'agents'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `agents/${f}`);
  return [...skills, ...agents];
}

describe('Nova HQ-domain refresh runs before Nova authoring (ace#3043)', () => {
  const commcareSetup = read('agents/commcare-setup.md');

  it('negative controls: the check fails on the shapes it exists to catch', () => {
    expect(refreshGateViolation('2. begin_work …\n5. upload_app_to_hq to the space')).toMatch(/never runs/);
    expect(
      refreshGateViolation(`2. begin_work …\n5. upload_app_to_hq; on refusal run scripts/${REFRESH}.ts`),
    ).toMatch(/AFTER/);
    expect(refreshGateViolation(`0. get_hq_connection; scripts/${REFRESH}.ts\n2. begin_work\n5. upload_app_to_hq`)).toBeNull();
  });

  it('commcare-setup Step 0 itself carries the gate', () => {
    expect(refreshGateViolation(commcareSetup)).toBeNull();
    expect(commcareSetup.indexOf(REFRESH)).toBeLessThan(commcareSetup.indexOf('### Step 1: PDD to Apps'));
  });

  it('app-case-sharing runs it in a Step 0 before authoring', () => {
    const s = read('skills/app-case-sharing/SKILL.md');
    expect(refreshGateViolation(s)).toBeNull();
    const step0 = s.slice(s.indexOf('0. **Prove Nova can upload'), s.indexOf('1. **Design the levels'));
    expect(step0).toMatch(/get_hq_connection/);
    expect(step0).toMatch(/exit 2/);
    expect(step0).toMatch(/exit 3/);
  });

  it('every other entry point that authors + uploads is gated or inherits commcare-setup Step 0', () => {
    const offenders: string[] = [];
    for (const p of entryPoints()) {
      const text = read(p);
      const violation = refreshGateViolation(text);
      if (!violation) continue;
      const skillName = p.startsWith('skills/') ? p.split('/')[1] : null;
      if (skillName && commcareSetup.includes(skillName)) continue; // Phase 3 sub-skill
      if (text.includes('Agent(commcare-setup)')) continue; // dispatches Phase 3
      offenders.push(`${p}: ${violation}`);
    }
    expect(offenders).toEqual([]);
  });
});
