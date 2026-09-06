---
name: nova-capability-adoption
description: >
  Adopt new Nova functionality and retire its workaround. Use when a Nova
  release lands, or a doc claims a Nova gap.
disable-model-invocation: false
---

# Nova Capability Adoption

Nova is an external service ACE does not own, and it ships continuously — 81
tools on 2026-08-14, 95 on 2026-08-17, 110 on 2026-09-01. When it grants a
capability ACE asked for, **nothing fails**. The workaround keeps working, no
error fires, and the doc that says "Nova can't do this" quietly becomes false
while every reader keeps believing it.

That silence is the whole problem. `skills/upstream-regression-triage` covers
the loud inverse — *what worked now fails*. This skill covers the quiet one:
*the thing we asked for shipped, and we are still paying for its absence.*

The bill is not hypothetical. `voidcraft-labs/nova-plugin#8` closed 2026-06-03
and a 471-line XML-patching workaround stayed documented as the path for ~three
months, costing menu icons, picture-choice options, and media that vanished on
every rebuild. The i18n channel shipped over a weekend and ACE spent three days
building English-only UIs. The fixtures channel had shipped before anyone here
checked.

## The one rule that makes this skill different

**A `tools/list` entry is not a capability.** Confirm it EXISTS, then prove it
WORKS on ACE's own path, and keep those two answers separate — because the
remedy depends on which one you got.

This is not caution for its own sake. Run on 2026-09-01, this skill found that
Nova's `create_lookup_table` worked perfectly while binding a select to the
table it had just created was refused every time. Adopting on the strength of
the tool list would have retired a halt whose only job is to stop ACE shipping
an invented option list into a partner's own published process — a defect with
no downstream symptom, since the app is complete, internally consistent with
its own invention, and passes every structural gate.

*(That block has since lifted: `voidcraft-labs/commcare-nova#545` closed
COMPLETED 2026-09-02 and the bind was adopted on 2026-09-06, ace#1886. The
example is kept in the past tense because the LESSON is not about lookups —
five ACE files had absorbed the inertness as fact, and one of them had re-ranked
a build ladder around it. Do not read this paragraph as a live constraint; the
current contract is in `playbook/integrations/nova-integration.md § The
fixtures (Project data table) channel`.)*

So: **correct the REASON; do not soften the REMEDY.** A primitive that exists
can still be inert, and saying precisely which is the fix. The same sentence
appears in `test/docs/upstream-absence-claims.test.ts`, and it is the single
most important line in this procedure.

## Inputs

- A trigger: a Nova release, a tool count that moved, a doc asserting a Nova
  gap, `scripts/probe-upstream-asks.ts` reporting a closed upstream ask, or a
  human saying "X works now".
- `NOVA_API_KEY` in the process env or the installed plugin-data `.env`.
- Authenticated `gh` for the upstream repo, `voidcraft-labs/commcare-nova`.
  Never guess a slug: the plausible-looking alternatives do not resolve, and a
  404 reads as "no upstream changes" to an unattended agent — the opposite of
  the truth. `upstream-regression-triage § Process` step 3 holds the full
  table, guarded by `test/skills/upstream-repo-slugs.test.ts`.

## Products

- A `## The <capability> channel — shipped <date>, adopted <date>` section in
  `playbook/integrations/nova-integration.md`, carrying a **Contract facts —
  observed live, not inferred** block.
- A durable probe under `scripts/probe-nova-<capability>.ts` with a pure,
  unit-tested verdict function, when the capability is partly usable.
- Corrected text at every site that claimed the gap.
- A row in `test/docs/upstream-absence-claims.test.ts`.
- Upstream issues for whatever is still blocked.

## Process

### Step 1 — Confirm the surface exists

```bash
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/probe-nova-contract.ts"   # live tool count
```

Compare against the last count recorded in
`playbook/integrations/nova-integration.md`. A jump is the signal; the tools
that appeared are the subject. Read their schemas **from the live
`tools/list`** — never from a paraphrase in a skill, and never from your own
memory of a similar API.

Nova's descriptions carry real contract detail (atomicity, revision guards,
limits). Read them. They are how you learn that `create_lookup_table` takes
5000 rows in one write, which is the difference between adopting it and
adopting it badly.

### Step 2 — Prove it works, end to end, on a throwaway

**This is the step that earns the skill.** Build the smallest real thing the
capability claims to support, on a scratch app you delete afterwards.

Call Nova by **direct JSON-RPC**, not through the in-session MCP client:
`https://mcp.commcare.app/mcp`, `Bearer $NOVA_API_KEY`, `tools/call`. The
in-session client has a documented credential hazard where a stored OAuth token
outranks the PAT and answers *normally, about a different account* — see
`playbook/integrations/nova-integration.md § Install + auth`. A probe that
silently ran as someone else is worse than no probe.
`scripts/probe-nova-fixtures.ts` has a working helper to copy.

