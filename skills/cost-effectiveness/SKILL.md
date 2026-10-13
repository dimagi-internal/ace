---
name: cost-effectiveness
description: >
  Say what a round of spend BUYS in a place — deaths averted, cost per death,
  the multiple of GiveWell's bar — and defend it, for any intervention Connect
  Labs can value: ORS/zinc for diarrhoea, and perennial malaria chemoprevention
  (PMC: which schedule, which states). Use when a funder asks "what is the
  expected return", "does this clear GiveWell's bar", "which states and which
  schedule", or "what does $X at $Y a visit buy in <area>", or before a BOTEC
  goes into a pitch.
disable-model-invocation: false
---

# Cost-effectiveness

`target-geographies` answers *where, how many, and what it costs to reach them*.
A funder's next question is *what does the money buy* — and that is a different
kind of claim. A cost is a price times a count. A return is a **model**: an
effect size borrowed from a trial or a simulation, a baseline nobody measured
this year, and a moral weight someone chose. This skill is the judgement around
that model; the arithmetic lives in Connect Labs, one tool per intervention.

## Pick the tool for the intervention

| Intervention | Tool (Connect Labs MCP) | What it values |
|---|---|---|
| ORS/zinc for under-5 diarrhoea | `targeting_cost_effectiveness` | GiveWell's ORS chain for one area |
| Perennial malaria chemoprevention (PMC, SP) | `targeting_pmc_rank` | every state × schedule in Nigeria, from IDM's EMOD fitted per state |
| A PMC schedule the grid does not hold (other months, ages, coverage) | `targeting_pmc_run_model` then `targeting_pmc_run_status` | one live EMOD run in one state (about five minutes) |

Anything else has no valuation tool yet: say so, and do not borrow another
intervention's chain. The method below is the same whichever tool answers.

## Method (every intervention)

1. **Fix the inputs from the proposal, then say which you fixed.** Ages, price
   (GiveWell judges a pilot at its **at-scale** price, so lead with that and show
   launch beside it), the places the proposal allows or excludes. An answer at
   the tool's default price is a different answer; name the price in every
   figure.
2. **Read what was already sent.** If a BOTEC or proposal already went to the
   funder, read it and compare its inputs with the registry's. Name a gap before
   the funder finds it — if the data-anchored answer still clears the bar, the
   gap costs nothing to admit.
3. **Run more than one scenario.** The data-anchored one leads; the as-sent one
   (if any) and a pessimistic one sit beside it. Each tool's overrides and
   inputs say how (below).
4. **Lead with the weakest input.** Each tool's `caveats` names it. Say which
   value you used and why.
5. **Quote what survives an argument.** A break-even price, or "clears the bar
   on either estimate alone", outlives a dispute about one input; a single point
   estimate does not.
6. **Say what is not counted, and why.** Every tool here counts deaths only, so
   every multiple is a floor. That is a strength in the pitch — but only if it is
   said.
7. **Publish as a model, not a number.** Hand off to `build-targeting-model` for
   a Sheet whose cells are live formulas, so the funder can change the price on
   the call and watch it propagate.

## ORS/zinc — `targeting_cost_effectiveness`

Runs GiveWell's ORS/zinc chain (Aug 2023, as applied to CHAI Bauchi) for one
area: the area's ORS coverage and under-5 mortality from the registry, with
provenance; diarrhoea mortality **derived** (GiveWell's Bauchi 6.34 per 1,000,
scaled by the area's U5MR over Bauchi's) — override it when you have better.
Returns deaths averted, cost per death, the multiple of the benchmark, the
**break-even price** for the 6× bar, a price × coverage grid, every fixed
parameter with its source, the benefits not counted, and caveats. The chain is
pinned in connect-labs' tests to GiveWell's published Bauchi column (134.9 deaths
per 100k, 20.2×): if a result looks wrong, look at the inputs.

| Scenario | Coverage | Mortality | Under-5s per household |
|---|---|---|---|
| Data-anchored (lead with this) | registry | derived | 1.2 |
| As already sent (if any) | the doc's | the doc's | the doc's |
| Pessimistic | registry + ~15 pts (outbreak-era saturation by other actors) | the lower of derived and the doc's conservative | 1.0 |

