/**
 * Tell a COLD labs visit cache apart from an opportunity that genuinely has no
 * visits (ace#3436).
 *
 * Labs' `data_describe` answers with `cached_visits`, which counts the VISIT
 * CACHE, not the store. That cache expires on purpose — labs says so itself
 * when you ask it to hold one:
 *
 *   workflow_ensure_visit_cache(hold_minutes: 1440)
 *   → "hold_minutes must be 1-180: long enough to finish a job, never so long
 *      it freezes visit statuses (expiry is what re-reads them)"
 *
 * So `cached_visits: 0` is the NORMAL resting state of an opportunity nobody
 * has read recently. It says nothing about whether the data exists. Re-reading
 * with `load_missing: true` repopulates it in seconds.
 *
 * ACE did not draw that distinction, and twice in three days (2026-11-16, both
 * on thread 1a1691a41973d718) it read a zero here as "the synthetic visits have
 * vanished from Labs" and regenerated a partner's demo dataset from scratch, in
 * the week of their client demo. Both datasets were intact: a `load_missing`
 * read returned 144 and 161 visits, the exact counts ACE reported after each
 * "rebuild". A regeneration is destructive and not equivalent — it mints new
 * visit ids, new worker names and fresh review statuses — so a self-healing
 * cache miss was converted into permanent loss of data the partner had already
 * reviewed.
 *
 * The rule: NEVER regenerate on the strength of an un-reloaded read.
 */

/** The shape `data_describe` returns per opportunity (the fields we judge on). */
export interface LabsOpportunityDataDescription {
  opportunity_id: number;
  opportunity_name?: string;
  /** Count held in labs' visit CACHE — not the store. */
  cached_visits: number;
  /** When the cache was last populated; null when it has never been, or expired. */
  cached_at?: string | null;
  latest_visit_date?: string | null;
}

export type VisitCacheVerdict =
  /** The cache is cold. Re-read with `load_missing: true` before concluding anything. */
  | 'cache-cold'
  /** A `load_missing` read still returned nothing. The opportunity really has no visits. */
  | 'data-absent'
  /** The cache holds visits. */
  | 'data-present';

export interface VisitCacheClassification {
  verdict: VisitCacheVerdict;
  opportunityId: number;
  cachedVisits: number;
  /** True when a regeneration would be acting on an un-reloaded zero. */
  regenerationWouldBeUnsafe: boolean;
  /** What to do next, in one line. */
  nextStep: string;
}

/**
 * Classify one `data_describe` entry.
 *
 * `loadMissingWasSet` MUST say whether the read that produced `description`
 * passed `load_missing: true`. It is a required argument rather than an
 * optional flag precisely because defaulting it would reintroduce the bug: a
 * caller who forgets it would get `data-absent` from a cold cache.
 */
export function classifyVisitCache(
  description: LabsOpportunityDataDescription,
  loadMissingWasSet: boolean,
): VisitCacheClassification {
  const { opportunity_id: opportunityId, cached_visits: cachedVisits } = description;

  if (cachedVisits > 0) {
    return {
      verdict: 'data-present',
      opportunityId,
      cachedVisits,
      regenerationWouldBeUnsafe: true,
      nextStep: `${cachedVisits} visits are loaded for opportunity ${opportunityId}; nothing to rebuild.`,
    };
  }

  if (!loadMissingWasSet) {
    return {
      verdict: 'cache-cold',
      opportunityId,
      cachedVisits,
      regenerationWouldBeUnsafe: true,
      nextStep:
        `Opportunity ${opportunityId} reports 0 CACHED visits, but this read did not pass ` +
        `load_missing. Re-read with data_describe({opportunity_ids:[${opportunityId}], ` +
        `load_missing:true}) before concluding the data is gone — the cache expires by design.`,
    };
  }

  return {
    verdict: 'data-absent',
    opportunityId,
    cachedVisits,
    regenerationWouldBeUnsafe: false,
    nextStep:
      `Opportunity ${opportunityId} returned 0 visits even with load_missing set, so the store ` +
      `really is empty. Regenerating is now the correct action.`,
  };
}

/**
 * The guard to call immediately before any regeneration prompted by "labs shows
 * no data". Throws unless a `load_missing` read has actually proven the store
 * empty.
 */
export function assertSafeToRegenerate(
  description: LabsOpportunityDataDescription,
  loadMissingWasSet: boolean,
): void {
  const result = classifyVisitCache(description, loadMissingWasSet);
  if (result.regenerationWouldBeUnsafe) {
    throw new Error(
      `refusing to regenerate opportunity ${result.opportunityId}: ${result.verdict}. ` +
        `${result.nextStep} (ace#3436)`,
    );
  }
}
