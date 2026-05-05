// scripts/probe-content-generator.ts
//
// Probes Dimagi's Content Generator API to document the live contract.
// Purely investigative.
//
// LIVE CONTRACT (probed 2026-05-05):
//   STATUS: BLOCKED — endpoint path not yet discovered.
//
// What we know from 1Password ("Content Generator API" / AI-Agents vault):
//   hostname:   https://content-generator-gateway-4pc8jsfa.uc.gateway.dev/
//   credential: AIzaSy... (Google Cloud-style API key, suggests `x-api-key` header
//               or `?key=` query param security definition on the API Gateway)
//
// What the gateway returns for every path tried so far:
//   HTTP/2 404
//   content-type: application/json
//   server: Google Frontend
//   {"code":404,"message":"The current request is not defined by this API."}
//
// That is the API Gateway's standard "no route matched" response. It returns
// before any auth check, so a 404 tells us only that the path is wrong — not
// whether the API key shape is right.
//
// Paths exhaustively swept and confirmed 404 (POST + GET, with `x-api-key` header):
//   /, /echo, /health, /healthz, /ping, /status,
//   /docs, /openapi, /openapi.json, /swagger,
//   /generate, /generate-image, /generate_image, /generateImage,
//   /generate-content, /generateContent, /image, /images,
//   /images/generate, /image/generate, /image:generate, /image/create,
//   /createImage, /create-image, /create_image, /create,
//   /predict, /invoke, /content, /gemini,
//   /v1, /v1/generate, /v1/generateImage, /v1/generate-image,
//   /v1/images, /v1/images:generate, /v1/image, /v1/image:generate,
//   /v1/predict, /v1/content, /v1/content:generate,
//   /api/generate, /api/v1/generate, /api/v1/images, /api/v1/image,
//   /api/v1/generateImage,
//   /commcare/generate, /multimedia/generate, /form-image, /form_image,
//   /question-image, /question_image,
//   /image-generation, /image_generation, /image-gen, /image_gen,
//   /imageGen, /imageGeneration, /gen, /gen/image, /gen/images,
//   /imagen, /imagen/generate, /create, /render, /render-image, /make-image,
//   /image_for_question, /generate_for_question, /question/image,
//   /cg, /cg/image, /cg/generate,
//   /multimedia, /multimedia/generate, /multimedia/image,
//   /commcare-image, /commcare/image, /form, /form/image, /form-image,
//   /question, /create-content, /create_content,
//   /generate_form_image, /generate-form-image, /app, /app/image,
//   /cchq/image, /content-generator, /content_generator, /contentGenerator,
//   /content-generator/generate, /content-generator/image,
//   /content-generator/v1/generate, /content-generator/api/generate,
//   /cg/v1/generate, /content-gen, /content_gen, /contentGen,
//   /content-gen/generate, /content-gen-internal,
//   /internal, /internal/generate, /internal/image,
//   /process, /submit, /request, /ai, /ai/generate, /ai/image,
//   /apikey, /apikey-test, /api, /api/, /api/v1, /api/v1/,
//   /cms/image, /jobs, /jobs/create, /rpc, /json-rpc,
//   /redoc, /__health__, /__ping__,
//   /sd, /sdapi, /sdapi/v1/txt2img,
//   /projects/.../models/gemini-3-flash:generateContent (Vertex-style),
//   /generate-content, /GenerateContent,
//   /generate/, /generate/image/, /generateImage/,
//   /image_generator, /content_generator,
//   /create-image-content, /go, /run, /test
//
// Methods tried per path: POST, GET (some PUT/PATCH/DELETE/HEAD too). All 404.
// Auth shapes tried: `x-api-key` header, `X-API-Key` header, `?key=` query,
//   `?api_key=` query, `Authorization: Bearer`. All produce the same 404
//   (because path doesn't match before auth).
// Body shapes tried: bare {application_context, form_text, image_directives},
//   wrapped {input: {...}}, wrapped {data: {...}}. All 404.
//
// Discovery angles attempted and dead-ended:
//   1. The web frontend at https://content-gen-internal-368616169126.us-central1.run.app/
//      is IAP-protected. jjackson@dimagi.com lacks an IAP-eligible identity
//      token because the IAP client_id (369001918367-t5qrahnqdaasaifvk6akpqkpjk9vli58)
//      lives in project 368616169126, which jjackson@dimagi.com cannot mint
//      ID tokens for ("invalid_audience: The audience client and the client
//      need to be in the same project").
//   2. gcloud project list does not include 368616169126 — no API-Gateway
//      config introspection available.
//   3. GitHub search for `content-generator-gateway-4pc8jsfa` /
//      `content-gen-internal` returns no public sources.
//   4. The 1Password item has only `hostname` and `credential` populated;
//      `notesPlain`, `username`, `filename` are null.
//
// Unblocking options (need help):
//   A. Ask the human (CTO or whoever stood up the service) for the route name,
//      method, request schema, and response shape.
//   B. Get IAP access for ace@dimagi-ai.com (or jjackson@dimagi.com) on the
//      Content Generator project so the web frontend's JS bundle can be
//      fetched and inspected for the API call.
//   C. Pull the API Gateway config (gcloud api-gateway api-configs describe)
//      from project 368616169126 — requires roles/apigateway.viewer on that
//      project.
//
// Once the path is known, the rest of the contract (auth header shape,
// body schema, response shape, wall-clock) can be filled in by re-running
// this script against the correct route.
//
// Run: npx tsx scripts/probe-content-generator.ts

