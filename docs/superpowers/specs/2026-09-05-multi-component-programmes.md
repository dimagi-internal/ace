# Spec — multi-component programmes

**Date:** 2026-09-05 · **Status:** proposed, not started · **Opp:** `poverty-graduation`
**Origin:** Jon, 2026-09-05 — *"I think we need to update ACE to be most sophisticated so
that we understand a multi-component system like this, this is the first time we've had
something of this complexity."*

## The crux, in one line

**ACE authors ONE design from raw material. Sophie brings a design that is already N designs.**

Everything below follows from that inversion. Phase 1's contract is *"synthesize a PDD from
whatever the human curated into `inputs/`"*; what is now in `inputs/` is a framework plus one
authored PDD per component, each specifying its own component and all of them keyed off a
shared case-and-state model. Pointed at that today, ACE flattens it.

## What actually breaks, verified not assumed

| # | Gap | Evidence |
|---|---|---|
| 1 | **Phase 1's output is singular.** One PDD per run. | `run_state.phases.idea-to-design.products.pdd` = `{title, description, file_id}`; `idea-to-pdd` is "the sole writer" |
| 2 | **No component identity anywhere in run_state.** | Nothing downstream can name `enrollment`, so nothing can verify its module exists, toggle it, or attribute a defect to it |
| 3 | **No home for the shared case-and-state model.** | The framework's identity / enrollment-gate / concurrent-tracks / graduation state and its seam list have no artifact and no reader — yet every component keys off it |
| 4 | **No concept of a *model*.** | The framework's "Components by model" table says a model = which components are on, plus per-component variants. ACE builds one app from one PDD |
| 5 | **Learn is one app from one PDD.** | Her Learn PDD specifies foundations + one module per component *that has a PDD*, gated to the model's active components. `pdd-to-learn-app` reads the single PDD |
| 6 | **Cross-component seams are unrepresented.** | Enrollment sets `enrolled`, which gates everything downstream; monitoring gates asset-transfer round two. Nothing expresses "A writes what B reads", so nothing can check it |
| 7 | **Evaluation averages across components.** | `-eval` skills grade one PDD / one app. A good enrollment module hides a broken consumption one |

Gap 2 is the load-bearing one. Once a component is addressable, most of the rest becomes
ordinary iteration over a list.

## Three shapes, and a recommendation

**A — component as a first-class run_state entity.** `products.components[]` of
`{key, name, pdd_file_id, status, verdict}`, plus `products.framework` (the case model) and
`products.model` (which components are on). Downstream phases iterate. Largest change, and the
only one that makes gaps 2, 5, 6 and 7 tractable rather than worked around.

**B — one PDD with typed component sections.** Keep `products.pdd` singular; require a
per-component section schema and have skills address components by section. Small change. But
synthesis re-flattens on every run and section-parsing is exactly the fragility ACE has been
removing elsewhere.

**C — one opp per component plus a composing programme opp.** Reuses everything ACE has. But
Connect wants ONE opportunity per programme, and cross-component case state would span opps,
which run independence explicitly forbids.

**Recommendation: A, staged.** B buys a fortnight and then has to be redone once anyone asks
"did enrollment's training requirements actually become a module?" — which is precisely what
Sophie has asked to test first.

## Staging, so the build is not blocked on all of it

**Stage 1 — ingest, don't synthesize.** Phase 1 gains a mode where an authored component set
is *ingested* (framework + one PDD per component, each validated as a component) rather than
synthesized into one document. Writes `products.framework` + `products.components[]`.
**This alone unblocks the `poverty-graduation` build**, and it is the smallest change that
stops flattening.

**Stage 2 — Learn from the component set.** Foundations module + one module per component
*with a PDD*; every framework component *without* one listed in the build memo as a gap. This
is the structure Sophie asked to exercise before another seven PDDs are written against it.

**Stage 3 — models and seams.** A model selects components; a seam declares
"component A writes property P, component B reads it," and the build fails loudly when a
declared reader has no writer.

