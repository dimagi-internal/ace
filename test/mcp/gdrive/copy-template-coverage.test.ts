import { describe, it, expect, vi } from 'vitest';
import { handleDocsCopyTemplate } from '../../../mcp/google-drive-server.js';

// ace#2126, the WIRING half.
//
// `test/lib/replacement-coverage.test.ts` proves the classifier is correct.
// It cannot prove the atom calls it: delete the `summarizeReplacementCoverage`
// line from `docs_copy_template` and that suite stays green while every
// unmatched key goes back to being invisible — which is the exact shape of the
// defect (the value evaporates and every checkpoint reads clean).
//
// These drive the atom end-to-end with an injected client that answers
// batchUpdate the way Google does: positionally, one reply per request, with
// `occurrencesChanged` ELIDED rather than sent as 0 when nothing matched.

function makeFakes(templateTokens: string[]) {
  const drive = {
    files: {
      copy: vi.fn(async (req: any) => ({
        data: {
          id: 'new-doc-1',
          name: req.requestBody?.name,
          webViewLink: 'https://docs.google.com/document/d/new-doc-1',
        },
      })),
    },
  };
  const docs = {
    documents: {
      batchUpdate: vi.fn(async (req: any) => ({
        data: {
          replies: (req.requestBody?.requests ?? []).map((r: any) =>
            templateTokens.includes(r.replaceAllText?.containsText?.text)
              ? { replaceAllText: { occurrencesChanged: 1 } }
              : { replaceAllText: {} },
          ),
        },
      })),
    },
  };
  return { drive, docs };
}

const parse = (res: any) => JSON.parse(res.content[0].text);

describe('docs_copy_template surfaces replacement coverage (ace#2126)', () => {
  it('names the unmatched key in the tool result, and only that key', async () => {
    const { drive, docs } = makeFakes(['{{background_body}}', '{{opp_title}}']);

    const out = parse(
      await handleDocsCopyTemplate(
        {
          templateDocId: 'TPL',
          title: 'pdd-to-work-order.gdoc',
          replacements: {
            '{{opp_title}}': 'Bednet Spot Check',
            '{{background_body}}': 'Some background.',
            '{{partner_first_reference}}': '[Partner Name] (henceforth, referred to as "partner")',
          },
        },
        drive as any,
        docs as any,
      ),
    );

    expect(out.unmatchedReplacements).toEqual(['{{partner_first_reference}}']);
    expect(out.warning).toContain('{{partner_first_reference}}');
    // The two that DID land must not be blamed.
    expect(out.warning).not.toContain('{{opp_title}}');
    expect(out.replacementOccurrences).toEqual({
      '{{opp_title}}': 1,
      '{{background_body}}': 1,
      '{{partner_first_reference}}': 0,
    });
    // The doc is still created and returned — the report is not a rollback.
    expect(out.id).toBe('new-doc-1');
  });

  it('reports no warning and an empty unmatched list when every key lands', async () => {
    const { drive, docs } = makeFakes(['{{a}}', '{{b}}']);

    const out = parse(
      await handleDocsCopyTemplate(
        { templateDocId: 'TPL', title: 't', replacements: { '{{a}}': '1', '{{b}}': '2' } },
        drive as any,
        docs as any,
      ),
    );

    expect(out.unmatchedReplacements).toEqual([]);
    expect(out.warning).toBeUndefined();
    expect(out.replacementOccurrences).toEqual({ '{{a}}': 1, '{{b}}': 1 });
  });

  it('omits the coverage block entirely when no replacements are supplied', async () => {
    const { drive, docs } = makeFakes([]);

    const out = parse(
      await handleDocsCopyTemplate({ templateDocId: 'TPL', title: 't' }, drive as any, docs as any),
    );

    expect(docs.documents.batchUpdate).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty('unmatchedReplacements');
    expect(out.id).toBe('new-doc-1');
  });

  it('sends one replaceAllText per key, matchCase, against the new copy — not the template', async () => {
    const { drive, docs } = makeFakes(['{{a}}']);

    await handleDocsCopyTemplate(
      { templateDocId: 'TPL', title: 't', replacements: { '{{a}}': '1' } },
      drive as any,
      docs as any,
    );

    const req = docs.documents.batchUpdate.mock.calls[0][0] as any;
    expect(req.documentId).toBe('new-doc-1');
    expect(req.requestBody.requests).toEqual([
      { replaceAllText: { containsText: { text: '{{a}}', matchCase: true }, replaceText: '1' } },
    ]);
  });

  it('does not swallow a coverage report when the API returns a short replies array', async () => {
    // Silence is not a match — a truncated/degraded reply must still surface.
    const drive = {
      files: { copy: vi.fn(async () => ({ data: { id: 'new-doc-1', name: 't', webViewLink: null } })) },
    };
    const docs = {
      documents: {
        batchUpdate: vi.fn(async () => ({
          data: { replies: [{ replaceAllText: { occurrencesChanged: 1 } }] },
        })),
      },
    };

    const out = parse(
      await handleDocsCopyTemplate(
        { templateDocId: 'TPL', title: 't', replacements: { '{{a}}': '1', '{{b}}': '2' } },
        drive as any,
        docs as any,
      ),
    );

    expect(out.unmatchedReplacements).toEqual(['{{b}}']);
  });
});
