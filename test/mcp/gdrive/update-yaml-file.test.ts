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
    const yaml = YAML.stringify({ phase: 'design-review', status: 'in_progress', foo: 'bar' });
    const fake = makeFakeDriveWithDoc(yaml, '5');

    const r = await handleUpdateYamlFile(
      { fileId: 'f1', patch: { status: 'done', new_field: 42 } },
      fake as any,
    );

    const updated = YAML.parse(fake.state.content);
    expect(updated).toEqual({
      phase: 'design-review',
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
      { fileId: 'f1', patch: { phase: 'design-review' } },
      fake as any,
    );

    expect(YAML.parse(fake.state.content)).toEqual({ phase: 'design-review' });
  });

  it('top-level replace, not deep merge', async () => {
    const yaml = YAML.stringify({ connect: { opportunity_id: 1, payment_units: [{ name: 'a' }] } });
    const fake = makeFakeDriveWithDoc(yaml, '1');

    await handleUpdateYamlFile(
      { fileId: 'f1', patch: { connect: { opportunity_id: 2 } } },
      fake as any,
    );

    // Replace, not merge: payment_units is gone.
    expect(YAML.parse(fake.state.content)).toEqual({ connect: { opportunity_id: 2 } });
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

  it('shallow mode wipes siblings under the patched key (the bug)', async () => {
    const yaml = YAML.stringify({
      phases: {
        'design-review': { status: 'done', verdict: 'pass' },
        'commcare-setup': { status: 'in_progress' },
      },
    });
    const fake = makeFakeDriveWithDoc(yaml, '1');

    await handleUpdateYamlFile(
      {
        fileId: 'f1',
        patch: { phases: { 'commcare-setup': { steps: { 'commcare-form-patch': { status: 'done' } } } } },
      },
      fake as any,
    );

    // Bug: design-review entirely wiped; commcare-setup.status also wiped.
    expect(YAML.parse(fake.state.content)).toEqual({
      phases: {
        'commcare-setup': { steps: { 'commcare-form-patch': { status: 'done' } } },
      },
    });
  });

  it('deep mode preserves siblings at every nesting level', async () => {
    const yaml = YAML.stringify({
      phases: {
        'design-review': { status: 'done', verdict: 'pass' },
        'commcare-setup': { status: 'in_progress', steps: { 'app-build': { status: 'done' } } },
      },
    });
    const fake = makeFakeDriveWithDoc(yaml, '1');

    await handleUpdateYamlFile(
      {
        fileId: 'f1',
        patch: { phases: { 'commcare-setup': { steps: { 'commcare-form-patch': { status: 'done' } } } } },
        mergeMode: 'deep',
      },
      fake as any,
    );

    expect(YAML.parse(fake.state.content)).toEqual({
      phases: {
        'design-review': { status: 'done', verdict: 'pass' },
        'commcare-setup': {
          status: 'in_progress',
          steps: {
            'app-build': { status: 'done' },
            'commcare-form-patch': { status: 'done' },
          },
        },
      },
    });
  });

  it('deep mode replaces arrays (does not concat)', async () => {
    const yaml = YAML.stringify({
      connect: { payment_units: [{ name: 'a' }, { name: 'b' }] },
    });
    const fake = makeFakeDriveWithDoc(yaml, '1');

    await handleUpdateYamlFile(
      {
        fileId: 'f1',
        patch: { connect: { payment_units: [{ name: 'c' }] } },
        mergeMode: 'deep',
      },
      fake as any,
    );

    expect(YAML.parse(fake.state.content)).toEqual({
      connect: { payment_units: [{ name: 'c' }] },
    });
  });

  it('deep mode replaces on object-vs-non-object mismatch', async () => {
    const yaml = YAML.stringify({
      gates: { 'app-deploy': { passed: true, evidence: 'foo' } },
    });
    const fake = makeFakeDriveWithDoc(yaml, '1');

    // Replace object with primitive
    await handleUpdateYamlFile(
      {
        fileId: 'f1',
        patch: { gates: { 'app-deploy': 'closed' } },
        mergeMode: 'deep',
      },
      fake as any,
    );

    expect(YAML.parse(fake.state.content)).toEqual({
      gates: { 'app-deploy': 'closed' },
    });

    // And primitive replaced with object
    await handleUpdateYamlFile(
      {
        fileId: 'f1',
        patch: { gates: { 'app-deploy': { reopened: true } } },
        mergeMode: 'deep',
      },
      fake as any,
    );

    expect(YAML.parse(fake.state.content)).toEqual({
      gates: { 'app-deploy': { reopened: true } },
    });
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
