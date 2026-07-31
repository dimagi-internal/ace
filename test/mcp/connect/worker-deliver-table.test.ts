import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseWorkerDeliverTable,
  stripTagsAttributeAware,
  WorkerDeliverTableSchemaError,
} from '../../../mcp/connect/backends/html-scrape.js';

// Captured live 2026-07-30 from
// GET /a/ai-demo-space/opportunity/1a30f061-.../workers/deliver/ (HX-Request: true)
const FIXTURE = readFileSync(
  fileURLToPath(new URL('../../fixtures/connect-worker-deliver-table.html', import.meta.url)),
  'utf8',
);

describe('parseWorkerDeliverTable (dimagi-internal/ace#1066)', () => {
  it('reads the real counts off the live fragment', () => {
    const { workers } = parseWorkerDeliverTable(FIXTURE);
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({
      name: 'ACE Test',
      payment_unit: 'Per verified bednet visit',
      delivered: 2,
      approved: 2,
      rejected: 0,
      progress_completed: 2,
      progress_total: 5,
    });
  });

  it('does NOT read numbers out of Alpine/htmx attributes (the silent-wrong-answer trap)', () => {
    // Connect renders Delivered/Approved/Rejected inside an Alpine
    // `x-data="{ ... }"` whose JS body contains BOTH angle brackets
    // (`window.innerHeight - rect.bottom < rect.height`) and integers, plus an
    // `hx-get="...?status=approved&payment_unit_id=..."` URL.
    //
    // A naive /<[^>]+>/g strip terminates the tag at the first `>` INSIDE that
    // attribute and leaks script text into the "visible" text. Measured on this
    // same fixture, that yields Approved=1 / Rejected=1 — where the truth is 2
    // and 0. It does not throw; it silently reports wrong counts, which for a
    // #1066 gate means fabricating evidence that a delivery was approved.
    const row = FIXTURE.match(
      /<tr\b[^>]*class="[^"]*\b(?:even|odd)\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/,
    )![1];
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);

    const naiveFirstInt = (h: string) => {
      const m = h.replace(/<[^>]+>/g, ' ').match(/-?\d+/);
      return m ? Number(m[0]) : null;
    };
    const smartFirstInt = (h: string) => {
      const m = stripTagsAttributeAware(h).match(/-?\d+/);
      return m ? Number(m[0]) : null;
    };

    // Approved cell (index 7) — the naive read is demonstrably wrong here.
    expect(naiveFirstInt(cells[7])).toBe(1);
    expect(smartFirstInt(cells[7])).toBe(2);
    // Rejected cell (index 8) — same.
    expect(naiveFirstInt(cells[8])).toBe(1);
    expect(smartFirstInt(cells[8])).toBe(0);
  });

  it('returns an empty roster rather than throwing when there are no data rows', () => {
    expect(parseWorkerDeliverTable('<table><thead></thead><tbody></tbody></table>')).toEqual({
      workers: [],
    });
  });

  it('fails loud on a template reshape instead of shifting fields', () => {
    // Drop the Approved column from the header row but keep a data row.
    const reshaped = FIXTURE.replace(/<th[^>]*>[\s\S]*?Approved[\s\S]*?<\/th>/, '');
    expect(() => parseWorkerDeliverTable(reshaped)).toThrow(WorkerDeliverTableSchemaError);
  });

  it('resolves columns by header label, not fixed index', () => {
    // The table has a leading "#" and "Status" column ahead of Name; a
    // fixed-index parser would mis-read every field.
    const { workers } = parseWorkerDeliverTable(FIXTURE);
    expect(workers[0].name).not.toMatch(/^\d+$/);
    expect(workers[0].last_active).toMatch(/\d{4}/);
  });
});
