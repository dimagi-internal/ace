//
// What Phase 3 WRITES to `run_state.phases.commcare-setup.products`.
//
// The Phase-3 twin of `lib/component-products.ts` (ace#1996 / PR #1999).
// `app-deploy` is the sole writer of `products.apps`; until ace#2157 the shape
// lived only as a YAML example in `skills/app-deploy/SKILL.md`, and a
// componentized Phase 3 had no declared place to say WHICH components each app
// built. The first live componentized run (`poverty-graduation/20260905-1345`)
// smuggled that fact through the `.passthrough()` app entries under two
// spellings — `components_covered` on Learn, `components_built` on Deliver —
// that nothing validated and nothing downstream could discover.
//
// Operator decision (2026-10-16, ace#2157): the key is `components_built`,
// recorded PER APP. Learn and Deliver legitimately build different component
// sets (Learn builds a module for every component with a PDD; Deliver builds
// forms only for components that deliver a paid or recorded service), so one
// products-level list would have to lie about one of them.
//
// This builder is the one place that shape is produced, and the schema test
// validates ITS output — not a hand-written fixture — so the schema and the
// producer cannot drift apart again.
//

import { compareComponentIds } from './component-set';
import type { LearnModulePlan } from './learn-module-plan';
import { novaAppUrl } from './nova-url';

export type BuildStatus = 'success' | 'errored' | 'pending';

/** What one app's build + upload produced. */
export interface AppBuildFacts {
  name: string;
  nova_app_id: string;
  hq_app_id: string;
  hq_url: string;
  build_status: BuildStatus;
  /**
   * Componentized runs only: the Phase-1 component ids (`products.components[]
   * .component_id`) this app built content for, verbatim. Learn: one module per
   * id (`learnComponentsBuilt(plan)`). Deliver: the components it built forms for.
   */
  components_built?: string[];
}

export interface CommcareAppEntry {
  name: string;
  nova_app_id: string;
  nova_url: string;
  hq_app_id: string;
  hq_url: string;
  build_status: BuildStatus;
  components_built?: string[];
}

export interface CommcareProducts {
  apps: {
    learn?: CommcareAppEntry;
    deliver?: CommcareAppEntry;
  };
}

export interface CommcareProductsInput {
  learn?: AppBuildFacts;
  deliver?: AppBuildFacts;
  /**
   * Phase 1's `products.components[]` when the run is componentized
   * (`products.mode === 'componentized'`); omit on the synthesized path.
   */
  components?: { component_id: string }[];
}

export class CommcareProductsError extends Error {}

/** The component ids a Learn module plan built — one per planned module. */
export function learnComponentsBuilt(plan: Pick<LearnModulePlan, 'modules'>): string[] {
  return plan.modules.filter((m) => m.built).map((m) => m.component_id);
}

function componentsBuiltFor(
  app: 'learn' | 'deliver',
  ids: string[] | undefined,
  known: Set<string> | null,
): string[] | undefined {
  if (known === null) {
    if (ids !== undefined) {
      throw new CommcareProductsError(
        `${app}: components_built given on a synthesized run (no Phase-1 components) — ` +
          'either the run is componentized and Phase 1 components were not passed, or this is a misclassification',
      );
    }
    return undefined;
  }
  if (ids === undefined || ids.length === 0) {
    throw new CommcareProductsError(
      `${app}: a componentized Phase 3 must record which components this app built (components_built)`,
    );
  }
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new CommcareProductsError(
      `${app}: components_built names component(s) Phase 1 never declared: ${unknown.join(', ')}`,
    );
  }
  return [...new Set(ids)].sort(compareComponentIds);
}

function entry(
  app: 'learn' | 'deliver',
  facts: AppBuildFacts,
  known: Set<string> | null,
): CommcareAppEntry {
  const built = componentsBuiltFor(app, facts.components_built, known);
  return {
    name: facts.name,
    nova_app_id: facts.nova_app_id,
    nova_url: novaAppUrl(facts.nova_app_id),
    hq_app_id: facts.hq_app_id,
    hq_url: facts.hq_url,
    build_status: facts.build_status,
    ...(built ? { components_built: built } : {}),
  };
}

/**
 * Build the `phases.commcare-setup.products` block `app-deploy` writes.
 *
 * Throws rather than degrading: a componentized run with an app that records
 * no `components_built`, or names a component Phase 1 never declared, is the
 * unvalidated drift ace#2157 exists to stop.
 */
export function buildCommcareProducts(input: CommcareProductsInput): CommcareProducts {
  const known = input.components ? new Set(input.components.map((c) => c.component_id)) : null;
  if (known !== null && known.size === 0) {
    throw new CommcareProductsError(
      'components given but empty — a run with no components belongs on the synthesized path',
    );
  }
  const apps: CommcareProducts['apps'] = {};
  if (input.learn) apps.learn = entry('learn', input.learn, known);
  if (input.deliver) apps.deliver = entry('deliver', input.deliver, known);
  return { apps };
}