import { writeFileSync } from 'node:fs';

const URL_BASE = process.env.CONTENT_GENERATOR_URL!;
const KEY = process.env.CONTENT_GENERATOR_API_KEY!;
if (!URL_BASE || !KEY) {
  console.error('Set CONTENT_GENERATOR_URL and CONTENT_GENERATOR_API_KEY');
  process.exit(1);
}

const body = {
  application_context:
    'Frontline workers in Africa teaching mothers to care for Small Vulnerable Newborns with Kangaroo Mother Care. Modestly dressed, representative of context.',
  form_text: "Show the mother how to support the baby's head and neck while skin-to-skin.",
  image_directives:
    'Frontline worker assisting a mother holding a small newborn skin-to-skin against her chest, head supported, warm lighting.',
};

// Discovery sweep — try a wide set of paths and auth shapes.
// Goal: find a path that returns a non-404 status.
//
// To fast-iterate once the human supplies the route, set CONTENT_GENERATOR_PATH
// in the env and the sweep will try only that path.
const userPath = process.env.CONTENT_GENERATOR_PATH;

const paths: string[] = userPath
  ? [userPath]
  : [
      '',
      'generate',
      'generate-image',
      'generate_image',
      'generateImage',
      'generate-content',
      'generateContent',
      'image',
      'images',
      'images/generate',
      'image/generate',
      'image:generate',
      'createImage',
      'create-image',
      'predict',
      'v1/generate',
      'v1/generateImage',
      'v1/images:generate',
      'api/generate',
      'api/v1/generate',
    ];

const authVariants: Array<{ name: string; apply: (h: Record<string, string>, u: URL) => void }> = [
  { name: 'x-api-key header', apply: (h) => { h['x-api-key'] = KEY; } },
  { name: 'X-API-Key header', apply: (h) => { h['X-API-Key'] = KEY; } },
  { name: 'key query param', apply: (_h, u) => { u.searchParams.set('key', KEY); } },
  { name: 'api_key query param', apply: (_h, u) => { u.searchParams.set('api_key', KEY); } },
  { name: 'Authorization Bearer', apply: (h) => { h['Authorization'] = `Bearer ${KEY}`; } },
];

const bodyVariants: Array<{ name: string; payload: unknown }> = [
  { name: 'bare', payload: body },
  { name: 'wrapped {input}', payload: { input: body } },
  { name: 'wrapped {data}', payload: { data: body } },
];

function joinUrl(base: string, path: string): URL {
  const b = base.endsWith('/') ? base : base + '/';
  return new URL(path, b);
}

type Attempt = {
  method: string;
  path: string;
  auth: string;
  bodyShape: string;
  status: number;
  contentType: string | null;
  elapsedMs: number;
  snippet: string;
};

let winner: (Attempt & { body: Buffer }) | null = null;
const interesting: Attempt[] = [];
let totalAttempts = 0;

outer: for (const path of paths) {
  for (const auth of authVariants) {
    for (const bv of bodyVariants) {
      const u = joinUrl(URL_BASE, path);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      auth.apply(headers, u);
      const t0 = Date.now();
      let res: Response;
      try {
        res = await fetch(u.toString(), {
          method: 'POST',
          headers,
          body: JSON.stringify(bv.payload),
        });
      } catch (e) {
        continue;
      }
      const elapsed = Date.now() - t0;
      const ct = res.headers.get('content-type');
      const buf = Buffer.from(await res.arrayBuffer());
      const snippet = ct?.startsWith('image/') ? '<image bytes>' : buf.toString('utf-8').slice(0, 200);
      totalAttempts++;
      const a: Attempt = {
        method: 'POST',
        path: path || '/',
        auth: auth.name,
        bodyShape: bv.name,
        status: res.status,
        contentType: ct,
        elapsedMs: elapsed,
        snippet,
      };
      if (res.status !== 404) interesting.push(a);
      if (res.status === 200) {
        winner = { ...a, body: buf };
        break outer;
      }
    }
  }
}

console.log(`--- attempts: ${totalAttempts} ---`);
if (interesting.length === 0) {
  console.log('All attempts returned 404 — path not discovered.');
  console.log('See top-of-file BLOCKED block for details and unblocking paths.');
  process.exit(2);
}

console.log('--- Non-404 attempts ---');
for (const a of interesting) {
  console.log(`[${a.status}] ${a.method} ${a.path} auth="${a.auth}" body=${a.bodyShape} ct=${a.contentType ?? '-'} :: ${a.snippet.replace(/\n/g, ' ')}`);
}

if (!winner) {
  console.log('\nNon-404 found but no 200. Iterate auth/body shape using these clues.');
  process.exit(3);
}

console.log('\n--- WINNER ---');
console.log({
  path: winner.path,
  auth: winner.auth,
  bodyShape: winner.bodyShape,
  status: winner.status,
  contentType: winner.contentType,
  elapsedMs: winner.elapsedMs,
  bytes: winner.body.length,
});

writeFileSync('/tmp/content-gen-probe-response.bin', winner.body);

if (winner.contentType?.startsWith('image/')) {
  console.log('Response is image bytes inline. Saved to /tmp/content-gen-probe-response.bin');
} else if (winner.contentType?.includes('json')) {
  console.log('Response is JSON:', winner.body.toString('utf-8').slice(0, 800));
} else {
  console.log('Unexpected content type. Body bytes 0..200:', winner.body.slice(0, 200).toString());
}
