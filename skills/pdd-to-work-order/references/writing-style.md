# Dimagi External Document — Writing Style

How Dimagi external documents *read* — the voice, tone, and language conventions that complement the visual identity. Apply these while drafting the prose body tokens in `pdd-to-work-order` (`{{background_body}}`, `{{scope_intro}}`, `{{geographic_coverage_body}}`, `{{primary_deliverable_body}}`, `{{verified_unit_closing}}`, `{{ethics_body}}`, bulleted-region items) before any styling.

> Source: adapted from `sarvesh-tewari/ace-skills-stewari` (CLP work-order skill pair). Applies to any ACE skill that emits external-facing Dimagi prose — work orders, solicitations, LLO emails, partner-facing one-pagers.

---

## Voice and tone

- **Plain, formal, direct.** No marketing language, no hyperbole, no "exciting opportunity to partner". Get to the point.
- **Active voice.** "DFHF will conduct sampling" not "Sampling will be conducted by DFHF". Passive voice creeps in when authorship is unclear; if you find yourself writing passive, ask who is responsible and re-write with that subject.
- **Present and future tense.** Past tense is rare — only when referencing prior history that establishes context.
- **Plain modal verbs.** Use `will` for commitments, `may` for permissions, `must` for hard requirements. Avoid `shall` (legal-archaic) and avoid stacking modals like `would be required to`.

Example:
- Don't write: `The Partner shall be required to ensure that all samples shall be delivered…`
- Do write: `The Partner will deliver all samples within 72 hours…`

---

## Pronoun and naming strategy

Define the partner once, then use the generic noun throughout. This makes documents readable and makes templates reusable across different partners.

**Convention:** On first reference, write the full name and define a short form in parentheses:

```
DFHF (henceforth, referred to as "partner") is an active Connect implementer…
```

After that, use `the partner` everywhere. Do not switch back and forth between the abbreviation and `the partner` — pick one and stick with it. (Default to `the partner` — it travels better when you reuse the document for the next LLO.)

For Dimagi's side, write `Dimagi` (no `Inc.`, no `we`, no `our team`). The corporate name `Dimagi, Inc.` appears in the parties block and signature block only.

---

## Bold use

Bold is reserved for genuinely load-bearing terms. Aim for 5–15 bold spans per page, not 50.

**Use bold for:**

- Defined terms on first appearance: `**field collection only**`, `**verified RDT sample**`
- Negative scope markers: `**not payable**`, `**not within scope**`
- Financial commitments: `**USD 2,500, not-to-exceed**`
- Hard requirements: `**must**`, `**at least 100 RDTs**`
- Bullet lead-ins for list items with a definable head: `**Weekly progress report** (lightweight Connect dashboard data…)`

**Don't use bold for:**

- Whole sentences or whole paragraphs
- Section headers (the heading style handles that)
- Emphasis-for-emphasis-sake ("this is **very** important")
- Repeated mentions of an already-bolded term within the same paragraph

---

## Hedging and commercial softness

Dimagi work orders frequently include suggestions or targets that are not hard contractual requirements. Use soft commercial language to keep them distinct from binding obligations.

| Softening phrase | When to use |
|---|---|
| `We think this could allow…` | Setting indicative scale (e.g., expected sample counts) |
| `Our suggestion is to try to get…` | Recommending a sampling mix or coverage pattern |
| `Though this is not a hard requirement…` | Clarifying a stated target is aspirational |
| `For reference, the following…` | Offering options the partner can choose from |
| `Where market availability permits` / `Where applicable` | Acknowledging field reality |

Keep hard requirements crisp: `The partner will…`, `The cap applies…`, `Samples that fail one or more of these criteria are not payable.`

---

## Section and sub-section numbering

Top-level sections are numbered with a single integer plus period: `1. Background`, `2. Scope of Work`, `3. Geographic Coverage`. The number is part of the heading text, not a separate list marker.

Sub-sections use decimal numbering: `4.1 Primary Deliverable`, `4.2 Definition of a Verified Sample`. They are part of the H3 heading text.

