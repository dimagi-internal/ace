//
// Whether a chatbot's LLM PROVIDER can populate `cited_files` at all.
//
// ## The defect this closes (ace#2027)
//
// `ocs-chatbot-eval` § Rubric Rules — Source usage explained an empty
// `cited_files` as a property of the CHANNEL:
//
//     "On the anonymous widget endpoint ... the `cited_files` field is
//      structurally always empty regardless of bot grounding."
//
// The observation is right and the attribution is wrong. Emptiness is decided
// in the pipeline's LLM node, before any channel exists, and it is a property
// of the PROVIDER.
//
// That matters because the `openai-compat` branch four lines above applies a
// hard `<=5` / `<=3` cap on exactly that signal. Scoped to the widget, the
// exemption misses every other channel — so switching `ocs-chatbot-qa` to
// `openai-compat` (a capture method the skill documents as supported) would
// cap Source usage, 20% of the `--deep` verdict that Phase 9 `llo-launch`
// reads, on a field that cannot be populated on ANY channel for an
// Anthropic-backed bot.
//
// ## The mechanism, from upstream source (dimagi/open-chat-studio @ main,
// ## read 2026-09-06)
//
// `cited_files` is populated by exactly one code path:
// `LlmService._default_parser` (`apps/service_providers/llm_service/main.py`
// :112), which at :144 calls `extract_file_ids_from_ocs_citations(final_text)`
// and resolves the ids into `LlmChatResponse.cited_files`. That is the ONLY
// call site of that function outside its own module and tests.
//
// `LlmService.get_output_parser` (:109) returns `_default_parser`. Exactly one
// subclass overrides it:
//
//     class AnthropicLlmService(LlmService):        # main.py:392
//         def get_output_parser(self):             # main.py:449
//             return parse_output_for_anthropic
//
// `parse_output_for_anthropic` (`parsers.py:83-115`) handles Anthropic's NATIVE
// url/title citations by appending markdown links to the text, and returns
// `LlmChatResponse(text=...)` on every one of its five return paths. It never
// calls `extract_file_ids_from_ocs_citations`, and
// `LlmChatResponse.cited_files` is `Field(default_factory=set)`
// (`datamodels.py:19`) — so it is empty by construction, not by accident.
//
// The `llm.type` value this module switches on is the OCS provider SLUG:
// `LlmProviderTypes` (`apps/service_providers/models.py:70-85`), assigned onto
// the service as `service._type = self.slug` (:157) and surfaced by
// `ocs_inspect_chatbot` as `pipeline.nodes[].llm.type`. `_build_llm_service`
// (:160-180) is the slug -> service-class map reproduced in PROVIDERS below.
//
// ## Live observation (the reproducer, not just the reading)
//
// `ocs_inspect_chatbot({public_id: "2c8d5f93-8e4f-4fde-9bf8-650909255c30",
// team_slug: "connect-ace", version: 3})` on 2026-09-06 — the bot graded by
// `hh-poverty-targeting/20260828-0702`:
//
//     llm:    { provider_name: "Antropic", type: "anthropic",
//               model: "claude-sonnet-4-6" }
//     params: { generate_citations: true }
//     channels: embedded_widget, web, api
//
// `generate_citations: true` and `cited_files` empty on all 64 entries of that
// deep suite. Three channels, one provider, one outcome — which is the whole
// point: the channel list is not the discriminator.
//
// ## Scope — what this module deliberately does NOT do
//
// It does not touch the cap for providers that CAN populate the field. An
// OpenAI-backed pipeline with `generate_citations: true` and empty
// `cited_files` is still a real defect and still caps, exactly as before. The
// only claim here is about which pipelines are capable of populating it.
//
// Sibling of `lib/widget-body-evidence.ts`, which harvests the evidence that
// remains when this one reports `false`.
//

/** Whether a provider's output parser can populate `cited_files`. */
export type CitedFilesSupport = 'supported' | 'unsupported' | 'unknown';

