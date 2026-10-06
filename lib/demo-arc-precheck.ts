/**
 * The PRE-RENDER arc check — catch, from the authored spec's TEXT, what canopy's
 * `ddd-arc-eval` keeps finding only after a render (ace#2735).
 *
 * `ddd-arc-eval` judges the rendered narrative as a sequence on five dimensions
 * (`arc_shape` .30, `escalation` .25, `visual_variety` .20, `persona_coherence`
 * .15, `opening_and_close` .10; overall = lowest). It is the only lens in the
 * DDD loop that sees the scenes as a sequence — and it only runs after a render
 * and a judge pass have been paid for. On DDD run
 * `spark-facilitator-programme-cascade-2026-10-06-002` it found, in its own words:
 *
 *  - *"Scenes 4 and 5 both end on the same community visit-list component in
 *    the same composition"* (visual_variety, CONCEPT);
 *  - *"The finale (scene 6) restates scene 1/2's headline fact (Kuunika 66.0%,
 *    last of five on meeting regularity) ... (cap max 3 fired)"* (arc_shape);
 *  - *"Scene 5 ... is a side-branch ... its slot is not load-bearing"* (arc_shape).
 *
 * Each is visible in the authored spec. This module reads it deterministically
 * where the text decides the question, and prepares ONE cheap text-only judge
 * pass (`buildArcPrecheckPrompt`, rubric `ARC_PRECHECK_RUBRIC`) for what needs
 * judgment. It runs BEFORE render and NEVER replaces `ddd-arc-eval`: the
 * post-render judge still sees frames, page text and composition that no text
 * pass can. A clean pre-check is a prediction, not a verdict.
 *
 * Mapping to `ddd-arc-eval`'s deduction rules (installed canopy
 * `skills/ddd-arc-eval/rubric.yaml`):
 *
 *   same-surface-component  ← visual_variety "more than half the scenes are the same surface",
 *                             arc_shape "two scenes make the same point with different pixels: max 2"
 *   finale-restates-opening ← arc_shape "the final scene is not the strongest moment: max 3",
 *                             opening_and_close "the close does not answer the opening's question: max 2"
 *   side-branch-scene       ← escalation "any scene whose removal would not be noticed: max 3"
 *
 * Neighbours, not duplicates: `demo-scene-variety` (surface monopoly; a
 * same-surface scene with only a scroll) and `demo-arc-ladder` (the finale
 * performs a state change). Spark's scenes 4→5 pass both — scene 5 clicks — and
 * still film the same component; that is the gap `same-surface-component` closes.
 *
 * Severity follows the family's history: two heuristics in this area were
 * retracted for firing on fine specs (ace#1660, ace#1841). So only the
 * structural rule and the literal claim restatement BLOCK; the narration
 * restatement and the side-branch are REPORTED and handed to the judge pass as
 * questions, never failed on their own.
 */

import type { QACheckResult } from './qa-types';

export interface PrecheckAction {
  kind: string;
  target?: string;
  value?: string | number;
}

export interface PrecheckScene {
  id?: string;
  title?: string;
  url?: string;
  persona?: string;
  concept_claim?: string;
  narrative?: string;
  actions?: PrecheckAction[];
}

export interface PrecheckSpec {
  name?: string;
  personas?: Record<string, { name?: string } | undefined>;
  scenes?: PrecheckScene[];
}

export type PrecheckFindingKind = 'same-surface-component' | 'finale-restates-opening' | 'side-branch-scene';

export interface PrecheckFinding {
  kind: PrecheckFindingKind;
  /** 1-based scene numbers involved. */
  scenes: number[];
  blocking: boolean;
  /** The `ddd-arc-eval` dimension whose deduction this predicts. */
  dimension: 'visual_variety' | 'arc_shape' | 'escalation' | 'opening_and_close';
  detail: string;
}

export interface PrecheckReport extends QACheckResult {
  findings: PrecheckFinding[];
  judged: number;
}

// ── Surfaces and components ───────────────────────────────────────────────

/** `${var}` → its realized value; then the URL's path (the template), query dropped. */
export function resolveSurface(url: string, realized: Record<string, unknown> = {}): string {
  const filled = url.replace(/\$\{([^}]+)\}/g, (m, k: string) => (typeof realized[k] === 'string' ? (realized[k] as string) : m));
  try {
    const u = new URL(filled);
    return `${u.host}${u.pathname}`;
  } catch {
    return filled.split('?')[0];
  }
}

