/**
 * The Drive half of `scripts/probe-upstream-asks.ts`: collect upstream-issue
 * citations from the opp `inputs/` that live in Drive, not in this repo.
 *
 * ## Why
 *
 * The probe only walked repo docs (`SCAN_DIRS` / `SCAN_FILES`). But some
 * harness-load-bearing prose is Drive-resident opp input — above all the
 * `/ace:iterate` fixture brief, `ACE/bednet-check-2-visit/inputs/idea.md`,
 * whose § Fixture pins kept a Nova limitation as BINDING after the upstream
 * fix shipped and `_app-component-library.md` retired the premise. Every run
 * of that fixture re-derived the conflict from scratch and paid for it in two
 * graded dimensions (ace#1924, observed on bednet-check-2-visit/20260902-1555
 * and 20260908-1544). No repo probe could see it.
 *
 * ## Shape
 *
 * I/O is injected (`DriveInputsReader`) so the selection and labelling rules
 * are unit-testable from a fixture; the probe supplies a real Drive reader.
 * Default scope is FIXTURE opps — those carrying `iterate-state.yaml` at the
 * opp root — because a fixture brief is reused across runs by design and a
 * stale pin there is never re-litigated, whereas a one-off opp's inputs are
 * read fresh, by a human, every run. `allOpps` widens it.
 *
 * Total: a reader failure for one opp is recorded in `errors` and the rest of
 * the scan continues. A failure must not read as "no stale citations".
 */
import { extractRefs, type UpstreamRef } from './upstream-asks.js';

export interface DriveOpp {
  /** Opp folder name under the ACE Drive root. */
  opp: string;
  /** True when `iterate-state.yaml` sits at the opp root (an `/ace:iterate` fixture). */
  fixture: boolean;
}

export interface DriveInputDoc {
  /** File name directly under `ACE/<opp>/inputs/`. */
  name: string;
  /** Its text (a Google Doc exported as plain text). */
  text: string;
}

export interface DriveInputsReader {
  listOpps(): Promise<DriveOpp[]>;
  readInputs(opp: string): Promise<DriveInputDoc[]>;
}

export interface DriveRefScan {
  refs: UpstreamRef[];
  /** Opps whose inputs/ were read. */
  scanned: string[];
  /** One line per opp the reader could not read. */
  errors: string[];
}

/** The `file` label a Drive citation reports under. */
export function driveInputLabel(opp: string, name: string): string {
  return `drive:ACE/${opp}/inputs/${name}`;
}

/** Text-bearing inputs only — a PDF or image carries no citation we can read. */
export function isScannableInput(name: string): boolean {
  return /\.(md|markdown|txt|ya?ml)$/i.test(name) || !/\.[a-z0-9]{1,5}$/i.test(name);
}

export async function collectDriveInputRefs(
  reader: DriveInputsReader,
  opts: { allOpps?: boolean } = {},
): Promise<DriveRefScan> {
  const refs: UpstreamRef[] = [];
  const scanned: string[] = [];
  const errors: string[] = [];
  let opps: DriveOpp[];
  try {
    opps = await reader.listOpps();
  } catch (e) {
    return { refs, scanned, errors: [`listing opps failed: ${(e as Error).message}`] };
  }
  for (const { opp, fixture } of opps) {
    if (!fixture && !opts.allOpps) continue;
    try {
      for (const doc of await reader.readInputs(opp)) {
        if (!isScannableInput(doc.name)) continue;
        refs.push(...extractRefs(driveInputLabel(opp, doc.name), doc.text));
      }
      scanned.push(opp);
    } catch (e) {
      errors.push(`${opp}: reading inputs/ failed: ${(e as Error).message}`);
    }
  }
  return { refs, scanned, errors };
}
