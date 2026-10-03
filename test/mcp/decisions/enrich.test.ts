/**
 * `decisions_enrich` (mcp/decisions-server.ts): reads decisions.yaml and
 * run_state.yaml from the run folder, applies the v6 review contract, and
 * writes only on change. Fixture: the real spark-facilitator/20261001-2208
 * pair.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { handleEnrich } from '../../../mcp/decisions-server.js';
import { parseDecisionsYaml } from '../../../lib/decisions-schema.js';

const DIR = join(__dirname, '..', '..', 'fixtures', 'decisions-backfill', 'spark-facilitator-20261001-2208');
const DECISIONS = readFileSync(join(DIR, 'decisions.yaml'), 'utf8');
const RUN_STATE = readFileSync(join(DIR, 'run_state.yaml'), 'utf8');

function fakeDrive(decisions: string) {
  const writes: string[] = [];
  return {
    writes,
    files: {
      list: vi.fn(async ({ q }: { q: string }) =>
        q.includes("name='decisions.yaml'")
          ? { data: { files: [{ id: 'dec', mimeType: 'application/vnd.google-apps.document' }] } }
          : { data: { files: [{ id: 'rs', mimeType: 'text/plain' }] } },
      ),
      export: vi.fn(async () => ({ data: decisions })),
      get: vi.fn(async () => ({ data: RUN_STATE })),
      update: vi.fn(async (args: { media: { body: string } }) => {
        writes.push(args.media.body);
        return { data: { id: 'dec' } };
      }),
    },
  };
}

describe('decisions_enrich', () => {
  it('stamps the six Spark review asks and writes once', async () => {
    const fake = fakeDrive(DECISIONS);
    const r = await handleEnrich({ runFolderId: 'run' }, fake as never);
    expect(r.written).toBe(true);
    expect(r.reviewAsks.map((a) => a.id)).toContain('open-question-recording-path-whole-community-group-declines');
    expect(r.reviewAsks).toHaveLength(6);
    expect(fake.writes).toHaveLength(1);
    expect(parseDecisionsYaml(fake.writes[0]).schema_version).toBe(6);
  });

  it('is a no-op on an already-enriched log, and on dryRun', async () => {
    const first = fakeDrive(DECISIONS);
    await handleEnrich({ runFolderId: 'run' }, first as never);
    const again = fakeDrive(first.writes[0]);
    expect((await handleEnrich({ runFolderId: 'run' }, again as never)).written).toBe(false);
    const dry = fakeDrive(DECISIONS);
    expect((await handleEnrich({ runFolderId: 'run', dryRun: true }, dry as never)).written).toBe(false);
    expect(dry.writes).toEqual([]);
  });
});