/** A selector that names a COMPONENT (a heading, a tab, a dialog, a labelled region) rather than a row or a text node. */
const COMPONENT_SELECTOR = /(^|[\s(,>:])h[1-4]\b|role[:=]\s*['"]?(?:tab|tabpanel|dialog|heading|region|table)\b|aria-label/i;

/** The component a scene SETTLES on: its last `wait_for` whose target names a component, quoted text normalised away. */
export function settledComponent(scene: PrecheckScene): string | null {
  const waits = (scene.actions ?? []).filter((a) => a.kind === 'wait_for' && typeof a.target === 'string' && COMPONENT_SELECTOR.test(a.target));
  const last = waits[waits.length - 1];
  return last ? (last.target as string).replace(/"[^"]*"|'[^']*'/g, '"…"') : null;
}

// ── Facts and names in prose ──────────────────────────────────────────────

/** Numeric facts a viewer would remember: percentages (80% ≡ 80.0%) and rankings ("5th of 5"). */
export function extractFacts(text: string | undefined): string[] {
  const out = new Set<string>();
  for (const m of (text ?? '').matchAll(/(\d+(?:\.\d+)?)\s?%/g)) out.add(`${Number(m[1])}%`);
  for (const m of (text ?? '').matchAll(/\b(\d+)(?:st|nd|rd|th) of (\d+)\b/g)) out.add(`${m[1]} of ${m[2]}`);
  return [...out];
}

const CALENDAR = new Set(
  'January February March April May June July August September October November December Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec Monday Tuesday Wednesday Thursday Friday Saturday Sunday'.split(' '),
);

function sentences(text: string | undefined): string[] {
  // Split on sentence ends only: a name after a colon ("furthest behind: Kuunika ...") is not sentence-initial.
  return (text ?? '').split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

/** Capitalised words that are not sentence-initial, a calendar word, or a persona's name: the named things a scene is about. */
export function namedWords(text: string | undefined, exclude: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  for (const s of sentences(text)) {
    const words = s.split(/\s+/);
    words.forEach((raw, i) => {
      const w = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').replace(/['’]s$/u, '');
      if (i === 0 || !/^\p{Lu}\p{Ll}/u.test(w) || CALENDAR.has(w) || exclude.has(w)) return;
      out.add(w);
    });
  }
  return out;
}

/** `word|fact` pairs: a named thing and a number stated in the same sentence. */
function anchoredFacts(text: string | undefined, exclude: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const s of sentences(text)) {
    const facts = extractFacts(s);
    if (!facts.length) continue;
    for (const w of namedWords(s, exclude)) for (const f of facts) out.add(`${w}|${f}`);
  }
  return out;
}

function personaWords(spec: PrecheckSpec): Set<string> {
  const out = new Set<string>();
  for (const p of Object.values(spec.personas ?? {})) for (const w of (p?.name ?? '').split(/\s+/)) if (w) out.add(w);
  return out;
}

const sceneText = (s: PrecheckScene) => `${s.concept_claim ?? ''} ${s.narrative ?? ''}`;

// ── The check ─────────────────────────────────────────────────────────────

