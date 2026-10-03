---
name: release-check
description: >
  Decide whether a run is ready to put in front of a partner: READY or NOT READY, with blockers and fixes. Use before releasing a run.
disable-model-invocation: false
---

# release-check

`/ace:release-check <workspace>/<opp>/<run-id> [--read-only]`

One pass across EVERYTHING a run produced, ending in ONE verdict — **READY** or
**NOT READY** — with blockers (must fix) and warnings (should fix), each naming
the skill that owns it and the route to fix it. "Ready to release" used to be a
claim; this makes it a gate. `/ace:release` invites nobody unless the latest
release-check for that run is READY and newer than the run's last write.

**It re-implements no gate.** It runs or reads the gates that already exist —
every `-qa` result, every `-eval` verdict, `connect-opp-setup`'s post-condition,
`output-preview-capture`, `run-surface-audit`, `ocs-chatbot-qa`,
`app-release-qa` — and rolls their evidence up (`lib/release-check.ts`, pinned by
`test/lib/release-check.test.ts` over the real evidence of
`spark-facilitator/20260926-1800`). Re-runnable and idempotent: each run replaces
the previous verdict and report.

## Inputs

| Source | What |
|---|---|
| The run folder (Drive) | every file's path + modifiedTime; the text of each QA result, eval verdict and chatbot transcript (`scripts/release-check.ts inventory`) |
| `run_state.yaml` | steps that ran, products, Phase 4's decided payment units / verification rules |
| ace-web | the run's outputs (`GET …/opps/<opp>?run_id=<run>`), the preview gap list (`…/runs/<run>/preview-gaps?refresh=true`), the public summary |
| Live systems | Connect (opportunity / payment units / invites), labs, HQ, OCS public chat, canopy — each with its own headless session (`scripts/browser-sessions.ts`) |

## Products

- `<run>/release-check_verdict.yaml` — machine-readable, `lib/release-check.ts`
  `ReleaseVerdict` (schema below). Real YAML bytes (`drive_upload_binary`,
  `text/yaml`), at the RUN ROOT next to `run_state.yaml`.
- `<run>/release-check_report.md` — the same verdict for a human, rendered as a
  Google Doc (`drive_create_doc_from_markdown`).

```yaml
schema_version: 1
kind: release-check
workspace: <ws>            # the workspace the run lives in (a clone's, after a clone)
opp: <opp>
run_id: <run-id>
checked_at: <ISO>
run_last_write: <ISO>      # newest write in the run folder the check saw (release-check files excluded)
verdict: READY | NOT_READY
read_only: <bool>          # a dry run — never releasable
counts: {blockers: N, warnings: N}
areas:                     # qa | eval | connect | previews | links | public-summary | chatbot | apps | hq | run-state
  qa: {blockers: N, warnings: N}
blockers: [{id, area, severity: blocker, owner, detail, fix, summary, action, merged?}]
warnings: [{id, area, severity: warning, owner, detail, fix, summary, action, merged?}]
```

`summary` / `action` are plain language for whoever releases the run (no skill
names or payload paths); `detail` / `fix` stay for the build team and existing
readers, and ace-web prefers `summary` / `action`. Findings that share one root
cause are ONE item: the folded ids are in `merged` and the item keeps the
highest severity, so readiness never changes (`lib/release-check-plain.ts`;
e.g. the review-page eval that stops on a missing reviewer list folds into that
finding).

## Process

Resolve the run folder (`resolve_opp_path` → `runs/<run-id>`), download
`run_state.yaml` locally (`drive_read_file` `writeToPath`), and pick a scratch
dir. `$RC` below is
`node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/release-check.ts"`.

1. **Inventory.** `$RC inventory --run-folder <id> --out inventory.json`.

