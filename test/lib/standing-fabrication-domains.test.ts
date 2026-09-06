/**
 * Seam test for the standing half of the composed prompt's anti-fabrication
 * list (dimagi-internal/ace#1890 sibling — the PREVENTER to
 * `fabrication-clamp.ts`'s detector).
 *
 * The fixture is not invented. `PROMPT_V3_SECTION` is the
 * `## Do not invent operational specifics` section of the system prompt
 * published as version 3 on chatbot 075abf86-b9bb-476f-8b9e-eed1d1f24785
 * (experiment 13033, team `connect-ace`, collection 571) — the prompt the
 * widget actually served for the `spark-facilitator/20260828-0703` deep run
 * that scored 8.03 and still gated `iterate` on two Fails, opp-50 (an
 * improvised cash-handover pathway) and opp-56 (an invented PersonalID
 * recovery chain).
 *
 * That section is five bullets long and every bullet is a genuine PDD open
 * question. Neither money movement nor account recovery is an open question in
 * that PDD, so neither appeared — which is precisely the class: the list bars
 * invention where the PDD happened to be uncertain and is silent where a
 * fabrication costs a field worker the most.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  STANDING_FABRICATION_DOMAINS,
  ANTI_FABRICATION_HEADING,
  extractAntiFabricationSection,
  auditComposedPrompt,
  formatStandingDomainReport,
} from '../../lib/standing-fabrication-domains.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const agentSetup = readFileSync(`${ROOT}skills/ocs-agent-setup/SKILL.md`, 'utf8');

/** Verbatim, as published in v3. The measured negative control. */
const PROMPT_V3_SECTION = `## Do not invent operational specifics

Several things about this pilot are genuinely undecided. When asked, say clearly that they are not yet decided and who decides — never fill the gap with a plausible answer:

- **No implementing organization (LLO) has been awarded.** The solicitation has not been published.
- The **districts, Traditional Authority and specific communities** are not determined.
- **Whether CBFs have smartphones and connectivity** is an open go/no-go question, not a settled fact.
- **Supervision ratios**, the number of CBFs and communities, and any per-person targets are not fixed.
- Whether CBFs record in this app **instead of, or in addition to,** Spark's existing app is unresolved.

Safety exception: if someone describes a situation involving immediate danger, harm or a safeguarding concern, tell them to seek help from local authorities and their supervisor straight away.

## Mandatory closing step — tagging

Every answer you give ends with a tag line.`;

/** The same section as the union of (PDD open questions) + (standing set). */
const PROMPT_FIXED_SECTION = `## Do not invent operational specifics

Several things about this pilot are genuinely undecided:

- **No implementing organization (LLO) has been awarded.**
- The **districts, Traditional Authority and specific communities** are not determined.

These domains are off-limits on every opportunity, whatever the design says:

- **Money movement and payment logistics** — never improvise one.
- **Account and credential recovery** — never improvise one.
- **Safeguarding and emergency escalation** — never improvise a reporting chain.
- **Medical or legal instruction** — never supply one.

## Mandatory closing step — tagging`;

describe('the standing set is well-formed', () => {
  it('carries the four domains the class requires, with stable ids', () => {
    expect(STANDING_FABRICATION_DOMAINS.map((d) => d.id)).toEqual([
      'money-movement',
      'credential-recovery',
      'safeguarding-escalation',
      'medical-legal-instruction',
    ]);
  });

  it('gives every domain a label and a reason invention there is high-cost', () => {
    for (const d of STANDING_FABRICATION_DOMAINS) {
      expect(d.label.length, `${d.id} needs a label`).toBeGreaterThan(0);
      expect(d.why.length, `${d.id} needs a rationale`).toBeGreaterThan(40);
    }
  });
});

describe('extractAntiFabricationSection', () => {
  it('returns null when the prompt has no such section', () => {
    expect(extractAntiFabricationSection('## Payment RATE\n\nThere is no rate.')).toBeNull();
  });

  it('stops at the next heading, so a later section cannot satisfy this one', () => {
    const section = extractAntiFabricationSection(PROMPT_V3_SECTION);
    expect(section).not.toBeNull();
    expect(section).toContain('Traditional Authority');
    expect(section, 'the tagging section must not bleed in').not.toContain('ends with a tag line');
  });
});

describe('auditComposedPrompt — the measured v3 prompt', () => {
  const audit = auditComposedPrompt(PROMPT_V3_SECTION);

  it('finds the section but fails the audit', () => {
    expect(audit.sectionPresent).toBe(true);
    expect(audit.ok).toBe(false);
  });

  it('reports ALL FOUR standing domains missing — including the two that gated the run', () => {
    expect(audit.missing.map((d) => d.id).sort()).toEqual([
      'credential-recovery',
      'medical-legal-instruction',
      'money-movement',
      'safeguarding-escalation',
    ]);
  });

  it('is not fooled by the closing safety paragraph', () => {
    // The v3 section literally contains "safeguarding" and "harm". A keyword
    // scan would score safeguarding-escalation as covered; it is not, because
    // that paragraph protects the safety INSTINCT and forbids no invention.
    expect(audit.section).toContain('safeguarding concern');
    expect(audit.covered).not.toContain('safeguarding-escalation');
  });

  it('names every missing domain in the operator report', () => {
    const report = formatStandingDomainReport(audit);
    for (const d of STANDING_FABRICATION_DOMAINS) expect(report).toContain(d.label);
  });
});

