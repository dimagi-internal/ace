import type { OcsClient } from '../client.js';
import type { RestBackend } from './rest.js';
import type { PlaywrightBackend } from './playwright.js';
import { ChatbotTableShapeError, ExperimentIdEnrichmentError,
  ExperimentIdStaleError, VersionBadgeUnreadableError } from '../errors.js';

export interface CompositeOptions {
  rest: RestBackend;
  playwright: PlaywrightBackend;
}

/**
 * CompositeBackend implements OcsClient by delegating each capability to either
 * the REST or Playwright backend, per the routing defined in capability-map.ts.
 *
 * Today the routing is hard-coded in the dispatch methods below — one dispatch
 * per atom — which matches the capability map exactly. When OCS ships a real
 * REST endpoint for a Playwright atom, the dispatch line for that atom is the
 * only line that changes.
 */
export class CompositeBackend implements OcsClient {
  constructor(private opts: CompositeOptions) {}

  // ── Authoring (Playwright today) ────────────────────────────────

  cloneChatbot = (a: Parameters<OcsClient['cloneChatbot']>[0]) => this.opts.playwright.cloneChatbot(a);
  createChatbot = (a: Parameters<OcsClient['createChatbot']>[0]) => this.opts.playwright.createChatbot(a);
  addPipelineNode = (a: Parameters<OcsClient['addPipelineNode']>[0]) => this.opts.playwright.addPipelineNode(a);
  addChatbotEvent = (a: Parameters<OcsClient['addChatbotEvent']>[0]) => this.opts.playwright.addChatbotEvent(a);
  addCustomAction = (a: Parameters<OcsClient['addCustomAction']>[0]) => this.opts.playwright.addCustomAction(a);
  linkActionToNode = (a: Parameters<OcsClient['linkActionToNode']>[0]) => this.opts.playwright.linkActionToNode(a);
  setChatbotSystemPrompt = (a: Parameters<OcsClient['setChatbotSystemPrompt']>[0]) => this.opts.playwright.setChatbotSystemPrompt(a);
  setChatbotPipeline = (a: Parameters<OcsClient['setChatbotPipeline']>[0]) => this.opts.playwright.setChatbotPipeline(a);
  createCollection = (a: Parameters<OcsClient['createCollection']>[0]) => this.opts.playwright.createCollection(a);
  uploadCollectionFiles = (a: Parameters<OcsClient['uploadCollectionFiles']>[0]) => this.opts.playwright.uploadCollectionFiles(a);
  waitForCollectionIndexing = (a: Parameters<OcsClient['waitForCollectionIndexing']>[0]) => this.opts.playwright.waitForCollectionIndexing(a);
  attachKnowledge = (a: Parameters<OcsClient['attachKnowledge']>[0]) => this.opts.playwright.attachKnowledge(a);
  setChatbotTools = (a: Parameters<OcsClient['setChatbotTools']>[0]) => this.opts.playwright.setChatbotTools(a);
  setSourceMaterial = (a: Parameters<OcsClient['setSourceMaterial']>[0]) => this.opts.playwright.setSourceMaterial(a);
  /**
   * Publish a chatbot version, then read the POST-publish version back from
   * the API — the system that owns the answer (ace#891, ace#1828).
   *
   * The Playwright path scrapes a `Version N` badge off the chatbot home page
   * after the POST. That scrape is a rendered-markup read of a value the API
   * reports directly, and it has failed in both directions:
   *
   *  - **Absent** (#891/#1297): markup drift or a flaky home-page load made it
   *    unreadable, hard-failing an operation that had demonstrably succeeded.
   *    Four runs in three weeks, each showing a correctly-published bot behind
   *    the error.
   *  - **Stale** (#1828): worse, because it is silent. On
   *    `bednet-check-2-visit/20260828-0629` the badge still read `Version 2`
   *    after a publish that created version 3, so the atom returned the
   *    PRE-publish number under a field named `version_number`. Both
   *    `ocs-agent-setup` § Step 11 and `ocs-knowledge-refresh` § Step 4 write
   *    that value into `run_state.yaml`, so durable state went one version
   *    behind a live bot — and the recorded number is a real version that
   *    really existed, so nothing looks malformed. It also invites the
   *    opposite error: "published, version unchanged" reads as a no-op publish
   *    and invites a republish chasing a number that was never going to move.
   *
   * So the API is now the PRIMARY read, not the fallback: after the publish
   * succeeds, ask `GET /api/experiments/<public_id>/` which version is flagged
   * default and return that. The badge scrape survives only as a labelled
   * fallback for when the API cannot answer at all. `source` says which one
   * answered, so a caller can never mistake a scraped number for an
   * authoritative one. ("Close the loop to the source of truth", and the
   * HTTP-only preference for backends.)
   *
   * #823's invariant is preserved, not weakened: never invent a version
   * number. With neither source able to answer, this still throws.
   */
  publishChatbotVersion = async (
    a: Parameters<OcsClient['publishChatbotVersion']>[0],
  ): Promise<{ version_number: number; task_id: string; source: 'api' | 'home-page-badge' }> => {
    let scraped: { version_number: number; task_id: string; public_id?: string } | undefined;
    let badgeFailure: VersionBadgeUnreadableError | undefined;

    try {
      scraped = await this.opts.playwright.publishChatbotVersion(a);
    } catch (err) {
      if (!(err instanceof VersionBadgeUnreadableError)) throw err;
      badgeFailure = err;
    }

    // The publish itself has succeeded by this point either way — the POST's
    // 302 is handled inside the Playwright backend, several lines before the
    // read-back it may have failed on.
    const publicId =
      scraped?.public_id ??
      badgeFailure?.publicId ??
      (await this.publicIdForExperimentSilently(a.experiment_id));

    const published = publicId ? await this.publishedVersionSilently(publicId) : undefined;
    if (published !== undefined) {
      return { version_number: published, task_id: 'none', source: 'api' };
    }

    // API unreachable, or it named no default version. Never fall through to
    // the working counter — that is the ace#891 off-by-one.
    if (badgeFailure) throw badgeFailure;
    return { version_number: scraped!.version_number, task_id: scraped!.task_id, source: 'home-page-badge' };
  };

