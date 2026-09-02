/**
 * Pure projection helper for `ocs_list_chatbots`.
 *
 * WHY (dimagi-internal/ace#1901): the atom's DEFAULT page already exceeds the
 * harness tool-result cap, so a caller that does not know to page gets nothing
 * usable — and `page_size` / `next_cursor`, which the atom has had all along,
 * cannot help, because they shrink a PAGE and the problem is the ROW.
 *
 * Measured on team `connect-ace` 2026-09-02, straight off
 * `GET /api/experiments/?page_size=50` so the payload never entered a model
 * context:
 *
 *   rows=50  serialized_chars=87009 (85.0 KB)   [count=81 → 2 pages]
 *   per-key Σ serialized chars:
 *     versions      74733   (85.9% of the payload)
 *     url            4300
 *     name           2121
 *     id             1900
 *     experiment_id   250
 *     version_number   50
 *   of that `versions` bulk, Σ version_description = 61234 chars (70.4%)
 *
 * That measurement CORRECTS the recipe the sibling fix (ace#1799 / PR #1897)
 * used for `connect_list_programs`, which the issue proposed transplanting.
 * Four candidate shapes, all serialized off the SAME live page:
 *
 *   today (versions[] in full)                       87,009
 *   #1897's recipe: cap version_description at 400   47,083   STILL over 40k
 *   drop version_description, keep versions[]        23,004
 *   this file: versions[] -> versions_summary        14,676   (83.1% cut)
 *
 * The 400-char cap does NOT clear the 40,000-char inline ceiling the rest of
 * the plugin uses (`OCS_INLINE_MAX_BASE64_CHARS`, gdrive's
 * `DEFAULT_INLINE_MAX_CHARS`, `UPDATE_FILE_INLINE_CEILING`), because the prose
 * here is spread over 109 NESTED entries rather than 50 rows — 42 of them are
 * over 400 chars, so the cap keeps 20,129 chars and the surrounding version
 * objects keep the rest. Transplanting the sibling recipe unexamined would
 * have shipped a fix that leaves the atom broken, which is the outcome the
 * issue explicitly warned about ("the fix rhymes but the reasoning does not
 * transfer unexamined").
 *
 * So the projection drops `versions[]` from list rows entirely and replaces it
 * with a two-field `versions_summary`, which preserves the one signal anything
 * in ACE actually derives from that array — WHICH version is published
 * (`is_default_version`, the ace#891 rule that `version_number` is the WORKING
 * counter and must not be read as "what we published"). Full version prose,
 * including `version_description`, is read per-chatbot from `ocs_get_chatbot`.
 *
 * Pure by design: MCP subprocesses bind their code at spawn, so atom behaviour
 * cannot be live-validated from the session that changes it. Keeping the
 * decision logic here means it is unit-testable without MCP plumbing.
 */

/** A version entry as OCS's experiment serializer emits it. */
export interface ChatbotVersionEntry {
  version_number?: number;
  is_default_version?: boolean;
  version_description?: string;
}

/** What survives the projection in place of the full `versions[]` array. */
export interface ChatbotVersionsSummary {
  /** How many version entries the row carried. */
  count: number;
  /**
   * The version flagged `is_default_version` — i.e. the PUBLISHED one.
   * `null` when no entry carries the flag (a bot with only a working draft).
   * This is the ace#891-correct answer; the row's `version_number` is the
   * WORKING counter and is off by one from this whenever a draft is open.
   */
  published_version_number: number | null;
}

export interface ChatbotVersionsProjectionResult<T> {
  chatbots: Array<Omit<T, 'versions'> & { versions_summary?: ChatbotVersionsSummary }>;
  /** How many rows actually had a `versions[]` array removed. */
  projected_rows: number;
  /** Version entries collapsed into summaries, across all rows. */
  version_entries_dropped: number;
  /** Serialized characters removed from the payload. Reported so the saving is visible. */
  chars_removed: number;
}

/**
 * Replace each row's `versions[]` with a `versions_summary`.
 *
 * A projected row is MARKED by the presence of `versions_summary` and the
 * absence of `versions` — a consumer that needs a version's description can
 * see it is not looking at it, and go get it from `ocs_get_chatbot`.
 *
 * Rows carrying no `versions` key are passed through untouched and are not
 * counted as projected: absent is not the same as emptied.
 */
export function projectChatbotVersions<T extends { versions?: ChatbotVersionEntry[] }>(
  chatbots: readonly T[],
): ChatbotVersionsProjectionResult<T> {
  let projected_rows = 0;
  let version_entries_dropped = 0;
  let chars_removed = 0;

  const out = chatbots.map((c) => {
    const versions = c.versions;
    if (!Array.isArray(versions)) {
      const { ...rest } = c;
      return rest as Omit<T, 'versions'>;
    }
    projected_rows++;
    version_entries_dropped += versions.length;
    const published = versions.find((v) => v.is_default_version === true);
    const versions_summary: ChatbotVersionsSummary = {
      count: versions.length,
      published_version_number: published?.version_number ?? null,
    };
    // Cost of what we removed minus cost of what replaced it, so the reported
    // saving is the real one rather than the gross size of the dropped array.
    chars_removed +=
      JSON.stringify(versions).length - JSON.stringify(versions_summary).length;
    const { versions: _dropped, ...rest } = c;
    return { ...(rest as Omit<T, 'versions'>), versions_summary };
  });

  return { chatbots: out, projected_rows, version_entries_dropped, chars_removed };
}

/**
 * The note attached to a projected response, so a reader who did not write
 * this code learns where the dropped prose lives.
 */
export const CHATBOT_VERSIONS_PROJECTION_NOTE =
  'Each row\'s `versions[]` array (including every `version_description`) was ' +
  'replaced by `versions_summary` — on team `connect-ace` that array is 85.9% ' +
  'of the default page, which overflows the tool-result cap (ace#1901). Read a ' +
  'version\'s full description from `ocs_get_chatbot({public_id})`, or re-call ' +
  'with `full_versions: true` / `write_to_path`.';
