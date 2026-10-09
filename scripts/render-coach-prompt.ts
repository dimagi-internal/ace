/**
 * Render an opp's ACE Coach system prompt from the template, the opp's
 * semantic-registry measures and a short app summary.
 *
 *   npx tsx scripts/render-coach-prompt.ts \
 *     --measures <registry measures JSON array> --app-summary <markdown file> \
 *     --program "Spark facilitator pilot" --worker facilitator --workers facilitators \
 *     [--language English] [--properties <registry properties JSON>] --out <prompt file>
 *
 * The measures are `indicators_doc.measures` from `semantic_registry_get`.
 * `--properties` is `properties_doc.properties` from the same registry: its case states
 * (properties with a `state:` block) become the coach's case cards
 * (docs/superpowers/specs/2026-10-09-case-coaching-design.md).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  coachableIndicators,
  caseStateCards,
  renderCaseCards,
  renderCoachPrompt,
  renderIndicatorCards,
} from '../lib/coach-briefing.js';

const { values } = parseArgs({
  options: {
    measures: { type: 'string' },
    'app-summary': { type: 'string' },
    program: { type: 'string' },
    worker: { type: 'string' },
    workers: { type: 'string' },
    language: { type: 'string', default: 'English' },
    properties: { type: 'string' },
    out: { type: 'string' },
  },
});
for (const k of ['measures', 'app-summary', 'program', 'worker', 'workers', 'out'] as const) {
  if (!values[k]) throw new Error(`--${k} is required`);
}

const caseCards = values.properties ? caseStateCards(JSON.parse(readFileSync(values.properties, 'utf8'))) : undefined;

const template = readFileSync(new URL('../templates/ocs-coach/coach-prompt.md', import.meta.url), 'utf8');
const cards = coachableIndicators(JSON.parse(readFileSync(values.measures!, 'utf8')));
const prompt = renderCoachPrompt(template, {
  programName: values.program!,
  workerName: values.worker!,
  workerPlural: values.workers!,
  openingLanguage: values.language!,
  indicatorCards: renderIndicatorCards(cards),
  appSummary: readFileSync(values['app-summary']!, 'utf8').trim(),
  caseCards: caseCards?.length ? renderCaseCards(caseCards) : undefined,
});
writeFileSync(values.out!, prompt);
console.log(JSON.stringify({ out: values.out, chars: prompt.length, topics: cards.map((c) => c.key), caseStates: caseCards?.map((c) => c.key) ?? [] }));
