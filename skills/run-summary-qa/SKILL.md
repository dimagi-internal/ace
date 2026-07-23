---
name: run-summary-qa
description: >
  QA the ace-web public run-summary page for an opp/run before sharing it: fetch the
  summary payload, check EVERY link on it (apps, connect opportunity, chatbot,
  walkthroughs, dashboards, training docs), and confirm each resolves as expected —
  a broken link (404/DNS/5xx) fails; an auth-gated link (login redirect / 401 / 403)
  is a valid pass. Run it whenever you're about to hand someone the run-summary URL.
---

# Run-summary QA — verify every link on the ace-web summary works

The **run-summary page is ACE's canonical shareable output** — a clean per-run summary
plus the live links (apps, Connect opportunity, chatbot, demo video + dashboards,
training docs). It is served by ace-web and reads `run_state.yaml` products live from
Drive. Its stable URL is:

```
${ACE_WEB_BASE_URL}/opps/${ACE_WEB_WORKSPACE}/<opp-slug>/runs/<run-id>/summary
```

Defaults: `ACE_WEB_BASE_URL=https://labs.connect.dimagi.com/ace`,
`ACE_WEB_WORKSPACE=dimagi-team` (the ACE ace-web workspace). The public summary is
un-authed ("the URL is the secret"), so anyone with the link can open it — which is
exactly why every link on it must actually work before you share it.

## When to run

- Before sharing the run-summary link with anyone (a stakeholder email, Slack, a gate).
- At the end of a `/ace:run` (the orchestrator close-out surfaces the URL — QA it then).
- After you edit `run_state.yaml` products that feed the summary (apps, connect, ocs,
  synthetic walkthroughs/dashboards, training).

## Process

Run the link checker — it fetches the summary payload, extracts every `http(s)` URL,
and HTTP-checks each:

```bash
python3 scripts/check-summary-links.py <opp-slug> <run-id> \
  [--workspace dimagi-team] [--base https://labs.connect.dimagi.com/ace] [--json]
```

It classifies each link and exits non-zero iff any link is **BROKEN**:

| Class | Meaning | Verdict |
|---|---|---|
| ✅ `OK` | 2xx, resolves publicly (e.g. a Drive anyone-with-link video) | pass |
| 🔒 `AUTH-GATED` | redirects to a sign-in page, or 401/403 | pass **iff it's a platform login gate** — a signed-in stakeholder reaches it (Connect, CommCare HQ, OCS are all login-gated by design). **NOT a pass for an ACE-authored deliverable doc** (see below). |
| ➖ `REACHABLE` | other 3xx/4xx that isn't a hard failure | inspect |
| ❌ `BROKEN` | 404 / 410 / 5xx / DNS failure / unreachable | **FAIL — fix before sharing** |

**AUTH-GATED is NOT automatically a pass for an ACE-authored deliverable doc.** A
`docs.google.com` / Google Slides / `drive.google.com` URL that we produced as a
*deliverable* (training deck, LLO/FLW guides, FAQ, onboarding email, any doc under
`products.*` meant for the recipient to open) returns **401/403 when it is private** —
the checker labels that `AUTH-GATED`, but unlike a Connect/HQ/OCS platform login, a
private Google Doc only opens for accounts explicitly shared on it. A recipient who
opens the public summary link hits "You need access." So treat a private ACE-authored
deliverable doc as a **must-fix**, even though its class is AUTH-GATED not BROKEN: run
`drive_set_anyone_with_link` on its file_id (reader / anyone-with-link) and re-check
until it reports `OK 200`. Only a *platform* login gate (Connect, CommCare HQ, OCS,
labs) legitimately stays AUTH-GATED. The producer skills (`qa-and-training` /
`training-*`) should set anyone-with-link at creation so this needs no manual step —
see jjackson/ace#902.

**On any BROKEN link, do NOT share the summary — fix the underlying cause first:**

- A **wrong host / dead domain** (e.g. a `nova.dimagi.com` build-tool URL that doesn't
  resolve) → the ace-web summary serializer or the run_state product wrote a bad URL;
  fix the source, don't paper over it. Internal build-tool artifacts generally should
  not appear on a stakeholder summary at all.
- A **404 on a real entity** (e.g. a Connect `program` page that 404s while the
  `opportunity` correctly login-redirects) → the URL scheme is wrong or the entity has
  no stakeholder page; correct the product URL or stop surfacing it.
- A **Drive artifact that isn't shared** (403/404 on a `drive.google.com` link, or a
  private ACE-authored `docs.google.com`/Slides deliverable that came back **AUTH-GATED
  401/403** per the note above) → set it anyone-with-link (`drive_set_anyone_with_link`)
  so recipients can open it, then re-check for `OK 200`.

Re-run until the checker reports **✅ No broken links**. Note: a summary change that
lives in ace-web code only takes effect after that ace-web PR deploys (GitHub Actions
on merge to `main`); a change that's pure `run_state` data is live on the next fetch
(the checker passes `?force=1` to bypass the summary cache).

## Report

State the summary URL, the count checked / broken, and — per broken link — the URL,
its failure, and the fix applied. A clean run: "N links checked, 0 broken; K auth-gated
(valid), M public-OK — safe to share: <url>."

## MCP tools used

None — a read-only `python3` link checker over public HTTP (`scripts/check-summary-links.py`)
plus `drive_set_anyone_with_link` when a Drive artifact needs sharing.
