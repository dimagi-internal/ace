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
 * ## The gate the URL depends on
 *
 * There is exactly one, and it is NOT about publishing. Re-verified against
 * upstream `main` on 2026-08-29 (ace#1812):
 *
 * - **The team's WEB channel must be enabled.** `start_session_public` calls
 *   `_disabled_web_channel_response(request)` before rendering the consent
 *   form; if the team has an `ExperimentChannel` with `platform=WEB` and
 *   `enabled=False`, every chat URL for that team returns the maintenance
 *   page — **HTTP 503**, not a 404 — with the channel's `disabled_message`.
 *   Added by OCS #4230 (`apps/experiments/views/experiment.py:263-274`;
 *   `is_disabled` is `not self.enabled`, `apps/channels/models.py:342-344`).
 *   This is a team-wide admin kill-switch, so one toggle takes down the chat
 *   URL of EVERY ACE per-opp bot at once. `connect-ace` has such a channel
 *   (`connect-ace-web-channel`). A channel row that does not exist yet cannot
 *   be disabled, so its absence is not a refusal.
 *
 * **Publishing is NOT a gate.** The view resolves
 * `resolve_published_or_working(experiment)`, so an UNPUBLISHED bot serves its
 * working version here rather than 404ing. Publishing still decides WHICH
 * version answers; it does not decide whether the URL is on.
 *
 * Historical note, so nobody "restores" the old text: this comment used to
 * describe two publish-time allowlist gates. OCS deleted both in #4275
 * (ADR-0057, merged 2026-08-26); the symbols they named now return zero hits
 * repo-wide upstream. The stale claim was benign in direction — that gate only
 * ever loosened access — but it is what a future reader would have triaged a
 * real outage against. See ace#1812 for the retired names and the evidence.
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
