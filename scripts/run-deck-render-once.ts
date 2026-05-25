/**
 * One-shot training-deck-render runner.
 *
 * Reads a local spec YAML, builds Slides API requests via the same
 * lib helpers that the training-deck-render skill documents, and emits
 * the requests as JSON for downstream slides_batch_update.
 *
 * Usage:
 *   npx tsx scripts/run-deck-render-once.ts <spec.yaml> <stencilJsonOrEmpty>
 *
 * If <stencilJsonOrEmpty> is "-", just parses and validates the spec
 * (prints slide count + alias check) — use this BEFORE slides_copy_template.
 *
 * If <stencilJsonOrEmpty> is a JSON file mapping stencil-key → objectId
 * (the result of inspecting the copied deck via slides_get), emits the
 * full requests JSON to stdout for slides_batch_update.
 */
import * as fs from 'node:fs';
import {
  parseTrainingSpec,
  resolveManifest,
  buildSlidesRequestsV2,
  STENCILS,
  type StencilKey,
} from '../lib/training-deck-spec.js';

const [specPath, stencilPath] = process.argv.slice(2);
if (!specPath || !stencilPath) {
  console.error('usage: run-deck-render-once.ts <spec.yaml> <stencilJsonOrEmpty>');
  process.exit(2);
}

const specYaml = fs.readFileSync(specPath, 'utf8');
const spec = parseTrainingSpec(specYaml);

const totalSlides = spec.modules.reduce((s, m) => s + (m.slides?.length ?? 0), 0);
const manifest = resolveManifest(spec.manifest);

if (stencilPath === '-') {
  // Pass 1: just report.
  console.error(`✓ spec parsed: ${spec.modules.length} modules, ${totalSlides} slides`);
  console.error(`✓ manifest: ${Object.keys(spec.manifest?.common ?? {}).length} common aliases`);

  const aliasRefs: string[] = [];
  for (const m of spec.modules) {
    for (const slide of m.slides ?? []) {
      const s = slide as Record<string, unknown>;
      if (typeof s.image === 'string' && s.image.startsWith('@')) aliasRefs.push(s.image);
      const left = s.left as Record<string, unknown> | undefined;
      const right = s.right as Record<string, unknown> | undefined;
      if (typeof left?.image === 'string' && (left.image as string).startsWith('@')) aliasRefs.push(left.image as string);
      if (typeof right?.image === 'string' && (right.image as string).startsWith('@')) aliasRefs.push(right.image as string);
    }
  }
  console.error(`✓ image alias refs in spec: ${aliasRefs.length}`);
  for (const ref of aliasRefs) {
    try {
      const url = manifest.resolveImageRef(ref);
      console.error(`  ${ref} → ${url}`);
    } catch (e) {
      console.error(`  ${ref} → UNRESOLVED (${(e as Error).message})`);
    }
  }
  process.exit(0);
}

const stencilRaw = JSON.parse(fs.readFileSync(stencilPath, 'utf8')) as Record<string, string>;
const stencils = stencilRaw as Record<StencilKey, string>;

// Verify all expected stencils are present.
const missing = Object.keys(STENCILS).filter((k) => !(k in stencils));
if (missing.length > 0) {
  console.error(`✗ stencils missing from copied deck: ${missing.join(', ')}`);
  process.exit(1);
}

const requests = buildSlidesRequestsV2(spec, { stencils, manifest });
console.error(`✓ built ${requests.length} requests for ${totalSlides} slides`);
console.log(JSON.stringify(requests));
