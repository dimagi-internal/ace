/**
 * ace#1767 — a scrape must never mistake OCS's sign-in page for the page it
 * asked for, and an auth failure must never be reported as a content problem.
 *
 * The mechanism, reproduced live against openchatstudio.com on 2026-09-06 with
 * a storageState whose `sessionid` had a past LOCAL `expires` stamp (the
 * server-side session was valid the whole time — a plain fetch with the same
 * cookie value returned the real page):
 *
 *     --- file cookies ---
 *      sessionid expires=1788704327 EXPIRED
 *     --- context cookies after load ---   (sessionid absent — Playwright drops it)
 *      ocs_language / csrftoken / theme
 *     status 200 ok true len 10663
 *     final url: https://www.openchatstudio.com/accounts/login/?next=/a/connect-ace/chatbots/11792/
 *     has api-url-link: false
 *     title: Sign In | Open Chat Studio
 *
 * `homeRes.ok` is TRUE, because the transport followed the 302 and the sign-in
 * page really is a 200. So `extractPublicId` missed and the atom reported
 * "Flag `flag_chat_widget` may be off" — blaming a feature flag for a dead
 * cookie. `bin/ace-doctor` then emitted `ocs_generation: status: fail, class:
 * unknown`, which HALTS `/ace:run` before Phase 1 (ace#1516) and sends the
 * operator at an LLM provider key that was healthy throughout.
 *
 * The final URL is the one field that can tell the two apart, and it costs
 * nothing to read.
 */
import { describe, it, expect } from 'vitest';
import { PlaywrightBackend } from '../../../../mcp/ocs/backends/playwright.js';
import { OcsAuthRedirectError } from '../../../../mcp/ocs/errors.js';
import { classifyGenerationFailure, probeStatusFor } from '../../../../lib/ocs-generation-probe.js';

const TEAM = 'connect-ace';
const BASE = 'https://www.openchatstudio.com';
const EID = 11792;

/** Abridged from the real sign-in page the live repro fetched. */
const SIGN_IN_HTML = `<!doctype html><html><head><title>Sign In | Open Chat Studio</title></head>
<body><form method="post" action="/accounts/login/"><input name="login"><input name="password">
</form></body></html>`;

/**
 * Abridged from the real chatbot home page, matching what the extractors
 * actually anchor on: the `#api-url-link` hidden input and the channel
 * button's `hx-get` + `fa-embedded_widget` icon.
 */
const HOME_HTML = `<!doctype html><html><body>
<input id="api-url-link" type="hidden"
       value="${BASE}/api/openai/cc4c5d04-b3cd-471a-91fe-0817824cf7b7/chat/completions" />
<button hx-get="/a/${TEAM}/chatbots/${EID}/channels/4242/edit-dialog/">
  <i class="fa-brands fa-embedded_widget"></i>
</button>
</body></html>`;

const DIALOG_HTML = `<input id="widget_token" type="text" value="Aq6utmgUFUXttX8IJrMAwENUVMb6PZnR">`;

/**
 * A backend whose transport behaves like Playwright's: it FOLLOWS the 302 to
 * the sign-in page and reports the result as 200/ok, exposing the redirect
 * only through the final url.
 */
function backend(opts: { authed: boolean; supplyUrl?: boolean }) {
  const seen: string[] = [];
  return {
    seen,
    be: new PlaywrightBackend({
      teamSlug: TEAM,
      baseUrl: BASE,
      csrfToken: 'csrf',
      request: async (_m: string, p: string) => {
        seen.push(p);
        if (!opts.authed) {
          const finalUrl = `${BASE}/accounts/login/?next=${p}`;
          return {
            ok: true,
            status: 200,
            headers: {},
            ...(opts.supplyUrl === false ? {} : { url: finalUrl }),
            text: async () => SIGN_IN_HTML,
            json: async () => ({}),
          };
        }
        const body = p.includes('edit-dialog') ? DIALOG_HTML : HOME_HTML;
        return {
          ok: true,
          status: 200,
          headers: {},
          url: `${BASE}${p}`,
          text: async () => body,
          json: async () => ({}),
        };
      },
    }),
  };
}

