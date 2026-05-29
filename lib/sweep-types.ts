export type Confidence = 'high' | 'medium' | 'low';

export interface LiveSet {
  /** Generated at this UTC ISO timestamp. */
  generatedAt: string;
  /** Opp slugs visible under ACE/ at generation time. */
  oppSlugs: string[];
  /** External identifiers referenced by any active opp's opp.yaml or run_state.yaml. */
  identifiers: {
    connectProgramIds: string[];
    connectOpportunityIds: string[];
    connectPaymentUnitIds: string[];
    ocsChatbotIds: string[];
    ocsCollectionIds: string[];
    ocsSessionIds: string[];
    commcareAppIds: string[];
    labsWorkflowIds: string[];
    labsPipelineIds: string[];
    labsSyntheticIds: string[];
    labsRecordIds: string[];
    driveFileIds: string[];
  };
}

export interface DriveFolderInfo {
  id: string;
  name: string;
  /** ISO timestamp from Drive `createdTime`. */
  createdTime: string;
  /** Parent folder id; for ACE-root sweep this is `ACE_DRIVE_ROOT_FOLDER_ID`. */
  parentId: string;
  /**
   * Whether the folder is actually an opp folder — i.e. it contains `opp.yaml`
   * or an `inputs/` subfolder (the same test `isOppFolder` and `sweep-live-set`
   * use). Populated by the caller after probing Drive; left `undefined` when the
   * caller didn't probe (the scorer then falls back to name-shape heuristics).
   *
   * This is the authoritative orphan signal: only a folder that IS an opp but is
   * NOT referenced by any active opp is a real orphan. Shared project folders
   * (`documentation`, `templates`, `videos`, …) are not opp-shaped and must never
   * be flagged, no matter how opp-like their names look.
   */
  isOppShaped?: boolean;
}

export interface Orphan {
  /** Drive file/folder id. */
  id: string;
  /** Display name (folder name). */
  name: string;
  /** ISO timestamp. */
  createdTime: string;
  confidence: Confidence;
  /** Human-readable signals that contributed to the score. */
  signals: string[];
}

export interface OrphanReport {
  system: 'drive' | 'connect' | 'ocs' | 'hq' | 'labs';
  generatedAt: string;
  liveSetGeneratedAt: string;
  totals: { high: number; medium: number; low: number };
  orphans: Orphan[];
}
