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
  CONTACT_EXACTNESS_OBLIGATIONS,
  auditContactExactness,
  extractContactProtectionBlocks,
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

/**
 * dimagi-internal/ace#2216 — the union of (PDD open questions) + (standing
 * set), and NO contact-exactness clause. This is the shape that shipped on
 * `spark-facilitator/20260907-1120`: all four standing domains present, zero
 * `@` anywhere in the prompt, exit 0 under the four-assertion audit. The bot
 * then answered prompt 1 of the 3-prompt quick gate with
 * *"For escalation beyond that, reach out to ace@dimagi.com."*
 *
 * The golden template owned that protection — it names the exact address AND
 * forbids the wrong spelling by name — but Step 8's `ocs_set_chatbot_pipeline`
 * sets `patch.prompt` wholesale (`mcp/ocs/backends/playwright.ts`), so the
 * composed prompt REPLACES it rather than extending it and no per-opp bot ever
 * serves the guard.
 */
const PROMPT_NO_CONTACT_CLAUSE = `## Do not invent operational specifics

Several things about this pilot are genuinely undecided:

- **No implementing organization (LLO) has been awarded.**
- The **districts, Traditional Authority and specific communities** are not determined.

These domains are off-limits on every opportunity, whatever the design says:

- **Money movement and payment logistics** — never improvise one.
- **Account and credential recovery** — never improvise one.
- **Safeguarding and emergency escalation** — never improvise a reporting chain.
- **Medical or legal instruction** — never supply one.

## Mandatory closing step — tagging`;

/**
 * The exactness clause `ocs-agent-setup` § Step 7 mandates. It names NO
 * address: the value still comes from retrieval (ace#1665). What it carries is
 * the golden guard's load-bearing half — quote it verbatim, never from general
 * knowledge, never vary the spelling.
 */
const CONTACT_CLAUSE =
  "Contacts for this opportunity — the ACE admin group's escalation address " +
  'and every named contact — are in the opportunity knowledge base. Quote them ' +
  'verbatim from there. If a contact you need is not published, say the ' +
  'programme has not published one and offer the ACE admin group; never supply ' +
  'an address from general knowledge or vary the spelling of one.';

/** The same prompt with the contact-exactness clause restored. */
const PROMPT_FIXED_SECTION = PROMPT_NO_CONTACT_CLAUSE.replace(
  '## Mandatory closing step — tagging',
  `## Escalation and contacts\n\n${CONTACT_CLAUSE}\n\n## Mandatory closing step — tagging`,
);

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
 * dimagi-internal/ace#2216 — the FIFTH assertion.
 *
 * The four standing domains live INSIDE `## Do not invent operational
 * specifics`. The protection the golden template owned does not: it is a
 * contact-exactness clause, and it is the half that the composed prompt
 * silently dropped. `ocs-agent-setup` § Step 7 asserted the golden guard
 * "stays as written — it is the cold-start fallback" and told authors not to
 * restate it; Step 8 sets `patch.prompt` wholesale, so it survives only in the
 * window before the publish, i.e. only while nobody is talking to the bot.
 *
 * The class is NOT "the prompt said ace@dimagi.com". It is "the composed
 * prompt dropped a protection the template owned", so the audit asserts the
 * three load-bearing halves of that protection and never a literal address —
 * a check that greps one wrong spelling passes the next variant, and the same
 * class has already produced an invented `pm@dimagi-ai.com`
 * (hh-poverty-targeting/20260824-1404).
 */
describe('the contact-exactness obligations are well-formed', () => {
  it('carries the three halves of the protection, with stable ids', () => {
    expect(CONTACT_EXACTNESS_OBLIGATIONS.map((o) => o.id)).toEqual([
      'quote-verbatim',
      'no-general-knowledge',
      'no-spelling-variation',
    ]);
  });

  it('gives every obligation a label and a reason', () => {
    for (const o of CONTACT_EXACTNESS_OBLIGATIONS) {
      expect(o.label.length, `${o.id} needs a label`).toBeGreaterThan(0);
      expect(o.why.length, `${o.id} needs a rationale`).toBeGreaterThan(40);
    }
  });

  it('names no email address — the value comes from retrieval (ace#1665)', () => {
    for (const o of CONTACT_EXACTNESS_OBLIGATIONS) {
      expect(o.pattern.source, `${o.id} must not hardcode an address`).not.toMatch(/@/);
    }
  });
});

