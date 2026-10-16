/**
 * A phase's CROSS-PHASE required inputs, and the resume-time precondition
 * check over them (ace#2134).
 *
 * ## The defect
 *
 * `agents/ace-orchestrator.md § Resume mode` fences each `pending` phase with
 * a structural precondition check: "confirm the phase's required input
 * artifacts (per `artifactsConsumedBy`) are present". But `consumedBy` holds
 * SKILL names, and the fence queried it with a PHASE name — so
 * `artifactsConsumedBy('commcare')` matched nothing, the list was `[]` for 9 of
 * 10 phases, and the check passed vacuously on every resume. On
 * `poverty-graduation/20260905-1345` Phase 6 resumed with `3-commcare/` holding
 * one file; the fence said nothing and the halt landed in Phase 6's own
 * pre-flight, after Phases 4 and 5 had already run.
 *
 * The manifest data was never missing — it is a key translation. A phase's
 * inputs are the union over its skills (agent frontmatter `skills[]`,
 * `recurring_skills[]`, `manual_skills[]`, plus each `eval_skill`), restricted
 * to artifacts produced by an EARLIER phase.
 *
 * ## Unable is not "no inputs"
 *
 * If the phase's skill list resolves empty — an agent whose frontmatter moved,
 * a phase key that stopped matching — the answer is `unable`, never an empty
 * input list. An empty list is exactly how the old fence read green while
 * looking at nothing (`lib/check-outcome.ts`).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  ARTIFACT_MANIFEST,
  PHASE_DEFS,
  isPhaseMode,
  type ArtifactEntry,
  type Phase,
  type PhaseDef,
} from './artifact-manifest.js';
import { checked, unable, type CheckOutcome } from './check-outcome.js';

const SKILL_LIST_KEYS = ['skills', 'recurring_skills', 'manual_skills'] as const;

/**
 * Every skill a phase agent declares in its frontmatter, including each
 * entry's `eval_skill`. Returns `[]` for a document with no frontmatter or no
 * skill lists — callers MUST treat that as `unable`, not as "no skills".
 */
export function parsePhaseAgentSkills(agentMd: string): string[] {
  const m = agentMd.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return [];
  let fm: unknown;
  try {
    fm = parseYaml(m[1]);
  } catch {
    return [];
  }
  if (!fm || typeof fm !== 'object') return [];
  const out = new Set<string>();
  for (const key of SKILL_LIST_KEYS) {
    const list = (fm as Record<string, unknown>)[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === 'string') out.add(item);
      else if (item && typeof item === 'object') {
        const { name, eval_skill } = item as { name?: unknown; eval_skill?: unknown };
        if (typeof name === 'string') out.add(name);
        if (typeof eval_skill === 'string') out.add(eval_skill);
      }
    }
  }
  return [...out];
}

/** Resolve a phase by manifest key (`commcare`) or agent name (`commcare-setup`). */
export function resolvePhaseDef(phase: string): PhaseDef | undefined {
  return PHASE_DEFS.find((d) => d.key === phase || d.agentName === phase);
}

/** Read the declared skills of a phase from `agents/<agentName>.md`. */
export function phaseSkillsFromRepo(phase: string, repoRoot: string): string[] {
  const def = resolvePhaseDef(phase);
  if (!def) return [];
  const file = join(repoRoot, 'agents', `${def.agentName}.md`);
  if (!existsSync(file)) return [];
  return parsePhaseAgentSkills(readFileSync(file, 'utf8'));
}

/** One required input a phase reads from an earlier phase's folder. */
export interface CrossPhaseInput {
  path: string;
  producedBy: string;
  /** Manifest key of the producing phase. */
  producerPhase: Phase;
  /** run_state key (agent name) of the producing phase. */
  producerAgent: string;
  /** Skills in THIS phase that read it. */
  consumers: string[];
}

function isLiteralPath(p: string): boolean {
  return !p.includes('<') && !p.includes('YYYY');
}

/**
 * Does `mode` (a `PHASE_MODES` value, e.g. `app-QA-only`) mean `skill` never
 * runs? True when every required artifact the skill produces is exempt in that
 * mode — the manifest's own record of the mode's run shape (ace#1069). Without
 * this, an app-QA-only Phase 6 would "need" Phase 5's chatbot docs through the
 * training skills the mode skips, and a legitimately skipped Phase 5 would
 * read as a mis-shaped seed.
 */
