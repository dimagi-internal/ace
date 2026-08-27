/**
 * The media plan `app-media-coverage` writes per app, and the validator that
 * keeps a malformed attachment from ever reaching Nova.
 *
 * Stored in Drive at `3-commcare/app-media-coverage_plan-<app>.yaml`.
 *
 * ## Why this schema is strict about shapes
 *
 * Nova's attach tools commit a batch as a whole and reject the batch when one
 * attachment does not resolve — so a single wrong-shaped row costs the entire
 * pass. The per-target rules below (a slot on fields but never on options, a
 * `form_uuid` on form tiles, a topic icon on modules and an action icon on
 * forms) are all rules Nova enforces server-side; encoding them here turns a
 * round-trip rejection into a local parse error, and lets an operator hand-edit
 * the plan with a safety net.
 *
 * The icon catalogues are transcribed from Nova's own `set_menu_media` enums.
 * They are the one part of this file that can drift upstream — if Nova adds an
 * icon, a plan naming it fails here until the list is updated. That is the
 * intended failure direction: a stale-but-loud list beats silently posting a
 * slug Nova will refuse.
 */

import { z } from 'zod';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'Nova stable UUID',
  );

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, '64-char hex SHA-256');

/** Topic icons Nova offers for MODULE tiles. Verified live 2026-08-27. */
export const MODULE_ICON_SLUGS = [
  'household', 'community', 'patient', 'chw_staff', 'maternal_health',
  'child_health', 'newborn_care', 'immunization', 'nutrition',
  'growth_monitoring', 'family_planning', 'hiv', 'tuberculosis', 'malaria',
  'disease_surveillance', 'mental_health', 'substance_use', 'oral_health',
  'eye_care', 'facility', 'bed_capacity', 'pharmacy_stock', 'medications',
  'lab', 'diagnostics', 'screening', 'referrals', 'appointments',
  'vital_events', 'education', 'tasks', 'alerts', 'reports', 'default',
] as const;

/** Action icons Nova offers for FORM tiles. Verified live 2026-08-27. */
export const FORM_ICON_SLUGS = [
  'register', 'update', 'follow_up', 'record_vitals', 'screen_assess',
  'administer', 'collect_sample', 'counsel', 'schedule', 'refer', 'consent',
  'checklist', 'close_case', 'default',
] as const;

/** Message slots `attach_field_media` exposes. Not every field kind has all. */
export const FIELD_SLOTS = ['label', 'hint', 'help', 'validate_msg'] as const;

const kind = z.enum(['image', 'audio', 'video']);
const source = z.enum(['input_file', 'generated', 'builtin_icon']);
const override = z.union([z.null(), z.literal('skip'), z.literal('force')]);

const commonFields = {
  kind,
  source,
  /** Drive file id, generator prompt hash, or built-in icon slug. */
  source_ref: z.string().min(1),
  /** Nova asset id — null until `upload_media_asset` returns, and for icons. */
  asset_id: uuid.nullable(),
  rationale: z.string().min(1).max(400),
  operator_override: override,
};

const fieldAttachment = z.object({
  target: z.literal('field'),
  module_uuid: uuid,
  form_uuid: uuid,
  field_uuid: uuid,
  slot: z.enum(FIELD_SLOTS),
  field_id: z.string().min(1).optional(),
  field_text: z.string().optional(),
  ...commonFields,
}).strict();

const optionAttachment = z.object({
  target: z.literal('option'),
  module_uuid: uuid,
  form_uuid: uuid,
  field_uuid: uuid,
  option_uuid: uuid,
  field_id: z.string().min(1).optional(),
  field_text: z.string().optional(),
  ...commonFields,
}).strict();

const moduleTileAttachment = z.object({
  target: z.literal('module_tile'),
  module_uuid: uuid,
  ...commonFields,
}).strict();

const formTileAttachment = z.object({
  target: z.literal('form_tile'),
  module_uuid: uuid,
  form_uuid: uuid,
  ...commonFields,
}).strict();