**Leave no state behind, and re-run the probe twice before trusting it.**
Nova objects are not all app-scoped — a lookup table lives on the *Project* and
survives `delete_app`, keeping its unique tag. A probe that cleans up only the
app therefore passes once and fails ever after with an error that reads exactly
like an upstream regression. Clean up every object you created, surface a
cleanup failure loudly rather than swallowing it, and make the second run prove
the first one tidied up.

**Then re-derive the teardown when the capability actually LANDS — adopting it
changes what cleanup requires (ace#1886).** This is the half the rule above
missed, and it is not obvious: the object a probe creates while a capability is
inert is *inert too*, so tearing it down is trivial. The moment the capability
works, the probe starts creating a real, referenced object — and the teardown
that was correct yesterday silently stops working. The fixtures probe hit this
exactly. While the bind was refused, `remove_lookup_table` → `delete_app` was
right; the day the bind landed, the bound field became a reference and the same
sequence started leaking a Project-scoped table on **every green run**, warning
about it in a line nobody reads because the probe exits 0. Worse, `delete_app`
does not release the reference — a soft-deleted app still appears in
`blockingApps` for ~30 days — so there is no ORDERING of the two calls that
works; the reference itself has to be dropped first (`remove_field` → re-read
the revision, which the removal bumps → `remove_lookup_table` → `delete_app`).

So: when a probe flips from "blocked" to "works", **re-read its teardown against
the new state before trusting the next run**, and assert the tidy-up rather than
warning about it. A leak here is uniquely nasty because it manufactures the
symptom of the thing the probe exists to detect.

Record every behaviour you had to discover rather than infer. Those become the
**Contract facts** block, and they are the highest-value output of this skill —
each line is a call the next reader does not have to burn.

Then classify honestly:

| Outcome | Meaning | Remedy |
|---|---|---|
| Works end to end | Adopt fully | Wire the consumer, delete the workaround |
| Exists, refuses on ACE's path | **Inert** | Correct the reason; **keep** the remedy; file upstream; land a tripwire |
| Not there | Nothing shipped | Stop. Do not edit a single doc |

**Beware a refusal that claims to be transient.** Nova's lookup-binding refusal
said *"wait for lookup data to reconnect, then retry"* and never reconnected
(until it was fixed upstream months later). Before believing such a message,
retry with backoff, retry minutes later, and retry on a **fresh app with fresh
objects**. If all three refuse, it is permanent *for now* and the misleading
wording is itself worth reporting.

**And beware the mirror image: an ACCEPTANCE that proves nothing.** A write that
returns no error is not evidence the write took effect — read the object back
and check the field you set. Nova's `add_fields` answers a *correctly bound*
lookup field with `"options": []` and no mention of the source at all, so on
that path "no error" would pass a bind that never happened AND reading the
response's own `options` would fail one that did. The fixtures probe scored the
bind this way for its whole life and would have certified a broken adoption
(ace#1886). **Verify a capability by reading state back, never by the mutation's
own response** — and put the check in a pure function the consumer shares, so
the probe and the skill cannot drift on what success means.

### Step 3 — Inventory the cruft

Search for text that asserts the gap. Absence claims cite nothing, so no
tracker finds them — you must grep:

```bash
git ls-files -z skills lib agents docs playbook commands scripts templates \
  | xargs -0 grep -nEi "no (MCP )?atom|not yet autonomous|UNVERIFIED|browser-session-only|workaround"
```

Three things to know:

- **Claims wrap across lines.** A sentence like `Nova has no MCP atom\nthat
  creates a <thing>` defeats a single-line grep. Read the surrounding block; do not trust
  the grep count alone.
- **Look for the workaround, not just the sentence.** The expensive cruft is a
  library that exists *because of* the gap (`lib/option-register.ts`'s CSV
  emitter, the 471-line media patcher). Its header comment usually states the
  false premise outright.
- **Changelog rows inside a SKILL.md are read as fact.** They are history, but
  an agent reads the file whole, and a present-tense "Nova has no X" in a dated
  row misleads exactly as much as one in the body. Supersede it in place with a
  date; do not rewrite what happened.

### Step 4 — Adopt

Write the playbook section first — the other edits cite it. Follow the shape
the i18n and media channels already use, because a reader who has seen one can
navigate the next:

```markdown
## The <capability> channel — shipped <date>, adopted <date>
### The tools                                  <- table: tool | what it does
### Contract facts — observed live <date>, not inferred
### What this means for ACE, exactly           <- the behaviour change, stated
### The tripwire                               <- only if partly blocked
```

Then correct every site from Step 3. At each one, ask the Step 2 question
again: does this text's REMEDY still hold? If the capability is inert, the
remedy stays and only its justification changes. Say what is blocked, name the
upstream issue, and point at the probe.

Where the capability is only partly usable, **adopt the half that works.** ACE
can build and populate a partner's register even though it cannot bind it —
that is not nothing; it removes a manual step from the handoff.

### Step 5 — Ratchet, so it cannot rot again

Add a row to `test/docs/upstream-absence-claims.test.ts`:

```ts
{
  primitive: 'create_lookup_table',
  declaredAt: 'Nova MCP tools/list at https://mcp.commcare.app/mcp (110 tools)',
  upstreamRef: 'voidcraft-labs/commcare-nova#545',
  shipped: '2026-09-01 (confirmed; ship date upstream is earlier and unrecorded)',
  absenceClaims: [/\bno\s+MCP\s+atom\s+that\s+creates\s+a\s+lookup\s+table/i],
  mustCite: /commcare-nova#545/i,
  mentions: /(?<![a-z_])create_lookup_table\b/,
}
```

Then **prove the guard fails.** Append the claim to a real file, watch the test
go red, restore, watch it go green. A guard that has never failed is not known
to work — and these regexes are easy to get subtly wrong.

Two traps this file will teach you the hard way:

- **Anchor `mentions` against namesakes.** `commcare_create_lookup_table` is
  ACE's CommCare **HQ** atom and has nothing to do with Nova's. Use
  `namesakePaths` for a subsystem that legitimately owns the bare name.
- **Do not quote the retired claim verbatim** in your own correction — the
  guard cannot tell an assertion from a citation of one, and it will fire on
  your fix. Paraphrase ("a missing create atom") instead.

Where the capability is inert, also land a **tripwire probe** with a pure
verdict function and exit codes that say what to do next
(`scripts/probe-nova-fixtures.ts`: `0` adopt fully, `2` still blocked, `3`
regression; invoke it through `$ACE_ROOT` as above). Prose asks to be re-read; an exit code gets checked.

### Step 6 — Close the loop upstream

File what is still blocked against `voidcraft-labs/commcare-nova`, per
CLAUDE.md § filing rules: search first **in its own Bash call**, verify the
premise against the artifact and quote what you ran, label the blast radius,
and include a minimal reproducer — the exact calls, in order, with payloads.

Report in the run summary: what was adopted, what stayed and why, the upstream
issue, and the exit code a future reader should expect from the tripwire.

## Recurring shapes

| Shape | Tell | Where it went wrong before |
|---|---|---|
| Granted ask, unnoticed | An upstream issue ACE filed is CLOSED, workaround still documented | nova-plugin#8, ~3 months, media |
| Prompt-absence encoded as fact | "The architect has no X step" written down once | i18n; Nova shipped guidance days later |
| Exists but inert | Tool in `tools/list`, refuses on the real path | fixtures; commcare-nova#545 |
| Namesake confusion | Same bare name in two systems | `commcare_create_lookup_table` vs Nova's |

**A prompt-absence observation has a shelf life.** Reading the architect's
operating prompt and finding no mention of a feature is a fact about *today*.
Never encode it as a durable constraint; re-read it, or make a probe do so.

## MCP Tools Used

None directly — every call goes over direct JSON-RPC to
`https://mcp.commcare.app/mcp` (Step 2 explains why). Read tool schemas from
the live `tools/list`, and see `docs/atom-schemas.md` for ACE's own atoms
rather than paraphrasing any signature inline.

## Mode Behavior

Read-only through Step 3. Steps 4–6 write to the repo and file upstream issues;
ship them via `skills/shipping` like any other change. Never edit a doc on the
strength of Step 1 alone.

## Related skills

- `upstream-regression-triage` — the loud inverse: what worked now fails.
- `shipping` — branch → PR → wait → merge → verify.
- `_app-component-library.md` — where Nova build primitives are named for the
  architect; usually a consumer of whatever this skill adopts.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-09-06 | **Step 2 gains two rules the first run needed and did not have (ace#1886).** Adopting the fixtures BIND four days after `voidcraft-labs/commcare-nova#545` closed exposed both. (1) *Verify by read-back, never by the mutation's response.* `scripts/probe-nova-fixtures.ts` had scored the bind as `!error` since it was written, and Nova answers a correctly-bound lookup field with `"options": []` — so that check could neither confirm nor deny, in either direction, and would have certified the adoption without ever observing a bind. (2) *Re-derive the teardown when a capability lands.* The skill already said to clean up and run twice, which the probe did; what it could not anticipate is that the object it creates stops being inert. Once the bind worked, the bound field became a reference, `remove_lookup_table` began failing `referenced` on every green run, and no ordering of it with `delete_app` helps because a SOFT-deleted app holds the reference for ~30 days. Three tables leaked before this was understood. Both rules generalise past Nova: a probe that stops tidying up manufactures the exact symptom it exists to detect. | ACE team |
| 2026-09-01 | **Created, from the fixtures adoption.** Generalises the procedure run by hand three times — the i18n channel (2026-08-17), the media channel (2026-08-27, three months late), and fixtures (2026-09-01). The fixtures run is why Step 2 exists as a separate gate rather than a footnote to Step 1: `create_lookup_table` was live and complete, and binding a select to its output was refused every time (`voidcraft-labs/commcare-nova#545`), so a tool-list-only adoption would have retired `pdd-to-deliver-app § Step 4f`'s partner-register halt and shipped invented options into a partner's app. Step 5's ratchet and both of its traps come from adding the fixtures row: the citation check had hardcoded the previous entry's symbol, and `create_lookup_table` collides with ACE's unrelated HQ atom. | ACE team |
