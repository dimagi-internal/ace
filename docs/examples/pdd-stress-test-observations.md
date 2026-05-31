# Sample PDD Observations

Analysis of two sample Program Design Documents to inform how the ACE pipeline (ACE) should stress test PDDs and verify LLO execution.

These notes were generated in conversation while exploring the kinds of stress tests, evidence layers, and Connect/CommCare configurations the ACE skills will need to support.

## Source artifacts

The two raw PDDs analyzed below are committed alongside this file so the folder is self-contained:

- **[`pdd-vaccine-hesitancy.md`](pdd-vaccine-hesitancy.md)** — two-stage intervention with focus groups (Stage 1) and household follow-up pilot (Stage 2). The harder case — focus groups don't fit the standard Connect delivery model.
- **[`pdd-turmeric-market-survey.md`](pdd-turmeric-market-survey.md)** — single-stage vendor photo survey with MTN card color reference. The cleaner case — maps directly onto atomic photo+GPS+form deliveries.

---

## PDD #1 — Vaccine Hesitancy (Sokoto State)

Two-stage intervention:
- **Stage 1:** Focus group discussions across six segments (women/men × close/remote × vaccinated/under-vaccinated)
- **Stage 2:** Household follow-up pilot where FLWs revisit zero/low-dose households on a ~2 week cadence

### Why this case is hard for ACE
The focus group stage breaks the standard Connect delivery model. The existing pipeline assumes atomic, photo+GPS+form deliveries. Focus groups have:
- Non-atomic delivery units (groups of 6–10, not individuals)
- Long duration (~90 min)
- Qualitative outputs that require synthesis, not structured form data
- Quality that can only be judged by reading/listening to content
- GPS that is largely meaningless (any community venue works)
- Skills required (facilitation, neutral probing, group dynamics) that aren't in `/builder` / `/tester` / `/connectifier` today

### Stress-test findings on the PDD itself

**Recruitment is underspecified.** The PDD itself flags this. Open questions:
- How is "under-vaccinated" determined? Self-report vs vaccine card vs facility records?
- Six segments × ~8 participants = ~48 people minimum to recruit
- Comparison groups (vaccinated children) may be expensive — analytical justification not given

