/**
 * ace#2184 — `update_yaml_file` took its `patch` INLINE ONLY, while every
 * sibling gdrive write atom (`drive_update_file`, `drive_upload_binary`,
 * `drive_create_file`, `drive_create_doc_from_markdown`) had taken a
 * `localFilePath` handle for months.
 *
 * The cost is not symmetric across operations, which is why the atom's own
 * description ("the model only sends the diff") read as safe. Adding a key IS
 * a diff. Removing ONE element of an array is not: arrays are replaced
 * wholesale under every merge mode (ace#1467), so the payload for deleting one
 * entry is every SURVIVING entry, retyped by the model.
 *
 * Live repro, twice on bednet-check-2-visit/20260907-1126: `app-hq-settings`
 * Step 5 removed one of nine `phases.commcare-setup.residuals[]` entries and
 * had to retype ~5 KB of load-bearing prose — including a Phase-4 mandate for
 * a Connect verification rule rejecting `consent_confirmed != yes`, a PAYMENT
 * predicate — through the model to do it. That is exactly the
 * transport-fidelity risk ace#1795 removed from the XForm round trip in the
 * same skill by adding `new_xform_xml_path`.
 *
 * Two halves are tested here:
 *   1. the resolver contract (both/neither/malformed), in-process; and
 *   2. EQUIVALENCE — a file-sourced patch produces a byte-identical Drive
 *      write to the inline one it replaces.
 *
 * Plus source-level assertions on the registration, for the same reason
 * test/mcp/gdrive/write-atom-localfilepath.test.ts parses source:
 * `mcp/google-drive-server.ts` does a top-level `await server.connect(...)`.
 */
import { describe, it, expect, vi } from 'vitest';
import YAML from 'yaml';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleUpdateYamlFile } from '../../../mcp/google-drive-server.js';
import { resolveYamlPatch, AtomArgUsageError } from '../../../lib/atom-payload-resolver.js';

const REPO = join(__dirname, '../../..');
const serverSrc = readFileSync(join(REPO, 'mcp/google-drive-server.ts'), 'utf8');

function tmpFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ace-patch-'));
  const p = join(dir, name);
  writeFileSync(p, body, 'utf-8');
  return p;
}

function makeFakeDriveWithDoc(initialContent: string, initialVersion = '1') {
  const state = { content: initialContent, version: initialVersion };
  return {
    state,
    files: {
      get: vi.fn(async (req: any) => {
        if (req.alt === 'media') return { data: state.content };
        return { data: { mimeType: 'application/vnd.google-apps.document', name: 'run_state.yaml', version: state.version } };
      }),
      export: vi.fn(async () => ({ data: state.content })),
      update: vi.fn(async (req: any) => {
        const body = req.media?.body;
        state.content = typeof body === 'string' ? body : String(body);
        state.version = String(Number(state.version) + 1);
        return { data: { id: req.fileId, name: 'run_state.yaml', modifiedTime: '2026-09-07T00:00:00Z', version: state.version } };
      }),
    },
  };
}

/**
 * The repro shape: a phase block whose `residuals` list carries prose with
 * every character class that makes a retyped round trip risky — `!=`, quoted
 * scalars, `--`, `->`, and an XPath `concat(...)`.
 */
const RESIDUALS = [
  "Phase 4 MUST add a Connect verification rule rejecting `consent_confirmed != yes` -- this is a PAYMENT predicate, not a display hint.",
  "Deliver form 'bednet_check' expects concat(household_id, '-', visit_round) as the case name; do not simplify.",
  "Grid menu display is unset on module 2 -> apply appearance='grid' at the HQ layer.",
  'Learn passing_score lives on the shared CommCareApp row (jjackson/ace#1350).',
  'Camera-only capture: appearance="acquire" on every Deliver image upload.',
];

