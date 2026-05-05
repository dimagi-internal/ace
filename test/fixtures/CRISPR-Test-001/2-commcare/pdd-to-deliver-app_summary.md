---
nova_app_id: DEL-TEST001-SYN-0001
nova_app_url: https://commcare.app/apps/DEL-TEST001-SYN-0001
archetype: atomic-visit
delivery_unit: one verified FLW visit to one beneficiary
---

# Deliver App Summary — CRISPR-Test-001

**App Name:** TestLand MCH Service Delivery
**Connect Type:** deliver
**Generated:** 2026-04-03 (synthetic fixture)

## Modules

### 1. Registration
- **Form:** Beneficiary Registration
- **Purpose:** Register new pregnant women or children under 5
- **Creates case:** `mother` or `child`
- **Key fields:** name, age, gestational_age/dob, village, phone

### 2. Prenatal Visits
- **Form:** Prenatal Visit
- **Purpose:** Monthly prenatal assessment during home visit
- **Updates case:** `mother`
- **Key fields:** bp_reading, weight, symptoms (multi-select), risk_score (calculated), referral_needed
- **Deliver unit:** 1 per verified visit

### 3. Immunization Visits
- **Form:** Immunization Visit
- **Purpose:** Record vaccination and schedule next dose
- **Updates case:** `child`
- **Key fields:** vaccine_given, batch_number, next_due_date (calculated), adverse_reaction
- **Deliver unit:** 1 per verified visit

### 4. Danger Sign Referral
- **Form:** Danger Sign Referral
- **Purpose:** Emergency referral when danger signs observed
- **Updates case:** `mother` or `child`
- **Key fields:** danger_signs (multi-select), referral_facility, transport_arranged

## Connect Configuration
- `connect_type: deliver`
- Each service form has `deliver_unit` configured
- Verification rules: GPS within 500m of village, form duration >5 minutes
- Payment: $10 per verified prenatal or immunization visit
