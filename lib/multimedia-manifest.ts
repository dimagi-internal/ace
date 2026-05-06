/**
 * Source of truth for what `app-multimedia-coverage` has actually generated
 * + uploaded for an opp. Stored in Drive at
 *   2-commcare/app-multimedia-coverage_manifest.yaml
 *
 * The skill writes the manifest incrementally: generation produces a row
 * with `cchq_multimedia_id` / `cchq_file_hash_md5` set to null; the upload
 * step fills them in from CCHQ's response. Both fields are therefore
 * nullable.
 *
 * CCHQ field naming notes:
 *   - cchq_multimedia_id  ← CCHQ's response.ref.m_id (couch _id, 32-hex)
 *   - cchq_file_hash_md5  ← CCHQ's response.ref.uid (md5 hex of bytes;
 *                           CCHQ dedupes on this — re-uploading identical
 *                           bytes returns the same m_id and uid)
 *
 * The earlier spec called this `cchq_sha1`; the live CCHQ probe (T2)
 * confirmed the response uses md5, not sha1.
 */

import { z } from 'zod';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const multimediaImageSchema = z.object({
  app: z.enum(['learn', 'deliver']),
  form_unique_id: z.string().regex(/^[0-9a-f]{32}$/, '32-char hex'),
  field_id: z.string().min(1),
  prompt_hash: z.string().regex(/^[0-9a-f]{64}$/, '64-char hex SHA-256'),
  file_path: z.string().min(1),
  ccz_filename: z.string().min(1),
  cchq_multimedia_id: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
  cchq_file_hash_md5: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
  generated_at: z.string().datetime(),
});

export const multimediaManifestSchema = z.object({
  app_context_hash: z.string().regex(/^[0-9a-f]{64}$/),
  images: z.array(multimediaImageSchema),
});

export type MultimediaImage = z.infer<typeof multimediaImageSchema>;
export type MultimediaManifest = z.infer<typeof multimediaManifestSchema>;

export function parseManifest(yaml: string): MultimediaManifest {
  return multimediaManifestSchema.parse(parseYaml(yaml));
}

export function serializeManifest(m: MultimediaManifest): string {
  multimediaManifestSchema.parse(m); // throw on invalid
  return stringifyYaml(m, { lineWidth: 100 });
}
