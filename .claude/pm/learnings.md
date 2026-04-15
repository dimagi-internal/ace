# Product Management Learnings

Items closed or rejected during PM cycles. Read this before every scout run to avoid re-proposing.

## Closed Items

(none yet)

## Preferences

- **Runtime-health checks should be WARN, not FAIL.** When adding `/ace:doctor` (or similar) checks that test whether a user is ready to *use* a feature (vs. whether the install works), use WARN. A user doing a design-review-only run shouldn't see FAIL for missing OCS config. FAIL is reserved for "tool won't run at all." (2026-04-15, from P3 implementation)
- **Skills that read external-human inputs must fail loudly, not improvise.** If a skill's input is `producedBy: 'external'` in the artifact manifest and the file isn't there, the skill must stop with an actionable error — never invent content. The orchestrator is responsible for capturing the input; the skill is responsible for defending against the bypass path (`/ace:step`). (2026-04-15, from P1 implementation)
- **Smoke-test scripts on the current machine before committing.** Bash / shell changes to `bin/` that look right in the diff can still break on live env data (quoting, quotes, empty values, etc.). Run the script at least once locally with `--here` or equivalent before staging. Caught a quote-stripping bug on 2026-04-15 that would have shipped otherwise.
