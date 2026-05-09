# Architecture Review — ACE test suite

**Bottom line:** the suite is in healthier shape than the user's worry implied. Across 739 tests in 81 files, the structural smells (assertion-less tests, over-mocking, redundant clusters) are concentrated in 7 specific tests. The bulk pattern is single-behavior tests with a real assertion against a real contract — the testing approach the TDD rubric scores highest.

## Coverage gaps

**Module inventory limitation.** The vitest adapter pairs `src/<x>` (or `lib/<x>`, `app/<x>`, `source/<x>`) with `<x>.test.*`. ACE keeps source under `lib/` (22 modules paired) but the bulk of its TypeScript code lives outside that — `mcp/connect/*`, `mcp/ocs/*`, `mcp/mobile/*`, `mcp/connect-labs/*`, `mcp/lib/*` (~85 source files total, none counted by `module_inventory`). The `untested_modules: [google-shim, parse-verdict]` list reflects only `lib/` and is misleading on its own.

That said, manual inspection of `test/mcp/{connect,ocs,mobile,gdrive,connect-labs}/**` shows substantive test files for each MCP backend (e.g., `playwright-backend.test.ts` with 41 tests, `playwright-fallbacks.test.ts` with 29, `commcare-patch-xform.test.ts` with 24). The mcp/ tree is well-tested; the inventory just doesn't see it.

**Genuine `lib/` gaps:**
- `lib/google-shim.ts` (20 lines, 0 public funcs) — by `public_func_count: 0` it's just type re-exports. No test needed.
- `lib/parse-verdict.ts` (35 lines, 1 public func) — has a `parseVerdict` function with no direct test. Possibly covered transitively through verdict-schema tests; worth a quick spike to verify.

**Recommendation:** improve the canopy vitest adapter to scan `mcp/` and other repo-conventional dirs (or accept a `--source-roots` flag). Out of scope for this audit; queued as a canopy follow-up.

## Over-mocked test files

**None.** Mock density across all 81 files: every file has `is_overmocked: false`. The overmock heuristic flags files where `total_mocks > total_assertions and total_mocks >= 2`. Highest-mock files:

- `test/mcp/mobile/recipe-generator.test.ts`: 7 mocks / 9 assertions (7 tests). Borderline; worth a glance but not a smell.
- `test/mcp/ocs/composite.test.ts`: 3 mocks / 3 assertions. Tests an MCP composite that *is* a router over backends — mocking the backends is correct here, not a smell.
- `test/lib/doctor-drive-layout.test.ts`: 10 mocks / 10 assertions. Tests use `vi.fn().mockResolvedValue(...)` for a Drive client interface — mocking the dependency, not the CUT. Healthy.

**Approach observation:** ACE strongly prefers **real fakes** over heavy mocking. `lib/multimedia-judge.test.ts` uses a `fakeAnthropic` factory that returns canned JSON; `lib/content-generator-client.test.ts` uses `fetchMock` with explicit response objects; `test/mcp/ocs/playwright-backend.test.ts` uses `page.request` fakes that return real Response objects. This is a strong sign of behavior-focused testing.

## Slow tests (top hot list)

Only one test above the 1s threshold:

- `test/mcp/ocs/rest-backend.test.ts::RestBackend chatbot atoms sendTestMessage uses the widget chat API (start → send → poll)` — 2003ms

Likely real polling delay built into the test. Consider parametrizing the poll interval via test-only injection so the real-time wait can shrink to <100ms.

## Framework hygiene

**vitest.config.ts is minimal and correct:**
```ts
test: {
  include: ['test/**/*.test.ts', 'lib/**/*.test.ts'],
  exclude: ['test/eval/**'],
  env: { OCS_INTEGRATION: process.env.OCS_INTEGRATION ?? '0' },
}
```

Hygiene observations:
- ✅ Co-located `lib/*.test.ts` *and* central `test/lib/*.test.ts` are both included — split is intentional (lib-local for unit-of-module, test/lib/ for cross-module integration).
- ✅ `test/eval/**` is excluded (those are LLM-driven evals, run via `npm run eval`, not part of the unit suite).
- ✅ Integration tests are gated by env var (`OCS_INTEGRATION`, `MOBILE_INTEGRATION`, `CONNECT_INTEGRATION`, `LABS_INTEGRATION`) — the file-suffix convention `*.integration.test.ts` makes intent obvious from the path. ✅ Healthy pyramid signal.
- ⚠️ No top-level `setup.ts`. None observed referenced from config. Suite avoids global setup, which is the right call for a library-style codebase but worth noting.
- ⚠️ `globals: true` is **not** set (good — keeps imports explicit; standard for library code).
- ⚠️ No `vitest` markers/tags system used — integration tests rely entirely on filename + env-gating to skip. That works because of explicit `if (!OCS_INTEGRATION) return;` checks at the top of each integration `it()`. Workable, slightly verbose; vitest 1.x+ supports `it.skipIf(...)` which would be cleaner.