Weakest input: usually the derived mortality, or a coverage figure on a small
survey sample. Cross-check mortality against the area's diarrhoea prevalence
(`targeting_select`, `diarrhoea_prevalence`). Not counted: zinc, water
treatment, hygiene and transmission — every figure is a floor on ORS alone.

## PMC — `targeting_pmc_rank`

Ranks every (state, schedule) pair by cost per under-5 death averted. Each state
is IDM's EMOD fitted to its own DHS prevalence and rainfall season; ten
schedules (quarterly, every two months, 4/6/8 monthly rounds from the rains,
monthly all year; 3–24 months or 12–24 only). It returns a `recommendation`
(one schedule for the states — what a trial arm needs), `tailored` (each state on
its own best), `versus_quarterly`, `step_up`, `budget_plans`, `by_design`, and
an `explorer_path` that opens the PMC page on the same states and price.

- **States.** Pass the proposal's states, or every state where seasonal malaria
  chemoprevention (SMC) does not run, less any the proposal excludes. The answer's
  `smc` names each state in the selection where SMC already runs (statewide or some
  LGAs, sourced); leave those out and say why — PMC there would be valued as if no
  chemoprevention ran. Apply no rainfall or prevalence cutoff: the ranking and the
  bar drop low transmission on their own.
- **The card.** When the visitor is choosing states (not on the PMC page itself),
  call `targeting_pmc_states` so they get the candidate-states card to tick and
  open; then point to it in one line rather than repeating its numbers.
- **Price.** `cost_per_visit` defaults to the launch price ($0.80, $1.01 a dose).
  Pass the at-scale price when the funder judges at scale, and make sure the
  `explorer_path` you give carries it.
- **Deaths: the lower of two estimates decides.** DHS-scaled and MAP disagree
  more than threefold in places, so each state counts its lower one, and every
  figure carries `by_basis` with each alone. Quote both beside the deciding
  figure. A total on the lower estimate sits *below* both one-estimate totals —
  that is the rule working, not an error; say it before someone asks.
- **Compare schedules on equal footing.** Across all states a weak schedule is
  dragged down by the states where it has no measurable effect; in its own best
  four states it can look respectable. Show both when the comparison is the
  point (e.g. the proposal's quarterly design against monthly rounds).
- **Scenarios:** at-scale and launch price; the recommended schedule and the
  proposal's; one schedule for all states and each state's own best.
- **Weakest inputs:** one fitted setting per state is not a calibration (every
  figure is illustrative); mortality is assumed to fall with clinical cases; SP
  resistance is not modelled.
- **Not counted:** cases, anaemia and admissions — deaths only, so a floor.

## What not to claim

- **A modelled multiple as a measured one.** Every figure here is a model:
  borrowed trial effects (ORS) or a fitted simulation (PMC). Where a measurement
  exists or is coming (e.g. the IPA trial of Connect CHC's ORS coverage effect),
  name it as what will replace the borrowed number.
- **Disease-specific deaths in an outbreak.** For cholera, ORS-for-cholera
  deaths averted come out tiny. The defensible return is **ORS for all under-5
  diarrhoea, delivered during an outbreak**.
- **Transmission effects.** Chlorine and hygiene slow spread; valuing that needs
  a dynamic model (IDM's MOSAIC for cholera, laser-measles / laser-polio,
  Starsim) and none is wired into a tool yet. Say the benefit is uncounted;
  never approximate it.
- **A PMC answer for a seasonal state.** The fitted grid covers PMC; in the
  seasonal north SMC is the standard, and `targeting_pmc_run_model` refuses a
  state it cannot speak for. Say why; do not work around it.
- **A lives-saved figure for a round that already happened.** Too small to
  attribute against the background.

## Products

- The tool's answer for each scenario, in the conversation or the run folder.
- A short defence: the headline (data-anchored, at the price the funder judges
  by), the weakest input, what survives an argument, what is not counted.
- For PMC, the `explorer_path` link at that price, so the funder can see it.
- Via `build-targeting-model`: the Sheet.

## Modes

- **Auto:** run the scenarios, write the defence, hand off to
  `build-targeting-model`.
- **Review:** stop after the defence for the operator to confirm the scenarios
  before anything is built.
