/**
 * Displacement reporting for Drive's find-or-update write path (ace#2338).
 *
 * ## The class
 *
 * `drive_create_file` / `drive_create_doc_from_markdown` default to
 * find-or-update: a same-name non-trashed file under the parent has its
 * CONTENT REPLACED and its id returned. That is the right default — it is what
 * closes the duplicate-artifact class (ace#1324, ace#1417) — but until now the
 * entire signal it returned was `reused: true`, which is equally true for
 *
 *   - "I re-wrote my own draft", and
 *   - "I destroyed a different agent's artifact and nobody will ever know".
 *
 * Measured instance: on `spark-facilitator/20260909-1211` Phase 8, an
 * INDEPENDENT `solicitation-create-eval` verdict (overall 9.17) was replaced by
 * the producer's own self-eval of the same solicitation (8.86), because the
 * producer had polled the phase folder for ~65 minutes, concluded the dispatched
 * grader had stalled, and ran the rubric inline as a fallback. Both wrote
 * `solicitation-create-eval_verdict.yaml` into the same folder. The tool result
 * was `{"id": "1i6kT…", "name": "…", "webViewLink": "…", "reused": true}`. It was
 * recovered only because the two agents happened to compare notes afterwards.
 *
 * ACE's whole QA-vs-Eval design rests on an `-eval` verdict being independent of
 * the thing it grades, so a silent producer-self-eval substitution defeats the
 * design at the storage layer rather than at the rubric.
 *
 * ## Why this reports rather than refuses
 *
 * The obvious stronger fix — "refuse to replace content written by a DIFFERENT
 * author" — is not implementable here, and it is worth writing down why so it is
 * not re-proposed. Every ACE Drive write goes through ONE Google service account
 * (`${CLAUDE_PLUGIN_DATA}/gws-sa-key.json`). The independent grader's write and
 * the producer's fallback write carry the same `lastModifyingUser`, so Drive
 * cannot distinguish them, and neither can this code. Authorship is simply not a
 * fact the storage layer holds.
 *
 * What the storage layer DOES hold is what was there a moment ago: which
 * revision, how old, how big, by which principal. So the reuse reports its
 * displacement — the same shape `drive_upload_binary` already uses for
 * `replacedMismatchedType` (ace#2102), which makes a destructive reuse visible
 * in the tool result rather than silent.
 *
 * The teeth are the caller-declared expectation, `expectAbsent` — see
 * `assertExpectedAbsent`. A writer that believes it is the FIRST author of an
 * artifact (the fallback grader above believed exactly that) can say so, and
 * have the collision be a loud typed refusal with nothing written, instead of a
 * silent overwrite.
 */

/**
 * Field sub-selection the find-or-update lookup must request so a reuse can
 * describe what it displaced. Exported as one constant so the query and
 * `describeDisplaced` cannot drift apart.
 *
 * `version` (Drive's monotonic per-file revision counter, surfaced everywhere in
 * this codebase as `revisionVersion`) and `modifiedTime` are always present.
 * `size` is populated only for the types Drive reports a byte size for, and
 * `lastModifyingUser` may be absent when the principal is not resolvable. Both
 * are therefore optional in the output, and absent is reported as absent rather
 * than guessed — see `describeDisplaced`'s omit-what-Drive-did-not-return test.
 */
export const DISPLACEMENT_FILE_FIELDS =
  'id, name, webViewLink, version, modifiedTime, size, lastModifyingUser(displayName, emailAddress)';

/** The raw Drive `files` resource subset this module reads. */
export interface DriveFileMetadata {
  id?: string | null;
  name?: string | null;
  webViewLink?: string | null;
  version?: string | number | null;
  modifiedTime?: string | null;
  size?: string | number | null;
  lastModifyingUser?: {
    displayName?: string | null;
    emailAddress?: string | null;
  } | null;
}

