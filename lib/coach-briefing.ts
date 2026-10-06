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

export function renderCoachPrompt(
  template: string,
  vars: {
    programName: string;
    workerName: string;
    workerPlural: string;
    openingLanguage: string;
    indicatorCards: string;
    appSummary: string;
  },
): string {
  const filled = template
    .replaceAll('{{PROGRAM_NAME}}', vars.programName)
    .replaceAll('{{WORKER_NAME}}', vars.workerName)
    .replaceAll('{{WORKER_PLURAL}}', vars.workerPlural)
    .replaceAll('{{OPENING_LANGUAGE}}', vars.openingLanguage)
    .replaceAll('{{INDICATOR_CARDS}}', vars.indicatorCards)
    .replaceAll('{{APP_SUMMARY}}', vars.appSummary);
  const left = filled.match(/\{\{[A-Z_]+\}\}/g);
  if (left) throw new Error(`coach prompt has unfilled placeholders: ${[...new Set(left)].join(', ')}`);
  return filled;
}