describe('extractContactProtectionBlocks', () => {
  it('returns the blocks that actually talk about contacts', () => {
    const blocks = extractContactProtectionBlocks(PROMPT_FIXED_SECTION);
    expect(blocks.join('\n')).toContain('escalation address');
  });

  it('finds none in the ace#2216 fixture — that is the defect', () => {
    expect(extractContactProtectionBlocks(PROMPT_NO_CONTACT_CLAUSE)).toEqual([]);
  });

  it('does not let a verbatim rule about something ELSE count as contact cover', () => {
    // A blanket "quote verbatim" about payment amounts is not a contact
    // protection, and scoping is what stops it reading as one.
    const decoy = [
      'Never state a payment amount unless it appears verbatim in the knowledge',
      'base, and never supply one from general knowledge or vary the spelling.',
      '',
      'The escalation address is in the knowledge base.',
    ].join('\n');
    expect(auditContactExactness(decoy).ok).toBe(false);
  });
});

describe('auditComposedPrompt — the ace#2216 contact-exactness gap', () => {
  it('the fixture really is the shape that shipped: four domains, no address', () => {
    expect(PROMPT_NO_CONTACT_CLAUSE).not.toContain('@');
    expect(auditComposedPrompt(PROMPT_NO_CONTACT_CLAUSE).missing).toEqual([]);
  });

  it('FAILS it — a complete standing half no longer buys an exit 0', () => {
    const audit = auditComposedPrompt(PROMPT_NO_CONTACT_CLAUSE);
    expect(audit.ok).toBe(false);
    expect(audit.contactExactness.ok).toBe(false);
    expect(audit.contactExactness.missing.map((o) => o.id)).toEqual(
      CONTACT_EXACTNESS_OBLIGATIONS.map((o) => o.id),
    );
  });

  it('names every missing obligation in the operator report', () => {
    const report = formatStandingDomainReport(auditComposedPrompt(PROMPT_NO_CONTACT_CLAUSE));
    for (const o of CONTACT_EXACTNESS_OBLIGATIONS) expect(report).toContain(o.label);
  });

  it('PASSES once the clause Step 7 mandates is present', () => {
    const audit = auditComposedPrompt(PROMPT_FIXED_SECTION);
    expect(audit.ok).toBe(true);
    expect(audit.contactExactness.missing).toEqual([]);
  });

  it('is not satisfied by inlining the RIGHT address', () => {
    // ace#1665: an address the prompt carries and the corpus does not is
    // reproduced from recall. Inlining the value is not the protection, and
    // must not buy a pass.
    const inlined = PROMPT_NO_CONTACT_CLAUSE.replace(
      '## Mandatory closing step',
      'Escalate to the ACE admin group at ace@dimagi-ai.com.\n\n## Mandatory closing step',
    );
    expect(auditComposedPrompt(inlined).ok).toBe(false);
  });

  it('is not a grep for one wrong domain either', () => {
    // The literal-string fix the issue warns against: banning the one spelling
    // that drifted. It says nothing about the next variant.
    const oneDomain = PROMPT_NO_CONTACT_CLAUSE.replace(
      '## Mandatory closing step',
      'Never use the address ace@dimagi.com.\n\n## Mandatory closing step',
    );
    expect(auditComposedPrompt(oneDomain).ok).toBe(false);
  });

  it('requires all three halves — dropping any ONE fails', () => {
    const ablations: [string, string, string][] = [
      ['quote-verbatim', 'Quote them verbatim from there.', 'Quote them from there.'],
      [
        'no-general-knowledge',
        'never supply an address from general knowledge or vary the spelling of one',
        'never vary the spelling of one',
      ],
      [
        'no-spelling-variation',
        'never supply an address from general knowledge or vary the spelling of one',
        'never supply an address from general knowledge',
      ],
    ];
    for (const [id, from, to] of ablations) {
      const weakened = PROMPT_FIXED_SECTION.replace(from, to);
      expect(weakened, `ablation for ${id} must actually change the prompt`).not.toBe(
        PROMPT_FIXED_SECTION,
      );
      const audit = auditComposedPrompt(weakened);
      expect(audit.ok, `dropping ${id} must fail the audit`).toBe(false);
      expect(audit.contactExactness.missing.map((o) => o.id)).toEqual([id]);
    }
  });
});

