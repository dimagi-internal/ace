# `training-*` skill template

Shared conventions for the per-artifact training skills under Phase 6.
Six skills (`training-llo-guide`, `training-flw-guide`,
`training-quick-reference`, `training-faq`, `training-deck-generate`,
`training-onboarding-email`) plus the renderer (`training-deck-render`)
all follow the same skeleton. This file documents the shared shape so
each skill body can reference it instead of duplicating boilerplate.

This is a **reference document**, not a skill. It is not invoked.
Excluded from the skill catalog because the filename starts with `_`.

## Skeleton

```markdown
# <Skill Name>

(1-3 sentence framing — what artifact this skill produces, who reads
the artifact, what Phase 6 sequence position the skill occupies.)

## When to run

(Phase 6 sequencing — which sibling skills must run before, which
skills consume this artifact.)

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| <phase> | `<path>` | <purpose> |

## Output

Single file: `ACE/<opp>/runs/<run-id>/6-qa-and-training/<artifact>.md`

## Format

(Markdown skeleton or YAML schema for the artifact. Each per-artifact
skill defines its own; do not try to share.)

## Format rules

(Per-artifact rules: word budget, voice/tone, screenshot embedding
policy, structural conventions. Each skill's audience and re-run
semantics drive different rules — do not try to share.)

## Support channel — one contract, all six skills (dimagi-internal/ace#1303)

**Worker-facing artifacts** (`training-flw-guide`, `training-quick-reference`,
`training-faq`) name a support channel the worker can actually reach:

1. a **human** — the LLO coordinator / Partner Trainer, and
2. the app's own in-app grievance route (the **GRM menu**), which the PDD
   already designates as the complaint channel.

**Never print OCS credentials in a worker-facing artifact** — not the
`openchatstudio.com` host, not the chatbot `public_id`, not the `embed_key`.
Those are *embed credentials*, not a destination: OCS serves the bot only as an
embedded corner widget, `/chatbots/embed/<public_id>/` live-probes **404**, and
Connect has no per-opportunity widget field to embed it into (CCC-301). A
36-character UUID also cannot be transcribed mid-visit. Phase 5 correctly
produces credentials; Phase 6 has nothing worker-reachable to turn them into,
and inventing a plausible-looking `/chat/<id>` URL is worse than saying so.

Credentials ARE correct in the **LLO-facing** artifacts (`training-llo-guide`,
`training-onboarding-email`) — their recipient is the person doing the
embedding.

This is shared rather than per-skill because the same run produced **three
different answers** to this one question: two artifacts printed the
credentials (flagged independently by `training-quick-reference-eval` and
`training-faq-eval`, the latter calling it "the single most important
finding") and a third declined to invent a link and routed to the coordinator.

**Check before writing:** run the pure helper over the composed markdown —

```ts
import { checkWorkerFacingSupportChannel, formatSupportChannelReport }
  from '../../lib/support-channel-guard';
const report = checkWorkerFacingSupportChannel(markdown);
```

Any finding is a rewrite-before-write, not a warning. It is string logic over
your own output, so it costs nothing and catches the class the evals otherwise
catch one artifact at a time, after the fact.

## Screenshot citations — canonical frames only (dimagi-internal/ace#1304)

Any skill that cites captures from `app-screenshot-capture_manifest.yaml`
selects them through `canonicalCaptures` and never by scanning `captures[]`
directly:

```ts
import { canonicalCaptures, findDuplicateCitations }
  from '../../lib/capture-manifest';
