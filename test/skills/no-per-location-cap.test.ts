import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ACE must not ask a PDD for a PER-LOCATION visit cap, because nothing can
 * enforce one.
 *
 * ## The failure class
 *
 * `skills/idea-to-pdd/SKILL.md` § `atomic-visit` used to list, among the
 * questions every atomic-visit PDD must answer:
 *
 *     - What's the per-FLW and per-location daily cap?
 *
 * So every atomic-visit PDD invented one. On
 * `turmeric-market-study/20260916-1650` that produced a documented rule of
 * five vendor surveys per market per day — carried into the Program
 * Parameters table, the Evidence Model and the FLW-facing rules — which the
 * platform cannot honour in any layer:
 *
 *   - **Connect caps per WORKER, not per place.** A payment unit's only two
 *     caps are `max_daily` and `max_total`, both per worker
 *     (`skills/connect-opp-setup/SKILL.md` § payment unit).
 *   - **A CommCare form cannot count other workers' submissions.** They are
 *     offline until sync, so no form logic can see a market's running total.
 *
 * The cost is not a missing feature, it is a false commitment: over-cap visits
 * are still paid, while the PDD, the Work Order and the FLW training all state
 * a limit. The operator's ruling (2026-09-16) was to remove it everywhere
 * rather than keep documenting it as unenforced — an unenforceable rule should
 * not be written down as a rule.
 *
 * A campaign-wide total is a separate thing and is NOT a cap field: it is
 * carried by `total_budget`, because Connect derives
 * `number_of_users = total_budget / Σ(max_total × (amount + org_amount))`.
 *
 * ## Why a test rather than prose
 *
 * The prose that created the problem WAS the guidance — one bullet in an
 * archetype's question list, reached by every atomic-visit run. `CLAUDE.md`'s
 * standing rule is that invariants are hooks, not memory; prose relies on the
 * model choosing to comply, which fails under load. This is the hook.
 */

const SKILLS_DIR = join(__dirname, '..', '..', 'skills');

/**
 * Lines that MENTION a per-location cap legitimately. Keep this list tiny and
 * justify every entry — an allowlist is how a rail rots.
 */
const ALLOWED = [
  {
    skill: 'pdd-to-test-prompts',
    needle: 'since the per-market cap',
    why:
      'A deliberate FALSE PREMISE in the `leading-question` adversarial category — the ' +
      'chatbot is supposed to CORRECT it. Dropping the concept from ACE makes this example ' +
      'more correct, not less.',
  },
  {
    skill: 'idea-to-pdd',
    needle: '**Do NOT specify a per-location cap**',
    why: 'The prohibition itself.',
  },
  {
    skill: 'flw-data-review',
    needle: 'do not assume a per-location cap',
    why: 'The prohibition, restated where the review criteria live.',
  },
];

/** Prescriptive phrasings — "state a per-location cap", not "never state one". */
const PRESCRIBES_PER_LOCATION_CAP =
  /(?:per[- ]location|per[- ]market|per[- ]village|per[- ]facility|per[- ]site)\s+(?:daily\s+)?cap|cap\s+per\s+(?:location|market|village|facility|site)|\b\d+\s+(?:vendors?|visits?|surveys?)\s+per\s+(?:market|village|facility|site)\b/i;

function skillFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(SKILLS_DIR)) {
    const p = join(SKILLS_DIR, entry, 'SKILL.md');
    try {
      if (statSync(p).isFile()) out.push(p);
    } catch {
      /* not a skill directory */
    }
  }
  return out;
}

describe('no skill prescribes an unenforceable per-location visit cap', () => {
  it('finds no prescriptive per-location cap outside the allowlist', () => {
    const offenders: string[] = [];

    for (const file of skillFiles()) {
      const skill = file.split('/').slice(-2)[0];
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!PRESCRIBES_PER_LOCATION_CAP.test(line)) return;
          const allowed = ALLOWED.some((a) => a.skill === skill && line.includes(a.needle));
          if (!allowed) offenders.push(`${skill}/SKILL.md:${i + 1}: ${line.trim()}`);
        });
    }

    expect(
      offenders,
      'A per-location cap cannot be enforced: Connect caps per worker (`max_daily` / ' +
        '`max_total`) and a CommCare form cannot see other workers\' offline submissions. ' +
        'Stating one commits the programme to a rule that will not hold, while over-cap ' +
        'visits still get paid. Express coverage spreading as LLO supervisory practice in ' +
        'operations guidance instead. If a mention is legitimate (e.g. a deliberate false ' +
        'premise for an adversarial test prompt), add it to ALLOWED with a reason.',
    ).toEqual([]);
  });

  it('idea-to-pdd asks for the two caps Connect actually enforces', () => {
    const body = readFileSync(join(SKILLS_DIR, 'idea-to-pdd', 'SKILL.md'), 'utf8');

    expect(body).toContain('**Do NOT specify a per-location cap**');
    // The replacement must name both real fields, or the question stops being answerable.
    expect(body).toMatch(/`max_daily`/);
    expect(body).toMatch(/`max_total`/);
    // And must say where a campaign-wide total actually lives.
    expect(body).toMatch(/total_budget/);
  });

  it('flw-data-review reviews against per-worker caps, not per-location ones', () => {
    const body = readFileSync(join(SKILLS_DIR, 'flw-data-review', 'SKILL.md'), 'utf8');

    expect(body).toContain('do not assume a per-location cap');
    expect(body).toMatch(/`max_daily`\s+and\s+`max_total`/);
  });
});
