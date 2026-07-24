---
name: agent-turn-review
description: >
  ACE's pre-send review — invokes the fleet-wide `canopy:agent-turn-review` discipline,
  then adds ACE's specifics. Run before EVERY outbound reply / deliverable / PR.
---

# Agent turn review (ACE)

Run before every outbound action (the thing that gets dropped under load). The general discipline
is fleet-wide and DRY — **invoke `canopy:agent-turn-review`** and apply it in full:
- **A. Fidelity** — re-read the request, extract each ask, do EXACTLY that (read cited sources),
  rate it tough.
- **B. Grounded commitments** — every "I'll do X" needs a concrete, executable mechanism; a vague
  "sync with / coordinate with / loop in <person>" is vapor — convert it to a runnable check or a
  draft-then-ask message, or cut it.
- **C. Presentation** — lead with what you DID; enumerate multiple asks; link artifacts as shared
  docs; verify recipients (reply-all hides `Cc:` in raw views).

## ACE-specifics
- **Every claim about EXTERNAL SYSTEM STATE must be read back before the send — no exceptions.**
  Check B covers grounded *future* commitments ("I'll do X"); this is its past-tense twin. Any
  sentence asserting the world is now in some state — *"access is set up"*, *"you'll see a pending
  invite"*, *"the app is released"*, *"the opportunity is active"*, *"I filed it in the inputs
  folder"* — is a factual claim about a system you do not control. Before it ships, go read that
  system and confirm: the membership list contains them, the build shows released, the folder
  contains the file. **A tool call that returned 200 is not a read-back; the read-back is querying
  the state afterward.** If you cannot verify it, either cut the claim or downgrade it to what you
  actually know ("I've requested X; I'll confirm when it lands"). Telling someone their access
  works when it doesn't sends them hunting for something that isn't there and costs a full
  round-trip — worse than saying nothing. (Origin: dimagi-internal/ace#915 — a reply announced
  "Access is set up — here's the one step each of you needs to get in" when two of three surfaces
  had never been granted and the third was blocked by a domain allowlist that made the instructed
  step impossible. A review DID run on that body and passed it, because nothing required checking
  the claim against the system. See also `share-run-access`'s NOT DONE contract and #913.)
- **The turn ends when the email sends — so never promise post-send work ACE won't autonomously
  do.** A reply that says "I'll build now / I'll run it next / I'll send those once they're up"
  is an ungrounded commitment: after the send, THIS turn is over and no run auto-starts. Any
  next-step that needs a fresh trigger (a `/ace:run` build, a follow-up deliverable) must be framed
  as an **invitation for an act-tier sender to say "go"** — "give me the go-ahead and I'll kick it
  off" — not as a self-continuation ACE will perform on its own. This is part of the **B. Grounded
  commitments** check: treat "I'll do X after I send this" as vapor unless X literally happens
  inside the same turn before the send. (Origin: Jon, 2026-07-22 — a povgraduate reply promised
  "next step is a clean build… I'll send those once up," which the turn model can't keep.
  Fleet-general for every turn-based agent → candidate for promotion into
  `canopy:agent-turn-review`.)
- **Never put intent or a commitment in another person's mouth.** Check B guards ACE's OWN "I'll
  do X"; this is its third-party twin. A reply must not assert that a NAMED human (or "the team")
  WILL do something they haven't agreed to — *"Jon and Neal can set up the call"*, *"Sasha will
  send that over"*, *"the team will schedule X"*. You cannot verify another person's intent, and
  naming them commits them without consent (and ACE itself can't attend a call / take a meeting, so
  it can't stand in for them either). Convert it to one of: (a) something ACE genuinely does async
  itself; (b) an open, UN-named offer that commits no one — *"if you'd prefer a call, say the word
  and we'll find a time"*; or (c) a request routed to that person FIRST for their own yes before it
  goes to the counterpart. (Origin: Jon, 2026-07-24 — a Spark reply offered "Jon and Neal … can set
  up a Wednesday/Thursday slot"; ACE can't attend a call and hadn't cleared it with either of them.
  Fleet-general for every turn-based agent → candidate for promotion into `canopy:agent-turn-review`.)
- **Eval-skill relationship:** ACE's `-qa`/`-eval` skills grade artifacts; this is the
  brief-fidelity counterpart for correspondence. (Supersedes the old `skills/self-review`.)
- **Send path:** outbound email goes ONLY via `bin/ace-email` (a `config/gating.json` deny rail
  blocks raw `gog gmail send/reply` as ACE; `--dry-run` to preview). Every send records
  `thread_id` in the routed run's comms-log (`email-communicator` step 7). Turns run in review
  posture: the draft is presented in-conversation and gets the human's yes before it goes.
- **Multi-ask replies:** when a message contained MULTIPLE asks, enumerate them in the reply and
  say how each was handled, one line each (done / link / status) — the requester must see their
  checklist reflected back.
- **Reply mechanics** follow canopy `docs/agent-operating-model.md § 1b` by reference
  (jjackson/ace#828): deliverables/attachments are **gdocs** with the draft shown **inline** —
  never a local file the human must open; **verify the recipient set from the structured thread
  read** (raw dumps hide `Cc:`) before rating fidelity complete.
- **Gated in:** `turn` (before every reply, and the close checklist) and `inbox-triage` step 2d.
