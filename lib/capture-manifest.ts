//
// Consumer-side helpers for `app-screenshot-capture_manifest.yaml`.
//
// Why this exists: dimagi-internal/ace#1304, the consumer half of ace#866.
// #866 taught the PRODUCER to hash every capture and mark byte-identical
// frames `duplicate_of: <canonical-step>`; that half works. Nothing consumed
// it, so two training producers captioned an alias frame as a distinct state,
// and two independent `-eval` skills — not the manifest — caught it.
//
// Both producers had self-scored image handling near-perfect because each
// verified every fileId RESOLVES. It did. Existence and distinctness are
// different properties, and only existence was asserted.
//
// A `duplicate_of` entry is advisory prose in a YAML that three separate
// skills each have to remember to honour — the shape of every convention that
// fails under load in this codebase. So the fix is a helper that can only hand
// back canonical captures: a producer that selects images through
// `canonicalCaptures` cannot reference an alias by construction.
//
// ace#2224: for four months the helpers below read ONLY `manifest.captures[]`,
// which is not the container `app-screenshot-capture` writes. On a real
// journey-grouped manifest every one of them returned empty — so the
// duplicate-detection and no-shows guards three training skills are instructed
// to run reported clean because they saw NOTHING, not because there was
// nothing. That is strictly worse than not having them: a guard whose failure
// mode is silence launders an unchecked artifact into a checked-looking one.
// `lib/caption-backing.ts` had learned the real shapes (ace#2104) and this file
// had not, which is the drift a second reader guarantees. There is now exactly
// ONE reader — `collectCaptureEntries` — and `flattenManifestFrames` calls it,
// so the two cannot disagree again.
//

export interface CaptureEntry {
  step: string;
  file_id?: string;
  /** Present iff this frame is byte-identical to an earlier capture. */
  duplicate_of?: string;
  /**
   * One line describing what is ACTUALLY ON the frame, written by someone who
   * opened it. Not the step name restated.
   *
   * This is the only field in the manifest that is evidence rather than
   * bookkeeping. Everything else — file_id, md5, duplicate_of — answers "which
   * file is this?"; `shows` answers "what is in the picture?", and only the
   * second question can contradict a caption.
   */
  shows?: string;
  [k: string]: unknown;
}

/**
 * Frames Maestro named for us, e.g. `step-010-assertCondition-org.commcare.dalvikid_vi`.
 *
 * These arrive when a chunk boundary screenshots without a name of its own, so
 * Maestro falls back to `step-<index>-<command>-<args>`. They are real pixels
 * and worth keeping, but the string carries no human meaning — and a producer
 * cites the CANONICAL step's name in learner-facing prose.
 *
 * Live on turmeric-market-study/20260828-1108: `step-010-assertCondition-…`
 * was captured 0.28s BEFORE `deliver-launch-download-gate` and was
 * byte-identical to it. First-in-recipe-order alone therefore made the opaque
 * name canonical, and the training deck would have captioned a slide with it.
 */
export function isAutoNamedCapture(step: string): boolean {
  return /^step-\d{1,4}-/.test(step);
}

/**
 * A capture entry as it appears ON DISK, before normalisation.
 *
 * Deliberately looser than `CaptureEntry`: the producer's worked example names
 * the key `step_name`, and both spellings are in the wild.
 */
export interface RawCaptureEntry {
  step?: unknown;
  step_name?: unknown;
  file_id?: unknown;
  duplicate_of?: unknown;
  shows?: unknown;
  [k: string]: unknown;
}

export interface RawJourneyLike {
  journey_id?: unknown;
  screenshots?: readonly RawCaptureEntry[];
  steps?: readonly RawCaptureEntry[];
  duplicates?: readonly RawCaptureEntry[];
  [k: string]: unknown;
}

export interface CaptureManifestLike {
  captures?: readonly RawCaptureEntry[];
  journeys?: readonly RawJourneyLike[];
  [k: string]: unknown;
}

