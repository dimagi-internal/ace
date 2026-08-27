#!/usr/bin/env npx tsx
/**
 * Bound one media file to what belongs on a frontline worker's phone.
 *
 * An oversized image is downscaled to 800px on its longest edge, and falls
 * back to JPEG (stepping the quality down) when a photograph is still over
 * budget. Oversized audio/video is refused by name rather than transcoded,
 * because re-encoding it is a judgement about content.
 *
 * **This script never emits file bytes.** It reports a PATH and the metadata
 * about it; `scripts/run-nova-media-upload.ts` is what reads those bytes and
 * uploads them, server-side, so nothing binary ever crosses a model tool call.
 * It used to write a base64 sidecar and offer a `--print-base64` flag — both
 * were left over from before the upload proxy existed, and the flag was a
 * footgun (base64 tokenizes at ~1 token/char, so printing a 60 KB image would
 * have cost ~80k tokens). Do not reintroduce either.
 *
 * Usage:
 *   npx tsx scripts/run-media-prepare.ts <input> [--out-dir <dir>] [--budget-bytes <n>]
 *
 * Output (stdout): one JSON line —
 *   { path, mime_type, kind, action, bytes, note }
 *
 * Exit codes: 0 prepared, 1 usage/IO error, 2 refused (cannot reach budget).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  ASSET_BUDGET_BYTES,
  pickResizer,
  planPreparation,
  resizeArgv,
  jpegArgv,
  type MediaKind,
} from '../lib/media-prepare.js';

/**
 * JPEG qualities tried in order when a resized image is still over budget.
 * Starts at visually-clean and steps down only as far as the budget forces.
 */
const JPEG_QUALITY_LADDER = [82, 70, 60, 50, 40] as const;

function die(msg: string, code = 1): never {
  process.stderr.write(`run-media-prepare: ${msg}\n`);
  process.exit(code);
}

const MIME_BY_EXT: Record<string, { mime: string; kind: MediaKind }> = {
  '.png': { mime: 'image/png', kind: 'image' },
  '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image' },
  '.gif': { mime: 'image/gif', kind: 'image' },
  '.webp': { mime: 'image/webp', kind: 'image' },
  '.mp3': { mime: 'audio/mpeg', kind: 'audio' },
  '.wav': { mime: 'audio/wav', kind: 'audio' },
  '.mp4': { mime: 'video/mp4', kind: 'video' },
};

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) die(`${name} needs a value`);
  return v;
}

function which(tool: string): boolean {
  try {
    // `sh -c` rather than `shell: true` — passing args alongside a shell
    // concatenates them unescaped (Node DEP0190).
    execFileSync('sh', ['-c', `command -v "$1"`, 'sh', tool], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  process.stderr.write(
    'usage: run-media-prepare.ts <input> [--out-dir <dir>] [--budget-bytes <n>]\n',
  );
  process.exit(argv.length === 0 ? 1 : 0);
}

const input = argv[0];
if (!existsSync(input)) die(`no such file: ${input}`);

const ext = extname(input).toLowerCase();
const typed = MIME_BY_EXT[ext];
if (!typed) {
  die(
    `unsupported extension "${ext || '(none)'}" — Nova accepts ` +
      `${Object.keys(MIME_BY_EXT).join(', ')}`,
  );
}

const budgetRaw = flag(argv, '--budget-bytes');
const budgetBytes = budgetRaw ? Number(budgetRaw) : ASSET_BUDGET_BYTES;
if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) die('--budget-bytes must be a positive number');

const outDir = flag(argv, '--out-dir') ?? join(process.cwd(), '.media-prepared');
const bytes = statSync(input).size;
const plan = planPreparation({ bytes, kind: typed.kind, budgetBytes });

let finalPath = input;
let finalMime = typed.mime;
let note = 'within budget; used as-is';

if (plan.action === 'refuse') {
  die(plan.reason, 2);
}

if (plan.action === 'resize') {
  const tool = pickResizer(['sips', 'magick', 'convert', 'ffmpeg'].filter(which));
  if (!tool) {
    die(
      `${plan.reason} No resizer found — install one of sips (macOS), ` +
        `ImageMagick (magick/convert), or ffmpeg, or supply a smaller file.`,
      2,
    );
  }
  mkdirSync(outDir, { recursive: true });
  // Always emit PNG/JPEG under the original extension so the mime stays true.
  finalPath = join(outDir, basename(input));
  if (finalPath === input) finalPath = join(outDir, `resized-${basename(input)}`);
  const [cmd, ...args] = resizeArgv(tool, input, finalPath, plan.longestEdge);
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
  } catch (e) {
    die(`${tool} failed to resize ${input}: ${(e as Error).message}`, 1);
  }
  if (!existsSync(finalPath)) die(`${tool} reported success but wrote no file`, 1);

  const after = statSync(finalPath).size;
  note = `${plan.reason} ${tool}: ${(bytes / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB`;

  // A resized PHOTOGRAPH can still be megabytes as lossless PNG. Re-encoding
  // to JPEG is what actually gets a photo under budget; we do it only here,
  // so the generator's diagrams and line art keep their crisp PNG edges.
  if (after > budgetBytes && typed.kind === 'image') {
    const sourceForJpeg = finalPath;
    const jpegPath = finalPath.replace(/\.[^.]+$/, '.jpg');
    let landed: number | null = null;
    let usedQuality = 0;

    // Step the quality down until it fits. A single fixed quality cannot
    // serve every budget — a detailed photograph at q82 can still overshoot
    // a tight one, and stopping there would refuse a file that q60 carries
    // perfectly well at this size.
    for (const quality of JPEG_QUALITY_LADDER) {
      const [jcmd, ...jargs] = jpegArgv(tool, sourceForJpeg, jpegPath, quality);
      try {
        execFileSync(jcmd, jargs, { stdio: 'ignore' });
      } catch (e) {
        die(`${note}; JPEG fallback via ${tool} failed: ${(e as Error).message}`, 1);
      }
      if (!existsSync(jpegPath)) continue;
      landed = statSync(jpegPath).size;
      usedQuality = quality;
      if (landed <= budgetBytes) break;
    }

    if (landed !== null) {
      note +=
        `; still over budget as ${extname(sourceForJpeg)}, ` +
        `re-encoded to JPEG q${usedQuality} → ${(landed / 1024).toFixed(0)} KB`;
      finalPath = jpegPath;
      finalMime = 'image/jpeg';
    }
  }

  if (statSync(finalPath).size > budgetBytes) {
    die(
      `${note}; still over the ${(budgetBytes / 1024).toFixed(0)} KB budget. ` +
        `Supply a smaller or less detailed source image.`,
      2,
    );
  }
}

const result = {
  path: finalPath,
  mime_type: finalMime,
  kind: typed.kind,
  action: plan.action,
  bytes: statSync(finalPath).size,
  note,
};

process.stdout.write(`${JSON.stringify(result)}\n`);
