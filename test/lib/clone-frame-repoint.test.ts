/**
 * ace#2697: a cloned run's LLO guide kept the SOURCE tenancy's Connect frames
 * after Step 4b re-captured them in the partner's org. Ids below are the real
 * ones from spark/spark-facilitator/20261004-1706 (re-graded 2026-10-05).
 */
import { describe, expect, it } from 'vitest';
import { rewriteDriveIds } from '../../lib/clone-readback';
import {
  citedDriveIds,
  embeddedImageIds,
  embeddedOutsideRun,
  planFrameRepoint,
  type CitedFile,
  type LiveFile,
} from '../../lib/clone-frame-repoint';

const PREV = '4-connect/previews/connect-opportunity';
// What the guide embedded: the frames from before the 4b re-capture, which show "ace-nm-org".
const OLD_OVERVIEW = '1L_QxM4OuHQFm_sEW3FrHWjgnGlCS6sNR';
const OLD_VERIFY = '1zxDTccyv0PYrL70PwR02HT70Qo8EAvsJ';
// The clone's own re-captured frames ("Spark NM Org Test").
const NEW_OVERVIEW = '1ookll2l0q3AXJ7HzOCdJhQx33Qsa1uU2';
const NEW_VERIFY = '100mYEoOUoPJd--j2CPi8S5wX_J-ClWnb';
// Two phone frames the guide also embeds; they were never re-captured and are live.
const PHONE_A = '1n9KgqXvGCR3as2GK_MJrw6tk6CekqHRW';
const PHONE_B = '1mUCVU2n_tzYL34PM3WfF8Vi8TSsVFV6A';

const live: LiveFile[] = [
  { id: NEW_OVERVIEW, path: `${PREV}/01-overview.png` },
  { id: NEW_VERIFY, path: `${PREV}/02-verification.png` },
  { id: PHONE_A, path: '3-commcare/previews/apps-deliver/01-home.png' },
  { id: PHONE_B, path: '3-commcare/previews/apps-deliver/02-form.png' },
];

const guide = [
  '## Your opportunity',
  `[Opportunity overview](https://drive.google.com/file/d/${OLD_OVERVIEW}/view)`,
  `[Verification](https://drive.google.com/file/d/${OLD_VERIFY}/view?usp=sharing)`,
  `[Deliver home](https://drive.google.com/file/d/${PHONE_A}/view)`,
  `![](https://drive.google.com/uc?export=view&id=${PHONE_B})`,
  'Connect: https://connect.dimagi.com/a/spark-nm-org-test/opportunity/7140057a/',
].join('\n');

const cited = (paths: Record<string, string | null>): CitedFile[] =>
  citedDriveIds(guide).map((id) => ({ id, path: id in paths ? paths[id] : null, isImage: true }));

describe('clone frame re-point (ace#2697)', () => {
  it('finds every Drive id the guide cites, and ignores non-Drive links', () => {
    expect(citedDriveIds(guide).sort()).toEqual([OLD_OVERVIEW, OLD_VERIFY, PHONE_A, PHONE_B].sort());
  });

  it('pairs each re-captured Connect frame with the live frame at the same run path', () => {
    const plan = planFrameRepoint(cited({ [OLD_OVERVIEW]: `${PREV}/01-overview.png`, [OLD_VERIFY]: `${PREV}/02-verification.png` }), live);
    expect(plan.ids).toEqual({ [OLD_OVERVIEW]: NEW_OVERVIEW, [OLD_VERIFY]: NEW_VERIFY });
    expect(plan.foreign).toEqual([]);
    const out = rewriteDriveIds(guide, plan.ids);
    expect(out.replacements).toBe(2);
    expect(out.text).toContain(NEW_OVERVIEW);
    expect(out.text).not.toContain(OLD_OVERVIEW);
    expect(citedDriveIds(out.text).filter((id) => !live.some((f) => f.id === id))).toEqual([]);
  });

  it('a cited image with no counterpart in the target run is foreign; a non-image link or a shared baseline frame is not', () => {
    const plan = planFrameRepoint(
      [
        { id: OLD_OVERVIEW, path: null, isImage: true },
        { id: OLD_VERIFY, path: `${PREV}/03-gone.png`, isImage: true },
        { id: '1xNotAFrameButADocLinkOutsideTheRun', path: null, isImage: false },
        // ACE/_common/connect-screenshots/2.63.0/commcare-welcome.png, cited by the real clone's deck spec.
        { id: '1rEPfgO-ahSFT29Tu3xcSV0odhvvdN4o2', path: null, isImage: true, shared: true },
      ],
      live,
    );
    expect(plan.ids).toEqual({});
    expect(plan.foreign.map((f) => f.id)).toEqual([OLD_OVERVIEW, OLD_VERIFY]);
  });

  it('read-back: an embedded image that is not live in the target run is named', () => {
    const doc = {
      inlineObjects: Object.fromEntries(
        [OLD_OVERVIEW, OLD_VERIFY, PHONE_A, PHONE_B].map((id, i) => [
          `kix.${i}`,
          { inlineObjectProperties: { embeddedObject: { imageProperties: { sourceUri: `https://drive.google.com/uc?export=view&id=${id}` } } } },
        ]),
      ),
    };
    expect(embeddedOutsideRun(embeddedImageIds(doc), live)).toEqual([OLD_OVERVIEW, OLD_VERIFY]);
    expect(embeddedOutsideRun([NEW_OVERVIEW, NEW_VERIFY, PHONE_A, PHONE_B], live)).toEqual([]);
    const BASELINE = '1rEPfgO-ahSFT29Tu3xcSV0odhvvdN4o2';
    expect(embeddedOutsideRun([NEW_OVERVIEW, BASELINE], live, new Set([BASELINE]))).toEqual([]);
  });
});
