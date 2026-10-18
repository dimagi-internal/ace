/**
 * Type surface for the plain-node marketplace resolver behind `/ace:update` (ace#3143).
 *
 * A `.d.mts` beside a `.mjs` rather than a `.ts` through tsx: on canopy runners the
 * plugin cache's `node_modules/.bin/tsx` is a plain file and fails, so `/ace:update`
 * runs this with bare `node`.
 */

export const MARKETPLACE_NAME: 'ace';

export interface AceMarketplace {
  /** Where the marketplace lives on disk. */
  path: string;
  /** `known_marketplaces.json` `ace.source.source`, or `unregistered`/`unknown`. */
  sourceType: string;
  /** `directory` = a checkout someone else owns (canopy runner); never pulled by /ace:update. */
  mode: 'clone' | 'directory';
}

export function resolveAceMarketplace(args: { known: unknown; home: string }): AceMarketplace;

/** Shell-safe `KEY='value'` lines (MARKETPLACE, SOURCE_TYPE, MODE) for `eval`. */
export function formatShell(res: AceMarketplace): string;