  /**
   * Best-effort "which version is PUBLISHED right now" from the API.
   *
   * Deliberately NOT `chatbot.version_number` — that is the working/next
   * counter (observed 3 while the published default was 2, and 4 while it was
   * 3), so reading it here would write an off-by-one into `run_state.yaml`.
   * The published version is the one flagged as default.
   */
  private async publishedVersionSilently(publicId: string): Promise<number | undefined> {
    try {
      const chatbot = await this.opts.rest.getChatbot({ public_id: publicId });
      return chatbot.versions?.find((v) => v.is_default_version)?.version_number;
    } catch {
      return undefined;
    }
  }

  /** Best-effort experiment_id -> public_id, for the ace#891 fallback. */
  private async publicIdForExperimentSilently(experimentId: number): Promise<string | undefined> {
    try {
      const { chatbots } = await this.opts.rest.listChatbots({});
      return chatbots.find((c) => c.experiment_id === experimentId)?.id;
    } catch {
      return undefined;
    }
  }
  addTeamMember = (a: Parameters<OcsClient['addTeamMember']>[0]) => this.opts.playwright.addTeamMember(a);
  getChatbotEmbedInfo = (a: Parameters<OcsClient['getChatbotEmbedInfo']>[0]) => this.opts.playwright.getChatbotEmbedInfo(a);
  deleteChatbot = (a: Parameters<OcsClient['deleteChatbot']>[0]) => this.opts.playwright.deleteChatbot(a);
  getChatbotPipelineId = async (a: Parameters<OcsClient['getChatbotPipelineId']>[0]) => ({
    pipeline_id: await this.opts.playwright.pipelineIdFor(a.experiment_id),
  });
  deletePipeline = (a: Parameters<OcsClient['deletePipeline']>[0]) => this.opts.playwright.deletePipeline(a);
  deleteCollection = (a: Parameters<OcsClient['deleteCollection']>[0]) => this.opts.playwright.deleteCollection(a);

