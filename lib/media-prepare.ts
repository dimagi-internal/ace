/**
 * Decides whether a media file is small enough to ship inside a CommCare app,
 * and how to shrink it when it is not.
 *
 * ## Why a budget exists
 *
 * Every attached image lands in the CCZ that each frontline worker downloads,
 * over connectivity that is often poor, onto a low-end Android device. An
 * 800px-longest-edge image is both what that device can usefully show and what
 * the network can afford; a 3 MB original is waste twice over, and a dozen of
 * them makes an app that will not install in the field.
 *
 * This used to also be a *context* budget, because Nova's `upload_media_asset`
 * takes inline base64 and a tool-call argument that large is unaffordable
 * (base64 tokenizes at ~1 token per character — a 46 KB payload measured at
 * 45k tokens on 2026-08-27). That constraint now lives where it belongs:
 * `scripts/run-nova-media-upload.ts` performs the upload server-side, so the
 * bytes never enter model context. What remains here is purely about what
 * belongs on a worker's phone.
 *
 * Pure decision logic lives here; `scripts/run-media-prepare.ts` performs the
 * I/O. `audio`/`video` are deliberately never transcoded — re-encoding them is
 * a lossy judgement call about content, so an oversized one is refused loudly
 * and named for the operator instead.
 */

export type MediaKind = 'image' | 'audio' | 'video';

/**
 * Largest single media file we will ship inside an app.
 *
 * 150 KB is generous for the job at 800px: a generated diagram compresses far
 * below it as PNG, and a photograph lands comfortably under it as JPEG. It is
 * also small enough that an app carrying a dozen images stays installable over
 * a slow connection.
 */
export const ASSET_BUDGET_BYTES = 150 * 1024;

/** Longest-edge pixel bound for a downscaled image. */
export const TARGET_LONGEST_EDGE = 800;

/** Resizers we know how to drive, in preference order. */
const RESIZERS = ['sips', 'magick', 'convert', 'ffmpeg'] as const;
export type Resizer = (typeof RESIZERS)[number];

/** Exact base64 length for a byte count, padding included. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

export type PreparationPlan =
  | { action: 'pass_through' }
  | { action: 'resize'; longestEdge: number; reason: string }
  | { action: 'refuse'; reason: string };

export function planPreparation(input: {
  bytes: number;
  kind: MediaKind;
  budgetBytes?: number;
}): PreparationPlan {
  const budget = input.budgetBytes ?? ASSET_BUDGET_BYTES;
  if (input.bytes <= budget) return { action: 'pass_through' };

  const over = `${(input.bytes / 1024).toFixed(0)} KB exceeds the ${(budget / 1024).toFixed(0)} KB asset budget`;

  if (input.kind === 'image') {
    return {
      action: 'resize',
      longestEdge: TARGET_LONGEST_EDGE,
      reason: `${over}; downscaling to ${TARGET_LONGEST_EDGE}px longest edge.`,
    };
  }

  return {
    action: 'refuse',
    reason:
      `${over}, and ${input.kind} cannot be resized without a content judgement. ` +
      `Re-encode it smaller (a shorter clip or a lower bitrate) and re-run.`,
  };
}

/** First known resizer present on this machine, or null. */
export function pickResizer(available: readonly string[]): Resizer | null {
  const present = new Set(available);
  return RESIZERS.find((r) => present.has(r)) ?? null;
}

/**
 * Argv that re-encodes an image as JPEG.
 *
 * Resizing alone does not always get under budget: PNG is lossless, so a
 * *photographic* 800px image can still run to megabytes, while the same
 * picture as JPEG is tens of kilobytes. PNG is the right format for the
 * diagrams and line art the generator produces, so this is a fallback rather
 * than the default — applied only when a resized image is still too large,
 * which in practice means it is a photograph.
 */
export function jpegArgv(
  tool: Resizer,
  input: string,
  output: string,
  quality: number,
): string[] {
  const q = String(quality);
  switch (tool) {
    case 'sips':
      return ['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', q, input, '--out', output];
    case 'magick':
    case 'convert':
      return [tool, input, '-quality', q, output];
    case 'ffmpeg':
      // ffmpeg's -q:v runs 2 (best) to 31 (worst); map a 0-100 quality onto it.
      return ['ffmpeg', '-y', '-i', input, '-q:v', String(jpegQualityToFfmpegScale(quality)), output];
  }
}

/** Maps a 0-100 JPEG quality onto ffmpeg's inverted 2-31 `-q:v` scale. */
export function jpegQualityToFfmpegScale(quality: number): number {
  const clamped = Math.min(100, Math.max(0, quality));
  return Math.round(31 - (clamped / 100) * 29);
}

/**
 * Argv (never a shell string — paths may contain spaces) that shrinks
 * `input` into `output`, bounding the longest edge and never upscaling.
 */
export function resizeArgv(
  tool: Resizer,
  input: string,
  output: string,
  longestEdge: number,
): string[] {
  const edge = String(longestEdge);
  switch (tool) {
    case 'sips':
      // sips bounds the larger dimension and leaves smaller images alone.
      return ['sips', '--resampleHeightWidthMax', edge, input, '--out', output];
    case 'magick':
    case 'convert':
      // The trailing `>` means "only shrink", so a small source is untouched.
      return [tool, input, '-resize', `${edge}x${edge}>`, output];
    case 'ffmpeg':
      return [
        'ffmpeg', '-y', '-i', input,
        '-vf',
        // Scale the longer side to `edge`, keep aspect, force even dimensions.
        `scale='if(gt(iw,ih),min(${edge},iw),-2)':'if(gt(iw,ih),-2,min(${edge},ih))'`,
        output,
      ];
  }
}
