/**
 * Code-level guards for destructive MCP atoms.
 *
 * Security audit 2026-07-31 (finding F5): several destructive atoms carried
 * only a PROSE warning ("callers MUST exclude OCS_GOLDEN_TEMPLATE_ID …") —
 * the exact pattern CLAUDE.md names as the failure mode ("prose relies on the
 * model choosing to comply, which fails under load"). These helpers encode the
 * documented invariants as hard rails: the value to protect is already an env
 * var in the MCP process, so the guard is a one-line comparison, not a redesign.
 *
 * Pure + env-injectable so they unit-test without live OCS / Drive.
 */

export class DestructiveGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DestructiveGuardError';
  }
}

/**
 * Refuse to delete the shared OCS golden-template CHATBOT. `ocs_delete_chatbot`
 * will archive any experiment_id; the golden template is what every per-opp
 * clone descends from, so deleting it breaks all future clones.
 */
export function assertNotGoldenTemplateChatbot(
  experimentId: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const golden = env.OCS_GOLDEN_TEMPLATE_ID;
  if (golden != null && golden !== '' && Number(golden) === experimentId) {
    throw new DestructiveGuardError(
      `Refusing to delete experiment_id=${experimentId}: it is OCS_GOLDEN_TEMPLATE_ID, ` +
        `the shared chatbot every per-opp clone descends from. Deleting it would break ` +
        `all future clones. If you truly mean to retire the template, do it in the OCS UI.`,
    );
  }
}

/**
 * Refuse to delete the shared OCS golden-template COLLECTION. `ocs_delete_collection`
 * async-purges blobs + embeddings; the template collection is referenced by every
 * cloned pipeline, so deleting it breaks RAG retrieval for every clone.
 */
export function assertNotGoldenTemplateCollection(
  collectionId: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const golden = env.OCS_GOLDEN_TEMPLATE_COLLECTION_ID;
  if (golden != null && golden !== '' && Number(golden) === collectionId) {
    throw new DestructiveGuardError(
      `Refusing to delete collection_id=${collectionId}: it is ` +
        `OCS_GOLDEN_TEMPLATE_COLLECTION_ID, referenced by every cloned pipeline. ` +
        `Deleting it would break RAG retrieval for every clone.`,
    );
  }
}

/** Dimagi-owned email domains ACE may transfer Drive ownership to. */
export const DIMAGI_OWNER_DOMAINS = ['dimagi.com', 'dimagi-ai.com', 'dimagi-associate.com'];

/**
 * Restrict `drive_transfer_ownership` to Dimagi-owned recipients. Ownership
 * transfer is irreversible from ACE's side; a prompt-injected transfer to an
 * external address would hand a Drive object to an attacker. ACE only ever
 * transfers within Dimagi (and Google itself only permits same-org transfer),
 * so a domain allowlist is non-breaking.
 */
export function assertDimagiOwnerRecipient(email: string): void {
  const at = email.lastIndexOf('@');
  const domain = at >= 0 ? email.slice(at + 1).toLowerCase().trim() : '';
  if (!DIMAGI_OWNER_DOMAINS.includes(domain)) {
    throw new DestructiveGuardError(
      `Refusing to transfer Drive ownership to "${email}": only Dimagi-owned ` +
        `recipients are allowed (${DIMAGI_OWNER_DOMAINS.join(', ')}). Ownership ` +
        `transfer is irreversible from ACE's side.`,
    );
  }
}