A standard work order has 8–10 numbered sections. An MSA may have more (15–20). A short SOW may have 5–7.

Annexures sit at the end, listed under an `Annexures` heading without a section number:

```
## Annexures
- Annexure A: Sampling Protocol (provided separately…)
- Annexure B: …
```

---

## Lists vs. prose

Use bullet lists for:

- Enumerable items (states, deliverables, exclusions)
- Step-by-step procedures (`For each POC location visited, the partner will:`)
- Verification criteria
- Cross-cutting scope exclusions (e.g., `The partner will not:` followed by bullets)

Use prose for:

- Background and context
- Single-sentence commitments
- Anything the reader needs to absorb as a flowing argument

A common pattern: introduce a list with a complete colon-terminated sentence ("The partner will not:" or "For each POC location visited, the partner will:"). Each bullet completes the introductory sentence.

---

## Terminology preferences

Use the Dimagi-preferred form on the left.

| Preferred | Avoid | Why |
|---|---|---|
| Locally-Led organization (LLO) | Local Lead Organization, Last-Mile Operator | Dimagi's current canonical expansion of LLO |
| Frontline Worker (FLW) | Community Health Worker, Health Worker (when on the platform) | FLW is the Connect ecosystem term |
| The partner | The vendor, The subcontractor, The implementer | Reusable and respectful |
| Point-of-care (POC) location | Site, Health facility (when ambiguous) | Captures both formal facilities and informal retail |
| Patent medicine vendor (PMV), drug shop | Chemist (Nigerian English variant — clarify if used) | Standardize on PMV |
| Verified visit / verified sample | Completed visit, Submitted visit | "Verified" is the Connect-specific term |
| Connect | CommCare Connect, the platform | Use the product name |
| Dimagi | Dimagi, Inc., we, our team | Use the org name consistently |

---

## Sentence-level patterns

A few specific phrasings that recur across Dimagi documents:

- Defining scope inclusion: `This Work Order covers **field collection only**. Laboratory testing … is being arranged separately by Dimagi.`
- Defining scope exclusion: `The partner will not: …` followed by a bullet list.
- Setting financial caps: `Dimagi's total financial commitment under this Work Order is **USD X,XXX, not-to-exceed**, inclusive of all the field collection costs, …`
- Defining verified deliverables: `A sample qualifies as "verified" and is payable under this Work Order only when all of the following criteria are met: …`
- Acknowledging timeline pressure: `The Parties acknowledge that the [external deadline] creates an aggressive timeline. The plan below assumes contract execution by [date], with formal milestone activities commencing the following week.`
- Risk flagging clause: `The partner will flag any timeline risk in writing to Dimagi within 24 hours of identification.`

These are templates — adapt the specific numbers and parties, but keep the structure.

---

## Closing boilerplate (work orders)

`IN WITNESS WHEREOF, the parties hereto have caused this Work Order to be executed by their authorized agents as of the date first above written, and annexed to the parties' MSA dated __________________.`

For non-work-order documents, substitute the document type and remove the MSA reference if not applicable.

---

## What to avoid in writing

- **Hyperbole / superlatives:** "world-class", "best-in-class", "cutting-edge", "industry-leading". Dimagi documents do not market.
- **Vague commitments:** "Best efforts", "as soon as practicable", "from time to time". State what will happen and by when.
- **Insider jargon without expansion:** First mention of any acronym must spell it out: `Frontline Worker (FLW)`, `Local Government Authority (LGA)`, `National Malaria Control Programme (NMCP)`.
- **Conditional pyramids:** "In the event that, subject to the provisions of, …". Re-write as a direct sentence.
- **Excessive caveats:** Each obligation should be stated once, clearly. If three sentences hedge a single commitment, the commitment is not yet decided — go back to the user.
- **Inconsistent partner naming:** Switching between "DFHF", "the LLO", "the partner", "the vendor". Pick one (default: "the partner") and stick with it.
