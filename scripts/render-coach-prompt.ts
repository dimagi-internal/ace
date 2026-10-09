/**
 * Render an opp's ACE Coach system prompt from the template, the opp's
 * semantic-registry measures and a short app summary.
 *
 *   npx tsx scripts/render-coach-prompt.ts \
 *     --measures <registry measures JSON array> --app-summary <markdown file> \
 *     --program "Spark facilitator pilot" --worker facilitator --workers facilitators \
 *     --knowledge-base yes|no [--language English] --out <prompt file>
 *
 * --knowledge-base says whether the coach will have indexed collections attached
 * (`ocs-coach-build.ts --collections`). It has no default: a prompt promising a
 * knowledge base the coach does not have makes it cite material it cannot see.
 *
 * The measures are `indicators_doc.measures` from `semantic_registry_get`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  coachableIndicators,
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
    'knowledge-base': { type: 'string' },
    language: { type: 'string', default: 'English' },
    out: { type: 'string' },
  },
});
for (const k of ['measures', 'app-summary', 'program', 'worker', 'workers', 'out'] as const) {
  if (!values[k]) throw new Error(`--${k} is required`);
}
if (values['knowledge-base'] !== 'yes' && values['knowledge-base'] !== 'no') {
  throw new Error('--knowledge-base yes|no is required: will the coach have indexed collections attached?');
}

const template = readFileSync(new URL('../templates/ocs-coach/coach-prompt.md', import.meta.url), 'utf8');
const cards = coachableIndicators(JSON.parse(readFileSync(values.measures!, 'utf8')));
const prompt = renderCoachPrompt(template, {
  programName: values.program!,
  workerName: values.worker!,
  workerPlural: values.workers!,
  openingLanguage: values.language!,
  indicatorCards: renderIndicatorCards(cards),
  appSummary: readFileSync(values['app-summary']!, 'utf8').trim(),
  knowledgeBase: values['knowledge-base'] === 'yes',
});
writeFileSync(values.out!, prompt);
console.log(JSON.stringify({ out: values.out, chars: prompt.length, topics: cards.map((c) => c.key) }));