function skippedInMode(skill: string, mode: string | undefined): boolean {
  if (!isPhaseMode(mode)) return false;
  const exempt = (a: ArtifactEntry) => a.notRequiredInModes?.includes(mode) ?? false;
  const own = ARTIFACT_MANIFEST.filter((a) => a.producedBy === skill && a.required);
  // A producer whose only required artifact is its `-eval` verdict (e.g.
  // training-deck-generate) is exempt exactly when that verdict is.
  const graded = ARTIFACT_MANIFEST.filter((a) => a.producedBy === `${skill}-eval` && a.required);
  const relevant = [...own, ...graded];
  return relevant.length > 0 && relevant.every(exempt);
}

/**
 * The REQUIRED run-folder artifacts `phase`'s skills read that an EARLIER
 * phase produces. `unable` when `skills` is empty or the phase is unknown.
 *
 * Kept: artifacts whose producing phase has a lower ordinal, that are
 * `required` at that phase, that live in that phase's run folder, and whose
 * path is literal (placeholders cannot be checked for presence). A later-phase
 * input is a declared, cut cycle (`test/lib/artifact-cycles.test.ts`), not a
 * precondition.
 */
export function crossPhaseInputs(
  phase: string,
  skills: readonly string[],
  mode?: string,
): CheckOutcome<never, { inputs: CrossPhaseInput[] }> {
  const def = resolvePhaseDef(phase);
  if (!def) return unable(`unknown phase "${phase}" — not a PHASE_DEFS key or agent name`);
  if (skills.length === 0) {
    return unable(
      `no skills resolved for phase "${def.agentName}" — agents/${def.agentName}.md frontmatter ` +
        `has no skills/recurring_skills/manual_skills list, so its inputs cannot be derived`,
    );
  }
  const byPath = new Map<string, CrossPhaseInput>();
  const skillSet = new Set(skills.filter((s) => !skippedInMode(s, mode)));
  for (const a of ARTIFACT_MANIFEST as readonly ArtifactEntry[]) {
    const producer = PHASE_DEFS.find((d) => d.key === a.phase);
    if (!producer || producer.ordinal >= def.ordinal) continue;
    if (!a.required || !isLiteralPath(a.path) || !a.path.startsWith(`${producer.folder}/`)) continue;
    const consumers = a.consumedBy.filter((c) => skillSet.has(c));
    if (consumers.length === 0) continue;
    byPath.set(a.path, {
      path: a.path,
      producedBy: a.producedBy,
      producerPhase: producer.key,
      producerAgent: producer.agentName,
      consumers,
    });
  }
  return { ...checked<never>(true, []), inputs: [...byPath.values()] };
}

/** A required cross-phase input absent at resume time. */
export interface MissingPhaseInput extends CrossPhaseInput {
  /** The producing phase's `phases.<agent>.status`, or `absent`. */
  producerStatus: string;
  /**
   * `reshape` — the producer is `skipped`/absent: the run was seeded or forked
   * with the wrong shape; re-seed including the producer.
   * `rerun-producer` — the producer closed (`done`/`partial`/…) without it.
   */
  remedy: 'reshape' | 'rerun-producer';
}

const STILL_TO_RUN = new Set(['pending', 'in_progress']);

/**
 * The resume fence: given what is present in the run folder and each phase's
 * status, which of `phase`'s cross-phase required inputs are missing?
 *
 * An input whose producer is still `pending`/`in_progress` is NOT missing — an
 * earlier pending phase will run first and produce it. `unable` propagates
 * from {@link crossPhaseInputs}; it is never a pass.
 */
export function checkPhasePreconditions(args: {
  phase: string;
  skills: readonly string[];
  presentPaths: Iterable<string>;
  /** run_state `phases.<name>.status`, keyed as run_state keys them (agent name or manifest key). */
  phaseStatuses: Record<string, string | undefined>;
  /** The phase's `phases.<agent>.mode`, if it runs in a reduced mode. */
  mode?: string;
}): CheckOutcome<MissingPhaseInput, { inputs: CrossPhaseInput[] }> {
  const resolved = crossPhaseInputs(args.phase, args.skills, args.mode);
  if (resolved.status === 'unable') return resolved;
  const present = new Set(args.presentPaths);
  const findings: MissingPhaseInput[] = [];
  for (const input of resolved.inputs) {
    if (present.has(input.path)) continue;
    // run_state keys phases by agent name for most phases but by manifest key
    // for Phase 9 (`execution-management`, agent `execution-manager`) — accept
    // either rather than misreading a pending Phase 9 as absent.
    const producerStatus =
      args.phaseStatuses[input.producerAgent] ?? args.phaseStatuses[input.producerPhase] ?? 'absent';
    if (STILL_TO_RUN.has(producerStatus)) continue;
    findings.push({
      ...input,
      producerStatus,
      remedy: producerStatus === 'skipped' || producerStatus === 'absent' ? 'reshape' : 'rerun-producer',
    });
  }
  return { ...checked(findings.length === 0, findings), inputs: resolved.inputs };
}
