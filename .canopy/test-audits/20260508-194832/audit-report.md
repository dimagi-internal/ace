# Test Audit — ACE (revised)

**739 tests** — keep 715, refactor 15, prune 9, investigate 0.

> **First pass was rubber-stamped.** Original verdicts were 7/739 — implausible for AI-assisted codebases. After user pushback, deep sibling-reading on 9 files (~150 of 739 tests) raised the candidate count meaningfully and surfaced consistent AI-test patterns. The remaining ~580 tests still default to `keep, ok` — they were not deep-read. Treat this as a partial audit with credible findings, not a complete one.

## Patterns found in deep-read files

Across 9 files (decisions-schema, idea-to-pdd-qa/checks, pdd-to-test-prompts-qa/checks, commcare-patch-xform, nova-contracts, decisions-renderer, artifact-manifest-lint, fixtures/artifact-manifest, eval-skill-yaml-drift):

| Pattern | Examples | Action |
|---|---|---|
| **Migration regression-pins** — assert the *absence* of a removed phrase | `does not retain the pre-Nova "Current Workaround" section` (×3 in nova-contracts.test.ts) | Refactor: delete or move to a one-off CI assertion bound to the migration window. |
| **TS-redundant invariants** — assert a fact the TypeScript compiler already enforces | `every check has type, description, and run` (×2 across check files); `all checks are static type` | Prune. TS interface compliance is checked at compile time. |
| **Schema rubber-stamps** — `expect(schema.parse(valid)).not.toThrow()` with no negative pair | `accepts a valid pass result` / `accepts a valid fail result` (qa-types); `accepts an optional notes field` (decisions-schema) | Prune or fold into a stronger sibling test. |
| **Tautology-adjacent positives** — `expect(arr.length).toBeGreaterThan(0)` next to a structural test that already implies length>0 | `returns a non-empty array of Docs API requests` (decisions-renderer) | Prune. |
| **Library-coverage tests** — `expect(() => yaml.parse(invalid)).toThrow()` — testing the library, not the wrapping | `throws on unparseable YAML` (decisions-schema) | Prune. The library is not the system under test. |
| **Same-code-path redundancy** — multi-input variants of a simple loop | `fails when multiple sections missing` next to `fails when one section is missing` | Prune the multi-input variant. |
| **Cross-file duplicates** — same lint invariant in two files | `manifest has no duplicate paths` in both `test/lib/artifact-manifest-lint.test.ts` and `test/fixtures/artifact-manifest.test.ts` | Prune the duplicate; relocate the survivor to the lint file. |
| **Mis-located lint tests** — fixture-file tests doing manifest-lint work | `has all nine phases represented`, `every artifact has at least a producedBy` (fixtures/artifact-manifest) | Refactor: relocate to artifact-manifest-lint. |

These patterns are well-known AI-codegen tells. Density across the deep-read set was ~10% (15/150 tests flagged). Extrapolating to the full corpus suggests ~60–80 candidates total, not 7.

## Top prune candidates (9)

- `lib/qa-types.test.ts::accepts pass with no detail` and the two `accepts a valid X result` siblings — schema rubber-stamps; fold into the `validateQAResult helper round-trips` test (already exercises happy path with field-level assertions).
- `test/lib/decisions-schema.test.ts::rejects an empty id` — redundant with the parametrized `rejects an id with %s` it.each table; add 'empty' to the table and delete.
- `test/lib/decisions-schema.test.ts::accepts an optional notes field` — zod-rubber-stamp.
- `test/lib/decisions-schema.test.ts::throws on unparseable YAML` — tests the yaml library.
- `test/skills/idea-to-pdd-qa/checks.test.ts::fails when multiple sections missing` — same code path as the single-missing variant.
- `test/skills/idea-to-pdd-qa/checks.test.ts::every check has type, description, and run` — TS-enforced.
- `test/skills/idea-to-pdd-qa/checks.test.ts::every check is type: static (no LLM checks for idea-to-pdd-qa)` — snapshot of incidental state.
- `test/skills/pdd-to-test-prompts-qa/checks.test.ts::all checks are static type` — same shape as idea-to-pdd-qa.
- `test/lib/decisions-renderer.test.ts::returns a non-empty array of Docs API requests` — implied by the next test in the cluster.
- `test/fixtures/artifact-manifest.test.ts::manifest has no duplicate paths` — cross-file duplicate of artifact-manifest-lint version.
- `test/mcp/ocs/smoke.test.ts::vitest smoke::runs` — `expect(2+2).toBe(4)` tautology.

## Refactor candidates (15)