/**
 * THE reader for a capture manifest. Every consumer goes through this —
 * including `flattenManifestFrames` in `lib/caption-backing.ts`, which used to
 * carry a second, better-informed copy of this walk (ace#2224).
 *
 * Containers accepted, in the order a manifest lists them:
 *
 *   - `captures[]` — the shape this file's docs describe;
 *   - `journeys[].screenshots[]`, plus its sibling `journeys[].duplicates[]`;
 *   - `journeys[].steps[]`, carrying `duplicate_of` inline on the entry.
 *
 * `step_name` is accepted as an alias for `step` and normalised to `step`, so
 * downstream code compares one key. An entry in `journeys[].duplicates[]` is an
 * alias by virtue of the container it sits in, so it gets `duplicate_of` even
 * when it names no canonical — `'unknown'` — rather than being read as a
 * distinct moment.
 *
 * `journeys[].superseded_artifacts[]` is deliberately NOT read. Those are
 * forensics from an earlier FAILED dispatch (ace#1571), not steps of the walk
 * that shipped, so citing one is a real defect and must keep surfacing as
 * unknown.
 */
export function collectCaptureEntries(
  manifest: CaptureManifestLike | undefined | null,
): CaptureEntry[] {
  const out: CaptureEntry[] = [];
  const m = manifest as Record<string, unknown> | null | undefined;
  if (!m || typeof m !== 'object') return out;

  const push = (raw: RawCaptureEntry | undefined, aliasFallback?: string) => {
    if (!raw || typeof raw !== 'object') return;
    const step =
      typeof raw.step === 'string'
        ? raw.step
        : typeof raw.step_name === 'string'
          ? raw.step_name
          : undefined;
    if (!step) return;
    const entry: CaptureEntry = {
      ...raw,
      step,
      file_id: typeof raw.file_id === 'string' ? raw.file_id : undefined,
      shows: typeof raw.shows === 'string' ? raw.shows : undefined,
      duplicate_of: typeof raw.duplicate_of === 'string' ? raw.duplicate_of : aliasFallback,
    };
    // Absent, not present-and-undefined: callers spread these into YAML.
    if (entry.file_id === undefined) delete entry.file_id;
    if (entry.shows === undefined) delete entry.shows;
    if (entry.duplicate_of === undefined) delete entry.duplicate_of;
    out.push(entry);
  };

  if (Array.isArray(m.captures)) for (const c of m.captures) push(c);

  if (Array.isArray(m.journeys)) {
    for (const j of m.journeys as RawJourneyLike[]) {
      if (Array.isArray(j?.screenshots)) for (const s of j.screenshots) push(s);
      if (Array.isArray(j?.steps)) for (const s of j.steps) push(s);
      if (Array.isArray(j?.duplicates)) for (const d of j.duplicates) push(d, 'unknown');
      // NOT `superseded_artifacts` — see the docblock. Citing one is a defect.
    }
  }
  return out;
}

const entries = collectCaptureEntries;

/**
 * Only the captures that show a distinct moment. Select images through this
 * and an alias cannot be cited by accident.
 */
export function canonicalCaptures(
  manifest: CaptureManifestLike | undefined | null,
): CaptureEntry[] {
  return entries(manifest).filter((c) => !c.duplicate_of);
}

/**
 * The step whose frame this one actually shows. A canonical step resolves to
 * itself, so callers can resolve unconditionally; an unknown step returns
 * undefined rather than echoing the input, because citing a capture that does
 * not exist is its own defect (ace#913) and must not be laundered into a
 * plausible-looking answer.
 */
export function resolveCanonicalStep(
  manifest: CaptureManifestLike | undefined | null,
  step: string,
): string | undefined {
  const all = entries(manifest);
  const found = all.find((c) => c.step === step);
  if (!found) return undefined;
  if (!found.duplicate_of) return found.step;
  // One hop is the producer's contract (the FIRST step in recipe order stays
  // canonical), but follow the chain defensively and stop on a cycle.
  const seen = new Set<string>([found.step]);
  let cursor = found;
  while (cursor.duplicate_of && !seen.has(cursor.duplicate_of)) {
    seen.add(cursor.duplicate_of);
    const next = all.find((c) => c.step === cursor.duplicate_of);
    if (!next) return cursor.duplicate_of; // canonical named but not listed
    cursor = next;
  }
  return cursor.step;
}

/** One captured frame, as the PRODUCER sees it before the manifest exists. */
export interface RawFrame {
  step: string;
  /** Content hash. Byte-identical frames share it. */
  md5: string;
  /** ISO timestamp; recipe order. */
  takenAt: string;
  [k: string]: unknown;
}

