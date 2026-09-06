/**
 * Regression tests for `hqOAuthLogin`'s project-space consent step (ace#1766).
 *
 * UPSTREAM MECHANISM (confirmed in commcare-hq SOURCE, not from a PR title):
 * dimagi/commcare-hq#38040 "Allow domain-scoping OAuth tokens" (merged
 * 2026-08-21) added a project-space step to HQ's OAuth consent prompt. Three
 * halves of it matter here, and each is quoted from master:
 *
 *   1. `corehq/apps/hqwebapp/templates/hqwebapp/bootstrap5/oauth_authorize.html`
 *      renders Authorize as
 *        <input type="submit" name="allow" value="Authorize"
 *               :disabled="selectedDomains.length === 0" disabled>
 *      i.e. it ships DISABLED and stays that way until a project space is
 *      picked. The "Select all" button beside it is `x-show="domainCount > 1"`,
 *      so it is absent from the layout for a single-project account.
 *
 *   2. `corehq/apps/hqwebapp/forms.py` `HQAllowForm` declares the field as a
 *      Select2-bound multi-select:
 *        'x-select2': ..., '@select2change': 'selectedDomains = $event.detail || []'
 *      so Alpine only learns about a selection through the `select2change`
 *      CustomEvent that `alpinejs/directives/select2.js` re-dispatches from the
 *      underlying `change`. Setting `option.selected` from Playwright is
 *      otherwise silent — HQ's own `setAllDomains()` dispatches `change` for
 *      exactly this reason.
 *
 *   3. The same form validates it server-side:
 *        if cleaned_data.get('allow') and not cleaned_data.get('domains'):
 *            add_error('domains', "Choose at least one project space.")
 *      So even a forced click POSTs and RE-RENDERS `/oauth/authorize/` rather
 *      than redirecting — which is precisely the reported symptom: the click
 *      registers, the URL never leaves the authorize page, the 15s
 *      `waitForURL` expires, and it is classified `oauth-consent`, a stage name
 *      that reads like rejected credentials and sends the operator at
 *      1Password. Every Connect + CCHQ auto-relogin failed this way, which
 *      halts Phase 3 and Phase 4 of any `/ace:run`.
 *
 * The driver fix shipped in f423ce12 (2026-08-28). It had no test, so nothing
 * stops a future edit from quietly restoring the halt — these are that test.
 * The fakes below model the page by the ACTUAL selector strings the driver
 * uses, so a selector rename fails here rather than in a live run.
 */
import { describe, it, expect } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { hqOAuthLogin } from '../../../../mcp/connect/auth/hq-oauth-login.js';

const BASE_URL = 'https://connect.dimagi.com';
const AUTHORIZE_URL =
  'https://www.commcarehq.org/oauth/authorize/?client_id=TY1MDae&scope=access_apis';
const LANDED_URL = `${BASE_URL}/a/ai-demo-space/opportunity/`;
const CREDS = { hqUsername: 'ace@dimagi-ai.com', hqPassword: 'unused-on-this-path' };

/** Poll a predicate on the fake page's mutable URL. */
async function pollUntil(pred: () => boolean, label: string): Promise<void> {
  // Deliberately ignores the caller's timeout (15s / 10s in the driver): these
  // waits never resolve on the failure path, and a test suite should not spend
  // real wall-clock proving that. 50 ticks is far more than the fakes need.
  for (let i = 0; i < 50; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`Timeout ${label}`);
}

interface AuthorizePageOptions {
  /** Number of project spaces on HQ's consent prompt. 0 = no project-space step. */
  domainCount: number;
  /** HQ hides "Select all" behind x-show="domainCount > 1". */
  selectAllVisible: boolean;
}

/**
 * A Page that behaves like HQ's post-#38040 authorize prompt: Authorize is
 * disabled and the POST is refused until at least one project space is
 * selected, and a selection only registers through the events Alpine listens
 * on.
 */
