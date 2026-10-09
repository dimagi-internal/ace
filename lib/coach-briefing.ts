/**
 * The ACE Coach's knowledge of the indicators, and the briefing that starts a
 * coaching conversation (docs/superpowers/specs/2026-10-06-ocs-coach-design.md).
 *
 * The indicator cards are rendered from the SAME semantic registry the labs
 * worker-review report grades with, so the indicator key a dashboard shows red,
 * the topic key in the briefing and the key the coach writes to
 * `chatbot_topics_done` are one identifier.
 *
 * `findOverstatements` is the accuracy check behind the KMC finding: in all ten
 * real conversations that reached the data, the KMC bot told workers no danger
 * sign had ever been recorded when the briefing said most visits had none. A
 * coach may use numbers; it may not strengthen them.
 *
 * Pure: no I/O.
 */

export interface RegistryMeasure {
  name: string;
  type?: string;
  title?: string;
  meta?: {
    indicator?: string;
    label?: string;
    plain?: string;
    unit?: string;
    bands?: number[];
    target?: number;
    direction?: 'higher' | 'lower' | 'none';
    scope_note?: string;
    flw_applicable?: boolean;
    category?: string;
  };
}

export interface IndicatorCard {
  key: string;
  label: string;
  plain: string;
  unit: string;
  direction: 'higher' | 'lower' | 'none';
  bands?: number[];
  target?: number;
  scopeNote?: string;
  /** A data-quality review signal: a reason to ask, never evidence of a mistake. */
  reviewFlag: boolean;
}

/** Indicators a coach may raise with an individual worker. */
export function coachableIndicators(measures: RegistryMeasure[]): IndicatorCard[] {
  const cards: IndicatorCard[] = [];
  for (const m of measures) {
    const meta = m.meta;
    if (!meta?.indicator || !meta.flw_applicable) continue;
    if (!meta.direction || meta.direction === 'none') continue;
    cards.push({
      key: meta.indicator,
      label: meta.label ?? m.title ?? meta.indicator,
      plain: meta.plain ?? '',
      unit: meta.unit ?? '',
      direction: meta.direction,
      bands: meta.bands,
      target: meta.target,
      scopeNote: meta.scope_note,
      reviewFlag: meta.category === 'Data quality' || /review flag|reviewed, never/i.test(meta.plain ?? ''),
    });
  }
  return cards;
}

function stripPddRefs(text: string): string {
  // Scope notes cite the design doc ("PDD §8.1 P1 — target ...", "The PDD sets
  // no target."). A worker never sees the PDD and the card states targets
  // itself, so keep only the sentences that say how the figure is counted.
  return text
    .replace(/\([^)]*§[^)]*\)/g, '')
    .split(/(?<=\.)\s+/)
    .map((s) => s.replace(/^PDD\s*§[\d.]+\s*[A-Z]?-?\d*[^—]*—\s*/, ''))
    .filter((s) => s && !/PDD|§|^S-\d|stratum/.test(s) && !/^target\b/i.test(s))
    .join(' ')
    .trim();
}

