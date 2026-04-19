---
name: ocs-chatbot-eval
description: >
  Judge an OCS chatbot transcript with LLM-as-Judge. Reads a transcript
  captured by `ocs-chatbot-qa`, scores each response across 4 dimensions
  (correctness, source usage, tone, tagging), writes a verdict YAML and
  human-readable report, and emits the Phase 4 gate brief in --deep mode.
---

# OCS Chatbot Eval

Grade a captured OCS chatbot transcript against an LLM-as-Judge rubric and
produce the machine-readable verdict that upstream gates (and the umbrella
`opp-eval`) consume. This skill is the **eval** half of the qa/eval pair —
it does not talk to the bot. For the capture half, see `ocs-chatbot-qa`.

See `skills/README.md § QA vs Eval — the two-phase pattern` for the
framework rationale and artifact-path contract.

## Modes

The mode is inherited from the transcript being judged. The same 4-dimension
rubric applies in every mode; what changes is suite size and gate behavior.

| Mode | Transcript source | Gate | Writes |
|---|---|---|---|
| `--quick` | `qa-captures/YYYY-MM-DD-ocs-chat-quick.md` | overall ≥ 7 passes; retry signal otherwise | stdout summary + `verdicts/ocs-chatbot-eval-quick.yaml` |
| `--deep` | `qa-captures/YYYY-MM-DD-ocs-chat-deep.md` | overall ≥ 7 AND zero Fail verdicts | `verdicts/` + `eval-reports/YYYY-MM-DD-ocs-eval.md` + `gate-briefs/ocs-chatbot-eval-deep.md` |
| `--monitor` | `qa-captures/YYYY-MM-DD-ocs-chat-monitor.md` | none — trend only | `verdicts/` + `eval-reports/YYYY-MM-DD-ocs-eval.md` + append to `eval-reports/trend.md` |

If no mode is passed, default to `--quick`.

## Process

1. **Locate the transcript.** Find the most recent
   `qa-captures/YYYY-MM-DD-ocs-chat-<mode>.md` for the requested mode in
   `ACE/<opp-name>/` (or the path passed as `--capture <path>`). Fail loudly
   if missing — do not chat with the bot to regenerate it. That's
   `ocs-chatbot-qa`'s job.

2. **Read the transcript structure.** Each entry in the capture has:
   - `prompt` — what was sent
   - `category` — classification tag from the suite
   - `expected_answer_summary` — ground-truth summary (opp-specific prompts)
     or declared expectation (smoke/edge-case prompts)
   - `expected_tags`, `expected_escalation`
   - `response_content`, `cited_files`, `tags` — the captured bot reply
   - `response_received` — structural flag from qa-side checks
   - `elapsed_ms`

3. **Grade each response (LLM-as-Judge).** For each entry, score across 4
   dimensions:

   | Dimension | Weight | Criteria |
   |-----------|--------|----------|
   | **Correctness** | 40% | Does the answer match `expected_answer_summary`? Factually accurate against the knowledge base? |
   | **Source usage** | 20% | `cited_files` references the right collection (shared Connect vs. opp-specific)? |
   | **Tone** | 20% | Professional, respectful, actionable for experienced Network Managers? Not condescending? |
   | **Tagging** | 20% | `[training-gap]` for basic-confusion answers, `[product-feedback]` for bug reports, escalation to `ace@dimagi-ai.com` for out-of-scope? Matches `expected_tags` / `expected_escalation`? |

   Each dimension is 0–10. Overall score is the weighted average.

   Per-prompt verdicts:
   - **Pass** (7–10): correct, well-sourced, properly tagged
   - **Warn** (4–6): partially correct or missing source/tag
   - **Fail** (0–3): wrong, off-topic, or violates tone guidelines

4. **Write the verdict YAML** to
   `ACE/<opp-name>/verdicts/ocs-chatbot-eval-<mode>.yaml`. Uses the shared
   verdict shape (see `skills/README.md § QA vs Eval — the two-phase
   pattern` for the contract — every `-eval` skill writes the same shape so
   `opp-eval` can aggregate uniformly):

   ```yaml
   skill: ocs-chatbot-eval
   target: <experiment_id>
   mode: quick | deep | monitor
   ran_at: <ISO timestamp>
   capture_path: qa-captures/YYYY-MM-DD-ocs-chat-<mode>.md

   overall_score: 7.8
   verdict: pass | warn | fail

   dimensions:
     correctness:  { score: 8.5, weight: 0.4 }
     source_usage: { score: 7.0, weight: 0.2 }
     tone:         { score: 8.0, weight: 0.2 }
     tagging:      { score: 7.5, weight: 0.2 }

   per_prompt:
     - prompt: "How do I review flagged deliveries?"
       category: connect-general
       score: 8.5
       verdict: pass
       note: "Correct steps, professional tone"
     - ...

   gate:
     threshold: 7.0
     disposition: approve | reject | iterate
   ```

