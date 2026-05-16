import type { OcsClient } from '../client.js';
import type { RestBackend } from './rest.js';
import type { PlaywrightBackend } from './playwright.js';

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
  setChatbotSystemPrompt = (a: Parameters<OcsClient['setChatbotSystemPrompt']>[0]) => this.opts.playwright.setChatbotSystemPrompt(a);
  setChatbotPipeline = (a: Parameters<OcsClient['setChatbotPipeline']>[0]) => this.opts.playwright.setChatbotPipeline(a);
  createCollection = (a: Parameters<OcsClient['createCollection']>[0]) => this.opts.playwright.createCollection(a);
  uploadCollectionFiles = (a: Parameters<OcsClient['uploadCollectionFiles']>[0]) => this.opts.playwright.uploadCollectionFiles(a);
  waitForCollectionIndexing = (a: Parameters<OcsClient['waitForCollectionIndexing']>[0]) => this.opts.playwright.waitForCollectionIndexing(a);
  attachKnowledge = (a: Parameters<OcsClient['attachKnowledge']>[0]) => this.opts.playwright.attachKnowledge(a);
  setChatbotTools = (a: Parameters<OcsClient['setChatbotTools']>[0]) => this.opts.playwright.setChatbotTools(a);
  setSourceMaterial = (a: Parameters<OcsClient['setSourceMaterial']>[0]) => this.opts.playwright.setSourceMaterial(a);
  publishChatbotVersion = (a: Parameters<OcsClient['publishChatbotVersion']>[0]) => this.opts.playwright.publishChatbotVersion(a);
  getChatbotEmbedInfo = (a: Parameters<OcsClient['getChatbotEmbedInfo']>[0]) => this.opts.playwright.getChatbotEmbedInfo(a);
  deleteChatbot = (a: Parameters<OcsClient['deleteChatbot']>[0]) => this.opts.playwright.deleteChatbot(a);
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
}
