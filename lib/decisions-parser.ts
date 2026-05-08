/**
 * Pure-function parser: Google Docs documents.get response → ParsedDecisionRow[].
 *
 * Walks the document body in paragraph order. HEADING_3 paragraphs are
 * decision-row boundaries (the row id). Within a decision section,
 * subsequent paragraphs are scanned for:
 *   - "Default: <value>"  → row.default
 *   - "Considered:"       → enters bullet-collection mode
 *   - bullet paragraphs   → appended to row.options_considered
 *   - "Source:" / "Status:" → exits bullet-collection mode; not extracted
 *
 * The parser is the inverse of lib/decisions-renderer.ts. Together they
 * form a round-trip pair for the decisions-sync workflow.
 *
 * NOT extracted: phase, skill, question, source, status, notes. Those are
 * not editable surfaces in the round-trip workflow; the merger pulls them
 * from the YAML.
 */

// ── Input shape (subset of Google Docs API documents.get response) ────────────

type DocsParagraph = {
  elements?: Array<{ textRun?: { content?: string } }>;
  paragraphStyle?: { namedStyleType?: string };
  bullet?: { listId?: string };
};

type DocsStructuralElement = { paragraph?: DocsParagraph };

type GoogleDocsDocument = { body?: { content?: DocsStructuralElement[] } };

// ── Output shape ──────────────────────────────────────────────────────────────

export type ParsedDecisionRow = {
  id: string;
  default?: string;
  options_considered?: string[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const HEADING_3 = "HEADING_3";
const HEADING_2 = "HEADING_2";

/** Concatenate all textRun.content values inside a paragraph, stripping the trailing newline. */
function paragraphText(p: DocsParagraph): string {
  if (!p.elements) return "";
  return p.elements
    .map((e) => e.textRun?.content ?? "")
    .join("")
    .replace(/\n$/, "");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a Google Docs `documents.get` response and extract decision rows.
 *
 * Pure function — no side effects, no I/O.
 *
 * @param doc - The Google Docs document object (or a compatible subset).
 * @returns Array of parsed decision rows, in document order.
 */
export function parseDocumentStructure(
  doc: GoogleDocsDocument,
): ParsedDecisionRow[] {
  const content = doc.body?.content ?? [];
  const rows: ParsedDecisionRow[] = [];

  // State machine: walk paragraphs in order.
  let current: ParsedDecisionRow | null = null;
  let inConsidered = false;

  function commit(): void {
    if (current) rows.push(current);
    current = null;
    inConsidered = false;
  }

  for (const el of content) {
    const p = el.paragraph;
    if (!p) continue;

    const style = p.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT";
    const text = paragraphText(p);

    if (style === HEADING_3) {
      commit();
      current = { id: text.trim() };
      continue;
    }

    if (style === HEADING_2) {
      commit();
      // HEADING_2 is a phase boundary — not a decision row.
      continue;
    }

    // HEADING_1 is the document title — skip.
    if (style === "HEADING_1") {
      continue;
    }

    if (!current) continue;

    // We're inside a decision section.
    const trimmed = text.trim();

    // Bullet paragraph inside a "Considered:" section.
    if (inConsidered && p.bullet) {
      if (trimmed) {
        current.options_considered = current.options_considered ?? [];
        current.options_considered.push(trimmed);
      }
      continue;
    }

    // A non-bullet paragraph exits the Considered block.
    if (inConsidered && !p.bullet) {
      inConsidered = false;
    }

    // Field-prefix detection (case-insensitive, strip leading indent).
    if (/^Default:/i.test(trimmed)) {
      current.default = trimmed.replace(/^Default:\s*/i, "").trim();
      continue;
    }

    if (/^Considered:/i.test(trimmed)) {
      inConsidered = true;
      continue;
    }

    if (/^Source:/i.test(trimmed) || /^Status:/i.test(trimmed)) {
      // Not extracted — just ensure we leave considered mode.
      inConsidered = false;
      continue;
    }

    // Any other body paragraph (question text, notes, blank lines) is ignored.
  }

  commit();
  return rows;
}
