import { z } from 'zod';

/**
 * Single source of truth for the `phases.<phase>.products.*` typed handoff
 * blocks in `run_state.yaml` — the blocks ace-web's public summary page
 * (`apps/opps/summary.py`) and every downstream skill consume.
 *
 * ## Why this exists
 *
 * `run_state.yaml` is a typed document hand-merged by ~10 phase agents through
 * the generic `update_yaml_file` atom and read by four+ consumers (ace-web
 * summary, opp-eval, /ace:status, mobile recipes). The contract used to live
 * only in prose (skill docs + summary.py docstring) with nothing enforcing
 * producer/consumer agreement — so a producer that wrote
 * `products.opportunity` instead of `products.connect.opportunity`, or a deck
 * under `products.training_materials.deck` instead of `products.training.deck`,
 * shipped a blank summary section that nobody noticed for weeks
 * (malaria-rdt/20260604-1604; jjackson/ace#705).
 *
 * This module encodes the contract once. The `update_yaml_file` atom validates
 * a products write against it BEFORE the Drive merge (`validateAs:
 * {kind:'phase-products', phase}`), so drift fails loud at the write with the
 * offending field named — the way labs `create_solicitation` rejects a bad
 * payload. `scripts/dump-phase-products-schema.ts` emits a JSON Schema that
 * ace-web reads, so the two repos can't silently diverge (mirrors the
 * `docs/atom-schemas.md` generated-catalog + staleness-gate pattern).
 *
 * ## Shape strategy
 *
 * - **Products-root is `.strict()`** — only the documented top-level product
 *   block names for that phase are allowed. Writing `products.opportunity`
 *   (instead of `products.connect`) or `products.training_materials` is
 *   rejected. This is the workhorse that catches nesting drift.
 * - **Inner blocks are `.passthrough()`** — phases legitimately carry internal
 *   detail ace-web doesn't read (deliver_units, payment_units, markers, …);
 *   we don't enumerate every internal key, only type the ones a consumer reads.
 * - **Every field is `.optional()`** — writes are incremental (one doc, one
 *   block at a time), so a fragment write must pass. Completeness (all critical
 *   handoff keys present once the phase is `done`) is asserted separately at the
 *   phase boundary via {@link REQUIRED_PRODUCT_KEYS}.
 *
 * Keep this in lock-step with ace-web `apps/opps/summary.py` `_read_*`. The
 * staleness test (`test/scripts/dump-phase-products-schema.test.ts`) gates the
 * generated JSON Schema; a contract test on the ace-web side reads it.
 */

// ─── Reusable leaf shapes ──────────────────────────────────────────

/** A Drive-doc pointer the summary renders as a link. */
const DocPointer = z
  .object({
    file_id: z.string().min(1).optional(),
    title: z.string().optional(),
    web_view_link: z.string().url().optional(),
  })
  .passthrough();

// ─── Per-phase product block schemas ───────────────────────────────

