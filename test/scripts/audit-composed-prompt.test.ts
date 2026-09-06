/**
 * dimagi-internal/ace#2015 — the standing-domain preventer had no runtime
 * caller. `61e7a785` shipped `auditComposedPrompt()`; only its own test ever
 * called it, so what was enforced was "`skills/ocs-agent-setup/SKILL.md`
 * lists the four labels", never "the prompt this run composed carries them".
 *
 * `scripts/audit-composed-prompt.ts` is that caller, and its contract is an
 * EXIT CODE, because a boolean an agent is asked to check is another
 * checklist item and the checklist is what failed. So these cases spawn the
 * real script and read `status` — importing `main()` would test the audit
 * (already covered by `test/lib/standing-fabrication-domains.test.ts`) and
 * not the thing Step 7.5 actually depends on.
 *
 * The positive control is the verbatim `## Do not invent operational
 * specifics` section published as v3 on experiment 13033 — five bullets, all
 * five genuine PDD open questions, zero standing domains. The negative
 * control is the same section carrying the union. NON-INERTNESS: the two
 * differ only in the standing bullets, and they must produce different exit
 * codes; a script that exited 0 on everything would pass a suite that only
 * checked the good case.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STANDING_FABRICATION_DOMAINS } from '../../lib/standing-fabrication-domains.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/audit-composed-prompt.ts');

/** Verbatim v3, experiment 13033 — the prompt that shipped with none. */
const PROMPT_V3 = `You are the support assistant for this opportunity.

## Do not invent operational specifics

Several things about this pilot are genuinely undecided. When asked, say clearly that they are not yet decided and who decides — never fill the gap with a plausible answer:

- **No implementing organization (LLO) has been awarded.** The solicitation has not been published.
- The **districts, Traditional Authority and specific communities** are not determined.
- **Whether CBFs have smartphones and connectivity** is an open go/no-go question, not a settled fact.
- **Supervision ratios**, the number of CBFs and communities, and any per-person targets are not fixed.
- Whether CBFs record in this app **instead of, or in addition to,** Spark's existing app is unresolved.

Safety exception: if someone describes a situation involving immediate danger, harm or a safeguarding concern, tell them to seek help from local authorities and their supervisor straight away.

## Mandatory closing step — tagging

Every answer you give ends with a tag line.
`;

/** The same prompt with the standing half added — the union Step 7 mandates. */
const PROMPT_FIXED = PROMPT_V3.replace(
  'Safety exception:',
  [
    'These domains are off-limits on every opportunity, whatever the design says:',
    '',
    ...STANDING_FABRICATION_DOMAINS.map(
      (d) =>
        `- **${d.label}** — the programme has published no procedure unless one ` +
        'appears verbatim in the knowledge base. Say so plainly and route to the ' +
        'human who can answer; never improvise or infer one from the country or region.',
    ),
    '',
    'Safety exception:',
  ].join('\n'),
);

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ace-2015-audit-'));
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function runOn(prompt: string, extra: string[] = []) {
  const file = join(tmp, `prompt-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(file, prompt);
  return run([file, ...extra]);
}

function run(args: string[], input?: string) {
  const res = spawnSync('npx', ['tsx', SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    input,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('scripts/audit-composed-prompt.ts — the two controls', () => {
  it('POSITIVE CONTROL: the verbatim v3 prompt exits 1 and names all four domains', () => {
    const { code, stderr } = runOn(PROMPT_V3);
    expect(code).toBe(1);
    for (const d of STANDING_FABRICATION_DOMAINS) expect(stderr).toContain(d.label);
    expect(stderr).toContain('DO NOT publish this prompt');
  });

  it('NEGATIVE CONTROL: the prompt carrying the union exits 0', () => {
    const { code, stdout } = runOn(PROMPT_FIXED);
    expect(code).toBe(0);
    expect(stdout).toContain('[STANDING-DOMAINS] OK');
  });

  it('NON-INERTNESS: the two controls differ, so the gate is not exit-0-always', () => {
    expect(runOn(PROMPT_V3).code).not.toBe(runOn(PROMPT_FIXED).code);
  });
});

describe('scripts/audit-composed-prompt.ts — the ace#2015 fixture', () => {
  // The issue's own natural fixture: a composed prompt missing exactly the
  // `Safeguarding and emergency escalation` label. That is the domain whose
  // absence let chatbot 13029 answer opp-46 with "Nigeria emergency: 112 or
  // 199" — a number occurring nowhere in collection 570.
  const missingOne = PROMPT_FIXED.replace(
    /- \*\*Safeguarding and emergency escalation\*\*[\s\S]*?region\.\n/,
    '',
  );

  it('the fixture really does drop that one label and keep the rest', () => {
    expect(missingOne).not.toContain('Safeguarding and emergency escalation');
    expect(missingOne).toContain('Money movement and payment logistics');
    expect(missingOne).toContain('Account and credential recovery');
    expect(missingOne).toContain('Medical or legal instruction');
  });

  it('exits 1 naming only that domain', () => {
    const { code, stderr } = runOn(missingOne);
    expect(code).toBe(1);
    expect(stderr).toContain('1 standing domain(s) missing');
    expect(stderr).toContain('Safeguarding and emergency escalation');
    expect(stderr).not.toContain('Money movement and payment logistics');
  });
});

describe('scripts/audit-composed-prompt.ts — section absence', () => {
  it('exits 1 when the anti-fabrication section is gone entirely', () => {
    const { code, stderr } = runOn('# Bot\n\n## Payment rate\n\nThere is no rate.\n');
    expect(code).toBe(1);
    expect(stderr).toContain('no "## Do not invent operational specifics"');
  });

  it('a LATER section cannot satisfy the check on the earlier one', () => {
    const decoy = [
      '## Do not invent operational specifics',
      '',
      '- The districts are not determined.',
      '',
      '## Appendix',
      '',
      ...STANDING_FABRICATION_DOMAINS.map((d) => `- ${d.label}`),
      '',
    ].join('\n');
    expect(runOn(decoy).code).toBe(1);
  });
});

describe('scripts/audit-composed-prompt.ts — harness errors are exit 2, never a verdict', () => {
  it('no argument', () => {
    const { code, stderr } = run([]);
    expect(code).toBe(2);
    expect(stderr).toContain('no prompt given');
  });

  it('unreadable file', () => {
    const { code, stderr } = run([join(tmp, 'does-not-exist.md')]);
    expect(code).toBe(2);
    expect(stderr).toContain('cannot read prompt');
  });

  it('empty prompt — not reported as four missing domains', () => {
    const { code, stderr } = runOn('   \n\n');
    expect(code).toBe(2);
    expect(stderr).toContain('nothing to audit');
    expect(stderr).not.toContain('standing domain(s) missing');
  });

  it('an unknown flag is an error, not silently ignored', () => {
    const { code, stderr } = run(['--deep']);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown flag: --deep');
  });
});

describe('scripts/audit-composed-prompt.ts — the other input paths', () => {
  it('--stdin reads the prompt from stdin and grades it the same', () => {
    expect(run(['--stdin'], PROMPT_V3).code).toBe(1);
    expect(run(['--stdin'], PROMPT_FIXED).code).toBe(0);
  });

  it('--json emits a machine-readable verdict alongside the exit code', () => {
    const { code, stdout } = runOn(PROMPT_V3, ['--json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.section_present).toBe(true);
    expect(parsed.missing.map((m: { id: string }) => m.id).sort()).toEqual(
      STANDING_FABRICATION_DOMAINS.map((d) => d.id).sort(),
    );
  });
});
