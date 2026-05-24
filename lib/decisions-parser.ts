/**
 * Pure-function parser: Google Docs documents.get response → ParsedDecisionRow[].
 *
 * Walks the document body in paragraph order. HEADING_3 paragraphs are
 * decision-row boundaries (the row id). Within a decision section,
 * subsequent paragraphs are scanned for:
 *   - "AI-default: <value>"        → contributes to row.value (falls back; loses to Override)
 *   - "Override: <value>"          → wins; sets row.value
 *   - "Options:" / "Considered:"   → enters bullet-collection mode
 *   - bullet paragraphs            → appended to row.options
 *   - "Override reasoning: <text>" → row.override_reasoning
 *   - "Source:" / "Status:" / "Reasoning:" → exits bullet-collection mode; not extracted
 *
 * The parser is the inverse of lib/decisions-renderer.ts. Together they
 * form a round-trip pair for the decisions-sync workflow.
 *
 * NOT extracted: phase, skill, question, source, status, reasoning. Those are
 * not editable surfaces in the round-trip workflow; the merger pulls them
 * from the YAML.
 *
 * The `value` field on ParsedDecisionRow is the effective value the human
 * wants applied — Override if present, else AI-default. The merger
 * compares it to the YAML row's effective value to decide whether an
 * override change occurred.
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
  value?: string;
  options?: string[];
  override_reasoning?: string;
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

  type Acc = {
    id: string;
    aiDefault?: string;
    override?: string;
    options?: string[];
    override_reasoning?: string;
  };
  let current: Acc | null = null;
  let inOptions = false;

  function commit(): void {
    if (current) {
      const value = current.override ?? current.aiDefault;
      const row: ParsedDecisionRow = { id: current.id };
      if (value !== undefined) row.value = value;
      if (current.options !== undefined) {
        row.options = current.options;
      }
      if (current.override_reasoning !== undefined) {
        row.override_reasoning = current.override_reasoning;
      }
      rows.push(row);
    }
    current = null;
    inOptions = false;
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
      continue;
    }

    if (style === "HEADING_1") {
      continue;
    }

    if (!current) continue;

    const trimmed = text.trim();

    // Bullet paragraph inside an "Options:" / "Considered:" section.
    if (inOptions && p.bullet) {
      if (trimmed) {
        current.options = current.options ?? [];
        current.options.push(trimmed);
      }
      continue;
    }

    if (inOptions && !p.bullet) {
      inOptions = false;
    }

    if (/^AI-default:/i.test(trimmed)) {
      current.aiDefault = trimmed.replace(/^AI-default:\s*/i, "").trim();
      continue;
    }

    // "Override reasoning:" must be checked BEFORE "Override:" to avoid
    // partial prefix match.
    if (/^Override reasoning:/i.test(trimmed)) {
      current.override_reasoning = trimmed.replace(/^Override reasoning:\s*/i, "").trim();
      continue;
    }

    if (/^Override:/i.test(trimmed)) {
      current.override = trimmed.replace(/^Override:\s*/i, "").trim();
      continue;
    }

    // Accept both "Options:" (v3) and "Considered:" (v2 gdocs).
    if (/^Options:/i.test(trimmed) || /^Considered:/i.test(trimmed)) {
      inOptions = true;
      continue;
    }

    if (/^Source:/i.test(trimmed) || /^Status:/i.test(trimmed) || /^Reasoning:/i.test(trimmed)) {
      inOptions = false;
      continue;
    }
  }

  commit();
  return rows;
}