**Operational logistics missing entirely:**
- Language (Hausa? translation?)
- Facilitator skill level / training requirement
- Consent process, especially for audio recording
- Venue (neutral vs facility vs leader's compound — each biases differently)
- Duration and participant compensation (opportunity cost is the same barrier the study is investigating)

**Question guide issues:**
- 15+ questions across multiple domains, no prioritization (a 90-min group covers 8–10 well)
- Sequencing risk: program-specific questions ("All Babies Are Equal") should come last to avoid anchoring
- No probing/follow-up guidance — focus group quality lives in the probes
- No warm-up questions

**Output specification too thin.** "Summary of key themes from each group, prepared by LLO facilitators" is the entire spec. No format, no length, no template, no path from a 90-min Hausa discussion to something AI synthesis can ingest. This is the biggest gap.

### Three-layer evidence model proposed for focus groups

| Layer | Purpose | Captured by | Verified by |
|---|---|---|---|
| A — Session-level proof | The group happened | Form: date, GPS, venue, segment, group photo, attendance register, audio recording | Automated: GPS, timestamp, audio duration |
| B — Content-level proof | The group was conducted properly | Structured per-domain summary form, key quotes, facilitator reflection | AI review of substance and specificity |
| C — Cross-session quality | The data is useful | AI synthesis across sessions | Theme variation across segments, mapping to literature, Stage-2 actionability |

### Stage 1 Connect/CommCare configuration sketch

**Learn app:** facilitation basics, question guide with probes, session form walkthrough, consent/ethics

**Deliver app — session documentation form:**
- Pre-session: date, GPS, venue, segment, participant count, consent confirmed, recording started
- Per question domain (5 sections): themes, notable quotes, level of consensus, time spent
- Post-session: facilitator reflection, attendance photo, audio file, total duration

**Connect opportunity:**
- Delivery unit = one completed focus group session with all Layer A + B evidence
- Payment unit = per verified session (e.g., 6 sessions total)
- Verification rules: GPS in expected area + audio duration >45 min + form complete + AI quality check on summaries

### Stress-test checklist (proposed for ACE to run on any PDD)

1. **Executability** — could an LLO read this PDD and start work on day one?
2. **Verifiability** — for every claimed output, is there a concrete artifact we can collect and check?
3. **Measurability** — are success criteria defined for this stage?
4. **Stage-gate clarity** — what must be true at the end of this stage to proceed to the next?
5. **Resource realism** — are the LLO's capabilities matched to what's being asked?

The Vaccine Hesitancy PDD partially fails on 1, 2, 3, and 4.

---

## PDD #2 — Turmeric Market Survey

Single-stage data collection. FLWs visit market vendors, take a photo of turmeric with a yellow MTN reference card, capture GPS, fill out a structured form, and deliver a brief vendor education message.

### Why this case is a clean fit
This PDD maps onto the existing ACE pipeline cleanly:
- Atomic delivery unit (one vendor)
- Short duration (minutes)
- Primary evidence is a photo (hard to fake well)
- GPS is meaningful (markets have known locations)
- Quality is judgeable from the artifact itself
- Form is already specified — `/builder` has a near-complete spec

This is the right PDD to use as the **first end-to-end test of the full ACE pipeline**. If ACE can't catch the stress-test issues below on an easy case, it won't catch harder ones on focus groups.

### Stress-test findings

**Scientific integrity (most important):**

1. **Photo standardization is unspecified.** The whole premise is that photos are *comparable*. But the PDD doesn't specify lighting, angle, distance, whether the MTN card is laid flat or held beside, or minimum resolution. Without a photo protocol, the dataset won't support shininess analysis. Fix: visual example + good/bad photo training in Learn app.

2. **FLW subjective judgment (Q12, Q13) asks non-experts to answer the actual research question.** If the photo is ground truth, these are training wheels and should be framed that way. If the FLW's answer is going to be used in analysis, there's a bias problem no training will fix. Needs an explicit call.

3. **MTN card has silent assumptions.** Same print run? Fading? Replacement protocol? If the card is the color reference, its consistency is load-bearing.

**Operational specificity:**

4. **"Market" is free text but caps depend on market identity.** Q1 is free text — so the 5/market/day cap is unenforceable. Needs either a market registry dropdown or geofence-based market assignment.

5. **No duplicate vendor detection.** No vendor ID, no stall number. Two FLWs could photograph the same vendor; one FLW could double-submit. GPS is too coarse to distinguish adjacent stalls.

6. **Sampling plan is missing.** Cap ≠ target. No selection criteria for markets, no per-region targets. Map will over-represent easy markets.

7. **Origin questions (Q10–11) will mostly be "no."** Set expectations that sparse data is expected, not a quality failure.

**Edge cases:**
- Vendor sells multiple forms (fresh AND powder) — one submission or two?
- No stock right now — valid submission or rejected visit?
- Wholesaler with bagged, unseen turmeric — how do you photograph what's not displayed?
- Shared stalls — one submission or many?

**Vendor education verification (Q16–18) is pure self-report.** An FLW could check "yes, receptive" 20 times a day with zero real conversations. Options:
- Accept self-report (cheapest)
- Sample audit via call-back (requires collecting phone numbers — form doesn't)
- Leave a printed safety card; closing photo of card on stall
- Optional short voice note of vendor reaction

**Safety/ethics gap:** No protocol for vendor hostility, no escalation path, photo consent is implicit.

### Verification mapping (standard Connect primitives — no new skills)

| Layer | Mechanism | Type |
|---|---|---|
| A — Delivery completeness | GPS + photo + form fields + reasonable hours | Automated, hard gate |
| B — Photo validity | MTN card detection, focus/exposure, EXIF timestamp match | Automated, AI-assisted |
| C — Behavioral plausibility | ≤20/day, ≤5/market/day, min time between visits, GPS path realism | Automated, rate limits |
| D — Cross-FLW quality | Price clustering, photo characteristic overlap, per-FLW outlier detection | AI advisory |
| E — Vendor education quality | Self-report + sample audit (weak) | Best-effort |

**Connect configuration:**
- Delivery unit = one verified vendor visit (Layers A + B pass)
- Payment unit = per verified visit; bonus tier for A+B+C
- Hard verification rules: GPS, photo, form, MTN card detected, caps respected
- Soft (human review flags): photo anomalies, price outliers, behavioral anomalies

---

## What this comparison tells us about ACE skill gaps

The turmeric survey works because **the artifact is the verification** — short, atomic, AI-inspectable. Focus groups have no equivalent.

For ACE to handle qualitative-research PDDs like the focus group case, we need new skills:

1. **A facilitation training skill** — "run a focus group" is a craft, not a checklist. The Learn app for this needs to teach probing, neutral framing, group dynamics.
2. **A qualitative-synthesis skill** — current pipeline assumes structured data; focus group outputs need LLM-as-analyst.
3. **A quality-assessment skill that can evaluate conversations** — not photos. Reads transcripts/summaries and rates substance, specificity, and segment differentiation.
4. **A different delivery/payment unit model** — is one delivery = one session? One participant? One hour of facilitated discussion? The current model doesn't have a good answer.

**Recommendation:** Use the Turmeric Market Survey as the first end-to-end ACE test. Treat the gaps listed above as a reference list of things `/builder` and `/tester` should be catching and pushing back on the PDD for. Use the focus group case to scope new skills and a new delivery model.
