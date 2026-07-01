---
name: self-review
description: >
  Before sending any reply or finishing any counterpart-facing deliverable, audit it against
  the REQUESTER'S ORIGINAL words — extract each discrete ask, confirm the deliverable does
  exactly that, verify cited sources by reading them, rate it tough, fix every gap. Run on
  every outbound reply in a turn, especially multi-part requests. (ACE's -eval skills grade
  artifacts; this is the brief-fidelity counterpart for correspondence.)
---

# Self-review (does the work match the brief?)

ACE already runs independent graders for artifacts (the `-qa`/`-eval` regime). This applies the same
discipline to correspondence: before anything goes out, check it against what was actually asked —
not what you remember being asked, and not a close-enough substitute.

## Process
1. **Re-read the original request and extract each discrete ask** as a checklist, verbatim where
   possible. Multi-part requests hide dropped items — list them ALL.
2. **For each ask, confirm the deliverable does EXACTLY that** — not a near-miss. The classic
   failure: they asked for a link to *the report* and you linked *your summary of the report*. Do
   the literal thing, or explicitly flag the deliberate substitution.
3. **Verify against cited sources — read them, don't reconstruct from memory.** If the thread
   references a doc or a run artifact, open it and use its actual content.
4. **Rate it, tough.** Faithfulness-to-each-ask, source-verification, completeness, clarity
   (1–5 each, default 3). Anything under 5 on faithfulness → fix before sending.
5. **Fix every gap**, then re-run the check.

## In the reply — separate multiple requests
When a message contained MULTIPLE asks, enumerate them and say how each was handled, one line each
(✓ done / link / status). The requester must be able to see their checklist reflected back.

## When to run
Before EVERY outbound reply or counterpart-facing deliverable — non-optional for any request with
multiple parts or cited links/sources. Wired into `inbox-triage` step 2d and `turn` Step 3.
