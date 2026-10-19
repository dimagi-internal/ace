// The LLO guide's Phase 4 Connect frames (ace#3234): who they show, and
// whether a reader other than the service account can fetch them.
//
// 1. Whose view. `output-preview-capture` opens the opportunity at the PM
//    org's url on a `pm-nm` run (ace#2893); on connect-fi/20261018-1440 the
//    frames' header read "ace-pm-org · Program Manager". The guide's Inputs row
//    called them "the LLO's own Connect screens, captured as the holding
//    (Network Manager) org". Pin the honest wording and the caption rule.
// 2. Sharing. The same run's frames were SA-only, so `embed-doc-screenshots`
//    failed with Docs' generic "problem retrieving the image". Pin both the
//    producer refusal (`index` before it writes) and the consumer pre-flight
//    (before the batchUpdate and before the dry-run exit).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('training-llo-guide describes the Phase 4 frames honestly (ace#3234)', () => {
  // The Change Log quotes the old wording on purpose; judge the instructions.
  const full = read('skills/training-llo-guide/SKILL.md');
  const skill = full.slice(0, full.indexOf('## Change Log'));
  const inputsRow = skill.split('\n').find((l) => l.includes('4-connect/previews/connect-opportunity/_previews.yaml'));

  it('no longer claims the frames are the holding org view or the LLO own screens', () => {
    expect(skill).not.toMatch(/captured as the holding \(Network Manager\) org/);
    expect(inputsRow).toBeDefined();
    expect(inputsRow!).not.toMatch(/\*\*the LLO's own Connect screens\*\*/);
  });

  it('says they are opened as the PM org on a pm-nm run, and the partner opp differs', () => {
    expect(inputsRow!).toMatch(/PM org's\*\* url/);
    expect(inputsRow!).toContain('ace#2893');
    expect(inputsRow!).toMatch(/Phase 9/);
  });

  it('has a caption rule: an example, never "your screen"', () => {
    expect(skill).toMatch(/Caption those frames as what they are: an example/);
  });

  it('agrees with output-preview-capture, which opens the PM org url', () => {
    expect(read('skills/output-preview-capture/SKILL.md')).toMatch(/Opened at the \*\*PM org's\*\* url/);
  });
});

describe('the frames must be anyone-with-link before anything consumes them (ace#3234)', () => {
  it('output-preview-capture index refuses unshared uploads before writing the index', () => {
    const src = read('scripts/output-preview-capture.ts');
    const body = src.slice(src.indexOf('function runIndex()'), src.indexOf('function runVerify()'));
    const check = body.indexOf('unsharedUploads(uploaded)');
    const write = body.indexOf('fs.writeFileSync');
    expect(check).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(check);
  });

  it('the skill tells the uploader to record each upload sharing', () => {
    const skill = read('skills/output-preview-capture/SKILL.md');
    expect(skill).toContain('shareAnyoneWithLink: true');
    expect(skill).toContain('[{name, file_id, sharing}]');
  });

  it('embed-doc-screenshots checks sharing before the dry-run exit and before batchUpdate', () => {
    const src = read('scripts/embed-doc-screenshots.ts');
    const main = src.slice(src.indexOf('async function main()'));
    const check = main.indexOf('await unsharedFrames(');
    expect(check).toBeGreaterThan(-1);
    expect(main.indexOf('args.dryRun')).toBeGreaterThan(check);
    expect(main.indexOf('documents.batchUpdate')).toBeGreaterThan(check);
    expect(main).toContain('explainEmbedFailure(');
  });
});
