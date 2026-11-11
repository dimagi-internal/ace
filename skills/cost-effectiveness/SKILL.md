---
name: cost-effectiveness
description: >
  Say and defend what a round of spend buys in a place (deaths averted, cost per death, multiple of
  GiveWell's bar) for malaria PMC, and where to find the answer for Connect's own programs (the CHC,
  MBW and KC models). Use when a funder asks the expected return, or before a BOTEC goes into a pitch.
disable-model-invocation: false
---

# Cost-effectiveness

**The method lives in the GiveWell project, not here.** It is the shared skill
`cost-effectiveness` of the canopy workspace project `connect/givewell`, so every agent and
person values Connect programs the same way. Load it and follow it:

```
project_skill "connect/givewell" "cost-effectiveness"
```

(`mcp__plugin_canopy_projects__project_skill`, from the canopy plugin.) It picks the Connect Labs
tool per intervention (`targeting_pmc_rank` and `targeting_pmc_run_model` for PMC), fixes the
inputs from the proposal, runs the scenarios, and says what is not counted. **There is no ORS
tool.** `targeting_cost_effectiveness` was removed on 11 Nov 2026 (connect-labs #2995): which
components count for the Connect Child Health Campaign (ORS and zinc, vitamin A, deworming) is
decided inside the CHC model, so for ORS-type questions use the CHC model's live Sheet, or the
delivered-opportunity ranking in the cost-effectiveness explorer (`/labs/cea/implementation/`).
PMC and the delivered ranking now value a death the same way (the CHC model's 118.05 units).
If the project's `cost-effectiveness` skill still names `targeting_cost_effectiveness`, that part
is out of date: say so and do not call it. The same project holds GiveWell's own models and values (`cea`) and
the review a figure needs before it goes to GiveWell (`givewell-review`). Change the method there,
never by copying it back into this file.

## In an ACE run

- **Products:** the tool's answer for each scenario, in the run folder; a short defence (the
  headline at the price the funder judges by, the weakest input, what survives an argument, what
  is not counted); for PMC, the `explorer_path` at that price; and the Sheet, via
  `build-targeting-model`, which gets a **Cost-effectiveness** sheet with live formulas.
- **Auto:** run the scenarios, write the defence, hand off to `build-targeting-model`.
- **Review:** stop after the defence for the operator to confirm the scenarios before anything is
  built.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-25 | Method moved to the GiveWell project's shared `cost-effectiveness` skill (connect/givewell); this file keeps ACE's products and modes | Eva |
