---
name: cost-effectiveness
description: >
  Say and defend what a round of spend buys in a place (deaths averted, cost per death, multiple of
  GiveWell's bar): Connect's own programs (the CHC, MBW and KC models, in Labs' cost-effectiveness
  explorer) and malaria PMC. Use when a funder asks the expected return, or before a BOTEC goes into a pitch.
disable-model-invocation: false
---

# Cost-effectiveness

**The method lives in the GiveWell project, not here.** It is the shared skill
`cost-effectiveness` of the canopy workspace project `connect/givewell`, so every agent and
person values Connect programs the same way. Load it and follow it:

```
project_skill "connect/givewell" "cost-effectiveness"
```

(`mcp__plugin_canopy_projects__project_skill`, from the canopy plugin.) It says where each answer
comes from in Connect Labs' cost-effectiveness explorer (`/labs/cea/`): **CEA models**, or the agent tool
`cea_model_run`, for Connect's own programmes (CHC, MBW, KC) at any inputs, with sensitivity over the inputs you
switch on; **Implementations**, or the agent tool `cea_opportunities` (full tokens only), for what delivered
opportunities achieved: any selection by programme, partner, country or model, with its roll-up, and for one
opportunity every step and a link that opens CEA models at that opportunity's own place and price; **Market size**
for what it would cost to reach everyone in chosen places and where a model says it is worth it;
`targeting_pmc_rank` and `targeting_pmc_run_model` for PMC, a one-off linked from Market size. It fixes the inputs from the proposal, runs the scenarios, and says what
is not counted. **There is no ORS tool**: `targeting_cost_effectiveness` was removed on 11 Nov 2026, and
which components count for the Child Health Campaign is the CHC model's own vitamin A and deworming
switches (`va_on`, `dw_on`). The same project holds GiveWell's own models and values (`cea`) and
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