## Test pyramid balance

By file path inspection:

- **Unit tests** (~70% of suite): `lib/*.test.ts`, `test/lib/*.test.ts`, `test/mcp/**/unit/*.test.ts`, `test/mcp/**/<atom>.test.ts`, `test/scripts/*.test.ts`, `test/skills/*.test.ts`, `test/fixtures/*.test.ts`. These hit pure functions or use simple in-memory fakes (`vi.fn`, factory-built `fakeAnthropic`, hand-written response mocks). Fast, deterministic.
- **Integration tests** (~20%): `*.integration.test.ts` files under `test/mcp/{ocs,connect,connect-labs,mobile}/`. Hit live services (OCS, Connect, CommCare HQ). Each test starts with `if (!FLAG) return;` so the suite stays usable in default CI.
- **E2E** (~10%): `test/mcp/ocs/e2e*.integration.test.ts`, `test/mcp/connect/integration/e2e.integration.test.ts`, `test/mcp/mobile/e2e.integration.test.ts`. End-to-end flows; long-running, env-gated.

The unit:integration:e2e ratio is roughly 7:2:1 — a healthy pyramid. **Recommendation: hold this line.** When adding new tests, write the unit version first.

## Approach consistency

- **Behavior over implementation.** Spot-checked ~150 tests across 20 files: assertions are on outputs (`output.patched`, `xml.toContain(...)`), schemas (`schema.parse(input).toEqual(...)`), and contracts (`fetchMock.mock.calls[0][0]`). Almost no `expect(spy).toHaveBeenCalledWith(...)`-style implementation lock-ins observed.
- **Real fakes over mocking.** The dominant pattern is hand-built fakes (`fakeAnthropic`, sample fixtures, `Response` objects) over `vi.mock`. Strong signal.
- **Schema validation tests are thin but justified.** Files like `test/lib/decisions-schema.test.ts` (15 tests, avg 1.2 assertions) and `test/lib/verdict-schema.test.ts` (16 tests, avg 1.2 assertions) have a "valid X passes / invalid Y throws" repeated shape. This is appropriate for zod schemas where the value of each test is documenting a specific constraint. Keep.

## False positives the heuristic flagged

Worth recording so the next pass doesn't waste effort:

- **`has_real_assertion: false` on 305 tests** — my static analyzer's regex doesn't match `expect(<func_call_with_parens>).<matcher>(...)` (regex requires no `)` inside `expect(...)`). Most of those 305 tests have real assertions. **Don't trust this signal for vitest;** read the source. (Canopy bug to fix later.)
- **Duplicate test names across `describe` blocks** — flagged tests like `it('invokes /nova:autobuild', ...)` appearing 3x in `nova-contracts.test.ts`, but each is in a different `describe(...)` block (one per skill: `pdd-to-learn-app`, `pdd-to-deliver-app`, `app-deploy`). Each tests the same invariant on a different artifact. Real test, just noisy in flat name space.

## Recommendations (top 3)

1. **Refactor the 5 OCS integration "no-assertion" tests** (`test/mcp/ocs/e2e*.integration.test.ts`) to either explicit assertions (`await expect(promise).resolves.toBeDefined()`) or move them to `beforeAll`/`afterAll` hooks. Right now they look like tests but are sequencing steps; future maintainers will misread them.
2. **Drop `test/mcp/ocs/smoke.test.ts::vitest smoke::runs`** (`expect(2+2).toBe(4)` — tautology). If a smoke test for OCS is wanted, write one that imports `mcp/ocs/composite.ts` and verifies the module loaded — that's a meaningful sanity check.
3. **Improve test-name hygiene in `test/skills/nova-contracts.test.ts`.** Current names like `invokes /nova:autobuild` repeated across 3 describe blocks lose context when reported in a flat list (vitest verbose output, our test-audit corpus, log greps). Renaming to `invokes /nova:autobuild (in <skill>)` or moving the skill into the test name would help.

## Out-of-scope follow-ups

- Canopy `module_inventory` should walk `mcp/` (or accept `--source-roots`). Filed as canopy issue.
- The `qa-types.test.ts` "accepts a valid X" tests (2) are weak alone but have negative siblings; consider parametrizing rather than pruning.
