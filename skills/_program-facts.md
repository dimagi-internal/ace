# Canonical program facts — shared across every prose-producing skill

Facts that **more than one artifact asserts**. A work order, a manager guide, an FAQ, a
quick reference card and a training deck all describe the same program to the same people, so
each of these has exactly one correct value per run and every document must carry that value.

This file exists because they did not. On `tekzal/20261013-2314` the partner's Round 1 review
found ACE's own outputs disagreeing on facts they would have acted and spent money on, and said
so plainly:

> *"What stops us is that the outputs disagree with each other on things we would act and spend
> on. The sharpest is who pays the field worker."*

> *"Check the generated outputs against each other before release… One comparison pass would
> have caught every one."*

The structural cause: **every per-skill `-eval` judges its own artifact in isolation**, and
`opp-eval` aggregates verdicts rather than content. Every check was vertical — artifact against
PDD. None was horizontal — artifact against artifact. A document can therefore be individually
correct and collectively wrong, which is what shipped.

This is the same failure class as [`_terminology.md`](./_terminology.md), one level up: that file
fixes what we *call* things, this one fixes what we *claim* about them.

## Invariants — true on every run, never re-derived per opportunity

### Payment flows Dimagi → partner → FLW. Always.

**Dimagi pays the partner organization. The partner pays the Frontline Worker. The partner then
uploads payment details into Connect.** There is no exception: **Dimagi never pays an FLW
directly**, and no artifact may say or imply that it does.

Retired wording, which must never be generated again — it was in the Round 1 work order while all
four training documents said the opposite:

- ❌ "FLW payments are disbursed through Connect directly to the FLW"
- ❌ anything making Dimagi the party that processes a worker payment
- ✅ "Dimagi pays {partner}. {partner} pays each Frontline Worker and records the payment in Connect."

Connect does not move money. Reference:
`https://dimagi.atlassian.net/wiki/spaces/connectpublic/overview`

The partner reasonably treated the contract as authoritative over the training, so this one
disagreement decided who they believed had to fund the float.

### Test submissions are never payable

A record submitted while testing or practising with the app is **recorded but never payable**, and
does not count toward a worker's delivery cap. Operator ruling 2026-11-25.

Say **"not payable"**. Never "Connect does not pay for these" — Connect does not move money at all,
so phrasing it that way implies it pays for the others, which contradicts the payment flow above.

Round 1 asserted this two ways: the PDD said review data "is not paid" while the work order
carried no carve-out at all, so a conforming test submission auto-approved, paid GHS 7 to the
worker and GHS 4 to the partner, and consumed one of the 20 per-worker slots.

### Consent comes before any question

Consent precedes **every** question, including what the seller sells, and before any photograph.
A quick reference card that asks what she sells at step 2 and reads consent at step 4 contradicts
its own "never ask before she says yes" rule — and it is the card carried to the stall.

### A contingent later phase is not "a separate engagement"

When a later phase sits inside the same contract, in the same period and against the same cap, it
is **contingent Phase B**. Reserve "separate" for work that genuinely needs its own work order.
Three of five Round 1 documents got this wrong.

### Translation is the partner's responsibility

ACE does not supply, standardize or commission local-language scripts. Artifacts state plainly
that interpreting or translating worker-facing material into local languages is the partner's
responsibility, and that the partner may translate the English text and hand a document to each
worker. Say it rather than leaving it unsaid — the gap is what the partner noticed.

### Approvals are generic and partner-owned

Never name a specific permission, authority, fee or lead time. The partner holds the local context
and owns the approval process. One line, everywhere:

> "Take all required approvals from respective authorities for smooth deployment."

Naming a permission no local authority issues is worse than saying nothing, and it is what Round 1
did.

### No device or camera guidance in partner-facing artifacts

No handset recommendation, no camera specification, no HDR/filter/scene-mode instruction. The only
capture control is **live photo only, no gallery upload**, and it is enforced in the app build, not
asserted in prose.

## Per-run facts — one value, agreed once, carried everywhere

These vary by opportunity. Each is settled in the PDD and every later artifact reads it from there.

| Fact | Must agree across |
|---|---|
| Worker cap (maximum FLWs) | work order, manager guide, deck |
| Per-worker delivery cap | work order, manager guide, FAQ, deck |
| Campaign total | work order, manager guide, deck |
| The payment conditions — **the full list, same count everywhere** | work order, manager guide, FAQ, FLW guide, quick reference, deck |
| Work timing window | work order, opportunity, all worker-facing material |
| Minimum submission duration | work order, opportunity, all worker-facing material |
| Visit duration target **and** floor | work order, manager guide, deck |
| Support address and reply-time commitment | work order, manager guide, FAQ |
| The name of each captured field | app, work order, manager guide, training |

### Three rules that govern the table

**Same count, not just same content.** Round 1's training closed the payment test at four
conditions where the contract set five. A worker taught four tests has been taught that the fifth
does not affect her pay.

**The caps must multiply out.** Worker cap × per-worker cap must cover the campaign total, and the
worker cap has to reach the person doing the onboarding. A coordinator who never saw a five-worker
cap can onboard ten and promise double the ceiling.

**One name per field.** A field called `stock` in training and `availability` in the manager guide
and the work order is two fields to the person reading, and its answer options must be published
somewhere a worker can be taught them.

## What a producer must do

Any skill writing an artifact that asserts one of these:

1. Read the settled value from the PDD. Do not re-derive it, and do not infer it from another
   artifact — that is how drift starts.
2. If the PDD does not settle it, **propose a value in the PDD for human confirmation** rather than
   deciding silently in a downstream document. On a run that needs no PDD review, proceed with the
   proposed value.
3. Never restate an invariant above in different words. Copy the wording.

## Enforced by

- `test/skills/program-facts.test.ts` — requires every prose-producing skill to link this file, and
  checks the contract still states the rules it is linked for.
- `skills/reconcile-outputs` — the horizontal pass. Reads a run's generated artifacts and reports
  any fact asserted two ways. Runs before release.

## Related

- [`_terminology.md`](./_terminology.md) — what we call things
- [`pdd-to-work-order/references/writing-style.md`](./pdd-to-work-order/references/writing-style.md) — voice and style
- [`README.md`](./README.md) — skills index