describe('update_yaml_file takes a file-based patch (ace#2184)', () => {
  describe('resolver contract', () => {
    it('rejects BOTH patch and localFilePath, in the sibling atoms’ wording', () => {
      const p = tmpFile('patch.json', '{"a":1}');
      expect(() => resolveYamlPatch({ patch: { a: 1 }, localFilePath: p }))
        .toThrow(/update_yaml_file: pass exactly one of patch or localFilePath, not both/);
    });

    it('rejects NEITHER — the param is no longer required, so absence must be caught here', () => {
      expect(() => resolveYamlPatch({}))
        .toThrow(/update_yaml_file: must supply one of patch or localFilePath/);
    });

    it('passes an inline patch through untouched', () => {
      const patch = { phases: { 'commcare-setup': { residuals: RESIDUALS } } };
      expect(resolveYamlPatch({ patch })).toBe(patch);
    });

    it('parses the JSON object at localFilePath into the patch', () => {
      const patch = { phases: { 'commcare-setup': { residuals: RESIDUALS.slice(1) } } };
      const p = tmpFile('patch.json', JSON.stringify(patch));
      expect(resolveYamlPatch({ localFilePath: p })).toEqual(patch);
    });

    it('preserves every risky character class through the file, byte for byte', () => {
      const p = tmpFile('patch.json', JSON.stringify({ residuals: RESIDUALS }));
      const resolved = resolveYamlPatch({ localFilePath: p }) as any;
      expect(resolved.residuals).toEqual(RESIDUALS);
    });
  });

  describe('a malformed patch file is a TYPED refusal, never a silent {}', () => {
    // The whole point: an empty or truncated file that merged as a no-op would
    // report success while writing nothing — worst possible outcome for state
    // that nothing downstream validates.
    it('refuses an empty file, naming the path', () => {
      const p = tmpFile('patch.json', '');
      expect(() => resolveYamlPatch({ localFilePath: p })).toThrow(AtomArgUsageError);
      expect(() => resolveYamlPatch({ localFilePath: p })).toThrow(/invalid_patch_file/);
      expect(() => resolveYamlPatch({ localFilePath: p })).toThrow(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    it('refuses truncated JSON', () => {
      const p = tmpFile('patch.json', '{"phases": {"commcare-setup": {"residuals": ["a"');
      expect(() => resolveYamlPatch({ localFilePath: p })).toThrow(/invalid_patch_file/);
    });

    it('refuses a top-level ARRAY — the shape a "just write the filtered list" script most easily emits', () => {
      const p = tmpFile('patch.json', JSON.stringify(RESIDUALS));
      expect(() => resolveYamlPatch({ localFilePath: p })).toThrow(/parsed as an array, not a JSON object/);
    });

    it('refuses a top-level scalar and null', () => {
      expect(() => resolveYamlPatch({ localFilePath: tmpFile('p.json', '"done"') }))
        .toThrow(/parsed as a string, not a JSON object/);
      expect(() => resolveYamlPatch({ localFilePath: tmpFile('p.json', '7') }))
        .toThrow(/parsed as a number, not a JSON object/);
      expect(() => resolveYamlPatch({ localFilePath: tmpFile('p.json', 'null') }))
        .toThrow(/parsed as null, not a JSON object/);
    });

    it('says no Drive I/O happened, so a caller knows it can retry freely', () => {
      const p = tmpFile('patch.json', '{');
      expect(() => resolveYamlPatch({ localFilePath: p })).toThrow(/No Drive read or write happened/);
    });
  });

  describe('equivalence: the file path is a transport change, not a semantic one', () => {
    const base = YAML.stringify({
      run_id: '20260907-1126',
      phases: {
        'commcare-setup': { status: 'done', residuals: RESIDUALS },
        'connect-setup': { status: 'in_progress' },
      },
    });

    it('removing one residual writes the same YAML inline and from a file', async () => {
      const survivors = RESIDUALS.filter((r) => !r.startsWith('Grid menu display'));
      const patch = { phases: { 'commcare-setup': { residuals: survivors } } };

      const inlineDrive = makeFakeDriveWithDoc(base, '53');
      await handleUpdateYamlFile(
        { fileId: 'f1', patch: resolveYamlPatch({ patch }), merge: 'deep' },
        inlineDrive as any,
      );

      const fileDrive = makeFakeDriveWithDoc(base, '53');
      const p = tmpFile('residuals.json', JSON.stringify(patch));
      await handleUpdateYamlFile(
        { fileId: 'f1', patch: resolveYamlPatch({ localFilePath: p }), merge: 'deep' },
        fileDrive as any,
      );

      expect(fileDrive.state.content).toBe(inlineDrive.state.content);

      const written = YAML.parse(fileDrive.state.content);
      expect(written.phases['commcare-setup'].residuals).toEqual(survivors);
      expect(written.phases['commcare-setup'].residuals).toHaveLength(4);
      // The payment predicate survived the round trip verbatim.
      expect(written.phases['commcare-setup'].residuals[0]).toBe(RESIDUALS[0]);
      // Sibling phases untouched.
      expect(written.phases['connect-setup']).toEqual({ status: 'in_progress' });
      expect(written.run_id).toBe('20260907-1126');
    });

    it('the write-time guards still fire on a file-sourced patch', async () => {
      // The resolver hands the SAME object shape to the handler, so the
      // unconditional phase-status enum guard (ace#992) cannot be bypassed by
      // routing the payload through a file.
      const fake = makeFakeDriveWithDoc(base, '1');
      const p = tmpFile('bad.json', JSON.stringify({ phases: { 'commcare-setup': { status: 'finito' } } }));
      await expect(
        handleUpdateYamlFile({ fileId: 'f1', patch: resolveYamlPatch({ localFilePath: p }) }, fake as any),
      ).rejects.toThrow(/INVALID_PHASE_STATUS/);
      expect(fake.files.update).not.toHaveBeenCalled();
    });
  });

  describe('registration shape matches its siblings', () => {
    const at = serverSrc.indexOf("'update_yaml_file',");
    const src = serverSrc.slice(at, serverSrc.indexOf('server.tool(', at));
    const schema = src.slice(0, src.indexOf('async ('));

    it('exposes localFilePath — the established write-side name, not a fourth spelling', () => {
      expect(schema).toMatch(/^\s{4}localFilePath: z\.string\(\)\.optional\(\)/m);
      for (const rival of ['patchFromPath', 'patch_file_path', 'patchLocalFilePath', 'fromPath', 'sourcePath']) {
        expect(schema, `update_yaml_file introduced a rival to localFilePath`).not.toContain(`${rival}:`);
      }
    });

    it('makes patch OPTIONAL so localFilePath can stand alone', () => {
      expect(schema).toMatch(/^\s{4}patch: z\.record\(z\.unknown\(\)\)\.optional\(\)/m);
    });

    it('enforces exactly-one through the shared resolver, not ad-hoc in the handler', () => {
      expect(src).toMatch(/resolveYamlPatch\(\{ patch, localFilePath \}\)/);
    });

    it('no longer claims the model only sends the diff', () => {
      // True for adds, false for an array-element removal — and that claim is
      // what made the inline-only shape look safe.
      const desc = src.slice(0, src.indexOf('  {\n'));
      expect(desc).not.toMatch(/keeps the full file content out of the model context \(the model only sends the diff\)/);
      expect(desc).toMatch(/localFilePath/);
      expect(desc).toMatch(/ace#2184/);
    });
  });
});
