# Dimagi External Document — Visual Style Guide

This is the complete visual specification for Dimagi-branded external documents (work orders, MSAs, MOUs, SOWs, partner agreements). Every value below is exact.

> Source: adapted from `sarvesh-tewari/ace-skills-stewari` (CLP work-order skill pair). Original target was programmatic `.docx` generation via `dimagi_styles.js`. **In ACE we render via `docs_copy_template` against a pre-styled Google Docs template (`templates/work-order-template.md` → uploaded as the WORK_ORDER_TEMPLATE_ID gdoc).** Use this guide when **updating the template** (or building a new one) — the values here are the source of truth for how the rendered Google Doc should look. The runtime skill does not consult this file per-run.

If you find a divergence between the rendered template and this guide, the guide is canonical — update the template.

---

## Page setup

- **Page size:** US Letter — 12,240 × 15,840 DXA (8.5" × 11")
- **Margins:** 1" on all sides (1,440 DXA top, right, bottom, left)
- **Header / footer margin:** 720 DXA (0.5") — but headers and footers are not used
- **Page numbers:** None
- **Columns:** Single column

DXA reminder: 1 inch = 1,440 DXA, 1 point = 20 DXA. Font sizes in OOXML are in half-points (so 11pt = `<w:sz w:val="22"/>`).

---

## Color palette

Use only these six colors. Reference them by name in code (never by raw hex).

| Name | Hex | Used for |
|---|---|---|
| Deep Purple | `#16006D` | Document title, H2 section headers (`1. Background`, `2. Scope of Work`…), metadata table label text, data table header row fills, numeric cells in first column of data tables (Week numbers, tranche numbers), inline emphasis where a brand colour is intended |
| Connect Indigo | `#3843D0` | Subtitle text under the title, decorative bottom border under title (12pt), decorative bottom border under each H2 (8pt) |
| Body Grey | `#5F6A7D` | All body paragraph text, all bullet text, all table cell values (except numbered first-column cells in data tables, which are Deep Purple) |
| Charcoal | `#434343` | H3 sub-heading text (`4.1`, `4.2`, `8.1`…). Provides clear visual hierarchy beneath Deep Purple H2s. |
| White | `#FFFFFF` | Text on Deep Purple table header rows |
| Light Purple | `#F2F0F7` | Metadata table label-column cell fill; alternating row shading on body rows of data tables |
| Border Grey | `#CCCCCC` | All table borders |

---

## Typography

Single font family: **Work Sans** (system fallback: Arial). Never mix in additional fonts — Dimagi documents use one font.

Default document text size: 11pt body (size 22 in half-points).

| Element | Font size | Color | Weight | Alignment | Other |
|---|---|---|---|---|---|
| Document title (e.g., `Work Order Agreement #3`) | 20pt (size 40) | Deep Purple | Bold | Centered | Space after: 60 DXA. Line: 240 (single). |
| Subtitle (project name) | 14pt (size 28) | Connect Indigo | Regular | Centered | Bottom border: 12pt Connect Indigo, 4 DXA space. Space after: 240 DXA. |
| H2 (numbered section: `1. Background`, `2. Scope of Work`) | 14pt (size 28) | Deep Purple | Bold | Left | Bottom border: 8pt Connect Indigo, 4 DXA space. Space before: 280 DXA, after: 120 DXA. Line: 240. |
| H3 (sub-section: `4.1 Primary Deliverable`) | 12pt (size 24) | Charcoal | Bold | Left | No border. Space before: 200 DXA, after: 80 DXA. Line: 240. |
| Body paragraph | 11pt (size 22 — inherits default) | Body Grey | Regular | Justified (`both`) | Space after: 200 DXA. Line: 300 (about 1.5 line spacing). |
| Inline bold | 11pt | Body Grey | Bold | inherits | Used sparingly — see writing-style.md |
| Bullet item | 11pt | Body Grey | Regular | Justified | Line: 300. Bullet character `●` (U+25CF, filled black circle). Indent: 720 DXA left, 360 DXA hanging. Sub-bullet: `○` (U+25E6) at indent 1,440 DXA. Sub-sub-bullet: `■` (U+25A0) at indent 2,160 DXA. |
| Table cell text (body) | 10pt (size 20) | Body Grey | Regular | Left (or centered for numbered ID columns) | Line: single. |
| Table header text | 10pt (size 20) | White | Bold | Left (or centered for narrow numeric columns) | Same line spacing. |
| Metadata table label | 10pt (size 20) | Deep Purple | Bold | Left | Sits in light-purple fill cell. |
| Signature block label | 11pt | Deep Purple | Bold | Left | Inline labels like `Name:`, `Title:`, `Signature:`, `Date:`. |

---

## Table patterns

Dimagi documents use exactly two table patterns. Do not invent new ones.

### Pattern A — Metadata table

Used once per document, immediately after the subtitle, to give the reader a one-glance summary of the deliverable. Typical fields: Work Order Number, Work Order Date, Work Order Title, Period of Performance. Choose 3–6 fields appropriate to the document type.

| Aspect | Value |
|---|---|
| Columns | 2 (label / value) |
| Total width | 9,360 DXA |
| Column widths | 2,400 (label) / 6,960 (value) |
| Borders | `#CCCCCC`, single, size 6 |
| Cell padding | top/bottom 80 DXA, left/right 140 DXA |
| Label cell fill | `#F2F0F7` Light Purple |
| Label cell text | Work Sans 10pt Deep Purple, bold |
| Value cell fill | None |
| Value cell text | Work Sans 10pt Body Grey |

### Pattern B — Data table

Used for timelines, payment schedules, roles & responsibilities matrices, comparison grids, data-handling specifications, and any other multi-row tabular content.

| Aspect | Value |
|---|---|
| Total width | 9,360 DXA |
| Column widths | Distribute to sum 9,360 — see Column Width Hints below |
| Borders | `#CCCCCC`, single, size 4 |
| Cell padding | top/bottom 100 DXA, left/right 140 DXA |
| Header row fill | `#16006D` Deep Purple |
| Header row text | Work Sans 10pt White, bold |
| First body row fill | None (white) |
| Second body row fill | `#F2F0F7` Light Purple |
| Subsequent rows | Alternate: white, Light Purple, white, Light Purple, … |
| Body cell text | Work Sans 10pt Body Grey |
| First-column ID/number cells | Bold, **Deep Purple**, centered (when the column is a number like Week 1, 2, 3 or Tranche # 1, 2, 3) |

#### Column Width Hints

Some typical column-width splits that work well at the 9,360-DXA total:

- 3-column R&R matrix: `5,360 / 2,000 / 2,000`
- 3-column timeline (Week / Dates / Activities): `1,100 / 1,700 / 6,560`
- 6-column payment schedule (# / Milestone / % / Amount / Trigger / Timing): `600 / 1,900 / 1,100 / 1,400 / 2,660 / 1,700`
- 2-column data handling specification: `3,000 / 6,360`

---

## Spacing

Spacing values in DXA (1,440 = 1 inch, 20 = 1 point):

- **Default line spacing (body):** 300 (≈1.5 line spacing, `lineRule="auto"`)
- **Default line spacing (headings, tables):** 240 (single)
- **Space after body paragraph:** 200 DXA (10pt)
- **Space before H2:** 280 DXA (14pt)
- **Space after H2:** 120 DXA (6pt)
- **Space before H3:** 200 DXA (10pt)
- **Space after H3:** 80 DXA (4pt)
- **Space after title:** 60 DXA (3pt)
- **Space after subtitle:** 240 DXA (12pt) — gives breathing room before the metadata table
- **Space between elements (paragraph → table):** Add a spacer paragraph or rely on the previous paragraph's after-spacing.

---

## Bullets

Bullet character hierarchy (Google Docs / Work Sans standard):

| Level | Character | Unicode | Indent (left) | Hanging |
|---|---|---|---|---|
| 0 | `●` | U+25CF (filled circle) | 720 DXA | 360 DXA |
| 1 | `○` | U+25E6 (hollow circle) | 1,440 DXA | 360 DXA |
| 2 | `■` | U+25A0 (filled square) | 2,160 DXA | 360 DXA |
| 3+ | Repeats: `●`, `○`, `■`… | | +720 DXA per level | 360 DXA |

Bullets are justified-aligned by default to match body paragraph alignment. They use the same line spacing (300) and Body Grey color as body paragraphs.

> ACE-specific note: bulleted regions in our Google Docs template are demarcated with `<<<BULLETS_*_START>>>` / `<<<BULLETS_*_END>>>` anchors and finalized via `docs_finalize_bullets` after `docs_copy_template`. The anchors apply standard Google Docs bullet styling (level 0 by default) and clean up empty bulleted paragraphs left over from blank-line spacing.

---

## Signature block

Two-column table at the end of the document. Each cell contains:

- Heading (Subcontractor / Dimagi, Inc.) in Work Sans 11pt Deep Purple bold.
- Lines for: `By:`, `Name:`, `Title:`, `Date:`, `Address for correspondence:`. Each label in Deep Purple bold, value in Body Grey on the same line.
- Borders: standard `#CCCCCC` size 4 around the cell. Light-purple fill (`#F2F0F7`) on the cell to set it apart.

Dimagi's default signatory: **Lucina Tse, COO, Dimagi, Inc., 245 Main Street, 2nd Floor, Cambridge, MA 02142**. (Note: this is Dimagi's legal/corporate address. The 585 Massachusetts Avenue address is the operating address and should not be used on contracts.)

Closing boilerplate above the signature table:
`IN WITNESS WHEREOF, the parties hereto have caused this Work Order to be executed by their authorized agents as of the date first above written, and annexed to the parties' MSA dated __________________.`

For non-work-order documents (MSA, MOU, SOW), substitute the document type and adapt as needed.

---

## What is intentionally absent

These are common docx features that Dimagi external documents do NOT use. Don't add them.

- **Headers and footers** — clean top and bottom of every page.
- **Page numbers** — not added.
- **Watermarks** — none, including no "DRAFT" or "CONFIDENTIAL" overlays. If a draft is being shared, use a `v0.x (working draft)` line at the top instead.
- **Multiple fonts** — Work Sans only.
- **Decorative drop caps, text effects, or font colours other than the six listed above.**
- **Justification within tables** — table cell text is left-aligned (or centered for numeric ID columns); only body paragraphs and bullets are justified.
- **First-line indents** — paragraphs are flush-left (with justified alignment).

---

## Source of truth

This style was derived from Dimagi work order v3 (RDT-DFHF, May 2026) and is meant to capture intentional design choices, not idiosyncrasies. If a future Dimagi document deliberately departs from these conventions, update this guide rather than carrying inconsistencies forward.