describe('auditComposedPrompt — a prompt carrying the union', () => {
  const audit = auditComposedPrompt(PROMPT_FIXED_SECTION);

  it('passes with every standing domain covered', () => {
    expect(audit.ok).toBe(true);
    expect(audit.missing).toEqual([]);
    expect(audit.covered).toHaveLength(STANDING_FABRICATION_DOMAINS.length);
  });

  it('emits no report when it passes', () => {
    expect(formatStandingDomainReport(audit)).toBe('');
  });

  it('still fails if a single standing domain is dropped', () => {
    const dropped = PROMPT_FIXED_SECTION.replace(
      /- \*\*Account and credential recovery\*\*.*\n/,
      '',
    );
    const a = auditComposedPrompt(dropped);
    expect(a.ok).toBe(false);
    expect(a.missing.map((d) => d.id)).toEqual(['credential-recovery']);
  });

  it('fails loudly when the section is deleted outright', () => {
    const a = auditComposedPrompt('## Payment RATE\n\nThere is no rate.');
    expect(a.sectionPresent).toBe(false);
    expect(a.missing).toHaveLength(STANDING_FABRICATION_DOMAINS.length);
    expect(formatStandingDomainReport(a)).toContain('no "## Do not invent operational specifics"');
  });
});

/**
 * The half that makes this a preventer rather than a library nobody calls:
 * `ocs-agent-setup` § Step 7 is what composes the prompt, so the standing set
 * must be stated THERE, in the instruction the composer reads.
 */
describe('ocs-agent-setup § Step 7 mandates the standing set', () => {
  it('names the anti-fabrication section by its heading', () => {
    expect(agentSetup).toContain(ANTI_FABRICATION_HEADING);
  });

  it('states the list is the UNION of PDD open questions and a standing set', () => {
    expect(agentSetup.toLowerCase()).toMatch(/union of/);
    expect(agentSetup.toLowerCase()).toMatch(/open questions/);
  });

  it('carries every standing domain label verbatim', () => {
    for (const d of STANDING_FABRICATION_DOMAINS) {
      expect(
        agentSetup,
        `ocs-agent-setup § Step 7 must name the standing domain "${d.label}" — ` +
          'a prompt composed without it fabricates there, which is how ' +
          'spark-facilitator/20260828-0703 gated iterate on opp-50 and opp-56.',
      ).toContain(d.label);
    }
  });

  it('points the composer at this module so the invariant is discoverable', () => {
    expect(agentSetup).toContain('lib/standing-fabrication-domains.ts');
  });
});

/**
 * dimagi-internal/ace#2015 — the block above pins that the DOCUMENT lists the
 * labels. It cannot see the prompt any given run composes, because that prompt
 * is authored at run time by an agent reading the document and pushed straight
 * to OCS. So on its own the invariant reduces to "the agent followed the
 * checklist" — the prose-does-not-bind mode `61e7a785` was written to escape.
 *
 * What closes it is a gate with an exit code, wired between composition and
 * publish. These assertions are the sibling of
 * `test/lib/emergency-number-fabrication.test.ts` § "the skill wires the pass
 * in — it is not dead code", and they are what stops the caller being quietly
 * deleted again.
 */
describe('the skill wires the gate in — it is not dead code (ace#2015)', () => {
  const scriptPath = `${ROOT}scripts/audit-composed-prompt.ts`;

  it('the runtime caller exists and calls the audit', () => {
    const script = readFileSync(scriptPath, 'utf8');
    expect(script).toContain('auditComposedPrompt');
    expect(script).toContain('formatStandingDomainReport');
  });

  it('ocs-agent-setup invokes that script', () => {
    expect(agentSetup).toContain('scripts/audit-composed-prompt.ts');
  });

  it('the gate runs BEFORE the publish, not after', () => {
    // Step 8's `ocs_set_chatbot_pipeline` is the only write that puts a prompt
    // on the bot. A check ordered after it finds a live bot already serving
    // the defective prompt.
    const gate = agentSetup.indexOf('scripts/audit-composed-prompt.ts');
    const publish = agentSetup.indexOf('ocs_set_chatbot_pipeline({ experiment_id, prompt,');
    expect(gate, 'the audit invocation must be present').toBeGreaterThan(-1);
    expect(publish, "Step 8's pipeline call must be present").toBeGreaterThan(-1);
    expect(gate).toBeLessThan(publish);
  });

  it('the gate has halt semantics, not advisory ones', () => {
    const step = agentSetup.slice(
      agentSetup.indexOf('7.5.'),
      agentSetup.indexOf('8. **Patch the chatbot'),
    );
    expect(step).toMatch(/do NOT call `ocs_set_chatbot_pipeline`/i);
    expect(step).toMatch(/exits?\s+\*\*0\*\*|exits \*\*0\*\*|\*\*0\*\*/);
  });

  it('the `--prompt-patch` re-run path is not exempt from the gate', () => {
    // Step 0's patch branch also reaches Step 8 through Step 7, so it can drop
    // a standing domain exactly as a fresh compose can.
    const step0 = agentSetup.slice(
      agentSetup.indexOf('State file present, `--prompt-patch` flag set.'),
      agentSetup.indexOf('State file present, no flag.'),
    );
    expect(step0).toContain('Step 7.5');
  });
});
