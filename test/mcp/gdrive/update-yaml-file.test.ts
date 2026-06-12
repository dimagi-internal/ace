import { describe, it, expect, vi, beforeEach } from 'vitest';
import YAML from 'yaml';
import { handleUpdateYamlFile } from '../../../mcp/google-drive-server.js';

// Build a fake drive whose state is a single in-memory document. Each
// files.get returns the current content + version; files.update writes
// content + bumps version. Tests can mutate `state` between calls to
// simulate a concurrent writer (revision_conflict path).
function makeFakeDriveWithDoc(initialContent: string, initialVersion = '1') {
  const state = { content: initialContent, version: initialVersion };
  return {
    state,
    files: {
      get: vi.fn(async (req: any) => {
        if (req.alt === 'media') return { data: state.content };
        return { data: { mimeType: 'application/vnd.google-apps.document', name: 'state.yaml', version: state.version } };
      }),
      export: vi.fn(async () => ({ data: state.content })),
      update: vi.fn(async (req: any) => {
        // Caller passes media.body as string for text/plain
        const body = req.media?.body;
        state.content = typeof body === 'string' ? body : String(body);
        state.version = String(Number(state.version) + 1);
        return { data: { id: req.fileId, name: 'state.yaml', modifiedTime: '2026-05-05T00:00:00Z', version: state.version } };
      }),
    },
  };
}

