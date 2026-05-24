/**
 * Pure-function renderer: DecisionsLog → Google Docs API batchUpdate requests[].
 *
 * Takes a validated DecisionsLog and returns an array of Docs API request
 * objects that, when applied via docs.documents.batchUpdate, produce a
 * formatted prose Google Doc.
 *
 * Layout produced:
 *   Decisions Log — <opp> / run <run_id>         [HEADING_1]
 *   <intro paragraph>                             [body, italic]
 *   Phase N — <Name>                              [HEADING_2, per phase group]
 *   <decision-id>                                 [HEADING_3, per decision]
 *   <question>                                    [body, bold]
 *   Default: <value>                              [bold prefix, normal value]
 *   Considered: / bullets                         [bold prefix + bullet list]
 *   Source: <value>                               [bold prefix]
 *   Status: <value>                               [bold prefix; OPEN gets emphasis]
 *   <notes>                                       [italic, if present]
 *
 * No Drive calls; no I/O. Caller (scripts/decisions-render.ts) applies the
 * requests via docs_batch_update.
 *
 * Index management strategy:
 *   A freshly-created Google Doc has an implicit empty paragraph at index 1.
 *   We insert text at the running end-of-document cursor, which starts at 1
 *   (the body start). Each insertText request extends the cursor by the
 *   length of the inserted text. After all insertText requests are emitted,
 *   we append updateParagraphStyle, updateTextStyle, and createParagraphBullets
 *   requests whose ranges reference the stable positions already established.
 */

import type { DecisionsLog, DecisionRow } from "./decisions-schema.js";

// ── Minimal local request-type union ─────────────────────────────────────────

export type BatchUpdateRequest =
  | { insertText: { location: { index: number }; text: string } }
  | {
      updateParagraphStyle: {
        range: { startIndex: number; endIndex: number };
        paragraphStyle: { namedStyleType?: string; alignment?: string };
        fields: string;
      };
    }
  | {
      updateTextStyle: {
        range: { startIndex: number; endIndex: number };
        textStyle: {
          bold?: boolean;
          italic?: boolean;
          foregroundColor?: {
            color: { rgbColor: { red: number; green: number; blue: number } };
          };
        };
        fields: string;
      };
    }
  | {
      createParagraphBullets: {
        range: { startIndex: number; endIndex: number };
        bulletPreset: string;
      };
    };

// ── Deferred styling descriptor ───────────────────────────────────────────────

type DeferredStyle =
  | {
      kind: "paragraphStyle";
      startIndex: number;
      endIndex: number;
      namedStyleType: string;
    }
  | {
      kind: "textStyle";
      startIndex: number;
      endIndex: number;
      bold?: boolean;
      italic?: boolean;
    }
  | {
      kind: "bulletList";
      startIndex: number;
      endIndex: number;
    };

// ── RequestBuilder ────────────────────────────────────────────────────────────

/**
 * Stateful builder that accumulates insertText requests and defers
 * styling requests until all text is in (indices are then stable).
 */
class RequestBuilder {
  private inserts: BatchUpdateRequest[] = [];
  private deferred: DeferredStyle[] = [];
  /** Running cursor. Starts at 1 (the implicit body start of a new doc). */
  private cursor = 1;

  /** Insert text at the current cursor, advancing it. Returns the range. */
  private insert(text: string): { startIndex: number; endIndex: number } {
    const startIndex = this.cursor;
    this.inserts.push({
      insertText: {
        location: { index: this.cursor },
        text,
      },
    });
    this.cursor += text.length;
    return { startIndex, endIndex: this.cursor };
  }

  /**
   * Append a paragraph (text + trailing newline). Returns the range
   * covering the entire paragraph including the newline.
   */
  appendParagraph(text: string): { startIndex: number; endIndex: number } {
    return this.insert(text + "\n");
  }

  /**
   * Append a paragraph and schedule a paragraph style update.
   */
  appendHeading(text: string, namedStyleType: "HEADING_1" | "HEADING_2" | "HEADING_3"): void {
    const range = this.appendParagraph(text);
    this.deferred.push({ kind: "paragraphStyle", namedStyleType, ...range });
  }

  /**
   * Append an italic paragraph.
   */
  appendItalic(text: string): void {
    const range = this.appendParagraph(text);
    this.deferred.push({ kind: "textStyle", italic: true, ...range });
  }

  /**
   * Append a line with a bold prefix label and a normal-weight value.
   * E.g. `appendBoldPrefix("Default:", "atomic-visit")` → "  Default: atomic-visit\n"
   * with "Default:" in bold.
   */
  appendBoldPrefix(prefix: string, value: string, indent = "  "): void {
    const line = `${indent}${prefix} ${value}`;
    const startIndex = this.cursor;
    this.insert(line + "\n");
    // Bold only the prefix portion (indent + prefix). The trailing
    // space and value are unbolded.
    const boldEnd = startIndex + indent.length + prefix.length;
    this.deferred.push({
      kind: "textStyle",
      bold: true,
      startIndex,
      endIndex: boldEnd,
    });
  }

  /**
   * Append a bold paragraph (entire line bold).
   */
  appendBold(text: string): void {
    const range = this.appendParagraph(text);
    this.deferred.push({ kind: "textStyle", bold: true, ...range });
  }

  /**
   * Append a label-only bold line (no value), e.g. "  Considered:".
   */
  appendBoldLabel(label: string, indent = "  "): { endIndex: number } {
    const range = this.appendParagraph(`${indent}${label}`);
    this.deferred.push({ kind: "textStyle", bold: true, ...range });
    return { endIndex: range.endIndex };
  }

