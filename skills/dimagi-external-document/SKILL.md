---
name: dimagi-external-document
description: >
  Generate Dimagi-branded external .docx documents — work orders, MSAs,
  SOWs, partner agreements, funder proposals. Use whenever producing
  any external-facing Dimagi deliverable.
---

# Dimagi External Document

This skill produces Dimagi-branded `.docx` documents that match the visual and writing style used in Dimagi's external-facing contracts, work orders, and partner agreements. It covers both the **visual brand application** (fonts, colors, table styling, spacing) and the **writing conventions** (voice, terminology, structural patterns) that make a document recognizable as a Dimagi document.

## When this skill applies

| Document type | Use this skill? |
|---|---|
| Work Order Agreement (Connect, Trace, OCS, custom) | Yes |
| Master Services Agreement (MSA) extensions | Yes |
| Memorandum of Understanding (MOU) | Yes |
| Statement of Work (SOW) | Yes |
| Partner agreements with LLOs | Yes |
| Funder-facing proposals | Yes |
| Internal docs (Slack updates, team norms, status reports) | No — use internal-comms or markdown |
| Investor decks, slide presentations | No — pptx skill with Dimagi palette |

## Related skills

- `clp-stage-work-order` — defines the *content structure* for CLP stage work orders. Use it alongside this skill: that one says what sections go in the document; this one says how to render them.

## Two-step workflow

Always work in this order. Skipping step 1 leads to documents that look right but read wrong; skipping step 2 leads to documents that read right but look wrong.

**Step 1 — Draft content in markdown.** Capture the deliverable in plain markdown first, applying the writing conventions in `references/writing-style.md`. Iterate with the user on content before touching styling. Working drafts use `.md`; final leadership deliverables use `.docx`.

**Step 2 — Convert to styled `.docx`.** Once content is locked, generate the Word document by writing a Node.js script that uses the helpers in `scripts/dimagi_styles.js`. The helpers encode every visual decision (font, color, size, spacing, table borders, alternating row shading). Do not re-derive these values — they are intentional and consistent across documents. See `scripts/example_work_order.js` for a worked example.

## Files in this skill

- **`references/style-guide.md`** — Complete visual specification. Read this before writing any styling code. Includes the full color palette, typography table, table patterns (metadata table vs. data table), spacing values, and bullet conventions.
- **`references/writing-style.md`** — Writing conventions: voice, modal verbs, pronoun strategy ("the partner"), bold-use rules, soft commercial language, justified alignment, terminology preferences.
- **`scripts/dimagi_styles.js`** — Node.js helper library. Exports functions for every styled element: `title()`, `subtitle()`, `h2()`, `h3()`, `body()`, `richBody()`, `bullet()`, `metadataTable()`, `dataTable()`, `signatureBlock()`. All Dimagi brand constants (colors, fonts, sizes) are exported as named constants so they can be referenced directly.
- **`scripts/example_work_order.js`** — A worked example that builds a small Dimagi work order using the helpers. Copy and adapt for new documents.
- **`scripts/README.md`** — How to run the scripts, what `npm` packages are needed, where files are written.

## Quick start for a new document

1. Read `references/style-guide.md` and `references/writing-style.md`.
2. Draft the content in markdown. Iterate with the user.
3. When content is locked, copy `scripts/example_work_order.js` to a new file named after your document.
4. Replace the example content with your real content, using the same helper functions.
5. Run with `node your_doc.js` (after `npm install docx` if not already installed).
6. Validate the output (open in Word or convert to PDF) and ship.

## What the helpers handle for you

You do not need to remember any of these — the helpers apply them automatically:

- **Fonts:** Work Sans throughout, with Arial fallback via system substitution.
- **Page setup:** US Letter, 1-inch margins all sides, no headers, no footers, no page numbers.
- **Colors:** Deep Purple `#16006D` for title and H2 section headers; Connect Indigo `#3843D0` for subtitle text and decorative borders under title and H2; Body Grey `#5F6A7D` for all body text; Charcoal `#434343` for H3 sub-headings; White on Deep Purple for table headers; Light Purple `#F2F0F7` for metadata table label cells and alternating data-table rows.
- **Tables:** Two distinct patterns. Metadata table (top-of-doc summary) has a light-purple label column with Deep Purple bold labels and a plain value column. Data tables (timeline, payment, R&R) have a Deep Purple header row with white text and alternating `#F2F0F7` row shading on body rows starting from the second body row.
- **Spacing:** 1.5 line spacing on body paragraphs, justified alignment, 10pt space after paragraphs.
- **Bullets:** `●` character (filled black circle), with 720 DXA left indent and 360 hanging indent. Level 2 uses `○`, level 3 uses `■`.

## What the user must decide for each document

These are document-specific and the helpers cannot decide for you:

- **Document title** and **subtitle** (e.g., "Work Order Agreement #3" and "Malaria RDT Point-of-Care Sampling Pilot — Nigeria").
- **Metadata fields** at the top (e.g., Work Order Number, Date, Title, Period of Performance). Choose 3–6 fields appropriate to the document type.
- **Section structure** (numbered top-level sections like "1. Background", "2. Scope of Work", etc.). Work orders typically have 8–10 sections; an MSA may have more; a short SOW may have fewer.
- **Partner naming convention.** Use the "henceforth, referred to as 'partner'" pattern (see `references/writing-style.md`) so the rest of the document stays neutral and templateable.
- **Signature block.** Include Dimagi's signatory (typically Lucina Tse, COO, with address `245 Main Street, 2nd Floor, Cambridge, MA 02142`) and the partner's signatory.
- **Annexures.** List them at the end of the main document; supply them as separate documents.

## Common mistakes to avoid

- **Do not use Calibri or Times New Roman.** Dimagi documents always use Work Sans.
- **Do not use `•` (U+2022) for bullets.** Use `●` (U+25CF). The hierarchy is `●` → `○` → `■`.
- **Do not left-align body paragraphs.** They are always justified.
- **Do not skip the alternating row shading on data tables.** It is subtle but intentional. Header row gets the Deep Purple fill; first body row stays white; second body row gets `#F2F0F7`; alternate from there.
- **Do not put H3 sub-headings in Deep Purple.** They are Charcoal `#434343`. Only H1 (title) and H2 (numbered section headers) are in Deep Purple. The hierarchy is purple → purple → charcoal.
- **Do not add headers, footers, or page numbers.** Dimagi external documents omit these on purpose; the document is meant to look clean.
- **Do not invent colors.** Stick to the six in `references/style-guide.md`. If you need an additional accent (e.g., for a chart), check with the user first.
