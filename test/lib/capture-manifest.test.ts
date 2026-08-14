/**
 * dimagi-internal/ace#1304 — #866's CONSUMER half.
 *
 * #866 fixed the producer: `app-screenshot-capture` hashes every capture and
 * marks byte-identical frames `duplicate_of: <canonical-step>`. That works —
 * the live run marked all 14 duplicates correctly.
 *
 * Nothing consumes it. Two of six training producers went on to caption a
 * `duplicate_of` frame as a distinct state, and it took two independent
 * `-eval` skills to catch — not the manifest. Both producers self-scored their
 * image handling near-perfect (`training-flw-guide` gave itself
 * `image_hygiene: 10.0`) because each verified every fileId RESOLVES, which
 * was true. **Existence and distinctness are different properties, and only
 * existence was being asserted.**
 *
 * `training-deck-generate` handled it correctly, so the contract is
 * followable — it is just advisory prose in a YAML that three skills each have
 * to remember, which is the shape of every convention that has failed under
 * load here. A helper that can only hand back canonical captures removes the
 * remembering.
 */
import { describe, it, expect } from 'vitest';

import {
  canonicalCaptures,
  resolveCanonicalStep,
  findDuplicateCitations,
} from '../../lib/capture-manifest.js';

/** The live shape from the run in the issue (aliases + their canonicals). */
const MANIFEST = {
  captures: [
    { step: 'journey-learn-module-1', file_id: 'f1' },
    { step: 'journey-learn-assessment-result', file_id: 'f2' },
    { step: 'journey-learn-final', file_id: 'f3', duplicate_of: 'journey-learn-assessment-result' },
    { step: 'deliver-sync-pre', file_id: 'f4', duplicate_of: 'journey-deliver-form-open' },
    { step: 'journey-deliver-form-open', file_id: 'f5' },
  ],
};

describe('capture-manifest consumer helpers (#1304)', () => {
  it('canonicalCaptures drops every alias', () => {
    const steps = canonicalCaptures(MANIFEST).map((c) => c.step);
    expect(steps).toEqual([
      'journey-learn-module-1',
      'journey-learn-assessment-result',
      'journey-deliver-form-open',
    ]);
    expect(steps).not.toContain('journey-learn-final');
  });

  it('resolveCanonicalStep maps an alias back to the moment it actually shows', () => {
    expect(resolveCanonicalStep(MANIFEST, 'journey-learn-final')).toBe(
      'journey-learn-assessment-result',
    );
    // A canonical step resolves to itself, so callers can resolve unconditionally.
    expect(resolveCanonicalStep(MANIFEST, 'journey-learn-module-1')).toBe('journey-learn-module-1');
    // An unknown step is reported as unknown rather than silently echoed —
    // citing a capture that does not exist is its own defect (ace#913).
    expect(resolveCanonicalStep(MANIFEST, 'nope')).toBeUndefined();
  });

  it('findDuplicateCitations flags exactly the two live instances', () => {
    // What training-llo-guide and training-flw-guide actually cited.
    const cited = ['journey-learn-final', 'deliver-sync-pre', 'journey-learn-module-1'];
    const bad = findDuplicateCitations(MANIFEST, cited);
    expect(bad.map((b) => b.step)).toEqual(['journey-learn-final', 'deliver-sync-pre']);
    expect(bad[0].canonical).toBe('journey-learn-assessment-result');
  });

  it('passes an artifact citing only canonical captures', () => {
    expect(
      findDuplicateCitations(MANIFEST, ['journey-learn-module-1', 'journey-deliver-form-open']),
    ).toEqual([]);
  });

  it('tolerates a manifest with no duplicates at all', () => {
    const clean = { captures: [{ step: 'a', file_id: 'x' }] };
    expect(canonicalCaptures(clean)).toHaveLength(1);
    expect(findDuplicateCitations(clean, ['a'])).toEqual([]);
  });

  it('is inert on a malformed/absent manifest rather than throwing mid-phase', () => {
    expect(canonicalCaptures(undefined)).toEqual([]);
    expect(canonicalCaptures({} as never)).toEqual([]);
    expect(findDuplicateCitations(undefined, ['a'])).toEqual([]);
  });
});
