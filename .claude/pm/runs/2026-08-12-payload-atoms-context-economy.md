# 2026-08-12 — Payload atoms: read the cost, not just the error

## Lens

An `agent-review` finding said `drive_read_file` errors on oversized Drive docs
and proposed `offset`/`limit` paging. Jonathan interrupted before the code was
written: *"are we doing this properly in general? We are moving all tokens
through the session instead of directly downloading first?"*

That reframed the whole thing. Paging fixes the **error**; it does not fix the
**cost** — walking a 68k-char doc in 40k slices still spends 68k chars of
context. The lens became: every atom whose result scales with its input should
hand back a **handle**, not a payload.

## Do it

Six PRs merged, 0.13.744 → 0.13.755.

| PR | What |
|----|------|
| #1177 | `drive_read_file`: `writeToPath` + `offset`/`limit` + typed `oversized_document`; also fixed the atom-schema dumper truncating `.describe()` at the first `)` (85 blanked descriptions) |
| #1178 | Renamed `destPath` → `writeToPath` to match `commcare_download_ccz.write_to_path` |
| #1179 | Same treatment for `drive_download_binary` (closed **#1027**) |
| #1186 | Path containment for 8 sinks + `ocs_download_file.writeToPath` (closed #1110, **#1182**) |
| #1188 | Dumper leaking source-level escapes into 55 catalog cells |
| #1194 | **Reverted #1186's containment** (see below) |
| #1196 | `idea-to-pdd` § 1b/§ 1: `.ccz`/`.xlsx` recipes still decoded `content_base64` |

The three payload atoms now share one param name across servers
(`write_to_path` snake on connect, `writeToPath` camel on gdrive + ocs), so an
agent that learns the escape hatch on one can guess it on the next. That
guessability is most of the value — an escape hatch nobody finds is not one.

Every inline path also got a **typed refusal** naming the cheap mode. Without
it the agent gets an opaque harness truncation and never learns the param
exists — which is exactly how #1027 sat open from 2026-07-28 while two docs
recommended a recipe the atom could not perform.

## Closed

- **#1027** — `drive_download_binary` had no write-to-path mode, so
  `ocs-agent-setup` § 5 and `ocs_upload_collection_files`' own schema had been
  documenting an impossible recipe for months. Both docs corrected.
- **#1182** — filed and self-healed in the same session: `ocs_download_file`,
  the last payload atom still forcing base64 through context.

## Reverted

**#1110 (path containment) — shipped in #1186, reverted in #1194, reopened.**

The allowlist refused a path Phase 7 actually uses: canopy renders walkthrough
scene PNGs into a *sibling repo checkout*, and `synthetic-walkthrough-run`
uploads each via `drive_upload_binary(localFilePath)`. `~/emdash/...` was not a
root.

The live validation went **15/0 green and was wrong**, because it enumerated
paths *ACE itself* produces and paths named in *ACE* skills. The break came
from **canopy**, into **another repo**. Green-but-incomplete validation is
worse than none: it converts "be careful here" into "I checked."

Reverted rather than widening the roots, because widening preserves the method
that failed (guess a root, discover the next one in production) and keeps the
prod/dev asymmetry (the plugin cache lives under the denied `~/.claude`).

The deeper point, which Jonathan made and which the revert vindicated: **the
agent has an ungated `Bash` tool.** `gating_guard.py` is PreToolUse on Bash
with two deny rails, both about `gog gmail send`. An allowlist on MCP args was
never the boundary it looked like. #1110 reopened with a **denylist-only**
recommendation — refuse `.env`, SA keys, `*session*.json`, `~/.zshrc`,
`.git/hooks` anywhere, allow everything else — plus the reusable pieces from
the reverted lib (`resolveRealPath`, the denylist tables, 38 tests).

## Skipped

- **Raising the 40,000-char inline cap.** Measured 25 real Drive artifacts: 23
  under the cap, one at 52,334 (a genuine change — read inline before, refused
  now), one at 67,685 (the original bug, failed before too). Left as-is: the
  refusal is self-correcting, and raising it trades a *guaranteed actionable*
  error for a *chance of an opaque* truncation on densely-tokenizing content.
- **`/ace:doctor` probe for containment** — moot after the revert.
- **Broadening `gating_guard.py` to cover credential reads via Bash** — the
  real residual, but deny rails that are too broad stall autonomous runs (the
  hal lesson). Needs a human decision, noted on #1110.

## Meta-observations

- **A review finding can encode the weaker half of a fix, and its own reasoning
  is not evidence.** Ada's brief explicitly dismissed save-to-disk as "the
  fallback the agent must then separately open." Separately opening it is the
  cheap part — and the only path where a subagent reads the whole thing and
  returns three sentences.
- **The reported blast radius was ~9x under.** The finding cited 3 sessions; the
  transcripts hold 28 oversized reads across 25 sessions (2026-07-27 → 08-11).
  Worth re-deriving the count rather than inheriting it.
- **Two bugs in one function, one fixed.** #1177 fixed the dumper truncating at
  `)`; #1188 fixed it leaking `\'`. Both are "source text treated as display
  text." Fixing one and filing the other would have been the file-and-route-
  around the conventions warn against — but I only saw the second because I
  looked at the generated output, not the diff.
- **GitHub honours the closing keyword only before the FIRST issue number.**
  "Closes #1110 and #1182" closed #1110 only. Already in memory; hit it anyway.
