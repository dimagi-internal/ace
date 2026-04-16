# Product Management Learnings

Items closed or rejected during PM cycles. Read this before every scout run to avoid re-proposing.

## Closed Items

(none yet)

## Preferences

- **Runtime-health checks should be WARN, not FAIL.** When adding `/ace:doctor` (or similar) checks that test whether a user is ready to *use* a feature (vs. whether the install works), use WARN. A user doing a design-review-only run shouldn't see FAIL for missing OCS config. FAIL is reserved for "tool won't run at all." (2026-04-15, from P3 implementation)
- **Skills that read external-human inputs must fail loudly, not improvise.** If a skill's input is `producedBy: 'external'` in the artifact manifest and the file isn't there, the skill must stop with an actionable error — never invent content. The orchestrator is responsible for capturing the input; the skill is responsible for defending against the bypass path (`/ace:step`). (2026-04-15, from P1 implementation)
- **Smoke-test scripts on the current machine before committing.** Bash / shell changes to `bin/` that look right in the diff can still break on live env data (quoting, quotes, empty values, etc.). Run the script at least once locally with `--here` or equivalent before staging. Caught a quote-stripping bug on 2026-04-15 that would have shipped otherwise.
- **Passing tests can still hide fixture drift against a spec/manifest.** A green `npm test` is not the same as "the fixture matches the canonical shape declared in `lib/artifact-manifest.ts`." The 2026-04-16 scout found three gaps (stale `state.yaml`, missing `test-prompts.md`, missing Phase 4–6 artifacts) that all passed CI because the test was pinned to `upToPhase: 'connect'`. When a change to the manifest / phase structure / skill contracts lands, re-check fixtures against the full manifest — don't rely on the test alone. (2026-04-16)
- **3-fixture coverage model.** `CRISPR-Test-001` = partial input fixture for `ocs-agent-setup` (Phase 1–3 inputs only); `CRISPR-Test-002` = focus-group archetype stress fixture (Phase 1–3); `CRISPR-Test-003-Turmeric` = complete E2E fixture with every required artifact stubbed across all 6 phases. When adding new skills / artifacts, update CRISPR-Test-003-Turmeric first (it's the one the manifest test validates end-to-end). (2026-04-16)
