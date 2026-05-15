---
name: video-spec-eval
description: >
  LLM-as-judge eval of the spec.yaml produced by /ace:video-from-program-page
  (or hand-authored) for an ace-web video program. Scores 6 quality
  dimensions and emits a verdict YAML with concrete improvement
  recommendations. Gated by video-spec-qa.
disable-model-invocation: true
---

# Video Spec Eval

Grade the *goodness* of a video program's `spec.yaml`. Where
`video-spec-qa` checks structural correctness, this skill judges
quality: does the narration sound like Connect, does the spec describe
*this* program rather than generic Connect content, are the chosen
stats the most compelling ones from the source page, does the 60s
flow build a story?

LLM-as-judge across 6 dimensions, each scored 0-10 with concrete
strengths/weaknesses and a one-line improvement recommendation. The
agent is the judge; this skill defines the rubric.

See `skills/_eval-template.md` for the shared eval contract (verdict
YAML format, severity rules, inflation guard).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| ace-web Drive | `videos/<slug>/runs/<run-id>/spec.yaml` | the spec under judgment |
| Source URL (optional) | `provenance.generated_from` page content | cross-check that the spec describes the *actual* program |
| Template prompt | `generate.prompt.md` for `provenance.template` | the rubric's voice + word-budget anchors live here |

## Products

- `video-spec-eval_verdict.yaml` per the canonical `Verdict` schema
  (`lib/verdict-schema.ts`). The skill prints it to stdout for the
  caller to persist.

## Process

1. **Confirm QA passed.** Skip the eval if `video-spec-qa` failed
   irrecoverably — quality grading on a structurally broken spec is
   noise. (Operator override: pass `--ignore-qa` to grade anyway.)

2. **Read the spec.yaml from ace-web** (same access path as
   video-spec-qa step 1).

3. **Re-fetch the source page** at `provenance.generated_from`. If
   the URL 404s or the spec has no provenance.generated_from, set
   `source_available = false` and switch the **Source Fidelity**
   dimension to its no-source branch (score from internal coherence
   only).

4. **Load the template prompt** at the canonical path
   `video-production/connect-videos/templates/<provenance.template>/generate.prompt.md`
   in ace-web. The prompt's voice rules + per-beat word budgets are
   the anchors the judge applies.

5. **Score each dimension below 0-10.** For each, capture:
   - `score: <int 0-10>`
   - `strength: <one-liner>` — what's working
   - `weakness: <one-liner>` — what's the worst issue
   - `recommendation: <one-liner>` — one concrete edit

6. **Produce overall verdict.**
   - `pass` — every dimension ≥ 7
   - `revise` — any dimension 5-6 (operator should edit before render)
   - `fail` — any dimension ≤ 4 (regenerate the spec)
   - `summary` — 2-3 sentences total. Lead with the biggest lever.

## Dimensions

### 1. Narration Voice

**Rubric:** Does the narration read like Connect's voice — plain,
declarative, specific? Or does it drift into marketing-ad mode (long
sentences, abstract nouns, "powering / enabling / transforming")?

| Anchor | Score |
|---|---|
| Every beat reads as documentary lower-third. Numbers over adjectives. Active voice. Short sentences. | 9-10 |
| Mostly tight; 1-2 beats use a marketing-ad phrasing the operator should retune. | 7-8 |
| Multiple beats read as ad copy. Long sentences, abstract subjects ("our solution leverages..."). | 4-6 |
| Generic Connect marketing copy. Could plausibly apply to any Connect program. | 0-3 |

**Common penalties:** "leverage", "empower", "transform", "robust",
"comprehensive", "world-class" — the static QA catches a small list,
but this dimension catches the broader register.

### 2. Stat Selection

**Rubric:** Did the agent pick the *most compelling* numbers from the
source for `problem.big` and the two `impact[]` entries? Or did it
grab the first numbers it saw?

| Anchor | Score |
|---|---|
| problem.big is the headline number a reader would remember from the source. Both impact entries are the highest-leverage ones. | 9-10 |
| Either problem or impact uses a less-than-optimal number; the swap is obvious. | 7-8 |
| Both problem and impact are suboptimal; better stats exist on the source page. | 4-6 |
| Stats appear made up, are wrong, or fail to connect to this program. | 0-3 |

**Common penalties:** picking "X% completion" when "$Y per beneficiary"
is in the source; using a Connect-level stat where the program has
its own; using a vanity metric over an outcome metric.

