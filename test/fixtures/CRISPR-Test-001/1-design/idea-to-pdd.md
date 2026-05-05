# Program Design Document (PDD)

## Opportunity: Community Health Worker Training Pilot — TestLand
**Date:** 2026-03-15
**Author:** Neal (ACE test fixture)
**Archetype:** atomic-visit

---

## Problem Statement
Rural health clinics in TestLand's Eastern Province lack systematic CHW training for maternal and child health (MCH) services. CHWs are conducting home visits but have no standardized protocol for prenatal assessments or immunization tracking.

## Intervention Design
Deploy a Learn + Deliver model where CHWs first complete training modules on MCH protocols (Learn app), then use a structured data collection app during home visits (Deliver app). The Learn app ensures baseline competency; the Deliver app standardizes service delivery and captures outcome data.

## Learn App Specification
### Training Modules
1. **Prenatal Assessment Basics** — identifying risk factors, measuring blood pressure, recording symptoms
2. **Immunization Schedule** — age-appropriate vaccinations, cold chain awareness, contraindications
3. **Danger Signs Recognition** — when to refer to clinic, emergency protocols

### Assessment
- Each module ends with a 5-question quiz
- Passing score: 80% (4/5 correct)
- CHWs must pass all 3 modules before accessing the Deliver app

## Deliver App Specification
### Services Delivered
- Prenatal home visits (monthly per beneficiary)
- Immunization tracking visits (per schedule)
- Danger sign screening at every visit

### Forms
| Form Name | Purpose | Key Fields |
|-----------|---------|------------|
| Beneficiary Registration | Register new pregnant woman or child under 5 | Name, age, gestational age or DOB, village, phone |
| Prenatal Visit | Monthly prenatal assessment | BP reading, weight, symptoms checklist, risk score (calculated), referral needed (Y/N) |
| Immunization Visit | Record vaccination | Vaccine given, batch number, next due date (calculated), adverse reaction (Y/N) |
| Danger Sign Referral | Emergency referral form | Danger signs observed (multi-select), referral facility, transport arranged (Y/N) |

### Case Management
- Case types: `mother` (prenatal), `child` (immunization)
- Case lifecycle: Registration creates case → visits update case → case closes at delivery (mother) or age-out at 5 years (child)
- Case list filters: overdue visits shown first

### Workflow
1. CHW opens app → sees case list sorted by next visit due
2. Selects beneficiary → opens appropriate visit form
3. Completes form → data saved, next visit auto-scheduled
4. If danger signs → referral form auto-opens

## Target Population
- Beneficiary criteria: Pregnant women and children under 5 in Eastern Province
- Geographic scope: 3 districts (Luvale, Mbunda, Kaonde)
- Expected reach: 500 beneficiaries across 3 districts

## FLW Requirements
- Number of FLWs: 25
- Skills/qualifications: Basic literacy, prior CHW experience preferred
- Geographic distribution: 8-9 per district, each covering 2-3 villages

## LLO Preference
- Preferred LLOs: TestLand Health Partners (fictional)
- LLO criteria: Experience managing CHW programs in Eastern Province, existing relationship with district health offices
- Contact: Neal (neal@test.example.com), Matt (matt@test.example.com)

## Success Metrics
| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| CHW training completion | 90% pass all modules within 2 weeks | Learn app completion data |
| Visit coverage | 80% of beneficiaries visited on schedule | Deliver app submission rates |
| Data quality | <5% forms with missing required fields | CommCare data quality reports |
| Referral appropriateness | >90% referrals clinically justified | Clinic record cross-check |

## Evidence Model

| Layer | Purpose | Captured by | Verified by |
|---|---|---|---|
| **A — Delivery proof** | The CHW visited the beneficiary and completed the appropriate form | Visit form submission (Prenatal Visit / Immunization Visit / Danger Sign Referral), GPS coordinate, timestamp, case ID, all required fields populated | Automated: GPS within target district, all required fields non-empty, case lifecycle action consistent (registration creates, follow-up updates), submission time within working hours |
| **B — Content proof** | The visit was conducted properly and the data is plausible | BP reading within physiologically possible range, vaccine batch number format valid, danger signs checklist complete with at least one entry where flagged, referral form attached when danger signs are present | Automated + AI-assisted: range checks on numeric fields, batch-number regex, conditional-required-field enforcement, referral cross-check |
| **C — Cross-delivery quality** | The dataset is useful and the FLWs are performing consistently | Per-FLW visit volume vs. cohort baseline, per-FLW referral rate vs. cohort baseline, case dropout patterns, data quality drift over time | AI advisory: outlier detection per FLW, referral-rate plausibility (too-low = under-referring, too-high = over-referring), case-dropout cluster detection |

## Timeline
- Start date: 2026-04-01
- End date: 2026-06-30
- Key milestones:
  - CHW training complete: 2026-04-14
  - First deliveries recorded: 2026-04-21
  - Mid-point review: 2026-05-15
  - Final data collection: 2026-06-25
  - Closeout: 2026-06-30

## Budget
- Estimated cost: $12,500
- Payment structure: $10 per verified home visit delivery