  // ── Observation (REST today) ─────────────────────────────────────

  /**
   * REST list + Playwright enrichment for `experiment_id`.
   *
   * Live OCS's REST `/api/experiments/` returns `url` as the API URL
   * `/api/experiments/<uuid>/`, NOT the human-facing
   * `/a/<team>/chatbots/<int>/`. The 0.6.1 URL-regex parser therefore
   * always returns null in production. As of 0.6.6, when the parser
   * returns null, we enrich each result by scraping the team's chatbots
   * table (HTMX endpoint) for the `name → integer` map, then matching by
   * name. One Playwright call per listChatbots; if it fails (e.g. session
   * expired), every result still has `experiment_id: null` and the caller
   * is responsible for surfacing the gap.
   */
  listChatbots = async (a: Parameters<OcsClient['listChatbots']>[0] = {}) => {
    const out = await this.opts.rest.listChatbots(a);
    if (out.chatbots.every((c) => c.experiment_id != null)) return out;
    // The Playwright session is bound to the default team only. When the
    // caller targeted a non-default team via `team_slug`, skip enrichment —
    // returning experiment_id: null is the documented degraded mode and
    // matches the contract `experiment_id` carries (best-effort).
    if (a.team_slug) return out;
    const idsByName = await this.fetchExperimentIdMapSilently();
    return {
      ...out,
      chatbots: out.chatbots.map((c) =>
        c.experiment_id == null && idsByName.has(c.name)
          ? { ...c, experiment_id: idsByName.get(c.name)! }
          : c,
      ),
    };
  };

  getChatbot = async (a: Parameters<OcsClient['getChatbot']>[0]) => {
    const out = await this.opts.rest.getChatbot(a);
    if (out.experiment_id != null) return out;
    // Loud, not silent (ace#1028): the single-bot read is what resume
    // idempotency keys on, and a swallowed scrape failure here yields
    // `experiment_id: null` whose natural recovery is the forbidden
    // re-clone. A successful scrape that lacks the name stays a null id —
    // that's honest absence (e.g. the bot lives on a non-default team).
    let idsByName: Map<string, number>;
    try {
      idsByName = await this.opts.playwright.fetchExperimentIdsByName();
    } catch (e) {
      // Template drift already names itself precisely — it is neither an
      // expired session nor a stale table, and re-wrapping it would bury the
      // one remedy that works (re-derive the parse from upstream source).
      // ace#1561.
      if (e instanceof ChatbotTableShapeError) throw e;
      throw new ExperimentIdEnrichmentError(out.name, e);
    }
    const id = idsByName.get(out.name);
    if (id != null) return { ...out, experiment_id: id };

    // The scrape worked and does not list this bot. Two very different causes
    // (ace#1451): the bot lives on a non-default team — honest absence, the
    // documented degraded mode — or the table is STALE because the bot was
    // just cloned. Distinguish them instead of returning the same silent null
    // for both: REST's unscoped list IS the default team, so a bot present
    // there but missing from the scrape is definitively stale.
    //
    // This branch was written assuming a POPULATED map missing ONE row. When
    // the map is wholesale wrong it fired for every bot that exists — telling a
    // seven-week-old bot to wait for a row that was already there (ace#1561).
    // Two guards now stand between: `fetchExperimentIdsByName` throws on a
    // table it cannot parse at all, and the overlap check below catches the
    // nastier variant where the parse "succeeds" but keys the map on something
    // no REST name can ever equal.
    const defaultTeam = await this.listDefaultTeamSilently();
    if (defaultTeam == null || !defaultTeam.some((c) => c.id === out.id)) return out;

    // The bot IS on the default team and the scrape does not list it. That is
    // staleness — UNLESS the scrape and REST are describing the same team and
    // agree on NOT ONE name, which no amount of waiting explains. A freshly
    // cloned bot is one missing row among many matching ones; zero overlap
    // between two non-empty views of the same team is a broken parse.
    if (idsByName.size > 0 && !defaultTeam.some((c) => idsByName.has(c.name))) {
      throw new ChatbotTableShapeError(
        `the table parsed ${idsByName.size} row(s), but not one of them matches any of the ` +
          `${defaultTeam.length} chatbot name(s) REST reports for this same team ` +
          `(e.g. parsed "${[...idsByName.keys()][0]}" vs REST "${defaultTeam[0].name}").`,
      );
    }
    throw new ExperimentIdStaleError(out.name, out.id);
  };

