# Canonical terminology — shared across every prose-producing skill

Naming rules that apply to **every artifact ACE generates for a human**: PDDs,
work orders, training decks, training guides, FAQs, onboarding emails,
solicitations, LLO correspondence, deck speaker notes.

This file exists because the rules kept being re-derived per skill. The
platform-name rule below lived only in
[`pdd-to-work-order/references/writing-style.md`](./pdd-to-work-order/references/writing-style.md)
and was enforced only by `pdd-to-work-order-eval`, so work orders said
"Connect" while the FLW training deck's opening slide asked "What is CommCare
Connect?" — the first thing a Frontline Worker ever read from us used a name
we had already retired everywhere else.

`writing-style.md` remains the fuller voice-and-style guide (modal verbs,
partner naming, sentence patterns) and its terminology table is still
authoritative for work-order prose. What is here is the subset that binds
**all** producers.

## The platform is "Connect"

**Always `Connect`. Never `CommCare Connect`.**

You will see "CommCare Connect" in source code, in older internal documents,
in upstream repo names and in some Nova prompts. None of that licenses it in a
generated artifact. Prefer the bare product name on every reference, including
the first one — there is no "spell it out on first use" exception here, because
the long form is not an expansion, it is a retired name.

| Preferred | Avoid |
|---|---|
| Connect | CommCare Connect |
| the Connect app, the Connect platform | the CommCare Connect app |
| a Connect opportunity | a CommCare Connect opportunity |

### What this rule does NOT touch

`CommCare` on its own is a **different, live product**, and the training deck
legitimately walks an FLW through installing it. Do not "correct" these:

- **CommCare** — the mobile app the FLW downloads from the Play Store
- **CommCare HQ** — the web platform apps are built and deployed on
- **a CommCare app** — a Learn or Deliver app, the thing Nova builds
- **CommCare Connect markers** — the code-level concept naming
  `<learn:deliver>` / `<learn:module>` / `<learn:assessment>`. This names a
  marker set, not the platform, and Nova's prompt behaviour is tuned to the
  phrase. Leave it in `pdd-to-learn-app`, `pdd-to-deliver-app`,
  `app-connect-coverage`, `_app-component-library` and `_qa-decisions`.
- **`dimagi/commcare-connect`**, `commcare_connect` — repo and identifier
  names. Never rewrite an identifier to satisfy a prose rule.

The test that enforces this scopes itself to `templates/` for exactly that
reason: template content is prose that reaches a human, so the phrase is always
wrong there, while a skill file may legitimately name the code concept.

### Dated records are not corrected

Do not rewrite `docs/learnings/**` or a dated file under
`docs/superpowers/{plans,specs}/**` to satisfy this rule. Those record what was
true and said at a point in time; editing them to match today's naming
falsifies the record. They are deliberately left carrying the old name.

## Naming drift in the source material

The public help site (see
[`templates/training-deck/_common/connect-wiki-map.yaml`](../templates/training-deck/_common/connect-wiki-map.yaml))
is mid-rename on two concepts, so it is not a reliable authority on either:

- **"Verification Rules (previously Verification Flags)"** — ACE's own API
  field is still `verification_flags`. In LLO-facing prose, follow whatever the
  opportunity's own UI shows that LLO; do not silently adopt one name because
  the wiki used it.
- **"ConnectID" vs "PersonalID"** — both appear. Prefer the term the FLW will
  actually see on their device for the run in question.

When the source and the product disagree, the product the reader is looking at
wins.

## Enforced by

- `test/skills/connect-terminology.test.ts` — fails on `CommCare Connect`
  anywhere under `templates/`.
- `pdd-to-work-order-eval § Terminology` — grades work-order prose.

## Related

- [`pdd-to-work-order/references/writing-style.md`](./pdd-to-work-order/references/writing-style.md) — full voice and style guide
- [`README.md`](./README.md) — skills index
