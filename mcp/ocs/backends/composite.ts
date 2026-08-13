import type { OcsClient } from '../client.js';
import type { RestBackend } from './rest.js';
import type { PlaywrightBackend } from './playwright.js';
import { VersionBadgeUnreadableError } from '../errors.js';

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
   * Publish a chatbot version, then read its number back from whichever source
   * can actually answer (dimagi-internal/ace#891).
   *
   * The Playwright path scrapes a `Version N` badge off the chatbot home page.
   * That scrape fails independently of the publish — the POST already returned
   * its 302 several lines earlier — so a markup drift or a flaky home-page load
   * used to hard-fail an operation that had demonstrably succeeded. Four runs
   * hit it in three weeks, each one showing a correctly-published bot behind
   * the error.
   *
   * On that specific typed failure, ask the API instead. This moves the
   * read-back from rendered markup to the upstream system's own answer, which
   * is the direction CLAUDE.md points ("close the loop to the source of truth"
   * and the HTTP-only preference for backends).
   *
   * #823's invariant is preserved, not weakened: never invent a version
   * number. If the API cannot answer either, this still throws.
   */
  publishChatbotVersion = async (a: Parameters<OcsClient['publishChatbotVersion']>[0]) => {
    try {
      return await this.opts.playwright.publishChatbotVersion(a);
    } catch (err) {
      if (!(err instanceof VersionBadgeUnreadableError)) throw err;

      const publicId = err.publicId ?? (await this.publicIdForExperimentSilently(err.experimentId));
      if (!publicId) throw err;

      const chatbot = await this.opts.rest.getChatbot({ public_id: publicId });

      // Deliberately NOT `chatbot.version_number` — that is the working/next
      // counter (observed 3 while the published default was 2), so reading it
      // here would write an off-by-one into run_state.yaml. The published
      // version is the one flagged as default.
      const published = chatbot.versions?.find((v) => v.is_default_version);
      if (!published) throw err;

      return { version_number: published.version_number, task_id: 'none' as const };
    }
  };

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
    const idsByName = await this.fetchExperimentIdMapSilently();
    const id = idsByName.get(out.name);
    return id != null ? { ...out, experiment_id: id } : out;
  };

  /** Try the HTMX scrape, swallow auth/network errors so list/get still
   * returns something usable. The trade-off: a silent miss leaves
   * experiment_id null (same as the regression we're fixing) but doesn't
   * break the list call entirely. */
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