describe('update_yaml_file: server-side patch+CAS', () => {
  it('merges top-level keys into existing YAML and writes once', async () => {
    const yaml = YAML.stringify({ phase: 'idea-to-design', status: 'in_progress', foo: 'bar' });
    const fake = makeFakeDriveWithDoc(yaml, '5');

    const r = await handleUpdateYamlFile(
      { fileId: 'f1', patch: { status: 'done', new_field: 42 } },
      fake as any,
    );

    const updated = YAML.parse(fake.state.content);
    expect(updated).toEqual({
      phase: 'idea-to-design',
      status: 'done',          // replaced
      foo: 'bar',              // preserved
      new_field: 42,           // added
    });
    expect(r.revisionVersion).toBe('6');
    expect(fake.files.update).toHaveBeenCalledTimes(1);
  });

  it('treats empty/missing content as {} and writes the patch', async () => {
    const fake = makeFakeDriveWithDoc('', '1');

    await handleUpdateYamlFile(
      { fileId: 'f1', patch: { phase: 'idea-to-design' } },
      fake as any,
    );

    expect(YAML.parse(fake.state.content)).toEqual({ phase: 'idea-to-design' });
  });

  it('top-level replace, not deep merge (default = shallow)', async () => {
    const yaml = YAML.stringify({ connect: { opportunity_id: 1, payment_units: [{ name: 'a' }] } });
    const fake = makeFakeDriveWithDoc(yaml, '1');

    await handleUpdateYamlFile(
      { fileId: 'f1', patch: { connect: { opportunity_id: 2 } } },
      fake as any,
    );

    // Replace, not merge: payment_units is gone.
    expect(YAML.parse(fake.state.content)).toEqual({ connect: { opportunity_id: 2 } });
  });

  it('two-level merge: object-valued top-level keys merge one level deeper, sibling child keys preserved', async () => {
    // Simulates the run_state.yaml write-back flow: two phase agents
    // each own one entry under `phases:` and must not clobber the other.
    const yaml = YAML.stringify({
      opportunity: 'leep-paint-collection',
      phases: { 'idea-to-design': { status: 'done', verdict: 'pass' } },
      gates: { 'idea-to-pdd': 'approved' },
    });
    const fake = makeFakeDriveWithDoc(yaml, '5');

    await handleUpdateYamlFile(
      {
        fileId: 'f1',
        patch: {
          phases: { 'commcare-setup': { status: 'done', verdict: 'pass' } },
          gates: { 'app-deploy': 'pass' },
          last_actor: 'jjackson@dimagi.com',
        },
        merge: 'two-level',
      },
      fake as any,
    );

    expect(YAML.parse(fake.state.content)).toEqual({
      opportunity: 'leep-paint-collection',
      phases: {
        'idea-to-design': { status: 'done', verdict: 'pass' },        // preserved
        'commcare-setup': { status: 'done', verdict: 'pass' },        // added
      },
      gates: {
        'idea-to-pdd': 'approved',                                    // preserved
        'app-deploy': 'pass',                                         // added
      },
      last_actor: 'jjackson@dimagi.com',                              // top-level scalar, replaced as usual
    });
  });

  it('two-level merge: child-key conflict — patch wins (replaces just that child)', async () => {
    const yaml = YAML.stringify({
      phases: { 'idea-to-design': { status: 'in_progress', verdict: null } },
    });
    const fake = makeFakeDriveWithDoc(yaml, '1');

    await handleUpdateYamlFile(
      {
        fileId: 'f1',
        patch: { phases: { 'idea-to-design': { status: 'done', verdict: 'pass' } } },
        merge: 'two-level',
      },
      fake as any,
    );

    expect(YAML.parse(fake.state.content)).toEqual({
      phases: { 'idea-to-design': { status: 'done', verdict: 'pass' } },
    });
  });

  it('two-level merge: non-object values still replace (arrays, scalars), and missing-on-base falls through to shallow', async () => {
    const yaml = YAML.stringify({ tags: ['a', 'b'], counter: 1 });
    const fake = makeFakeDriveWithDoc(yaml, '1');

    await handleUpdateYamlFile(
      {
        fileId: 'f1',
        patch: { tags: ['c'], counter: 2, new_obj: { x: 1 } },
        merge: 'two-level',
      },
      fake as any,
    );

    // Arrays and scalars replace; brand-new top-level keys land as-is.
    expect(YAML.parse(fake.state.content)).toEqual({ tags: ['c'], counter: 2, new_obj: { x: 1 } });
  });

  it('deep merge: patching a NESTED path preserves grandchild siblings (the lost-update footgun #572)', async () => {
    // Reproduces the bednet-spot-check/20260529-1124 corruption: a partial
    // `two-level` patch of one step under a phase wiped the rest of the phase
    // block (products + other steps). `deep` must preserve them.
    const yaml = YAML.stringify({
      phases: {
        'commcare-setup': {
          status: 'done',
          verdict: 'proceed',
          products: { apps: { learn: { hq_app_id: 'L' }, deliver: { hq_app_id: 'D' } } },
          steps: {
            'pdd-to-learn-app': { status: 'done' },
            'app-release-qa': { status: 'done', artifact: '3-commcare/app-release-qa_verdict.yaml' },
          },
        },
        'connect-setup': { status: 'pending' },
      },
    });
    const fake = makeFakeDriveWithDoc(yaml, '1');

    // Patch ONLY the one step's artifact path, three levels deep.
    await handleUpdateYamlFile(
      {
        fileId: 'f1',
        patch: { phases: { 'commcare-setup': { steps: { 'app-release-qa': { artifact: '3-commcare/app-release-qa_result.yaml' } } } } },
        merge: 'deep',
      },
      fake as any,
    );

    expect(YAML.parse(fake.state.content)).toEqual({
      phases: {
        'commcare-setup': {
          status: 'done',                                    // preserved
          verdict: 'proceed',                                // preserved
          products: { apps: { learn: { hq_app_id: 'L' }, deliver: { hq_app_id: 'D' } } }, // preserved
          steps: {
            'pdd-to-learn-app': { status: 'done' },          // sibling step preserved
            'app-release-qa': {
              status: 'done',                                // sibling key in same step preserved
              artifact: '3-commcare/app-release-qa_result.yaml', // updated
            },
          },
        },
        'connect-setup': { status: 'pending' },              // sibling phase preserved
      },
    });
  });

  it('deep merge: arrays and scalars replace wholesale (no array concat)', async () => {
    const yaml = YAML.stringify({ a: { list: [1, 2], n: 1, keep: 'x' } });
    const fake = makeFakeDriveWithDoc(yaml, '1');

    await handleUpdateYamlFile(
      { fileId: 'f1', patch: { a: { list: [9], n: 2 } }, merge: 'deep' },
      fake as any,
    );

    expect(YAML.parse(fake.state.content)).toEqual({ a: { list: [9], n: 2, keep: 'x' } });
  });

  it('retries once on revision_conflict (concurrent writer wins, we re-read)', async () => {
    const yaml = YAML.stringify({ phase: 'a', counter: 1 });
    const fake = makeFakeDriveWithDoc(yaml, '5');

    // First update call: simulate conflict by bumping the doc behind our back
    // and rejecting the call.
    let firstCall = true;
    const realUpdate = fake.files.update;
    fake.files.update = vi.fn(async (req: any) => {
      if (firstCall) {
        firstCall = false;
        // Concurrent writer landed: bump version + change content.
        fake.state.content = YAML.stringify({ phase: 'a', counter: 2, sneak: true });
        fake.state.version = '6';
        const e: any = new Error(`revision_conflict: file ${req.fileId} revisionVersion is 6, expected 5.`);
        throw e;
      }
      return realUpdate(req);
    }) as any;

    await handleUpdateYamlFile(
      { fileId: 'f1', patch: { phase: 'b' } },
      fake as any,
    );

    // After retry: phase replaced, counter+sneak preserved from concurrent write.
    expect(YAML.parse(fake.state.content)).toEqual({ phase: 'b', counter: 2, sneak: true });
    expect(fake.files.update).toHaveBeenCalledTimes(2);
  });

  it('gives up after 1 retry on persistent revision_conflict', async () => {
    const yaml = YAML.stringify({ x: 1 });
    const fake = makeFakeDriveWithDoc(yaml, '1');

    fake.files.update = vi.fn(async () => {
      throw new Error('revision_conflict: file f1 revisionVersion is 999, expected 1.');
    }) as any;

    await expect(
      handleUpdateYamlFile({ fileId: 'f1', patch: { x: 2 } }, fake as any),
    ).rejects.toThrow(/revision_conflict/);

    // 1 initial + 1 retry = 2 update attempts
    expect(fake.files.update).toHaveBeenCalledTimes(2);
  });
});

