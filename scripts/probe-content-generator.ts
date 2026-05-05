// scripts/probe-content-generator.ts
//
// LIVE CONTRACT (probed 2026-05-05 via /openapi.json + live POST):
//   Service: Dimagi Content Gen v0.1.0
//   Endpoint: POST <CONTENT_GENERATOR_URL>/v1/form-image
//   Auth: x-api-key: <google-cloud-api-key> header
//         (the gateway also documents ?key= as a fallback; header is the
//          confirmed-working scheme — see probe run 2026-05-05)
//   Request body (application/json):
//     { application_context, form_text, image_directives?, upscale?=false }
//   Response 200 (application/json):
//     { image: <base64-PNG>, prompt_used: <string> }
//   Wall-clock: ~68s observed for an upscale=false request on 2026-05-05;
//   spec hints ~10s low-res and ~30s upscaled but live latency is higher.
//
// Run:
//   export CONTENT_GENERATOR_URL=<gateway base from 1Password>
//   export CONTENT_GENERATOR_API_KEY=<key from 1Password>
//   npx tsx scripts/probe-content-generator.ts

import { writeFileSync } from 'node:fs';

const URL = process.env.CONTENT_GENERATOR_URL!;
const KEY = process.env.CONTENT_GENERATOR_API_KEY!;
if (!URL || !KEY) {
  console.error('Set CONTENT_GENERATOR_URL and CONTENT_GENERATOR_API_KEY');
  process.exit(1);
}

const endpoint = URL.replace(/\/$/, '') + '/v1/form-image';
const body = {
  application_context:
    'Frontline workers in Africa teaching mothers to care for Small Vulnerable Newborns with Kangaroo Mother Care. Modestly dressed, representative of context.',
  form_text: "Show the mother how to support the baby's head and neck while skin-to-skin.",
  image_directives:
    'Frontline worker assisting a mother holding a small newborn skin-to-skin against her chest, head supported, warm lighting.',
  upscale: false,
};

const t0 = Date.now();
const res = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
  body: JSON.stringify(body),
});
const elapsed = Date.now() - t0;

console.log({
  status: res.status,
  contentType: res.headers.get('content-type'),
  elapsedMs: elapsed,
  authScheme: 'x-api-key header',
});

const buf = Buffer.from(await res.arrayBuffer());
writeFileSync('/tmp/content-gen-probe-response.bin', buf);

if (res.status !== 200) {
  console.error('Probe failed. Body slice:', buf.slice(0, 1000).toString('utf-8'));
  process.exit(1);
}

const json = JSON.parse(buf.toString('utf-8'));
console.log('Response keys:', Object.keys(json));
console.log('prompt_used (first 200 chars):', String(json.prompt_used ?? '').slice(0, 200));
const imageBytes = Buffer.from(json.image, 'base64');
writeFileSync('/tmp/content-gen-probe-image.png', imageBytes);
console.log(`PNG saved (${imageBytes.length} bytes) to /tmp/content-gen-probe-image.png`);
console.log(`First 4 bytes (PNG magic = 89504e47):`, imageBytes.slice(0, 4).toString('hex'));
