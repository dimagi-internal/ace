/**
 * Mirror-vs-live template token drift (dimagi-internal/ace#2126).
 *
 * `templates/work-order-template.md` is a MIRROR of a Drive document. The
 * renderer never reads the repo file — `pdd-to-work-order` calls
 * `docs_copy_template(templateDocId=$WORK_ORDER_TEMPLATE_ID, …)`, which copies
 * the LIVE gdoc and runs one `replaceAllText` per token. Nothing made the two
 * agree, so a template edit could land in the repo and never reach the
 * renderer, which is exactly what ace#2126 measured: the mirror carried
 * `{{partner_first_reference}}` and the live gdoc did not.
 *
 * The failure is silent in BOTH directions and every existing check is blind
 * to it:
 *
 *   - MIRROR_ONLY (a token the repo has and the live doc lacks). The producer
 *     emits a replacement for it; `replaceAllText` matches zero occurrences;
 *     the API returns 200. There is no leftover `{{token}}` in the output, so
 *     the ace#819 token-coverage scan passes, `pdd-to-work-order-qa` returned
 *     14/14, and the value simply evaporates. It reads as fixed at every
 *     checkpoint.
 *   - LIVE_ONLY (a token the live doc has and the repo lacks). No producer
 *     fills it, so a literal `{{token}}` ships into a contractual document —
 *     the ace#819 direction.
 *
 * `test/skills/work-order-template-token-contract.test.ts` pins the three REPO
 * files against each other and explicitly declines to read Drive ("that would
 * need Drive credentials and make CI flaky"). This module is the other half:
 * the pure comparison it performs, with the Drive fetch left to the caller
 * (`scripts/probe-work-order-template-drift.ts`), so the diff logic is unit
 * testable without credentials.
 */

/** Meta-placeholders that name the token SHAPE, not a real token. */
const META = new Set(['snake_case', 'token']);

/**
 * Repeated table rows are enumerated in the template (`{{week_3_dates}}`,
 * `{{raci_11_partner}}`) but written once as a family in the docs
 * (`{{week_N_dates}}`). Collapse both sides so the comparison is about WHICH
 * tokens exist, not how many rows a table happens to have. Mirrors the
 * `normalize()` in `test/skills/work-order-template-token-contract.test.ts`.
 */
export function normalizeToken(token: string): string {
  return token.replace(/^(week|raci)_\d+_/, '$1_N_');
}

/**
 * Extract the normalized `{{token}}` set from a document's plain text.
 *
 * Both inputs are plain text: the repo mirror is markdown, and the live gdoc
 * is fetched via `drive.files.export({ mimeType: 'text/plain' })`. Google's
 * text export can wrap a token across a soft line break inside table cells,
 * so tokens are matched on a single line only — a token split by the export
 * would surface as LIVE_ONLY noise rather than being silently dropped.
 */
export function tokensIn(text: string): Set<string> {
  const found = text.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) ?? [];
  const out = new Set<string>();
  for (const raw of found) {
    const name = raw.slice(2, -2);
    if (META.has(name)) continue;
    out.add(normalizeToken(name));
  }
  return out;
}

export interface TokenDrift {
  /** Tokens the repo mirror declares that the live template does not carry. */
  mirrorOnly: string[];
  /** Tokens the live template carries that the repo mirror does not declare. */
  liveOnly: string[];
  /** True when both sets agree. */
  inSync: boolean;
}

export function diffTemplateTokens(mirrorText: string, liveText: string): TokenDrift {
  const mirror = tokensIn(mirrorText);
  const live = tokensIn(liveText);
  const mirrorOnly = [...mirror].filter((t) => !live.has(t)).sort();
  const liveOnly = [...live].filter((t) => !mirror.has(t)).sort();
  return { mirrorOnly, liveOnly, inSync: mirrorOnly.length === 0 && liveOnly.length === 0 };
}

export function formatTokenDrift(drift: TokenDrift, templateId: string): string {
  if (drift.inSync) {
    return `OK  live template ${templateId} carries exactly the tokens the repo mirror declares.`;
  }
  const lines: string[] = [`DRIFT  live template ${templateId} disagrees with templates/work-order-template.md`];
  if (drift.mirrorOnly.length > 0) {
    lines.push(
      '',
      '  MIRROR_ONLY — in the repo, ABSENT from the live gdoc.',
      '  The producer emits these and replaceAllText matches nothing: a silent no-op',
      '  that leaves no {{token}} behind for any rendered-doc check to find (ace#2126).',
      ...drift.mirrorOnly.map((t) => `    - {{${t}}}`),
    );
  }
  if (drift.liveOnly.length > 0) {
    lines.push(
      '',
      '  LIVE_ONLY — in the live gdoc, ABSENT from the repo mirror.',
      '  No producer fills these, so a literal {{token}} ships into a contract (ace#819).',
      ...drift.liveOnly.map((t) => `    - {{${t}}}`),
    );
  }
  lines.push(
    '',
    '  Fix: apply the missing edit to the LIVE gdoc (minimal docs_batch_update — do',
    '  NOT re-bootstrap, that mints a new file id and drops the style retrofit), or',
    '  bring templates/work-order-template.md back in line with it.',
    '  See playbook/integrations/work-order-template.md § Mirror-vs-live drift.',
  );
  return lines.join('\n');
}
