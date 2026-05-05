import { describe, it, expect } from 'vitest';
import {
  multimediaManifestSchema,
  parseManifest,
  serializeManifest,
  type MultimediaManifest,
} from './multimedia-manifest.js';

const sample: MultimediaManifest = {
  app_context_hash: 'a'.repeat(64),
  images: [
    {
      app: 'learn',
      form_unique_id: 'f'.repeat(32),
      field_id: 'kmc_position_demo',
      prompt_hash: 'b'.repeat(64),
      file_path:
        'app-multimedia-coverage_generated/learn/ffffffffffffffffffffffffffffffff/kmc_position_demo__bbbbbbbb.png',
      ccz_filename: 'kmc_position_demo.png',
      cchq_multimedia_id: '9'.repeat(32),
      cchq_file_hash_md5: 'd'.repeat(32),
      generated_at: '2026-05-05T20:00:00.000Z',
    },
  ],
};

describe('multimediaManifestSchema', () => {
  it('accepts a well-formed manifest', () => {
    expect(multimediaManifestSchema.parse(sample)).toEqual(sample);
  });

  it('rejects an unknown app value', () => {
    const bad = { ...sample, images: [{ ...sample.images[0], app: 'feedback' }] };
    expect(() => multimediaManifestSchema.parse(bad)).toThrow();
  });

  it('rejects a non-32-char form_unique_id', () => {
    const bad = { ...sample, images: [{ ...sample.images[0], form_unique_id: 'short' }] };
    expect(() => multimediaManifestSchema.parse(bad)).toThrow();
  });

  it('round-trips through YAML serialize/parse', () => {
    const yaml = serializeManifest(sample);
    expect(parseManifest(yaml)).toEqual(sample);
  });

  it('allows cchq_multimedia_id and cchq_file_hash_md5 to be null (pre-upload state)', () => {
    const preUpload = {
      ...sample,
      images: [{ ...sample.images[0], cchq_multimedia_id: null, cchq_file_hash_md5: null }],
    };
    expect(multimediaManifestSchema.parse(preUpload)).toEqual(preUpload);
  });
});