describe('update_yaml_file: validateAs phase-products contract guard', () => {
  it('rejects a drifted products write BEFORE any Drive read/write', async () => {
    const fake = makeFakeDriveWithDoc(YAML.stringify({ phases: {} }), '1');

    await expect(
      handleUpdateYamlFile(
        {
          fileId: 'f1',
          // the malaria-rdt drift: products.opportunity instead of products.connect.opportunity
          patch: { phases: { 'connect-setup': { status: 'done', products: { opportunity: { url: 'https://connect.dimagi.com/a/x/opportunity/o1/' } } } } },
          merge: 'deep',
          validateAs: { kind: 'phase-products', phase: 'connect-setup' },
        },
        fake as any,
      ),
    ).rejects.toThrow(/INVALID_PHASE_PRODUCTS/);

    // fail-fast: no Drive read and no write happened on the rejected payload
    expect(fake.files.update).not.toHaveBeenCalled();
    expect(fake.files.get).not.toHaveBeenCalled();
  });

  it('lets a contract-shaped products write through', async () => {
    const fake = makeFakeDriveWithDoc(YAML.stringify({ phases: {} }), '1');

    const r = await handleUpdateYamlFile(
      {
        fileId: 'f1',
        patch: { phases: { 'connect-setup': { status: 'done', products: { connect: { domain: 'connect-ace-prod', opportunity: { url: 'https://connect.dimagi.com/a/x/opportunity/o1/' } } } } } },
        merge: 'deep',
        validateAs: { kind: 'phase-products', phase: 'connect-setup' },
      },
      fake as any,
    );

    expect(r.revisionVersion).toBe('2');
    const written = YAML.parse(fake.state.content);
    expect(written.phases['connect-setup'].products.connect.domain).toBe('connect-ace-prod');
  });

  it('is a no-op for a status-only patch (no products in the patch)', async () => {
    const fake = makeFakeDriveWithDoc(YAML.stringify({ phases: {} }), '1');
    const r = await handleUpdateYamlFile(
      {
        fileId: 'f1',
        patch: { phases: { 'connect-setup': { status: 'done' } } },
        merge: 'deep',
        validateAs: { kind: 'phase-products', phase: 'connect-setup' },
      },
      fake as any,
    );
    expect(r.revisionVersion).toBe('2');
  });
});

