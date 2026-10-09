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

// ── Case states (docs/superpowers/specs/2026-10-09-case-coaching-design.md) ──
// A case state is a bool Layer-2 property in the programme's SEMANTIC REGISTRY
// carrying a `case_state:` block ("case" because a worker could have states too); Labs evaluates it per case as of the run date. One
// conversation is about ONE case in ONE state. The coach's case cards are rendered
// from the registry's state meta, as the indicator cards are from its measures —
// nothing programme-specific lives here.

export interface RegistryCaseStateMeta {
  tone?: 'celebrate' | 'check' | 'concern' | 'urgent';
  /** Lower is more urgent; a case's state is its true state with the lowest priority. */
  priority?: number;
  evidence?: string[];
  facts?: string;
  picture?: Record<string, unknown>;
  coach?: { approach?: string; next_steps?: string; limits?: string };
}

/** A Layer-2 property from `properties_doc.properties` (semantic_registry_get). */
export interface RegistryProperty {
  name: string;
  label?: string;
  means?: string;
  type?: string;
  case_state?: RegistryCaseStateMeta;
}

export interface CaseStateCard {
  /** The case-state property's name: the briefing's topic key and the task's coaching_indicators entry. */
  key: string;
  label: string;
  means: string;
  approach: string;
  nextSteps: string;
  limits: string;
  priority: number;
}

/** The registry's case states, most urgent first. A case state without coach guidance is
 *  refused: the coach would be briefed on something it has no card for. */
export function caseStateCards(properties: RegistryProperty[]): CaseStateCard[] {
  const cards = properties
    .filter((p) => p.case_state)
    .map((p) => {
      const coach = p.case_state!.coach ?? {};
      const missing = (['approach', 'next_steps', 'limits'] as const).filter((k) => !coach[k]?.trim());
      if (missing.length || !p.label?.trim() || !p.means?.trim()) {
        const gaps = [...missing.map((k) => `case_state.coach.${k}`), ...(!p.label?.trim() ? ['label'] : []), ...(!p.means?.trim() ? ['means'] : [])];
        throw new Error(`case state ${p.name} is missing ${gaps.join(', ')} in the registry`);
      }
      return {
        key: p.name,
        label: p.label!.trim(),
        means: p.means!.trim(),
        approach: coach.approach!.trim(),
        nextSteps: coach.next_steps!.trim(),
        limits: coach.limits!.trim(),
        priority: p.case_state!.priority ?? Number.MAX_SAFE_INTEGER,
      };
    });
  return cards.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
}

export function renderCaseCards(cards: CaseStateCard[]): string {
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
  /** The case state: its registry property name and label. */
  story: { key: string; label: string };
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
