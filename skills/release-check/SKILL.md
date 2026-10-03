---
name: release-check
description: >
  Superseded by validate-release-readiness (2026-10-03). This stub remains so older references keep working.
disable-model-invocation: false
---

# release-check → validate-release-readiness

`release-check` was absorbed into `skills/validate-release-readiness/SKILL.md`
(owner decision, Jonathan, 2026-10-03): one validation that does every check
and every non-sharing change a release could need, and on READY writes the
exact release plan `/ace:release` executes.

Read `skills/validate-release-readiness/SKILL.md` and follow it. It needs the
reviewers (`--reviewers` / `--from-thread`) to reach READY. Its verdict file is
`release-readiness_verdict.yaml`; an old `release-check_verdict.yaml` has no
release plan and is never releasable. Do not add content here.
