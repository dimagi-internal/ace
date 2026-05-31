# Program Design Document (PDD)

## Opportunity: Niger Maternal Health Pilot
**Date:** 2026-05-04
**Author:** ACE Test Fixture
**Archetype:** atomic-visit

---

## Problem Statement
Pregnant women and new mothers in 3 Niger districts lack regular access to ANC/PNC guidance. Facility delivery rates are below 35%; danger-sign recognition is inconsistent.

## Intervention Design
Community Health Workers (CHWs) visit pregnant women and new mothers monthly to provide ANC/PNC guidance, basic screening for danger signs, and active referral to the nearest health facility for high-risk cases.

## Learn App Specification
### Data Collection
- Pregnancy status, expected delivery date
- Danger-sign screening (per WHO checklist)
- Referral log per visit

### Visit Structure
- Visit frequency: monthly
- Expected visits per FLW: 30/month
- Duration per visit: 15 minutes

### Forms
| Form Name | Purpose | Key Fields |
|-----------|---------|------------|
| ANC/PNC Visit | Visit-level data + screening | woman_id, visit_date, danger_signs, referral_made |

## Deliver App Specification
### Services Delivered
- Visit a registered woman, screen for danger signs, log referral if needed.

### Workflow
1. Open case → confirm visit eligibility (last visit ≥ 25 days ago)
2. Run danger-sign screening (10 questions)
3. Log referral if any danger sign positive
4. Close visit form; CommCare auto-syncs to opportunity dashboard

### Case Management
- Case types: woman
- Case lifecycle: open at registration → updated each visit → closed at delivery + 6 weeks postpartum

## Target Population
- Beneficiary criteria: pregnant women and women within 6 weeks postpartum
- Geographic scope: 3 districts in Niger
- Expected reach: ~1200 women across the opportunity

## FLW Requirements
- Number of FLWs: 40
- Skills/qualifications: existing community health volunteers, basic literacy in Hausa or French
- Geographic distribution: spread across the 3 districts

## LLO Preference
- Preferred LLOs:
  - { name: "Niger Health Initiative", contact_email: "ops@niger-health.example", organization_slug: "niger-health-initiative" }
  - { name: "Sahel Maternal Care", contact_email: "info@sahel-maternal.example", organization_slug: "sahel-maternal-care" }
- LLO criteria: prior CHW deployment in West Africa, local-language capacity (Hausa or French), recruitment + supervision capability for 40+ FLWs

## Solicitation
- Solicitation type: EOI
- Response window: 21
- Response template:
  - "Describe your prior experience deploying CHW programs in West Africa"
  - "How will you recruit and train 40 FLWs across 3 districts?"
  - "What is your timeline for fielding once awarded?"
  - "What is your supervision model for FLW visits?"
  - "Do you have local-language capacity (Hausa or French)?"

## Success Metrics
| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| ≥80% pregnant women in catchment receive at least 1 ANC visit | 80% | Visit form submission count vs catchment census |
| ≥60% danger-sign cases referred to facility | 60% | Referral log analysis |
| FLW retention | ≥85% over 6 months | Active-FLW count over time |

## Evidence Model

| Layer | Purpose | Captured by | Verified by |
|---|---|---|---|
| **A — Delivery proof** | Visit happened with the named woman | woman_id linkage, visit_date, GPS at visit, photo of woman + FLW | Connect verification: 1-per-day cap per FLW, GPS within 50m of registered location |
| **B — Content proof** | Screening completed properly | Full danger-sign checklist filled in, referral log when positive | Form-completion rate ≥95%; referral rate matches expected danger-sign positivity |
| **C — Cross-delivery quality** | Dataset useful for cohort analysis | Visit cadence (monthly), retention curves, referral-outcome tracking | AI-assisted: outlier-detect FLWs missing visits, plot referral rates by FLW for calibration drift |

## Timeline
- Start date: 2026-06-01
- End date: 2026-12-01
- Key milestones:
  - Awardee selected and onboarded: 2026-05-25
  - First visits in field: 2026-06-15
  - Mid-cycle review: 2026-09-01

## Budget
- Estimated cost: 75000
- Payment structure: per visit
