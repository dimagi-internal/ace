import { z } from 'zod';

/**
 * Schema for `run_state.yaml.phases.commcare-setup.products.apps`.
 *
 * This block is the structured handoff Phase 3 produces and Phase 4+
 * consumes. The `app-deploy` skill is its sole writer (see
 * `skills/app-deploy/SKILL.md` § Products). Downstream readers include
 * `connect-opp-setup`, `llo-uat`, `llo-launch`, and the ace-web summary
 * view. Each reader unpacks fields directly — drift in this block (wrong
 * key, missing field, malformed URL) breaks every downstream consumer
 * silently.
 *
 * Validate before writing to `run_state.yaml`:
 *
 * ```ts
 * import { AppsProductsSchema } from './products-apps-schema.js';
 * AppsProductsSchema.parse(block);  // throws on shape violation
 * ```
 */

const BUILD_STATUS = z.enum(['success', 'errored', 'pending']);

const AppEntrySchema = z.object({
  name: z.string().min(1),
  nova_app_id: z.string().min(1),
  nova_url: z.string().url(),
  hq_app_id: z.string().min(1),
  hq_url: z.string().url(),
  build_status: BUILD_STATUS,
}).refine(
  (e) => e.nova_url === `https://commcare.app/build/${e.nova_app_id}`,
  {
    message: 'nova_url must be https://commcare.app/build/<nova_app_id>',
    path: ['nova_url'],
  },
);

export const AppsProductsSchema = z.object({
  learn: AppEntrySchema,
  deliver: AppEntrySchema,
});

export type AppsProducts = z.infer<typeof AppsProductsSchema>;
export type AppEntry = z.infer<typeof AppEntrySchema>;