  /**
   * Append each item as its own paragraph, then schedule a
   * createParagraphBullets request spanning all of them. No leading
   * indent on the text content — Google Docs' bullet preset handles the
   * visual indentation; a literal indent here would render as a double
   * indent in the live doc.
   */
  appendBulletList(items: string[]): void {
    if (items.length === 0) return;
    const listStart = this.cursor;
    for (const item of items) {
      this.insert(item + "\n");
    }
    const listEnd = this.cursor;
    this.deferred.push({ kind: "bulletList", startIndex: listStart, endIndex: listEnd });
  }

  /**
   * Produce the final ordered request list:
   * 1. All insertText requests (document order).
   * 2. All deferred style/bullet requests.
   */
  build(): BatchUpdateRequest[] {
    const styleRequests: BatchUpdateRequest[] = this.deferred.map((d) => {
      if (d.kind === "paragraphStyle") {
        return {
          updateParagraphStyle: {
            range: { startIndex: d.startIndex, endIndex: d.endIndex },
            paragraphStyle: { namedStyleType: d.namedStyleType },
            fields: "namedStyleType",
          },
        } satisfies BatchUpdateRequest;
      } else if (d.kind === "textStyle") {
        const textStyle: { bold?: boolean; italic?: boolean } = {};
        if (d.bold) textStyle.bold = true;
        if (d.italic) textStyle.italic = true;
        const fields = Object.keys(textStyle).join(",");
        return {
          updateTextStyle: {
            range: { startIndex: d.startIndex, endIndex: d.endIndex },
            textStyle,
            fields,
          },
        } satisfies BatchUpdateRequest;
      } else {
        // bulletList
        return {
          createParagraphBullets: {
            range: { startIndex: d.startIndex, endIndex: d.endIndex },
            bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
          },
        } satisfies BatchUpdateRequest;
      }
    });

    return [...this.inserts, ...styleRequests];
  }
}

// ── Phase label helpers ───────────────────────────────────────────────────────

/**
 * Parse a phase string like "1-design" or "3-commcare-setup" into a
 * human-readable label: "Phase 1 — Design" / "Phase 3 — Commcare Setup".
 */
function phaseLabel(phase: string): string {
  const dashIdx = phase.indexOf("-");
  if (dashIdx === -1) return `Phase ${phase}`;
  const num = phase.slice(0, dashIdx);
  const name = phase
    .slice(dashIdx + 1)
    .split("-")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
  return `Phase ${num} — ${name}`;
}

// ── Intro paragraph text ──────────────────────────────────────────────────────

const INTRO =
  'Generated {generated_at}. To override a default, edit the "AI-default:" line of the relevant decision below — the sync step will record your value as an Override and preserve the original AI-default. ' +
  'To propose a new option, add a bullet to "Options:". Add your reasoning under "Override reasoning:". Then run /ace:step decisions-sync <opp>/<run-id> to push your edits back.';

// ── Decision block renderer ───────────────────────────────────────────────────

function renderDecision(builder: RequestBuilder, row: DecisionRow): void {
  // HEADING_3: decision id
  builder.appendHeading(row.id, "HEADING_3");

  // Bold question
  builder.appendBold(row.question);

  // AI-default: <value>
  builder.appendBoldPrefix("AI-default:", row["ai-default"]);

  // Override: <value> (only when present)
  if (row.override !== undefined) {
    builder.appendBoldPrefix("Override:", row.override);
  }

  // Options: (bold label) then bullet list
  builder.appendBoldLabel("Options:");
  builder.appendBulletList(row.options);

  // Source: <value>
  builder.appendBoldPrefix("Source:", row.source);

  // Status: <value>
  builder.appendBoldPrefix("Status:", row.status);

  // AI reasoning (italic), if present
  if (row.reasoning) {
    builder.appendParagraph("");
    builder.appendBoldLabel("Reasoning:");
    builder.appendItalic(`  ${row.reasoning}`);
  }

  // Override reasoning (italic), if present
  if (row.override_reasoning) {
    builder.appendBoldLabel("Override reasoning:");
    builder.appendItalic(`  ${row.override_reasoning}`);
  }

  // trailing blank line
  builder.appendParagraph("");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render a validated DecisionsLog into a list of Google Docs API
 * batchUpdate request objects.
 *
 * Pure function — no side effects, no I/O.
 *
 * @param log - The validated decisions log.
 * @returns Ordered array of Docs API batchUpdate request objects.
 */
export function renderDecisionsLog(log: DecisionsLog): BatchUpdateRequest[] {
  const builder = new RequestBuilder();

  // ── Title ────────────────────────────────────────────────────────────
  builder.appendHeading(
    `Decisions Log — ${log.opportunity} / run ${log.run_id}`,
    "HEADING_1",
  );

  // ── Intro ────────────────────────────────────────────────────────────
  const intro = INTRO.replace("{generated_at}", log.generated_at);
  builder.appendItalic(intro);
  builder.appendParagraph(""); // blank line after intro

  // ── Group decisions by phase (preserve order) ─────────────────────
  const phaseGroups: Map<string, DecisionRow[]> = new Map();
  for (const row of log.decisions) {
    let group = phaseGroups.get(row.phase);
    if (!group) {
      group = [];
      phaseGroups.set(row.phase, group);
    }
    group.push(row);
  }

  for (const [phase, rows] of phaseGroups) {
    // HEADING_2: phase header
    builder.appendHeading(phaseLabel(phase), "HEADING_2");

    for (const row of rows) {
      renderDecision(builder, row);
    }
  }

  return builder.build();
}
