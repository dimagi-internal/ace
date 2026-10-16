/**
 * The Phase 7 registry gate: no synthetic data is generated against a semantic
 * registry until `semantic-registry-author-eval` has graded it and not failed it.
 *
 * ## Why this is code and not a sentence in the agent doc
 *
 * `agents/synthetic-data-and-workflows.md` already said the eval must run ("run
 * it, do not defer it"), and `demo-data-setup § C2` said not to generate against
 * a registry that had not passed QA. Neither was an ORDER anything enforced. On
 * all three runs of 2026-10-15 — `noora-health/20261015-1129`,
 * `kaduna-graduation/20261015-1411`, `smallholder-seasonal/20261015-1402` — the
 * registry eval ran AFTER the data had been generated and the dashboards built.
 * The story signals, the per-partner manifests, the indicator report trio and
 * the history rebuild are all authored against the registry's indicator ids, so
 * an eval finding at that point means regenerating the whole cascade (the slow
 * part of Phase 7 short of the DDD render) instead of editing one registry
 * record. Grading first costs one eval; grading last costs the cascade.
 *
 * The chokepoint is `scripts/run-labs-synthetic-generate.ts` — the one path
 * `demo-data-setup` sends a manifest through — so the gate lives there: it
 * refuses to send unless handed the eval verdict file (this check) or an
 * explicit skip with a reason (providers that author no registry: `denovo`,
 * `clone`). A skip is recorded, never silent.
 *
 * ## The rule
 *
 * - verdict file absent → BLOCK ("run semantic-registry-author-eval first").
 * - unparseable, or the file is some other skill's verdict → BLOCK: a gate that
 *   cannot read its input must not read as open.
 * - `fail` → BLOCK. Fix the registry and re-grade; that is cheap NOW.
 * - `incomplete` / `partial` → BLOCK: the eval did not finish grading, which is
 *   the deferred-eval shape the agent doc already forbids.
 * - `pass` / `warn` → proceed. A warn is graded and recorded; it does not justify
 *   holding generation (the same "never repair on a warn" policy Phase 3 uses).
 *
 * Schema problems beyond those (e.g. dimension weights not summing to 1.0) are
 * reported as notes, not blocks — they say the verdict is untidy, not that the
 * registry is bad, and blocking on them would teach operators to skip the gate.
 */
import { parse as parseYaml } from 'yaml';
import { checked, type CheckOutcome } from './check-outcome.js';
import { validateVerdict } from './verdict-schema.js';

/** Where the eval writes its verdict, relative to the run folder (lib/artifact-manifest.ts). */
export const REGISTRY_EVAL_VERDICT_PATH = '7-synthetic/semantic-registry-author-eval_verdict.yaml';
export const REGISTRY_EVAL_SKILL = 'semantic-registry-author-eval';

export type RegistryGateCode = 'missing' | 'unparseable' | 'wrong-skill' | 'failing' | 'not-graded';

export interface RegistryGateFinding {
  code: RegistryGateCode;
  message: string;
}

export interface RegistryGateExtra {
  /** The verdict disposition read, when one was readable. */
  verdict?: string;
  overall_score?: number;
  /** Non-blocking schema notes. */
  notes: string[];
}

export type RegistryGateOutcome = CheckOutcome<RegistryGateFinding, RegistryGateExtra>;

function block(finding: RegistryGateFinding, extra: Partial<RegistryGateExtra> = {}): RegistryGateOutcome {
  return { ...checked(false, [finding]), notes: [], ...extra };
}

/**
 * Pure. `verdictYaml` is the CONTENT of
 * `<run>/7-synthetic/semantic-registry-author-eval_verdict.yaml`, or
 * null/undefined when the file does not exist.
 *
 * A missing verdict is a `checked` BLOCK, not `unable`: the gate's question is
 * "has the registry been graded?", and absence answers it — no.
 */
export function checkRegistryEvalGate(verdictYaml: string | null | undefined): RegistryGateOutcome {
  if (verdictYaml == null || verdictYaml.trim() === '') {
    return block({
      code: 'missing',
      message:
        `no ${REGISTRY_EVAL_VERDICT_PATH} — run ${REGISTRY_EVAL_SKILL} first. Synthetic data, ` +
        'the story signals and the report trio are all authored against the registry; grading it ' +
        'after generation means regenerating the cascade for any finding.',
    });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(verdictYaml);
  } catch (e) {
    return block({ code: 'unparseable', message: `the verdict file is not valid YAML: ${(e as Error).message}` });
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  if (typeof parsed !== 'object' || parsed === null) {
    return block({ code: 'unparseable', message: 'the verdict file does not hold a YAML mapping' });
  }

  if (obj.skill !== REGISTRY_EVAL_SKILL) {
    return block({
      code: 'wrong-skill',
      message: `the verdict file is for skill "${String(obj.skill ?? 'absent')}", not ${REGISTRY_EVAL_SKILL} — pass the registry eval's own verdict`,
    });
  }

  const verdict = typeof obj.verdict === 'string' ? obj.verdict : undefined;
  const overall_score = typeof obj.overall_score === 'number' ? obj.overall_score : undefined;
  const v = validateVerdict(parsed);
  const notes = [...v.errors, ...v.warnings];

  if (verdict === 'fail') {
    return block(
      {
        code: 'failing',
        message:
          `${REGISTRY_EVAL_SKILL} verdict is fail (score ${overall_score ?? '?'}) — fix the registry ` +
          '(semantic_registry_update), re-run semantic-registry-author-qa and the eval, then generate',
      },
      { verdict, overall_score, notes },
    );
  }
  if (verdict !== 'pass' && verdict !== 'warn') {
    return block(
      {
        code: 'not-graded',
        message:
          `${REGISTRY_EVAL_SKILL} verdict is "${verdict ?? 'absent'}" — the eval did not finish grading; ` +
          'complete it (a deferred eval is not a gate) before generating',
      },
      { verdict, overall_score, notes },
    );
  }
  return { ...checked<RegistryGateFinding>(true, []), verdict, overall_score, notes };
}

/** One line for stderr / a summary. */
export function describeRegistryEvalGate(outcome: RegistryGateOutcome): string {
  if (outcome.status === 'unable') return `registry gate: UNABLE TO CHECK — ${outcome.reason}`;
  if (outcome.ok) {
    return `registry gate: OPEN — ${REGISTRY_EVAL_SKILL} verdict ${outcome.verdict} (score ${outcome.overall_score ?? '?'})`;
  }
  return `registry gate: BLOCKED — ${outcome.findings.map((f) => `[${f.code}] ${f.message}`).join('; ')}`;
}
