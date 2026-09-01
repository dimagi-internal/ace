---
name: target-geographies
description: >
  Select target geographies by burden or coverage and size the reach. Use when
  asked where to intervene or how many people are reachable.
disable-model-invocation: false
---

# Target Geographies

Where an intervention should go, who lives there, and what reaching them would
cost. This is the core query loop of the `targeting-analyst` agent; the
judgement that surrounds it — vetting a new source, defending the number,
producing the artifacts — lives in its sibling skills, and this one hands off
rather than half-doing them.

The data and arithmetic are in the Connect Labs `targeting_*` MCP tools. What
this skill carries is what those tools cannot: which question to ask, and how to
read the answer without overclaiming.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| The request | indicator, threshold(s), country scope | the query itself |
| Connect Labs MCP | `targeting_research` | what is already known about this indicator's sources and traps |
| Connect Labs MCP | `targeting_indicators` | indicator family, unit, which methods can answer |
| Connect Labs MCP | `targeting_select` | totals, ranked areas, honesty fields |
| Connect Labs MCP | `targeting_scenario` | cost basis and total |
| Phase 1 (optional) | `1-design/idea-to-pdd.md` | intervention, unit cost and pricing basis |

## Products

- `<phase>/target-geographies_summary.md` — the selection, its totals, and every
  caveat the honesty fields raised
- A handoff to `defend-a-figure` before any figure is published

## Process

1. **Read what is already known.** `targeting_research` for the indicator, first
   and always. It returns prior findings with each claim re-run against live
   data. Read `trust` before using anything: `holds` means the note describes
   reality now, `drifted` means re-derive whatever the failed checks cover,
   `unverified` means the note is a lead rather than a finding. If `rescan_due`
   is set, say so and ask the user whether to run `scan-data-sources` — the
   checks confirm what we found, they cannot tell you whether something better
   has since been published.
2. **Establish the indicator's family and unit.** Call `targeting_indicators`. A
   **burden** measure (mortality, stunting, malaria incidence) is worse when
   high and selects places *above* the threshold. A **coverage** measure
   (sanitation, ORS, immunisation, ITN use, effective treatment) is worse when
   low, selects *below*, and the fundable quantity is the **unreached count**,
   not the rate. More than half of the 29 targetable indicators are coverage
   measures — never assume. Units are not interchangeable either: mortality is per 1,000
   live births, so 8% is a threshold of 80, while 50% sanitation is 50.
3. **Check which methods can answer it.** `targeting_indicators` lists per-method
   country counts. IGME publishes mortality only; MAP's surfaces answer malaria
   only; DHS answers what it surveyed. A method showing 0 countries returns an
   empty answer, which reads exactly like "no burden here".
4. **Run `targeting_select`** for each threshold of interest, scoping with
   `iso_codes` when the question names countries.
5. **Read the honesty fields before quoting any total.** `coverage` says how many
   selected units carry each count — short of the total means the figure is a
   **floor, not a measurement**, and must be worded that way. `inherited_units`
   counts units whose rate was measured somewhere coarser — usually their
   country — and applied here; a selection that is mostly inherited is a
   national figure repeated across regions, not a subnational finding.
   `countries_unsupported` names who was left out rather than answered at
   another level.
6. **Cost it with `targeting_scenario`** when money is in the question. A unit
   price is meaningless without a unit of measure, and the basis is a property of
   the programme: KMC per newborn, a bednet per child, a water connection per
   household, an antimalarial per case. Where an indicator implies no case count
   the per-case basis is refused rather than approximated — pick another basis.
7. **Hand off before publishing.** `defend-a-figure` for anything a funder will
   read; `build-targeting-model` for a Doc and model. Do not shortcut either.
8. **Write back anything new you learned** with `targeting_research_write`,
   especially a trap or a rejected source. The next session should not have to
   find it again.

## MCP Tools Used

**connect_labs** (remote HTTP, PAT auth)
- `targeting_research` — built
- `targeting_research_write` — built
- `targeting_indicators` — built
- `targeting_select` — built
- `targeting_scenario` — built
- `targeting_admin_levels` — built

## What has counts, and why it matters

Most indicators here are rates, and a rate cannot answer "how many cases would we
be treating" — the per-case cost basis is refused rather than faked. Four
families escape that, and they are what to reach for when a programme has to be
*sized* rather than merely located:

| Count | From | Answers |
|---|---|---|
| `malaria_cases`, `malaria_deaths` | MAP 5 km surfaces, annual to 2024 | how much disease, per year |
| `antimalarial_effective_gap` | cases x (1 - effective treatment) | **untreated cases** — its denominator is a case count, not a population |
| `pop_beyond_2h` | Weiss et al. travel time x WorldPop | people further than two hours' walk from care |
| `pop_rural` | DEGURBA x WorldPop | rural population, by the UN-comparable definition |

Continental figures, for scale: 241.9M malaria cases and 116.9M of them
untreated; 242.9M people beyond two hours' walk; 745.2M rural.

## What this cannot answer

- **"How many villages?"** Only where somebody has already drawn them: of 55
  African countries, three reach village level — Rwanda (14,815 *umudugudu*),
  Madagascar (17,465 *fokontany*), Burundi (2,615 *collines*). Twenty-one stop at
  ward, twenty-five at district. Check `targeting_admin_levels` first. Detection
  from building footprints does not substitute: tested against Rwanda's register,
  the same buildings yield 68 or 2,403 clusters for one district depending only
  on the radius, and in Kigali one cluster absorbed 69% of the district. Where no
  register exists, reframe to *"how many delivery units of ~N households"* — well
  posed, and what a programme actually budgets.
- **Rural vs urban**, without naming the definition. DEGURBA classes 17% of
  Rwanda's villages as rural against a national figure near 72%. Both are
  defensible; a number quoted without its definition is not.
- **Anything from IHME.** Its non-commercial licence excludes for-profit entities
  and their employees and forbids re-hosting; nobody should register a
  healthdata.org account on a dimagi.com address. Report it as excluded on
  licence grounds, and note it may well be better — not that it is worse.

Each of these is recorded as a research note, so `targeting_research` returns the
current version rather than this file's.

## Mode Behavior

- **Auto:** run the queries, write the summary, hand off to `defend-a-figure`,
  notify the admin group with the headline figure and any honesty-field caveat.
- **Review:** present the selection, its totals and its caveats for approval
  before costing or handing off.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-08-29 | Initial version — burden/coverage families, honesty fields, village and DEGURBA limits | ACE team |
| 2026-08-29 | Split defence and deliverables into sibling skills; research-note read is now step 1; 26 indicators; MAP counts | ACE team |
| 2026-08-29 | 29 indicators; countable families now include access (`pop_beyond_2h`) and settlement (`pop_rural`), not malaria alone | ACE team |
| 2026-09-01 | `off_method_units` became `inherited_units` — a source a method does not declare is no longer used at all, so what remains to report is how much was inherited | ACE team |