const usable = canonicalCaptures(manifest);            // aliases removed
const bad = findDuplicateCitations(manifest, citedSteps); // pre-write guard
```

A capture marked `duplicate_of: <step>` is **byte-identical** to that step's
frame — the same moment, not a second one. Captioning it as a distinct state
tells a reader the app reached a screen it never showed.

**Verifying that every `file_id` resolves is NOT this check.** Existence and
distinctness are different properties: two producers asserted the first, scored
their own `image_hygiene` near 10, and shipped alias frames captioned as
distinct states anyway — caught only by two independent `-eval` skills after
the fact (ace#1304, the consumer half of ace#866). Any `image_hygiene`-style
self-eval criterion must assert duplicate handling explicitly, or it will keep
scoring 10 on this defect.

## Illustrated guides — render, THEN embed (dimagi-internal/ace#1418)

Applies to the artifacts flagged `illustrated: true` in
`lib/artifact-manifest.ts` — today the FLW guide and the LLO guide. **Not**
`training-quick-reference` (a printed pocket card: no screenshots by design)
and not the FAQ or onboarding email.

Publishing one of these is a **two-step write**, and step 2 is not optional:

1. `drive_create_doc_from_markdown` — converts the prose. Every screenshot
   reference stays as it is written: a Drive link
   `[Connect home](https://drive.google.com/file/d/<fileId>/view)`, or a
   filename citation `` `learn-launch-home-tiles.png` ``. Both are legible
   captions and both survive the conversion.
2. **Embed the frames into the converted doc:**

   ```bash
   ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
   npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/embed-doc-screenshots.ts" <docId> \
     --screenshots <screenshots folderId from the capture manifest's drive_folders>
   ```

   It anchors on the references the prose ALREADY carries and appends those
   frames right after the citing paragraph — no prose added, moved or
   reworded — then re-reads the document and counts the images an ANONYMOUS
   reader gets. Non-zero exit means the pictures are not there. Re-running is
   safe: an already-illustrated paragraph is skipped.

**Why the images cannot just ride in the markdown.** Drive's importer *will*
fetch a real `https` image src (measured 2026-08-14 across four Drive URL
forms — all imported as real, anonymously-visible images). What it will not do
is size them: it takes the natural pixel dimensions, so a 1080x2400 phone
screenshot lands 9.4 inches wide and a page and a half tall, forty-four times
over. `insertInlineImage` takes an explicit `objectSize`. That is the entire
reason for the two-step shape. (`![alt](drive:<id>)` is a separate and older
mistake: `drive:` is an ACE-internal reference, not a URL, and the importer
drops that node silently, alt text included — ace#1338.)

**Why this is a contract and not advice.** Both guides shipped to a partner
with zero images and every word intact, twice, for two different reasons. Word
counts, section checks and all five per-artifact content evals scored them a
pass both times; a partner reading the docs found it, and then the surface
auditor's `DOC-SCREENSHOTS-ABSENT` did. A step-by-step guide whose steps are
not shown is not a step-by-step guide — for a functionally-literate CBF reading
it mid-visit, 44 links is close to useless. Enforced by
`test/lib/illustrated-artifacts.test.ts`.

## Process

1. Read inputs.
2. Compose the artifact per format rules.
3. Self-check against the four-criterion self-eval (per-skill specific).
3b. **Worker-facing skills only:** run the support-channel check above and
   rewrite any finding before writing.
4. Write to Drive.
4b. **Illustrated artifacts only:** run the embed step above and confirm it
   exits 0 with a non-zero anonymous image count.
5. Self-evaluate via LLM-as-Judge — write
   `<artifact>_verdict.yaml` using the verdict shape from
   `skills/_eval-template.md § Verdict YAML contract`.
6. Hand off — print Drive URL + verdict summary.

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

## Why a separate skill

(Per-skill specific — describe this skill's audience, re-run
semantics, and why it owns one artifact instead of being merged with
siblings. Reference the sibling skills explicitly.)

## Change Log

| Date | Change | Author |
|---|---|---|
```

## Per-artifact decomposition rationale

The legacy `training-materials` umbrella was removed in 0.10.89 in
favor of one skill per artifact. The decomposition gives:

- **Independent re-run.** Re-running the FAQ after a PDD edit doesn't
  re-emit the entire LLO guide.
- **Independent eval.** Each artifact has its own four-criterion
  self-eval — verdicts attribute cleanly per artifact.
- **Independent context budget.** Each LLM call sees only the inputs
  it needs (FAQ doesn't need deck-outline context).
- **Phase-8 boundary.** `training-onboarding-email` is consumed by
  Phase 9 LLO onboarding; isolating it from Phase-6-only siblings
  makes the cross-phase dependency explicit.

## Sibling map

| Skill | Artifact | Audience | Sequencing |
|---|---|---|---|
| `training-llo-guide` | `training-llo-guide.md` | LLOs running the deployment | Step 2 (parallel) |
| `training-flw-guide` | `training-flw-guide.md` | FLWs in the field | Step 2 (parallel) |
| `training-quick-reference` | `training-quick-reference.md` | FLWs (printed pocket card) | Step 2 (parallel) |
| `training-faq` | `training-faq.md` | LLOs and FLWs | Step 2 (parallel) |
| `training-deck-generate` | `training-deck-spec.yaml` | Phase 6 internal (input to deck-render) | Step 2 (parallel) |
| `training-onboarding-email` | `training-onboarding-email.md` | Phase 9 (consumed at LLO onboarding) | Step 3 (sequential, after siblings) |
| `training-deck-render` | Google Slides URL | LLO (presents to FLWs / records) | Step 4 (sequential, after deck-generate) |

`agents/qa-and-training.md` enforces the sequencing.

## Common Drive paths

All per-artifact training skills write to:
`ACE/<opp-name>/runs/<run-id>/6-qa-and-training/`

All consume per-opp screenshots from:
`ACE/<opp-name>/runs/<run-id>/6-qa-and-training/screenshots/`

All consume cross-opp Connect screenshots from:
`ACE/_common/connect-screenshots/<connect-version>/`
(produced by the standalone `connect-baseline-screenshots` skill —
NOT a Phase 6 dispatch).

## Verdict shape

Same shape as eval skills — see
`skills/_eval-template.md § Verdict YAML contract`.

The artifact-specific `dimensions` differ per skill (each has its own
four-criterion self-eval) but the verdict envelope, severity rules,
and gate-brief surface follow the shared contract.

## When to update this template

Edit when:
- A new per-artifact training skill is added (update the sibling map).
- The Phase 6 dispatch order changes (update sequencing column).
- A shared contract changes (then also touch `_eval-template.md` if
  the change affects verdict shape or stock blocks).

Per-skill format rules and audience-specific concerns stay in each
skill's own file — do not pull them into this template.