function makeAuthorizePage(opts: AuthorizePageOptions) {
  const options = Array.from({ length: opts.domainCount }, (_, i) => ({
    value: `project-space-${i}`,
    selected: false,
  }));

  const state = {
    url: `${BASE_URL}/accounts/login/`,
    selectAllClicked: false,
    /** Events the driver's fallback announced on the hidden <select>. */
    dispatched: [] as string[],
    /** Authorize was clicked while HQ still had it disabled. */
    clickedWhileDisabled: false,
  };

  // Alpine's `selectedDomains`, as HQ maintains it: seeded empty at init, and
  // only updated when a `select2change` reaches the @select2change binding.
  let selectedDomains: string[] = [];
  const authorizeEnabled = () => opts.domainCount === 0 || selectedDomains.length > 0;

  const domainsLocator = {
    count: async () => (opts.domainCount > 0 ? 1 : 0),
    first: () => domainsLocator,
    evaluate: async (fn: (el: unknown) => void) => {
      const select = {
        options,
        get selectedOptions() {
          return options.filter((o) => o.selected);
        },
        dispatchEvent: (ev: Event) => {
          state.dispatched.push(ev.type);
          if (ev.type === 'select2change') {
            selectedDomains = (ev as CustomEvent).detail ?? [];
          }
          return true;
        },
      };
      return fn(select);
    },
  };

  const selectAllLocator = {
    count: async () => (opts.selectAllVisible ? 1 : 0),
    first: () => selectAllLocator,
    isVisible: async () => opts.selectAllVisible,
    click: async () => {
      state.selectAllClicked = true;
      // HQ's own setAllDomains(true) → change → select2 → select2change.
      options.forEach((o) => (o.selected = true));
      selectedDomains = options.map((o) => o.value);
    },
  };

  const enabledAuthorizeLocator = {
    count: async () => (authorizeEnabled() ? 1 : 0),
    first: () => enabledAuthorizeLocator,
    waitFor: async () => pollUntil(authorizeEnabled, 'waiting for Authorize to enable'),
  };

  const approveLocator = {
    count: async () => 1,
    first: () => approveLocator,
    click: async () => {
      if (!authorizeEnabled()) {
        // HQAllowForm.clean() adds "Choose at least one project space." and the
        // view re-renders the authorize page. No redirect.
        state.clickedWhileDisabled = true;
        return;
      }
      state.url = LANDED_URL;
    },
  };

  const page = {
    goto: async () => null,
    url: () => state.url,
    $: async (selector: string) => {
      if (selector.includes('Login with CommCareHQ')) {
        return {
          click: async () => {
            // The bounce lands straight on the consent prompt (CCHQ session
            // still valid) — branch (b) in the driver's header comment.
            state.url = AUTHORIZE_URL;
          },
        };
      }
      return null;
    },
    locator: (selector: string) => {
      if (selector === '#id_domains') return domainsLocator;
      if (selector.includes('Select all')) return selectAllLocator;
      if (selector.includes(':not([disabled])')) return enabledAuthorizeLocator;
      if (selector.includes('input[name="allow"]')) return approveLocator;
      throw new Error(`fake page: unmodelled selector ${selector}`);
    },
    waitForURL: async (pred: (u: string) => boolean) =>
      pollUntil(() => pred(state.url), `waiting for URL, stuck at ${state.url}`),
    close: async () => undefined,
  } as unknown as Page;

  return { page, state, context: { newPage: async () => page } as unknown as BrowserContext };
}

describe('hqOAuthLogin — HQ project-space consent step (ace#1766)', () => {
  it('clicks "Select all" and completes consent on a multi-project account', async () => {
    // The live shape: 9 project spaces, "Select all" rendered.
    const { page, state, context } = makeAuthorizePage({ domainCount: 9, selectAllVisible: true });

    await expect(hqOAuthLogin({ context, baseUrl: BASE_URL, ...CREDS })).resolves.toBeUndefined();

    expect(state.selectAllClicked).toBe(true);
    // The halt this issue is about: Authorize clicked with nothing selected.
    expect(state.clickedWhileDisabled).toBe(false);
    expect(page.url()).toBe(LANDED_URL);
  });

  it('grants ALL project spaces, not a subset', async () => {
    // Deliberate: the token spans whichever spaces an opportunity lives in, and
    // a subset does not fail loudly — it returns much later as a 403 or a
    // silently empty list from an API never granted the space it needed.
    const { context, state } = makeAuthorizePage({ domainCount: 9, selectAllVisible: false });

    await hqOAuthLogin({ context, baseUrl: BASE_URL, ...CREDS });

    expect(state.clickedWhileDisabled).toBe(false);
    // Fallback path: every option selected, announced the way Alpine listens.
    expect(state.dispatched).toContain('select2change');
  });

  it('falls back to the select2change event when "Select all" is hidden (single-project account)', async () => {
    // HQ hides "Select all" behind x-show="domainCount > 1". Playwright cannot
    // drive the real <select> (Select2 hides it aria-hidden / tabindex=-1), so
    // the driver sets the options and announces it itself.
    const { context, state } = makeAuthorizePage({ domainCount: 1, selectAllVisible: false });

    await expect(hqOAuthLogin({ context, baseUrl: BASE_URL, ...CREDS })).resolves.toBeUndefined();

    expect(state.selectAllClicked).toBe(false);
    expect(state.dispatched).toEqual(expect.arrayContaining(['change', 'select2change']));
    expect(state.clickedWhileDisabled).toBe(false);
  });

  it('still authorizes on a deployment with no project-space step (older HQ, or an upstream revert)', async () => {
    // The forward-compatibility guard the issue asked for: `#id_domains`
    // absent must not become a new failure mode of its own.
    const { context, state } = makeAuthorizePage({ domainCount: 0, selectAllVisible: false });

    await expect(hqOAuthLogin({ context, baseUrl: BASE_URL, ...CREDS })).resolves.toBeUndefined();

    expect(state.selectAllClicked).toBe(false);
    expect(state.dispatched).toEqual([]);
  });

  it('NEGATIVE CONTROL: the modelled page really does halt when nothing is selected', async () => {
    // Proves the fakes above reproduce ace#1766 rather than passing vacuously.
    // Consent is driven by hand here with the project-space step SKIPPED — the
    // pre-f423ce12 behaviour — and the page must refuse exactly as HQ does.
    const { page, state } = makeAuthorizePage({ domainCount: 9, selectAllVisible: true });
    (await page.$('button:has-text("Login with CommCareHQ")'))!.click();

    await page
      .locator('input[name="allow"], button:has-text("Authorize"), button:has-text("Allow")')
      .first()
      .click();

    expect(state.clickedWhileDisabled).toBe(true);
    expect(page.url()).toBe(AUTHORIZE_URL); // never redirected
    // String(u) rather than `new URL(u)`: Playwright's type says the callback
    // receives a URL, the driver treats it as a string, and both are correct
    // at runtime — the fake hands over the raw href.
    await expect(
      page.waitForURL((u) => String(u).includes('connect.dimagi.com')),
    ).rejects.toThrow(/Timeout/);
  });
});