const appLogoAttachment = z.object({
  target: z.literal('app_logo'),
  ...commonFields,
}).strict();

const attachmentUnion = z.discriminatedUnion('target', [
  fieldAttachment,
  optionAttachment,
  moduleTileAttachment,
  formTileAttachment,
  appLogoAttachment,
]);

export const mediaAttachmentSchema = attachmentUnion.superRefine((a, ctx) => {
  const fail = (message: string, path: (string | number)[] = []) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

  // --- source vs asset coherence -----------------------------------------
  if (a.source === 'builtin_icon') {
    if (a.target !== 'module_tile' && a.target !== 'form_tile') {
      fail('builtin_icon is only available on module_tile and form_tile targets.', ['source']);
    }
    if (a.asset_id !== null) {
      fail('A built-in icon has no uploaded asset — asset_id must be null.', ['asset_id']);
    }
    const catalogue =
      a.target === 'module_tile'
        ? (MODULE_ICON_SLUGS as readonly string[])
        : (FORM_ICON_SLUGS as readonly string[]);
    if (a.target === 'module_tile' || a.target === 'form_tile') {
      if (!catalogue.includes(a.source_ref)) {
        const tier = a.target === 'module_tile' ? 'module topic' : 'form action';
        fail(`"${a.source_ref}" is not a ${tier} icon slug.`, ['source_ref']);
      }
    }
  } else if (a.source === 'generated') {
    if (!/^[0-9a-f]{64}$/.test(a.source_ref)) {
      fail('A generated attachment must carry its prompt hash as source_ref.', ['source_ref']);
    }
  }

  // --- per-target media-kind rules ---------------------------------------
  if (a.target === 'option' && a.kind !== 'image') {
    fail('CommCare renders images on select options — audio/video are not shown.', ['kind']);
  }
  if ((a.target === 'module_tile' || a.target === 'form_tile') && a.kind !== 'image') {
    // Audio labels on tiles exist, but travel via set_menu_media's audioLabel,
    // not as a tile "icon" — keep the plan honest about which call it drives.
    fail('Tile icons are images; an audio label is a separate set_menu_media field.', ['kind']);
  }
  if (a.target === 'app_logo' && a.kind !== 'image') {
    fail('The app logo must be an image asset.', ['kind']);
  }
});

export const mediaPlanSchema = z.object({
  app: z.enum(['learn', 'deliver']),
  nova_app_id: z.string().min(1),
  /** SHA-256 over the Application Context — invalidates the generated cache. */
  app_context_hash: sha256,
  /** Guidance documents actually read, in the order they were read. */
  guidance_docs: z.array(z.object({ file_id: z.string().min(1), name: z.string().min(1) })),
  attachments: z.array(mediaAttachmentSchema),
});

export type MediaAttachment = z.infer<typeof mediaAttachmentSchema>;
export type MediaPlan = z.infer<typeof mediaPlanSchema>;

export function parseMediaPlan(yaml: string): MediaPlan {
  return mediaPlanSchema.parse(parseYaml(yaml));
}

export function serializeMediaPlan(plan: MediaPlan): string {
  mediaPlanSchema.parse(plan);
  return stringifyYaml(plan, { lineWidth: 100 });
}

/**
 * Splits a plan into the batches the three Nova attach calls take. Rows whose
 * operator_override is 'skip' are dropped; everything else is grouped by the
 * call that applies it. Batching matters — Nova commits a batch as a whole,
 * so one call per surface is both cheaper and atomic.
 */
export function partitionForNova(plan: MediaPlan) {
  const live = plan.attachments.filter((a) => a.operator_override !== 'skip');
  return {
    fields: live.filter((a) => a.target === 'field'),
    options: live.filter((a) => a.target === 'option'),
    tiles: live.filter((a) => a.target === 'module_tile' || a.target === 'form_tile'),
    logo: live.find((a) => a.target === 'app_logo') ?? null,
    /** Attachments still needing `upload_media_asset` before they can attach. */
    pendingUpload: live.filter((a) => a.source !== 'builtin_icon' && a.asset_id === null),
  };
}
