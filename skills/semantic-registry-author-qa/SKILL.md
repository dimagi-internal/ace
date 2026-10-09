---
name: semantic-registry-author-qa
description: >
  Pass/fail check of an authored semantic registry (live labs validation plus PDD fidelity) before
  any labs write.
disable-model-invocation: false
---

# Semantic Registry Author — QA

Two gates, both must pass. Shared QA contract: [`skills/_qa-template.md`](../_qa-template.md).

1. **Labs grammar** — `mcp__connect-labs__semantic_registry_validate({properties_doc,
   indicators_doc, deployment})` → `valid: true`. Every reference resolves, every
   SQL fragment is on the allow-list, the registry compiles at every scope
   (programme, organisation, opportunity, worker, month, case). It does not run
   the SQL, so a wrong number passes it.
2. **PDD fidelity** — `checkRegistryAuthoring(registry, {pddSections:
   pddSectionIds(pdd), opportunityIds: partners.map(p => p.opportunity_id)})` from
   [`lib/semantic-registry-authoring.ts`](../../lib/semantic-registry-authoring.ts).

## Inputs

| Source | Artifact |
|---|---|
| `semantic-registry-author` | `7-synthetic/semantic-registry-author_registry.json` |
| Phase 1 | the PDD markdown (for `pddSectionIds`) — or, with NO PDD, the Deliver app structure (`--app`, `appFormNames`) |
| `demo-data-setup` § C1 | the partner opportunity ids |

## Products

- `7-synthetic/semantic-registry-author-qa_result.yaml` — per `lib/qa-types.ts`

## Checks (`checkRegistryAuthoring`)

| check | fails when | auto-fix |
|---|---|---|
| `model` | `entity.{name,plural,key}` or `pipelines.entity` missing | declare them — a registry with no model is read as KMC |
| `indicators` / `indicator-meta` | no indicator, or one lacks `label` / `plain` / `category` / `direction` / `scope_note` | fill from the PDD row |
| `measures` | an indicator's `_numerator` / `_denominator` measure is missing or unread by its value | add the measure / fix the value's `sql` |
| `pdd-anchor` | `scope_note` cites no PDD section — numbered (`PDD §8.1`) or by heading name (`PDD § Success Metrics`, the only form ACE's unnumbered PDD template allows, ace#2803) — or only sections the PDD lacks; with no PDD (`--app`), names no form of the released Deliver app | cite the section (or the app form), or drop the indicator |
| `target` | a target the `scope_note` does not quote, a % target outside 0–100, a target without higher/lower | cite the PDD's number, or remove the target |
| `bands` | % bands written as fractions (`0.8`) — every cell grades green | write `80` |
| `headline` | duplicate position, or beyond `display.headline_count` | renumber |
| `display` | missing title / entity / worker / organisation nouns, an unlisted category, a bad `case_fields` format | fill from the PDD vocabulary |
| `display-text` | a string the cascade RENDERS (`display.title`, `targets_note`, nouns, categories, `reading` / `case_fields` / `visit_fields` labels, `visit_flags` labels + descriptions, indicator `label` / `plain`) carries a design-document reference (`PDD`, `§`, a section number like `8.1`), an internal indicator code (`P1`, `S-1`, `SF_P1`), a comparison symbol for words (`≥`, `≤`) or a snake_case column name — `lib/registry-display-text.ts`, ace#2748 | rewrite it for a programme manager (`semantic-registry-author` § 3): "a meeting in at least 80% of each community's weeks", "the pilot design"; keep the citation in `scope_note` |
| `llo-map` | a partner opportunity missing from `deployment.llo_map`, or fewer organisations than the floor: 3 for invented partners, 2 with `--partner-source programme` (below 3 there is a `warn`, since the benchmark then exposes a peer's figures) | map every opportunity |

`warn` findings (bands without a target, an over-long `plain`, no `case_fields`)
are reported and do not fail the gate.

## Result — one outcome per check, through the shared writer

Run both gates and write the result in one step:

1. `mcp__connect-labs__semantic_registry_validate({properties_doc, indicators_doc,
   deployment})` → save the JSON response locally.
2. Read the PDD with **`exportAs: 'text/markdown'`** (`drive_read_file`
   `writeToPath`). The default `text/plain` export drops the `#` heading markers
   `pddSectionIds` keys on, which disables the `pdd-anchor` check without a word.
3. ```bash
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/semantic-registry-author-qa.ts" \
     --registry <semantic-registry-author_registry.json> --pdd <pdd.md> \
     --partners <opp id,opp id,…> --labs-validate <validate.json> \
     --target <opp>/<run-id> --out <local semantic-registry-author-qa_result.yaml>
   ```
   It runs `checkRegistryAuthoring`, turns the report into ONE outcome per check
   (`registryQAOutcomes`: `labs-validate` plus the eleven rows above), fails a check
   whose input was not supplied rather than skipping it, and writes the canonical
   `lib/qa-types.ts` shape through `aggregateQAResult`.
4. Upload it as `7-synthetic/semantic-registry-author-qa_result.yaml`. ace-gdrive
   refuses any other shape (`INVALID_QA_RESULT`, `lib/qa-result-write-guard.ts`).

**Why:** `spark-facilitator/20260926-1800` wrote `{verdict: pass, findings: []}` —
every check had run and passed, but the file carried no `stats`, so ace-web read it
as "Passed (0/0 checks)". The same result through the writer reads 11/11.

## Change Log

| Date | Change |
|---|---|
| 2026-10-06 | New `display-text` check (`lib/registry-display-text.ts`, ace#2748): the registry text the cascade renders must read plainly — no PDD/§/section numbers, indicator codes, `≥`/`≤` or column names. spark-facilitator/20261004-1706's `targets_note` "Targets are the PDD's own (§8.1 P1 ≥ 80%, P3 ≥ 75%)" capped its DDD demo at clarity 2; this check fails it at build time. Twelve outcomes per result now. |
| 2026-10-01 | Result goes through the shared writer (`scripts/semantic-registry-author-qa.ts` → `aggregateQAResult`): one outcome per check, so the file counts what it checked. spark-facilitator/20260926-1800's `{verdict, findings}` result displayed as "Passed (0/0 checks)" on ace-web; re-run against its real registry and PDD it reads 11/11 pass. The PDD is read as `text/markdown` and normalised — the plain export left `pddSectionIds` with no headings, which silently disabled `pdd-anchor`; a missing input now FAILS its check. |
| 2026-09-26 | Created (ace#2510). Positive control: the live-accepted Spark registry (`test/fixtures/cascade/spark-facilitator-registry.json`); one negative control per check in `test/lib/semantic-registry-authoring.test.ts`. |