/**
 * The OCS provider slug -> can-it-populate-`cited_files` map.
 *
 * Derived from `LlmProviderTypes._build_llm_service`: every slug resolves to a
 * service class, and a class populates `cited_files` iff it inherits
 * `LlmService.get_output_parser` (i.e. `_default_parser`). Only
 * `AnthropicLlmService` overrides it.
 *
 * Listed exhaustively rather than as "anthropic is special" so that the next
 * reader can see WHICH providers were checked, and so a provider added
 * upstream shows up here as `unknown` instead of being silently assumed.
 */
const PROVIDERS: Readonly<Record<string, boolean>> = Object.freeze({
  // -> OpenAILlmService / OpenAIGenericService / AzureLlmService /
  //    DeepSeekLlmService / GoogleLlmService / GoogleVertexAILlmService /
  //    VoyageAILlmService — all inherit `_default_parser`.
  openai: true,
  azure: true,
  groq: true,
  perplexity: true,
  minimax: true,
  litellm: true,
  deepseek: true,
  google: true,
  google_vertex_ai: true,
  voyage: true,
  // -> AnthropicLlmService, the sole `get_output_parser` override.
  anthropic: false,
});

/**
 * Classify a provider slug read from `ocs_inspect_chatbot`'s
 * `pipeline.nodes[].llm.type`.
 *
 * Returns `'unknown'` for a missing, empty, or unrecognised slug. `'unknown'`
 * is a real answer and callers must branch on it — see `citedFilesCapApplies`
 * for which way, and why.
 */
export function citedFilesSupport(llmType: string | null | undefined): CitedFilesSupport {
  if (typeof llmType !== 'string') return 'unknown';
  const slug = llmType.trim().toLowerCase();
  if (slug === '') return 'unknown';
  const known = PROVIDERS[slug];
  if (known === undefined) return 'unknown';
  return known ? 'supported' : 'unsupported';
}

/**
 * Whether the empty-`cited_files` cap may be applied to this capture.
 *
 * Only `'supported'` earns the cap. Both `'unsupported'` and `'unknown'`
 * withhold it, and the asymmetry is deliberate:
 *
 *   - Applying the cap when the field is unpopulatable produces the ace#2027
 *     false-fail on `llo-launch`'s gate, off a field no bot could have filled.
 *   - Withholding it when the field WAS populatable under-penalises a genuinely
 *     broken pipeline — but body-text grounding still runs on that entry and
 *     still deducts (`-2` for unsourced assertions, `<=3` for a fabricated
 *     source title), so the answer is not ungraded, only ungraded by THIS
 *     signal.
 *
 * A recoverable under-penalty against an unrecoverable false gate failure: on
 * an unknown provider, withhold. Same shape as CLAUDE.md's "when you cannot
 * classify it confidently, it is device-truth" — the cheaper error wins.
 */
export function citedFilesCapApplies(llmType: string | null | undefined): boolean {
  return citedFilesSupport(llmType) === 'supported';
}

/** Marker prefix, matching the `[PLATFORM]` tier used across the `-eval` skills. */
export const CITED_FILES_PLATFORM_MARKER = '[PLATFORM]';

/**
 * The `auto_surfaced` line a judge must emit when it withholds the cap.
 *
 * `[PLATFORM]` because the cause is upstream of the skill and of the bot:
 * per the tier's definition it does not count toward the inflation guard.
 * Returns `null` when the cap applies and there is nothing to explain.
 */
export function citedFilesPlatformNote(llmType: string | null | undefined): string | null {
  const support = citedFilesSupport(llmType);
  if (support === 'supported') return null;

  const slug = typeof llmType === 'string' && llmType.trim() !== '' ? llmType.trim() : '(absent)';
  const because =
    support === 'unsupported'
      ? `provider "${slug}" uses parse_output_for_anthropic, which never populates cited_files ` +
        '(open-chat-studio main.py:449 -> parsers.py:83; ace#2027)'
      : `provider "${slug}" is not a recognised OCS provider slug, so cited_files support is unknown ` +
        '(ace#2027)';

  return (
    `${CITED_FILES_PLATFORM_MARKER} empty cited_files not gradeable: ${because}. ` +
    'Structured-citation cap withheld; graded on inline ids and body text instead.'
  );
}
