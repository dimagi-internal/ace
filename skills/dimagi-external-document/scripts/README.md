# Scripts

Node.js generator for Dimagi-branded `.docx` documents.

## Files

- **`dimagi_styles.js`** — Helper library. Encodes every visual decision from `references/style-guide.md` as a set of reusable functions and exported constants. Do not edit casually — changes here affect every document built with this skill.
- **`example_work_order.js`** — A worked example showing how to use the helpers. Copy this file and adapt it for any new document.

## Prerequisites

- Node.js 18+ (any modern version works)
- The `docx` npm package:

  ```bash
  npm install docx
  ```

  If installing globally: `npm install -g docx` and set `NODE_PATH` when running.

## Running the example

```bash
cd scripts
node example_work_order.js
```

This produces `example_work_order.docx` in the working directory. Open it in Word to confirm the styling.

## Building a new document

1. Decide the document type (work order, MSA, SOW, etc.) and section structure.
2. Draft the content in markdown first — iterate with the user until content is locked. Do not start scripting until the content is settled.
3. Copy `example_work_order.js` to a new file named for your document (e.g., `wo_clp_stage4_partner_x.js`).
4. Replace the placeholder content with your real content, using the same helper functions:
   - `D.title(...)`, `D.subtitle(...)` — title block
   - `D.metadataTable([...])` — top-of-doc summary
   - `D.h2(...)`, `D.h3(...)` — section and sub-section headings
   - `D.body(...)`, `D.richBody([...])` — paragraphs
   - `D.bullet(...)` — bullet items (supports rich segments with bold)
   - `D.dataTable({...})` — purple-header tables with alternating row shading
   - `D.signatureBlock({...})` — closing signature block
5. Run `node your_file.js` to produce the `.docx`.
6. Validate by opening in Word or converting to PDF (`soffice --headless --convert-to pdf your_file.docx`).
7. Save the final to your project's `outputs/` folder with the naming convention `YYYY-MM-DD-[scope]-[document-type].docx`.

## What the helpers expect from you

The helpers handle all visual styling. You provide:

- **Content** — the words, structured into sections and sub-sections you choose.
- **Column widths** for data tables — distribute to sum 9,360 DXA total. See `references/style-guide.md` for typical splits.
- **Centering / bolding / coloring hints** for data tables via the `options` parameter on `D.dataTable(...)`. Typically you'll center the first column when it's a numeric ID (Week 1, 2, 3...).

## What the helpers will NOT decide

- The document's section structure (you choose which sections to include and in what order).
- Whether to use `D.body(...)` or `D.bullet(...)` for a given block (your judgement — see `references/writing-style.md`).
- Inline bold emphasis (you decide which words are load-bearing — use `D.richBody([{text, bold}])` for mixed runs).

## If something looks wrong

1. Re-read `references/style-guide.md` and confirm the spec matches what you see rendered.
2. Open the generated `.docx` in Word (not just LibreOffice / PDF preview — the rendering can differ slightly).
3. If the issue is in the helpers, fix it in `dimagi_styles.js` and document the change. Don't patch around it in your document-specific script — the next document will hit the same bug.

## Validation tip

To inspect the generated docx's XML directly:

```bash
unzip -o your_doc.docx -d your_doc_unpacked/
# then look at your_doc_unpacked/word/document.xml
```

This is useful when debugging unusual rendering issues — the XML doesn't lie about what was set.
