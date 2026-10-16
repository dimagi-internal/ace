/**
 * Deterministic render check for a PUBLISHED Google Doc (ace#2213).
 *
 * Does the document a reader actually opens show raw markdown, and how many
 * images does it render? Both answers come from the anonymous txt / html
 * exports, never from the run-folder `.md` the doc was composed from.
 *
 * Why this lives outside `run-surface-audit.ts`: on
 * `poverty-graduation/20260905-1345` all five Phase 6 training `-eval`s passed
 * at 8.4-8.8 on documents that published as raw markdown, two of them with 0 of
 * the run's 157 screenshots. The surface auditor caught it (10 MISLEADING
 * findings, same day); the evals did not, because an LLM judge told in prose to
 * open the rendered artifact read the source instead. The detectors were only
 * reachable from `scripts/audit-run-surface.ts`. Here they are a shared helper,
 * and `scripts/check-published-doc-render.ts` is the binary pre-eval gate every
 * eval of a published Doc runs (ratchet: `test/skills/eval-checks-published-render.test.ts`).
 */

/**
 * Markers that a Google Doc is showing the reader raw markdown rather than
 * rendered prose (defect 11: documents rendered as literal `##`, `**`, and YAML
 * frontmatter because they were uploaded as `text/plain`).
 *
 * Deliberately anchored to line starts / paired delimiters so prose that
 * happens to contain an asterisk doesn't trip it.
 */
export const ATX_PATTERN = { re: /^#{1,6}[^\S\n]+\S[^\n]*$/m, what: 'ATX headings (`## ...`)' } as const;
export const LITERAL_MARKDOWN_PATTERNS: readonly { re: RegExp; what: string }[] = [
  // NOTE the `[^\S\n]` instead of `\s`. With `\s` and the `m` flag, `\s+`
  // happily eats the NEWLINE, so a lone `#` — which is what a Google Docs table
  // column literally named "#" exports as — matched against the first character
  // of the NEXT line. Measured on spark-facilitator's PDD, 2026-08-14: a clean,
  // properly-converted document was reported as raw markdown. A false positive
  // here is not harmless; it is the same class of bug as a false negative, and
  // it trains the reader to ignore the auditor.
  // ATX is also cross-checked against the HTML export when one is supplied: the
  // txt export drops code-span backticks, so `` `## Archive` is closed history``
  // arrives as a heading-shaped line (`hasUnexcusedAtxHeading`, ace#2499).
  ATX_PATTERN,
  { re: /\*\*[^*\n]{2,}\*\*/, what: 'bold markers (`**...**`)' },
  { re: /^---[^\S\n]*$[\s\S]{0,400}?^---[^\S\n]*$/m, what: 'YAML frontmatter fence' },
  { re: /^[^\S\n]*\|[^\n]+\|[^\S\n]*$/m, what: 'pipe tables' },
  { re: /!\[[^\]]*\]\([^)]*\)/, what: 'unresolved image references (`![alt](...)`)' },
  { re: /^[^\S\n]*```/m, what: 'code fences' },
];

const ATX_LINE = /^#{1,6}[^\S\n]+\S/;

/** Decode the handful of entities Google's HTML export emits in body text. */
function decodeHtmlText(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&sect;/g, '\u00a7')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const normaliseLine = (s: string): string => s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The plain text of every paragraph in a Google Docs HTML export that OPENS
 * with a monospace run starting `#` — i.e. a paragraph like
 * `` `## Archive` is closed history… `` whose txt-export line will begin
 * `## Archive …` with the backticks gone (dimagi-internal/ace#2499).
 *
 * Monospace is read from the export's own `<style>` block (`.c3{…font-family:
 * "Roboto Mono"}` is what Drive emits for a converted code span), never from a
 * guessed class name. Pure; regex-level, which is enough for Google's flat,
 * machine-generated export.
 */
export function codeSpanLedParagraphs(html: string): string[] {
  const mono = new Set<string>();
  for (const m of html.matchAll(/\.([A-Za-z0-9_-]+)\{([^}]*)\}/g)) {
    const family = /font-family:\s*([^;]+)/i.exec(m[2]);
    if (family && /mono|courier|consolas|menlo|source code/i.test(family[1])) mono.add(m[1]);
  }
  if (!mono.size) return [];

  const out: string[] = [];
  for (const m of html.matchAll(/<(p|li|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const first = /^\s*<span\b[^>]*class="([^"]*)"[^>]*>([^<]*)<\/span>/.exec(m[2]);
    if (!first) continue;
    if (!first[1].split(/\s+/).some((c) => mono.has(c))) continue;
    if (!decodeHtmlText(first[2]).trimStart().startsWith('#')) continue;
    out.push(normaliseLine(decodeHtmlText(m[2].replace(/<[^>]*>/g, ''))));
  }
  return out;
}

/**
 * Does the txt export carry an ATX heading line the HTML export does not
 * explain as a code-span-led paragraph? Each code-span paragraph excuses ONE
 * matching txt line, so a literal `## …` line that merely shares its text is
 * still caught. With no HTML the answer is the raw pattern — the safe direction.
 */
export function hasUnexcusedAtxHeading(text: string, html: string | null | undefined): boolean {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => ATX_LINE.test(l));
  if (!lines.length) return false;
  if (!html) return true;
  const excuses = new Map<string, number>();
  for (const p of codeSpanLedParagraphs(html)) excuses.set(p, (excuses.get(p) ?? 0) + 1);
  for (const line of lines) {
    const key = normaliseLine(line);
    const n = excuses.get(key) ?? 0;
    if (n === 0) return true;
    excuses.set(key, n - 1);
  }
  return false;
}

