# app-multimedia-coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a manually-invoked ACE skill that takes Nova-built CommCare apps, uses an LLM judge to pick which fields deserve display-only images, generates them via Dimagi's Content Generator API, patches form XML and bundles assets into the CCZ, then re-builds and re-releases — closing the loop on multimedia attachment.

**Architecture:** Sibling of `commcare-form-patch`. New skill `skills/app-multimedia-coverage/`, two new pure helpers (`lib/multimedia-judge.ts`, `lib/content-generator-client.ts`, `lib/multimedia-manifest.ts`, `lib/multimedia-prompt-hash.ts`, `lib/multimedia-xform-patch.ts`), one new MCP atom (`commcare_upload_multimedia`), `.env.tpl` additions for Content Generator credentials, doctor env-drift checks, a smoke fixture, and a Nova feature request filed against `voidcraft-labs/nova-plugin`. Spec at `docs/superpowers/specs/2026-05-05-app-multimedia-coverage-design.md`.

**Tech Stack:** TypeScript / vitest / Anthropic SDK (Sonnet 4.6) / Playwright for CCHQ I/O / Zod for schemas / @xmldom/xmldom (already in repo for form-XML manipulation).

---

## Task 0: Branch verification & worktree confirmation

**Files:** none

- [ ] **Step 1: Verify branch and clean tree**

```bash
git rev-parse --git-dir | grep -q worktrees && echo "in worktree: ok"
git status --short    # expect empty
git log --oneline -1  # expect the design-spec commit (638a855 or later)
```

Expected: in worktree, clean tree, the spec commit at HEAD.

- [ ] **Step 2: Read the spec**

Read `docs/superpowers/specs/2026-05-05-app-multimedia-coverage-design.md` end-to-end before continuing. The plan below assumes you've read it.

---

## Task 1: Probe the Content Generator API contract

**Files:**
- Create: `scripts/probe-content-generator.ts`

This is investigative; no test, no commit yet (the script gets committed alongside the client in Task 6 once the contract is documented). The goal is to discover: does the API return PNG bytes inline or a signed URL? What's the exact request body and auth header shape?

- [ ] **Step 1: Pull credentials from 1Password**

```bash
op item get "Content Generator API" --vault AI-Agents --account dimagi.1password.com --format json
```

Expected: JSON containing fields like `url`, `apikey` (or `credential`, etc.). Note the exact field names — they go into `.env.tpl` in Task 3.

- [ ] **Step 2: Write the probe script**

```typescript
// scripts/probe-content-generator.ts
//
// Probes Dimagi's Content Generator API to document the live contract.
// Purely investigative — outputs:
//   - Request shape that worked
//   - Response shape (Content-Type, body size, structure)
//   - Total wall-clock for one image
//
// Run: npx tsx scripts/probe-content-generator.ts

import { writeFileSync } from 'node:fs';

const URL = process.env.CONTENT_GENERATOR_URL!;
const KEY = process.env.CONTENT_GENERATOR_API_KEY!;
if (!URL || !KEY) {
  console.error('Set CONTENT_GENERATOR_URL and CONTENT_GENERATOR_API_KEY');
  process.exit(1);
}

const body = {
  application_context:
    'Frontline workers in Africa teaching mothers to care for Small Vulnerable Newborns with Kangaroo Mother Care. Modestly dressed, representative of context.',
  form_text: 'Show the mother how to support the baby\'s head and neck while skin-to-skin.',
  image_directives:
    'Frontline worker assisting a mother holding a small newborn skin-to-skin against her chest, head supported, warm lighting.',
};

const t0 = Date.now();
const res = await fetch(URL, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});
const elapsed = Date.now() - t0;

console.log({ status: res.status, contentType: res.headers.get('content-type'), elapsedMs: elapsed });

const buf = Buffer.from(await res.arrayBuffer());
writeFileSync('/tmp/content-gen-probe-response.bin', buf);

if (res.headers.get('content-type')?.startsWith('image/')) {
  console.log('Response is image bytes inline. Saved to /tmp/content-gen-probe-response.bin (open to confirm).');
} else if (res.headers.get('content-type')?.includes('json')) {
  console.log('Response is JSON:', buf.toString('utf-8').slice(0, 500));
} else {
  console.log('Unexpected content type. Body bytes 0..200:', buf.slice(0, 200).toString());
}
```

- [ ] **Step 3: Run the probe and capture findings**

```bash
export CONTENT_GENERATOR_URL=<from 1Password>
export CONTENT_GENERATOR_API_KEY=<from 1Password>
npx tsx scripts/probe-content-generator.ts
```

If status is non-200, iterate on auth header (`Authorization: Bearer X` vs `X-API-Key: X` vs `?api_key=`), body wrapper, etc., until 200.

- [ ] **Step 4: Document the contract**

Append a top-of-file comment block to `scripts/probe-content-generator.ts` documenting the live contract verbatim:

```
// LIVE CONTRACT (probed YYYY-MM-DD):
//   Method: POST
//   URL: <full URL>
//   Auth: <header name>: <scheme> <value>
//   Request body: { application_context, form_text, image_directives }
//   Response: <Content-Type> — <inline bytes | {url: ...} | other>
//   Wall-clock: ~Xs low-res / ~Ys upscaled
```

This block becomes the source of truth for `lib/content-generator-client.ts` in Task 6.

---

## Task 2: Probe the CCHQ multimedia upload endpoint

**Files:**
- Create: `scripts/probe-multimedia-upload.ts`

Same shape as Task 1: discover the live endpoint, document it, no commit yet.

- [ ] **Step 1: Read existing CCHQ atoms for the auth pattern**

Read `mcp/connect/backends/commcare.ts` lines 285–360 (the `patchXform` implementation). The probe script needs to use the same Playwright-session auth.

- [ ] **Step 2: Write the probe script**

```typescript
// scripts/probe-multimedia-upload.ts
//
// Probes CCHQ's multimedia upload endpoint to document the live contract.
// Uses the same authenticated Playwright session as commcare_patch_xform.
//
// Run: npx tsx scripts/probe-multimedia-upload.ts <hq_domain> <app_id>
//
// The endpoint is best-guess `/a/<domain>/apps/<app_id>/multimedia/uploaded/`;
// CCHQ may use a different path. Iterate until 200.

import { commcareClient } from '../mcp/connect/backends/commcare.js'; // adjust if needed
import { readFileSync } from 'node:fs';

const [, , domain, appId] = process.argv;
if (!domain || !appId) {
  console.error('Usage: npx tsx scripts/probe-multimedia-upload.ts <domain> <app_id>');
  process.exit(1);
}

// 1x1 PNG (smallest valid PNG, ~67 bytes)
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

const candidatePaths = [
  `/a/${domain}/apps/${appId}/multimedia/uploaded/`,
  `/a/${domain}/apps/${appId}/multimedia_upload/`,
  `/a/${domain}/multimedia/upload_multimedia/${appId}/`,
  `/a/${domain}/apps/multimedia/${appId}/uploaded/`,
];

const client = await commcareClient();
for (const path of candidatePaths) {
  const form = new FormData();
  form.set('Filedata', new Blob([TINY_PNG], { type: 'image/png' }), 'probe.png');
  form.set('media_type', 'image');
  form.set('file_name', 'probe.png');

  // Probe: try the path with a multipart POST through the existing session.
  // Adjust the POST helper to match commcare.ts's actual API.
  const res = await client.rawPost(path, form); // <-- helper to add if missing
  console.log({ path, status: res.status, body: (await res.text()).slice(0, 300) });
  if (res.status === 200) break;
}
```

- [ ] **Step 3: Run against a test HQ project**

Use an existing ACE smoke opp's HQ domain + app_id from a recent `2-commcare/app-deploy_summary.md`. Iterate the candidate paths and form-field names until one returns 200 with a multimedia_id-shaped response.

- [ ] **Step 4: Document the contract**

Top-of-file comment block in `scripts/probe-multimedia-upload.ts`:

```
// LIVE CONTRACT (probed YYYY-MM-DD against <hq_domain>):
//   Method: POST
//   Path: /a/<domain>/<exact-path>/<app_id>/...
//   Content-Type: multipart/form-data
//   Required fields: Filedata=<png-bytes>, media_type=image, file_name=<filename>
//   Optional fields: <any others discovered>
//   CSRF: required via X-CSRFToken header (per CCHQ standard)
//   Auth: same Playwright session as patchXform (login_or_digest)
//   Response: 200 application/json { multimedia_id, sha1, ... }
//   Errors: 400 on bad media_type, 403 on csrf miss
```

This is the source of truth for `commcare_upload_multimedia` in Task 9.

---

## Task 3: Add Content Generator credentials to `.env.tpl`

**Files:**
- Modify: `.env.tpl` (append a new section after CommCare HQ block)

- [ ] **Step 1: Append new section**

Append to `.env.tpl` (use the field names discovered in Task 1 step 1):

```bash
# ── Content Generator (image gen for app-multimedia-coverage) ───────
#
# Dimagi's internal image-generation service (Cloud Run, Gemini-3-Flash).
# Used by the app-multimedia-coverage skill to attach display-only images
# to CommCare app questions.
#
# 1Password item: "Content Generator API" in AI-Agents vault.

CONTENT_GENERATOR_URL=op://AI-Agents/Content Generator API/url
CONTENT_GENERATOR_API_KEY=op://AI-Agents/Content Generator API/credential
```

