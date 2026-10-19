/**
 * Markdown → Google Docs batchUpdate requests that write ONE document tab.
 *
 * `canopy gdoc publish` renders markdown into a doc's body but knows nothing
 * of tabs, and Drive's markdown import always yields a single-tab doc. A
 * report that needs a clean first tab (the analyst overview) beside a detail
 * tab therefore needs the content written into a tab directly. This builds
 * those requests for a freshly added, empty tab: one insertText, then the
 * heading styles, bold and link runs, then the bullet lists.
 *
 * Supported: `#`/`##`/`###` headings, paragraphs, `- ` bullets (two-space
 * indent per nesting level), `1. ` numbered items, `**bold**` and
 * `[text](https://…)` inline. Pipe tables are refused, not mangled: write the
 * content as headed sections or bullets instead.
 */

export interface DocsRequest {
  [key: string]: unknown;
}

interface Run {
  start: number;
  end: number;
  bold?: boolean;
  link?: string;
}

interface ListGroup {
  start: number;
  end: number;
  numbered: boolean;
}

const HEADINGS: Record<number, string> = { 1: 'HEADING_1', 2: 'HEADING_2', 3: 'HEADING_3' };

/** Strip `**bold**` and `[text](url)` markers from one line, returning the plain text and its runs (offsets relative to the line). */
export function parseInline(line: string): { text: string; runs: Run[] } {
  const runs: Run[] = [];
  let text = '';
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    text += line.slice(last, m.index);
    if (m[1] !== undefined) {
      // Bold may itself contain a link: parse it recursively.
      const inner = parseInline(m[1]);
      const base = text.length;
      runs.push({ start: base, end: base + inner.text.length, bold: true });
      for (const r of inner.runs) runs.push({ ...r, start: r.start + base, end: r.end + base });
      text += inner.text;
    } else {
      runs.push({ start: text.length, end: text.length + m[2].length, link: m[3] });
      text += m[2];
    }
    last = re.lastIndex;
  }
  text += line.slice(last);
  return { text, runs };
}

/**
 * Build the requests that write `markdown` into the (empty) tab `tabId`.
 * Indices start at 1, the first position of an empty tab body.
 */
export function markdownToTabRequests(markdown: string, tabId: string): DocsRequest[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let body = '';
  const headings: Array<{ start: number; end: number; style: string }> = [];
  const runs: Run[] = [];
  const groups: ListGroup[] = [];
  let open: ListGroup | null = null;

  const closeList = () => {
    if (open) groups.push(open);
    open = null;
  };

  for (const raw of lines) {
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      throw new Error(`markdownToTabRequests: pipe tables are not supported in a tab ("${raw.slice(0, 60)}"); use headed sections or bullets`);
    }
    if (raw.trim() === '') {
      closeList();
      continue;
    }
    const start = 1 + body.length;
    const h = /^(#{1,3})\s+(.*)$/.exec(raw);
    const b = /^( *)[-*]\s+(.*)$/.exec(raw);
    const n = /^( *)\d+\.\s+(.*)$/.exec(raw);
    let content: string;
    let prefix = '';
    if (h) {
      closeList();
      content = h[2];
    } else if (b || n) {
      const mm = (b ?? n)!;
      const numbered = !b;
      // Leading tabs set the nesting level; createParagraphBullets consumes them.
      prefix = '\t'.repeat(Math.floor(mm[1].length / 2));
      content = mm[2];
      if (open && open.numbered !== numbered) closeList();
      if (!open) open = { start, end: start, numbered };
    } else {
      closeList();
      content = raw.trim();
    }
    const parsed = parseInline(content);
    const textStart = start + prefix.length;
    for (const r of parsed.runs) runs.push({ ...r, start: r.start + textStart, end: r.end + textStart });
    body += prefix + parsed.text + '\n';
    const end = 1 + body.length;
    if (h) headings.push({ start, end, style: HEADINGS[h[1].length] });
    if (open) open.end = end;
  }
  closeList();

  const requests: DocsRequest[] = [{ insertText: { location: { index: 1, tabId }, text: body } }];
  for (const hd of headings) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: hd.start, endIndex: hd.end, tabId },
        paragraphStyle: { namedStyleType: hd.style },
        fields: 'namedStyleType',
      },
    });
  }
  for (const r of runs) {
    const textStyle: Record<string, unknown> = {};
    const fields: string[] = [];
    if (r.bold) {
      textStyle.bold = true;
      fields.push('bold');
    }
    if (r.link) {
      textStyle.link = { url: r.link };
      fields.push('link');
    }
    requests.push({
      updateTextStyle: { range: { startIndex: r.start, endIndex: r.end, tabId }, textStyle, fields: fields.join(',') },
    });
  }
  // Bullets last and in reverse: each createParagraphBullets deletes its
  // groups' leading tabs, which shifts every index after it.
  for (const g of [...groups].reverse()) {
    requests.push({
      createParagraphBullets: {
        range: { startIndex: g.start, endIndex: g.end, tabId },
        bulletPreset: g.numbered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });
  }
  return requests;
}
