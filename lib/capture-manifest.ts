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

export interface CaptureManifestLike {
  captures?: CaptureEntry[];
  [k: string]: unknown;
}

function entries(manifest: CaptureManifestLike | undefined | null): CaptureEntry[] {
  const list = manifest?.captures;
  return Array.isArray(list) ? list.filter((c) => c && typeof c.step === 'string') : [];
}

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
