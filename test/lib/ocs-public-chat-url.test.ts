/**
 * dimagi-internal/ace#1021 — the issue concluded "there is no OCS widget URL
 * to fetch", and both `ocs-agent-setup` and `ocs-widget-handoff-eval` were
 * written against that conclusion. It is wrong: an anonymous chat surface
 * exists, it is just none of the three paths that were probed.
 *
 * The probes were `/chatbots/embed/<public_id>/`, `/chat/<public_id>/` and
 * `/c/<public_id>/`. Read from source (dimagi/open-chat-studio, main):
 *
 *   config/urls.py:64          path("chatbots/", include("apps.chatbots.urls"))   # inside team_urlpatterns
 *   config/urls.py:88          path("a/<slug:team_slug>/", include(team_urlpatterns))
 *   apps/chatbots/urls.py:80   path("<uuid:experiment_id>/start/",
 *                                   views.start_chatbot_session_public,
 *                                   name="start_session_public")
 *
 * so the route is TEAM-SCOPED: `/a/<team_slug>/chatbots/<public_id>/start/`.
 * The `/chatbots/embed/…` flow really was deleted (2026-08-03, OCS #3540 —
 * `apps/experiments/urls.py` now maps it to `embed_flow_gone`), which is why
 * the issue's first probe 404s; the other two were never routes at all.
 *
 * Verified live 2026-08-14 against team `connect-ace`, bot
 * `f92d26f3-2dbe-4c4a-a9fd-7cb0d80fc099`, unauthenticated:
 *
 *   no cookie jar   → 302 then 404 at /s/<session>/chat/
 *   with cookie jar → 200, a live chat page
 *
 * Both are correct behaviour and the difference is the whole trap.
 * `start_session_public` CREATES a session and redirects, and `chatbot_chat`
 * is wrapped in `@verify_session_access_cookie` — so a cookieless probe
 * (curl without `-c/-b`) reads as 404 on a perfectly working bot. Any
 * liveness check must carry cookies through the redirect.
 *
 * Two gates the URL depends on, both from source:
 *   - `start_session_public` resolves the PUBLISHED version and requires
 *     `experiment_version.is_public` (apps/experiments/views/experiment.py:262)
 *   - `is_public` is `len(participant_allowlist) == 0`
 *     (apps/experiments/models.py:998)
 */
import { describe, it, expect } from 'vitest';
import { buildOcsPublicChatUrl } from '../../lib/ocs-public-chat-url.js';

describe('buildOcsPublicChatUrl (#1021)', () => {
  it('builds the team-scoped public start route', () => {
    expect(
      buildOcsPublicChatUrl({
        teamSlug: 'connect-ace',
        publicId: 'f92d26f3-2dbe-4c4a-a9fd-7cb0d80fc099',
      }),
    ).toBe(
      'https://www.openchatstudio.com/a/connect-ace/chatbots/f92d26f3-2dbe-4c4a-a9fd-7cb0d80fc099/start/',
    );
  });

  it('is NOT the deleted embed path — that flow is a 410 stub since OCS #3540', () => {
    const u = buildOcsPublicChatUrl({ teamSlug: 't', publicId: 'p' });
    expect(u).not.toContain('/embed/');
  });

  it('honours a non-default base URL without doubling the slash', () => {
    expect(
      buildOcsPublicChatUrl({ baseUrl: 'https://ocs.example.org/', teamSlug: 't', publicId: 'p' }),
    ).toBe('https://ocs.example.org/a/t/chatbots/p/start/');
  });

  it('refuses to build a URL with a missing part rather than emitting a broken one', () => {
    expect(() => buildOcsPublicChatUrl({ teamSlug: '', publicId: 'p' })).toThrow(/teamSlug/);
    expect(() => buildOcsPublicChatUrl({ teamSlug: 't', publicId: '' })).toThrow(/publicId/);
  });
});

describe('the skills no longer say the surface does not exist (#1021)', () => {
  const read = async (p: string) =>
    (await import('node:fs')).readFileSync(
      new URL(`../../${p}`, import.meta.url).pathname,
      'utf8',
    );

  it('ocs-agent-setup names the working public route', async () => {
    const src = await read('skills/ocs-agent-setup/SKILL.md');
    expect(src).toMatch(/chatbots\/<public_id>\/start\//);
    expect(src, 'the retired claim must be gone').not.toMatch(
      /there's no standalone embed page/i,
    );
  });

  it('ocs-widget-handoff-eval probes the real route, with cookies', async () => {
    const src = await read('skills/ocs-widget-handoff-eval/SKILL.md');
    expect(src).toMatch(/start\//);
    expect(src, 'a cookieless probe reads 404 on a working bot').toMatch(/cookie/i);
  });
});
