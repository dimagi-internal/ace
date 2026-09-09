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

  // ---------------------------------------------------------------------
  // dimagi-internal/ace#1467 — the LOST-RESIDUAL repro, named.
  //
  // The generic array test above already pinned the semantics, and it passed
  // the whole time. That is the point: the CODE was never wrong. CLAUDE.md
  // described `deep` as "recursive, preserves siblings at every depth", which
  // is true for object keys and false for array elements, and
  // app-hq-settings carried the inverse-but-also-false rationale that deep
  // "can only add/update entries, never remove one".
  //
  // So this test exists to pin the SHAPE that actually loses data in
  // production — successive partial patches of an array-valued phase key —
  // rather than the abstract rule. residuals[] is standing state with no
  // status field: Phase 6 treats presence as open, so a silently dropped
  // entry is indistinguishable from a resolved one.
  // ---------------------------------------------------------------------
  it('deep merge: successive partial patches of residuals[] keep ONLY the last (#1467)', async () => {
    const yaml = YAML.stringify({
      phases: {
        'commcare-setup': {
          status: 'in-progress',
          residuals: [{ id: 'camera-only' }, { id: 'grid-menu' }],
        },
      },
    });
    const fake = makeFakeDriveWithDoc(yaml, '1');

    // A caller who believes "deep preserves siblings at every depth" writes
    // just the one residual it owns.
    await handleUpdateYamlFile(
      {
        fileId: 'f1',
        patch: { phases: { 'commcare-setup': { residuals: [{ id: 'camera-only' }] } } },
        merge: 'deep',
      },
      fake as any,
    );

    const after = YAML.parse(fake.state.content);
    // grid-menu is GONE — not merged, not appended. This is the data loss.
    expect(after.phases['commcare-setup'].residuals).toEqual([{ id: 'camera-only' }]);
    // ...while sibling OBJECT keys at the same depth survive, which is exactly
    // why the doc's wording read as safe.
    expect(after.phases['commcare-setup'].status).toBe('in-progress');
  });

  it('deep merge: the correct pattern is read, filter, write the WHOLE list (#1467)', async () => {
    // The remedy, pinned alongside the hazard so the fix is discoverable from
    // the failing test rather than only from a doc.
    const yaml = YAML.stringify({
      phases: {
        'commcare-setup': {
          status: 'in-progress',
          residuals: [{ id: 'camera-only' }, { id: 'grid-menu' }],
        },
      },
    });
    const fake = makeFakeDriveWithDoc(yaml, '1');

    const current = YAML.parse(fake.state.content).phases['commcare-setup'].residuals;
    const remaining = current.filter((r: { id: string }) => r.id !== 'camera-only');

    await handleUpdateYamlFile(
      { fileId: 'f1', patch: { phases: { 'commcare-setup': { residuals: remaining } } }, merge: 'deep' },
      fake as any,
    );

    const after = YAML.parse(fake.state.content);
    expect(after.phases['commcare-setup'].residuals).toEqual([{ id: 'grid-menu' }]);
    expect(after.phases['commcare-setup'].status).toBe('in-progress');
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

/**
 * ace#2296 — the serializer, which is where the defect actually came from.
 *
 * The issue exonerated `update_yaml_file` by testing **js-yaml**, which quotes
 * `'yes'` and uses single quotes. But this server imports the **`yaml`**
 * package (`mcp/google-drive-server.ts` line 23), and `YAML.stringify` resolves
 * the YAML 1.2 core schema by default: it emits the string `'yes'` BARE,
 * because to a 1.2 reader a bare `yes` IS the string. It also double-quotes
 * `+74260000101`. Both halves of the Drive file's fingerprint — bare `yes`,
 * double-quoted phone — are this serializer's output, so the block did come
 * through `update_yaml_file` after all.
 *
 * Fix: serialize with `{version: '1.1'}`, which quotes every string a YAML 1.1
 * reader would re-resolve. Parsing stays on 1.2 ON PURPOSE — switching the READ
 * to 1.1 would coerce existing bare `yes` values in already-written files into
 * booleans and write them back as `true`, which is the read-modify-write
 * corruption the issue warns about.
 */
describe('update_yaml_file: YAML 1.1-safe serialization (ace#2296)', () => {
  it('quotes a `yes` string value so PyYAML cannot read it as a boolean', async () => {
    const fake = makeFakeDriveWithDoc('', '1');
    await handleUpdateYamlFile(
      { fileId: 'f1', patch: { question_value: 'yes', phone: '+74260000101' } },
      fake as any,
    );
    expect(fake.state.content).toContain('question_value: "yes"');
    expect(fake.state.content).not.toMatch(/question_value: yes\s*$/m);
  });

  it('writes the payability predicate so BOTH dialects read the same string', async () => {
    const fake = makeFakeDriveWithDoc('', '1');
    await handleUpdateYamlFile(
      {
        fileId: 'f1',
        merge: 'deep',
        patch: {
          phases: {
            'connect-setup': {
              products: {
                connect: {
                  opportunity: {
                    verification: {
                      form_field_rules: [
                        {
                          name: 'consent_confirmed=yes',
                          question_path: 'form.consent_to_continue.consent_confirmed',
                          question_value: 'yes',
                          deliver_unit_id: 6862,
                        },
                      ],
                      form_field_rules_saved: 1,
                    },
                  },
                },
              },
            },
          },
        },
      },
      fake as any,
    );
    const at = (opts: any) =>
      (YAML.parse(fake.state.content, opts) as any).phases['connect-setup'].products.connect
        .opportunity.verification.form_field_rules[0].question_value;
    expect(at(undefined)).toBe('yes');       // YAML 1.2 — the plugin
    expect(at({ version: '1.1' })).toBe('yes'); // YAML 1.1 — PyYAML / ace-web
  });

  it('quotes every ambiguous token, not just `yes`', async () => {
    const fake = makeFakeDriveWithDoc('', '1');
    const tokens = ['y', 'Y', 'n', 'N', 'yes', 'YES', 'no', 'No', 'on', 'ON', 'off', 'Off'];
    const patch: Record<string, string> = {};
    tokens.forEach((t, i) => (patch[`k${i}`] = t));
    await handleUpdateYamlFile({ fileId: 'f1', patch }, fake as any);
    const under11 = YAML.parse(fake.state.content, { version: '1.1' });
    tokens.forEach((t, i) => expect(under11[`k${i}`]).toBe(t));
  });

  it('leaves genuine booleans, numbers and plain strings unquoted', async () => {
    const fake = makeFakeDriveWithDoc('', '1');
    await handleUpdateYamlFile(
      { fileId: 'f1', patch: { flag: true, count: 12, score: 8.5, status: 'done', empty: null } },
      fake as any,
    );
    expect(fake.state.content).toContain('flag: true');
    expect(fake.state.content).toContain('count: 12');
    expect(fake.state.content).toContain('score: 8.5');
    expect(fake.state.content).toContain('status: done');
    expect(fake.state.content).toContain('empty: null');
  });

  it('round-trips a repeated patch cycle without drift (1.1-write / 1.2-read is stable)', async () => {
    const fake = makeFakeDriveWithDoc('', '1');
    const payload = { question_value: 'yes', started_at: '2026-09-08T21:44:35Z', v: '1.10' };
    await handleUpdateYamlFile({ fileId: 'f1', patch: payload }, fake as any);
    const first = fake.state.content;
    for (let i = 0; i < 3; i++) {
      await handleUpdateYamlFile({ fileId: 'f1', patch: { tick: i } }, fake as any);
    }
    const parsed = YAML.parse(fake.state.content);
    expect(parsed).toMatchObject(payload);
    expect(YAML.parse(fake.state.content, { version: '1.1' })).toMatchObject(payload);
    // The ambiguous keys are byte-identical across cycles — no re-quoting churn.
    for (const line of first.split('\n').filter((l) => l.trim())) {
      expect(fake.state.content).toContain(line);
    }
  });
});
