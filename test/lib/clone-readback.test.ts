import { describe, expect, it } from 'vitest';
import {
  buildCopyIdMap,
  docIdRewriteRequests,
  docTextAndLinks,
  findLeftoverSourceIds,
  isIdBearingCopy,
  isLeftBehind,
  isProvenanceCopy,
  rewriteDriveIds,
} from '../../lib/clone-readback.js';

// Ids from the live repro (dimagi-internal/ace#2603, spark/spark-facilitator/20261001-2208).
const SRC_OVERVIEW = '1x_InS0toha6u1A_pi-6MkyBUbF1jCHsy';
const SRC_VERIF = '1gFjL277FH_HJHiqg5tyjVwMiEXwP1dhO';
const DST_OVERVIEW = '17G-cQr5pq89EPyejUAJ4-g7ZQUpOoEM1';
const SRC_PDD = '1AAAApddSourceDocIdxxxxxxxxxxxxxx';
const SRC_COMMS = '1CCCCcommsLogSourceIdxxxxxxxxxxxxx';
const GDOC = 'application/vnd.google-apps.document';

const SOURCE = [
  { id: SRC_OVERVIEW, path: '4-connect/previews/connect-opportunity/01-overview.png' },
  { id: SRC_VERIF, path: '4-connect/previews/connect-opportunity/02-verification.png' },
  { id: SRC_PDD, path: '1-design/pdd.md' },
  { id: SRC_COMMS, path: '8-solicitation-management/llo-invite_comms-log' },
];

const STALE_INDEX = `captured_by: output-preview-capture
items:
  - file_id: ${SRC_OVERVIEW}
    name: 01-overview.png
  - file_id: ${SRC_VERIF}
    name: 02-verification.png
`;

describe('findLeftoverSourceIds', () => {
  it('catches source ids left in a copied preview index even when run_state is clean (ace#2603)', () => {
    const r = findLeftoverSourceIds(SOURCE, [
      { path: 'run_state.yaml', text: 'pdd: https://docs.google.com/document/d/1NEWpdd/edit\n' },
      { path: '4-connect/previews/connect-opportunity/_previews.yaml', text: STALE_INDEX },
    ]);
    expect(r.checked).toEqual([
      'run_state.yaml',
      '4-connect/previews/connect-opportunity/_previews.yaml',
    ]);
    expect(r.hits.map((h) => [h.copyPath, h.sourceId, h.occurrences])).toEqual([
      ['4-connect/previews/connect-opportunity/_previews.yaml', SRC_OVERVIEW, 1],
      ['4-connect/previews/connect-opportunity/_previews.yaml', SRC_VERIF, 1],
    ]);
    expect(r.hits[0].sourcePath).toBe('4-connect/previews/connect-opportunity/01-overview.png');
  });

  it('checks the Phase 6 capture manifest and still checks run_state', () => {
    const r = findLeftoverSourceIds(SOURCE, [
      { path: '6-qa-and-training/app-screenshot-capture_manifest.yaml', text: `- file_id: ${SRC_OVERVIEW}\n` },
      { path: 'run_state.yaml', text: `pdd_doc_id: ${SRC_PDD}\nagain: ${SRC_PDD}\n` },
    ]);
    expect(r.hits.map((h) => [h.copyPath, h.occurrences])).toEqual([
      ['6-qa-and-training/app-screenshot-capture_manifest.yaml', 1],
      ['run_state.yaml', 2],
    ]);
  });

  it('passes a correctly rewritten clone (negative control)', () => {
    const fixed = STALE_INDEX.replace(SRC_OVERVIEW, DST_OVERVIEW).replace(SRC_VERIF, '1MD2-cfxw8Q01fZ2e0JnfzKQPFPmGjR9u');
    const r = findLeftoverSourceIds(SOURCE, [
      { path: '4-connect/previews/connect-opportunity/_previews.yaml', text: fixed },
    ]);
    expect(r.hits).toEqual([]);
  });

  it('matches whole ids only: a copy id that starts with a source id is not a hit', () => {
    const r = findLeftoverSourceIds(SOURCE, [
      { path: 'run_state.yaml', text: `id: ${SRC_PDD}Z\nother: x${SRC_PDD}\n` },
    ]);
    expect(r.hits).toEqual([]);
  });

  it('reports comms-log ids separately: the clone leaves those files behind on purpose', () => {
    const r = findLeftoverSourceIds(SOURCE, [
      { path: 'run_state.yaml', text: `thread_log: ${SRC_COMMS}\n` },
    ]);
    expect(r.hits).toEqual([]);
    expect(r.leftBehind.map((h) => h.sourceId)).toEqual([SRC_COMMS]);
  });

  it('checks markdown copies too: the onboarding email linked the SOURCE FAQ (ace#2607)', () => {
    const r = findLeftoverSourceIds(SOURCE, [
      {
        path: '6-qa-and-training/training-onboarding-email.source.md',
        text: `[FAQ](https://docs.google.com/document/d/${SRC_PDD}/edit)`,
      },
    ]);
    expect(r.checked).toEqual(['6-qa-and-training/training-onboarding-email.source.md']);
    expect(r.hits.map((h) => h.sourceId)).toEqual([SRC_PDD]);
  });

  it("checks a Google Doc's hyperlink TARGETS, not only its visible text (ace#2607)", () => {
    const r = findLeftoverSourceIds(SOURCE, [
      {
        path: '6-qa-and-training/training-flw-guide.md',
        mimeType: GDOC,
        text: 'Step 3 — open the register (screenshot)\n',
        links: [`https://drive.google.com/file/d/${SRC_OVERVIEW}/view`],
      },
    ]);
    expect(r.hits.map((h) => [h.copyPath, h.sourceId])).toEqual([
      ['6-qa-and-training/training-flw-guide.md', SRC_OVERVIEW],
    ]);
  });

  it('reports decisions-log and eval-verdict ids as provenance, not hits', () => {
    const r = findLeftoverSourceIds(SOURCE, [
      { path: 'decisions.gdoc', mimeType: GDOC, text: `row cites ${SRC_PDD}` },
      { path: '3-commcare/pdd-to-learn-app-eval_verdict.yaml', text: `artifact: ${SRC_PDD}` },
    ]);
    expect(r.hits).toEqual([]);
    expect(r.provenance.map((h) => h.copyPath)).toEqual([
      'decisions.gdoc',
      '3-commcare/pdd-to-learn-app-eval_verdict.yaml',
    ]);
  });

  it('ignores binary copies', () => {
    const r = findLeftoverSourceIds(SOURCE, [
      { path: '3-commcare/previews/apps-learn/01.png', mimeType: 'image/png', text: SRC_PDD },
    ]);
    expect(r.checked).toEqual([]);
  });
});

