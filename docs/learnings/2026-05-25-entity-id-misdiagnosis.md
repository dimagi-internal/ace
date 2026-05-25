# 2026-05-25 — `entity_id` misdiagnosis: PR #445 swapped the canonical pattern for a broken one based on a rescan with no captured artifact

## TL;DR

PR #445 (2026-05-24, commit `749888e`) flipped the recommended `connect.deliver_unit.entity_id` override from `#case/case_id` (canonical, Vellum-source-of-truth) to `#case/case_name` (broken at install time). The change was driven by a `/canopy:select-session` rescan citing a Nova validator rejection in the `e2e-malaria-rdt` 2026-05-24 run — but no artifact was captured (no `validate_app` response, no error string, no app id), and the change contradicted an explicit verified learning from one day prior.

The broken guidance shipped through Nova's validator, CCHQ's build, CCHQ's release, and `app-release-smoke`'s structural CCZ projection — all green. Then exploded at Phase 6 on `bednet-spot-check/20260525-1405` when the device tried to install the Deliver app and CommCare's runtime install path rejected the CCZ with "A part of your application is invalid."

Reverted in this commit; new REQUIRED rule added to `pdd-to-deliver-app/SKILL.md` warning explicitly against the substitution; structural preventer (commcare-cli.jar install simulation) drafted separately as Preventer 2.

## Why `#case/case_name` is wrong on a case-create form

CommCare's mobile install path (`app/src/org/commcare/android/resource/installers/XFormAndroidInstaller.java:99-106`) parses each form's resource graph at install time, BEFORE any case is created and BEFORE any hidden-field `calculate` fires. When the form's `connect.deliver_unit.entity_id` binds to `#case/case_name`, and `case_name` is a hidden field with `calculate: concat(#user/username, '-', uuid())` (the typical pattern for a unique case_name on a case-create form), the install-time resource graph reads null — the calculate hasn't run yet — and throws `InvalidResourceException`, which maps to `notification.install.invalid.title` = "A part of your application is invalid."

`#case/case_id` does NOT have this problem because JavaRosa allocates the case UUID synchronously at the START of form processing (before any field-level calculates fire). The UUID is resolvable from that point forward. This is exactly what `case_id` is for, and exactly what Vellum's help text cites as the canonical example (`voidcraft-labs/nova-plugin` Vellum `src/commcareConnect.js:243`).

## Why the architect's diagnosis was wrong

PR #445's narrative ("case_id is the new UUID being assigned mid-form and isn't a resolvable reference at submission time") inverts when JavaRosa allocates UUIDs vs when hidden-field calculates run:

- **JavaRosa case-create allocates UUID at the start of form processing.** `case_id` is resolvable from that point — install-time resource graph included.
- **Hidden-field `calculate` fires at field-evaluation time during form playback, NOT at install.** A hidden field that uses `uuid()` doesn't have a value until the form is being filled out by the FLW (or the form-submit calculate chain runs at end).

So the substitution didn't actually solve the alleged "not resolvable" problem — it created a new "really not resolvable at the install step" problem, but masked it because Nova's static validator doesn't simulate the install path.

## Why every Phase 3 gate missed it

| Gate | What it does | Why this slipped through |
|---|---|---|
| Nova `validate_app` | Server-side schema + XForm rules + reference completeness | Doesn't simulate the device install path. `#case/case_name` is a syntactically valid XPath; validator accepts it. |
| CCHQ `make_build` | Compiles the app-state into a versioned build | Same — compile passes; no install simulation. |
| CCHQ `release` | Marks build as `is_released: true` | Pure metadata flip. No install simulation. |
| `app-release-smoke` projection | Counts `<learn:deliver>` / `<learn:module>` markers, checks slug collisions + lengths via `projected_connect_state` | Structural only — doesn't bind any XPath. |

The class-level gap: **no Phase 3 step exercises the CCZ in a CommCare runtime context.** Every check is static. The runtime evaluates expressions that the static gates can't.

(`commcare-cli.jar validate` from `dimagi/commcare-core` runs the SAME install path the device runs and IS the right structural preventer — tracked separately as `2026-05-25-bednet-smoke-phase6-install-rejection.md § Preventer 2`.)

## Why the rescan-driven PR slipped through

`/canopy:select-session` rescans are useful for surfacing patterns the original session missed, but they have a structural risk: the rescan recommendation may not have access to the actual evidence the original session DID have. PR #445 was the canonical failure mode of this risk:

- The rescan saw an architect substituting `#case/case_name` for `#case/case_id` during the e2e-malaria-rdt 2026-05-24 run
- The rescan inferred a Nova validator rejection ("the architect must have hit one")
- No artifact (validate_app response, error message, app id, reproducer) was preserved
- The rescan's recommendation contradicted `docs/learnings/2026-04-29-nova-connect-marker-bugs.md:92-95`, which records that on 2026-05-23 (ONE DAY EARLIER) ACE verified live against Nova app `onyIxf7jEqGKv8HmcTIS` that `entity_id: "#case/case_id"` round-trips through Nova as-passed — and that learning is marked "Status: Resolved — all bugs fixed upstream"
- The PR went through review and shipped

## Process fix

**`/canopy:select-session`-style findings that recommend skill-text changes contradicting an existing verified learning MUST require artifact capture before landing.**

Specifically:
- A `validate_app` response (the actual rejection JSON)
- The full sent payload (the args to `update_form` or `add_field`)
- The Nova app id at which the rejection was observed
- The diff between the rescan's understanding of skill state vs. the actual current skill state

If the rescan can't provide these, the recommendation becomes "investigate further with the original session's transcript" — not "ship a contradicting skill change."

This is consistent with the broader CLAUDE.md rule "**Class-level preventers > instance-level fixes.**" The instance-level fix (substitute `#case/case_name`) shipped without verifying it didn't break a different class (install-time resource resolution). The class-level lesson here is: **before recommending a substitution for a "rejected" pattern, verify the substitution doesn't break the original problem class differently.**

## What changed in this commit

- `skills/pdd-to-deliver-app/SKILL.md` — reverted PR #445's diff (restored `#case/case_id` as the canonical override) + added new REQUIRED rule "`entity_id` on a create-form MUST resolve at install/parse time, not at submit time" with this incident as the reproducer
- `playbook/integrations/nova-integration.md` — reverted PR #445's `e2e-malaria-rdt` observation block; restored "No known upstream bugs" → "Notable capabilities" connector
- `docs/learnings/2026-05-25-bednet-smoke-phase6-install-rejection.md` — companion learning capturing the run-level details + 3 preventers
- `docs/learnings/2026-05-25-entity-id-misdiagnosis.md` (this file) — captures the misdiagnosis story + process fix

## Citations

- Wrong PR: jjackson/ace#445, commit `749888e` (2026-05-24)
- Contradicted prior learning: `docs/learnings/2026-04-29-nova-connect-marker-bugs.md:92-95`
- Vellum source-of-truth: voidcraft-labs/nova-plugin Vellum `src/commcareConnect.js:240-249`
- CommCare error source: commcare-android `app/src/org/commcare/android/resource/installers/XFormAndroidInstaller.java:99-100, 104-106`, `tasks/ResourceEngineTask.java:149-151`, `engine/resource/AppInstallStatus.java:35`
- Companion learning (run-level + structural preventers): `docs/learnings/2026-05-25-bednet-smoke-phase6-install-rejection.md`