  /**
   * The DEFAULT team's chatbots per REST's unscoped list, which is exactly that
   * team. Returns null on failure, so a flaky extra call degrades to today's
   * behaviour rather than inventing a loud error.
   *
   * Returns the rows rather than a boolean (ace#1561) because the caller needs
   * their NAMES too: whether the scrape's map overlaps this list at all is what
   * separates a stale table from a mis-parsed one.
   */
  private async listDefaultTeamSilently(): Promise<Array<{ id: string; name: string }> | null> {
    try {
      const { chatbots } = await this.opts.rest.listChatbots({});
      return chatbots;
    } catch {
      return null;
    }
  }

  /** Try the HTMX scrape, swallow auth/network errors so the LIST still
   * returns something usable — the list contract is documented best-effort
   * per row. Only the single-bot read (`getChatbot`) fails loud (ace#1028).
   *
   * That includes `ChatbotTableShapeError`: during template drift EVERY row
   * degrades to `experiment_id: null`, which is the documented degraded mode,
   * and hard-failing the list would take out callers that never wanted the
   * integer id. The loud read is `getChatbot`, and it is the one resume
   * idempotency keys on. */
  private async fetchExperimentIdMapSilently(): Promise<Map<string, number>> {
    try {
      return await this.opts.playwright.fetchExperimentIdsByName();
    } catch {
      return new Map();
    }
  }
  inspectChatbot = (a: Parameters<OcsClient['inspectChatbot']>[0]) => this.opts.rest.inspectChatbot(a);
  listSessions = (a: Parameters<OcsClient['listSessions']>[0]) => this.opts.rest.listSessions(a);
  getSession = (a: Parameters<OcsClient['getSession']>[0]) => this.opts.rest.getSession(a);
  endSession = (a: Parameters<OcsClient['endSession']>[0]) => this.opts.rest.endSession(a);
  addSessionTags = (a: Parameters<OcsClient['addSessionTags']>[0]) => this.opts.rest.addSessionTags(a);
  removeSessionTags = (a: Parameters<OcsClient['removeSessionTags']>[0]) => this.opts.rest.removeSessionTags(a);
  updateSessionState = (a: Parameters<OcsClient['updateSessionState']>[0]) => this.opts.rest.updateSessionState(a);
  sendTestMessage = (a: Parameters<OcsClient['sendTestMessage']>[0]) => this.opts.rest.sendTestMessage(a);
  triggerBotMessage = (a: Parameters<OcsClient['triggerBotMessage']>[0]) => this.opts.rest.triggerBotMessage(a);
  updateParticipantData = (a: Parameters<OcsClient['updateParticipantData']>[0]) => this.opts.rest.updateParticipantData(a);
  downloadFile = (a: Parameters<OcsClient['downloadFile']>[0]) => this.opts.rest.downloadFile(a);
  getMe = (a: Parameters<OcsClient['getMe']>[0] = {}) => this.opts.rest.getMe(a);
}