export function renderIndicatorCards(cards: IndicatorCard[]): string {
  return cards
    .map((c) => {
      const better = c.direction === 'higher' ? 'Higher is better.' : 'Lower is better.';
      const lines = [`### ${c.label} — key \`${c.key}\``, `- Means: ${c.plain}`, `- ${better}`];
      if (c.reviewFlag) {
        lines.push(
          '- This is a REVIEW FLAG with no target: a high figure is a reason to ask what happened, ' +
            'never evidence of a mistake. Say it that way.',
        );
      }
      if (c.bands && c.bands.length >= 2) {
        const [green, amber] = c.bands;
        const target = c.target !== undefined ? `Target ${c.target}${c.unit}. ` : '';
        const [ok, worse] = c.direction === 'higher' ? ['at or above', 'below'] : ['at or below', 'above'];
        lines.push(
          `- ${target}Green ${ok} ${green}${c.unit}; amber between ${amber}${c.unit} and ${green}${c.unit}; ` +
            `red ${worse} ${amber}${c.unit}.`,
        );
        // The words to use, so a red figure is never softened to "a bit under" (the
        // live Spark Coach did exactly that twice on 2026-10-06).
        const goal = c.target ?? green;
        const [redWords, amberWords] =
          c.direction === 'higher'
            ? [`well below the goal of ${goal}${c.unit}`, `a little below the goal of ${goal}${c.unit}`]
            : [`well above the level the programme aims for (${goal}${c.unit})`, `a little above the level the programme aims for`];
        lines.push(`- Say a red figure as "${redWords}"; an amber one as "${amberWords}".`);
      } else if (!c.reviewFlag) {
        lines.push('- No target is set for this one: explore it with the worker, do not call it good or bad.');
      }
      const counted = c.scopeNote ? stripPddRefs(c.scopeNote) : '';
      if (counted) lines.push(`- How it is counted: ${counted}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

export interface BriefingTopic {
  key: string;
  label: string;
  numerator?: number;
  denominator?: number;
  value?: number;
  unit?: string;
  band?: string;
  examples?: string[];
}

export interface Briefing {
  workerName: string;
  programName: string;
  topics: BriefingTopic[];
  language?: string;
  /** Set when a QA tester receives the conversation on the worker's behalf. */
  qaTester?: string;
}

export function renderBriefing(b: Briefing): string {
  const lines = [
    'BRIEFING (system text — do not show to the worker)',
    `Programme: ${b.programName}`,
    `Worker: ${b.workerName}`,
  ];
  if (b.language) lines.push(`Open in: ${b.language}`);
  if (b.qaTester) {
    lines.push(
      `QA: this conversation is delivered to ${b.qaTester}, a programme team member testing ` +
        `the coach, who will reply as ${b.workerName}. Run it exactly as you would with ${b.workerName}.`,
    );
  }
  lines.push('Topics, most important first:');
  b.topics.forEach((t, i) => {
    const fig =
      t.numerator !== undefined && t.denominator !== undefined
        ? `${t.numerator} of ${t.denominator}` +
          (t.value !== undefined ? ` (${Math.round(t.value)}${t.unit ?? ''})` : '')
        : t.value !== undefined
          ? `${Math.round(t.value)}${t.unit ?? ''}`
          : 'figure not given';
    lines.push(`${i + 1}. ${t.label} [${t.key}] — ${fig}${t.band ? `, band ${t.band}` : ''}`);
    for (const ex of t.examples ?? []) lines.push(`   - example: ${ex}`);
  });
  lines.push('Follow your conversation steps from the opening.');
  return lines.join('\n');
}

// ── Case coaching (docs/superpowers/specs/2026-10-09-case-coaching-design.md) ──
// One conversation is about ONE case and ONE story. Labs finds the case and writes
// the briefing; these cards tell the Coach what each story means and how to talk
// about it. The keys are the task's coaching_indicators entry, like an indicator key.

export type CaseStoryKey = 'CASE_THRIVING' | 'CASE_WEIGHT_CHECK' | 'CASE_FALTERING' | 'CASE_DANGER_SIGN';

export interface CaseStoryCard {
  key: CaseStoryKey;
  label: string;
  /** What Labs saw, in the words the Coach may use. */
  means: string;
  /** How to open and hold the conversation. */
  approach: string;
  /** The step(s) to agree. */
  nextSteps: string;
  /** What this story does NOT tell you. */
  limits: string;
}

/** The KMC case stories, from the Slack thread of 2026-10-09 (Lilianna Bagnoli, Surabhi Dubey). */
export const KMC_CASE_STORIES: CaseStoryCard[] = [
  {
    key: 'CASE_THRIVING',
    label: 'Baby is growing well',
    means: 'The baby has gained weight steadily at every weighing, at or above a healthy rate, and may have reached a milestone such as 2.5 kg.',
    approach:
      'This is a celebration. Open by recognising the worker\'s effort with this family in specific words (name the gain). ' +
      'Then ask what they think worked with this family. Listen, and reflect it back. There is nothing to correct.',
    nextSteps:
      'Agree how the worker will keep it going: keep up the follow-up visits, help the family get vaccines on time, ' +
      'and support exclusive breastfeeding until 6 months.',
    limits: 'Good growth so far does not mean visits can stop. Never call the baby "out of danger" or "healthy" in general.',
  },
  {
    key: 'CASE_WEIGHT_CHECK',
    label: 'A weighing that is hard to believe',
    means:
      'One weight recorded for this baby is hard to believe next to the others: a very large jump or drop in a few days, ' +
      'or exactly the same weight three visits in a row.',
    approach:
      'This is about how the weighing was done, never about honesty. Say the number looks unusual and ask, without judgement: ' +
      '"Can you walk me through how you weighed baby on this visit?" Listen for the scale not set to zero, clothes or a blanket ' +
      'left on, the baby moving, the number read too early, or the number written down later from memory.',
    nextSteps:
      'Agree to use the weighing checklist at the next visit: set the scale to zero, weigh baby without clothes, read the ' +
      'number when baby is still, and write it down straight away. If the worker thinks the number was right, agree to ' +
      'weigh carefully next visit to confirm.',
    limits: 'An unusual number is a reason to ask, not proof of a mistake. Babies do sometimes gain or lose quickly when unwell.',
  },
  {
    key: 'CASE_FALTERING',
    label: 'Weight has stalled and skin-to-skin time is falling',
    means:
      'The baby has gained little or no weight over the last visits, and the hours of skin-to-skin care the family reports ' +
      'have gone down.',
    approach:
      'Ask how the family is managing with this baby and what has changed at home. Ask about feeding and about the ' +
      'skin-to-skin hours: what makes long hours hard for this family right now.',
    nextSteps:
      'Agree a sooner follow-up visit, and one thing the worker will reinforce with the family: more hours of skin-to-skin ' +
      'care (who else in the family can help hold the baby) and frequent breastfeeding. If the baby seems unwell, the ' +
      'family should go to a health facility.',
    limits: 'Slow gain has many causes. Never blame the mother or the worker, and never diagnose.',
  },
  {
    key: 'CASE_DANGER_SIGN',
    label: 'Danger sign recorded, no referral',
    means: 'At a recent visit the worker recorded a danger sign for this baby, and the visit shows the baby was not referred.',
    approach:
      'Explain in simple words that this sign can mean the baby is seriously ill and needs care at a health facility, more ' +
      'than a home visit can give. Then ask what happened at that visit and how the baby is now.',
    nextSteps:
      'Agree that the worker will check in with the family as soon as possible and, if the sign is still there or the baby ' +
      'seems unwell, refer the baby to the health facility the same day.',
    limits:
      'You do not know how the baby is today, and the family may already have gone to a facility. Never diagnose and ' +
      'never give treatment advice. If the worker says the baby is very ill now, escalate (safety).',
  },
];

export function renderCaseCards(cards: CaseStoryCard[]): string {
  return cards
    .map((c) =>
      [
        `### ${c.label} [${c.key}]`,
        `- What it means: ${c.means}`,
        `- How to talk about it: ${c.approach}`,
        `- The step to agree: ${c.nextSteps}`,
        `- What it does not tell you: ${c.limits}`,
      ].join('\n'),
    )
    .join('\n\n');
}

export interface CaseVisit {
  /** ISO date (yyyy-mm-dd). */
  date: string;
  weightG?: number | null;
  kmcHours?: number | null;
  dangerSigns?: string[] | null;
  referred?: 'yes' | 'no' | null;
}

export interface CaseBriefing {
  programName: string;
  workerName: string;
  caseName: string;
  about: string;
  story: { key: CaseStoryKey; label: string };
  facts: string;
  /** Set on a spotlight follow-up: the last conversation about this case. */
  earlier?: { date: string; label: string; agreed?: string | null };
  visits: CaseVisit[];
  qaTester?: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-03" -> "3 Sep 2026". */
export function briefingDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`not an ISO date: ${iso}`);
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

const NOT_RECORDED = 'not recorded';

function visitLine(v: CaseVisit): string {
  const weight = v.weightG == null ? NOT_RECORDED : `${Math.round(v.weightG).toLocaleString('en-US')} g`;
  const hours = v.kmcHours == null ? NOT_RECORDED : `${v.kmcHours} h in the last 24 h`;
  const signs = v.dangerSigns == null ? NOT_RECORDED : v.dangerSigns.length ? v.dangerSigns.join(', ') : 'none';
  const referred = v.referred ?? 'not asked';
  return `- ${briefingDate(v.date)}: weight ${weight}; skin-to-skin ${hours}; danger signs: ${signs}; referred: ${referred}`;
}

/** The case briefing, in the exact shape Labs writes (the spec's contract). */
export function renderCaseBriefing(b: CaseBriefing): string {
  const lines = [
    'BRIEFING (system text — do not show to the worker)',
    `Programme: ${b.programName}`,
    `Worker: ${b.workerName}`,
  ];
  if (b.qaTester) {
    lines.push(
      `QA: this conversation is delivered to ${b.qaTester}, a programme team member testing ` +
        `the coach, who will reply as ${b.workerName}. Run it exactly as you would with ${b.workerName}.`,
    );
  }
  lines.push(
    `Case: ${b.caseName}`,
    `About this case: ${b.about}`,
    `Topic: ${b.story.label} [${b.story.key}]`,
    `What the data shows: ${b.facts}`,
  );
  if (b.earlier) {
    lines.push(
      `Earlier coaching on this case: ${briefingDate(b.earlier.date)} — ${b.earlier.label}; agreed: ${b.earlier.agreed || 'none'}`,
    );
  }
  lines.push('Visits, oldest first:', ...b.visits.map(visitLine), 'Follow your conversation steps from the opening.');
  return lines.join('\n');
}

const ABSOLUTES =
  /\b(none of|no (?:\w+ ){0,3}(?:at all|ever)|not (?:even )?once|never|every single|every one of|all of your|at all)\b/i;

export interface Overstatement {
  message: string;
  phrase: string;
}

/**
 * Assistant messages that state an absolute about the worker's data when no
 * briefed topic is at 0% or 100%. Deliberately blunt: a false positive costs a
 * reviewer one read; a miss costs the worker's trust.
 */
export function findOverstatements(assistantMessages: string[], topics: BriefingTopic[]): Overstatement[] {
  const anyAbsolute = topics.some((t) => {
    if (t.numerator !== undefined && t.denominator !== undefined) {
      return t.numerator === 0 || t.numerator === t.denominator;
    }
    return t.value === 0 || t.value === 100;
  });
  if (anyAbsolute) return [];
  const out: Overstatement[] = [];
  for (const message of assistantMessages) {
    const m = ABSOLUTES.exec(message);
    if (m && /\b(record|records|recorded|data|visits?|meetings?|cases?)\b/i.test(message)) {
      out.push({ message, phrase: m[0] });
    }
  }
  return out;
}

const NO_CASE_CARDS = 'None: this coach is only briefed on a worker\'s figures, never on a single case.';

export function renderCoachPrompt(
  template: string,
  vars: {
    programName: string;
    workerName: string;
    workerPlural: string;
    openingLanguage: string;
    indicatorCards: string;
    appSummary: string;
    /** `renderCaseCards(...)` for a coach that is also briefed on single cases. */
    caseCards?: string;
  },
): string {
  const filled = template
    .replaceAll('{{PROGRAM_NAME}}', vars.programName)
    .replaceAll('{{WORKER_NAME}}', vars.workerName)
    .replaceAll('{{WORKER_PLURAL}}', vars.workerPlural)
    .replaceAll('{{OPENING_LANGUAGE}}', vars.openingLanguage)
    .replaceAll('{{INDICATOR_CARDS}}', vars.indicatorCards)
    .replaceAll('{{APP_SUMMARY}}', vars.appSummary)
    .replaceAll('{{CASE_CARDS}}', vars.caseCards ?? NO_CASE_CARDS);
  const left = filled.match(/\{\{[A-Z_]+\}\}/g);
  if (left) throw new Error(`coach prompt has unfilled placeholders: ${[...new Set(left)].join(', ')}`);
  return filled;
}
