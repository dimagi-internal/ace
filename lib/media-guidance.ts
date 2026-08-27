/**
 * Classifies the contents of an opp's `inputs/media/` Drive folder into the
 * three things `app-media-coverage` needs from it:
 *
 *   - `assets`     — the image / audio / video files to attach to the app
 *   - `guidance`   — free-form documents the operator dropped in to say how
 *                    they want the media used
 *   - `unsupported`/`ignored` — everything else, named rather than dropped
 *
 * ## Why guidance discovery is not a filename match
 *
 * The operator writes whatever they write. Requiring `overview.md` means a
 * folder holding `how we want these used.gdoc` silently ships with no
 * guidance at all, and nothing in the run says so — the same silent-skip
 * class as ace#1556. So the rule here is inverted: **every readable text
 * document in the folder is guidance.** Name affinity only *orders* the
 * list so the skill reads the most-likely-primary doc first; it never
 * excludes a document, and a folder with no text document at all is a
 * fully supported case, not a defect.
 *
 * Pure and total: no I/O, no throwing, deterministic for a given input.
 * The caller supplies the Drive listing (`drive_list_folder` /
 * `generate_inputs_manifest` rows) and fetches bytes itself.
 */

export interface DriveEntry {
  file_id: string;
  name: string;
  mime_type: string;
  /** Present when the entry is a Drive shortcut. */
  resolved_target_id?: string;
  resolved_target_mime_type?: string;
}

export type MediaKind = 'image' | 'audio' | 'video';

export interface MediaAsset {
  /** Target id when the entry was a shortcut, else the entry's own id. */
  file_id: string;
  name: string;
  /** Canonical mime type — sniffed from the extension when Drive was vague. */
  mime_type: string;
  kind: MediaKind;
  /** Stable kebab-case handle used for binding + tracing. Unique in a folder. */
  asset_key: string;
}

export interface GuidanceDoc {
  file_id: string;
  name: string;
  mime_type: string;
  /** True for formats needing a local extractor (PDF); false for Docs/text. */
  needs_extraction: boolean;
  /** Name-affinity score. Higher sorts first; 0 is still guidance. */
  affinity: number;
}

export interface RejectedEntry {
  file_id: string;
  name: string;
  mime_type: string;
  reason: string;
}

export interface MediaFolderClassification {
  assets: MediaAsset[];
  guidance: GuidanceDoc[];
  /** Media-shaped but not attachable (e.g. an audio container HQ refuses). */
  unsupported: RejectedEntry[];
  /** Not media and not readable text — subfolders, unknown binaries. */
  ignored: RejectedEntry[];
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const GDOC_MIME = 'application/vnd.google-apps.document';

/** Extensions Nova's `upload_media_asset` accepts, with their canonical mime. */
const ATTACHABLE_BY_EXT: Record<string, { mime: string; kind: MediaKind }> = {
  png: { mime: 'image/png', kind: 'image' },
  jpg: { mime: 'image/jpeg', kind: 'image' },
  jpeg: { mime: 'image/jpeg', kind: 'image' },
  gif: { mime: 'image/gif', kind: 'image' },
  webp: { mime: 'image/webp', kind: 'image' },
  mp3: { mime: 'audio/mpeg', kind: 'audio' },
  wav: { mime: 'audio/wav', kind: 'audio' },
  mp4: { mime: 'video/mp4', kind: 'video' },
};

/**
 * Media containers CommCare HQ cannot ingest. Named explicitly so the run
 * reports "we saw this and could not use it" instead of staying silent —
 * an operator who dropped in a voice memo deserves to be told why it did
 * not reach the app.
 */
const REFUSED_BY_EXT: Record<string, string> = {
  m4a: 'CommCare HQ cannot ingest .m4a — re-encode as .mp3 or .wav.',
  ogg: 'CommCare HQ cannot ingest .ogg — re-encode as .mp3 or .wav.',
  aac: 'CommCare HQ cannot ingest .aac — re-encode as .mp3 or .wav.',
  mov: 'CommCare HQ cannot ingest .mov — re-encode as .mp4.',
  avi: 'CommCare HQ cannot ingest .avi — re-encode as .mp4.',
  webm: 'CommCare HQ cannot ingest .webm — re-encode as .mp4.',
  svg: 'CommCare renders raster images only — export the SVG as .png.',
  heic: 'CommCare HQ cannot ingest .heic — export as .png or .jpg.',
};

const TEXT_GUIDANCE_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  GDOC_MIME,
]);

const TEXT_GUIDANCE_EXTS = new Set(['md', 'markdown', 'txt', 'text', 'rst', 'csv', 'gdoc']);

