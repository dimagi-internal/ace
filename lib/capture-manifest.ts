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
  [k: string]: unknown;
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