- 5 OCS integration "tests" with no assertions — `test/mcp/ocs/e2e*.integration.test.ts::*`. Sequencing steps disguised as tests; move to `beforeAll`/`afterAll` or add explicit `await expect(promise).resolves...` assertions.
- 3 nova-contracts "does not retain Current Workaround" tests — post-migration scarecrows that pin the absence of a removed phrase. Delete or scope to a transient CI assertion.
- `test/lib/decisions-schema.test.ts::round-trips an empty decisions array` — parametrize with the main round-trip test.
- `test/skills/idea-to-pdd-qa/checks.test.ts::passes with multiple data rows` — parametrize with single-row sibling.
- `test/lib/decisions-renderer.test.ts::includes a HEADING_2 paragraph style update for each phase header` — parametrize with multi-phase sibling.
- `test/fixtures/artifact-manifest.test.ts::has all nine phases represented` — relocate to artifact-manifest-lint.test.ts.
- `test/fixtures/artifact-manifest.test.ts::every artifact has at least a producedBy` — relocate.
- 2 `lib/qa-types.test.ts::accepts a valid X result` — combine with negative siblings or fold into round-trip.

## Investigate

None.

## Files I didn't deep-read

About 70 files containing ~580 tests still default to `keep, ok`. Highest-yield candidates for a follow-up audit, ordered by likely smell density:

1. `test/lib/verdict-schema.test.ts` (16 tests, avg_assert=1.2) — same shape as decisions-schema, likely 3-4 candidates.
2. `test/mcp/ocs/playwright-backend.test.ts` (41 tests) — large file, redundancy clusters likely.
3. `test/mcp/connect/unit/playwright-fallbacks.test.ts` (29 tests, avg 3.4 assertions) — fallback variants prone to "test each variant independently" redundancy.
4. `test/mcp/connect/unit/html-scrape.test.ts` (30 tests) — HTML parsing variants.
5. `test/scripts/migrate-drive-layout.test.ts` (20 tests) — script tests; check for snapshot patterns.
6. `test/scripts/run-form-walk.test.ts` (18 tests, avg 4.0 assertions) — likely thorough but worth confirming.
7. `test/lib/atom-payload-resolver.test.ts` (20 tests) — already noted same-name false-positives across describe blocks; worth a real read.

Recommended: a second `/canopy:test-audit` run with a per-file deep brief instead of the full-corpus default.

## Suite-level architectural findings (still valid)

(Full version in `architecture-review.md`.)

1. **Module inventory is incomplete.** Canopy's vitest adapter pairs `src/<x>` (or `lib/`/`app/`/`source/`) with tests; doesn't walk `mcp/`. ACE has ~85 source files under `mcp/` not inventoried. The "untested_modules" list reflects only `lib/`.
2. **Mock density is uniformly low.** Strong real-fakes-over-mocking pattern. No file flagged as overmocked.
3. **One slow test:** `test/mcp/ocs/rest-backend.test.ts::sendTestMessage uses the widget chat API (start → send → poll)` — 2003ms.
4. **Test pyramid is healthy** (~7:2:1 unit:integration:e2e) and integration tests are env-gated correctly.

## Canopy bugs surfaced during this audit

Two issues in the brand-new vitest adapter showed up running it for real against ACE:

1. **Fixed (PR #41):** fallback scan was using `_SKIP_SRC_DIRS` instead of `_SKIP_TEST_DIRS`, missing tests under `test/`. Reproduced as soon as ACE didn't have `node_modules` and the regex fallback kicked in.
2. **NEW (not yet filed):** vitest list reporter emits leaf names without describe-path. Multiple tests with the same leaf name collapse to the same nodeid (e.g., 3 `invokes /nova:autobuild` tests in nova-contracts.test.ts share one corpus entry; one verdict applies to all). This breaks per-test verdicting for files that use describe-blocks heavily. Fix: read the task tree from vitest list (or use the jest-compat reporter) and prepend describe path to nodeid.
3. **NEW (not yet filed):** test names containing quote characters get truncated in the YAML corpus dump (e.g., `does not retain the pre-Nova "Current Workaround" section` → `does not retain the pre-Nova `). The collapse + truncation together make some nova-contracts tests indistinguishable in verdicts.yaml.
4. **NEW (not yet filed):** `module_inventory` only walks `src/`/`lib/`/`app/`/`source/`. ACE keeps ~85 source files under `mcp/` that get no untested-modules signal. Should accept `--source-roots` or expand the default walk.

I'll file (3) and (4) as canopy issues after we close out this audit.

## What this audit IS — and what it ISN'T

**Is:** an honest partial audit. Deep-read 9 files (~150 tests). Found ~24 candidates with concrete, citable smells. Documented patterns that would generalize to the rest of the suite.

**Is not:** a complete audit. Most of the corpus defaulted to `keep, ok` based on structural signal alone. The first pass through this loop was a rubber stamp; the user caught it; this revision is more honest but still partial. To finish the job: run a second pass focused on the highest-yield files listed above, or pass `--scope <file>` to canopy if/when that's supported.