/**
 * Name tokens that suggest a document is the folder's primary "how to use
 * these" note. Purely a ranking signal — see the module docstring.
 */
const AFFINITY_TOKENS = [
  'overview',
  'summary',
  'readme',
  'read-me',
  'guide',
  'guidance',
  'instruction',
  'instructions',
  'howto',
  'how-to',
  'how to',
  'about',
  'notes',
  'note',
  'index',
  'manifest',
  'brief',
  'spec',
  'legend',
  'caption',
  'captions',
  'credits',
  'key',
  'media',
  'image',
  'images',
  'photo',
  'photos',
  'usage',
  'use',
];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function baseNameOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Lowercase, non-alphanumerics collapsed to single hyphens, trimmed. */
export function toAssetKey(name: string): string {
  const key = baseNameOf(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return key || 'asset';
}

function affinityOf(name: string): number {
  const haystack = baseNameOf(name).toLowerCase().replace(/[_\s]+/g, '-');
  let score = 0;
  for (const token of AFFINITY_TOKENS) {
    const needle = token.replace(/\s+/g, '-');
    if (haystack === needle) score += 3;
    else if (haystack.includes(needle)) score += 1;
  }
  return score;
}

/**
 * Sorts guidance so the most-likely-primary document is read first.
 * Affinity descending, then shorter names, then alphabetical — the last two
 * exist only to make the order deterministic across runs.
 */
function compareGuidance(a: GuidanceDoc, b: GuidanceDoc): number {
  if (a.affinity !== b.affinity) return b.affinity - a.affinity;
  if (a.name.length !== b.name.length) return a.name.length - b.name.length;
  return a.name.localeCompare(b.name);
}

export function classifyMediaFolder(entries: DriveEntry[]): MediaFolderClassification {
  const assets: MediaAsset[] = [];
  const guidance: GuidanceDoc[] = [];
  const unsupported: RejectedEntry[] = [];
  const ignored: RejectedEntry[] = [];

  for (const entry of entries) {
    // A shortcut stands in for its target: read the target's identity.
    const isShortcut = entry.mime_type === SHORTCUT_MIME || !!entry.resolved_target_id;
    const fileId = isShortcut ? (entry.resolved_target_id ?? entry.file_id) : entry.file_id;
    const mime = isShortcut
      ? (entry.resolved_target_mime_type ?? entry.mime_type)
      : entry.mime_type;

    if (mime === FOLDER_MIME) {
      ignored.push({
        file_id: fileId,
        name: entry.name,
        mime_type: mime,
        reason: 'Subfolder — app-media-coverage reads inputs/media/ one level deep.',
      });
      continue;
    }

    const ext = extensionOf(entry.name);

    const refusal = REFUSED_BY_EXT[ext];
    if (refusal) {
      unsupported.push({ file_id: fileId, name: entry.name, mime_type: mime, reason: refusal });
      continue;
    }

    // Attachable media: trust the extension when the mime is generic, and
    // trust the mime otherwise. Both must agree on a supported kind.
    const byExt = ATTACHABLE_BY_EXT[ext];
    const byMime = Object.values(ATTACHABLE_BY_EXT).find((v) => v.mime === mime);
    const resolved = byExt ?? byMime;
    if (resolved && (byExt || byMime)) {
      assets.push({
        file_id: fileId,
        name: entry.name,
        mime_type: resolved.mime,
        kind: resolved.kind,
        asset_key: toAssetKey(entry.name),
      });
      continue;
    }

    if (TEXT_GUIDANCE_MIMES.has(mime) || TEXT_GUIDANCE_EXTS.has(ext)) {
      guidance.push({
        file_id: fileId,
        name: entry.name,
        mime_type: mime,
        needs_extraction: false,
        affinity: affinityOf(entry.name),
      });
      continue;
    }

    if (mime === 'application/pdf' || ext === 'pdf') {
      guidance.push({
        file_id: fileId,
        name: entry.name,
        mime_type: 'application/pdf',
        needs_extraction: true,
        affinity: affinityOf(entry.name),
      });
      continue;
    }

    ignored.push({
      file_id: fileId,
      name: entry.name,
      mime_type: mime,
      reason: `Not an attachable media file and not a readable document (${mime}).`,
    });
  }

  // Asset keys must be unique within the folder — two files that key the
  // same would otherwise collide in the plan and in operator overrides.
  const seen = new Map<string, number>();
  for (const asset of assets) {
    const n = (seen.get(asset.asset_key) ?? 0) + 1;
    seen.set(asset.asset_key, n);
    if (n > 1) asset.asset_key = `${asset.asset_key}-${n}`;
  }

  guidance.sort(compareGuidance);

  return { assets, guidance, unsupported, ignored };
}