const DesignProducts = z
  .object({
    pdd: z
      .object({
        title: z.string().optional(),
        description: z.string().optional(),
        file_id: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    work_order: DocPointer.optional(),
  })
  .strict();

const AppEntry = z
  .object({
    name: z.string().optional(),
    nova_app_id: z.string().min(1).optional(),
    nova_url: z.string().url().optional(),
    hq_app_id: z.string().min(1).optional(),
    hq_url: z.string().url().optional(),
    domain: z.string().optional(),
    build_status: z.enum(['success', 'errored', 'pending']).optional(),
  })
  .passthrough();

const CommcareProducts = z
  .object({
    apps: z
      .object({
        learn: AppEntry.optional(),
        deliver: AppEntry.optional(),
        domain: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .strict();

const ConnectProducts = z
  .object({
    connect: z
      .object({
        domain: z.string().optional(),
        organization_slug: z.string().optional(),
        program: z
          .object({
            id: z.string().optional(),
            name: z.string().optional(),
            url: z.string().url().optional(),
          })
          .passthrough()
          .optional(),
        opportunity: z
          .object({
            id: z.string().optional(),
            name: z.string().optional(),
            url: z.string().url().optional(),
            start_date: z.string().optional(),
            end_date: z.string().optional(),
          })
          .passthrough()
          .optional(),
        ace_test_user: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .strict();

const OcsProducts = z
  .object({
    ocs_chatbot: z
      .object({
        public_id: z.string().optional(),
        embed_key: z.string().optional(),
        admin_url: z.string().url().optional(),
        experiment_id: z.union([z.string(), z.number()]).optional(),
        team_slug: z.string().optional(),
        collection_id: z.union([z.string(), z.number()]).optional(),
        version_number: z.union([z.string(), z.number()]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .strict();

const TrainingProducts = z
  .object({
    training: z
      .object({
        deck: DocPointer.optional(),
        docs: z
          .object({
            llo_guide: DocPointer.optional(),
            flw_guide: DocPointer.optional(),
            quick_reference: DocPointer.optional(),
            faq: DocPointer.optional(),
            onboarding_email: DocPointer.optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .strict();

const Walkthrough = z
  .object({
    persona: z.string().optional(),
    slideshow_url: z.string().url().optional(),
    web_view_link: z.string().url().optional(),
    eval_score: z.number().optional(),
  })
  .passthrough();

const SyntheticProducts = z
  .object({
    synthetic: z
      .object({
        walkthroughs: z.array(Walkthrough).optional(),
        workflows: z.unknown().optional(),
        labs_opp_id: z.union([z.string(), z.number()]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .strict();

const SolicitationProducts = z
  .object({
    solicitation: z
      .object({
        url: z.string().url().optional(),
        public_url: z.string().url().optional(),
        deadline: z.string().optional(),
        status: z.string().optional(),
      })
      .passthrough()
      .optional(),
    selected_llo: z
      .object({
        org_slug: z.string().optional(),
        org_display_name: z.string().optional(),
        contact_email: z.string().optional(),
        awarded_at: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .strict();

const ExecutionProducts = z
  .object({
    launch: z
      .object({
        went_live_at: z.string().optional(),
        llo_org_display_name: z.string().optional(),
        llo_org_slug: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .strict();

const CloseoutProducts = z
  .object({
    cycle_grade: z
      .object({
        letter: z.string().optional(),
        headline: z.string().optional(),
        overall_score: z.number().optional(),
      })
      .passthrough()
      .optional(),
    opp_eval: z
      .object({
        overall_score: z.number().optional(),
        verdict: z.string().optional(),
        mode: z.string().optional(),
      })
      .passthrough()
      .optional(),
    learnings: z
      .object({
        summary_file_id: z.string().optional(),
        summary_web_view_link: z.string().url().optional(),
        new_pdd_file_id: z.string().optional(),
        new_pdd_web_view_link: z.string().url().optional(),
        iteration_warranted: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .strict();

/**
 * Registry: phase name → its `products` block schema. Phases ace-web does not
 * read products from (e.g. `scenarios-and-acceptance`) are intentionally
 * absent — `validateAs` is a no-op for them.
 */
export const PHASE_PRODUCTS_SCHEMAS = {
  design: DesignProducts,
  'idea-to-design': DesignProducts,
  'commcare-setup': CommcareProducts,
  'connect-setup': ConnectProducts,
  'ocs-setup': OcsProducts,
  'qa-and-training': TrainingProducts,
  'synthetic-data-and-workflows': SyntheticProducts,
  'solicitation-management': SolicitationProducts,
  'execution-management': ExecutionProducts,
  closeout: CloseoutProducts,
} as const;

export type PhaseName = keyof typeof PHASE_PRODUCTS_SCHEMAS;

/**
 * Critical handoff keys (dot-paths under `products`) that MUST be present once
 * a phase reaches `done` — the keys the ace-web summary needs to render a
 * non-blank section. Checked at the phase boundary, NOT at the (incremental)
 * write. Absent phases have no hard completeness requirement.
 */
export const REQUIRED_PRODUCT_KEYS: Partial<Record<PhaseName, string[]>> = {
  'commcare-setup': ['apps.learn.hq_app_id', 'apps.deliver.hq_app_id'],
  'connect-setup': ['connect.opportunity.url', 'connect.domain'],
  'qa-and-training': ['training.docs.onboarding_email'],
  'solicitation-management': ['solicitation.url'],
};

export interface ProductsValidationIssue {
  path: string;
  message: string;
}

export interface ProductsValidationResult {
  valid: boolean;
  /** True when the phase has no registered products schema (validation skipped). */
  skipped: boolean;
  issues: ProductsValidationIssue[];
}

function flattenZodIssues(err: z.ZodError, prefix: string): ProductsValidationIssue[] {
  return err.issues.map((i) => {
    const path = [prefix, ...i.path.map(String)].filter(Boolean).join('.');
    let message = i.message;
    if (i.code === 'unrecognized_keys') {
      const keys = (i as any).keys as string[] | undefined;
      message = `unrecognized product key(s): ${(keys ?? []).join(', ')} — not part of the ${prefix || 'products'} contract`;
    }
    return { path: path || prefix, message };
  });
}

/**
 * Validate a products FRAGMENT (incremental write) for `phase`. Unknown
 * top-level product block names are rejected (strict root); present fields are
 * type-checked; MISSING fields are allowed (writes are incremental). Returns
 * `{skipped:true}` for phases with no registered schema.
 *
 * `products` is `patch.phases.<phase>.products` — pass that sub-object, not the
 * whole patch.
 */
export function validatePhaseProductsFragment(
  phase: string,
  products: unknown,
): ProductsValidationResult {
  const schema = (PHASE_PRODUCTS_SCHEMAS as Record<string, z.ZodTypeAny>)[phase];
  if (!schema) return { valid: true, skipped: true, issues: [] };
  if (products === undefined || products === null) {
    return { valid: true, skipped: false, issues: [] };
  }
  const parsed = schema.safeParse(products);
  if (parsed.success) return { valid: true, skipped: false, issues: [] };
  return {
    valid: false,
    skipped: false,
    issues: flattenZodIssues(parsed.error, 'products'),
  };
}

/**
 * Boundary completeness check: every {@link REQUIRED_PRODUCT_KEYS} dot-path for
 * `phase` must resolve to a non-empty value in `products`. Use when a phase
 * reports `done`. Runs the fragment (shape) check first.
 */
export function validatePhaseProductsComplete(
  phase: string,
  products: unknown,
): ProductsValidationResult {
  const shape = validatePhaseProductsFragment(phase, products);
  if (!shape.valid || shape.skipped) return shape;
  const required = REQUIRED_PRODUCT_KEYS[phase as PhaseName] ?? [];
  const issues: ProductsValidationIssue[] = [];
  for (const dotted of required) {
    if (resolveDotPath(products, dotted) === undefined) {
      issues.push({
        path: `products.${dotted}`,
        message: `required handoff key missing for completed phase '${phase}' — the ace-web summary renders this`,
      });
    }
  }
  return { valid: issues.length === 0, skipped: false, issues };
}

function resolveDotPath(obj: unknown, dotted: string): unknown {
  let cur: any = obj;
  for (const seg of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  if (cur === '' || cur === null) return undefined;
  return cur;
}

export interface PhaseProductsClassification {
  phase: string;
  /** The phase's `status` from run_state (undefined if the phase block is absent). */
  status: string | undefined;
  ok: boolean;
  /**
   * Which check ran:
   * - `complete`  — phase is `done`/`complete`; both shape AND required-key
   *   completeness were checked.
   * - `fragment`  — phase not yet done; only shape was checked (incremental
   *   writes are allowed to be partial).
   * - `skipped`   — phase has no registered products schema.
   */
  mode: 'complete' | 'fragment' | 'skipped';
  issues: ProductsValidationIssue[];
}

/**
 * Boundary-fence classifier: given a PARSED `run_state.yaml` object and a phase
 * name, validate that phase's `products` block. Runs the strict completeness
 * check (`validatePhaseProductsComplete`) only when the phase is `done` /
 * `complete` — so an in-flight phase's incremental fragment writes are not
 * flagged as "incomplete"; before then it only shape-checks. This is the
 * run_state-level companion to {@link verifyPhaseArtifacts} (which checks Drive
 * files): wire both into the phase boundary fence so a phase can't ship `done`
 * with a malformed or missing typed handoff the ace-web summary needs.
 */
export function classifyPhaseProducts(
  parsed: unknown,
  phase: string,
): PhaseProductsClassification {
  const phaseBlock =
    (parsed as any)?.phases?.[phase] && typeof (parsed as any).phases[phase] === 'object'
      ? (parsed as any).phases[phase]
      : {};
  const status: string | undefined = typeof phaseBlock.status === 'string' ? phaseBlock.status : undefined;
  const products = phaseBlock.products;
  const isDone = status === 'done' || status === 'complete';
  const r = isDone
    ? validatePhaseProductsComplete(phase, products)
    : validatePhaseProductsFragment(phase, products);
  return {
    phase,
    status,
    ok: r.valid,
    mode: r.skipped ? 'skipped' : isDone ? 'complete' : 'fragment',
    issues: r.issues,
  };
}