/**
 * The strongest available control that the audit measures the protection the
 * TEMPLATE owned rather than a phrasing invented here: run it against the
 * golden template's own guard, read off disk. If that guard ever loses one of
 * the three halves this fails, which is the right outcome — the composed
 * prompt is only being asked to carry what the template carried.
 */
describe('the golden template guard satisfies the audit (ace#2216)', () => {
  const bootstrap = readFileSync(`${ROOT}scripts/bootstrap-ocs-golden-template.ts`, 'utf8');
  const literal = /const GOLDEN_TEMPLATE_PROMPT = `([\s\S]*?)\n`;/.exec(bootstrap);

  it('the golden prompt is still extractable from the bootstrap script', () => {
    expect(literal, 'GOLDEN_TEMPLATE_PROMPT literal not found').not.toBeNull();
    expect(literal![1]).toContain('any other spelling');
  });

  it('carries all three halves of the contact protection', () => {
    const audit = auditContactExactness(literal![1]);
    expect(audit.missing.map((o) => o.id)).toEqual([]);
    expect(audit.ok).toBe(true);
  });
});

/**
 * ace#2216 — Step 7 is where the false claim lived, and a doc that misstates
 * the mechanism is part of the defect: the composer only skipped the
 * protection because Step 7 said it was already there.
 */
describe('ocs-agent-setup § Step 7 states the replacement fact (ace#2216)', () => {
  it('never claims the golden guard is a cold-start fallback without retracting it', () => {
    // The phrase may still APPEAR — Step 7 quotes the retracted wording so a
    // future reader recognises it, and the 2026-08-26 changelog row is
    // history. What must not survive is an un-retracted claim: Step 8 sets
    // `patch.prompt` wholesale, so the guard is live only before the publish,
    // i.e. only while nobody is talking to the bot.
    const RETRACTION = /(ace#2216|was false|is superseded|superseded by)/i;
    for (let i = agentSetup.indexOf('cold-start fallback'); i !== -1; ) {
      const window = agentSetup.slice(Math.max(0, i - 500), i + 500);
      expect(
        RETRACTION.test(window),
        `"cold-start fallback" at offset ${i} is stated without a retraction ` +
          'nearby. The golden guard does not survive Step 8\'s publish.',
      ).toBe(true);
      i = agentSetup.indexOf('cold-start fallback', i + 1);
    }
  });

  it('says the publish REPLACES the prompt, and names the call that does it', () => {
    const step7 = agentSetup.slice(
      agentSetup.indexOf('7. **Compose the system prompt'),
      agentSetup.indexOf('7.5.'),
    );
    expect(step7).toMatch(/REPLACE/i);
    expect(step7).toContain('ocs_set_chatbot_pipeline');
  });

  it('mandates a clause that itself passes the audit — doc and gate cannot drift', () => {
    const start = agentSetup.indexOf('The composed prompt MUST say, as two obligations:');
    expect(start, 'Step 7 must still mandate the obligations verbatim').toBeGreaterThan(-1);
    const mandated = agentSetup.slice(start, agentSetup.indexOf('- **Carry a `## Do not invent'));
    const audit = auditContactExactness(mandated);
    expect(
      audit.missing.map((o) => o.label),
      'the text Step 7 tells the composer to write must satisfy Step 7.5',
    ).toEqual([]);
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
