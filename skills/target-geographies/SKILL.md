---
name: target-geographies
description: >
  Pick target geographies by disease burden or service coverage, size and cost
  the reach, and defend the figures. Use when asked where to intervene or how
  many people a programme could reach.
disable-model-invocation: false
---

# Target Geographies

Where an intervention should go, who lives there, what reaching them would cost,
and — the part that decides whether the number survives a funder — how to defend
it. The data and arithmetic live in the `connect_labs` MCP; this skill is what
the MCP cannot hold: which question to ask, how to read the answer without
overclaiming, and how to turn it into the artifacts a funding conversation needs.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| The request | indicator, threshold(s), country scope | the query itself |
| Connect Labs MCP | `targeting_indicators` | indicator family, unit, which methods can answer |
| Connect Labs MCP | `targeting_select` | totals, ranked areas, honesty fields |
| Connect Labs MCP | `targeting_methodology` | provenance, cross-checks, method spread |
| Phase 1 (optional) | `1-design/idea-to-pdd.md` | intervention, unit cost and pricing basis |

## Products

- `<phase>/target-geographies_summary.md` — the three-paragraph write-up
- A Google Doc of the same, via `drive_create_doc_from_markdown`
- `<phase>/<country>-targeting-model.xlsx` — the ranked model, via `drive_upload_binary`

## Process

1. **Establish the indicator's family and unit before anything else.** Call
   `targeting_indicators`. A **burden** measure (under-5 mortality, stunting,
   malaria prevalence) is worse when high and selects places *above* the
   threshold. A **coverage** measure (sanitation, ORS, immunisation, ANC4) is
   worse when low, selects *below*, and the quantity worth funding is the
   **unreached count**, not the coverage rate. Fourteen of the 21 targetable
   indicators are coverage; never assume. Units are not interchangeable either —
   mortality is per 1,000 live births, most other measures are already percent,
   so 8% mortality is a threshold of 80 while 50% sanitation is a threshold of 50.
2. **Check which methods can answer this indicator.** IGME publishes mortality
   only and cannot answer 14 of the 21. `targeting_indicators` lists per-method
   country counts; a method with 0 countries returns an empty answer.
3. **Run `targeting_select`** for each threshold of interest, scoping with
   `iso_codes` when the question names countries.
4. **Read the honesty fields before quoting any total.** `coverage` says how many
   selected units carry each count — short of the total means the figure is a
   **floor, not a measurement**, and must be described that way. `off_method_units`
   counts units answered by a source the method does not declare, inherited from a
   coarser unit; a high value means the selection is a national figure repeated
   across regions. `countries_unsupported` lists countries left out rather than
   answered at another level.
5. **Cost it with `targeting_scenario` when the question involves money.** A unit
   price is meaningless without a unit of measure, and the basis is a property of
   the programme: KMC per newborn, a bednet per child, a water connection per
   household. Where an indicator implies no case count the per-case basis is
   refused rather than approximated — pick another basis, do not work around it.
6. **Fetch `targeting_methodology` before writing anything a funder reads.** It
   returns the sources with vintages and licences, four computed cross-checks, and
   what every alternative method would have reported.
7. **Write the three paragraphs** (see below), leading the defence with the
   weakest check rather than the strongest.
8. **Produce the Doc and the Excel model** if the answer is going anywhere beyond
   chat.

## MCP Tools Used

**connect_labs** (remote HTTP, PAT auth)
- `targeting_indicators` — built
- `targeting_select` — built
- `targeting_methodology` — built
- `targeting_scenario` — built
- `targeting_admin_levels` — built

**ace-gdrive**
- `drive_create_doc_from_markdown` — built
- `drive_upload_binary` — built

## The three-paragraph pattern

- **For the proposal** — the claim, the figure, the thresholds either side of
   it, and where every input came from with vintage and licence.
- **The internal defence** — the cross-checks, led by the weakest. Label it as
   the section that would normally be cut from a submission; it exists to
   convince ourselves and to survive a challenge.
- **Other methods considered** — what the alternatives report, why this one was
   chosen, which figure a conservative reviewer should use, and what was excluded
   and why.

Always include a **Sources** table with a working URL per input. Take the links
from the methodology's own source table; never invent them.

Two habits carry most of the credibility:

- **Lead with the weakest check.** If the births cross-check reads *worth
  watching*, say so and give the implied accuracy. A reviewer who finds it first
  will not believe the rest.
- **Report the method spread.** It is often wider than any single method's
  internal uncertainty — Nigeria at 8% ranged 4.20M to 6.12M births across
  methods. Where that holds, say plainly that the choice of method moves the
  answer more than the data does, and name the conservative figure.

## The Excel model

A model, not an export: unit cost and pricing basis are input cells and every
cost column is a formula referencing them, so a reader can change an assumption
and watch it propagate. Sheets: **Assumptions** (highlighted inputs),
**Ranked geographies** (eligible list ranked by burden, with cumulative share),
**Threshold comparison**, **Method comparison** (naming the conservative figure),
**Sources & caveats** (links, licences, cross-check verdicts).

`openpyxl` is available in the labs venv. Row values arrive rounded to whole
units, so a column sum can differ from the published total by a few units —
state that rather than letting a reader find it.

## What this cannot answer

- **"How many villages?"** Only where someone has already drawn them. Of 55
  African countries only Rwanda (14,815 *umudugudu*), Madagascar (17,465
  *fokontany*) and Burundi (2,615 *collines*) reach village level; 21 stop at
  ward or district and 25 at district. Check `targeting_admin_levels` before
  promising a count. Detecting villages from building footprints does not
  substitute: tested against Rwanda's register, density clustering produced 806
  or 2,403 clusters from the same buildings depending only on the radius, and in
  Kigali one cluster absorbed 69% of the district. Where no register exists,
  reframe to *"how many delivery units of ~N households"* — well-posed, and what
  a programme actually budgets.
- **Rural vs urban** is definition-dependent, and the definition dominates the
  answer. DEGURBA (UN-endorsed) classes only 17% of Rwanda's villages as rural
  against a national figure near 72%, because Rwanda's density clears DEGURBA's
  urban threshold nearly everywhere. Always state which definition was used.
- **IHME data.** Its non-commercial licence excludes for-profit entities and
  their employees and forbids re-hosting; nobody should register a
  healthdata.org account on a dimagi.com address. Report it as excluded on
  licence grounds and note it may well be better — not that it is worse.

## Mode Behavior

- **Auto:** run the queries, write the summary and artifacts, notify the admin
  group with the headline figure and any check reading *worth watching*.
- **Review:** run the queries and present the three paragraphs plus the
  cross-check verdicts for human approval before creating the Doc or model.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-08-29 | Initial version — Connect Labs `targeting_*` MCP, three-paragraph defence pattern, Excel model, village/DEGURBA limits | ACE team |
