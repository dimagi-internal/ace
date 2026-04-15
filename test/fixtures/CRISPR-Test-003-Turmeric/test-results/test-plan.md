# Test Plan — Turmeric Market Survey (SYNTHETIC)

Produced by `app-test` against `deployment-summary.md` + `pdd.md`.
Cross-references the PDD's Evidence Model (Layer A / B).

## Scope
- Learn App: LRN-TURMERIC-SYN-0001 (onboarding flow, module completion)
- Deliver App: DEL-TURMERIC-SYN-0001 (intake form, education form,
  submission, verification)

## Test Cases

### T-01 Happy-path delivery (Layer A)
- **Evidence target:** Delivery proof — photo + GPS + required fields
- **Steps:** Open Deliver app → fill intake form with all required fields →
  attach photo with MTN card visible → submit
- **Expected:** Submission accepted by Connect, verification rules pass,
  delivery counted toward FLW's daily tally

### T-02 Missing MTN card photo (Layer B)
- **Evidence target:** Content proof — photo is usable
- **Steps:** Same as T-01 but photo does not include the MTN card
- **Expected:** Submission accepted by Layer A (photo present), flagged
  at Layer B AI review for "card not visible"

### T-03 GPS outside bounding box (Layer A)
- **Evidence target:** Delivery proof — GPS within operating area
- **Steps:** Attempt submission with GPS coordinates outside the
  configured bounding box
- **Expected:** Connect verification rejects the submission

### T-04 Daily cap hit (per FLW)
- **Steps:** One FLW submits 20 deliveries in a single day, tries to
  submit #21
- **Expected:** Deliver app blocks the submission with
  "daily limit reached"

### T-05 Daily cap hit (per market)
- **Steps:** A market has 5 deliveries already; any FLW tries to submit
  a 6th for that market
- **Expected:** Deliver app blocks the submission with
  "market limit reached"

### T-06 Education not delivered
- **Evidence target:** Success metric — education delivered in ≥85% of
  visits
- **Steps:** Submit delivery with `education_shared = no`
- **Expected:** Submission accepted; cross-delivery metric captures the
  rate

### T-07 Learn App completion
- **Steps:** Complete all three modules of the Learn app
- **Expected:** Module-completion state updates in Connect; FLW unlocks
  Deliver app