/** Number of images the published document renders (`<img` tags in its HTML export). */
export function renderedImageCount(html: string): number {
  return (html.match(/<img\b/gi) ?? []).length;
}

/**
 * The literal-markdown markers present in a published doc's txt export, as
 * human labels (`'ATX headings (`## ...`)'`, …). Empty = renders clean. The
 * html export, when supplied, only EXCUSES heading-shaped lines that are really
 * paragraphs opening with a code span (ace#2499).
 */
export function literalMarkdownHits(text: string, html?: string | null): string[] {
  return LITERAL_MARKDOWN_PATTERNS.filter((p) =>
    p === ATX_PATTERN ? hasUnexcusedAtxHeading(text, html) : p.re.test(text),
  ).map((p) => p.what);
}

export interface PublishedDocExport {
  /** Plain-text export, or null when the doc could not be read anonymously. */
  text: string | null;
  /** `<img` count in the html export, or null when it was not readable. */
  images: number | null;
  html: string | null;
  /** Why `text` is null, when it is. Empty otherwise. */
  why: string;
}

/**
 * Plain-text (and image-count) export of a Google Doc, ANONYMOUSLY.
 *
 * Sequential and retried, not parallel. A first cut fired the txt and html
 * exports concurrently across every deliverable and Google throttled one of
 * them, which surfaced as "could not read this document" — a transient network
 * condition wearing the costume of a real finding. An auditor that cries wolf
 * gets ignored, so a read failure is retried once and reports the status it
 * actually saw.
 *
 * Returns `text: null` when the document genuinely could not be read.
 */
export async function fetchPublishedDocExport(url: string): Promise<PublishedDocExport> {
  const m = url.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  if (!m) return { text: null, images: null, html: null, why: 'not a Drive document URL' };
  const id = m[1];
  // Slides and Sheets have no plain-text export; they are judged by the link
  // probe only, and this says so rather than reporting them unread.
  if (!url.includes('/document/')) return { text: null, images: null, html: null, why: 'not a Google Doc (no text export)' };

  async function get(fmt: 'txt' | 'html'): Promise<{ ok: boolean; body: string; status: number }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`https://docs.google.com/document/d/${id}/export?format=${fmt}`, {
          redirect: 'follow',
          credentials: 'omit',
        });
        if (r.ok && !r.url.includes('accounts.google.com')) return { ok: true, body: await r.text(), status: r.status };
        if (attempt === 0) {
          await new Promise((res) => setTimeout(res, 1500));
          continue;
        }
        return { ok: false, body: '', status: r.status };
      } catch {
        if (attempt === 0) await new Promise((res) => setTimeout(res, 1500));
      }
    }
    return { ok: false, body: '', status: 0 };
  }

  const txt = await get('txt');
  if (!txt.ok) return { text: null, images: null, html: null, why: `text export answered HTTP ${txt.status || 'nothing'} anonymously` };
  const html = await get('html');
  return {
    text: txt.body,
    images: html.ok ? renderedImageCount(html.body) : null,
    // Handed to the literal-markdown check so a code span the txt export
    // unwrapped is not reported as a raw `##` heading (ace#2499).
    html: html.ok ? html.body : null,
    why: '',
  };
}

export interface PublishedRenderVerdict {
  ok: boolean;
  /** Literal-markdown markers found on the published page. */
  literalMarkdownHits: string[];
  /** Images the published page renders; null when unreadable. */
  renderedImageCount: number | null;
  /** Each reason `ok` is false, in plain words. */
  failures: string[];
}

/**
 * Pure verdict over an export. Fails on: an unreadable doc (not judged is not
 * clean), any literal-markdown marker, and — only when `expectImages` is set,
 * i.e. for an `illustrated` artifact — a render with zero images.
 */
export function judgePublishedRender(
  exp: Pick<PublishedDocExport, 'text' | 'html' | 'images' | 'why'>,
  opts: { expectImages?: boolean } = {},
): PublishedRenderVerdict {
  if (exp.text === null) {
    return {
      ok: false,
      literalMarkdownHits: [],
      renderedImageCount: null,
      failures: [`could not read the published document anonymously (${exp.why || 'unknown'}), so it was not judged`],
    };
  }
  const hits = literalMarkdownHits(exp.text, exp.html);
  const failures: string[] = [];
  if (hits.length) failures.push(`the published document shows raw markdown: ${hits.join(', ')}`);
  if (opts.expectImages) {
    if (exp.images === null) failures.push('could not read the html export, so the rendered image count is unknown');
    else if (exp.images === 0) failures.push('the published document renders ZERO images');
  }
  return { ok: failures.length === 0, literalMarkdownHits: hits, renderedImageCount: exp.images, failures };
}