2. **Gates — every QA result and eval verdict of every step.** These come from
   the inventory in step 8 — a `fail`, a result that is not the canonical shape
   (ace-web shows it as "0/0 checks"), an unparseable verdict, an eval below its
   pass band (anything but `pass`, or under its gate threshold), a step whose
   `-qa` / `-eval` has no file, or an artifact regenerated after its gate (stale
   by more than the copy window a fork's copies land in). Before assessing,
   **re-run every gate that is missing or stale** — dispatch the gate skill
   itself (`Skill(build-memo-eval)`, `Skill(training-deck-render-eval)`,
   `Skill(demo-data-setup-qa)`, `Skill(semantic-registry-author-qa)`, …) — then
   re-run step 1. Under `--read-only`, run each gate with its writes going to
   the scratch dir instead, and pass them with `--overlay
   {"<run path>": "<local file>"}` in step 8.

3. **Connect post-condition (live).** In one parallel message, at the holding
   org: `connect_get_opportunity`, `connect_list_payment_units`,
   `connect_list_flw_invites({phone: "${ACE_E2E_PHONE}"})`; save each JSON, then
   `$RC postcondition --run-state … --opportunity … --payment-units … --invites … --out postcondition.json`.
   The rules are `connect-opp-setup`'s Step 11: what would block the Phase 6 walk,
   and `is_test` off, block a release; a refused verification write (ace#2419) is
   a warning the memo must state.

4. **Output previews.** `scripts/output-preview-capture.ts gaps --opp … --run …
   --refresh > gaps.json`. Any gap → run `output-preview-capture` for the run
   (all phases, `--run-end`), then fetch again. Then **LOOK** at a sample of the
   preview frames — at least one per phase that has previews, and every frame
   captured today: a login page, an error, an empty report or the WRONG thing (a
   different program, opportunity or bot) is a blocker. Record each look as
   `{frame, ok, detail}` in `looks.json`.

5. **Links, for the intended audience.** `$RC links --workspace … --opp … --run …
   --run-state … --out links.json` loads every output a reviewer is given with
   the session its host needs, and the public summary and the chatbot's public
   chat ANONYMOUSLY. Solicitations open in their own labs program context. Drive
   documents are checked by the summary audit (next), which probes them as an
   outsider.

6. **The public run summary.** `scripts/audit-run-surface.ts <opp> <run>
   --workspace … --json --render --run-state … --run-files <paths json>` (paths
   from the inventory) `> surface.json`; add `--reviewer <email>` per intended
   reviewer when known, and `--doc-source` when the source markdown is at hand.
   Then `verify_run_claims` on `claims.yaml` if the run has one → `claims.json`
   (`{all_met, unmet, not_reached}`). If the audit reports `broken`, also run
   `run-surface-audit-eval`.

7. **Chatbot and apps.** If the newest `ocs-chatbot-qa_transcript*.md` is older
   than 7 days or records a failed exchange, run `ocs-chatbot-qa --quick` (and
   re-inventory). Apps need a released build per app in run_state and a passing
   `app-release-qa` result — both read from the inventory.

7b. **HQ plan.** `commcare_get_subscription(domain: <the apps' HQ space>)` →
   save as `hq-plan.json`. The space comes from run_state
   (`products.apps.domain`, else the domain in an app's `hq_url`;
   `hqDomainFromRunState`). A new space is on Free until a Dimagi HQ
   superuser sets it to "Test or Demo Project" (Enterprise, not invoiced) —
   normally done at clone setup (`clone-to-new-workspace` checklist item 1b). That is
   blocker `hq-plan-free:<space>`, owned by **HQ superuser (operator)**,
   whose fix is the exact URL and clicks (`lib/hq-enterprise-flip.ts`, also
   printed by `$RC hq-flip-steps --domain <space>`). `/ace:release` Step 0.4
   walks the operator through it. An unread plan is its own blocker, never a
   pass.

8. **Verdict.**
   ```bash
   $RC assess --workspace <ws> --opp <opp> --run <run-id> --inventory inventory.json \
     --run-state run_state.yaml --gaps gaps.json --postcondition postcondition.json \
     --links links.json --surface surface.json [--claims claims.json] [--looks looks.json] \
     --hq-plan hq-plan.json [--overlay overlay.json] [--read-only] --out-dir <scratch>/out
   ```
   Missing evidence is its own blocker ("not checked"), never a pass. Upload
   `release-check_verdict.yaml` (`drive_upload_binary`, `text/yaml`) and the
   report (`drive_create_doc_from_markdown`, name `release-check_report.md`) to
   the RUN ROOT — **except under `--read-only`, which writes nothing to Drive.**

9. **Report** the verdict line, then every blocker as its `summary` and `action`
   (owner and technical fix beneath), then the warnings. A NOT READY run is not a failure of this skill — it is its answer.

## The gate `/ace:release` calls

```bash
$RC gate --workspace <ws> --opp <opp> --run <run-id> --verdict <local release-check_verdict.yaml> --inventory <fresh inventory.json>
```

Exit 0 only when the verdict is READY, is for this workspace/opp/run, was not a
read-only dry run, and nothing in the run folder was written after it
(`releaseGate`). Otherwise it prints why — the blockers, or "the run changed
after the check" — and the release stops.

## MCP Tools Used

- **ace-gdrive:** `resolve_opp_path`, `drive_read_file`, `drive_upload_binary`,
  `drive_create_doc_from_markdown`, `verify_run_claims`.
- **ace-connect:** `connect_get_opportunity`, `connect_list_payment_units`,
  `connect_list_flw_invites`, `commcare_get_subscription` (read-only).
- Skills it dispatches: the gate skills above, `output-preview-capture`,
  `run-surface-audit-eval`, `ocs-chatbot-qa`.

## Mode Behavior

- **Auto / default / review:** identical — no pause. It writes only its own two
  files and whatever the gates it re-runs write.
- **`--read-only` / dry-run:** no Drive writes, no gate writes into the run
  (they go to the scratch dir and in via `--overlay`); the verdict says
  `read_only: true` and can never release.

## Related skills

- `release-run` (`/ace:release`) — invites nobody unless this says READY.
- `clone-to-new-workspace` — runs this as its last step, to report (not block).

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-10-01 | Initial version. READY / NOT READY over every gate's evidence (`lib/release-check.ts`), with `/ace:release` refusing a run whose latest check is not READY and fresh. First read-only run, spark-facilitator/20260926-1800: NOT READY, 7 blockers (two hand-rolled QA results, an unparseable learn-app verdict, demo-data-setup-qa failing on the worker-review URLs, build-memo-eval at 6.2 warn, training-deck-render-eval at 4.66 fail, two evals never run), 3 warnings. | ACE team |
