/**
 * Render an opp's ACE Coach system prompt from the template, the opp's
 * semantic-registry measures and a short app summary.
 *
 *   npx tsx scripts/render-coach-prompt.ts \
 *     --measures <registry measures JSON array> --app-summary <markdown file> \
 *     --program "Spark facilitator pilot" --worker facilitator --workers facilitators \
 *     [--language English] [--case-stories kmc] --out <prompt file>
 *
 * The measures are `indicators_doc.measures` from `semantic_registry_get`.
 * `--case-stories kmc` also briefs the coach on single-case conversations
 * (docs/superpowers/specs/2026-10-09-case-coaching-design.md).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  coachableIndicators,
  KMC_CASE_STORIES,
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
    'case-stories': { type: 'string' },
    out: { type: 'string' },
  },
});
for (const k of ['measures', 'app-summary', 'program', 'worker', 'workers', 'out'] as const) {
  if (!values[k]) throw new Error(`--${k} is required`);
}

const CASE_STORIES = { kmc: KMC_CASE_STORIES } as const;
const caseKey = values['case-stories'];
if (caseKey && !(caseKey in CASE_STORIES)) throw new Error(`--case-stories: unknown set ${caseKey}; known: ${Object.keys(CASE_STORIES).join(', ')}`);
const caseStories = caseKey ? CASE_STORIES[caseKey as keyof typeof CASE_STORIES] : undefined;

const template = readFileSync(new URL('../templates/ocs-coach/coach-prompt.md', import.meta.url), 'utf8');
const cards = coachableIndicators(JSON.parse(readFileSync(values.measures!, 'utf8')));
const prompt = renderCoachPrompt(template, {
  programName: values.program!,
  workerName: values.worker!,
  workerPlural: values.workers!,
  openingLanguage: values.language!,
  indicatorCards: renderIndicatorCards(cards),
  appSummary: readFileSync(values['app-summary']!, 'utf8').trim(),
  caseCards: caseStories ? renderCaseCards(caseStories) : undefined,
});
writeFileSync(values.out!, prompt);
console.log(JSON.stringify({ out: values.out, chars: prompt.length, topics: cards.map((c) => c.key), caseTopics: caseStories?.map((c) => c.key) ?? [] }));