5. **Apply the gate (mode-dependent):**
   - `--quick`: overall ≥ 7 passes. On fail, return a retry signal so the
     caller (`ocs-setup` agent) can re-run `ocs-agent-setup`'s prompt-patch
     once before escalating.
   - `--deep`: overall ≥ 7 AND every Fail verdict resolved. On fail,
     escalate to admin group with the report attached.
   - `--monitor`: no gate — write verdict + report, append to trend file.
     If overall drops > 1.5 points from the previous monitor verdict, email
     the admin group with the delta.

6. **Write the human-readable report** (skipped for `--quick` stdout-only
   mode) to `ACE/<opp-name>/eval-reports/YYYY-MM-DD-ocs-eval.md`:

   ```markdown
   # OCS Chatbot Eval Report
   Date: YYYY-MM-DD
   Target: <experiment_id> (<bot name>)
   Mode: quick | deep | monitor
   Capture: qa-captures/YYYY-MM-DD-ocs-chat-<mode>.md
   Overall Score: X.X / 10

   ## Results

   | # | Prompt | Score | Verdict | Notes |
   |---|--------|-------|---------|-------|
   | 1 | How do I review flagged deliveries? | 8.5 | PASS | Correct steps, good tone |
   | ... | ... | ... | ... | ... |

   ## Dimension Breakdown
   - Correctness: X.X / 10
   - Source usage: X.X / 10
   - Tone: X.X / 10
   - Tagging: X.X / 10

   ## Full Transcript With Judgments
   [per-question: prompt + response + cited_files + judge evaluation]
   ```

7. **In `--monitor` mode**, append a single-line entry to
   `ACE/<opp-name>/eval-reports/trend.md` with date, overall score, and
   dimension breakdown so drift is visible at a glance.

8. **Write the gate brief** (only for `--deep` mode) to
   `ACE/<opp-name>/gate-briefs/ocs-chatbot-eval-deep.md` using the shape
   from `agents/ace-orchestrator.md § Gate Brief Contract`. See `## Gate
   Brief` below for the exact fields.

## Gate Brief

*Applies to `--deep` mode only.* Summarizes the verdict so the admin can
decide whether the bot is ready for Phase 5 without reading the full
transcript.

- **Artifact Under Review:** path to the dated report under
  `ACE/<opp-name>/eval-reports/`; summary is
  `<overall-score>/10 across <N> prompts, <P> Pass / <W> Warn / <F> Fail`
- **What to Check** (emit these 4 items verbatim):
  - Overall score ≥ 7.0 and no Fail verdicts on opp-specific prompts
    from `test-prompts.md`
  - All four dimensions (Correctness, Source usage, Tone, Tagging) scored
    ≥ 6.0 — a dimension below 6 is a retrieval or prompt gap, not noise
  - Edge-case prompts (out-of-scope, adversarial) all passed — role
    leakage is a privacy risk, not just a quality one
  - `cited_files` on Pass responses actually correspond to the right
    collection (Connect shared vs. opp-specific) — spot-check one of each
- **Auto-Surfaced Concerns:** one line per signal:
  - `[BLOCKER]` for each Fail verdict (include prompt snippet + reason)
  - `[BLOCKER]` if overall score is below 7.0
  - `[WARN]` for each dimension scoring 6.0–6.9
  - `[WARN]` if any Pass used the wrong source collection
  - `[INFO]` if the deep suite ran fewer than 10 prompts (thin test)
  - "None — all auto-checks passed." if cleared ≥ 7 with zero Fail
- **Recommended Disposition:** `Approve` if zero `[BLOCKER]`; `Reject` if
  any `[BLOCKER]` (bot not ready); `Iterate` to re-run prompt/RAG and
  retry qa + eval

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`
- No OCS calls — this skill judges an already-captured transcript

## Mode Behavior

- **Auto:** Grade, write verdict + report, surface gate result
- **Review:** Pause after judgment to let a human eyeball the verdict
  before the gate brief propagates

## Dry-Run Behavior

When `--dry-run` is active:
- Write verdict + report to Drive normally (these are human-facing artifacts)
- Skip admin-group emails; write them to `comms-log/dry-run-ocs-chatbot-eval.md`
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-19 | Initial version — split out from `ocs-chatbot-qa` as the judge half of the qa/eval pair. Reads transcripts from `qa-captures/`, writes `verdicts/`, `eval-reports/`, `gate-briefs/ocs-chatbot-eval-deep.md`. Gate now sits on eval, not qa | ACE team (qa/eval split refactor) |
