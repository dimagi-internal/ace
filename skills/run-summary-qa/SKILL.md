---
name: run-summary-qa
description: >
  QA the ace-web public run-summary page for an opp/run before sharing it: fetch the
  summary payload, check EVERY link on it (apps, connect opportunity, chatbot,
  walkthroughs, dashboards, training docs), and confirm each resolves as expected —
  a broken link (404/DNS/5xx) fails, and so does a private ACE-authored Google
  deliverable (PRIVATE-DELIVERABLE); a third-party auth-gated link (login redirect /
  401 / 403) is a valid pass. Run it whenever you're about to hand someone the
  run-summary URL.
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
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
python3 "$ACE_ROOT/scripts/check-summary-links.py" <opp-slug> <run-id> \
  [--workspace dimagi-team] [--base https://labs.connect.dimagi.com/ace] [--json] \
  [--reviewer <email> ...] [--memberships <readbacks.json>]
```

**`--reviewer` is MANDATORY whenever you are QA'ing the summary in order to
share it with named people** — which is the only reason to run this skill
(ace#1060). Pass one `--reviewer` per person, plus `--memberships` pointing at
the read-backs the existing tools already produce:

| Surface | Read-back |
|---|---|
| HQ, OCS | `npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/grant-review-access.ts" --dry-run` |
| Connect | `connect_add_org_member`'s pre-read of `/organization/member_table` (`lib/connect-member-table.ts`, ace#911) |

Shape: `{"hq": {"a@b.c": true}, "ocs": {...}, "connect": {...}}`. **Without it
every reviewer is `MEMBER-UNVERIFIED`, and that blocks** — "we did not check"
is not "it is fine", and treating it as fine is the entire bug.

It classifies each link and exits non-zero iff any link is **BROKEN**,
**PRIVATE-DELIVERABLE**, or carries a `MEMBER-MISSING` / `MEMBER-UNVERIFIED`
verdict for a named reviewer. It resolves page-relative URLs against the summary page
URL before checking, so a root-relative link like the footer's `workbench_url`
is checked exactly as a browser would follow it:

| Class | Meaning | Verdict |
|---|---|---|
| ✅ `OK` | 2xx, resolves publicly (e.g. a Drive anyone-with-link video) | pass |
| 🔒 `AUTH-GATED` | redirects to a sign-in page, or 401/403, on a **login**-gated surface (e.g. labs dashboards — any CCHQ account reaches them) | pass |
| 🚫 `PRIVATE-DELIVERABLE` | 401/403/sign-in redirect on `docs.google.com` / `drive.google.com` — an **ACE-authored deliverable** that is shared with nobody | **FAIL — share it before sharing the summary** |
| 👤 `MEMBER-GATED` | same anonymous signature, but on a **membership**-gated surface: HQ `/a/<domain>/`, OCS `/a/<team>/`, Connect `/a/<org>/` | **NOT a pass on its own** — see below. |
| ➖ `REACHABLE` | other 3xx/4xx that isn't a hard failure | inspect |
| ❌ `BROKEN` | 404 / 410 / 5xx / DNS failure / unreachable | **FAIL — fix before sharing** |

**Per-reviewer classes** (only emitted with `--reviewer`):

| Class | Meaning | Verdict |
|---|---|---|
| ✅ `MEMBER-OK` | the read-back confirms this person is a member of that surface | pass |
| ❌ `MEMBER-MISSING` | the read-back says they are NOT | **FAIL — grant access first (`skills/share-run-access`)** |
| ❌ `MEMBER-UNVERIFIED` | no read-back was supplied for that (surface, person) | **FAIL — go get the evidence** |

**Why this is a gate and not a reminder.** For three runs the confirmation was
prose in this checker's own output, and the confirming got done by an agent
choosing to comply — at exactly the moment (about to send a reply) when it
feels already-done. On 2026-07-23 that produced a written claim to an external
partner, *"you already had access there, so nothing to do"*, that a read-back
showed was false and that stayed false for a week.

And the failure never announces itself: **a reviewer without membership gets a
flat 404**, indistinguishable from "this run doesn't exist". It reads to them
as us shipping a broken link — which is exactly how ace#913 and ace#916 reached
us, from the same reviewer.

**MEMBER-GATED is never a pass on its own — signing in is not enough.** The checker
probes **anonymously**, so it can only prove a link is reachable to *somebody*. HQ, OCS
and Connect org pages gate on **membership**: a visitor who is signed in but is not a web
user on that HQ domain / not on that OCS team / not in that Connect org gets a hard
**404** — those surfaces deliberately don't leak the existence of projects you can't see.
Anonymously that is indistinguishable from a plain login gate, which is why the checker
used to certify these green. Before sharing, for each MEMBER-GATED link either:

1. confirm every named reviewer actually holds membership on that surface
   (`share-run-access`, and read the membership back — don't assume an invite landed), or
2. don't present the link to them as reviewer-facing. **Prefer this for HQ and OCS**: those
   URLs are the *app builder* and the *chatbot admin console* — internal build tools, the
   wrong artifact for a program reviewer even when access exists.

Never report a run as "safe to share" while a MEMBER-GATED link is unresolved for the
people you're about to send it to. (Origin: 2026-07-23, `hh-poverty-targeting/20260722-1341`
— the checker reported `13 links · 0 BROKEN · ✅ safe to share`; the external reviewer we
sent it to hit 404 on both app links and "Shucks. We couldn't find that." on the chatbot.
dimagi-internal/ace#913.)

**PRIVATE-DELIVERABLE is enforced by the checker — you do not have to remember it.**
A `docs.google.com` / Google Slides / `drive.google.com` URL that we produced as a
*deliverable* (training deck, LLO/FLW guides, FAQ, onboarding email, open-questions,
any doc under `products.*` meant for the recipient to open) returns **401/403 when it
is private**. Unlike a Connect/HQ/OCS platform login, a private Google Doc only opens
for accounts explicitly shared on it, so the recipient of the public summary link hits
"You need access." The checker therefore gives it its own class and its own non-zero
exit — the rule used to live only in this paragraph, and on
`spark-facilitator/20260813-2126` it duly reported `12 links · 0 BROKEN` while **every
one** of the run's Google Doc deliverables 401'd. Fix each one with
`drive_set_anyone_with_link` on its file_id (default `role: reader`; pass
`role: 'commenter'` when the reviewer is expected to leave feedback in the doc — a
reader physically cannot comment) and re-check until it reports `OK 200`. Only a
*platform* login gate (Connect, CommCare HQ, OCS, labs) legitimately stays AUTH-GATED.

**Nothing sets anyone-with-link on these docs at creation today.** Only the image/deck
paths do (`app-screenshot-capture`, `common-screenshot-capture`, `training-deck-render`
share PNGs so Slides can import them). Until a producer-side fix lands (jjackson/ace#902),
this check plus the manual `drive_set_anyone_with_link` IS the mechanism — do not assume
an earlier phase handled it.

**On any BROKEN or PRIVATE-DELIVERABLE link, do NOT share the summary — fix the
underlying cause first:**

- A **wrong host / dead domain** (e.g. a `nova.dimagi.com` build-tool URL that doesn't
  resolve) → the ace-web summary serializer or the run_state product wrote a bad URL;
  fix the source, don't paper over it. Internal build-tool artifacts generally should
  not appear on a stakeholder summary at all.
- A **404 on a real entity** (e.g. a Connect `program` page that 404s while the
  `opportunity` correctly login-redirects) → the URL scheme is wrong or the entity has
  no stakeholder page; correct the product URL or stop surfacing it.
- A **Drive artifact that isn't shared** (anything the checker classed
  **PRIVATE-DELIVERABLE**) → set it anyone-with-link (`drive_set_anyone_with_link`, with
  `role: 'commenter'` if the reviewer should be able to comment) so recipients can open
  it, then re-check for `OK 200`.
- A **relative link that resolves to a 404** (e.g. `workbench_url` missing the `/ace`
  deployment path prefix) → the ace-web serializer emitted a path that only works from a
  different mount point; fix it in ace-web, don't hand out the summary in the meantime.

Re-run until the checker reports **✅ No broken links**. Note: a summary change that
lives in ace-web code only takes effect after that ace-web PR deploys (GitHub Actions
on merge to `main`); a change that's pure `run_state` data is live on the next fetch
(the checker passes `?force=1` to bypass the summary cache).

## Report

State the summary URL, the count checked / broken / private-deliverable, and — per
failing link — the URL,
its failure, and the fix applied. **Name every MEMBER-GATED link and say who it was
resolved for** (membership confirmed, or link withheld as internal); "safe to share" is
only claimable once none are outstanding. A clean run: "N links checked, 0 broken;
K auth-gated (valid), M public-OK, J member-gated resolved for <names> — safe to share:
<url>."

## MCP tools used

None — a read-only `python3` link checker over public HTTP (`scripts/check-summary-links.py`)
plus `drive_set_anyone_with_link` when a Drive artifact needs sharing.