**Stage 4 — per-component evals.** A verdict per component, and a rollup that cannot hide a
failing component inside an average.

## Two platform facts the design should build on, now established

Both were open questions on this thread, both settled by throwaway builds this week:

- **A household can belong to two groups at once** — two *named* child indices, proven through
  the HQ build and install gate. So two case types (VSLA, business) is viable and dual
  membership is not a reason to collapse them. See
  `docs/learnings/2026-09-02-household-dual-group-membership.md`.
- **A group case can carry a running ledger** — hidden `calculate` + `caseWrite`, with the
  property read coerced via `number()` because a case property reads as **text**, and a
  followup form because a survey form has no case context. See
  `docs/learnings/2026-09-04-vsla-group-running-ledger.md`. Its concurrency caveat (two
  offline workers on one group overwrite rather than add) is a **design input for Stage 3**,
  not a platform defect.

## Amendment, 2026-09-05 — components are a LIBRARY, opps are the programmes

Jon, after the first draft:

> *"you should design it thinking we are going to have several opps that re-use as
> possible but will be turning on and off different components depending on that
> specific pov grad program."*

This answers open question 2 below, and more sharply than it was asked. A *model* is
not a per-run or a per-opp field on a single programme — **each opp IS a povgrad
programme**, and what is shared across them is the component set itself.

So the shape is two-layer:

- **A component library**, authored once and reused: the framework plus one PDD per
  component. It does NOT belong inside any one opp's `inputs/`, which is where this
  spec's first draft would have put it.
- **An opp = one programme = a selection from that library**, plus per-component
  variants. Component 7 built for a Kaduna-shaped programme and for a
  classic-graduation-shaped one are the same component with different settings, not
  two components.

Consequences for the staging above:

1. **Stage 1 changes location, not mechanism.** Ingest still replaces synthesis, but
   the component set is resolved from the shared library and the opp records *which
   components it selected*. Building Stage 1 against one opp's `inputs/` would have to
   be undone at the second programme.
2. **`ACE/_common/` is the natural home** for the library — it already exists at the
   ACE root for exactly this class of cross-opp material.
3. **Shortcuts are load-bearing, not a convenience.** `poverty-graduation/inputs/`
   already holds Drive shortcuts to the live component documents rather than copies
   (verified 2026-09-05: `drive_read_file` on a shortcut returns the target's content
   and revision). That is what lets N programmes share one component set and all stay
   current — the mechanism the library needs, reached before the requirement was
   stated.
4. **Selection needs a default, not a blocking question.** The first programme does not
   have to declare a model: Stage 2's rule — build a module for every component that
   *has* a PDD — is a well-defined default. Selection becomes a real input at the
   SECOND programme, which is when to ask for it rather than now.

**The author already designed for this.** The Learn PDD's framing note: *"a given model
shows the foundations module and the modules for the components it turns on, and hides
the rest, the same on/off logic as the Deliver side."* The gap is ACE's, not the
design's.

**Scope discipline, same conversation:** *"We are in a weird state a bit as we're still
just trying to get ACE to fundamentally work."* Build Stages 1–2 and the library
resolution. Do NOT build the full model/variant matrix, per-component overrides, or a
selection UI yet — a default plus a recorded selection is enough until a second
programme exists to disagree with it.

## Open, and genuinely the human's call

1. **Stage 1 only, or Stages 1–2 before the first build?** Stage 1 unblocks a build; Stage 2 is
   what makes that build test what Sophie actually asked about. Recommendation: 1–2.
2. ~~Is a "model" per-run or per-opp?~~ **ANSWERED** — see the amendment above. Neither: each
   opp is a programme, and the component set is a shared library above them.
3. **Does the targeting survey stay a component of this programme** (assumed yes — the
   framework lists it as Component 2), or remain the separate deliverable it is today in
   `hh-poverty-targeting`?

## Not in scope

Rebuilding `hh-poverty-targeting`. It stays a finished single-component programme; this spec
does not migrate it, and its 13 runs stay comparable to each other.
