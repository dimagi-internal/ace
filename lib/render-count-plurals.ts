/**
 * Count-onto-hard-coded-plural lint for labs workflow `render_code` (ace#2248).
 *
 * `demo-data-setup`-authored render code builds count phrases by concatenating
 * a number onto a fixed plural, so a count of exactly 1 renders ungrammatically
 * on a page a funder reads. Verbatim from labs workflow 5482
 * (spark-facilitator/20260907-1120, the `shortfall-panel` a DDD scene frames):
 *
 *   if (t.committee > 0) parts.push(t.committee + " were committee meetings");
 *
 * rendered for mercy_chirwa as "1 were committee meetings". 1 is the likeliest
 * value a per-cause count takes, so the class recurs on every ledger.
 *
 * The scan is deliberately narrow, because a lint that cries wolf gets ignored:
 *   - `<expr> + " were|are|have ..."` always fires — a bare number followed by
 *     a plural verb is wrong at exactly 1, whatever the expression is;
 *   - `<expr> + " <word>s ..."` fires only when the expression is count-shaped
 *     (`.length`, or a name ending in count / total / num / n), since
 *     `name + " shows ..."` is ordinary prose;
 *   - a phrase picked by a ternary (`n + (n === 1 ? " was …" : " were …")`) is
 *     never a match, and a line that already compares against 1 (`=== 1`,
 *     `== 1`, `!== 1`, `!= 1`) is left alone.
 *
 * Run by `scripts/check-render-code-utilities.ts` before upload, on the full
 * post-patch source. *Enforced:* `test/lib/render-count-plurals.test.ts`.
 */

export interface CountPluralFinding {
  /** 1-based line in the render source. */
  line: number;
  /** The count expression concatenated onto the phrase. */
  expr: string;
  /** The hard-coded phrase as written, quotes stripped. */
  phrase: string;
}

const PLURAL_VERBS = new Set(['were', 'are', 'have']);

/** `-s` words that are not plurals, so a count-shaped `n + " is ..."` stays quiet. */
const NOT_PLURAL = new Set(['is', 'was', 'has', 'this', 'its', 'plus', 'us', 'does', 'his', 'yes', 'as']);

const COUNT_SHAPED = /(?:\.length|count|total|num|\bn)$/i;

const CONCAT = /([A-Za-z_$][\w$.]*(?:\(\))?)\s*\+\s*(["'`])(\s+([A-Za-z]+)[^"'`]*)\2/g;

const SINGULAR_GUARD = /[!=]==?\s*1\b/;

export function checkCountPlurals(source: string): { pass: boolean; findings: CountPluralFinding[] } {
  const findings: CountPluralFinding[] = [];
  source.split('\n').forEach((text, i) => {
    if (SINGULAR_GUARD.test(text)) return;
    for (const m of text.matchAll(CONCAT)) {
      const [, expr, , phrase, firstWord] = m;
      const word = firstWord.toLowerCase();
      const pluralVerb = PLURAL_VERBS.has(word);
      const pluralNoun =
        COUNT_SHAPED.test(expr) && /[^s]s$/.test(word) && !NOT_PLURAL.has(word);
      if (pluralVerb || pluralNoun) {
        findings.push({ line: i + 1, expr, phrase: phrase.trim() });
      }
    }
  });
  return { pass: findings.length === 0, findings };
}

export function renderCountPluralReport(findings: CountPluralFinding[]): string {
  if (findings.length === 0) return 'count plurals: every concatenated count phrase carries its singular form';
  return [
    `count plurals: ${findings.length} phrase(s) render ungrammatically when the count is 1 (ace#2248):`,
    ...findings.map(
      (f) =>
        `  line ${f.line}: ${f.expr} + " ${f.phrase}" — branch on the singular, e.g. ` +
        `${f.expr} === 1 ? " was …" : " ${f.phrase}"`,
    ),
  ].join('\n');
}