export function checkArcPrecheck(spec: PrecheckSpec | undefined, realized: Record<string, unknown> = {}): PrecheckReport {
  const scenes = spec?.scenes ?? [];
  const findings: PrecheckFinding[] = [];
  if (scenes.length < 2) return finish(findings, scenes.length);
  const exclude = personaWords(spec ?? {});

  // Surfaces carry forward, as the renderer does.
  const surfaces: string[] = [];
  let current = '';
  for (const s of scenes) {
    if (s.url?.trim()) current = resolveSurface(s.url.trim(), realized);
    surfaces.push(current);
  }

  // 1 — consecutive scenes settle on the same component of the same surface.
  for (let i = 1; i < scenes.length; i++) {
    const a = settledComponent(scenes[i - 1]);
    const b = settledComponent(scenes[i]);
    if (!a || a !== b || surfaces[i] !== surfaces[i - 1] || !surfaces[i]) continue;
    findings.push({
      kind: 'same-surface-component',
      scenes: [i, i + 1],
      blocking: true,
      dimension: 'visual_variety',
      detail:
        `scenes ${i} and ${i + 1} both settle on ${a} of ${surfaces[i]} — the same component in the same composition, ` +
        `which the arc judge reads as one picture twice (spark-facilitator 2026-10-06: "Scenes 4 and 5 both end on the ` +
        `same community visit-list component"). Frame one of them on a different component the page has (an indicator ` +
        `row, a chart, a flag column), or merge the two beats`,
    });
  }

  // 2 — the finale restates the opening.
  const last = scenes.length - 1;
  const finaleClaim = extractFacts(scenes[last].concept_claim);
  const openingClaim = new Set(extractFacts(scenes[0].concept_claim));
  if (finaleClaim.length && finaleClaim.every((f) => openingClaim.has(f))) {
    findings.push({
      kind: 'finale-restates-opening',
      scenes: [1, last + 1],
      blocking: true,
      dimension: 'arc_shape',
      detail:
        `the finale's concept_claim states only facts scene 1's claim already stated (${finaleClaim.join(', ')}) — ` +
        `the close adds nothing the opening had not, and the arc judge caps arc_shape at 3 when the final scene is ` +
        `not the strongest moment. End on what only the last surface can show`,
    });
  } else {
    const openingN = Math.max(1, Math.ceil(scenes.length / 3));
    const opening = new Set<string>();
    for (const s of scenes.slice(0, openingN)) for (const x of anchoredFacts(sceneText(s), exclude)) opening.add(x);
    const restated = [...anchoredFacts(sceneText(scenes[last]), exclude)].filter((x) => opening.has(x));
    if (restated.length) {
      findings.push({
        kind: 'finale-restates-opening',
        scenes: [1, last + 1],
        blocking: false,
        dimension: 'arc_shape',
        detail:
          `the finale repeats a fact the opening (scenes 1–${openingN}) already gave: ${restated.map((r) => r.split('|').join(' ')).join(', ')}. ` +
          `Reported, not failed — a payoff may revisit a baseline — but it is exactly what the arc judge read as "the finale ` +
          `restates scene 1/2's headline fact" on spark-facilitator 2026-10-06. The judge pass decides whether the finale ` +
          `adds something only its surface shows`,
      });
    }
  }

  // 3 — a middle scene the thread steps around.
  const names = scenes.map((s) => namedWords(sceneText(s), exclude));
  for (let i = 1; i < last; i++) {
    if (!scenes[i].url?.trim()) continue; // a continuation on the previous surface is part of its thread
    const shares = (a: Set<string>, b: Set<string>) => [...a].some((w) => b.has(w));
    if (shares(names[i], names[i - 1]) || shares(names[i], names[i + 1])) continue;
    const before = new Set<string>();
    for (let k = 0; k < i; k++) for (const w of names[k]) before.add(w);
    if (!shares(names[i + 1], before)) continue;
    findings.push({
      kind: 'side-branch-scene',
      scenes: [i + 1],
      blocking: false,
      dimension: 'escalation',
      detail:
        `scene ${i + 1} opens a new surface about ${[...names[i]].slice(0, 4).join(', ') || 'nothing named'}, names nothing ` +
        `scenes ${i} or ${i + 2} name, and scene ${i + 2} picks the earlier thread back up — a side-branch whose slot is ` +
        `not load-bearing (the arc judge's words on spark-facilitator 2026-10-06). Reported: move it where it escalates, ` +
        `or tie it to its neighbours; the judge pass decides`,
    });
  }

  return finish(findings, scenes.length);
}

function finish(findings: PrecheckFinding[], judged: number): PrecheckReport {
  const blockers = findings.filter((f) => f.blocking);
  return {
    pass: blockers.length === 0,
    judged,
    findings,
    detail: `${judged} scene(s) judged as a sequence; ${blockers.length} blocking, ${findings.length - blockers.length} reported for the judge pass`,
    ...(blockers.length ? { auto_fix_hint: blockers.map((f) => `[${f.kind}] scenes ${f.scenes.join(',')} — ${f.detail}`).join('\n') } : {}),
  };
}

// ── The one cheap text-only judge pass ────────────────────────────────────

/**
 * The text-only rubric. Same five dimensions, weights and deduction rules as
 * `ddd-arc-eval`, restricted to what the SPEC can show — the visual parts are
 * judged on declared surfaces/components, not pixels.
 */
export const ARC_PRECHECK_RUBRIC = {
  name: 'demo-arc-precheck',
  mirrors: 'canopy skills/ddd-arc-eval/rubric.yaml',
  default_score: 3,
  overall_rule: 'lowest',
  dimensions: [
    { id: 'arc_shape', weight: 0.3, rules: ['The final scene is not the strongest moment: max 3', 'Two scenes make the same point (even non-adjacent): max 2'] },
    { id: 'escalation', weight: 0.25, rules: ['Any scene whose removal would not be noticed: max 3 — name it', 'Two scenes on the same surface and component: max 2'] },
    { id: 'visual_variety', weight: 0.2, rules: ['More than half the scenes on one surface: max 2'] },
    { id: 'persona_coherence', weight: 0.15, rules: ['A persona switch the narration does not motivate: max 3'] },
    { id: 'opening_and_close', weight: 0.1, rules: ['The close does not answer the opening\'s question: max 2'] },
  ],
} as const;

