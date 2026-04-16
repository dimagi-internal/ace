# Widget Handoff — Turmeric Market Survey (SYNTHETIC)

**Produced by:** `ocs-setup` Phase 4 Step 4
**For operator:** paste these credentials into the Connect opportunity
widget configuration. This is a manual step until Connect's
`update_opportunity` API lands (CCC-301).

## Credentials to paste
- **public_id:** pub-turmeric-syn-0001
- **embed_key:** emb-turmeric-syn-0001

## Target
- **Connect opportunity:** OPP-TURMERIC-SYN-0001
- **Widget config URL (synthetic):**
  https://connect.dimagi.com/a/crispr-connect/opportunities/OPP-TURMERIC-SYN-0001/widget/

## Paste Instructions
1. Sign in to Connect with an operator account.
2. Navigate to the opportunity at the URL above.
3. Open the Widget Configuration tab.
4. Paste `public_id` into "Widget Public ID".
5. Paste `embed_key` into "Widget Embed Key".
6. Save. Verify the test preview returns a non-empty response.
7. Mark this handoff doc complete in the opportunity state.

## Why manual
The Connect API for editing widget config on an existing opportunity is
not yet implemented (CCC-301). When it ships, this entire step becomes
a single API call from `ocs-setup` and this handoff doc goes away.
