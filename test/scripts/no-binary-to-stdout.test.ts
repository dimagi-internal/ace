/**
 * No ACE media script may print file bytes to stdout.
 *
 * A script's stdout is read by the model. Base64 tokenizes at roughly one
 * token per character, so emitting an encoded file there is not "a bit
 * wasteful" — it is catastrophic: a 60 KB image costs ~80k tokens, and a
 * 46 KB payload measured at 45k tokens (enough to hit the read cap) on
 * 2026-08-27. A dozen images would exhaust a phase's budget moving pixels.
 *
 * The correct shape, and the one `scripts/run-nova-media-upload.ts`
 * implements, is: read the bytes off disk INSIDE the script, do the work
 * there, and print only the small result (an id, a path, a count). ACE has an
 * established name for this — the `_path` companion pattern in
 * `docs/learnings/2026-05-12-boundary-probe-registry.md`.
 *
 * This guard exists because the rule was violated by accident rather than by
 * disagreement: `run-media-prepare.ts` shipped with a base64 sidecar and a
 * `--print-base64` flag, both written before the upload proxy existed and
 * both left behind when it landed.
 *
 * ## Why this test EXECUTES the scripts
 *
 * The first version of this guard was static — it looked for a base64-bound
 * variable appearing inside a `process.stdout.write(...)` call. It passed
 * against a deliberately reintroduced defect, because the bytes reached
 * stdout indirectly (`result.base64 = b64`, then `write(JSON.stringify(result))`),
 * and because a flag embedded in a longer usage string is not a standalone
 * literal. A guard that cannot fail is worse than no guard, so this one runs
 * the real script against a real file and reads what actually comes out.
 * Indirection cannot fool it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A run this long of pure base64 alphabet is file content, not a path or an
 * id. Paths break on `.`, `-`, and `_`; a UUID breaks on `-`.
 */
const BASE64_RUN = /[A-Za-z0-9+/=]{300,}/;

/** Stdout that stays this small cannot be carrying an image. */
const STDOUT_BUDGET_BYTES = 4096;

let dir: string;
let png: string;

/** Minimal valid PNG — a 64x64 opaque square, a few hundred bytes. */
function writePng(path: string): void {
  const W = 64;
  const H = 64;
  const raw = Buffer.concat(
    Array.from({ length: H }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(W * 3, 0x80)])),
  );
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crcTable: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

function run(script: string, args: string[]): string {
  return execFileSync('npx', ['tsx', join(REPO, 'scripts', script), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    cwd: REPO,
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-stdout-guard-'));
  png = join(dir, 'probe.png');
  writePng(png);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('run-media-prepare prints metadata, never bytes', () => {
  it('emits a small JSON line with no base64 payload', () => {
    const out = run('run-media-prepare.ts', [png, '--out-dir', join(dir, 'prepared')]);
    expect(Buffer.byteLength(out)).toBeLessThan(STDOUT_BUDGET_BYTES);
    expect(out).not.toMatch(BASE64_RUN);

    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('path');
    expect(parsed).toHaveProperty('bytes');
    // The keys that used to carry (or point at) encoded bytes.
    for (const banned of ['base64', 'base64_path', 'base64_bytes', 'data_base64']) {
      expect(parsed, `stdout must not carry ${banned}`).not.toHaveProperty(banned);
    }
  });

  it('writes no base64 sidecar beside the prepared file', () => {
    const outDir = join(dir, 'sidecar-check');
    run('run-media-prepare.ts', [png, '--out-dir', outDir]);
    // Nothing anywhere in the working dirs may be a .b64 sidecar.
    const strays = readdirSync(dir, { recursive: true } as never) as unknown as string[];
    expect(strays.filter((f) => String(f).endsWith('.b64'))).toEqual([]);
  });

  it('still does its real job — the guard is not passing by breaking the script', () => {
    const out = JSON.parse(run('run-media-prepare.ts', [png, '--out-dir', join(dir, 'works')]));
    expect(out.mime_type).toBe('image/png');
    expect(out.bytes).toBeGreaterThan(0);
  });
});

describe('run-media-classify prints classification, never bytes', () => {
  it('emits no base64 payload', () => {
    const listing = join(dir, 'listing.json');
    writeFileSync(
      listing,
      JSON.stringify({ files: [{ id: 'f1', name: 'a.png', mimeType: 'image/png' }] }),
    );
    const out = run('run-media-classify.ts', [listing]);
    expect(out).not.toMatch(BASE64_RUN);
    expect(JSON.parse(out).assets).toHaveLength(1);
  });
});

describe('run-nova-media-upload keeps the encode inside the script', () => {
  const src = readFileSync(join(REPO, 'scripts', 'run-nova-media-upload.ts'), 'utf8');

  it('does encode the file — it is the upload proxy, that is its job', () => {
    expect(src).toMatch(/toString\('base64'\)/);
  });

  it('sends the encoded bytes to Nova, not to stdout', () => {
    // The single stdout write must emit the parsed RPC result, nothing else.
    const writes = [...src.matchAll(/process\.stdout\.write\(([^\n]*)\)/g)].map((m) => m[1]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('JSON.stringify(parsed)');
    expect(writes[0]).not.toMatch(/b64|base64|args\b/);
  });

  it('never puts the encoded field on the object it prints', () => {
    // `data_base64` may appear only in the request payload built for fetch.
    const printedNearby = /parsed[^;]*data_base64|data_base64[^;]*parsed/;
    expect(src).not.toMatch(printedNearby);
  });
});
