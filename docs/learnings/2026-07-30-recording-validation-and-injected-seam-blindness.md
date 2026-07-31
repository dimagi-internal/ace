# An idle screen lies, and an injected fake can't emit what the real thing does

**Date:** 2026-07-30
**Context:** Building AVD session recording (spec + plan in `docs/superpowers/{specs,plans}/2026-07-30-avd-session-recording-*`). Two lessons that generalize well past screen recording.

## 1. Validating a capture mechanism on an IDLE screen tells you nothing

The design probe recorded 6 seconds of a live emulator and produced a file that
`ffprobe` read as **1 frame, `duration=N/A`**. That looks exactly like a broken
stop-and-finalize path — and it is not. A static Android screen produces almost
no new frames, because SurfaceFlinger has nothing to composite, so the encoder
emits a keyframe and little else.

The same code, recording a screen that was actually moving (Settings opened and
scrolled six times), produced **565 frames and a real 14.97s duration**.

The general shape: **a capture mechanism validated against a quiescent source
cannot distinguish "the mechanism is broken" from "there was nothing to
capture."** Same trap for a log tailer against an idle service, a diff watcher
against an unchanged tree, or a metrics scraper against a system at rest. When
you validate a capture path, you must first *generate the thing being captured*.

The spec was written with the ambiguity named and the gate left explicitly open
("do not merge on the idle-screen probe") rather than resolved by assumption —
that is what made the real validation happen instead of a plausible-sounding
claim shipping unchecked. See `CLAUDE.md § close the loop to the source of
truth`.

**Validation recipe, for the next person:** boot a second `-read-only` instance
of the AVD on your own ports (never inject input into an emulator another macOS
account owns — `ps -eo user,pid,command | grep qemu` tells you whose it is),
drive motion with `adb shell input swipe`, then assert `nb_read_frames > 1` AND
a real `duration`.

## 2. An injected seam is a blind spot, not a proof

The recorder takes an injectable `spawnFn` so tests run device-free. The default
implementation wrapped `child_process.spawn` and attached **no `'error'`
listener** — so an `adb` spawn failure (ENOENT, EAGAIN/EMFILE) would emit an
unhandled `'error'` event and **crash the entire mobile MCP subprocess**, the
most complete possible violation of the feature's "recording must never change a
recipe's verdict" invariant.

A test *did* exist for spawn failure: `spawnFn: () => { throw ... }`. It passed.
It could never have caught this, because **a fake can only fail the way the fake
knows how to fail** — synchronously. The real `ChildProcess` fails
asynchronously, via an EventEmitter contract the fake doesn't implement.

Two clean per-task reviews and a full unit suite went past it. The final
whole-branch review caught it by asking a different question.

**The question worth asking at every injected seam:** *what does the real
implementation do that the fake cannot?* Async error events, timeouts, partial
writes, backpressure, reconnects. Where the answer is "something," that behavior
is untested no matter how green the suite is. Related seams in this repo with
the same exposure: `ShellFn` (real `defaultShell` resolves non-zero exits rather
than rejecting — which produced a second defect on this same branch, a failed
`adb pull` misreported as a good artifact), and `fetchImpl`.

## 3. Corollary: `tsc` reads across task boundaries; per-task review does not

A `TS2322` in the recorder survived two clean per-task reviews and was found only
when a later task happened to run `npx tsc --noEmit`. Reviewers judge a diff and
don't run type checks; CI runs `tsc`, but CI runs after everything has landed.

When work is split across tasks or agents, run `tsc --noEmit` inside **each**
task's verification, not once at the end. It costs about two seconds and it is
the only check in this repo that sees across the split.
