import { describe, expect, it } from 'vitest';
import {
  findLeftoverSourceIds,
  isIdBearingCopy,
  isLeftBehind,
} from '../../lib/clone-readback.js';

// Ids from the live repro (dimagi-internal/ace#2603, spark/spark-facilitator/20261001-2208).
const SRC_OVERVIEW = '1x_InS0toha6u1A_pi-6MkyBUbF1jCHsy';
const SRC_VERIF = '1gFjL277FH_HJHiqg5tyjVwMiEXwP1dhO';
const DST_OVERVIEW = '17G-cQr5pq89EPyejUAJ4-g7ZQUpOoEM1';
const SRC_PDD = '1AAAApddSourceDocIdxxxxxxxxxxxxxx';
const SRC_COMMS = '1CCCCcommsLogSourceIdxxxxxxxxxxxxx';

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

  it('ignores non-YAML copies (a source id quoted in prose is not a broken link index)', () => {
    const r = findLeftoverSourceIds(SOURCE, [
      { path: '1-design/pdd.md', text: `see ${SRC_OVERVIEW}` },
    ]);
    expect(r.checked).toEqual([]);
    expect(r.hits).toEqual([]);
  });
});

describe('path predicates', () => {
  it('treats every YAML file as id-bearing', () => {
    expect(isIdBearingCopy('3-commcare/previews/apps-learn/_previews.yaml')).toBe(true);
    expect(isIdBearingCopy('x/_previews.yml')).toBe(true);
    expect(isIdBearingCopy('3-commcare/previews/apps-learn/01.png')).toBe(false);
  });

  it('mirrors ace-web run_cloner._skip_run_child', () => {
    expect(isLeftBehind('comms-log/llo-invite.md')).toBe(true);
    expect(isLeftBehind('8-solicitation-management/llo-invite_comms-log')).toBe(true);
    expect(isLeftBehind('8-solicitation-management/solicitation.md')).toBe(false);
  });
});
