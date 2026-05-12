# Connect `short_description` 50-char Trap (Phase 3 HTTP 500 Root Cause)

**Status:** Open upstream (commcare-connect serializer/model mismatch). Mitigated client-side in ACE by tightening the atom Zod schema to `max(50)`.

**Origin:** turmeric run `20260511-2053` Phase 3 — `connect-opp-setup` failed with HTTP 500 across 5 attempts before bisect.

## What looked like the bug (prior framing)

Carried forward from `mcp/connect-server.ts` and `agents/commcare-setup.md`:

> "Connect's `/opportunity/init/` *now* tolerates these [Nova in-form
> `<assessment xmlns="…connect…">` wrappers] (post-2026-04 server fix),
> so Phase 3 succeeds."

And, separately:

> "Server has an upper bound around ~250 chars [on `description`] before
> HTTP 500s start firing **intermittently**."

Both were inferred from observation, not from reading Connect's code. The
"intermittent" label was the giveaway — every consistent deterministic bug
gets labelled "intermittent" until you actually bisect it.

## What the bug actually is

Schema mismatch in commcare-connect:

| Field | Serializer (`program/api/serializers.py:131`) | Model (`opportunity/models.py:92`) |
|---|---|---|
| `Opportunity.short_description` | `serializers.CharField(max_length=255)` | `models.CharField(max_length=50, null=True)` |

When the wire payload has `short_description` of 51–255 chars:

1. DRF serializer validates clean (under its 255 cap).
2. `serializer.save()` calls `ManagedOpportunity.objects.create(short_description="…51 chars…", …)` inside `transaction.atomic()`.
3. Postgres raises `DataError: value too long for type character varying(50)`.
4. `commcare-connect/program/api/views.py:102` only catches `httpx.RequestError`/`httpx.TimeoutException`/`httpx.ConnectError`/`CommCareHQAPIException`/`AppNoBuildException` — `DataError` bubbles up.
5. Django returns HTTP 500 with no actionable response body.

## Proof (bisect 2026-05-12 against program `e62dcb06-5d06-4392-9b5d-8f5015b2cddd` on connect.dimagi.com)

All other fields identical. `short_description` was the only variable.

| chars | result |
|---|---|
| 49 | HTTP 201, opp created cleanly (id `1c8a872f-6a8d-4efa-ae97-597c32ef6aca`) |
| 50 | 30s hang (separate boundary symptom — unrelated; the row never lands) |
| 51 | instant HTTP 500 |

The deterministic switch from 201 (49) → 500 (51) at the 50-char boundary
matches `varchar(50)` semantics exactly. Connect's create-and-sync path is
otherwise fast and healthy — no CCHQ slowness, no in-form wrappers issue.

## Why prior Phase 3 runs "worked"

They didn't survive *because* the server tolerated wrappers — they survived
because their `short_description` happened to be ≤ 50 chars. Once an opp's
PDD-derived headline crept past 50, every cycle 500'd. Confirmation bias from
the AVD-runtime fix (commcare-form-patch) anchored the wrong causal story for
weeks.

## Reproduction recipe (for QA / regression)

```sh
# Pre-flight: have `ACE_HQ_API_KEY`, OAuth session for connect.dimagi.com,
# released Learn + Deliver HQ apps in `connect-ace-prod`, and an `ai-demo-space`
# accepted ProgramApplication for an existing program.

# Then call connect_create_opportunity with identical args, varying ONLY
# short_description char count: 49, 50, 51.
# Expect: 201, hang, 500. Deterministic on every run.
```

A standalone repro lives in this run's Drive folder (`ACE/turmeric/runs/20260511-2053/3-connect/`) — see the bisect transcripts.

## Fix

### Client-side (this commit)

- `mcp/connect-server.ts` `connect_create_opportunity.short_description`: tighten from `z.string().max(255)` to `z.string().max(50)` with a description block explaining the upstream mismatch and citing this learning.
- `mcp/connect-server.ts` `connect_update_opportunity.short_description`: same change for the optional update variant.
- `agents/commcare-setup.md` Step 2.8 background: replace the wrong "Connect tolerates wrappers" claim with the correct provenance (wrappers benign for sync; commcare-form-patch is AVD-runtime-only).

After these changes, an over-cap payload fails fast in Zod before any network round-trip, with a clear error pointing at the right field.

### Upstream (commcare-connect)

Align the serializer to the model (or vice versa). The right choice is probably to widen the model column to `max_length=255` to match the existing DRF contract — many callers may already rely on >50 char headlines. If the 50-char limit is intentional, tighten the serializer to `max_length=50` and document in the API contract.

File the upstream issue/PR. Until that lands, the ACE-side Zod cap holds.

## Generalization — the QA-replicating-server-logic pattern

The user's correct framing was: "stop trusting 'intermittent', see if you can prove a deterministic logic error". The proof technique that worked:

1. Read the server's actual route handler + serializer + model end-to-end.
2. Replicate the relevant business logic locally (Python script, against the same CCZ artifacts).
3. Cross-reference every length cap / type / constraint on every wire field.
4. Bisect against the live server with a controlled A/B (49 vs 51 chars).

This pattern generalizes. Add a similar client-side pre-check shim for any
class-of-bug where the server's failure mode is opaque (500 with no body, 30s
hang, etc). ACE already has analogs:

- `assertParentOnSharedDrive` — pre-flights Drive parent before write (catches My-Drive quota footgun)
- `assertCollectionPromptInvariant` — enforces the OCS `{collection_index_summaries}` cross-field rule pre-publish
- `ocs_shared_collection_team` doctor probe — pre-flights team-scope before bootstrap

`short_description.max(50)` is the same shape: a structural pre-flight that turns "intermittent server 500" into "Zod validation error" before any network round-trip. Adding more of these is cheap and self-documenting.

## Files touched

- `mcp/connect-server.ts` — Zod schema tightening on `connect_create_opportunity` + `connect_update_opportunity`
- `agents/commcare-setup.md` — Step 2.8 background corrected
- `docs/learnings/2026-05-12-connect-opp-short-description-50-char-trap.md` — this file
