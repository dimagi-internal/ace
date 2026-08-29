---
name: build-targeting-model
description: >
  Turn a targeting selection into a shareable Doc and a formula-driven Excel
  model. Use when the answer must leave the conversation.
disable-model-invocation: false
---

# Build Targeting Model

A figure that only exists in a chat transcript cannot be argued with, and cannot
be re-run when somebody challenges the unit cost. This skill produces the two
artifacts a funding conversation actually needs: a document that states the claim
with its sources, and a spreadsheet that is a *model* rather than an export —
assumptions in input cells, every cost column a formula, so a reader can change a
number and watch it propagate.

The distinction matters more than it sounds. A static export invites the reader
to trust the total. A model invites them to test it, and the ones that survive
testing are the ones that get funded.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Upstream | the selection and its totals | the headline figures |
| `defend-a-figure` | the three paragraphs and Sources table | the document body |
| Connect Labs MCP | `targeting_select` (high `limit`) | the ranked geography rows |
| Connect Labs MCP | `targeting_scenario` | cost basis and unit price |
| Connect Labs MCP | `targeting_methodology` | source URLs, licences, cross-check verdicts |
| Phase 1 (optional) | `1-design/idea-to-pdd.md` | the intervention and its pricing basis |

## Products

- A Google Doc via `drive_create_doc_from_markdown` — claim, defence, methods
  considered, Sources table with live links
- `<country>-<indicator>-targeting-model.xlsx` via `drive_upload_binary` — five
  sheets, described below
- `<phase>/build-targeting-model_summary.md` — what was produced and the links

## Process

1. **Confirm the figures have been defended.** If `defend-a-figure` has not run,
   run it. Publishing an undefended number is the failure this whole toolchain
   exists to prevent.
2. **Pull the ranked rows** with `targeting_select` at a high `limit` — the
   document shows a headline, the model shows the list, and a reader who cannot
   see their own district loses interest in both.
3. **Settle the cost basis explicitly** with `targeting_scenario`. A unit price
   is meaningless without a unit: per newborn, per child, per household, per
   case. Where an indicator implies no case count the per-case basis is refused
   rather than approximated — pick another basis, do not work around it.
4. **Build the workbook with `openpyxl`** (available in the labs venv), as a
   model and not an export — the sheet layout is below.
5. **Make every cost column a formula** referencing the Assumptions cells. A
   reader who changes the unit price and sees nothing move stops believing the
   spreadsheet.
6. **Reconcile the column sums against the published totals and disclose the
   difference.** Row values arrive rounded, so a column can differ from the
   headline by a few units. State it on the Assumptions sheet; a reader who
   finds it themselves assumes worse.
7. **Write the Doc from the defence**, with the Sources table carrying a working
   URL per input, taken from the methodology rather than invented.
8. **Upload both and return the links together.** A model without its document
   loses its caveats; a document without its model cannot be tested.

## MCP Tools Used

**connect_labs** (remote HTTP, PAT auth)
- `targeting_select` — built
- `targeting_scenario` — built
- `targeting_methodology` — built

**ace-gdrive**
- `drive_create_doc_from_markdown` — built
- `drive_upload_binary` — built

## The workbook

| Sheet | Holds |
|---|---|
| **Assumptions** | Unit cost, pricing basis, threshold, method, vintage — highlighted as inputs. Everything else references these. Carries the rounding note. |
| **Ranked geographies** | The eligible list ranked by burden, with population, the count being funded, cumulative share, and formula-driven cost columns. |
| **Threshold comparison** | The same selection at each threshold under discussion, so the reader can see what the cutoff is buying. |
| **Method comparison** | What every method reports, with the conservative figure named rather than left to be inferred. |
| **Sources & caveats** | Source, vintage, licence, live URL, and each cross-check's verdict. |

The cost columns are the load-bearing part: `=IF(Assumptions!$B$6="birth", E2, ...)`
to pick the denominator from the basis cell, and `=H2*Assumptions!$B$5` for the
cost itself. Hard-coded costs are the single most common reason a model gets
returned.

## Mode Behavior

- **Auto:** build both artifacts, upload, notify the admin group with the links
  and the headline figure.
- **Review:** present the document draft and the model's assumptions for
  approval before uploading to a shared Drive location.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-08-29 | Initial version — model-not-export principle, five-sheet layout, formula-driven costs, rounding disclosure | ACE team |
