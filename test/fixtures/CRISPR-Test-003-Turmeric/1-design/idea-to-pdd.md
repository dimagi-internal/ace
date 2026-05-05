# Program Design Document (PDD)

## Opportunity: Turmeric Market Survey
**Date:** 2026-04-16
**Author:** ACE (synthetic — seeded from `docs/examples/pdd-turmeric-market-survey.md`)
**Archetype:** atomic-visit

---

## Problem Statement

Turmeric sold in South Asian and African markets is commonly adulterated with
lead chromate, a toxic industrial pigment used to brighten the color.
Dietary lead exposure from adulterated turmeric causes irreversible cognitive
damage in children. No baseline dataset currently exists to map where
adulterated turmeric is most prevalent, making it hard to target follow-up
lab testing.

## Intervention Design

FLWs visit vendors in target markets and photograph each vendor's turmeric
with a standard yellow MTN color-reference card in the frame. The photos,
combined with a short structured form and auto-captured GPS, form a
geo-tagged dataset that analysts can use to flag candidates for lab
confirmation. A brief educational conversation with each vendor also raises
awareness that purchasing from trusted sources matters.

## Learn App Specification

### Data Collection
- 18-question per-vendor form covering location, vendor profile, product,
  origin, appearance quality, and the educational interaction

### Visit Structure
- Visit frequency: one-off (single visit per vendor)
- Expected visits per FLW: up to 20/day
- Duration per visit: ~10 minutes

### Forms
| Form Name | Purpose | Key Fields |
|-----------|---------|------------|
| Vendor Intake | Primary data collection | market_name, gps, photo_with_mtn_card, vendor_type, product_form, price, unit, stock, origin_known, color, shininess |
| Vendor Education | Capture of education outcome | education_shared, vendor_response, notes |

## Deliver App Specification

### Services Delivered
- One structured observation per vendor (photo + GPS + form)
- One brief educational conversation per vendor

### Workflow
1. Arrive at market, identify a turmeric vendor
2. Capture GPS (auto)
3. Take photo of turmeric with MTN card visible
4. Complete intake form
5. Deliver education message, record response
6. Submit delivery, move to next vendor (max 5/market/day)

### Case Management
- Case types: none (one-shot delivery; no case lifecycle)
- Each delivery is independent

## Target Population
- Beneficiary criteria: turmeric-selling vendors in target markets
- Geographic scope: TBD (to be set with LLOs at onboarding)
- Expected reach: ~2,000 vendor observations across 40 markets

## FLW Requirements
- Number of FLWs: 20
- Skills/qualifications: literate in the local market language, comfortable
  with polite vendor-facing conversation, comfortable with smartphone form
  and photo workflows
- Geographic distribution: 1–2 FLWs per market cluster

## LLO Preference
- Preferred LLOs: Dimagi-operated test LLO for pilot
- LLO criteria: operates in a geography with active market activity;
  experienced running photo + GPS FLW workflows

## Success Metrics
| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| Vendor observations submitted | 2,000 | Connect delivery count |
| Photos usable for color analysis | 90% of submissions | Layer B review |
| Education delivered | 85% of visits | Form field `education_shared = yes` |
| Unique markets covered | 40 | Distinct `market_name` values |

## Evidence Model

| Layer | Purpose | Captured by | Verified by |
|---|---|---|---|
| **A — Delivery proof** | Vendor observation happened | Photo with MTN card, GPS, complete form | Connect verification rules: photo present, GPS within configured bounding box, all required form fields populated |
| **B — Content proof** | Observation is usable for color analysis | Photo content (card visible, turmeric in frame, reasonable lighting), form substance | AI-assisted photo-quality rubric (card visibility, exposure, framing); spot-check form responses for plausibility |
| **C — Cross-delivery quality** | Dataset supports market-level comparison | Distribution of shininess scores, color counts, and price points per market | AI synthesis across deliveries — flag markets with anomalous shininess rates for lab follow-up |

## Timeline
- Start date: 2026-05-01
- End date: 2026-07-15
- Key milestones:
  - LLO onboarding complete: 2026-05-08
  - First 100 deliveries: 2026-05-22
  - Midpoint data review: 2026-06-10
  - Closeout: 2026-07-15

## Budget
- Estimated cost: ~$28,000 (synthetic)
- Payment structure: per-delivery (verified vendor observation)

---

## Stress Test Results

Stress-test rubric from `idea-to-pdd` (all 5 checks must pass):

1. **Archetype fit:** PASS — `atomic-visit` maps directly onto Connect's
   one-delivery-one-photo model.
2. **Evidence Model completeness:** PASS — all three layers declared with
   concrete verification methods.
3. **FLW skill realism:** PASS — photo + form + short conversation is within
   the range of existing Connect FLW workflows.
4. **Verifiability:** PASS — Layer A is fully automated (photo + GPS +
   required fields); Layer B uses a concrete photo rubric.
5. **Scope boundedness:** PASS — single-stage, no follow-up visits, fixed
   max per day.

No iteration needed; moving to `pdd-to-test-prompts`.
