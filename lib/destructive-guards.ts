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
 *
 * ## One of these guards shipped inert, and the tests were green
 *
 * `assertNotGoldenTemplateCollection` originally read
 * `OCS_GOLDEN_TEMPLATE_COLLECTION_ID`. That variable is declared nowhere — not
 * in `.env.tpl`, not in either installed `.env`. The guard therefore compared
 * against `undefined` on every call and could never fire, while its unit test
 * injected the phantom key by hand and passed. The audit item read as closed
 * and the shared collection stayed deletable. The real key is
 * `OCS_SHARED_COLLECTION_ID` (=350, which the atom's own description calls
 * "typically id 350").
 *
 * `GUARD_ENV_KEYS` + its test are the preventer: every env key a guard depends
 * on must be declared in `.env.tpl`, so a guard keyed on a variable nobody
 * sets cannot ship green again.
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
  // `OCS_SHARED_COLLECTION_ID` is the key that actually exists — see the note
  // at the top of this file on why. The alias is accepted so that if the
  // clearer name is ever introduced it works without a code change.
  const golden = env.OCS_SHARED_COLLECTION_ID ?? env.OCS_GOLDEN_TEMPLATE_COLLECTION_ID;
  if (golden != null && golden !== '' && Number(golden) === collectionId) {
    throw new DestructiveGuardError(
      `Refusing to delete collection_id=${collectionId}: it is ` +
        `OCS_SHARED_COLLECTION_ID, the shared collection referenced by every ` +
        `cloned pipeline. Deleting it would break RAG retrieval for every clone.`,
    );
  }
}

/**
 * Env keys these guards read. Exported so a test can assert every one is
 * actually declared in `.env.tpl` — see the false-green note at the top of
 * this file. A guard keyed on a variable nobody sets is not a guard.
 */
export const GUARD_ENV_KEYS = [
  'OCS_GOLDEN_TEMPLATE_ID',
  'OCS_SHARED_COLLECTION_ID',
  'ACE_HQ_DOMAIN',
] as const;

/**
 * Restrict `commcare_delete_app` to an ACE-owned HQ domain.
 *
 * The atom takes any `domain` + `app_id` and POSTs HQ's `delete_app` view, so
 * a wrong-domain call soft-deletes some other project space's application. The
 * audit flagged this as "needs judgment — may affect legit cross-domain
 * cleanup". Checked (2026-08-14): every caller in the repo already passes
 * ACE_HQ_DOMAIN — `skills/app-deploy` Step 4.6 and `skills/sweep-hq` are the
 * only two — so the rail is non-breaking as written.
 *
 * The override is a STRING that must equal the target domain, not a boolean.
 * A boolean flag is reusable boilerplate the model can set reflexively; having
 * to restate the exact domain makes the intent specific to one call. To be
 * clear about what this does and does not do: it bounds accidental blast
 * radius (a typo'd or stale domain, a sweep bug). It does not stop a
 * determined injection that also sets the override — nothing at this layer
 * can, which is why this is a rail and not an approval gate.
 */
export function assertAceOwnedHqDomain(
  domain: string,
  allowForeignDomain?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const target = domain.trim().toLowerCase();
  const owned = (env.ACE_HQ_DOMAIN ?? '').trim().toLowerCase();

  if (!owned) {
    throw new DestructiveGuardError(
      `Refusing to delete an app in domain "${domain}": ACE_HQ_DOMAIN is unset, ` +
        `so there is no way to tell an ACE-owned project space from someone ` +
        `else's. Run /ace:setup --force-env.`,
    );
  }
  if (target === owned) return;
  if (allowForeignDomain != null && allowForeignDomain.trim().toLowerCase() === target) {
    return;
  }
  throw new DestructiveGuardError(
    `Refusing to delete app in domain "${domain}": ACE owns "${owned}" ` +
      `(ACE_HQ_DOMAIN). If this is deliberate, pass allow_foreign_domain with ` +
      `the exact domain name "${domain}" — a bare true is not accepted, so the ` +
      `override has to name what it is overriding.`,
  );
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
