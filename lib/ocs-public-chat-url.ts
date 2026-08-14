/**
 * The anonymous chat URL for a published OCS chatbot.
 *
 * Why this is code (dimagi-internal/ace#1021): ACE concluded that no such URL
 * exists and wrote two skills against that conclusion — `ocs-agent-setup`
 * stated "there's no standalone embed page, only the corner widget", and
 * `ocs-widget-handoff-eval` kept gating 25% of its score on fetching a page it
 * had been told was a 404. The consequence is that every ACE per-opp chatbot
 * looked unreachable outside the OCS admin UI.
 *
 * The conclusion came from probing three paths, none of which is the route:
 * `/chatbots/embed/<public_id>/`, `/chat/<public_id>/`, `/c/<public_id>/`.
 * From source (`dimagi/open-chat-studio`, main):
 *
 * ```
 * config/urls.py:64          path("chatbots/", include("apps.chatbots.urls"))  # inside team_urlpatterns
 * config/urls.py:88          path("a/<slug:team_slug>/", include(team_urlpatterns))
 * apps/chatbots/urls.py:80   path("<uuid:experiment_id>/start/",
 *                                 views.start_chatbot_session_public,
 *                                 name="start_session_public")
 * ```
 *
 * The route is TEAM-SCOPED. The embed flow really was deleted (2026-08-03, OCS
 * issue #3540 — `apps/experiments/urls.py` maps it to `embed_flow_gone`), which
 * is why the first probe 404s; the other two were never routes.
 *
 * ## The cookie trap — a working bot reads as 404 without one
 *
 * Verified live 2026-08-14, team `connect-ace`, bot
 * `f92d26f3-2dbe-4c4a-a9fd-7cb0d80fc099`, unauthenticated:
 *
 * ```
 * curl -L               → 302, then 404 at /a/<team>/chatbots/<id>/s/<session>/chat/
 * curl -L -c jar -b jar → 200, a live chat page
 * ```
 *
 * Both are correct. `start_session_public` CREATES a session and redirects,
 * and the chat view is wrapped in `@verify_session_access_cookie`, so a
 * cookieless probe drops the session cookie and the redirect target refuses
 * it. Any liveness check MUST carry cookies through the redirect — a plain
 * `curl -sI` is exactly the false negative that produced this issue.
 *
 * ## Two gates the URL depends on
 *
 * - `start_session_public` resolves the PUBLISHED version and requires
 *   `experiment_version.is_public` (`apps/experiments/views/experiment.py:262`),
 *   so an unpublished bot 404s here whatever its working copy says.
 * - `is_public` is `len(participant_allowlist) == 0`
 *   (`apps/experiments/models.py:998`). ACE bots leave the allowlist empty,
 *   which is what makes them public.
 *
 * NOTE: this is the OCS half only. Connect genuinely has no per-opportunity
 * widget field to paste anything into — `#1021`'s second finding, which stands:
 * the `<open-chat-studio-widget>` on a Connect opportunity page is hard-coded
 * into the base template as ONE site-wide support bot (identical
 * `chatbot-id` / `embed-key` on the program page and on 404 pages).
 */

export interface PublicChatUrlParts {
  /** OCS base, default production. */
  baseUrl?: string;
  /** The OCS team slug — ACE's is normally `connect-ace`. */
  teamSlug: string;
  /** The chatbot's `public_id` (from `ocs_get_chatbot_embed_info`). */
  publicId: string;
}

export const OCS_DEFAULT_BASE_URL = 'https://www.openchatstudio.com';

export function buildOcsPublicChatUrl(parts: PublicChatUrlParts): string {
  const { baseUrl = OCS_DEFAULT_BASE_URL, teamSlug, publicId } = parts;
  if (!teamSlug) throw new Error('buildOcsPublicChatUrl: teamSlug is required');
  if (!publicId) throw new Error('buildOcsPublicChatUrl: publicId is required');
  return `${baseUrl.replace(/\/+$/, '')}/a/${teamSlug}/chatbots/${publicId}/start/`;
}