### 3. Beat Coherence

**Rubric:** Does the 60s flow as a story or read as eight disconnected
sentences? The arc the 60s template implies:
hook → cycle (the how) → handoff (this program) → scene (the field) →
problem (the stakes) → product (the proof) → impact (the result) →
cta (empty / outro). Does each beat hand off cleanly?

| Anchor | Score |
|---|---|
| Each beat sets up the next. A listener with no Connect context follows the arc. | 9-10 |
| One beat feels bolted on or stylistically off-key; the rest land. | 7-8 |
| Two or more transitions feel abrupt; the listener has to recover context. | 4-6 |
| The arc is broken — beats appear in the wrong order or contradict each other. | 0-3 |

### 4. Source Fidelity

**Rubric:** Does the spec describe the *actual* program from the
source page, or is it generic Connect content with the program name
swapped in?

| Anchor | Score |
|---|---|
| Field-level specificity: country, partner names, activity descriptions, FLW tasks match the source verbatim or near-verbatim. | 9-10 |
| Mostly specific; one or two fields generic where the source has detail. | 7-8 |
| Half-specific: country + name are right but activities, partners, stats are generic. | 4-6 |
| Could plausibly apply to a different Connect program with no edits. Hallucinated stats or activities. | 0-3 |

**No-source branch** (`source_available = false`): grade on internal
coherence only — does the spec hang together?

### 5. Tagline Mirror

**Rubric:** Does `narration.by_beat.hook` paraphrase Connect's
tagline "Pay for verified service delivery, not planned activity"
without inventing a different tagline?

| Anchor | Score |
|---|---|
| Verbatim or near-verbatim ("Connect pays for verified service delivery, not planned activity"). | 9-10 |
| Strong paraphrase keeping all four key concepts (pay / verified / service / delivery). | 7-8 |
| Drift — drops one concept ("we deliver" without "verified"). | 4-6 |
| New tagline invented from whole cloth. | 0-3 |

**Note:** the static QA catches gross divergence (3+ of 4 key tokens
required). This dimension catches the subtler stylistic drift.

### 6. Story Compression

**Rubric:** Within each beat's word budget, did the agent use the
words to maximum effect? Or did it pad with filler to hit the target?

| Anchor | Score |
|---|---|
| Every word earns its place. A reader couldn't trim by 2 words without losing meaning. | 9-10 |
| One or two beats use filler ("structured care that is delivered in their homes"). | 7-8 |
| Multiple beats pad; a sharp editor could compress by 20% with no loss. | 4-6 |
| Most beats are bloated. The 60s of audio carries 30s of content. | 0-3 |

## Verdict YAML shape

```yaml
schema_version: 1
skill: video-spec-eval
target: dimagi-team/kangaroo-mother-care/run-001
ran_at: 2026-05-15T12:34:56Z
capture_path: videos/kangaroo-mother-care/runs/run-001/spec.yaml
overall_score: 82
verdict: pass         # pass | revise | fail
qa_gated: true        # was QA passing when eval ran?
source_available: true
dimensions:
  narration_voice:
    score: 9
    strength: "Every beat reads as documentary lower-third."
    weakness: "Cycle beat uses 'verified' twice — feels redundant."
    recommendation: "Change cycle beat's second 'verified' to 'confirmed'."
  stat_selection: {score: 7, strength: ..., weakness: ..., recommendation: ...}
  beat_coherence: {...}
  source_fidelity: {...}
  tagline_mirror: {...}
  story_compression: {...}
summary: |
  Strong source fidelity and voice; the main lever is tightening
  the cycle beat's word choice. Spec is ship-ready after one edit.
```

## Inflation guard

Eval inflation is real — every well-written spec wants a 9. To keep
the rubric calibrated:
- Default ceiling for a first-pass agent-authored spec is 8 on any
  dimension. Reserve 9-10 for specs that genuinely could not be
  improved.
- If you find yourself scoring 9+ on every dimension, re-examine: am I
  grading what's *there* or am I grading absence of obvious flaws?
- A 7 is a good score. It means "ship-ready with one or two
  operator edits."

## MCP Tools Used

- Google Drive: `drive_read_file` (spec + source page if reachable)
- WebFetch: `provenance.generated_from` to re-fetch the source page
- Bash: writing the verdict YAML to a temp path

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-15 | Initial skill paired with /ace:video-from-program-page. Six dimensions covering voice, stats, coherence, fidelity, tagline, and compression. | ACE team |