describe('getChatbotEmbedInfo refuses to scrape the sign-in page (ace#1767)', () => {
  it('throws an AUTH error, not the flag_chat_widget message, on an anonymous context', async () => {
    const { be } = backend({ authed: false });

    await expect(be.getChatbotEmbedInfo({ experiment_id: EID })).rejects.toBeInstanceOf(
      OcsAuthRedirectError,
    );
  });

  it('does not blame `flag_chat_widget` for a dead cookie', async () => {
    // The specific misdirection this issue is about: the operator was sent to
    // check a feature flag and an LLM provider key, both of which were fine.
    const { be } = backend({ authed: false });

    await expect(be.getChatbotEmbedInfo({ experiment_id: EID })).rejects.toThrow(
      /redirected to the OCS sign-in page/,
    );
    await expect(be.getChatbotEmbedInfo({ experiment_id: EID })).rejects.not.toThrow(
      /flag_chat_widget/,
    );
  });

  it('refuses at the FIRST request, before any scraping is attempted', async () => {
    // Asserts the guard's POSITION, not just its existence: it must fire on
    // the home-page response rather than after a downstream selector misses.
    const { be, seen } = backend({ authed: false });
    await expect(be.getChatbotEmbedInfo({ experiment_id: EID })).rejects.toBeInstanceOf(
      OcsAuthRedirectError,
    );
    expect(seen).toEqual([`/a/${TEAM}/chatbots/${EID}/`]);
  });

  it('POSITIVE CONTROL: an authenticated response still scrapes normally', async () => {
    // Without this the guard could be satisfied by refusing everything.
    const { be } = backend({ authed: true });

    const info = await be.getChatbotEmbedInfo({ experiment_id: EID });
    expect(info.public_id).toBe('cc4c5d04-b3cd-471a-91fe-0817824cf7b7');
    expect(info.embed_key).toBe('Aq6utmgUFUXttX8IJrMAwENUVMb6PZnR');
  });

  it('a transport that supplies no `url` behaves exactly as before (older fakes)', async () => {
    // `url` is optional on RequestResult. A caller that cannot supply it must
    // not start throwing auth errors — it just keeps the old, worse message.
    const { be } = backend({ authed: false, supplyUrl: false });

    await expect(be.getChatbotEmbedInfo({ experiment_id: EID })).rejects.toThrow(/flag_chat_widget/);
  });
});

describe('the auth error routes to a SKIP, not a run-halting FAIL (ace#1767)', () => {
  it('classifies the thrown message as no_session', () => {
    // The chain that matters end-to-end: the error text must be recognisable
    // to the doctor classifier, or the honest error still reports `unknown`.
    const err = new OcsAuthRedirectError(
      `/a/${TEAM}/chatbots/${EID}/`,
      `${BASE}/accounts/login/?next=/a/${TEAM}/chatbots/${EID}/`,
    );

    expect(classifyGenerationFailure(err.message).class).toBe('no_session');
  });

  it('reports no_session as skip — the halt class is the whole bug', () => {
    expect(probeStatusFor('no_session')).toBe('skip');
  });

  it('NEGATIVE CONTROL: every class that IS evidence about OCS still halts', () => {
    // A guard that turned everything into `skip` would hide real outages,
    // which is the opposite and equally expensive error.
    expect(probeStatusFor('ok')).toBe('pass');
    for (const cls of ['provider_capped', 'provider_auth', 'no_channel', 'timeout', 'transport', 'unknown'] as const) {
      expect(probeStatusFor(cls), `${cls} must still halt`).toBe('fail');
    }
  });

  it('the old message would NOT have classified as no_session — hence class: unknown', () => {
    // Why the reported block said `class: unknown`: nothing in the
    // flag_chat_widget text names auth, so no rule could match it.
    const old =
      `Could not scrape public_id from chatbot home page for experiment ${EID}. ` +
      'Flag `flag_chat_widget` may be off (the widget tag is behind that flag).';

    expect(classifyGenerationFailure(old).class).toBe('unknown');
    expect(probeStatusFor('unknown')).toBe('fail'); // → the halt
  });
});