/**
 * Producer-side half of ace#866: decide WHICH of a set of byte-identical frames
 * is canonical, and mark the rest `duplicate_of`.
 *
 * The rule is recipe order — the first frame to observe a state is the one that
 * state belongs to — with ONE exception: an auto-named frame
 * (`isAutoNamedCapture`) always yields to a meaningfully-named twin, however
 * much earlier it was taken. Downstream prose cites the canonical step's name,
 * and `step-010-assertCondition-org.commcare.dalvikid_vi` is not a caption.
 *
 * This exists because Step 5.5 previously stated the rule as prose — "keep the
 * FIRST step in recipe order" — which is correct until it isn't, and the
 * exception has to be re-derived by hand on every run. It was missed once and
 * caught only on re-read.
 */
export function assignCanonicalDuplicates<T extends RawFrame>(
  frames: readonly T[],
): (T & { duplicate_of?: string })[] {
  const ordered = [...frames].sort((a, b) => {
    const autoA = isAutoNamedCapture(a.step);
    const autoB = isAutoNamedCapture(b.step);
    if (autoA !== autoB) return autoA ? 1 : -1; // named frames win outright
    return a.takenAt < b.takenAt ? -1 : a.takenAt > b.takenAt ? 1 : 0;
  });

  const canonicalByHash = new Map<string, string>();
  const out: (T & { duplicate_of?: string })[] = [];
  for (const f of ordered) {
    const prior = canonicalByHash.get(f.md5);
    if (prior === undefined) {
      canonicalByHash.set(f.md5, f.step);
      out.push({ ...f });
    } else {
      out.push({ ...f, duplicate_of: prior });
    }
  }
  return out;
}

/**
 * Cited frames that carry no `shows` — i.e. the artifact is describing a screen
 * nobody looked at.
 *
 * Why this exists, stated plainly because the failure is counter-intuitive:
 * on turmeric-market-study/20260828-1108 an FLW guide and a 50-slide deck
 * passed EVERY structural gate — schema valid, 100% of cited file_ids
 * resolving, zero duplicate citations, visual coverage 1.00, 49 inline images
 * verified against an anonymous reader — and two of the first four frames
 * anyone opened did not show what the prose said. The certification "result"
 * frame was the lesson menu with a "1 form sent to server!" toast: no score
 * anywhere on it. Every check passed because **every check treats a screenshot
 * as an id.** Existence, distinctness and resolvability were all asserted;
 * CONTENT never was, and content is the only thing a caption can contradict.
 *
 * The rule this enforces: you may cite a frame freely, but the moment your
 * prose ASSERTS what is on it, someone has to have opened it. `shows` is that
 * someone's one-line record. A producer runs this over the steps it cites and
 * either records a `shows` or drops the claim.
 */
export function framesCitedWithoutShows(
  manifest: CaptureManifestLike | undefined | null,
  citedSteps: readonly string[],
): string[] {
  const all = entries(manifest);
  const out: string[] = [];
  for (const step of citedSteps) {
    const found = all.find((c) => c.step === step);
    // An unknown step is a different defect (ace#913) and is reported by
    // resolveCanonicalStep; do not double-report it here.
    if (!found) continue;
    const shows = typeof found.shows === 'string' ? found.shows.trim() : '';
    if (!shows) out.push(step);
  }
  return out;
}

export interface DuplicateCitation {
  /** The alias the artifact cited. */
  step: string;
  /** The step whose frame it actually shows. */
  canonical: string;
}

/**
 * Cited captures that are aliases — i.e. the artifact is presenting the same
 * frame as a distinct moment. Empty means every citation names a distinct
 * capture.
 */
export function findDuplicateCitations(
  manifest: CaptureManifestLike | undefined | null,
  citedSteps: readonly string[],
): DuplicateCitation[] {
  const all = entries(manifest);
  const out: DuplicateCitation[] = [];
  for (const step of citedSteps) {
    const found = all.find((c) => c.step === step);
    if (found?.duplicate_of) {
      out.push({ step, canonical: resolveCanonicalStep(manifest, step) ?? found.duplicate_of });
    }
  }
  return out;
}