// jjackson/ace#751 — the Google Docs text/plain upload→export round-trip is
// NOT identity: interior blank-line runs DOUBLE per cycle (measured live
// 2026-06-12 on doc 1X2UFGsOz8NvfsNlmTwzJSl0X9LMXmR_EbPepnPcnOPs: upload
// "A\n\nB\n" exports "A\r\n\r\n\r\nB"; "A\n\n\nB" exports 5 breaks). A folded
// `notes:` scalar with one blank line therefore grows exponentially across
// update_yaml_file cycles until the Docs API rejects the write with a bare
// Bad Request (run_state.yaml hit 8.4MB on bednet-spot-check/20260609-0909).
describe('update_yaml_file: Docs newline-amplification preventers (#751)', () => {
  // Fake drive whose export applies the MEASURED Docs transform: every
  // interior run of n>=2 line breaks comes back as 2n-1 breaks (one blank
  // line -> two), single breaks stable, CRLF endings, trailing newline dropped.
  function makeAmplifyingFakeDrive(initialContent: string, initialVersion = '1') {
    const state = { content: initialContent, version: initialVersion };
    const amplify = (s: string) =>
      s
        .replace(/\n{2,}/g, (m) => '\n'.repeat(2 * m.length - 1))
        .replace(/\n$/, '')
        .replace(/\n/g, '\r\n');
    return {
      state,
      files: {
        get: vi.fn(async (req: any) => {
          if (req.alt === 'media') return { data: amplify(state.content) };
          return { data: { mimeType: 'application/vnd.google-apps.document', name: 'state.yaml', version: state.version } };
        }),
        export: vi.fn(async () => ({ data: amplify(state.content) })),
        update: vi.fn(async (req: any) => {
          const body = req.media?.body;
          state.content = typeof body === 'string' ? body : String(body);
          state.version = String(Number(state.version) + 1);
          return { data: { id: req.fileId, name: 'state.yaml', modifiedTime: '2026-06-12T00:00:00Z', version: state.version } };
        }),
      },
    };
  }

  it('repeated patches reach a fixpoint instead of exponential blank-line growth', async () => {
    const initial = 'notes: >\n  sentence one\n\n\n  sentence two\ntick: 0\n';
    const fake = makeAmplifyingFakeDrive(initial);
    for (let i = 1; i <= 8; i++) {
      await handleUpdateYamlFile({ fileId: 'f1', patch: { tick: i } }, fake as any);
    }
    // Without read-normalization the blank-line run doubles each of the 8
    // cycles (~2^8 newlines). With it, content stays the same order of
    // magnitude as the original.
    expect(fake.state.content.length).toBeLessThan(initial.length * 3);
    const notes = YAML.parse(fake.state.content.replace(/\r\n/g, '\n')).notes as string;
    expect(notes).toMatch(/sentence one/);
    expect(notes).toMatch(/sentence two/);
    expect(/\n{3,}/.test(notes)).toBe(false);
  });

  it('refuses an oversized serialized doc with YAML_BALLOON_DETECTED naming the largest scalar', async () => {
    const fake = makeAmplifyingFakeDrive('phase: x\n');
    const balloon = 'line\n\n'.repeat(50_000); // ~300KB string scalar
    await expect(
      handleUpdateYamlFile({ fileId: 'f1', patch: { notes: balloon } }, fake as any),
    ).rejects.toThrow(/YAML_BALLOON_DETECTED[\s\S]*notes/);
    // No write happened — the guard fires before the Drive update.
    expect(fake.files.update).not.toHaveBeenCalled();
  });
});