/** The prompt for the single text-only pass. Self-contained: the judge sees nothing else. */
export function buildArcPrecheckPrompt(spec: PrecheckSpec, report: PrecheckReport, realized: Record<string, unknown> = {}): string {
  const scenes = spec.scenes ?? [];
  let current = '';
  const rows = scenes.map((s, i) => {
    if (s.url?.trim()) current = resolveSurface(s.url.trim(), realized);
    return [
      `## Scene ${i + 1}: ${s.title ?? s.id ?? ''}`,
      `persona: ${s.persona ?? '(unset)'}  surface: ${current || '(unset)'}  settles on: ${settledComponent(s) ?? '(no component wait)'}`,
      `actions: ${(s.actions ?? []).map((a) => a.kind).join(', ') || '(none)'}`,
      `concept_claim: ${s.concept_claim ?? ''}`,
      `narration: ${s.narrative ?? ''}`,
    ].join('\n');
  });
  const rubric = ARC_PRECHECK_RUBRIC.dimensions
    .map((d) => `- ${d.id} (weight ${d.weight}): default 3. ${d.rules.join('; ')}.`)
    .join('\n');
  const questions = report.findings.length
    ? report.findings.map((f) => `- [${f.kind}${f.blocking ? ', blocking' : ''}] scenes ${f.scenes.join(', ')}: ${f.detail}`).join('\n')
    : '- none';
  return [
    `You are judging a demo narrative AS A SEQUENCE, from its text only, before it is rendered.`,
    `This mirrors canopy's ddd-arc-eval, which will judge the rendered frames later; you are the cheap early read, not the verdict.`,
    `Judge the sequence, not any one scene. Start every dimension at 3 and move only with a named scene as evidence.`,
    ``,
    `# Rubric (overall = lowest)`,
    rubric,
    ``,
    `# Deterministic pre-check findings — answer each one`,
    questions,
    ``,
    `# Scenes (${scenes.length}) — ${spec.name ?? ''}`,
    rows.join('\n\n'),
    ``,
    `# Answer with YAML only`,
    `dimensions: {arc_shape: {score: N, why: "..."}, escalation: {...}, visual_variety: {...}, persona_coherence: {...}, opening_and_close: {...}}`,
    `one_sentence_story: "..."`,
    `findings: [{scenes: [N, ...], dimension: <id>, detail: "...", fix: "a reorder / cut / reframe of what the deck already has"}]`,
  ].join('\n');
}

export interface ArcPrecheckVerdict {
  dimensions?: Record<string, { score?: number } | undefined>;
  findings?: Array<{ scenes?: number[]; dimension?: string; detail?: string }>;
}

/**
 * Gate on the judge pass: any dimension ≤ 2 blocks the hand-off (revise the
 * spec first); a 3 is carried into the hand-off as a reported risk. A verdict
 * missing a dimension is a failed pass, never a silent pass.
 */
export function gateArcPrecheckVerdict(v: ArcPrecheckVerdict | null | undefined): QACheckResult {
  const ids = ARC_PRECHECK_RUBRIC.dimensions.map((d) => d.id);
  const missing = ids.filter((id) => typeof v?.dimensions?.[id]?.score !== 'number');
  if (missing.length) {
    return { pass: false, detail: `the judge pass returned no score for ${missing.join(', ')}`, auto_fix_hint: 're-run the text-only judge pass; never write its verdict yourself' };
  }
  const low = ids.filter((id) => (v!.dimensions![id]!.score as number) <= 2);
  const three = ids.filter((id) => v!.dimensions![id]!.score === 3);
  if (low.length === 0) return { pass: true, detail: `text-only arc pass: none ≤ 2${three.length ? `; at 3 (reported): ${three.join(', ')}` : ''}` };
  return {
    pass: false,
    detail: `text-only arc pass scored ${low.map((id) => `${id} ${v!.dimensions![id]!.score}`).join(', ')}`,
    auto_fix_hint: 'revise the spec per the pass\'s findings (reorder, cut, reframe) and re-run steps 3c before the DDD hand-off',
  };
}
