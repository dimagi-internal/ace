# Intervention Design Document: Malaria Bed Net Distribution Pilot

## Problem Statement
In rural districts of Zambia, malaria remains the leading cause of under-5 mortality. Insecticide-treated bed nets (ITNs) are proven effective but distribution coverage and usage compliance remain below 60%.

## Intervention Design
Train community health workers (CHWs) to register households, assess bed net needs, distribute ITNs, and conduct follow-up visits to verify installation and usage. Each CHW covers ~200 households.

## Learn App Specification
### Data Collection
CHWs learn how to:
- Identify eligible households (those with children under 5 or pregnant women)
- Assess bed net condition and count
- Record distribution properly
- Conduct follow-up verification visits

### Visit Structure
- Training module: 3 lessons (household identification, distribution protocol, follow-up verification)
- Assessment after each lesson
- Estimated 15 minutes per lesson

### Forms
| Form Name | Purpose | Key Fields |
|-----------|---------|------------|
| Household Identification Quiz | Test ability to identify eligible households | scenario questions, correct answers, score |
| Distribution Protocol Quiz | Test proper distribution recording | step ordering, documentation requirements, score |
| Verification Visit Quiz | Test follow-up procedures | timing rules, compliance indicators, score |

## Deliver App Specification
### Services Delivered
- Household registration (demographics, GPS, bed net count)
- Bed net distribution (number distributed, recipients, condition of old nets)
- Follow-up verification visit (net installed? being used? condition?)

### Workflow
1. Register household → assess need → schedule distribution
2. Distribute nets → record quantities → get acknowledgment
3. Follow-up at 2 weeks → verify installation → record usage

### Case Management
- Case type: household
- Properties: head_of_household, num_children_under_5, num_pregnant_women, num_nets_needed, num_nets_distributed, nets_installed, nets_in_use
- Case lifecycle: registered → nets_distributed → verified → closed

## Target Population
- Beneficiaries: ~5,000 households in 3 rural districts
- Geographic scope: Luapula Province, Zambia

## FLW Requirements
- 25 CHWs
- Must complete all Learn app training modules with >80% assessment score
- Each covers ~200 households

## LLO Preference
- Preferred: Zambia CHW Cooperative (existing relationship)
- Alternative: District Health Office community program

## Success Metrics
| Metric | Target | Measurement |
|--------|--------|-------------|
| CHW training completion rate | >90% | Learn app assessment scores |
| Household registration coverage | >85% | Deliver app registrations vs. census |
| Net distribution rate | >80% | Nets distributed / nets needed |
| Follow-up visit completion | >75% | Verification visits / distributions |
| Net usage at 2 weeks | >70% | Verified in-use / distributed |

## Timeline
- Start: 2026-05-01
- CHW training: 2 weeks
- Distribution phase: 6 weeks
- Follow-up phase: 4 weeks
- End: 2026-08-15

## Budget
- Per-delivery payment: $2 per household visit (registration + distribution + follow-up)
- Estimated total: $30,000 (5,000 households × 3 visits × $2)
