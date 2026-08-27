import { describe, it, expect } from 'vitest';
import {
  mediaPlanSchema,
  parseMediaPlan,
  serializeMediaPlan,
  MODULE_ICON_SLUGS,
  FORM_ICON_SLUGS,
  type MediaPlan,
} from './media-plan.js';

const U = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const MOD = U('1');
const FORM = U('2');
const FIELD = U('3');
const OPT = U('4');
const ASSET = U('5');

const fieldAttachment = () => ({
  target: 'field' as const,
  module_uuid: MOD,
  form_uuid: FORM,
  field_uuid: FIELD,
  slot: 'label' as const,
  field_id: 'kmc_position_demo',
  field_text: 'Show the mother how to support the head and neck.',
  kind: 'image' as const,
  source: 'input_file' as const,
  source_ref: 'drive-file-abc',
  asset_id: ASSET,
  rationale: 'FLW shows this to the mother while demonstrating the hold.',
  operator_override: null,
});

const plan = (over: Partial<MediaPlan> = {}): MediaPlan => ({
  app: 'learn',
  nova_app_id: 'app-1',
  app_context_hash: 'a'.repeat(64),
  guidance_docs: [{ file_id: 'g1', name: 'overview.md' }],
  attachments: [fieldAttachment()],
  ...over,
});

describe('mediaPlanSchema — round trip', () => {
  it('accepts a well-formed plan and round-trips through YAML', () => {
    const p = plan();
    expect(parseMediaPlan(serializeMediaPlan(p))).toEqual(p);
  });

  it('accepts a plan with no guidance docs — the no-overview case', () => {
    expect(() => mediaPlanSchema.parse(plan({ guidance_docs: [] }))).not.toThrow();
  });

  it('accepts an empty attachment list — nothing earned an image', () => {
    expect(() => mediaPlanSchema.parse(plan({ attachments: [] }))).not.toThrow();
  });
});

describe('mediaPlanSchema — per-target shape rules', () => {
  it('requires a slot on a field attachment', () => {
    const a: Record<string, unknown> = { ...fieldAttachment() };
    delete a.slot;
    expect(() => mediaPlanSchema.parse(plan({ attachments: [a] as never }))).toThrow();
  });

  it('rejects a slot that the field kind cannot carry', () => {
    const a = { ...fieldAttachment(), slot: 'caption' };
    expect(() => mediaPlanSchema.parse(plan({ attachments: [a] as never }))).toThrow();
  });

  it('requires an option_uuid on an option attachment and forbids a slot', () => {
    const ok = {
      target: 'option',
      module_uuid: MOD,
      form_uuid: FORM,
      field_uuid: FIELD,
      option_uuid: OPT,
      kind: 'image',
      source: 'generated',
      source_ref: 'b'.repeat(64),
      asset_id: ASSET,
      rationale: 'Visual choice card for a low-literacy worker.',
      operator_override: null,
    };
    expect(() => mediaPlanSchema.parse(plan({ attachments: [ok] as never }))).not.toThrow();

    const withSlot = { ...ok, slot: 'label' };
    expect(() => mediaPlanSchema.parse(plan({ attachments: [withSlot] as never }))).toThrow();

    const noOption: Record<string, unknown> = { ...ok };
    delete noOption.option_uuid;
    expect(() => mediaPlanSchema.parse(plan({ attachments: [noOption] as never }))).toThrow();
  });

  it('accepts a module tile carrying a built-in icon slug with no uploaded asset', () => {
    const a = {
      target: 'module_tile',
      module_uuid: MOD,
      kind: 'image',
      source: 'builtin_icon',
      source_ref: 'newborn_care',
      asset_id: null,
      rationale: 'Newborn-care module.',
      operator_override: null,
    };
    expect(() => mediaPlanSchema.parse(plan({ attachments: [a] as never }))).not.toThrow();
  });

  it('rejects a form-only icon slug used on a module tile', () => {
    // `counsel` is a FORM action icon; module tiles take topic icons.
    const a = {
      target: 'module_tile',
      module_uuid: MOD,
      kind: 'image',
      source: 'builtin_icon',
      source_ref: 'counsel',
      asset_id: null,
      rationale: 'wrong tier',
      operator_override: null,
    };
    expect(() => mediaPlanSchema.parse(plan({ attachments: [a] as never }))).toThrow();
  });

  it('rejects a module-only icon slug used on a form tile', () => {
    const a = {
      target: 'form_tile',
      module_uuid: MOD,
      form_uuid: FORM,
      kind: 'image',
      source: 'builtin_icon',
      source_ref: 'maternal_health',
      asset_id: null,
      rationale: 'wrong tier',
      operator_override: null,
    };
    expect(() => mediaPlanSchema.parse(plan({ attachments: [a] as never }))).toThrow();
  });

  it('requires a form_uuid on a form tile', () => {
    const a = {
      target: 'form_tile',
      module_uuid: MOD,
      kind: 'image',
      source: 'builtin_icon',
      source_ref: 'register',
      asset_id: null,
      rationale: 'registration form',
      operator_override: null,
    };
    expect(() => mediaPlanSchema.parse(plan({ attachments: [a] as never }))).toThrow();
  });

  it('requires the app logo to be an image with an uploaded asset', () => {
    const base = {
      target: 'app_logo',
      kind: 'image',
      source: 'input_file',
      source_ref: 'drive-logo',
      asset_id: ASSET,
      rationale: 'Partner logo supplied in inputs/media.',
      operator_override: null,
    };
    expect(() => mediaPlanSchema.parse(plan({ attachments: [base] as never }))).not.toThrow();
    expect(() =>
      mediaPlanSchema.parse(plan({ attachments: [{ ...base, kind: 'audio' }] as never })),
    ).toThrow();
  });
});

describe('mediaPlanSchema — source/asset coherence', () => {
  it('rejects a built-in icon that also claims an uploaded asset id', () => {
    const a = {
      target: 'module_tile',
      module_uuid: MOD,
      kind: 'image',
      source: 'builtin_icon',
      source_ref: 'nutrition',
      asset_id: ASSET,
      rationale: 'cannot be both',
      operator_override: null,
    };
    expect(() => mediaPlanSchema.parse(plan({ attachments: [a] as never }))).toThrow();
  });

  it('allows a null asset_id before upload and a uuid after', () => {
    const pending = { ...fieldAttachment(), asset_id: null };
    expect(() => mediaPlanSchema.parse(plan({ attachments: [pending] }))).not.toThrow();
  });

  it('requires a generated attachment to carry a prompt hash as its source_ref', () => {
    const a = { ...fieldAttachment(), source: 'generated', source_ref: 'not-a-hash' };
    expect(() => mediaPlanSchema.parse(plan({ attachments: [a] as never }))).toThrow();
  });

  it('rejects a non-image asset on a select option — CommCare renders images there', () => {
    const a = {
      target: 'option',
      module_uuid: MOD,
      form_uuid: FORM,
      field_uuid: FIELD,
      option_uuid: OPT,
      kind: 'video',
      source: 'input_file',
      source_ref: 'drive-x',
      asset_id: ASSET,
      rationale: 'no',
      operator_override: null,
    };
    expect(() => mediaPlanSchema.parse(plan({ attachments: [a] as never }))).toThrow();
  });
});

describe('icon slug catalogues', () => {
  it('keeps the module and form catalogues disjoint apart from `default`', () => {
    const overlap = MODULE_ICON_SLUGS.filter((s) => (FORM_ICON_SLUGS as readonly string[]).includes(s));
    expect(overlap).toEqual(['default']);
  });
});
