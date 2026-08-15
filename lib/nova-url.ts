/**
 * The one place a Nova app URL is constructed.
 *
 * ace#1431. Nova's working route is `/build/<id>`; the legacy `/apps/<id>`
 * 404s. Three places templated the URL independently and they disagreed:
 * `app-deploy` used `/build/` and carried a comment saying the upstream
 * summaries were wrong, while `pdd-to-learn-app` and `pdd-to-deliver-app` kept
 * emitting `/apps/` in their build-summary frontmatter. So `app-deploy` knew
 * the producers were broken, worked around it for `run_state.yaml`, and the
 * producers went on shipping a dead link on every run — observed live on
 * bednet-check-2-visit/20260814-2019.
 *
 * The workaround comment was the tell that this had already drifted once. One
 * exported builder plus the invariant in `lib/products-apps-schema.ts` means
 * the next route change is a single edit rather than a hunt.
 */

export const NOVA_BASE_URL = 'https://commcare.app' as const;

/**
 * Preview URL for a Nova app.
 *
 * `/build/<id>` — NOT `/apps/<id>`, which is the legacy route and 404s.
 */
export function novaAppUrl(novaAppId: string): string {
  return `${NOVA_BASE_URL}/build/${novaAppId}`;
}

/** True for a URL this builder would produce. Used by the run_state validator. */
export function isNovaAppUrl(url: string, novaAppId: string): boolean {
  return url === novaAppUrl(novaAppId);
}
