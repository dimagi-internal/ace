// The one HQ step ACE cannot do itself: setting a new project space to
// "Test or Demo Project", which puts it on HQ's Enterprise plan, not invoiced
// (ace#2552). It is a setting on the space alone — it does NOT attach the space
// to the `ace-enterprise` project or its billing account.
//
// Every new space (made in the HQ UI or by `commcare_create_domain`) starts on CommCare Free Edition
// (REST API closed). HQ's only way onto Enterprise for these spaces is the
// "Test or Demo Project" option on internal subscription management, and that
// view is `@require_superuser` (corehq/apps/domain/views/accounting.py
// InternalSubscriptionManagementView) — as ace@ it 302s to /no_permissions/
// (observed 2026-10-02). Enterprise accounts give no self-serve path: new
// spaces always get a Free subscription (registration/utils.py
// `_setup_subscription`), and the enterprise console has no add-space view.
// So a Dimagi HQ superuser does it, once per space: since 2026-10-02 while
// setting the space up from the clone's operator checklist
// (lib/clone-setup-checklist.ts, item 1b), with `/ace:validate-release-readiness`
// (step 5) as the re-check and fallback.
//
// This module is the single wording of that step, so the clone checklist,
// and validate-release-readiness both show the operator the same URL and clicks.

export const HQ_BASE_URL = 'https://www.commcarehq.org';

/** The page the superuser opens — the space's own settings page. */
export function hqEnterpriseFlipUrl(domain: string): string {
  return `${HQ_BASE_URL}/a/${encodeURIComponent(domain)}/settings/project/internal_subscription_management/`;
}

/** The read-back page: shows the space's plan after the flip. */
export function hqSubscriptionUrl(domain: string): string {
  return `${HQ_BASE_URL}/a/${encodeURIComponent(domain)}/settings/project/subscription/`;
}

/** Numbered steps, markdown, for a human HQ superuser. */
export function hqEnterpriseFlipSteps(domain: string): string {
  return [
    `**HQ superuser step — set \`${domain}\` to "Test or Demo Project"** (about a minute; ace@ cannot do this, HQ restricts it to superusers):`,
    `1. Signed in to CommCare HQ as a Dimagi **superuser**, open ${hqEnterpriseFlipUrl(domain)}`,
    `2. Under **Subscription Type**, choose **Test or Demo Project**.`,
    `3. Press **Update**. HQ redirects to the space's Current Subscription page.`,
    `4. Check that page (${hqSubscriptionUrl(domain)}) now shows an **Enterprise** plan, not "CommCare Free Edition".`,
    `Not invoiced (sanctioned by accounts for ACE's partner review spaces, Gillian Javetski 2026-10-02) — do NOT pick a paid plan or an extended trial instead.`,
    `Then tell ACE "done"; it reads the plan back with commcare_get_subscription.`,
  ].join('\n');
}

/** The HQ space a run's apps live in, from run_state (null when not recorded). */
export function hqDomainFromRunState(runState: unknown): string | null {
  const apps = (runState as { phases?: Record<string, { products?: { apps?: Record<string, unknown> } }> })
    ?.phases?.['commcare-setup']?.products?.apps;
  if (!apps) return null;
  if (typeof apps.domain === 'string' && apps.domain) return apps.domain;
  for (const k of ['learn', 'deliver', 'learn_app', 'deliver_app']) {
    const a = apps[k] as { domain?: unknown; hq_url?: unknown } | undefined;
    if (typeof a?.domain === 'string' && a.domain) return a.domain;
    // Phase 3 records only `hq_url` (…/a/<domain>/apps/view/<id>/) — the real
    // spark-facilitator/20260926-1800 run_state has no `domain` field at all.
    const m = typeof a?.hq_url === 'string' ? a.hq_url.match(/\/a\/([^/]+)\//) : null;
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}