describe('repair: copy-id map and rewrites (ace#2607)', () => {
  const src = [
    { id: 'S_FOLDER_previews_aaaaaaaaaaaaaa', path: '3-commcare/previews/' },
    { id: SRC_OVERVIEW, path: '3-commcare/previews/01.png' },
    { id: SRC_PDD, path: '1-design/pdd.md' },
    { id: 'S_DUPxxxxxxxxxxxxxxxxxxxxxxxxxxxx1', path: 'x/dup.md' },
    { id: 'S_DUPxxxxxxxxxxxxxxxxxxxxxxxxxxxx2', path: 'x/dup.md' },
    { id: SRC_COMMS, path: '8-solicitation-management/llo-invite_comms-log' },
  ];
  const dst = [
    { id: 'T_FOLDER_previews_aaaaaaaaaaaaaa', path: '3-commcare/previews/' },
    { id: DST_OVERVIEW, path: '3-commcare/previews/01.png' },
    { id: '1NEWpddCopyIdxxxxxxxxxxxxxxxxxxxx', path: '1-design/pdd.md' },
    { id: 'T_DUPxxxxxxxxxxxxxxxxxxxxxxxxxxxx1', path: 'x/dup.md' },
  ];

  it('pairs by relative path, includes folders and roots, never guesses a duplicate', () => {
    const m = buildCopyIdMap(src, dst, { source: 'SRCROOT', target: 'DSTROOT' });
    expect(m.ids).toEqual({
      SRCROOT: 'DSTROOT',
      S_FOLDER_previews_aaaaaaaaaaaaaa: 'T_FOLDER_previews_aaaaaaaaaaaaaa',
      [SRC_OVERVIEW]: DST_OVERVIEW,
      [SRC_PDD]: '1NEWpddCopyIdxxxxxxxxxxxxxxxxxxxx',
    });
    expect(m.ambiguous).toEqual(['x/dup.md']);
    expect(m.unmatched).toEqual(['8-solicitation-management/llo-invite_comms-log']);
  });

  it('rewrites whole ids in a markdown copy and leaves longer tokens alone', () => {
    const { ids } = buildCopyIdMap(src, dst);
    const r = rewriteDriveIds(`![a](https://drive.google.com/file/d/${SRC_OVERVIEW}/view) ${SRC_PDD}Z`, ids);
    expect(r.replacements).toBe(1);
    expect(r.text).toBe(`![a](https://drive.google.com/file/d/${DST_OVERVIEW}/view) ${SRC_PDD}Z`);
  });

  const doc = (url: string, visible: string) => ({
    body: {
      content: [
        { paragraph: { elements: [{ startIndex: 1, endIndex: 9, textRun: { content: 'See FAQ\n' } }] } },
        {
          table: {
            tableRows: [
              {
                tableCells: [
                  {
                    content: [
                      {
                        paragraph: {
                          elements: [
                            { startIndex: 12, endIndex: 20, textRun: { content: 'the deck', textStyle: { link: { url } } } },
                            { startIndex: 20, endIndex: 60, textRun: { content: visible } },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  });

  it('turns a formatted Doc into link-only style updates + replaceAllText, never a text rewrite', () => {
    const { ids } = buildCopyIdMap(src, dst);
    const r = docIdRewriteRequests(doc(`https://docs.google.com/document/d/${SRC_PDD}/edit`, ` id ${SRC_OVERVIEW}\n`), ids);
    expect(r.links).toBe(1);
    expect(r.textIds).toBe(1);
    expect(r.requests).toEqual([
      {
        updateTextStyle: {
          range: { startIndex: 12, endIndex: 20 },
          textStyle: { link: { url: 'https://docs.google.com/document/d/1NEWpddCopyIdxxxxxxxxxxxxxxxxxxxx/edit' } },
          fields: 'link',
        },
      },
      { replaceAllText: { containsText: { text: SRC_OVERVIEW, matchCase: true }, replaceText: DST_OVERVIEW } },
    ]);
  });

  it('emits nothing for a Doc already pointing at copies (negative control)', () => {
    const { ids } = buildCopyIdMap(src, dst);
    const r = docIdRewriteRequests(doc(`https://drive.google.com/file/d/${DST_OVERVIEW}/view`, ' plain\n'), ids);
    expect(r.requests).toEqual([]);
    expect(docTextAndLinks(doc('u', 'v')).links).toEqual([
      { url: 'u', startIndex: 12, endIndex: 20, segmentId: undefined },
    ]);
  });

  it('refuses replaceAllText for an id that also sits inside a longer token', () => {
    const { ids } = buildCopyIdMap(src, dst);
    const r = docIdRewriteRequests(doc('x', ` ${SRC_OVERVIEW} and ${SRC_OVERVIEW}Q\n`), ids);
    expect(r.unsafe).toEqual([SRC_OVERVIEW]);
    expect(r.requests).toEqual([]);
  });
});

describe('path predicates', () => {
  it('treats every text file and Google Doc as id-bearing, binaries not', () => {
    expect(isIdBearingCopy('3-commcare/previews/apps-learn/_previews.yaml')).toBe(true);
    expect(isIdBearingCopy('x/_previews.yml')).toBe(true);
    expect(isIdBearingCopy('6-qa-and-training/training-flw-guide.source.md')).toBe(true);
    expect(isIdBearingCopy('6-qa-and-training/training-flw-guide.md', GDOC)).toBe(true);
    expect(isIdBearingCopy('Training Deck', GDOC)).toBe(true);
    expect(isIdBearingCopy('3-commcare/previews/apps-learn/01.png')).toBe(false);
    expect(isIdBearingCopy('6-qa-and-training/walk.mp4', 'video/mp4')).toBe(false);
  });

  it('marks the decisions log and eval/QA records as provenance', () => {
    expect(isProvenanceCopy('decisions.yaml')).toBe(true);
    expect(isProvenanceCopy('decisions.gdoc')).toBe(true);
    expect(isProvenanceCopy('6-qa-and-training/training-llo-guide-eval_verdict.yaml')).toBe(true);
    expect(isProvenanceCopy('5-ocs/ocs-chatbot-qa_result.yaml')).toBe(true);
    expect(isProvenanceCopy('6-qa-and-training/training-onboarding-email.md')).toBe(false);
    expect(isProvenanceCopy('8-solicitation-management/solicitation-management_summary.md')).toBe(false);
  });

  it('mirrors ace-web run_cloner._skip_run_child', () => {
    expect(isLeftBehind('comms-log/llo-invite.md')).toBe(true);
    expect(isLeftBehind('8-solicitation-management/llo-invite_comms-log')).toBe(true);
    expect(isLeftBehind('8-solicitation-management/solicitation.md')).toBe(false);
  });
});