(Adjust `url` / `credential` to match the actual 1Password field names from Task 1 step 1.)

- [ ] **Step 2: Regenerate local `.env`**

```bash
op inject -i .env.tpl -o "$CLAUDE_PLUGIN_DATA/.env" --account dimagi.1password.com 2>&1 | tail -5
# Verify new vars are present:
grep -c CONTENT_GENERATOR "$CLAUDE_PLUGIN_DATA/.env"   # expect 2
```

- [ ] **Step 3: Commit**

```bash
git add .env.tpl
git commit -m "feat(env): add CONTENT_GENERATOR_URL / _API_KEY for multimedia skill"
```

---

## Task 4: `lib/multimedia-prompt-hash.ts` — content-addressed cache key

**Files:**
- Create: `lib/multimedia-prompt-hash.ts`
- Test: `lib/multimedia-prompt-hash.test.ts`

Pure function. Used to cache-skip image regeneration when inputs haven't changed.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/multimedia-prompt-hash.test.ts
import { describe, it, expect } from 'vitest';
import { promptHash } from './multimedia-prompt-hash.js';

describe('promptHash', () => {
  it('returns the same hash for identical inputs', () => {
    const a = promptHash({ appContext: 'X', formText: 'Y', directive: 'Z' });
    const b = promptHash({ appContext: 'X', formText: 'Y', directive: 'Z' });
    expect(a).toBe(b);
  });

  it('returns a different hash when any field changes', () => {
    const base = { appContext: 'X', formText: 'Y', directive: 'Z' };
    const h = promptHash(base);
    expect(promptHash({ ...base, appContext: 'X2' })).not.toBe(h);
    expect(promptHash({ ...base, formText: 'Y2' })).not.toBe(h);
    expect(promptHash({ ...base, directive: 'Z2' })).not.toBe(h);
  });

  it('is whitespace-insensitive on leading/trailing whitespace', () => {
    const a = promptHash({ appContext: 'X', formText: 'Y', directive: 'Z' });
    const b = promptHash({ appContext: '  X  ', formText: '\nY\n', directive: ' Z ' });
    expect(a).toBe(b);
  });

  it('treats null/undefined directive as the same as empty string', () => {
    const a = promptHash({ appContext: 'X', formText: 'Y', directive: '' });
    const b = promptHash({ appContext: 'X', formText: 'Y', directive: null });
    const c = promptHash({ appContext: 'X', formText: 'Y', directive: undefined });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns a 64-char hex string (SHA-256)', () => {
    const h = promptHash({ appContext: 'X', formText: 'Y', directive: 'Z' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm test -- lib/multimedia-prompt-hash.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```typescript
// lib/multimedia-prompt-hash.ts
import { createHash } from 'node:crypto';

export interface PromptHashInput {
  appContext: string;
  formText: string;
  directive: string | null | undefined;
}

export function promptHash(input: PromptHashInput): string {
  const norm = (s: string | null | undefined) => (s ?? '').trim();
  const payload = [norm(input.appContext), norm(input.formText), norm(input.directive)].join(' ');
  return createHash('sha256').update(payload, 'utf-8').digest('hex');
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npm test -- lib/multimedia-prompt-hash.test.ts
```

Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/multimedia-prompt-hash.ts lib/multimedia-prompt-hash.test.ts
git commit -m "feat(lib): multimedia prompt-hash helper for cache-skip"
```

---

## Task 5: `lib/multimedia-manifest.ts` — Zod schema + I/O helpers

**Files:**
- Create: `lib/multimedia-manifest.ts`
- Test: `lib/multimedia-manifest.test.ts`

The manifest is the auth-only source of truth for what's been generated. Stored as YAML in Drive at `2-commcare/app-multimedia-coverage_manifest.yaml`.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/multimedia-manifest.test.ts
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
      cchq_multimedia_id: 'mm_123',
      cchq_sha1: 'c'.repeat(40),
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
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm test -- lib/multimedia-manifest.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```typescript
// lib/multimedia-manifest.ts
import { z } from 'zod';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';

export const multimediaImageSchema = z.object({
  app: z.enum(['learn', 'deliver']),
  form_unique_id: z.string().regex(/^[0-9a-f]{32}$/, '32-char hex'),
  field_id: z.string().min(1),
  prompt_hash: z.string().regex(/^[0-9a-f]{64}$/, '64-char hex SHA-256'),
  file_path: z.string().min(1),
  ccz_filename: z.string().min(1),
  cchq_multimedia_id: z.string().nullable(),
  cchq_sha1: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  generated_at: z.string().datetime(),
});

export const multimediaManifestSchema = z.object({
  app_context_hash: z.string().regex(/^[0-9a-f]{64}$/),
  images: z.array(multimediaImageSchema),
});

export type MultimediaImage = z.infer<typeof multimediaImageSchema>;
export type MultimediaManifest = z.infer<typeof multimediaManifestSchema>;

export function parseManifest(yaml: string): MultimediaManifest {
  return multimediaManifestSchema.parse(yamlLoad(yaml));
}

export function serializeManifest(m: MultimediaManifest): string {
  multimediaManifestSchema.parse(m); // throw on invalid
  return yamlDump(m, { noRefs: true, lineWidth: 100 });
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npm test -- lib/multimedia-manifest.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/multimedia-manifest.ts lib/multimedia-manifest.test.ts
git commit -m "feat(lib): multimedia-manifest Zod schema + YAML I/O"
```

---

## Task 6: `lib/content-generator-client.ts` — typed wrapper for the API

**Files:**
- Create: `lib/content-generator-client.ts`
- Test: `lib/content-generator-client.test.ts`

Wrapper around the live contract documented in Task 1 step 4.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/content-generator-client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentGeneratorClient, ContentGeneratorAuthError } from './content-generator-client.js';

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('ContentGeneratorClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('returns PNG bytes on 200 image/png', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(PNG_MAGIC, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const c = new ContentGeneratorClient({ url: 'https://x.test/gen', apiKey: 'k' });
    const out = await c.generateImage({ applicationContext: 'A', formText: 'F', imageDirectives: 'D' });
    expect(out.subarray(0, 8)).toEqual(Buffer.from(PNG_MAGIC));
  });

  it('sends Authorization Bearer header with the API key', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(PNG_MAGIC, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const c = new ContentGeneratorClient({ url: 'https://x.test/gen', apiKey: 'k123' });
    await c.generateImage({ applicationContext: 'A', formText: 'F' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer k123');
  });

  it('retries once on 5xx then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('fail', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(PNG_MAGIC, { status: 200, headers: { 'content-type': 'image/png' } }),
      );
    const c = new ContentGeneratorClient({ url: 'https://x.test/gen', apiKey: 'k', retryDelayMs: 1 });
    const out = await c.generateImage({ applicationContext: 'A', formText: 'F' });
    expect(out.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws ContentGeneratorAuthError on 401/403', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const c = new ContentGeneratorClient({ url: 'https://x.test/gen', apiKey: 'bad', retryDelayMs: 1 });
    await expect(c.generateImage({ applicationContext: 'A', formText: 'F' })).rejects.toBeInstanceOf(
      ContentGeneratorAuthError,
    );
  });

  it('does not retry on 4xx (other than 408/429)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    const c = new ContentGeneratorClient({ url: 'https://x.test/gen', apiKey: 'k', retryDelayMs: 1 });
    await expect(c.generateImage({ applicationContext: 'A', formText: 'F' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm test -- lib/content-generator-client.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement (adapt to live contract from Task 1)**

```typescript
// lib/content-generator-client.ts
//
// Wrapper around Dimagi's internal Content Generator API. Live contract
// documented in scripts/probe-content-generator.ts.

export class ContentGeneratorAuthError extends Error {
  constructor(public status: number, body: string) {
    super(`Content Generator auth failed (${status}): ${body.slice(0, 200)}`);
    this.name = 'ContentGeneratorAuthError';
  }
}

export class ContentGeneratorClient {
  constructor(
    private opts: {
      url: string;
      apiKey: string;
      timeoutMs?: number;       // default 60_000
      retryDelayMs?: number;    // default 1_000
    },
  ) {}

  async generateImage(input: {
    applicationContext: string;
    formText: string;
    imageDirectives?: string;
  }): Promise<Buffer> {
    const body = {
      application_context: input.applicationContext,
      form_text: input.formText,
      image_directives: input.imageDirectives ?? '',
    };

    const attempt = async (): Promise<Response> => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? 60_000);
      try {
        return await fetch(this.opts.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(t);
      }
    };

    let res = await attempt();
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      await new Promise(r => setTimeout(r, this.opts.retryDelayMs ?? 1_000));
      res = await attempt();
    }

    if (res.status === 401 || res.status === 403) {
      throw new ContentGeneratorAuthError(res.status, await res.text());
    }
    if (res.status !== 200) {
      throw new Error(`Content Generator HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const ct = res.headers.get('content-type') ?? '';
    if (ct.startsWith('image/')) {
      return Buffer.from(await res.arrayBuffer());
    }
    if (ct.includes('json')) {
      // Live contract may return {url: signed} — fetch it inline.
      const j = await res.json();
      if (typeof j?.url === 'string') {
        const r2 = await fetch(j.url);
        if (r2.status !== 200) throw new Error(`signed URL fetch ${r2.status}`);
        return Buffer.from(await r2.arrayBuffer());
      }
      throw new Error(`Content Generator JSON response had no .url: ${JSON.stringify(j).slice(0, 200)}`);
    }
    throw new Error(`Content Generator unexpected content-type: ${ct}`);
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npm test -- lib/content-generator-client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit (probe + client together)**

```bash
git add lib/content-generator-client.ts lib/content-generator-client.test.ts scripts/probe-content-generator.ts
git commit -m "feat(lib): content-generator-client + probe script"
```

---

## Task 7: `lib/multimedia-judge.ts` — LLM judge for "image-worthy" fields

**Files:**
- Create: `lib/multimedia-judge.ts`
- Test: `lib/multimedia-judge.test.ts`

Single Anthropic SDK call per field. App Context goes in an `ephemeral`-cached block. Sonnet 4.6.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/multimedia-judge.test.ts
import { describe, it, expect, vi } from 'vitest';
import { judgeField, type JudgeInput } from './multimedia-judge.js';

const fakeAnthropic = (responseText: string) => ({
  messages: {
    create: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: responseText }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  },
});

const baseInput: JudgeInput = {
  appContext: 'African FLWs teaching mothers KMC for SVN newborns. Modestly dressed.',
  appType: 'learn',
  formName: 'KMC positioning',
  formPosition: 'module 1, form 0 (instructional)',
  field: {
    id: 'kmc_position_demo',
    kind: 'label',
    label: "Show the mother how to support the baby's head and neck while skin-to-skin.",
    hint: null,
    options: [],
  },
  surroundingFields: [],
};

describe('judgeField', () => {
  it('parses a valid yes-self-use response', async () => {
    const fake = fakeAnthropic(
      JSON.stringify({
        generate: true,
        use_case: 'flw_self_use',
        why: 'FLW uses this to demonstrate KMC positioning.',
        directive: 'Frontline worker assisting a mother holding a small newborn skin-to-skin.',
      }),
    );
    const out = await judgeField(baseInput, fake as any);
    expect(out.generate).toBe(true);
    expect(out.use_case).toBe('flw_self_use');
  });

  it('parses a valid no response', async () => {
    const fake = fakeAnthropic(JSON.stringify({ generate: false, why: 'numeric input', directive: null }));
    const out = await judgeField(baseInput, fake as any);
    expect(out.generate).toBe(false);
  });

  it('throws on schema-invalid LLM output', async () => {
    const fake = fakeAnthropic(JSON.stringify({ generate: 'maybe', why: 42 }));
    await expect(judgeField(baseInput, fake as any)).rejects.toThrow();
  });

  it('throws on non-JSON LLM output', async () => {
    const fake = fakeAnthropic('I am sorry, I cannot');
    await expect(judgeField(baseInput, fake as any)).rejects.toThrow();
  });

  it('places appContext in a cache_control:ephemeral block', async () => {
    const fake = fakeAnthropic(
      JSON.stringify({ generate: false, why: 'x', directive: null }),
    );
    await judgeField(baseInput, fake as any);
    const callArgs = fake.messages.create.mock.calls[0][0];
    const sysBlocks = Array.isArray(callArgs.system) ? callArgs.system : [];
    const ephemeral = sysBlocks.find((b: any) => b.cache_control?.type === 'ephemeral');
    expect(ephemeral).toBeDefined();
    expect(ephemeral.text).toContain(baseInput.appContext);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm test -- lib/multimedia-judge.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```typescript
// lib/multimedia-judge.ts
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';

export const judgeOutputSchema = z.object({
  generate: z.boolean(),
  use_case: z.enum(['flw_self_use', 'flw_shows_client', 'both']).optional().nullable(),
  why: z.string().min(1).max(500),
  directive: z.string().max(800).nullable(),
});

export type JudgeOutput = z.infer<typeof judgeOutputSchema>;

export interface JudgeInput {
  appContext: string;
  appType: 'learn' | 'deliver';
  formName: string;
  formPosition: string;
  field: {
    id: string;
    kind: string;
    label: string;
    hint: string | null;
    options: string[];
  };
  surroundingFields: Array<{ id: string; kind: string; label: string }>;
}

const SYSTEM_HEAD = `You decide whether to generate a display-only image for a single CommCare app question.

Criterion (yes if EITHER applies):
1. The frontline worker (FLW) would use this image themselves to do their job — e.g. a step-by-step demonstration, a labeled diagram of an anatomy or device.
2. The FLW would show the image to a client to communicate something — e.g. a visual choice card, a "what does X look like" reference.

Skip if the question is purely numeric (weight, age), date/time, or a yes/no without ambiguity. Skip if the question's text alone is unambiguous and concrete.

Return STRICT JSON only, matching this schema:
{
  "generate": boolean,
  "use_case": "flw_self_use" | "flw_shows_client" | "both" | null,
  "why": "short rationale, ≤200 chars",
  "directive": "draft Image Directive for the generator, ≤500 chars, or null if generate=false"
}

Image Directive guidance: be specific about the subject, action, environment, lighting, and any modesty/representation cues from the application context. The directive will be passed verbatim to an image generator.`;

export async function judgeField(
  input: JudgeInput,
  anthropic: Anthropic,
  model = 'claude-sonnet-4-6',
): Promise<JudgeOutput> {
  const userPayload = {
    app_type: input.appType,
    form_name: input.formName,
    form_position: input.formPosition,
    field: input.field,
    surrounding_fields: input.surroundingFields,
  };

  const res = await anthropic.messages.create({
    model,
    max_tokens: 600,
    system: [
      { type: 'text', text: SYSTEM_HEAD },
      {
        type: 'text',
        text: `Application Context (constant for this opp):\n${input.appContext}`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
  });

  const text = (res.content[0] as { type: string; text?: string }).text ?? '';
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`judge returned non-JSON: ${text.slice(0, 200)}`);
  }
  return judgeOutputSchema.parse(parsed);
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npm test -- lib/multimedia-judge.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/multimedia-judge.ts lib/multimedia-judge.test.ts
git commit -m "feat(lib): multimedia-judge LLM rubric for image-worthy fields"
```

---

## Task 8: `lib/multimedia-xform-patch.ts` — add `<image>` itext to a form

**Files:**
- Create: `lib/multimedia-xform-patch.ts`
- Test: `lib/multimedia-xform-patch.test.ts`
- Test fixture: `test/fixtures/cchq/multimedia-sample-form.xml` (a minimal CommCare XForm with a label question, 30-50 lines)

Pure XML-DOM manipulation. No I/O.

- [ ] **Step 1: Create the test fixture**

```xml
<!-- test/fixtures/cchq/multimedia-sample-form.xml -->
<?xml version="1.0" encoding="UTF-8"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"
        xmlns:jr="http://openrosa.org/javarosa">
  <h:head>
    <h:title>KMC positioning</h:title>
    <model>
      <instance>
        <data id="kmc_positioning" xmlns="">
          <kmc_position_demo/>
        </data>
      </instance>
      <itext>
        <translation lang="en" default="">
          <text id="kmc_position_demo-label">
            <value>Show the mother how to support the baby's head and neck.</value>
          </text>
        </translation>
      </itext>
      <bind nodeset="/data/kmc_position_demo" type="xsd:string"/>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/kmc_position_demo">
      <label ref="jr:itext('kmc_position_demo-label')"/>
    </input>
  </h:body>
</h:html>
```

- [ ] **Step 2: Write the failing test**

```typescript
// lib/multimedia-xform-patch.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addImageItext } from './multimedia-xform-patch.js';

const FIXTURE = readFileSync(
  join(__dirname, '../test/fixtures/cchq/multimedia-sample-form.xml'),
  'utf-8',
);

describe('addImageItext', () => {
  it('adds an <image> jr:// value to the matching itext text node', () => {
    const out = addImageItext(FIXTURE, [
      { fieldId: 'kmc_position_demo', cczFilename: 'kmc_position_demo.png' },
    ]);
    expect(out.patched).toBe(true);
    expect(out.xml).toContain('<value form="image">jr://file/commcare/image/kmc_position_demo.png</value>');
    // The original label value must remain intact.
    expect(out.xml).toContain("Show the mother how to support the baby's head and neck.");
  });

  it('is idempotent — re-applying does not duplicate the <image> entry', () => {
    const once = addImageItext(FIXTURE, [
      { fieldId: 'kmc_position_demo', cczFilename: 'kmc_position_demo.png' },
    ]);
    const twice = addImageItext(once.xml, [
      { fieldId: 'kmc_position_demo', cczFilename: 'kmc_position_demo.png' },
    ]);
    const occurrences = (twice.xml.match(/jr:\/\/file\/commcare\/image\/kmc_position_demo\.png/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(twice.patched).toBe(false);
  });

  it('returns patched=false when the field has no matching itext entry', () => {
    const out = addImageItext(FIXTURE, [{ fieldId: 'no_such_field', cczFilename: 'x.png' }]);
    expect(out.patched).toBe(false);
  });

  it('handles multiple fields in one pass', () => {
    // Build a form with two label-text entries
    const twoFieldForm = FIXTURE.replace(
      /<text id="kmc_position_demo-label">[\s\S]*?<\/text>/,
      `<text id="a-label"><value>A</value></text><text id="b-label"><value>B</value></text>`,
    );
    const out = addImageItext(twoFieldForm, [
      { fieldId: 'a', cczFilename: 'a.png' },
      { fieldId: 'b', cczFilename: 'b.png' },
    ]);
    expect(out.xml).toContain('jr://file/commcare/image/a.png');
    expect(out.xml).toContain('jr://file/commcare/image/b.png');
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

```bash
npm test -- lib/multimedia-xform-patch.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 4: Check available XML library**

```bash
grep -E '"@xmldom/xmldom"|"xmldom"|"fast-xml-parser"' package.json
```

If `@xmldom/xmldom` is present, use it. Otherwise `npm install --save @xmldom/xmldom` then commit `package.json` + `package-lock.json` changes alongside the implementation in step 6.

- [ ] **Step 5: Implement**

```typescript
// lib/multimedia-xform-patch.ts
//
// Pure XML transformation: given a CommCare XForm and a list of
// (fieldId, cczFilename) pairs, add a `<value form="image">jr://...</value>`
// child to the matching `<text id="<fieldId>-label">` node in itext.
// Idempotent: skips fields whose <image> value is already present.

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

export interface ImageBinding {
  fieldId: string;
  cczFilename: string;
}

export interface PatchResult {
  patched: boolean;
  xml: string;
  applied: string[];      // field ids that were modified
  skipped: string[];      // field ids whose itext was already up-to-date
  notFound: string[];     // field ids with no matching itext text
}

export function addImageItext(xml: string, bindings: ImageBinding[]): PatchResult {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const applied: string[] = [];
  const skipped: string[] = [];
  const notFound: string[] = [];

  // Find every <text id="..."> node anywhere; loose match handles
  // multi-translation forms (each <translation lang="..."> has its own copy).
  const texts = Array.from(doc.getElementsByTagName('text'));

  for (const b of bindings) {
    const targetId = `${b.fieldId}-label`;
    const matches = texts.filter(t => t.getAttribute('id') === targetId);
    if (matches.length === 0) {
      notFound.push(b.fieldId);
      continue;
    }

    const jrUrl = `jr://file/commcare/image/${b.cczFilename}`;
    let modifiedThisField = false;
    for (const t of matches) {
      const existing = Array.from(t.getElementsByTagName('value')).some(
        v => v.getAttribute('form') === 'image' && (v.textContent ?? '').trim() === jrUrl,
      );
      if (existing) continue;

      const valueEl = doc.createElement('value');
      valueEl.setAttribute('form', 'image');
      valueEl.appendChild(doc.createTextNode(jrUrl));
      t.appendChild(valueEl);
      modifiedThisField = true;
    }

    if (modifiedThisField) applied.push(b.fieldId);
    else skipped.push(b.fieldId);
  }

  const out = new XMLSerializer().serializeToString(doc);
  return { patched: applied.length > 0, xml: out, applied, skipped, notFound };
}
```

- [ ] **Step 6: Run tests, verify pass**

```bash
npm test -- lib/multimedia-xform-patch.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add lib/multimedia-xform-patch.ts lib/multimedia-xform-patch.test.ts test/fixtures/cchq/multimedia-sample-form.xml
# include package.json/lock if dependency was added
git commit -m "feat(lib): multimedia-xform-patch — add <image> itext entries"
```

---

## Task 9: `commcare_upload_multimedia` MCP atom

**Files:**
- Modify: `mcp/connect/backends/commcare.ts` (add `uploadMultimedia` method)
- Modify: `mcp/connect/capability-map.ts` (add capability)
- Test: `test/mcp/connect/unit/commcare-upload-multimedia.test.ts`
- Integration test: `test/mcp/connect/integration/commcare-upload-multimedia.test.ts`

**Live contract** (probed 2026-05-05; see `scripts/probe-multimedia-upload.ts` header):

- **Method**: `POST`
- **Path**: `/a/<domain>/apps/<app_id>/multimedia/uploaded/<media_type>/` where `<media_type>` ∈ `{image, audio, video, text}` derived from the `content_type` MIME prefix
- **Body**: multipart/form-data; **required** `Filedata` (bytes) and `path` (`jr://file/commcare/<media_type>/<filename>.<ext>`); **optional** `originalPath`, `shared='t'`, `license`, `author`, `attribution-notes`
- **Headers**: `X-CSRFToken` (from session cookie), `Referer: <baseUrl>/a/<domain>/apps/view/<app_id>/`
- **Response 200**: `Content-Type: text/html` (lies; body is JSON):
  ```json
  {
    "ref": {
      "path": "jr://file/commcare/image/foo.png",
      "uid":  "<32-hex md5>",        // → file_hash_md5 (CCHQ dedupes on this)
      "m_id": "<32-hex couch _id>",  // → multimedia_id
      "url":  "/hq/multimedia/file/CommCareImage/<m_id>/",
      "updated": false,
      "media_type": "Image"
    },
    "errors": []
  }
  ```
- **Failure**: `400` with non-empty `errors[]`; `302 → /accounts/login/` on session expiry; `403` on CSRF miss

**CRITICAL gotcha — orphan pruning.** CCHQ's `clean_paths()` strips multimedia entries that no form references on the next `make_build`. So this atom alone does NOT bundle the file into the released CCZ — the form-XML must already reference the `jr://...` path before `make_build` runs. The skill (Task 12) is responsible for ordering: patch form XML → upload media → make_build → release. The atom only owns the upload step.

- [ ] **Step 1: Write the failing unit test**

```typescript
// test/mcp/connect/unit/commcare-upload-multimedia.test.ts
import { describe, it, expect, vi } from 'vitest';
import { CommcareBackend } from '../../../../mcp/connect/backends/commcare.js';

function fakeRequest(handler: (url: string, init: any) => { status: number; body: string; contentType?: string }) {
  return {
    get: vi.fn().mockImplementation(async () => ({
      status: () => 200, text: async () => '<html></html>', headers: () => new Headers(),
    })),
    post: vi.fn().mockImplementation(async (url: string, init: any) => {
      const r = handler(url, init);
      const headers = new Headers({ 'content-type': r.contentType ?? 'text/html' });
      return { status: () => r.status, text: async () => r.body, headers: () => headers };
    }),
    storageState: async () => ({ cookies: [{ name: 'csrftoken', value: 'TOKEN' }] }),
  };
}

const SUCCESS_BODY = JSON.stringify({
  ref: {
    path: 'jr://file/commcare/image/x.png',
    uid: 'd'.repeat(32),       // md5 hex
    m_id: '9'.repeat(32),
    url: '/hq/multimedia/file/CommCareImage/' + '9'.repeat(32) + '/',
    updated: false,
    media_type: 'Image',
  },
  errors: [],
});

describe('commcare uploadMultimedia', () => {
  it('POSTs to /multimedia/uploaded/image/ for image content types', async () => {
    let postedUrl = '';
    const fake = fakeRequest((url) => {
      postedUrl = url;
      return { status: 200, body: SUCCESS_BODY };
    });
    const backend = new CommcareBackend({ request: fake as any, baseUrl: 'https://test.cchq' });
    await backend.uploadMultimedia({
      domain: 'demo', app_id: 'a'.repeat(32),
      media_path: 'jr://file/commcare/image/x.png',
      file_bytes: Buffer.from('PNG'), content_type: 'image/png',
    });
    expect(postedUrl).toBe('https://test.cchq/a/demo/apps/' + 'a'.repeat(32) + '/multimedia/uploaded/image/');
  });

  it('returns multimedia_id (m_id) and file_hash_md5 (uid) from ref', async () => {
    const fake = fakeRequest(() => ({ status: 200, body: SUCCESS_BODY }));
    const backend = new CommcareBackend({ request: fake as any, baseUrl: 'https://test.cchq' });
    const out = await backend.uploadMultimedia({
      domain: 'demo', app_id: 'a'.repeat(32),
      media_path: 'jr://file/commcare/image/x.png',
      file_bytes: Buffer.from('PNG'), content_type: 'image/png',
    });
    expect(out.multimedia_id).toBe('9'.repeat(32));
    expect(out.file_hash_md5).toBe('d'.repeat(32));
  });

  it('routes audio content types to /multimedia/uploaded/audio/', async () => {
    let postedUrl = '';
    const fake = fakeRequest((url) => {
      postedUrl = url;
      return { status: 200, body: SUCCESS_BODY };
    });
    const backend = new CommcareBackend({ request: fake as any, baseUrl: 'https://test.cchq' });
    await backend.uploadMultimedia({
      domain: 'd', app_id: 'a'.repeat(32),
      media_path: 'jr://file/commcare/audio/x.mp3',
      file_bytes: Buffer.from('MP3'), content_type: 'audio/mpeg',
    });
    expect(postedUrl).toMatch(/\/multimedia\/uploaded\/audio\/$/);
  });

  it('sets X-CSRFToken from cookies and uses the app-view page as Referer', async () => {
    let init: any = null;
    const fake = fakeRequest((_url, _init) => {
      init = _init;
      return { status: 200, body: SUCCESS_BODY };
    });
    const backend = new CommcareBackend({ request: fake as any, baseUrl: 'https://test.cchq' });
    await backend.uploadMultimedia({
      domain: 'demo', app_id: 'a'.repeat(32),
      media_path: 'jr://file/commcare/image/x.png',
      file_bytes: Buffer.from('PNG'), content_type: 'image/png',
    });
    expect(init.headers['X-CSRFToken']).toBe('TOKEN');
    expect(init.headers.Referer).toBe('https://test.cchq/a/demo/apps/view/' + 'a'.repeat(32) + '/');
  });

  it('throws with errors[] payload when CCHQ returns 400', async () => {
    const fake = fakeRequest(() => ({
      status: 400,
      body: JSON.stringify({ ref: null, errors: ['File extension does not match content_type'] }),
    }));
    const backend = new CommcareBackend({ request: fake as any, baseUrl: 'https://test.cchq' });
    await expect(
      backend.uploadMultimedia({
        domain: 'd', app_id: 'a'.repeat(32),
        media_path: 'jr://file/commcare/image/x.png',
        file_bytes: Buffer.from('x'), content_type: 'image/png',
      }),
    ).rejects.toThrow(/extension does not match/);
  });

  it('throws on 302 redirect (session expired)', async () => {
    const fake = fakeRequest(() => ({ status: 302, body: '<html>login</html>' }));
    const backend = new CommcareBackend({ request: fake as any, baseUrl: 'https://test.cchq' });
    await expect(
      backend.uploadMultimedia({
        domain: 'd', app_id: 'a'.repeat(32),
        media_path: 'jr://file/commcare/image/x.png',
        file_bytes: Buffer.from('x'), content_type: 'image/png',
      }),
    ).rejects.toThrow(/302|session/i);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm test -- test/mcp/connect/unit/commcare-upload-multimedia.test.ts
```

Expected: FAIL — `uploadMultimedia` does not exist.

- [ ] **Step 3: Add the backend method**

In `mcp/connect/backends/commcare.ts`, add (place after `patchXform` around line 360+):

```typescript
export interface UploadMultimediaArgs {
  domain: string;
  app_id: string;
  media_path: string;          // jr://file/commcare/<image|audio|video|text>/<filename>.<ext>
  file_bytes: Buffer;
  content_type: string;        // "image/png" | "image/jpeg" | "audio/mpeg" | ...
}

export interface UploadMultimediaResult {
  multimedia_id: string;       // CouchDB doc _id (CCHQ's ref.m_id)
  file_hash_md5: string;       // md5 hex of the file bytes (CCHQ's ref.uid)
}

// Inside CommcareBackend class:
async uploadMultimedia(args: UploadMultimediaArgs): Promise<UploadMultimediaResult> {
  const mediaType = mediaTypeFromContentType(args.content_type);
  const path = `/a/${args.domain}/apps/${args.app_id}/multimedia/uploaded/${mediaType}/`;
  const refreshPath = `/a/${args.domain}/apps/view/${args.app_id}/`;

  // Refresh CSRF + session via the app view page (same pattern as patchXform).
  await this.opts.request.get(`${this.opts.baseUrl}${refreshPath}`);
  const csrf = await this.csrfFromCookies();

  // Derive filename from media_path (last URI segment).
  const filename = args.media_path.split('/').pop() ?? 'unnamed';

  const form = new FormData();
  form.set('Filedata', new Blob([args.file_bytes], { type: args.content_type }), filename);
  form.set('path', args.media_path);

  const res = await this.opts.request.post(`${this.opts.baseUrl}${path}`, {
    multipart: form as any,
    headers: {
      'X-CSRFToken': csrf ?? '',
      Referer: `${this.opts.baseUrl}${refreshPath}`,
    },
    maxRedirects: 0,
  });
  const status = res.status();
  const body = await res.text();

  if (status === 302) {
    throw new Error(
      `commcare_upload_multimedia POST ${path} returned 302 — session expired. Re-run /ace:connect-login.`,
    );
  }
  if (status !== 200) {
    let errs: string[] = [];
    try {
      const j = JSON.parse(body);
      if (Array.isArray(j?.errors)) errs = j.errors;
    } catch { /* fall through */ }
    const errMsg = errs.length ? errs.join('; ') : body.slice(0, 300);
    throw new Error(
      `commcare_upload_multimedia POST ${path} returned ${status}: ${errMsg}`,
    );
  }

  let parsed: { ref?: { m_id?: string; uid?: string }; errors?: string[] } = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`commcare_upload_multimedia non-JSON response: ${body.slice(0, 200)}`);
  }
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(`commcare_upload_multimedia errors: ${parsed.errors.join('; ')}`);
  }
  if (!parsed.ref?.m_id || !parsed.ref?.uid) {
    throw new Error(
      `commcare_upload_multimedia response missing ref.m_id / ref.uid: ${body.slice(0, 200)}`,
    );
  }
  return {
    multimedia_id: parsed.ref.m_id,
    file_hash_md5: parsed.ref.uid,
  };
}

function mediaTypeFromContentType(ct: string): 'image' | 'audio' | 'video' | 'text' {
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('text/'))  return 'text';
  throw new Error(`commcare_upload_multimedia: unsupported content_type ${ct}`);
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npm test -- test/mcp/connect/unit/commcare-upload-multimedia.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Add integration test**

```typescript
// test/mcp/connect/integration/commcare-upload-multimedia.test.ts
//
// Verifies the upload atom against a live CCHQ project. NOTE: this test
// only verifies the upload step (200 + parseable response). It does NOT
// build or release because orphan multimedia (no form reference) gets
// pruned by clean_paths() — that's expected CCHQ behavior, not a bug.
// Bundling-into-CCZ is the skill's responsibility, exercised end-to-end
// in Task 14's live smoke test.
import { describe, it, expect } from 'vitest';
import { commcareClient } from '../../../../mcp/connect/backends/commcare.js';

const RUN = process.env.CONNECT_INTEGRATION === '1';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

describe.skipIf(!RUN)('commcare_upload_multimedia (integration)', () => {
  it('uploads a tiny PNG and returns multimedia_id + file_hash_md5', async () => {
    const domain = process.env.ACE_HQ_DOMAIN!;
    const appId = process.env.ACE_SMOKE_APP_ID!;
    expect(domain).toBeTruthy();
    expect(appId).toBeTruthy();

    const c = await commcareClient();
    const filename = `probe-${Date.now()}.png`;
    const out = await c.uploadMultimedia({
      domain, app_id: appId,
      media_path: `jr://file/commcare/image/${filename}`,
      file_bytes: TINY_PNG, content_type: 'image/png',
    });
    expect(out.multimedia_id).toMatch(/^[0-9a-f]{32}$/);
    expect(out.file_hash_md5).toMatch(/^[0-9a-f]{32}$/);
  }, 30_000);

  it('is idempotent — same bytes return the same multimedia_id', async () => {
    const domain = process.env.ACE_HQ_DOMAIN!;
    const appId = process.env.ACE_SMOKE_APP_ID!;
    const c = await commcareClient();
    const filename = `probe-idem-${Date.now()}.png`;
    const a = await c.uploadMultimedia({
      domain, app_id: appId,
      media_path: `jr://file/commcare/image/${filename}`,
      file_bytes: TINY_PNG, content_type: 'image/png',
    });
    const b = await c.uploadMultimedia({
      domain, app_id: appId,
      media_path: `jr://file/commcare/image/${filename}`,
      file_bytes: TINY_PNG, content_type: 'image/png',
    });
    expect(b.multimedia_id).toBe(a.multimedia_id);
    expect(b.file_hash_md5).toBe(a.file_hash_md5);
  }, 30_000);
});
```

- [ ] **Step 6: Run integration test (gated)**

```bash
CONNECT_INTEGRATION=1 \
  ACE_HQ_DOMAIN=connect-ace-prod \
  ACE_SMOKE_APP_ID=4e20ddf5beca42278c4d2c20383eb943 \
  npm test -- test/mcp/connect/integration/commcare-upload-multimedia.test.ts
```

(Domain + app_id values above are from the live probe in Task 2; replace with current smoke target if those are stale.)

Expected: PASS. If it fails because the contract has drifted, re-run the probe script to confirm the live shape and adjust the atom + test together.

- [ ] **Step 7: Commit**

```bash
git add mcp/connect/backends/commcare.ts \
        test/mcp/connect/unit/commcare-upload-multimedia.test.ts \
        test/mcp/connect/integration/commcare-upload-multimedia.test.ts \
        scripts/probe-multimedia-upload.ts
git commit -m "feat(connect): commcare_upload_multimedia atom backend"
```

---

## Task 10: Wire the atom into the MCP server + capability map

**Files:**
- Modify: `mcp/connect-server.ts` (add `server.tool('commcare_upload_multimedia', ...)`)
- Modify: `mcp/connect/capability-map.ts` (add the capability entry)

- [ ] **Step 1: Add tool registration**

In `mcp/connect-server.ts`, after the `commcare_patch_xform` block (line ~413), add:

```typescript
// commcare_upload_multimedia — POST a binary multimedia asset to CCHQ.
// Required companion to commcare_patch_xform: the form-XML patch makes the
// build *reference* the asset; this atom puts the *bytes* into CouchDB so
// CCHQ's clean_paths() doesn't prune the reference on the next make_build.
//
// Endpoint: POST /a/<domain>/apps/<app_id>/multimedia/uploaded/<media_type>/
//   <media_type> derives from content_type MIME prefix.
// Auth: same Playwright session as commcare_patch_xform; X-CSRFToken header.
// Returns: { multimedia_id, file_hash_md5 } — see backends/commcare.ts.
//
// CRITICAL ORDER OF OPERATIONS:
//   1. patch form XML to reference jr://file/commcare/<type>/<filename>
//   2. commcare_upload_multimedia (this atom)
//   3. commcare_make_build + commcare_release_build
// Reversing 1 and 2 still works (uploads are idempotent), but skipping
// step 1 means the upload is silently no-op for FLW devices because
// CCHQ's clean_paths() prunes orphaned media on every build.
server.tool('commcare_upload_multimedia',
  {
    domain: z.string(),
    app_id: z.string().regex(/^[0-9a-f]{32}$/, '32-char hex'),
    media_path: z.string().regex(/^jr:\/\/file\/commcare\/(image|audio|video|text)\/[^\/]+$/),
    file_bytes_base64: z.string().min(1).describe('Asset bytes, base64-encoded'),
    content_type: z.string().regex(/^(image|audio|video|text)\//),
  },
  async (args) =>
    runAtom(async () => {
      const { file_bytes_base64, ...rest } = args;
      return (await commcareClient()).uploadMultimedia({
        ...rest,
        file_bytes: Buffer.from(file_bytes_base64, 'base64'),
      });
    }),
);
```

- [ ] **Step 2: Add capability entry**

In `mcp/connect/capability-map.ts`, add `'upload_multimedia'` to the `Capability` union and to whatever routing table is alongside it. Backend: `'PLAYWRIGHT'`. Look at the existing entry for `'patch_xform'` and copy the shape exactly.

- [ ] **Step 3: Smoke-test the MCP server boots**

```bash
npm run mcp:connect 2>&1 | head -20 &
sleep 2
kill %1 || true
```

Expected: server starts without throwing. If a Zod schema or capability-map entry is malformed, the import fails noisily.

- [ ] **Step 4: Commit**

```bash
git add mcp/connect-server.ts mcp/connect/capability-map.ts
git commit -m "feat(connect): register commcare_upload_multimedia tool"
```

---

## Task 11: Doctor checks for new env vars

**Files:**
- Modify: `bin/ace-doctor` (add CONTENT_GENERATOR_URL / CONTENT_GENERATOR_API_KEY to the env-drift check)

- [ ] **Step 1: Find the existing env-drift check**

```bash
grep -n "CONTENT_GENERATOR\|env_drift\|env_file" bin/ace-doctor | head -20
grep -n "OCS_API_TOKEN\|ACE_HQ_USERNAME" bin/ace-doctor | head -10
```

The env-drift block enumerates expected `.env` keys and reports any that are missing.

- [ ] **Step 2: Add the two new keys**

In `bin/ace-doctor`, locate the array / list of expected env var names and add `CONTENT_GENERATOR_URL` and `CONTENT_GENERATOR_API_KEY`.

If there's a separate "service health" section that probes each integration, add a passive check: present-and-non-empty only (no live HTTP call — image generation is too slow / costly to ping on every doctor run).

- [ ] **Step 3: Run doctor and verify**

```bash
/ace:doctor 2>&1 | grep -i content
```

Expected: output mentions `CONTENT_GENERATOR_URL` and `CONTENT_GENERATOR_API_KEY` either as `OK` (if `.env` was regenerated in Task 3) or `MISSING` (otherwise).

- [ ] **Step 4: Commit**

```bash
git add bin/ace-doctor
git commit -m "feat(doctor): check Content Generator env vars"
```

---

## Task 12: `skills/app-multimedia-coverage/SKILL.md` — the orchestration prose

**Files:**
- Create: `skills/app-multimedia-coverage/SKILL.md`

This is a prompt, not code. Mirror the structure of `skills/commcare-form-patch/SKILL.md` (process, mode behavior, dry-run, failure modes, MCP tools used, change log).

- [ ] **Step 1: Read the reference skill**

Open `skills/commcare-form-patch/SKILL.md` end-to-end and `skills/app-connect-coverage/SKILL.md` for the verify+fix pattern.

- [ ] **Step 2: Author SKILL.md**

```markdown
---
name: app-multimedia-coverage
description: >
  Post-Phase-2 enhancement skill that attaches display-only images to
  Connect Learn / Deliver app questions. Uses an LLM judge to pick which
  fields deserve images (criterion: FLW uses it OR shows it to a client),
  generates them via Dimagi's Content Generator API, patches the form
  XML to add `<image>` itext references, uploads the assets to CCHQ via
  `commcare_upload_multimedia`, and re-builds + re-releases the apps.
  Manual gate; not part of `/ace:run`. Sibling of `commcare-form-patch`.
  Delete when Nova ships first-class field-level multimedia (see § Removal
  criteria).
---

# App Multimedia Coverage

Generate and attach display-only images to Connect app questions where
they meaningfully help frontline workers. This skill closes the loop
that Nova doesn't today: schema for media on a field, asset generation,
CCZ bundling, form-XML reference, and a release. Mirrors the
end-to-end pattern of `commcare-form-patch`.

## Why this skill exists

CommCare apps render images on questions via standard `<image>` itext
references and CCZ-bundled assets at `commcare/multimedia/image/...`.
Nova has no schema for this — its `image`/`audio`/`video` field kinds
are *input capture*, not *display*. Until Nova ships field-level media
(see § Removal criteria), this skill is the only path from "PDD" to
"images on screen."

## Removal criteria

Delete this skill (and the supporting helpers + atom) when ALL of:

1. Nova ships a field-level `media: { image_url, alt_text, image_directives }`
   schema and round-trips it through `compile_app`.
2. Nova's compile bundles linked media into the produced CCZ at
   `commcare/multimedia/image/...`.
3. A clean `/ace:run` against `CRISPR-Test-004-KMC-multimedia` produces
   images-attached apps without this skill firing.
4. Each affected opp's `run_state.yaml` has empty
   `phase_2_backlog.app-multimedia-coverage`.

## Process

Inputs:
- `<opp-name>` — positional, required
- `--app=learn|deliver|both` — default `both`
- `--max-images=N` — default `100` (runaway guard)
- `--dry-run` — investigate without generating or patching

For each app in scope:

1. **Read deployment summary** `2-commcare/app-deploy_summary.md` →
   `hq_domain`, `learn_app_id` / `deliver_app_id`, latest released
   `build_id`. Read PDD for App Context derivation.

2. **Derive Application Context.** If
   `2-commcare/app-multimedia-coverage_app-context.md` exists, use as-is
   (operator override wins). Otherwise synthesize from the PDD's
   intervention description + a target-FLW one-liner + the standard
   Dimagi guidance ("People should be dressed modestly. All of the
   users and participants should be representative of the context.").
   Write the synthesized version back so the operator can edit.

3. **LLM-judge each visible field** via `lib/multimedia-judge.ts`. Skip
   `hidden` and `calculate` kinds. Skip kinds with no displayed label.
   Application Context goes in a prompt-cached system block — every
   per-field call benefits from cache hit on the constant block.

4. **Write candidates YAML** to
   `2-commcare/app-multimedia-coverage_candidates-<app>.yaml`. If the
   file already exists, **operator hand-edits win** — load as-is. The
   judge runs only on first creation; re-run with `--rejudge` to
   refresh.

5. **Cost preview** — print
   `Will generate {N} images for <app>; ~30s each ≈ M minutes.`
   Halt if `N > --max-images`.

6. **Generate images.** For each `generate: true` candidate:
   - Compute `prompt_hash` via `lib/multimedia-prompt-hash.ts`.
   - Cache hit (PNG present at expected path) → skip.
   - Cache miss → `ContentGeneratorClient.generateImage(...)` → save
     PNG to
     `2-commcare/app-multimedia-coverage_generated/<app>/<form_unique_id>/<field_id>__<prompt_hash>.png`
     → update `app-multimedia-coverage_manifest.yaml`.
   - Default: serial. Bounded parallelism may be added later.

7. **Patch form XML** for each form with ≥1 image:
   - `commcare_download_ccz` to fetch the released form XML.
   - `addImageItext()` from `lib/multimedia-xform-patch.ts` to add the
     `<image>` itext entries.
   - `commcare_patch_xform` to POST the patched XML.
   - Re-fetch via `commcare_download_ccz` to confirm the patch stuck.

   **WHY this happens before the upload:** CCHQ's `clean_paths()` prunes
   any multimedia binary that no form references on the next
   `make_build`. The form-XML reference is what causes CCHQ to retain
   the asset in the build's multimedia map. Reverse this order and the
   asset lands in CouchDB but never reaches FLW devices.

8. **Upload multimedia to CCHQ** via `commcare_upload_multimedia` per
   image. Record returned `multimedia_id` (CCHQ couch _id) and
   `file_hash_md5` (CCHQ's md5 of the bytes) into the manifest.

9. **Build + release** — `commcare_make_build` then
   `commcare_release_build`. Capture new `build_id` + `version`.

10. **Verify** — re-download the released CCZ. Assert every manifest
    image is at `commcare/multimedia/image/<filename>` AND every patched
    form XML references its `jr://file/...` URI. Halt on mismatch — if
    the file is missing despite a successful upload, the most likely
    cause is step 7 didn't land before step 9 (orphan-prune).

11. **Report.** Write
    `2-commcare/app-multimedia-coverage_report-<YYYY-MM-DD>.md`
    (frontmatter + per-form table; see spec § 4 step 11).

12. **Update `run_state.yaml`** with status + per-app counts under
    `phases.manual.app-multimedia-coverage`.

## Mode behavior

- **Auto** (default): walk → judge → generate → patch → upload → build
  → release → verify → report. No human gate.
- **Review**: pause after step 4 (candidates YAML written) and after
  step 7 (form-XML diff staged) for operator approval.
- **Dry-run** (`--dry-run`): execute steps 1–4 + cost preview only.
  Outputs candidates YAML for inspection. State tracks
  `dry-run-success`.

## Failure modes

| Mode | Cause | Behavior |
|---|---|---|
| `judge.error` ≥1 field | LLM Zod validation failed | Skip that field, log to candidates, continue. Status: `partial`. |
| Content Generator 5xx | Service hiccup | One retry with backoff, then halt. |
| `ContentGeneratorAuthError` | Bad/missing API key | Halt; point at `/ace:doctor`. |
| `XformConflictError` | CCHQ form sha1 changed | Halt the form, surface live sha1. |
| `commcare_upload_multimedia` HTTP 500 | CCHQ rejected the binary | Halt skill; surface response slice. |
| Verify (step 10) fails | Patch or upload silently dropped | Halt with per-form diff. Status: `blocked`. |
| `--max-images` exceeded | Runaway opp | Halt before generation. |
| Nova MCP unavailable | Step 1 fallback | Use released-CCZ XML walk for field discovery. |

## MCP tools used

- **Google Drive:** `drive_read_file`, `drive_create_file`, `drive_update_file`, `drive_create_folder`, `drive_list_folder`
- **ace-connect (CCHQ atoms):** `commcare_download_ccz`, `commcare_patch_xform`, `commcare_upload_multimedia` (new), `commcare_make_build`, `commcare_release_build`
- **Nova:** `nova_get_app`, `nova_get_form`, `nova_get_field` (read-only — for field metadata when blueprint is available)
- **Anthropic SDK:** Sonnet 4.6 via `@anthropic-ai/sdk` (judge calls)
- **HTTP:** Content Generator API via `lib/content-generator-client.ts`

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-05 | Initial version. Manual gate, sibling of `commcare-form-patch`. | ACE team |
```

- [ ] **Step 3: Commit**

```bash
git add skills/app-multimedia-coverage/SKILL.md
git commit -m "feat(skills): app-multimedia-coverage SKILL.md"
```

---

## Task 13: Smoke fixture — `CRISPR-Test-004-KMC-multimedia`

**Files:**
- Create: `test/fixtures/CRISPR-Test-004-KMC-multimedia/pdd.md`
- Create: `test/fixtures/CRISPR-Test-004-KMC-multimedia/expected-multimedia-candidates-learn.yaml` (golden expected output for the judge)

The fixture exists for two purposes: (a) demo target for live runs, (b) Nova-feature-request removal-criteria check (when Nova ships, the same PDD should produce images-attached apps without this skill).

- [ ] **Step 1: Author the PDD**

```markdown
<!-- test/fixtures/CRISPR-Test-004-KMC-multimedia/pdd.md -->
---
name: KMC Multimedia Smoke
archetype: atomic-visit
target_flws: African community health workers in low-resource settings
---

# Kangaroo Mother Care for Small Vulnerable Newborns

## Intervention

Frontline workers visit mothers of small or vulnerable newborns (SVN —
under 2.5 kg or born preterm) and teach Kangaroo Mother Care (KMC):
continuous skin-to-skin contact, exclusive breastfeeding, and early
recognition of warning signs. Each visit is a single in-person
encounter with one structured assessment and several teaching points.

## Learn app — module structure

1. **What is KMC?**
   - Form: instructional. Label-only fields explaining benefits,
     positioning, duration, and indications.
2. **How to position the baby**
   - Form: instructional. Step-by-step visual demonstration: head and
     neck support, skin contact, wrapping the baby securely.
3. **Recognising danger signs**
   - Form: instructional with a quiz. Visual cues for jaundice, apnea,
     poor feeding, hypothermia.
4. **Knowledge check**
   - Form: quiz. Single-select questions on positioning, signs, etc.

## Deliver app — visit structure

Single registration form per visit:
- Mother's name, age, contact
- Baby weight at birth, gestational age, current weight
- Direct observation: is baby positioned correctly? (yes/no with photo)
- Triage: any danger signs present? (multi-select with visual choices)
- Counselling delivered: which teaching points? (multi-select)
- Follow-up date

## Preferred LLOs

(none — smoke fixture, runs without solicitation)
```

- [ ] **Step 2: Author the expected-judge-output YAML (golden ground truth)**

```yaml
# test/fixtures/CRISPR-Test-004-KMC-multimedia/expected-multimedia-candidates-learn.yaml
#
# Golden ground truth for what the LLM judge SHOULD emit on a clean run.
# Used to spot regressions in the judge prompt over time. Form/field IDs
# match the structure the live Nova build will produce; if Nova field
# naming changes, regenerate this file from a known-good run.

# ~8-12 candidates expected:
# - "What is KMC" intro screen → generate=true (FLW shows mother)
# - Positioning step labels (3-5 of them) → generate=true (FLW demonstrates)
# - Danger sign visual cues (jaundice, apnea, hypothermia) → generate=true
# - "Mother's name" text field → generate=false
# - "Baby weight" numeric → generate=false
# - "Follow-up date" → generate=false
```

(The actual ground-truth file is filled in after the first live run against this fixture; for now it ships as a placeholder describing what's expected.)

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/CRISPR-Test-004-KMC-multimedia/
git commit -m "test(fixture): CRISPR-Test-004-KMC-multimedia smoke PDD"
```

---

## Task 14: Live smoke test against the fixture

**Files:** none (this is a manual verification step)

- [ ] **Step 1: Verify env is wired**

```bash
/ace:doctor 2>&1 | grep -E 'CONTENT_GENERATOR|env_file' | head -10
```

Expected: both `CONTENT_GENERATOR_*` keys reported as OK.

- [ ] **Step 2: Pick (or create) a smoke opp that has Nova-built apps released**

The skill needs an existing opp where Phase 1 + Phase 2 have completed. The simplest path: pick the most recent passing smoke opp from `~/.ace/` or Drive, and run against it. (Standing up a new opp from `CRISPR-Test-004` is a longer-form smoke that comes with the Nova-feature-request validation cycle; not required for first live run of this skill.)

```bash
/ace:status 2>&1 | tail -30
```

Choose an opp with `phase_2: clean` and noted `learn_app_id` + `deliver_app_id`.

- [ ] **Step 3: Dry-run first**

```bash
/ace:step app-multimedia-coverage <opp-name> --dry-run
```

Expected: candidates YAML written, cost preview printed, no API calls to Content Generator, no patches.

- [ ] **Step 4: Inspect the candidates YAML**

Read `2-commcare/app-multimedia-coverage_candidates-learn.yaml` and `_candidates-deliver.yaml` from Drive. Sanity-check: do the `generate: true` choices look right? Are the directives reasonable?

If choices look bad: iterate the judge prompt in `lib/multimedia-judge.ts` (`SYSTEM_HEAD`), regenerate the candidates with `--rejudge`, repeat until the operator is happy.

- [ ] **Step 5: Live run on Learn only first**

```bash
/ace:step app-multimedia-coverage <opp-name> --app=learn --max-images=10
```

Expected: 10 images generated, form XML patched, multimedia uploaded, app re-built and re-released, verify step passes, report written.

- [ ] **Step 6: Manual visual check**

Open the new build in CommCare HQ's app preview or pull the CCZ and inspect:

```bash
gh attestation download ... # OR via CCHQ's preview UI
```

Confirm at least one image renders alongside the expected question.

- [ ] **Step 7: Iterate**

If something failed: address the failure mode, re-run, repeat. **Convergence is the goal of this task.** Each iteration should commit fixes (judge prompt tweaks, atom edge cases, XML patcher edge cases) as small focused commits.

- [ ] **Step 8: Run on Deliver after Learn passes**

```bash
/ace:step app-multimedia-coverage <opp-name> --app=deliver --max-images=10
```

- [ ] **Step 9: Capture the golden run for the fixture's expected YAML**

Once a live run looks right, copy the produced `app-multimedia-coverage_candidates-learn.yaml` from Drive into `test/fixtures/CRISPR-Test-004-KMC-multimedia/expected-multimedia-candidates-learn.yaml`, replacing the placeholder.

```bash
git add test/fixtures/CRISPR-Test-004-KMC-multimedia/expected-multimedia-candidates-learn.yaml
git commit -m "test(fixture): capture golden judge output from first live run"
```

---

## Task 15: Update CLAUDE.md and CHANGELOG

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a CLAUDE.md "Current state" bullet**

After the existing post-Nova-skill paragraphs (the section that mentions `app-connect-coverage` and `commcare-form-patch`), add:

```markdown
- **`app-multimedia-coverage` — manual post-Phase-2 multimedia attach.**
  Sibling of `commcare-form-patch`. LLM-judges each Nova-built field
  (criterion: would the FLW use it OR show it to a client?), calls
  Dimagi's Content Generator API for the chosen ones, patches form XML
  with `<image>` itext entries, uploads PNGs via the new
  `commcare_upload_multimedia` atom, and re-builds + re-releases. **Not
  part of `/ace:run`** — invoked manually with `/ace:step
  app-multimedia-coverage <opp>`. Spec at
  `docs/superpowers/specs/2026-05-05-app-multimedia-coverage-design.md`;
  delete when Nova ships first-class field-level multimedia (see the
  removal criteria in the SKILL.md).
```

- [ ] **Step 2: Add a CHANGELOG entry under the next version**

(Pick the next minor or patch version per `CLAUDE.md` § "Plugin updates".)

```markdown
## 0.13.4 — app-multimedia-coverage skill

- New skill `app-multimedia-coverage` (manual gate, post-Phase 2):
  attaches display-only images to Connect Learn/Deliver app questions
  via Dimagi's Content Generator + post-Nova CCZ patching.
- New CCHQ atom `commcare_upload_multimedia` to bundle binary assets
  into the released CCZ.
- New helpers under `lib/`: `multimedia-judge`, `content-generator-client`,
  `multimedia-manifest`, `multimedia-prompt-hash`, `multimedia-xform-patch`.
- New `.env.tpl` keys: `CONTENT_GENERATOR_URL`, `CONTENT_GENERATOR_API_KEY`.
- Filed Nova feature request `voidcraft-labs/nova-plugin#<N>` for
  field-level multimedia; this skill has explicit removal criteria.
```

- [ ] **Step 3: Bump version**

```bash
scripts/version-bump.sh
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CHANGELOG.md VERSION package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "docs: app-multimedia-coverage in CLAUDE.md + CHANGELOG (0.13.4)"
```

---

## Task 16: File the Nova feature request

**Files:** none in this repo

- [ ] **Step 1: Verify gh CLI auth**

```bash
gh auth status
```

If not authed for `voidcraft-labs/nova-plugin`, sort that out before proceeding.

- [ ] **Step 2: File the issue**

```bash
gh issue create --repo voidcraft-labs/nova-plugin \
  --title "Field-level multimedia (display-only) on Learn/Deliver questions" \
  --body "$(cat <<'EOF'
## Problem

Nova has no schema for **display-only** multimedia on a question (the
image / audio / video that the FLW sees alongside a question label).
The existing `image` / `audio` / `video` field kinds are *input
capture* (FLW takes a photo / records audio), not display.

Standard CommCare apps render display media via:

- `<image>` / `<audio>` / `<video>` itext entries in form XML, e.g.
  `<value form="image">jr://file/commcare/image/foo.png</value>`
- Bundled assets in the CCZ at `commcare/multimedia/<media_type>/...`

There's no field-level hook in Nova's blueprint to populate either.

## What ACE is doing as a workaround

The new `app-multimedia-coverage` skill in
[anthropics-friends/ace](https://github.com/...) (ACE plugin) post-builds:

1. LLM-judges each field for "image-worthy" (criterion: FLW uses it
   themselves OR shows it to a client).
2. Calls Dimagi's Content Generator API to make the asset.
3. Patches form XML to add `<image>` itext via existing
   `commcare_patch_xform`.
4. Bundles the PNG into the CCZ via a new
   `commcare_upload_multimedia` atom.
5. Re-builds and re-releases.

This works but is a maintenance liability — every Nova rebuild loses
the patches. We'd love to delete the skill once Nova handles this
natively.

## Proposal

### Schema

New optional `media` property on every field:

```yaml
fields:
  - id: kmc_position_demo
    kind: label
    label: "Show the mother how to support the baby's head and neck."
    media:
      image_url: https://...                 # OR raw bytes via separate atom
      alt_text: "Mother holding small newborn skin-to-skin"
      image_directives: "warm lighting, modest clothing, African setting"
```

### Compile

`compile_app` fetches each `media.image_url`, bundles into the produced
CCZ at `commcare/multimedia/image/<form_unique_id>__<field_id>.png`,
and writes the matching `<image>` itext entry into the form XML.

### Optional v2

Pluggable generator hook so authors can specify `media: { generate:
true, directives: "..." }` and Nova produces the asset at compile time
via Dimagi's Content Generator (or any pluggable provider).

## Acceptance

- `update_form` accepts `media: { image_url, ... }` on a field.
- `compile_app` produces a CCZ with the correct `<image>` itext entry
  AND the bundled asset present at the expected path.
- Round-trip: `get_form` returns the `media` block as written.
- ACE's `CRISPR-Test-004-KMC-multimedia` smoke fixture produces an
  images-attached app without `app-multimedia-coverage` running.

When this ships, ACE will delete `app-multimedia-coverage`,
`commcare_upload_multimedia`, and the supporting `lib/multimedia-*`
helpers.
EOF
)"
```

- [ ] **Step 3: Capture the issue number in CHANGELOG**

```bash
# After the issue is filed and you have its number, fix the CHANGELOG line:
# `voidcraft-labs/nova-plugin#<N>` → `voidcraft-labs/nova-plugin#42` (or whatever)
```

```bash
git add CHANGELOG.md
git commit --amend --no-edit  # OR a new commit if amend is risky
```

---

## Task 17: Final verification & PR

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: all unit + integration (where gated env is present) tests pass.

- [ ] **Step 2: `/ace:doctor` clean**

```bash
/ace:doctor
```

Expected: no fail-level findings (warnings about Connect / OCS sessions are fine if not authenticated).

- [ ] **Step 3: Push and open a PR**

Use the `dev-utils:create-pr` skill. PR title: `feat: app-multimedia-coverage skill (0.13.4)`.

PR body covers:
- Spec link
- Plan link
- New atom + helpers + skill
- Nova feature request link
- Live smoke status (which opp / which app / how many images / verify pass)

---

## Plan Self-Review

**Spec coverage check:**

| Spec section | Plan task |
|---|---|
| § 1 Problem statement | (covered by entire plan; no specific task needed) |
| § 2 Goals & non-goals | Tasks 7 (judge), 9 (atom), 12 (skill orchestration) cover the in-scope goals. Out-of-scope items (audio/video, multilingual) are not in the plan — correct. |
| § 3 Skill shape | Task 12 (SKILL.md) |
| § 4 End-to-end pipeline (12 steps) | Task 12 (encoded into SKILL.md) |
| § 5a LLM judge | Task 7 |
| § 5b Content Generator client | Tasks 1 (probe), 6 (client) |
| § 5c CCHQ atom | Tasks 2 (probe), 9 (backend), 10 (registration) |
| § 6 Drive layout | Task 12 (SKILL.md prose); Task 5 (manifest schema) |
| § 7 Idempotency | Tasks 4 (prompt hash), 12 (skill flow) |
| § 8 Failure modes | Task 12 (SKILL.md table mirrors spec) |
| § 9 Nova feature request + removal criteria | Task 16 (file) + Task 12 (removal criteria in SKILL.md) |
| § 10 Modes | Task 12 |
| § 11 Testing | Tasks 4–9 (unit), Task 9 (integration), Tasks 13–14 (smoke fixture + live run) |
| § 12 Open questions | Tasks 1–2 (probes resolve them) |
| § 13 Out of scope | (correctly absent from plan) |

All spec sections accounted for.

**Placeholder scan:**

- All code blocks contain real code, not stubs.
- All file paths are exact.
- All test assertions are concrete.
- One soft spot: Task 13 step 2 ships a comment-only `expected-multimedia-candidates-learn.yaml`, with the real golden coming from Task 14 step 9. That's intentional — the golden output requires a live run to capture — and it's documented as such.

**Type consistency check:**

- `JudgeOutput` — defined in Task 7, never re-shaped.
- `MultimediaManifest` / `MultimediaImage` — defined in Task 5, used implicitly in Tasks 9, 12.
- `ContentGeneratorClient.generateImage(...)` signature — Task 6 defines it; Task 12 SKILL.md uses the same shape.
- `addImageItext(xml, bindings)` — Task 8 defines, Task 12 SKILL.md references.
- `commcare_upload_multimedia` schema — Task 9 backend, Task 10 server registration both use the same field shapes (domain, app_id, media_path, file_bytes, content_type).

No drift detected.

**Done.**
