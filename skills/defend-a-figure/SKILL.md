---
name: defend-a-figure
description: >
  Cross-check a targeting figure against outside data and write its defence. Use
  before a number reaches a funder or a published document.
disable-model-invocation: false
---

# Defend a Figure

A number that computes is not a number that survives. This skill is the step
between having a figure and being willing to publish it: cross-check it against
something outside the system, find out how much of the answer is the method
rather than the data, and write the defence in a form a reviewer can attack.

The discipline it enforces is one rule — **lead with the weakest check**. A
reviewer who finds the soft spot before you name it stops believing the rest of
the document, and they are right to.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Upstream | the selection: indicator, threshold, scope, totals | what is being defended |
| Connect Labs MCP | `targeting_methodology` | sources with vintages and licences, four computed cross-checks, every alternative method's answer |
| Connect Labs MCP | `targeting_research` | known traps, prior validations, what was rejected and why |
| External | WHO, national statistics, World Bank | the outside figure to check against |

## Products

- `<phase>/defend-a-figure_summary.md` — the three paragraphs
- A **Sources** table with a live URL per input, taken from the methodology's
  own source table
- A named conservative figure, where the methods disagree

## Process

1. **Fetch `targeting_methodology` for the exact selection being defended.** Not
   a similar one. The cross-checks are computed against the selection's own
   rows, so a figure defended against a neighbouring query is undefended.
2. **Read the honesty fields first.** `coverage` short of the total means the
   figure is a floor and must be worded as one. A high `inherited_units` means
   a national figure has been repeated across regions and the subnational
   framing is a fiction. `countries_unsupported` names who was left out.
3. **Read the four computed cross-checks and rank them by how badly they read.**
   Whichever is worst goes first in the defence paragraph. A verdict of *worth
   watching* is not a failure — it is the sentence that makes the rest credible.
4. **Check against something outside the system.** The system cross-checking
   itself proves consistency, not correctness. For malaria that is the WHO World
   Malaria Report; for mortality, IGME's national series; for population, a
   national statistical office. State the gap as a percentage, and state which
   direction it runs.
5. **Report the method spread.** Run the same selection under every method that
   can answer and quote the range. This is frequently wider than any single
   method's own uncertainty — Nigeria at 8% under-5 mortality ranged 4.20M to
   6.12M births. Where that holds, say plainly that the choice of method moves
   the answer more than the data does, and name the figure a conservative
   reviewer should use.
6. **Read the research notes for known traps** with `targeting_research`. Check
   `trust` before using anything a note says: `drifted` means re-derive,
   `unverified` means it is a lead. An age-band mismatch or a definitional
   difference that a note already records is exactly the thing a reviewer will
   find.
7. **Write the three paragraphs**, then check every claim in them against a
   field you actually read rather than one you remember.
8. **Build the Sources table from the methodology's own source list.** Never
   invent a URL. A dead or wrong link in a proposal costs more credibility than
   the figure it was supposed to support.

## MCP Tools Used

**connect_labs** (remote HTTP, PAT auth)
- `targeting_methodology` — built
- `targeting_research` — built
- `targeting_select` — built (re-run per method for the spread)

## The three paragraphs

- **For the proposal.** The claim, the figure, the thresholds either side of it,
  and where every input came from with vintage and licence. Written to be
  quoted.
- **The internal defence.** The cross-checks, weakest first, with the external
  comparison and its gap. Label it as the section normally cut from a
  submission: it exists to convince ourselves and to survive a challenge.
- **Other methods considered.** What the alternatives report, why this one was
  chosen, which figure a conservative reviewer should use, and what was excluded
  and why — with licence exclusions stated as licence exclusions, never as
  quality judgements.

## What a good defence sounds like

> MAP puts Africa at 241.9M *P. falciparum* cases against the WHO World Malaria
> Report's ~246M, inside 2%. Deaths are the weaker half: 646,000 against WHO's
> ~569,000, about 13% high. That gap is a disagreement between two modelling
> groups rather than an error in our aggregation — our regional sums reconcile
> exactly to the national totals — but a reviewer working from WHO figures will
> see a different death count, and the conservative number to quote is WHO's.

Note what it does: names the weak half, quantifies it, says what it is *not*,
and hands the reviewer the conservative figure before they ask.

## Mode Behavior

- **Auto:** run the checks, write the defence, notify the admin group with the
  headline figure and any check reading *worth watching* or worse.
- **Review:** present the cross-check verdicts, the method spread and the draft
  paragraphs for approval before anything is published.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-08-29 | Initial version — weakest-check-first rule, external validation step, method spread, three-paragraph pattern | ACE team |
| 2026-09-01 | `off_method_units` became `inherited_units` | ACE team |
