---
name: cost-effectiveness
description: >
  Say what a round of spend BUYS in a place — deaths averted, cost per death,
  the multiple of GiveWell's bar — and defend it. Use when a funder asks "what
  is the expected return", "does this clear GiveWell's bar", or "what does $X at
  $Y a visit buy in <area>", or before a BOTEC goes into a pitch.
disable-model-invocation: false
---

# Cost-effectiveness

`target-geographies` answers *where, how many, and what it costs to reach them*.
A funder's next question is *what does the money buy* — and that is a different
kind of claim. A cost is a price times a count. A return is a **model**: an
effect size borrowed from a trial, a baseline nobody measured this year, and a
moral weight someone chose. This skill is the judgement around that model; the
arithmetic lives in Connect Labs.

## The tool

`targeting_cost_effectiveness` (Connect Labs MCP) runs GiveWell's ORS/zinc chain
(Aug 2023, as applied to CHAI Bauchi) for one area:

- **inputs from the registry, with provenance** — the area's ORS coverage (the
  value the targeting map shows) and its under-5 mortality;
- **diarrhoea mortality is derived, not measured** — GiveWell's Bauchi figure
  (6.34 per 1,000) scaled by the area's U5MR over Bauchi's. Override it when you
  have better;
- returns deaths averted, cost per death, the multiple of the benchmark, the
  **break-even price** for the 6x bar, a price x coverage sensitivity grid, every
  fixed parameter with its source, the **benefits not counted**, and caveats.

The chain is pinned in connect-labs' tests to GiveWell's published Bauchi column
(134.9 deaths per 100k, 20.2x). If a result looks wrong, the inputs are the place
to look, not the chain.

The same tool is behind **"Ask an agent" on `/labs/targeting/`**, so a programme
lead can ask it in the page; the canopy agent there runs it as the visitor.

## Process

1. **Read what was already sent.** If a BOTEC already went to the funder, read it
   first and compare its inputs with the registry's. A funder who finds that your
   "Central" coverage is 11 points below the latest DHS will stop trusting the
   rest. Name the gap before they do — and if the data-anchored answer still
   clears the bar, the gap costs nothing to admit.
2. **Run three scenarios, not one:**

   | Scenario | Coverage | Mortality | Under-5s per household |
   |---|---|---|---|
   | Data-anchored (lead with this) | registry | derived | 1.2 |
   | As already sent (if any) | the doc's | the doc's | the doc's |
   | Pessimistic | registry + ~15 pts (outbreak-era saturation by other actors) | the lower of derived and the doc's conservative | 1.0 |

   Use the tool's overrides for the second and third.
3. **Lead with the weakest input.** Usually that is the derived mortality (an
   assumption that diarrhoea's share of under-5 deaths matches Bauchi's) or a
   coverage figure resting on a small survey sample — the tool's `caveats` names
   both. Cross-check the mortality against the area's diarrhoea prevalence
   (`targeting_select`, `diarrhoea_prevalence`): when prevalence and U5MR ratios
   disagree, say which you used and why.
4. **Quote the break-even price.** "Clears the bar at any price under $5.43 a
   visit" survives an argument about every other input; a point estimate of
   13.0x does not.
5. **Say what is not counted, and why.** Zinc, water treatment, hygiene and
   transmission are excluded, so every figure is a floor on ORS alone. That is a
   strength in the pitch, not a gap — but only if it is said.
6. **Publish as a model, not a number.** Hand off to `build-targeting-model` for a
   Sheet whose cells are live formulas (inputs, the chain, sensitivity), so the
   funder can change the price on the call and watch it propagate.

## What not to claim

- **Disease-specific deaths in an outbreak.** For cholera, ORS-for-cholera deaths
  averted come out tiny (attack rates of ~1% and recorded CFRs of ~0.5% leave a
  20,000-household round averting well under one cholera death). The defensible
  return is **ORS for all under-5 diarrhoea, delivered during an outbreak**. A
  pitch led by "cholera deaths averted" invites exactly the question that sinks
  it.
- **Transmission effects.** Chlorine and hygiene slow spread; valuing that needs a
  dynamic model. IDM's are the candidates — MOSAIC for cholera (40 countries,
  **country-level only**, R), laser-measles / laser-polio for spatial vaccine
  questions, Starsim for the rest — and none is wired into the tool yet. Say the
  benefit is uncounted; never approximate it.
- **Measured impact.** This is a modelled estimate. The uptake gain is a trial
  effect (Wagner et al. 2019) after GiveWell's validity discounts, not a Connect
  measurement. Where a measurement exists or is coming (e.g. the IPA trial of
  Connect CHC's ORS coverage effect in Jigawa, Gombe, Kano and Kaduna), name it
  as what will replace the borrowed number.
- **A lives-saved figure for a round that already happened.** Too small to
  attribute against an outbreak's background.

## Products

- The tool's answer for each scenario, in the conversation or the run folder.
- A short defence: the headline (data-anchored), the weakest input, the
  break-even price, what is not counted.
- Via `build-targeting-model`: the Sheet.

## Modes

- **Auto:** run the three scenarios, write the defence, hand off to
  `build-targeting-model`.
- **Review:** stop after the defence for the operator to confirm the scenarios
  before anything is built.