/** What a find-or-update reuse replaced. */
export interface DisplacedContent {
  /** Drive's `version` on the file as it was found, BEFORE this write. */
  revisionVersion?: string;
  /** `modifiedTime` of the content that was replaced. */
  modifiedTime?: string;
  /**
   * Seconds between that `modifiedTime` and now. The single most useful number
   * for spotting the failure class: a file last written eleven seconds ago by
   * "you" is a retry; one written three minutes ago, while you believed the
   * artifact did not exist, is someone else's work.
   */
  ageSeconds?: number;
  /** Principal Drive recorded for the replaced content. */
  lastModifiedBy?: string;
  /** Byte size, on the types for which Drive reports one. Often absent. */
  sizeBytes?: number;
  /**
   * Always present, always the same sentence. Carries the interpretation to the
   * reader of the tool result, who is a model that will not go and read this
   * file.
   */
  note: string;
}

const DISPLACEMENT_NOTE =
  'Content that existed under this name was REPLACED (find-or-update). If you did not write ' +
  'the revision described here, you have just overwritten another writer\'s artifact — read the ' +
  'file\'s revision history before proceeding. Pass expectAbsent: true when you believe you are ' +
  'the first writer and want a collision to fail loudly instead (ace#2338).';

function toOptionalNumber(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Describe the content a find-or-update reuse is about to replace.
 *
 * Pure: takes the metadata the lookup already returned, so it costs ZERO extra
 * Drive calls — the fields ride along on the `files.list` the find-or-update
 * path performs anyway.
 */
export function describeDisplaced(
  existing: DriveFileMetadata,
  now: Date = new Date(),
): DisplacedContent {
  const out: DisplacedContent = { note: DISPLACEMENT_NOTE };

  if (existing.version !== null && existing.version !== undefined && existing.version !== '') {
    out.revisionVersion = String(existing.version);
  }
  if (existing.modifiedTime) {
    out.modifiedTime = existing.modifiedTime;
    const then = Date.parse(existing.modifiedTime);
    if (Number.isFinite(then)) {
      out.ageSeconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
    }
  }
  const who = existing.lastModifyingUser?.emailAddress || existing.lastModifyingUser?.displayName;
  if (who) out.lastModifiedBy = who;

  const size = toOptionalNumber(existing.size);
  if (size !== undefined) out.sizeBytes = size;

  return out;
}

/**
 * The opt-in preventer: refuse the write when the caller declared it expected no
 * same-name file and one is there.
 *
 * Nothing is written — the refusal happens before any `files.update` /
 * `files.create` — so a writer that guessed wrong loses nothing and can go read
 * what is already there. The message carries the id and the revision precisely
 * because the recovery is always the same: read it, then decide.
 */
export function assertExpectedAbsent(
  existing: DriveFileMetadata | undefined,
  ctx: { atom: string; name: string; parentFolderId: string },
): void {
  if (!existing?.id) return;
  const d = describeDisplaced(existing);
  const bits = [
    `id=${existing.id}`,
    d.revisionVersion ? `revision=${d.revisionVersion}` : null,
    d.modifiedTime ? `modifiedTime=${d.modifiedTime}` : null,
    d.ageSeconds !== undefined ? `age=${d.ageSeconds}s` : null,
    d.lastModifiedBy ? `lastModifiedBy=${d.lastModifiedBy}` : null,
  ].filter(Boolean).join(' ');
  throw new Error(
    `${ctx.atom}: expectAbsent was set, but "${ctx.name}" ALREADY EXISTS under ${ctx.parentFolderId} ` +
    `(${bits}). NOTHING WAS WRITTEN. Another writer produced this artifact while you were working; ` +
    `read it (drive_read_file on ${existing.id}) and decide deliberately whether your content should ` +
    `replace it. To replace it anyway, re-issue the call WITHOUT expectAbsent — the result will then ` +
    `report what was displaced (ace#2338).`,
  );
}
