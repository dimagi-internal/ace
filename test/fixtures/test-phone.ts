// Synthetic phone constants for unit tests. Uses the +7426 demo prefix so
// tests that exercise demo-user-detection logic remain semantically valid.
//
// Intentionally decoupled from ACE_E2E_PHONE (the production env var):
// production phone swaps (e.g. rotating to a fresh demo user with a
// cleaner OpportunityAccess list) don't need test fixture rewrites.
export const TEST_PHONE = '+74260000100';
export const TEST_PHONE_LOCAL = '4260000100';
export const TEST_PHONE_2 = '+74260000101';
